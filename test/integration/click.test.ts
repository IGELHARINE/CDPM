// 가림 확인과 다른 사이트 iframe 안 클릭을 진짜 Chrome으로 시험한다.
// 스크롤해야 보이는 버튼을 팝업이 덮었을 때 누르지 않는지(예전에는 좌표 기준이 달라 가림 확인이 조용히 건너뛰어졌다),
// 긴 iframe 아래쪽 버튼을 제자리에서 누르는지, 바깥 페이지 팝업이 iframe을 덮으면 누르지 않는지 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.CDPM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-click-'));
process.env.CDPM_TEST_PORT_BASE = '29471';
const { launchSlot, attachSlot, syncTabs } = await import('../../src/service.js');
const { pageSession, browserConnection, closeAllConnections } = await import('../../src/cdp/sessions.js');
const { takeSnapshot } = await import('../../src/page/snapshot.js');
const act = await import('../../src/page/actions.js');

let clicks: string[] = [];
let srv: http.Server, U = '';

function server(): Promise<void> {
  srv = http.createServer((q, r) => {
    const u = new URL(q.url ?? '/', 'http://x');
    if (u.pathname === '/hit') { clicks.push(u.searchParams.get('b') ?? ''); r.end('ok'); return; }
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const modal = u.searchParams.has('modal') ? '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9"><div style="background:#fff;margin:100px auto;width:300px;padding:20px">팝업</div></div>' : '';
    if (u.pathname === '/pay') return r.end(`<body style="margin:0"><div style="height:1400px"></div><button style="width:200px;height:40px" onclick="fetch('/hit?b=pay')">결제하기</button><div style="height:300px"></div></body>`);
    if (u.pathname === '/frame') return r.end(`<title>f</title><div style="height:900px"></div><iframe src="http://localhost:${(srv.address() as { port: number }).port}/pay" style="width:500px;height:500px"></iframe><div style="height:1500px"></div>${modal}`);
    r.end(`<title>p</title><div style="height:1500px"></div><button onclick="fetch('/hit?b=buy')">구매하기</button><div style="height:1500px"></div>${modal}`);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => { U = `http://127.0.0.1:${(srv.address() as { port: number }).port}`; res(); }));
}

type Session = Awaited<ReturnType<typeof pageSession>>;
let s: Session;

async function open(url: string, label: string): Promise<string> {
  clicks = [];
  await s.send('Page.navigate', { url });
  // 다른 사이트 iframe이 있어도 네트워크가 조용해졌다고 알아야 한다 (예전에는 iframe 문서 요청이 영원히 '진행 중'으로 남았다)
  const idle = await act.waitNetworkIdle(s, 10, 300);
  assert.match(idle, /Network idle/, `${url}: ${idle}`);
  const { text } = await takeSnapshot(s, 't');
  const ref = new RegExp(`button "${label}" \\[(e\\d+)\\]`).exec(text)?.[1];
  assert.ok(ref, `${label} 버튼 없음:\n${text}`);
  return ref;
}

describe('클릭: 가림 확인과 iframe', () => {
  before(async () => {
    await server();
    await launchSlot(1, 'test', { headless: true });
    await attachSlot(1);
    const b = await browserConnection(1);
    const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    await syncTabs(1);
    s = await pageSession(1, targetId);
  });
  after(async () => {
    const b = await browserConnection(1).catch(() => undefined);
    await b?.send('Browser.close').catch(() => undefined);
    closeAllConnections();
    srv.close();
  });

  it('스크롤해야 보이는 버튼: 가려져 있지 않으면 누르고, 팝업이 덮으면 누르지 않는다', async () => {
    let ref = await open(`${U}/`, '구매하기');
    await act.click(s, 't', ref);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(clicks, ['buy']);
    ref = await open(`${U}/?modal`, '구매하기');
    await assert.rejects(act.click(s, 't', ref), /팝업.*is covering/);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(clicks, []);
  });

  it('다른 사이트 iframe: 긴 iframe 아래쪽 버튼을 누르고, 바깥 팝업이 덮으면 누르지 않는다', async () => {
    let ref = await open(`${U}/frame`, '결제하기');
    await act.click(s, 't', ref);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(clicks, ['pay']);
    ref = await open(`${U}/frame?modal`, '결제하기');
    await assert.rejects(act.click(s, 't', ref), /팝업.*covering the frame/);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(clicks, []);
  });
});
