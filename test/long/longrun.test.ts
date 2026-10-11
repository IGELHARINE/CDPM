// 오래 켜 두기 시험 (npm run test:long, 약 5분). 매번 돌리는 테스트에는 넣지 않는다.
// 주소가 안 바뀌는 SPA에서 "다시 그리기(버튼 200개를 새 요소로 교체) → 스냅샷 → 클릭 → 입력 → 버튼 켜짐 기다리기"를
// 반복하면서, 반복마다 새 에이전트 이름을 쓴다 (서브에이전트가 계속 새로 뜨는 상황).
// CDPM 서버의 정리 후 힙과 Chrome 페이지의 요소 수·JS 힙이 계속 늘지 않는지 본다.
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
const ROUNDS = Number(process.env.CDPM_LONG_ROUNDS) || 3000;
const PORT_BASE = 29621;
const INSPECT = 9349;

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>SPA</title></head><body>
<button id="re" onclick="draw()">다시 그리기</button><button id="go" disabled>다음</button><input id="q" aria-label="검색"><div id="list"></div>
<script>
let n = 0;
function draw() {
  n++;
  const go = document.getElementById('go'); go.disabled = true; setTimeout(() => (go.disabled = false), 20);
  document.getElementById('list').replaceChildren(...Array.from({ length: 200 }, (_, i) => { const b = document.createElement('button'); b.textContent = '항목 ' + n + '-' + i; return b; }));
  fetch('/api?n=' + n);
}
draw();
</script></body></html>`;

/** CDP 명령 몇 개만 보내는 작은 연결 (Node 디버거·Chrome 탭 둘 다) */
async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); pend.get(d.id)?.(d.result); pend.delete(d.id); };
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

describe('오래 켜 두기', { timeout: 30 * 60_000 }, () => {
  let site: http.Server;
  let url: string;
  let home: string;
  let c: Client;

  before(async () => {
    site = http.createServer((q, r) => {
      if (q.url?.startsWith('/api')) return r.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-long-'));
    c = new Client({ name: 'long', version: '1' });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [`--inspect=127.0.0.1:${INSPECT}`, CLI], stderr: 'ignore',
      // 에이전트 정리를 시험 안에서 보려고 6시간 대신 20초
      env: { ...process.env, CDPM_HOME: home, CDPM_TEST_PORT_BASE: String(PORT_BASE), CDPM_TEST_AGENT_FORGET_MS: '20000' } as Record<string, string>,
    }));
  });

  after(async () => {
    await c.callTool({ name: 'browser_close', arguments: { slot: 1, agent: 'long' } }).catch(() => undefined);
    await c.close().catch(() => undefined);
    site.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(`${ROUNDS}회 반복해도 CDPM 서버와 Chrome 페이지 메모리가 늘지 않음`, async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: { slot: 1, ...args } }) as { isError?: boolean; content: { text?: string }[] };
      return { err: !!r.isError, text: r.content.map((x) => x.text ?? '').join(' ') };
    };
    const serverHeap = async () => {
      const [t] = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
      const n = await cdp(t.webSocketDebuggerUrl);
      await n.send('HeapProfiler.enable');
      await n.send('HeapProfiler.collectGarbage');
      await n.send('HeapProfiler.collectGarbage');
      const u = await n.send('Runtime.getHeapUsage');
      n.close();
      return u.usedSize / 1048576;
    };
    const pageCounters = async () => {
      const list = await (await fetch(`http://127.0.0.1:${PORT_BASE + 1}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      const p = await cdp(list.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
      await p.send('HeapProfiler.collectGarbage');
      const d = await p.send('Memory.getDOMCounters');
      const h = await p.send('Runtime.getHeapUsage');
      p.close();
      return { nodes: d.nodes as number, heap: h.usedSize / 1048576 };
    };

    await call('browser_launch', { agent: 'long', headless: true, url });
    await new Promise((r) => setTimeout(r, 800));
    const samples: { i: number; server: number; nodes: number; page: number }[] = [];
    let errors = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      const agent = `sub-${i}`; // 반복마다 새 서브에이전트
      const snap = (await call('browser_snapshot', { agent, interactive: true })).text;
      const re = /button "다시 그리기" \[(e\d+)\]/.exec(snap)?.[1];
      const go = /button "다음"[^[]*\[(e\d+)\]/.exec(snap)?.[1];
      const q = /textbox "검색" \[(e\d+)\]/.exec(snap)?.[1];
      const r1 = await call('browser_click', { agent, ref: re });
      const r2 = await call('browser_type', { agent, ref: q, text: 'abc', clear: true });
      const r3 = await call('browser_wait', { agent, enabled: go, timeout: 10 });
      if (!re || !go || !q || r1.err || r2.err || r3.err) errors++;
      if (i % 100 === 0) {
        const pc = await pageCounters();
        samples.push({ i, server: await serverHeap(), nodes: pc.nodes, page: pc.heap });
        const s = samples.at(-1)!;
        console.log(`${i}회: 서버 힙 ${s.server.toFixed(1)}MB, 페이지 요소 ${s.nodes}개, 페이지 힙 ${s.page.toFixed(1)}MB, 오류 ${errors}`);
      }
    }
    assert.equal(errors, 0, `오류 ${errors}회`);
    // 반복마다 새 에이전트 이름을 쓰므로, 서버 힙은 "안 보이는 에이전트 기록을 1분마다 정리"하는 톱니 모양으로 오르내린다.
    // 누수면 뒤쪽의 꼭대기·바닥이 앞쪽보다 계속 높아지고, 톱니만 있으면 같다 → 앞 절반과 뒤 절반의 최고·최저를 비교한다.
    // (처음 250회는 기록·캐시가 정해진 최대치까지 차는 구간이라 뺀다)
    const front = samples.filter((x) => x.i >= 250 && x.i <= ROUNDS / 2);
    const later = samples.filter((x) => x.i > ROUNDS / 2);
    const base = later[0];
    const last = later.at(-1)!;
    const hi = (xs: typeof samples) => Math.max(...xs.map((x) => x.server));
    const lo = (xs: typeof samples) => Math.min(...xs.map((x) => x.server));
    assert.ok(hi(later) - hi(front) < 4 && lo(later) - lo(front) < 4,
      `CDPM 서버 힙이 계속 늘었어요: 앞 절반 ${lo(front).toFixed(1)}~${hi(front).toFixed(1)}MB → 뒤 절반 ${lo(later).toFixed(1)}~${hi(later).toFixed(1)}MB`);
    assert.ok(last.nodes <= base.nodes * 1.1 + 50, `페이지 요소가 ${base.nodes} → ${last.nodes}개로 늘었어요 (사라진 요소를 붙잡고 있음)`);
    assert.ok(last.page - base.page < 2, `페이지 힙이 ${base.page.toFixed(1)} → ${last.page.toFixed(1)}MB로 늘었어요`);
  });
});
