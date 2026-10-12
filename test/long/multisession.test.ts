// 여러 세션 오래 쓰기 시험 (npm run test:long). 매번 돌리는 테스트에는 넣지 않는다.
// Claude 세션 3개(CDPM 프로세스 3개)가 같은 슬롯을 동시에 쓰면서, 반복마다 새 에이전트 이름으로
// "새 탭 → 이동 → 스냅샷 → 클릭 → 입력 → 다른 세션에 메시지 → 받기 → 탭 닫기"를 하고, 가끔 슬롯을 껐다 켠다.
// 세션마다 정리 후 힙, 공용 기록부·메시지 파일 크기, 남은 잠금 파일, Chrome에 남은 탭 수가 계속 늘지 않는지 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const ROUNDS = Number(process.env.CDPM_LONG_MULTI_ROUNDS) || 600;
const PORT_BASE = 29721;
const SESSIONS = 3;
const INSPECT = (k: number) => 9360 + k;
const RELAUNCH_EVERY = 150;

const PAGE = (n: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>페이지 ${n}</title></head><body>
<button onclick="document.getElementById('o').textContent = '눌림 ' + Date.now(); fetch('/api')">누르기</button>
<input aria-label="입력">
<p id="o"></p>
${Array.from({ length: 100 }, (_, i) => `<a href="/p?n=${i}">링크 ${i}</a>`).join(' ')}
</body></html>`;

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); pend.get(d.id)?.(d.result); pend.delete(d.id); };
  const send = (method: string) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method })); });
  return { send, close: () => ws.close() };
}

async function heapOf(port: number): Promise<number> {
  const [t] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
  const n = await cdp(t.webSocketDebuggerUrl);
  await n.send('HeapProfiler.enable');
  await n.send('HeapProfiler.collectGarbage');
  await n.send('HeapProfiler.collectGarbage');
  const u = await n.send('Runtime.getHeapUsage');
  n.close();
  return u.usedSize / 1048576;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'profiles') total += dirSize(p); } else total += fs.statSync(p).size;
  }
  return total;
}

describe('여러 세션 오래 쓰기', { timeout: 60 * 60_000 }, () => {
  let site: http.Server;
  let url: string;
  let home: string;
  const clients: Client[] = [];

  before(async () => {
    site = http.createServer((q, r) => {
      if (q.url?.startsWith('/api')) return r.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      const n = new URL(q.url ?? '/', 'http://x').searchParams.get('n') ?? '0';
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(n));
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-multi-'));
    for (let k = 0; k < SESSIONS; k++) {
      const c = new Client({ name: `s${k}`, version: '1' });
      await c.connect(new StdioClientTransport({
        command: process.execPath, args: [`--inspect=127.0.0.1:${INSPECT(k)}`, CLI], stderr: 'ignore',
        env: { ...process.env, CDPM_HOME: home, CDPM_TEST_PORT_BASE: String(PORT_BASE), CDPM_TEST_AGENT_FORGET_MS: '20000' } as Record<string, string>,
      }));
      clients.push(c);
    }
  });

  after(async () => {
    await clients[0]?.callTool({ name: 'browser_close', arguments: { slot: 1, agent: 'x' } }).catch(() => undefined);
    for (const c of clients) await c.close().catch(() => undefined);
    site.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(`세션 ${SESSIONS}개가 같은 슬롯을 ${ROUNDS}회씩 써도 메모리·파일·탭이 늘지 않음`, async () => {
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: { slot: 1, ...args } }) as { isError?: boolean; content: { text?: string }[] };
      return { err: !!r.isError, text: r.content.map((x) => x.text ?? '').join(' ') };
    };
    await call(clients[0], 'browser_launch', { agent: 'x', headless: true });
    const errors: string[] = [];
    const round = async (k: number, i: number) => {
      const c = clients[k];
      const agent = `s${k}-sub${i}`;
      const opened = await call(c, 'browser_tab_new', { agent, url: `${url}p?n=${i}` });
      const tab = /Opened new tab: tab \d+ \[(t\d+)\]/.exec(opened.text)?.[1];
      if (!tab) { errors.push(`탭 못 엶: ${opened.text.slice(-120)}`); return; }
      const steps = [
        await call(c, 'browser_navigate', { agent, tab, url: `${url}p?n=${i + 1}` }),
      ];
      const snap = (await call(c, 'browser_snapshot', { agent, tab, interactive: true })).text;
      const btn = /button "누르기" \[(e\d+)\]/.exec(snap)?.[1];
      const box = /textbox "입력" \[(e\d+)\]/.exec(snap)?.[1];
      steps.push(await call(c, 'browser_click', { agent, tab, ref: btn }));
      steps.push(await call(c, 'browser_type', { agent, tab, ref: box, text: `세션${k}-${i}` }));
      steps.push(await call(c, 'slot_send', { agent, text: `세션 ${k}의 ${i}번째` }));
      steps.push(await call(c, 'slot_inbox', { agent }));
      steps.push(await call(c, 'browser_tab_close', { agent, tab }));
      for (const s of steps) if (s.err) errors.push(s.text.slice(-160));
    };

    const samples: { i: number; heaps: number[]; files: number; locks: number; tabs: number }[] = [];
    for (let i = 1; i <= ROUNDS; i++) {
      // 세 세션이 동시에 한 바퀴씩
      await Promise.all(clients.map((_, k) => round(k, i)));
      if (i % RELAUNCH_EVERY === 0 && i < ROUNDS) {
        // 슬롯 껐다 켜기 (다른 세션의 연결·기록도 정리돼야 함)
        await call(clients[i % SESSIONS], 'browser_close', { agent: 'x' });
        await call(clients[(i + 1) % SESSIONS], 'browser_launch', { agent: 'x', headless: true });
      }
      if (i % 100 === 0) {
        const heaps = await Promise.all(clients.map((_, k) => heapOf(INSPECT(k))));
        const list = await (await fetch(`http://127.0.0.1:${PORT_BASE + 1}/json/list`)).json() as { type: string }[];
        const lockDir = path.join(home, 'locks');
        const locks = fs.existsSync(lockDir) ? fs.readdirSync(lockDir).length : 0;
        const s = { i, heaps, files: dirSize(home) / 1024, locks, tabs: list.filter((t) => t.type === 'page').length };
        samples.push(s);
        console.log(`${i}회: 세션 힙 ${heaps.map((h) => h.toFixed(1)).join(' / ')}MB, 기록 파일 ${s.files.toFixed(0)}KB, 잠금 파일 ${locks}개, 탭 ${s.tabs}개, 오류 ${errors.length}`);
      }
    }
    assert.equal(errors.length, 0, `오류 ${errors.length}회: ${errors.slice(0, 3).join(' | ')}`);
    const later = samples.filter((x) => x.i >= ROUNDS / 2);
    const base = later[0];
    const last = later.at(-1)!;
    for (let k = 0; k < SESSIONS; k++) {
      const max = Math.max(...later.map((x) => x.heaps[k]));
      assert.ok(max - base.heaps[k] < 15 && last.heaps[k] - base.heaps[k] < 5, `세션 ${k} 힙이 ${base.heaps[k].toFixed(1)} → ${last.heaps[k].toFixed(1)}MB(최대 ${max.toFixed(1)})로 늘었어요`);
    }
    assert.ok(last.files - base.files < 64, `기록 파일이 ${base.files.toFixed(0)} → ${last.files.toFixed(0)}KB로 늘었어요`);
    assert.ok(last.locks <= 3, `잠금 파일이 ${last.locks}개 남았어요`);
    assert.ok(last.tabs <= 2, `탭이 ${last.tabs}개 남았어요 (닫은 탭이 남음)`);
  });
});
