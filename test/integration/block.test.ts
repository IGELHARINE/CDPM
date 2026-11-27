// 요청 막기(browser_block)가 CDP 단계에서 여러 경로를 빠짐없이 막는지 진짜 Chrome으로 시험한다.
// 페이지·이미지·스크립트·fetch·XHR·sendBeacon·다른 사이트 iframe·전용/공유/서비스 워커·EventSource·prefetch·떠날 때 beacon.
// 막는 동안에도 워커가 멈추지 않고(막지 않은 요청은 그대로 나감), 규칙을 풀면 다시 나가는지도 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.CDPM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-block-'));
process.env.CDPM_TEST_PORT_BASE = '29421';
const { launchSlot, attachSlot, syncTabs } = await import('../../src/service.js');
const { pageSession, closeAllConnections, browserConnection } = await import('../../src/cdp/sessions.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hits = new Map<string, number>();
const hit = (k: string) => hits.set(k, (hits.get(k) ?? 0) + 1);
let col: http.Server, site: http.Server, C = '', S = '';

const SENT = ['css', 'img', 'script', 'fetch', 'xhr', 'beacon', 'oopif', 'oopif-beacon', 'worker', 'shared', 'sw', 'es', 'prefetch', 'late-img', 'unload-beacon'];
const ALIVE = ['alive-worker', 'alive-shared', 'alive-sw'];

function servers(): Promise<void> {
  col = http.createServer((req, res) => {
    const k = new URL(req.url ?? '/', 'http://x').searchParams.get('k') ?? '?';
    if (req.url?.startsWith('/collect')) hit(k);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': k === 'es' ? 'text/event-stream' : 'text/plain' });
    res.end(k === 'es' ? 'data: x\n\n' : '');
  });
  const u = (k: string) => `http://${C}/collect?k=${k}`;
  site = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/alive') hit(`alive-${url.searchParams.get('k')}`);
    const js = (b: string) => { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(b); };
    if (url.pathname === '/w.js') return js(`fetch('/alive?k=worker');fetch('${u('worker')}')`);
    if (url.pathname === '/sw.js') return js(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>{fetch('/alive?k=sw');fetch('${u('sw')}')});`);
    if (url.pathname === '/shared.js') return js(`onconnect=()=>{fetch('/alive?k=shared');fetch('${u('shared')}')}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (url.pathname === '/frame') return res.end(`<script>fetch('${u('oopif')}');navigator.sendBeacon('${u('oopif-beacon')}','x')</script>`);
    if (url.pathname !== '/') return res.end('');
    res.end(`<!doctype html><title>t</title><link rel="stylesheet" href="${u('css')}"><img src="${u('img')}">
<script src="${u('script')}"></script>
<iframe src="http://localhost:${(site.address() as { port: number }).port}/frame"></iframe>
<script>
window.R={};
fetch('${u('fetch')}').then(r=>R.fetch='ok',()=>R.fetch='err');
const x=new XMLHttpRequest();x.open('POST','${u('xhr')}');x.send('a');
navigator.sendBeacon('${u('beacon')}','data');
new Worker('/w.js');
new SharedWorker('/shared.js?'+Math.random()).port.start();
new EventSource('${u('es')}');
const l=document.createElement('link');l.rel='prefetch';l.href='${u('prefetch')}';document.head.append(l);
navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>setTimeout(()=>r.active.postMessage(1),300));
setTimeout(()=>{const i=new Image();i.onload=()=>R.img='load';i.onerror=()=>R.img='error';i.src='${u('late-img')}'},800);
addEventListener('pagehide',()=>navigator.sendBeacon('${u('unload-beacon')}','bye'));
</script>`);
  });
  return Promise.all([col, site].map((srv) => new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r())))).then(() => {
    C = `127.0.0.1:${(col.address() as { port: number }).port}`;
    S = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  });
}

type Session = Awaited<ReturnType<typeof pageSession>>;
let s: Session;

/** 페이지를 열었다가 떠나며, 그동안 수집 서버·페이지 서버에 닿은 것과 페이지가 본 결과를 돌려준다. */
async function visit(): Promise<{ seen: Record<string, unknown> }> {
  hits.clear();
  await s.send('Page.navigate', { url: S });
  for (let i = 0; i < 40 && !ALIVE.every((k) => hits.get(k)); i++) await sleep(150);
  await sleep(1200);
  const seen = JSON.parse((await s.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'JSON.stringify(window.R)', returnByValue: true })).result.value);
  await s.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  return { seen };
}

describe('요청 막기: CDP 단계에서 모든 경로', () => {
  before(async () => {
    await servers();
    await launchSlot(1, 'test', { headless: true });
    await attachSlot(1);
    const b = await browserConnection(1);
    const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    await syncTabs(1);
    s = await pageSession(1, targetId);
    await s.send('Page.enable');
    // 서비스 워커가 자리 잡게 한 번 열어 둔다
    await visit();
  });
  after(async () => {
    const b = await browserConnection(1).catch(() => undefined);
    await b?.send('Browser.close').catch(() => undefined);
    closeAllConnections();
    col.close();
    site.close();
  });

  it('막지 않으면 다 나간다 (시험 장치 확인)', async () => {
    await visit();
    for (const k of [...SENT, ...ALIVE]) assert.ok(hits.get(k), `${k} 가 안 나감`);
  });

  it('막으면 어느 경로로도 안 나가고, 워커는 멈추지 않는다; 페이지는 실패를 본다', async () => {
    await s.network.setRules([{ pattern: `*${C}/collect*`, agent: 't', at: '' }]);
    const { seen } = await visit();
    for (const k of SENT) assert.equal(hits.get(k) ?? 0, 0, `${k} 가 막히지 않음`);
    for (const k of ALIVE) assert.ok(hits.get(k), `${k}: 워커가 멈춤`);
    assert.equal(seen.fetch, 'err');
  });

  it('quiet: 보내지 않고 빈 성공을 준다 (페이지는 막힌 줄 모른다)', async () => {
    await s.network.setRules([{ pattern: `*${C}/collect*`, agent: 't', at: '', mode: 'empty' }]);
    const { seen } = await visit();
    for (const k of SENT) assert.equal(hits.get(k) ?? 0, 0, `${k} 가 막히지 않음`);
    for (const k of ALIVE) assert.ok(hits.get(k), `${k}: 워커가 멈춤`);
    assert.equal(seen.fetch, 'ok');
    assert.equal(seen.img, 'load');
  });

  it('업체 규칙은 지금 사이트 자신의 요청은 막지 않고, 다른 사이트로 옮기면 다시 막는다', async () => {
    // 수집 서버(127.0.0.1)를 "업체"로 친 규칙. 127.0.0.1 페이지에서는 자기 사이트라 막지 않는다
    await s.network.setRules([{ pattern: `*${C}/collect*`, agent: 't', at: '', label: 'test vendor', thirdParty: true }]);
    await visit();
    assert.ok(hits.get('fetch'), '자기 사이트 요청을 막음');
    // localhost 페이지(다른 사이트)로 가면 같은 규칙이 막아야 한다 (예전 사이트가 남아 있으면 안 막힘)
    hits.clear();
    const other = S.replace('127.0.0.1', 'localhost');
    await s.send('Page.navigate', { url: other });
    for (let i = 0; i < 40 && !ALIVE.every((k) => hits.get(k)); i++) await sleep(150);
    await sleep(1200);
    await s.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    assert.equal(hits.get('fetch') ?? 0, 0, '다른 사이트로 옮긴 뒤에도 업체 요청이 나감');
  });

  it('규칙을 풀면 다시 나간다 (공유 워커 포함)', async () => {
    await s.network.setRules([]);
    await visit();
    for (const k of [...SENT, ...ALIVE]) assert.ok(hits.get(k), `${k} 가 다시 안 나감`);
  });
});
