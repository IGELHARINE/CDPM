// 진짜 Chrome + 진짜 MCP 서버(stdio)로 도구를 호출하는 통합 테스트.
// 사용자의 실제 1~30번(14050~)과 부딪히지 않도록 테스트 전용 포트(29222~)와 임시 저장소를 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSite } from '../fixtures/site.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-it-'));
const ENV = { ...process.env, CDPM_HOME: HOME, CDPM_TEST_PORT_BASE: '29221' } as Record<string, string>;
const SLOT = 1;
const PORT = 29222;

async function connect(): Promise<Client> {
  const client = new Client({ name: 'cdpm-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: ENV }));
  return client;
}

type Result = { text: string; isError: boolean; images: number };

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return {
    text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'),
    isError: !!r.isError,
    images: r.content.filter((x) => x.type === 'image').length,
  };
}

function ref(snapshot: string, pattern: RegExp): string {
  const m = snapshot.match(pattern);
  assert.ok(m, `스냅샷에서 ${pattern}를 찾지 못함:\n${snapshot}`);
  return m[1];
}

async function portOpen(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** 테스트 정리용: CDPM은 dialog를 처리하지 않으므로 테스트가 직접 닫는다. */
async function dismissDialogs() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  for (const p of pages.filter((x) => x.type === 'page')) {
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
    ws.send(JSON.stringify({ id: 2, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
  }
}

describe('CDPM MCP 통합', { timeout: 180_000 }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let a: Client;
  let b: Client;

  before(async () => {
    site = await startSite();
    a = await connect();
    b = await connect();
  });

  after(async () => {
    await call(a, 'browser_close', { slot: SLOT }).catch(() => undefined);
    await a?.close();
    await b?.close();
    await site?.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('도구 목록', async () => {
    const { tools } = await a.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['browser_status', 'browser_snapshot', 'browser_click', 'slot_send', 'slot_inbox']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /dialog/.test(n)), 'dialog 처리 도구는 없어야 함');
  });

  it('범위 밖 슬롯은 거부', async () => {
    const r = await a.callTool({ name: 'browser_launch', arguments: { slot: 31 } });
    assert.ok(r.isError);
  });

  it('꺼진 슬롯은 다른 도구가 켜지 않음', async () => {
    const r = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.equal(r.isError, true);
    assert.match(r.text, /1번 Chrome은 꺼져 있어요/);
    assert.equal(await portOpen(PORT), false);
  });

  it('실행, 이동, 스냅샷', async () => {
    const asked = await call(a, 'browser_launch', { agent: 'A' });
    assert.match(asked.text, /\[확인 필요\]/);
    const launched = await call(a, 'browser_launch', { agent: 'A', headless: false });
    assert.match(launched.text, /1번 Chrome을 창 모드로 켰어요/);
    assert.match(launched.text, /비어 있는 가장 작은 슬롯/);
    assert.match(launched.text, /연 사람: A/);

    const nav = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url, summary: '테스트 메인 확인' });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /\[1번\] 탭 1개 · 1번 탭 \[t1\]에서 실행함/);

    const snap = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.match(snap.text, /heading "테스트 메인"/);
    assert.match(snap.text, /textbox "검색어" \[e\d+\]: "기존값"/);
    assert.match(snap.text, /link "두번째로 가기" \[e\d+\] → \/page2/);
    assert.match(snap.text, /iframe "내부 프레임"/);
    assert.match(snap.text, /button "프레임 버튼" \[e\d+\]/);
  });

  it('입력(clear) → 클릭 → 글자 대기', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const box = ref(snap, /textbox "검색어" \[(e\d+)\]/);
    const btn = ref(snap, /button "검색" \[(e\d+)\]/);
    const typed = await call(a, 'browser_type', { slot: SLOT, agent: 'A', ref: box, text: '노트북', clear: true });
    assert.equal(typed.isError, false, typed.text);
    const clicked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: btn });
    assert.equal(clicked.isError, false, clicked.text);
    const waited = await call(a, 'browser_wait', { slot: SLOT, agent: 'A', text: '결과: 노트북', timeout: 5 });
    assert.equal(waited.isError, false, waited.text);
    const listed = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    assert.match(listed.text, /마지막: A 클릭/);
  });

  it('read: 이동하면서 본문, 클릭하면서 바뀐 부분만, 폼 채우기', async () => {
    const nav = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: `${site.url}/page2`, read: 'text' });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /\[화면: 본문\][\s\S]*여기는 두번째입니다/);
    const back = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url, read: 'snapshot' });
    const box = ref(back.text, /textbox "검색어" \[(e\d+)\]/);
    const btn = ref(back.text, /button "검색" \[(e\d+)\]/);
    const filled = await call(a, 'browser_fill', { slot: SLOT, agent: 'A', fields: [{ ref: box, text: '가방' }], submit: btn, read: 'changes' });
    assert.equal(filled.isError, false, filled.text);
    assert.match(filled.text, /1\. 입력했어요/);
    assert.match(filled.text, /\[화면: 바뀐 부분\][\s\S]*\+ .*결과: 가방/);
    const same = await call(a, 'browser_scroll', { slot: SLOT, agent: 'A', dy: 0, read: 'changes' });
    assert.match(same.text, /화면 변화 없음/);
  });

  it('큰 페이지용: interactive 스냅샷, find 여러 낱말, 주소 바뀔 때까지 기다리기', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
    const inter = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', interactive: true });
    assert.match(inter.text, /textbox "검색어" \[e\d+\]/);
    assert.doesNotMatch(inter.text, /paragraph/);
    const found = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', find: 'subject|검색어' });
    assert.match(found.text, /textbox "검색어"/);
    const t0 = Date.now();
    const [waited] = await Promise.all([
      call(a, 'browser_wait', { slot: SLOT, agent: 'A', url: '/page2', timeout: 20 }),
      (async () => { await new Promise((r) => setTimeout(r, 800)); await call(b, 'browser_navigate', { slot: SLOT, agent: 'B', tab: 1, url: `${site.url}/page2`, multiSlot: true }); })(),
    ]);
    assert.equal(waited.isError, false, waited.text);
    assert.match(waited.text, /주소가 바뀌었어요/);
    assert.ok(Date.now() - t0 < 5000, '바뀌면 바로 돌아와야 함');
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
    // 글자가 사라질 때까지 (로그인 폼이 사라지는 것 감지): 화면은 건드리지 않고, 사라지면 바로 돌아옴
    const [gone] = await Promise.all([
      call(a, 'browser_wait', { slot: SLOT, agent: 'A', gone: '두번째로 가기', timeout: 20 }),
      (async () => { await new Promise((r) => setTimeout(r, 600)); await call(b, 'browser_navigate', { slot: SLOT, agent: 'B', tab: 1, url: `${site.url}/page2`, multiSlot: true }); })(),
    ]);
    assert.match(gone.text, /글자가 사라졌어요/);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
  });

  it('가려진 요소는 클릭하지 않음', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const under = ref(snap, /button "가려진 버튼" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: under });
    assert.equal(r.isError, true);
    assert.match(r.text, /가리고 있어요/);
    assert.match(r.text, /overlay/);
  });

  it('카드를 덮는 투명 링크는 막지 않고 눌림 (구글 뉴스식)', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: `${site.url}/cards` });
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const title = ref(snap, /heading "카드 기사 제목" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: title });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /두번째/);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
  });

  it('다른 사이트 iframe(별도 프로세스) 안의 입력칸·버튼도 보이고 입력·클릭됨', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: `${site.url}/xframe` });
    let snap = '';
    for (let i = 0; i < 20 && !/textbox "교차 입력"/.test(snap); i++) {
      await new Promise((r) => setTimeout(r, 250));
      snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    }
    const box = ref(snap, /textbox "교차 입력" \[(e\d+)\]/);
    const btn = ref(snap, /button "교차 버튼" \[(e\d+)\]/);
    const typed = await call(a, 'browser_type', { slot: SLOT, agent: 'A', ref: box, text: '안녕' });
    assert.equal(typed.isError, false, typed.text);
    const clicked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: btn, read: 'changes' });
    assert.equal(clicked.isError, false, clicked.text);
    assert.match(clicked.text, /교차 값: 안녕 \/ 교차 눌림/);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
  });

  it('iframe 안 버튼 클릭', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const fb = ref(snap, /button "프레임 버튼" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: fb });
    assert.equal(r.isError, false, r.text);
    const after = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    assert.match(after, /button "눌림"/);
  });

  it('링크 클릭으로 이동 → 뒤로', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const link = ref(snap, /link "두번째로 가기" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: link });
    assert.match(r.text, /로딩 완료/);
    assert.match((await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text, /두번째 페이지/);
    const stale = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: link });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /browser_snapshot을 다시 찍으세요/);
    const back = await call(a, 'browser_back', { slot: SLOT, agent: 'A' });
    assert.equal(back.isError, false, back.text);
    assert.match((await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text, /테스트 메인/);
  });

  it('키 입력, JS 실행, 스크린샷, 늦게 나타나는 글자', async () => {
    assert.equal((await call(a, 'browser_press_key', { slot: SLOT, agent: 'A', key: 'Tab' })).isError, false);
    assert.equal((await call(a, 'browser_press_key', { slot: SLOT, agent: 'A', key: '없는키' })).isError, true);
    const ev = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', expression: '1 + 2' });
    assert.match(ev.text, /---\n3$/);
    const shot = await call(a, 'browser_screenshot', { slot: SLOT, agent: 'A' });
    assert.equal(shot.images, 1, shot.text);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: `${site.url}/slow` });
    const w = await call(a, 'browser_wait', { slot: SLOT, agent: 'A', text: '늦게 나타남', timeout: 5 });
    assert.equal(w.isError, false, w.text);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
  });

  it('탭이 여러 개면 조작 도구는 tab 지정 필요, 보기는 앞 탭', async () => {
    const opened = await call(b, 'browser_tab_new', { slot: SLOT, agent: 'B', url: `${site.url}/page2`, summary: 'B 전용 탭' });
    assert.match(opened.text, /새 탭을 열었어요: 2번 \[t\d+\]/);
    assert.match(opened.text, /연 사람: B/);
    // 아직 아무 탭도 안 쓴 에이전트는 탭을 지정해야 한다
    const noTab = await call(a, 'browser_click', { slot: SLOT, agent: 'C', ref: 'e1' });
    assert.equal(noTab.isError, true);
    assert.match(noTab.text, /탭이 2개 있고 이 에이전트가 아직 쓴 탭이 없어요/);
    // 쓴 적이 있는 에이전트는 자기 마지막 탭(t1)에서 실행된다
    const mine = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.match(mine.text, /1번 탭 \[t1\]에서 실행함/);
    const view = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.equal(view.isError, false, view.text);
  });

  it('남의 탭 조작 시 경고만 (막지 않음)', async () => {
    const snap = (await call(b, 'browser_snapshot', { slot: SLOT, agent: 'B', tab: 1 })).text;
    const box = ref(snap, /textbox "검색어" \[(e\d+)\]/);
    const r = await call(b, 'browser_type', { slot: SLOT, agent: 'B', tab: 1, ref: box, text: 'x' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /\[주의\] 이 탭 \[t1\]은 A이\(가\) .*했어요/);
  });

  it('에이전트 간 메시지: 머리말 전달 + inbox 대기', async () => {
    const sent = await call(a, 'slot_send', { slot: SLOT, agent: 'A', text: '나 t1 쓸게', to: 'B' });
    assert.match(sent.text, /보냈어요/);
    const r = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.match(r.text, /새 메시지 1개 \(여기서 읽음 처리됨[^)]*\)\n {2}A → B \(.*\): 나 t1 쓸게/);
    const again = await call(b, 'slot_inbox', { slot: SLOT, agent: 'B' });
    assert.match(again.text, /새 메시지가 없어요/);
    const waiting = call(b, 'slot_inbox', { slot: SLOT, agent: 'B', wait: 10 });
    await new Promise((res) => setTimeout(res, 500));
    await call(a, 'slot_send', { slot: SLOT, agent: 'A', text: '끝났어' });
    const got = await waiting;
    assert.match(got.text, /A \(.*\): 끝났어/);
  });

  it('상태 보기와 요약', async () => {
    const st = await call(a, 'browser_status', {});
    assert.match(st.text, /\[1번\] 포트 29222 · 탭 2개/);
    assert.match(st.text, /요약: B — B 전용 탭/);
  });

  it('알림창: 감지하고 알리기만, 처리하지 않음 (다른 탭·다른 세션은 멈추지 않음)', async () => {
    // 알림창은 CDPM이 닫지 않으므로 전용 탭에서 띄우고 마지막에 탭을 닫는다.
    const opened = await call(a, 'browser_tab_new', { slot: SLOT, agent: 'A', url: site.url });
    const id = opened.text.match(/새 탭을 열었어요: \d+번 \[(t\d+)\]/)![1];
    await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: id, text: '알림 띄우기', timeout: 5 });
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: id, find: '알림' })).text;
    const btn = ref(snap, /button "알림 띄우기" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: btn });
    assert.equal(r.isError, false, '클릭은 이루어졌으므로 오류가 아님');
    assert.match(r.text, /행동은 실행됐고, 그 결과 alert 알림창이 떴어요: "안녕하세요"/);
    const blocked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: btn });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /알림창이 떠 있어요/);
    // 처리하지 않았는지: 아직 떠 있어야 함
    const still = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    assert.match(still.text, new RegExp(`\\[주의\\] alert 알림창 떠 있음 \\(\\d+번 탭 \\[${id}\\]\\)`));
    // 다른 탭은 정상
    const other = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1' });
    assert.equal(other.isError, false, other.text);
    // 다른 세션(B)이 이 슬롯을 봐도 오래 멈추지 않음 (알림창이 뜬 뒤 처음 붙는 연결)
    const t0 = Date.now();
    const seen = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.ok(Date.now() - t0 < 4000, `다른 세션이 ${Date.now() - t0}ms 멈춤`);
    assert.match(seen.text, new RegExp(`\\[${id}\\]`));
    // 알림창이 떠 있는 탭도 닫을 수 있음
    const closed = await call(a, 'browser_tab_close', { slot: SLOT, agent: 'A', tab: id });
    assert.match(closed.text, /탭을 닫았어요/);
  });

  it('드롭다운은 browser_select, 시간 입력칸은 형식대로, 파일 칸은 클릭 → 업로드', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', tab: 't1', url: site.url });
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '크기' })).text;
    const sel = ref(snap, /combobox "크기" \[(e\d+)\]/);
    const picked = await call(a, 'browser_select', { slot: SLOT, agent: 'A', tab: 't1', ref: sel, option: '크게' });
    assert.match(picked.text, /골랐어요: \[e\d+\] "크게" \(값: l\)/);
    const wrong = await call(a, 'browser_select', { slot: SLOT, agent: 'A', tab: 't1', ref: sel, option: '없는항목' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /고를 수 있는 항목:[\s\S]*작게/);
    const clickSel = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: sel });
    assert.equal(clickSel.isError, true);
    assert.match(clickSel.text, /browser_select/);

    const full = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '배달' })).text;
    const time = ref(full, /배달 시간[\s\S]*?\[(e\d+)\]/);
    const typed = await call(a, 'browser_type', { slot: SLOT, agent: 'A', tab: 't1', ref: time, text: '19:30' });
    assert.equal(typed.isError, false, typed.text);
    assert.match(typed.text, /time 입력칸에 값을 직접 넣음/);
    const bad = await call(a, 'browser_type', { slot: SLOT, agent: 'A', tab: 't1', ref: time, text: '저녁' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /HH:MM/);
    assert.match(bad.text, /원래 값 "19:30" 유지/);
    const v = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: "[document.getElementById('size').value, document.getElementById('when').value]" });
    assert.match(v.text, /"l",\s*"19:30"/);

    const fileSnap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '첨부' })).text;
    const file = ref(fileSnap, /"첨부"[^\n]*\[(e\d+)\]/);
    // 파일 칸 클릭: OS 파일 창은 가로채고(사용자 화면에 안 뜸) 업로드로 이어감
    const f = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: file });
    assert.equal(f.isError, false, f.text);
    assert.match(f.text, /파일 선택 창이 열리려 해서/);
    const tmp = path.join(os.tmpdir(), `cdpm-up-${Date.now()}.txt`);
    fs.writeFileSync(tmp, '안녕');
    const up = await call(a, 'browser_upload', { slot: SLOT, agent: 'A', tab: 't1', files: [tmp] });
    assert.equal(up.isError, false, up.text);
    assert.match(up.text, /파일을 넣었어요 \(1개\)/);
    const got = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: "document.getElementById('file').files[0]?.name" });
    assert.match(got.text, /cdpm-up-/);
    // ref로 바로 넣기
    const up2 = await call(a, 'browser_upload', { slot: SLOT, agent: 'A', tab: 't1', ref: file, files: [tmp] });
    assert.match(up2.text, /파일을 넣었어요: \[e\d+\] 1개/);
    fs.rmSync(tmp, { force: true });
  });

  it('isolated world: 페이지 전역 변수는 browser_eval에서 보이지 않음', async () => {
    const r = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: 'typeof window.__pageVar' });
    assert.match(r.text, /"undefined"/);
  });

  it('네트워크 기록, 자세히, 요청 막기와 해제', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: 'API' })).text;
    const api = ref(snap, /button "API 부르기" \[(e\d+)\]/);
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: api });
    await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: 't1', text: 'API: {', timeout: 5 });
    const net = await call(a, 'browser_network', { slot: SLOT, agent: 'A', tab: 't1', filter: 'api/data' });
    const line = net.text.split('\n').find((l) => /api\/data/.test(l));
    assert.ok(line, net.text);
    assert.match(line!, /^n\d+ {2}GET {2}200 {2}Fetch/);
    const id = line!.split(' ')[0];
    const detail = await call(a, 'browser_network_detail', { slot: SLOT, agent: 'A', tab: 't1', id });
    assert.match(detail.text, /\[응답 본문\]\n\{"ok":true,"n":42\}/);

    const blocked = await call(a, 'browser_block', { slot: SLOT, agent: 'A', tab: 't1', add: ['api/data'] });
    assert.match(blocked.text, /\*api\/data\* \(A\)/);
    assert.match(blocked.text, /요청을 막는 중: \*api\/data\* \(A\)/);
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: api });
    await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: 't1', text: 'API 실패', timeout: 5 });
    const failed = await call(a, 'browser_network', { slot: SLOT, agent: 'A', tab: 't1', failed: true });
    assert.match(failed.text, /실패 .*\(막음: \*api\/data\*\)/);
    // 다른 세션(B)에게도 보임
    const seen = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.match(seen.text, /\[t1\]에서 요청을 막는 중/);
    const cleared = await call(a, 'browser_block', { slot: SLOT, agent: 'A', tab: 't1', clear: true });
    assert.match(cleared.text, /이 세션의 규칙: 없음/);
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: api });
    const ok = await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: 't1', text: 'API: {', timeout: 5 });
    assert.equal(ok.isError, false, ok.text);
  });

  it('페이지가 연 새 탭을 알려줌', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '새 창' })).text;
    const pop = ref(snap, /button "새 창 열기" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: pop });
    const m = r.text.match(/새 탭이 열렸어요: \d+번 \[(t\d+)\]/);
    assert.ok(m, r.text);
    assert.match(r.text, new RegExp(`\\[${m![1]}\\][^\\n]*연 사람: A \\(페이지가 염\\)`));
    await call(a, 'browser_tab_close', { slot: SLOT, agent: 'A', tab: m![1] });
  });

  it('긴 페이지: 위에서부터 쪽 나누기, ref 유지, 찾기, 본문 읽기, 스크롤 확인', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', tab: 't1', url: `${site.url}/long` });
    const p1 = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1' })).text;
    assert.match(p1, /— 1\/\d+쪽 \(전체 [\d,]+자\) · 다음: page=2/);
    assert.ok(p1.length < 16_000, `1쪽이 너무 김: ${p1.length}`);
    const lastRef1 = Math.max(...[...p1.matchAll(/\[e(\d+)\]/g)].map((x) => Number(x[1])));
    const p2 = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', page: 2 })).text;
    const firstRef2 = Math.min(...[...p2.matchAll(/\[e(\d+)\]/g)].map((x) => Number(x[1])));
    assert.equal(firstRef2, lastRef1 + 1, '2쪽 ref 번호는 1쪽에 이어져야 함');
    const found = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '맨 아래 버튼' })).text;
    const bottom = ref(found, /button "맨 아래 버튼" \[(e\d+)\]/);
    assert.match(found, /"맨 아래 버튼" 1곳/);
    const clicked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: bottom });
    assert.equal(clicked.isError, false, clicked.text);
    const text = (await call(a, 'browser_text', { slot: SLOT, agent: 'A', tab: 't1' })).text;
    assert.match(text, /문단 1 내용입니다/);
    assert.match(text, /— 1\/\d+쪽/);
    await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: 'scrollTo(0, 0)' });
    const sc = await call(a, 'browser_scroll', { slot: SLOT, agent: 'A', tab: 't1', dy: 800 });
    assert.match(sc.text, /아래로 800px 스크롤했어요 \(위치 0 → 800/);
  });

  it('뒤에 있는 탭도 앞 탭을 바꾸지 않고 캡처', async () => {
    // 새 탭은 뒤에서 열리므로, 테스트를 위해 t2를 앞으로 가져와 t1을 뒤로 보낸다
    await call(b, 'browser_tab_select', { slot: SLOT, agent: 'B', tab: 't2' });
    const before = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    const front = before.text.split('\n').find((l) => l.includes('·앞'));
    assert.ok(front && !front.includes('[t1]'), `t1이 뒤에 있어야 함:\n${before.text}`);
    const t0 = Date.now();
    const shot = await call(a, 'browser_screenshot', { slot: SLOT, agent: 'A', tab: 't1' });
    assert.equal(shot.images, 1, shot.text);
    assert.ok(Date.now() - t0 < 4000, '뒤 탭 캡처가 너무 느림');
    const after = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    const idOf = (line?: string) => line?.match(/\[(t\d+)\]/)?.[1];
    assert.equal(idOf(after.text.split('\n').find((l) => l.includes('·앞'))), idOf(front), '앞 탭이 바뀌면 안 됨');
  });

  it('번호 없이 켜면 비어 있는 가장 작은 슬롯 (1번이 떠 있으면 2번)', async () => {
    const r = await call(a, 'browser_launch', { agent: 'A', headless: false });
    assert.match(r.text, /2번 Chrome을 창 모드로 켰어요/);
    await call(a, 'browser_close', { slot: 2, agent: 'A' });
  });

  it('켜면서 시작 주소를 바로 엶 (slots + urls)', async () => {
    const r = await call(a, 'browser_launch', { agent: 'A', slots: [5, 6], headless: true, urls: [`${site.url}/page2`, `${site.url}/cards`] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /5번 Chrome을 헤드리스로 켰어요 .*page2 여는 중/);
    const t5 = await call(a, 'browser_text', { slot: 5, agent: 'A' });
    assert.match(t5.text, /여기는 두번째입니다/);
    const t6 = await call(a, 'browser_text', { slot: 6, agent: 'A6' });
    assert.match(t6.text, /카드 기사 제목/);
    await call(a, 'browser_close', { slot: 5, agent: 'A' });
    await call(a, 'browser_close', { slot: 6, agent: 'A' });
  });

  it('마우스 올리기·끌어 놓기·슬라이더·새로고침·앞으로·다운로드·PDF', async () => {
    const A = { slot: SLOT, agent: 'A' };
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/tools` });
    let snap = (await call(a, 'browser_snapshot', A)).text;
    const hov = await call(a, 'browser_hover', { ...A, ref: ref(snap, /button "상품 메뉴" \[(e\d+)\]/), read: 'changes' });
    assert.match(hov.text, /숨은 항목/);
    snap = (await call(a, 'browser_snapshot', A)).text;
    const dr = await call(a, 'browser_drag', { ...A, from: ref(snap, /draggable \[(e\d+)\]: "끌 상자"/), to_text: '놓을 곳', read: 'text' });
    assert.match(dr.text, /받음: 짐/);
    const sl = await call(a, 'browser_drag', { ...A, from: ref(snap, /slider "가격 범위" \[(e\d+)\]/), dx: 60, read: 'text' });
    assert.match(sl.text, /값 [1-9]\d*/);
    const rl = await call(a, 'browser_reload', A);
    assert.equal(rl.isError, false, rl.text);
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/page2` });
    await call(a, 'browser_back', A);
    assert.match((await call(a, 'browser_forward', A)).text, /앞으로 갔어요: .*page2/);
    await call(a, 'browser_back', A);
    snap = (await call(a, 'browser_snapshot', A)).text;
    const t0 = Date.now();
    await call(a, 'browser_click', { ...A, ref: ref(snap, /link "받기" \[(e\d+)\]/) });
    assert.ok(Date.now() - t0 < 5000, '다운로드 클릭은 바로 돌아와야 함');
    const w = await call(a, 'browser_download_wait', { ...A, timeout: 30 });
    const file = /다운로드가 끝났어요: (.+\.txt)/.exec(w.text)?.[1];
    assert.ok(file && fs.existsSync(file), w.text);
    fs.rmSync(file!, { force: true });
    const out = path.join(os.tmpdir(), `cdpm-${Date.now()}.pdf`);
    const pd = await call(a, 'browser_pdf', { ...A, path: out });
    assert.equal(pd.isError, false, pd.text);
    assert.ok(fs.statSync(out).size > 1000);
    fs.rmSync(out, { force: true });
  });

  it('여러 슬롯을 한 번에 작은 번호부터 켬 (count)', async () => {
    const asked = await call(a, 'browser_launch', { agent: 'A', count: 2 });
    assert.match(asked.text, /\[확인 필요\] 2, 3번/);
    const t0 = Date.now();
    const r = await call(a, 'browser_launch', { agent: 'A', count: 2, headless: true });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.indexOf('2번 Chrome을') < r.text.indexOf('3번 Chrome을'), r.text);
    assert.ok(Date.now() - t0 < 15_000, `${Date.now() - t0}ms`);
    await call(a, 'browser_close', { slot: 2, agent: 'A' });
    await call(a, 'browser_close', { slot: 3, agent: 'A' });
  });

  it('창(탭)을 사용자가 다 닫으면 슬롯을 끝냄 (Windows·Linux. macOS는 Cmd+Q로만 끝남)', { skip: process.platform === 'darwin' }, async () => {
    await call(a, 'browser_launch', { slot: 4, agent: 'A', headless: true });
    const port = Number(ENV.CDPM_TEST_PORT_BASE) + 4;
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; type: string }[];
    for (const p of pages.filter((p) => p.type === 'page')) await fetch(`http://127.0.0.1:${port}/json/close/${p.id}`);
    let open = true;
    for (let i = 0; i < 40 && open; i++) {
      await new Promise((r) => setTimeout(r, 500));
      open = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    }
    assert.equal(open, false, '20초 안에 포트가 닫혀야 함');
  });

  it('종료 뒤에는 다시 켜지지 않음', async () => {
    const r = await call(a, 'browser_close', { slot: SLOT, agent: 'A' });
    assert.match(r.text, /종료했어요/);
    const st = await call(a, 'browser_status', {});
    assert.match(st.text, /떠 있는 슬롯이 없어요/);
    const again = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
    assert.equal(again.isError, true);
    assert.match(again.text, /꺼져 있어요/);
    assert.equal(await portOpen(PORT), false);
  });
});
