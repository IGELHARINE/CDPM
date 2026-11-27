// 관제 화면의 "탭을 다른 슬롯으로 넘기기"를 진짜 Chrome 두 개로 시험한다.
// 받는 슬롯에 같은 주소가 열리고 원래 탭이 닫히는지, 쿠키·로그인은 안 따라가는지를 본다 (받는 슬롯이 가진 상태 그대로 연다).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// 실제 슬롯과 부딪히지 않게 시험용 포트와 임시 저장소를 쓴다 (모듈을 읽어 들이기 전에 정해야 한다)
process.env.CDPM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-watch-'));
process.env.CDPM_TEST_PORT_BASE = '29321';
const { launchSlot } = await import('../../src/service.js');
const { moveTab } = await import('../../src/watch/move.js');
const { listPages, probe } = await import('../../src/cdp/targets.js');
const { CdpConnection } = await import('../../src/cdp/client.js');
const { closeAllConnections } = await import('../../src/cdp/sessions.js');
const { portOf } = await import('../../src/slots.js');
const { startWatchServer } = await import('../../src/watch/server.js');

const A = 1, B = 2;
let site: http.Server, base = '';

function startSite(): Promise<void> {
  site = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const who = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const html = (body: string) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>${url.pathname}</title>${body}`); };
    if (url.pathname === '/login') {
      res.writeHead(302, { 'Set-Cookie': `sid=${url.searchParams.get('u')}; Path=/; HttpOnly`, Location: '/home' });
      return res.end();
    }
    if (url.pathname === '/home') {
      if (!who) { res.writeHead(302, { Location: '/login-form' }); return res.end(); }
      return html(`<h1 id="who">안녕 ${who}</h1><a href="/logout">로그아웃</a><input id="memo"><div style="height:3000px"></div><script>document.getElementById('who').dataset.ls = localStorage.getItem('pref') || '';</script>`);
    }
    if (url.pathname === '/login-form') return html('<h1>로그인이 필요합니다</h1>');
    html('ok');
  });
  return new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(site.address() as { port: number }).port}`; r(); }));
}

async function browser(slot: number) {
  const p = await probe(slot, 3000);
  assert.equal(p.state, 'chrome');
  return CdpConnection.connect((p as { version: { webSocketDebuggerUrl: string } }).version.webSocketDebuggerUrl);
}

/** 그 슬롯에 새 탭을 열어 주소로 가고, 탭 ID와 페이지 연결을 돌려준다. */
async function open(slot: number, url: string) {
  const b = await browser(slot);
  const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  b.close();
  const page = await CdpConnection.connect(`ws://127.0.0.1:${portOf(slot)}/devtools/page/${targetId}`);
  await page.send('Page.enable');
  const loaded = page.waitFor('Page.loadEventFired', () => true, 10_000);
  await page.send('Page.navigate', { url });
  await loaded;
  return { targetId, page };
}

type Conn = Awaited<ReturnType<typeof CdpConnection.connect>>;
const js = async <T>(page: Conn, expression: string) => (await page.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

/** 받는 슬롯의 쿠키를 다 지운다 (그 사이트에 로그인 안 된 상태로) */
const clearB = async () => { const b = await browser(B); await b.send('Storage.clearCookies'); b.close(); };

async function pageOf(slot: number, targetId: string) {
  return CdpConnection.connect(`ws://127.0.0.1:${portOf(slot)}/devtools/page/${targetId}`);
}

async function closeSlot(slot: number) {
  const b = await browser(slot).catch(() => undefined);
  await b?.send('Browser.close').catch(() => undefined);
  b?.close();
}

describe('관제: 탭을 다른 슬롯으로 넘기기', () => {
  before(async () => {
    await startSite();
    await launchSlot(A, 'test', { headless: true });
    await launchSlot(B, 'test', { headless: true });
  });
  after(async () => {
    await closeSlot(A);
    await closeSlot(B);
    closeAllConnections();
    site.close();
  });

  it('주소만 다른 슬롯에 열리고 원래 탭은 닫힌다; 쿠키·로그인은 안 따라간다', async () => {
    // A에서 로그인(sid=alice)해 /home 을 연다. B에는 그 로그인이 없다.
    const { targetId, page } = await open(A, `${base}/login?u=alice`);
    assert.equal(await js(page, 'document.getElementById("who").textContent'), '안녕 alice');
    page.close();
    await clearB();
    const r = await moveTab({ from: A, targetId, to: B });
    assert.equal(r.status, 'moved', JSON.stringify(r));
    // 원래 탭은 닫히고, 원래 슬롯에는 탭이 하나는 남는다
    assert.ok(!(await listPages(A)).some((p) => p.id === targetId), '원래 탭이 남아 있음');
    assert.ok((await listPages(A)).length >= 1, '원래 슬롯에 탭이 하나도 없음');
    // B에 같은 주소(/home)로 새 탭이 생겼지만, 로그인이 안 따라가 로그인 화면으로 간다
    const moved = await pageOf(B, r.newTargetId!);
    assert.match(await js(moved, 'location.pathname') as string, /login-form/);
    assert.ok(r.notes.some((n) => /nothing was carried/.test(n)), r.notes.join(' / '));
    moved.close();
  });

  it('관제 서버: 표 없는 요청·다른 이름으로 부른 요청은 거절, 탭 목록·화면이 오고, 누른 것은 바로 적용된다', async () => {
    await clearB();
    const w = await startWatchServer(0);
    try {
      const url = `http://127.0.0.1:${w.port}`;
      assert.equal((await fetch(`${url}/events`)).status, 403);
      assert.equal((await fetch(`${url}/api/tab`, { method: 'POST', body: '{}' })).status, 403);
      // 다른 웹 페이지가 주소를 돌려 이 서버를 부르는 경우 (Host가 다르다)
      const viaOtherName = await new Promise<number>((resolve) => { const r = http.request({ host: '127.0.0.1', port: w.port, path: '/', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.end(); });
      assert.equal(viaOtherName, 403);
      assert.match(await (await fetch(url)).text(), /CDPM Watch/);
      const { targetId, page } = await open(A, `${base}/login?u=carol`);
      page.close();
      // 한 줄 연결로 탭 목록과 화면이 온다
      const got = { state: '', frames: 0 };
      const ctl = new AbortController();
      const stream = fetch(`${url}/events?token=${w.token}&slots=${A}`, { signal: ctl.signal }).then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (const block of buf.split('\n\n').slice(0, -1)) {
            if (block.startsWith('event: state')) got.state = block.slice(block.indexOf('data: ') + 6);
            if (block.startsWith('event: frame')) got.frames++;
          }
          buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
        }
      }).catch(() => undefined);
      for (let i = 0; i < 60 && !(got.frames > 0 && got.state.includes(targetId)); i++) await new Promise((r) => setTimeout(r, 200));
      assert.ok(got.state.includes(targetId), '탭 목록에 새 탭이 없음');
      assert.ok(got.frames > 0, '화면이 오지 않음');
      const post = async (pathname: string, body: unknown) => (await fetch(url + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDPM-Watch': w.token }, body: JSON.stringify(body) })).json() as Promise<{ ok?: boolean; status?: string; message: string }>;
      // 넘기기: 받는 슬롯(B)에는 지금 로그인이 없으므로 로그인과 함께 넘어간다
      const moved = await post('/api/move', { from: A, targetId, to: B });
      assert.equal(moved.status, 'moved', JSON.stringify(moved));
      // 탭 닫기는 AI를 거치지 않고 바로
      const extra = await open(A, `${base}/home`);
      extra.page.close();
      const closed = await post('/api/tab', { slot: A, targetId: extra.targetId, action: 'close' });
      assert.equal(closed.ok, true, JSON.stringify(closed));
      for (let i = 0; i < 15 && (await listPages(A)).some((p) => p.id === extra.targetId); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(!(await listPages(A)).some((p) => p.id === extra.targetId), '탭이 닫히지 않음');
      // 슬롯 멈추기·다시 시작
      assert.equal((await post('/api/slot', { slot: A, action: 'pause' })).ok, true);
      assert.equal((await post('/api/slot', { slot: A, action: 'resume' })).ok, true);
      ctl.abort();
      await stream;
    } finally {
      w.close(false);
    }
  });

  it('관제: 탭에 뜬 알림창을 보여 주고, 닫히면 표시도 사라진다', async () => {
    const w = await startWatchServer(0);
    try {
      const url = `http://127.0.0.1:${w.port}`;
      const { targetId, page } = await open(A, `${base}/home`);
      let state = '';
      const ctl = new AbortController();
      const stream = fetch(`${url}/events?token=${w.token}&slots=${A}`, { signal: ctl.signal }).then(async (r) => {
        const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop() ?? ''; for (const b of parts) if (b.startsWith('event: state')) state = b.slice(b.indexOf('data: ') + 6); }
      }).catch(() => undefined);
      // 관제가 이 탭에 붙을 때까지 기다린 뒤 확인창을 띄운다
      for (let i = 0; i < 50 && !state.includes(targetId); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 2000));
      const answer = page.send<{ result: { value: boolean } }>('Runtime.evaluate', { expression: "confirm('지울까요?')", returnByValue: true }, 30_000);
      for (let i = 0; i < 50 && !state.includes('지울까요?'); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(state, /"dialog":\{"type":"confirm","message":"지울까요\?"/);
      // 답은 브라우저 쪽에서 (관제는 보여 주기만 한다)
      await page.send('Page.handleJavaScriptDialog', { accept: true });
      assert.equal((await answer).result.value, true);
      for (let i = 0; i < 30 && state.includes('지울까요?'); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(!state.includes('"dialog"'), '닫힌 뒤에도 알림창 표시가 남음');
      // 슬롯 번호가 1~99 밖이면 거절
      assert.equal((await fetch(`${url}/api/tab`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDPM-Watch': w.token }, body: JSON.stringify({ slot: 50000, targetId, action: 'reload' }) })).status, 400);
      page.close();
      ctl.abort();
      await stream;
    } finally {
      w.close(false);
    }
  });

  it('꺼진 슬롯, 다시 열 수 없는 화면, 이미 닫힌 탭', async () => {
    await clearB();
    const { targetId, page } = await open(A, `${base}/home`);
    page.close();
    const moved = await moveTab({ from: A, targetId, to: B });
    assert.equal(moved.status, 'moved', JSON.stringify(moved));
    assert.ok(!(await listPages(A)).some((p) => p.id === targetId), '원래 탭이 닫히지 않음');
    assert.equal((await moveTab({ from: A, targetId, to: 9 })).status, 'failed');
    const internal = await open(A, 'chrome://version');
    internal.page.close();
    const no = await moveTab({ from: A, targetId: internal.targetId, to: B });
    assert.equal(no.status, 'failed');
    assert.match(no.message, /can't be reopened/);
    assert.equal((await moveTab({ from: A, targetId: 'nope', to: B })).status, 'failed');
  });
});
