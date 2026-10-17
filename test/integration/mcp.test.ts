// 진짜 Chrome + 진짜 MCP 서버(stdio)로 도구를 호출하는 통합 테스트.
// 사용자의 실제 1~30번(14050~)과 부딪히지 않도록 테스트 전용 포트(29222~)와 임시 저장소를 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hits, startSite } from '../fixtures/site.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-it-'));
const ENV = { ...process.env, CDPM_HOME: HOME, CDPM_TEST_PORT_BASE: '29221' } as Record<string, string>;
const SLOT = 1;
const PORT = 29222;

async function connect(name = 'cdpm-test'): Promise<Client> {
  const client = new Client({ name, version: '0' });
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
    assert.ok(names.includes('browser_dialog'), '알림창은 에이전트가 판단해서 browser_dialog로 처리');
  });

  it('범위 밖 슬롯은 거부', async () => {
    const r = await a.callTool({ name: 'browser_launch', arguments: { slot: 31 } });
    assert.ok(r.isError);
  });

  it('꺼진 슬롯은 다른 도구가 켜지 않음', async () => {
    const r = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Chrome on slot 1 is off/);
    assert.equal(await portOpen(PORT), false);
  });

  it('실행, 이동, 스냅샷', async () => {
    const asked = await call(a, 'browser_launch', { agent: 'A' });
    assert.match(asked.text, /\[Confirm\]/);
    const launched = await call(a, 'browser_launch', { agent: 'A', headless: false });
    assert.match(launched.text, /Started slot 1 Chrome windowed/);
    assert.match(launched.text, /picked the lowest free slot/);
    assert.match(launched.text, /opened by: A/);

    const nav = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url, summary: '테스트 메인 확인' });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /\[Slot 1\] 1 tab\(s\) · ran on tab 1 \[t1\]/);

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
    assert.match(listed.text, /last: A click/);
  });

  it('read: 이동하면서 본문, 클릭하면서 바뀐 부분만, 폼 채우기', async () => {
    const nav = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: `${site.url}/page2`, read: 'text' });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /\[page: text\][\s\S]*여기는 두번째입니다/);
    const back = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url, read: 'snapshot' });
    const box = ref(back.text, /textbox "검색어" \[(e\d+)\]/);
    const btn = ref(back.text, /button "검색" \[(e\d+)\]/);
    const filled = await call(a, 'browser_fill', { slot: SLOT, agent: 'A', fields: [{ ref: box, text: '가방' }], submit: btn, read: 'changes' });
    assert.equal(filled.isError, false, filled.text);
    assert.match(filled.text, /1\. Typed/);
    assert.match(filled.text, /\[page: changes\][\s\S]*\+ .*결과: 가방/);
    const same = await call(a, 'browser_scroll', { slot: SLOT, agent: 'A', dy: 0, read: 'changes' });
    assert.match(same.text, /\(no changes\)/);
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
    assert.match(waited.text, /URL changed/);
    assert.ok(Date.now() - t0 < 5000, '바뀌면 바로 돌아와야 함');
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
    // 글자가 사라질 때까지 (로그인 폼이 사라지는 것 감지): 화면은 건드리지 않고, 사라지면 바로 돌아옴
    const [gone] = await Promise.all([
      call(a, 'browser_wait', { slot: SLOT, agent: 'A', gone: '두번째로 가기', timeout: 20 }),
      (async () => { await new Promise((r) => setTimeout(r, 600)); await call(b, 'browser_navigate', { slot: SLOT, agent: 'B', tab: 1, url: `${site.url}/page2`, multiSlot: true }); })(),
    ]);
    assert.match(gone.text, /Text gone/);
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
  });

  it('가려진 요소는 클릭하지 않음', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text;
    const under = ref(snap, /button "가려진 버튼" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: under });
    assert.equal(r.isError, true);
    assert.match(r.text, /is covering/);
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
    assert.match(r.text, /\(navigated: (loaded|DOM loaded)/);
    assert.match((await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' })).text, /두번째 페이지/);
    const stale = await call(a, 'browser_click', { slot: SLOT, agent: 'A', ref: link });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Take a new browser_snapshot/);
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
    assert.match(opened.text, /Opened new tab: tab 2 \[t\d+\]/);
    assert.match(opened.text, /opened by: B/);
    // 아직 아무 탭도 안 쓴 에이전트는 탭을 지정해야 한다
    const noTab = await call(a, 'browser_click', { slot: SLOT, agent: 'C', ref: 'e1' });
    assert.equal(noTab.isError, true);
    assert.match(noTab.text, /There are 2 tabs and this agent has not used any yet/);
    // 쓴 적이 있는 에이전트는 자기 마지막 탭(t1)에서 실행된다
    const mine = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.match(mine.text, /ran on tab 1 \[t1\]/);
    const view = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A' });
    assert.equal(view.isError, false, view.text);
  });

  it('남의 탭 조작 시 경고만 (막지 않음)', async () => {
    const snap = (await call(b, 'browser_snapshot', { slot: SLOT, agent: 'B', tab: 1 })).text;
    const box = ref(snap, /textbox "검색어" \[(e\d+)\]/);
    const r = await call(b, 'browser_type', { slot: SLOT, agent: 'B', tab: 1, ref: box, text: 'x' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /\[warning\] Tab \[t1\] was used by A .*\(\w+\)/);
  });

  it('에이전트 간 메시지: 머리말 전달 + inbox 대기', async () => {
    const sent = await call(a, 'slot_send', { slot: SLOT, agent: 'A', text: '나 t1 쓸게', to: 'B' });
    assert.match(sent.text, /Message sent/);
    const r = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.match(r.text, /1 new message\(s\) \(marked read here[^)]*\)\n {2}A → B \(.*\): 나 t1 쓸게/);
    const again = await call(b, 'slot_inbox', { slot: SLOT, agent: 'B' });
    assert.match(again.text, /No new messages/);
    const waiting = call(b, 'slot_inbox', { slot: SLOT, agent: 'B', wait: 10 });
    await new Promise((res) => setTimeout(res, 500));
    await call(a, 'slot_send', { slot: SLOT, agent: 'A', text: '끝났어' });
    const got = await waiting;
    assert.match(got.text, /A \(.*\): 끝났어/);
  });

  it('상태 보기와 요약', async () => {
    const st = await call(a, 'browser_status', {});
    assert.match(st.text, /\[Slot 1\] port 29222 · 2 tab\(s\)/);
    assert.match(st.text, /summary: B — B 전용 탭/);
  });

  it('알림창: 저절로 처리하지 않고 알림 → browser_dialog로 확인·취소·입력 (다른 탭·다른 세션은 멈추지 않음)', async () => {
    // 전용 탭에서 띄우고 마지막에 탭을 닫는다.
    const opened = await call(a, 'browser_tab_new', { slot: SLOT, agent: 'A', url: site.url });
    const id = opened.text.match(/Opened new tab: tab \d+ \[(t\d+)\]/)![1];
    await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: id, text: '알림 띄우기', timeout: 5 });
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: id, find: '알림' })).text;
    const btn = ref(snap, /button "알림 띄우기" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: btn });
    assert.equal(r.isError, false, '클릭은 이루어졌으므로 오류가 아님');
    assert.match(r.text, /Action done\. Then: A alert dialog opened: "안녕하세요"/);
    const blocked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: btn });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /dialog is open on this tab/);
    assert.match(blocked.text, /browser_dialog/, '처리 방법을 알려 줌');
    // 저절로 처리하지 않았는지: 아직 떠 있어야 함
    const still = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    assert.match(still.text, new RegExp(`\\[warning\\] dialog open \\(alert\\) on tab \\d+ \\[${id}\\]`));
    // 다른 탭은 정상
    const other = await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1' });
    assert.equal(other.isError, false, other.text);
    // 다른 세션(B)이 이 슬롯을 봐도 오래 멈추지 않음 (알림창이 뜬 뒤 처음 붙는 연결)
    const t0 = Date.now();
    const seen = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.ok(Date.now() - t0 < 4000, `다른 세션이 ${Date.now() - t0}ms 멈춤`);
    assert.match(seen.text, new RegExp(`\\[${id}\\]`));
    // 에이전트가 판단해서 처리: alert 확인 → 탭이 다시 움직임
    const okd = await call(a, 'browser_dialog', { slot: SLOT, agent: 'A', tab: id, accept: true });
    assert.match(okd.text, /Accepted alert dialog: "안녕하세요"/, okd.text);
    const none = await call(a, 'browser_dialog', { slot: SLOT, agent: 'A', tab: id, accept: true });
    assert.match(none.text, /No dialog is open on this tab/);
    const snap2 = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: id, find: '띄우기' })).text;
    // confirm 취소 → 페이지가 취소 결과를 받음
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: ref(snap2, /button "확인창 띄우기" \[(e\d+)\]/) });
    const no = await call(a, 'browser_dialog', { slot: SLOT, agent: 'A', tab: id, accept: false, read: 'text' });
    assert.match(no.text, /Dismissed confirm dialog: "지울까요\?"/, no.text);
    assert.match(no.text, /취소 누름/, '페이지가 취소 결과를 받음');
    // prompt 입력 → 페이지가 입력값을 받음
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: ref(snap2, /button "입력창 띄우기" \[(e\d+)\]/) });
    const typed = await call(a, 'browser_dialog', { slot: SLOT, agent: 'A', tab: id, accept: true, text: '김철수', read: 'text' });
    assert.match(typed.text, /Accepted prompt dialog: "이름은\?" \(input: "김철수"\)/, typed.text);
    assert.match(typed.text, /입력: 김철수/, '페이지가 입력값을 받음');
    // 알림창이 떠 있는 탭도 닫을 수 있음
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: id, ref: ref(snap2, /button "알림 띄우기" \[(e\d+)\]/) });
    const closed = await call(a, 'browser_tab_close', { slot: SLOT, agent: 'A', tab: id });
    assert.match(closed.text, /Closed tab/);
  });

  it('드롭다운은 browser_select, 시간 입력칸은 형식대로, 파일 칸은 클릭 → 업로드', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', tab: 't1', url: site.url });
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '크기' })).text;
    const sel = ref(snap, /combobox "크기" \[(e\d+)\]/);
    const picked = await call(a, 'browser_select', { slot: SLOT, agent: 'A', tab: 't1', ref: sel, option: '크게' });
    assert.match(picked.text, /Selected \[e\d+\] "크게" \(value: l\)/);
    const wrong = await call(a, 'browser_select', { slot: SLOT, agent: 'A', tab: 't1', ref: sel, option: '없는항목' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /Available:[\s\S]*작게/);
    const clickSel = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: sel });
    assert.equal(clickSel.isError, true);
    assert.match(clickSel.text, /browser_select/);

    const full = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '배달' })).text;
    const time = ref(full, /배달 시간[\s\S]*?\[(e\d+)\]/);
    const typed = await call(a, 'browser_type', { slot: SLOT, agent: 'A', tab: 't1', ref: time, text: '19:30' });
    assert.equal(typed.isError, false, typed.text);
    assert.match(typed.text, /value set directly on time input/);
    const bad = await call(a, 'browser_type', { slot: SLOT, agent: 'A', tab: 't1', ref: time, text: '저녁' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /HH:MM/);
    assert.match(bad.text, /kept "19:30"/);
    const v = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: "[document.getElementById('size').value, document.getElementById('when').value]" });
    assert.match(v.text, /"l",\s*"19:30"/);

    const fileSnap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '첨부' })).text;
    const file = ref(fileSnap, /"첨부"[^\n]*\[(e\d+)\]/);
    // 파일 칸 클릭: OS 파일 창은 가로채고(사용자 화면에 안 뜸) 업로드로 이어감
    const f = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: file });
    assert.equal(f.isError, false, f.text);
    assert.match(f.text, /A file chooser tried to open/);
    const tmp = path.join(os.tmpdir(), `cdpm-up-${Date.now()}.txt`);
    fs.writeFileSync(tmp, '안녕');
    const up = await call(a, 'browser_upload', { slot: SLOT, agent: 'A', tab: 't1', files: [tmp] });
    assert.equal(up.isError, false, up.text);
    assert.match(up.text, /Uploaded 1 file\(s\)/);
    const got = await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: "document.getElementById('file').files[0]?.name" });
    assert.match(got.text, /cdpm-up-/);
    // ref로 바로 넣기
    const up2 = await call(a, 'browser_upload', { slot: SLOT, agent: 'A', tab: 't1', ref: file, files: [tmp] });
    assert.match(up2.text, /Uploaded to \[e\d+\]: 1 file\(s\)/);
    // 클릭이 아니라 키(파일 칸에서 Enter)로 열려도 OS 창 대신 가로챔
    await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: "document.getElementById('file').focus()" });
    const k = await call(a, 'browser_press_key', { slot: SLOT, agent: 'A', tab: 't1', key: 'Enter' });
    assert.match(k.text, /A file chooser tried to open; it was not shown to the user/, k.text);
    const up3 = await call(a, 'browser_upload', { slot: SLOT, agent: 'A', tab: 't1', files: [tmp] });
    assert.match(up3.text, /Uploaded 1 file\(s\)/, up3.text);
    fs.rmSync(tmp, { force: true });
  });

  it('에이전트 조작 중 인쇄 창은 막고 바로 이어감, 조작이 끝나면 원래대로 / 날짜·색 칸은 클릭 대신 값으로', async () => {
    const A = { slot: SLOT, agent: 'A', tab: 't1' };
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/printpage` });
    const snap = (await call(a, 'browser_snapshot', A)).text;
    const t0 = Date.now();
    const p = await call(a, 'browser_click', { ...A, ref: ref(snap, /button "인쇄하기" \[(e\d+)\]/), read: 'text' });
    assert.ok(Date.now() - t0 < 5000, `인쇄 버튼 클릭이 ${Date.now() - t0}ms 걸림 (탭이 멈춤)`);
    assert.match(p.text, /Blocked the page from opening a print dialog/, p.text);
    assert.match(p.text, /인쇄 뒤 이어짐/, '페이지가 멈추지 않고 이어서 실행됨');
    // 조작이 끝나면 페이지의 print는 원래대로 (사람이 누르는 인쇄는 평소처럼)
    const restored = await call(a, 'browser_eval', { ...A, expression: "'__cdpmPrintGuard' in window" });
    assert.match(restored.text, /false/);
    // 색 칸: 클릭은 거절, 값으로는 들어감 (대소문자 상관없이)
    const col = ref(snap, /"색"[^\n]*\[(e\d+)\]/);
    const c = await call(a, 'browser_click', { ...A, ref: col });
    assert.equal(c.isError, true);
    assert.match(c.text, /is a color input; clicking opens a picker on the user's screen/);
    const ct = await call(a, 'browser_type', { ...A, ref: col, text: '#FF0000' });
    assert.equal(ct.isError, false, ct.text);
    const cv = await call(a, 'browser_eval', { ...A, expression: "document.getElementById('col').value" });
    assert.match(cv.text, /#ff0000/);
    await call(a, 'browser_navigate', { ...A, url: site.url }); // 뒤 시험들이 쓰는 원래 페이지로
  });

  it('클라이언트에 맞는 안내: Claude Code만 서브에이전트 안내, 다른 클라이언트에는 Claude Code 전용 말이 없음', async () => {
    const generic = a.getInstructions() ?? '';
    assert.ok(generic.includes('browser_launch'), '공통 안내는 있음');
    for (const w of ['Agent 도구', 'cdpm-browser', 'run_in_background', 'subagent_type']) assert.ok(!generic.includes(w), `다른 클라이언트 안내에 "${w}"가 있음`);
    const cc = await connect('claude-code');
    try {
      const inst = cc.getInstructions() ?? '';
      assert.ok(inst.includes('cdpm-browser') && inst.includes('run_in_background'), 'Claude Code에는 서브에이전트 안내가 있음');
    } finally {
      await cc.close();
    }
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
    assert.match(detail.text, /\[Response body\]\n\{"ok":true,"n":42\}/);

    const blocked = await call(a, 'browser_block', { slot: SLOT, agent: 'A', tab: 't1', add: ['api/data'] });
    assert.match(blocked.text, /\*api\/data\* \(A\)/);
    assert.match(blocked.text, /blocking requests: \*api\/data\* \(A\)/);
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: api });
    await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: 't1', text: 'API 실패', timeout: 5 });
    const failed = await call(a, 'browser_network', { slot: SLOT, agent: 'A', tab: 't1', failed: true });
    assert.match(failed.text, /failed .*\(blocked: \*api\/data\*\)/);
    // 다른 세션(B)에게도 보임
    const seen = await call(b, 'browser_tabs', { slot: SLOT, agent: 'B' });
    assert.match(seen.text, /\[t1\] blocking requests/);
    const cleared = await call(a, 'browser_block', { slot: SLOT, agent: 'A', tab: 't1', clear: true });
    assert.match(cleared.text, /This session: none/);
    await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: api });
    const ok = await call(a, 'browser_wait', { slot: SLOT, agent: 'A', tab: 't1', text: 'API: {', timeout: 5 });
    assert.equal(ok.isError, false, ok.text);
  });

  it('페이지가 연 새 탭을 알려줌', async () => {
    const snap = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '새 창' })).text;
    const pop = ref(snap, /button "새 창 열기" \[(e\d+)\]/);
    const r = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: pop });
    const m = r.text.match(/New tab opened: tab \d+ \[(t\d+)\]/);
    assert.ok(m, r.text);
    assert.match(r.text, new RegExp(`\\[${m![1]}\\][^\\n]*opened by: A \\(via page\\)`));
    await call(a, 'browser_tab_close', { slot: SLOT, agent: 'A', tab: m![1] });
  });

  it('긴 페이지: 위에서부터 쪽 나누기, ref 유지, 찾기, 본문 읽기, 스크롤 확인', async () => {
    await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', tab: 't1', url: `${site.url}/long` });
    const p1 = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1' })).text;
    assert.match(p1, /— page 1\/\d+ \([\d,]+ chars total\) · next: page=2/);
    assert.ok(p1.length < 16_000, `1쪽이 너무 김: ${p1.length}`);
    const lastRef1 = Math.max(...[...p1.matchAll(/\[e(\d+)\]/g)].map((x) => Number(x[1])));
    const p2 = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', page: 2 })).text;
    const firstRef2 = Math.min(...[...p2.matchAll(/\[e(\d+)\]/g)].map((x) => Number(x[1])));
    assert.equal(firstRef2, lastRef1 + 1, '2쪽 ref 번호는 1쪽에 이어져야 함');
    const found = (await call(a, 'browser_snapshot', { slot: SLOT, agent: 'A', tab: 't1', find: '맨 아래 버튼' })).text;
    const bottom = ref(found, /button "맨 아래 버튼" \[(e\d+)\]/);
    assert.match(found, /"맨 아래 버튼": 1 match\(es\)/);
    const clicked = await call(a, 'browser_click', { slot: SLOT, agent: 'A', tab: 't1', ref: bottom });
    assert.equal(clicked.isError, false, clicked.text);
    const text = (await call(a, 'browser_text', { slot: SLOT, agent: 'A', tab: 't1' })).text;
    assert.match(text, /문단 1 내용입니다/);
    assert.match(text, /— page 1\/\d+/);
    await call(a, 'browser_eval', { slot: SLOT, agent: 'A', tab: 't1', expression: 'scrollTo(0, 0)' });
    const sc = await call(a, 'browser_scroll', { slot: SLOT, agent: 'A', tab: 't1', dy: 800 });
    assert.match(sc.text, /Scrolled down 800px \(pos 0 → 800/);
  });

  it('뒤에 있는 탭도 앞 탭을 바꾸지 않고 캡처', async () => {
    // 새 탭은 뒤에서 열리므로, 테스트를 위해 t2를 앞으로 가져와 t1을 뒤로 보낸다
    await call(b, 'browser_tab_select', { slot: SLOT, agent: 'B', tab: 't2' });
    const before = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    const front = before.text.split('\n').find((l) => l.includes('·front'));
    assert.ok(front && !front.includes('[t1]'), `t1이 뒤에 있어야 함:\n${before.text}`);
    const t0 = Date.now();
    const shot = await call(a, 'browser_screenshot', { slot: SLOT, agent: 'A', tab: 't1' });
    assert.equal(shot.images, 1, shot.text);
    assert.ok(Date.now() - t0 < 4000, '뒤 탭 캡처가 너무 느림');
    const after = await call(a, 'browser_tabs', { slot: SLOT, agent: 'A' });
    const idOf = (line?: string) => line?.match(/\[(t\d+)\]/)?.[1];
    assert.equal(idOf(after.text.split('\n').find((l) => l.includes('·front'))), idOf(front), '앞 탭이 바뀌면 안 됨');
  });

  it('번호 없이 켜면 비어 있는 가장 작은 슬롯 (1번이 떠 있으면 2번)', async () => {
    const r = await call(a, 'browser_launch', { agent: 'A', headless: false });
    assert.match(r.text, /Started slot 2 Chrome windowed/);
    await call(a, 'browser_close', { slot: 2, agent: 'A' });
  });

  it('켜면서 시작 주소를 바로 엶 (slots + urls)', async () => {
    const r = await call(a, 'browser_launch', { agent: 'A', slots: [5, 6], headless: true, urls: [`${site.url}/page2`, `${site.url}/cards`] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Started slot 5 Chrome headless .*opening .*page2/);
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
    assert.match((await call(a, 'browser_forward', A)).text, /Went forward: .*page2/);
    await call(a, 'browser_back', A);
    snap = (await call(a, 'browser_snapshot', A)).text;
    const t0 = Date.now();
    await call(a, 'browser_click', { ...A, ref: ref(snap, /link "받기" \[(e\d+)\]/) });
    assert.ok(Date.now() - t0 < 5000, '다운로드 클릭은 바로 돌아와야 함');
    const w = await call(a, 'browser_download_wait', { ...A, timeout: 30 });
    const file = /Download finished: (.+\.txt)/.exec(w.text)?.[1];
    assert.ok(file && fs.existsSync(file), w.text);
    fs.rmSync(file!, { force: true });
    const out = path.join(os.tmpdir(), `cdpm-${Date.now()}.pdf`);
    const pd = await call(a, 'browser_pdf', { ...A, path: out });
    assert.equal(pd.isError, false, pd.text);
    assert.ok(fs.statSync(out).size > 1000);
    fs.rmSync(out, { force: true });
  });

  it('기다리기: 버튼이 눌릴 수 있게 될 때까지 / 데이터 응답이 올 때까지 (본문까지)', async () => {
    const A = { slot: SLOT, agent: 'A' };
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/spa` });
    const snap = (await call(a, 'browser_snapshot', A)).text;
    const next = ref(snap, /button "다음"[^[]*\[(e\d+)\]/);
    const t0 = Date.now();
    const en = await call(a, 'browser_wait', { ...A, enabled: next, timeout: 10 });
    assert.match(en.text, /Now enabled/, en.text);
    assert.ok(Date.now() - t0 < 5000);
    // 클릭하는 동안 이미 온 응답도 잡아야 함 (서버는 0.3초 뒤 응답)
    await call(a, 'browser_click', { ...A, ref: ref(snap, /button "검색" \[(e\d+)\]/) });
    const r = await call(a, 'browser_wait', { ...A, response: '/api/search', timeout: 10 });
    assert.match(r.text, /Response received: .*200/, r.text);
    assert.match(r.text, /"name":"풋사과"/, '응답 본문(JSON)이 함께 옴');
    // 와일드카드 + 주소의 한글(인코딩된 q=사과)도 맞음
    await call(a, 'browser_click', { ...A, ref: ref(snap, /button "검색" \[(e\d+)\]/) });
    const w = await call(a, 'browser_wait', { ...A, response: '*search?q=사과*', timeout: 10 });
    assert.match(w.text, /"q":"사과"/, w.text);
    // 오지 않는 응답은 시간 초과
    const none = await call(a, 'browser_wait', { ...A, response: '/api/never', timeout: 1 });
    assert.equal(none.isError, true);
    assert.match(none.text, /No response with URL containing/);
  });

  it('멈추기: 기다리던 에이전트가 바로 멈추고 조작은 거절, 다시 시작하면 바로 깨어남 (다른 세션·터미널)', async () => {
    const A = { slot: SLOT, agent: 'A' };
    await call(a, 'browser_navigate', { ...A, url: site.url });
    // A는 오지 않을 글자를 기다리는 중 → B(다른 세션)가 멈춤
    const t0 = Date.now();
    const waiting = call(a, 'browser_wait', { ...A, text: '절대 안 나오는 글자', timeout: 30 });
    await new Promise((r) => setTimeout(r, 500));
    const p = await call(b, 'slot_pause', { slot: SLOT, agent: 'B' });
    assert.match(p.text, new RegExp(`Paused slot ${SLOT}`), p.text);
    const w = await waiting;
    assert.ok(Date.now() - t0 < 3000, `기다리기가 ${Date.now() - t0}ms 뒤에야 멈춤`);
    assert.match(w.text, /\[paused\]/, w.text);
    // 조작은 거절, 화면 읽기는 됨
    const clk = await call(a, 'browser_navigate', { ...A, url: `${site.url}/page2` });
    assert.equal(clk.isError, true);
    assert.match(clk.text, /\[paused\].*slot_inbox/s);
    assert.equal((await call(a, 'browser_tab_new', A)).isError, true, '새 탭도 거절');
    assert.equal((await call(a, 'browser_snapshot', A)).isError, false, '화면 읽기는 됨');
    // A가 inbox로 기다리는 동안 터미널에서 다시 시작 → 바로 깨어남
    const inbox = call(a, 'slot_inbox', { ...A, wait: 30 });
    await new Promise((r) => setTimeout(r, 300));
    const t1 = Date.now();
    const out = execFileSync(process.execPath, [CLI, 'resume', String(SLOT)], { env: ENV, encoding: 'utf8' });
    assert.match(out, /Resumed slot/);
    const got = await inbox;
    assert.ok(Date.now() - t1 < 3000, `깨어나는 데 ${Date.now() - t1}ms`);
    assert.match(got.text, /\[resumed\]/, got.text);
    const again = await call(a, 'browser_navigate', { ...A, url: `${site.url}/page2` });
    assert.equal(again.isError, false, again.text);
    // 터미널 멈춤도 같은 기록을 씀
    execFileSync(process.execPath, [CLI, 'pause', String(SLOT)], { env: ENV, encoding: 'utf8' });
    assert.equal((await call(a, 'browser_back', A)).isError, true);
    const r = await call(b, 'slot_resume', { slot: SLOT, agent: 'B' });
    assert.match(r.text, /Resumed slot/);
    assert.equal((await call(a, 'browser_back', A)).isError, false);

    // 하던 조작도 그 자리에서 멈춤: 긴 글을 한 글자씩 치는 도중에 멈추면 거기서 끝남
    await call(a, 'browser_navigate', { ...A, url: site.url });
    const snap = (await call(a, 'browser_snapshot', { ...A, find: '검색어' })).text;
    const box = ref(snap, /textbox "검색어" \[(e\d+)\]/);
    const long = '가나다라마바사아자차카타파하'.repeat(200);
    const typing = call(a, 'browser_type', { ...A, ref: box, text: long, clear: true });
    await new Promise((r) => setTimeout(r, 300));
    const t2 = Date.now();
    await call(b, 'slot_pause', { slot: SLOT, agent: 'B' });
    const typed = await typing;
    assert.ok(Date.now() - t2 < 1500, `입력이 ${Date.now() - t2}ms 뒤에야 멈춤`);
    assert.equal(typed.isError, true);
    assert.match(typed.text, /the action stopped midway/, typed.text);
    const len = Number((await call(a, 'browser_eval', { ...A, expression: 'document.getElementById("q").value.length' })).text.match(/(\d+)\s*$/)?.[1] ?? -1);
    await call(b, 'slot_resume', { slot: SLOT, agent: 'B' });
    const len2 = Number((await call(a, 'browser_eval', { ...A, expression: 'document.getElementById("q").value.length' })).text.match(/(\d+)\s*$/)?.[1] ?? -1);
    assert.ok(len2 > 0 && len2 < long.length, `멈춘 자리까지만 입력돼야 함 (${len2}/${long.length})`);
    void len;
  });

  it('서로 다른 세션이 같은 탭에 동시에 입력해도 섞이지 않음 (탭 잠금)', async () => {
    const A = { slot: SLOT, agent: 'A' };
    const B = { slot: SLOT, agent: 'B' };
    await call(a, 'browser_navigate', { ...A, tab: 't1', url: site.url });
    const sa = (await call(a, 'browser_snapshot', { ...A, tab: 't1', find: '검색어' })).text;
    const sb = (await call(b, 'browser_snapshot', { ...B, tab: 't1', find: '메모' })).text;
    const qa = ref(sa, /textbox "검색어" \[(e\d+)\]/);
    const ib = ref(sb, /textbox "메모" \[(e\d+)\]/);
    const ta = 'A'.repeat(400);
    const tb = 'B'.repeat(400);
    // 두 세션(두 프로세스)이 같은 탭의 다른 칸에 동시에 한 글자씩 친다 → 잠금이 없으면 포커스가 오가며 글자가 섞임
    const [ra, rb] = await Promise.all([
      call(a, 'browser_type', { ...A, tab: 't1', ref: qa, text: ta, clear: true }),
      call(b, 'browser_type', { ...B, tab: 't1', ref: ib, text: tb, clear: true }),
    ]);
    assert.equal(ra.isError, false, ra.text);
    assert.equal(rb.isError, false, rb.text);
    const v = (await call(a, 'browser_eval', { ...A, tab: 't1', expression: 'document.getElementById("q").value + "|" + document.getElementById("memo").value' })).text;
    assert.ok(v.includes(`${ta}|${tb}`), `섞임: ${v.slice(-120)}`);
  });

  it('입력한 값이 다르면 제출하지 않음 (browser_type submit, browser_fill)', async () => {
    const A = { slot: SLOT, agent: 'A' };
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/numform` });
    const snap = (await call(a, 'browser_snapshot', A)).text;
    const num = ref(snap, /textbox "숫자만" \[(e\d+)\]/);
    const nm = ref(snap, /textbox "이름" \[(e\d+)\]/);
    // 숫자만 받는 칸에 글자를 섞어 넣고 Enter → 값이 달라서 제출하지 않아야 함
    const t = await call(a, 'browser_type', { ...A, ref: num, text: 'ab12', submit: true, read: 'text' });
    assert.match(t.text, /Value differs from what was typed/);
    assert.match(t.text, /Not submitted \(Enter\)/);
    assert.match(t.text, /미제출/, '페이지가 제출되지 않음');
    const f = await call(a, 'browser_fill', { ...A, fields: [{ ref: nm, text: '홍길동' }, { ref: num, text: 'x9' }], submit: 'Enter', read: 'text' });
    assert.match(f.text, /value differs from the intended text \(not submitted\)/, f.text);
    assert.match(f.text, /미제출/);
    // 값이 맞으면 제출됨
    const ok = await call(a, 'browser_type', { ...A, ref: num, text: '42', clear: true, submit: true, read: 'text' });
    assert.match(ok.text, /제출됨/, ok.text);
  });

  it('응답 기다리기: 앞의 끝나지 않은 같은 주소 요청이 뒤에 끝난 응답을 가리지 않음', async () => {
    const A = { slot: SLOT, agent: 'A' };
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/twice` });
    const snap = (await call(a, 'browser_snapshot', A)).text;
    const t0 = Date.now();
    await call(a, 'browser_click', { ...A, ref: ref(snap, /button "두 번 요청" \[(e\d+)\]/) });
    const r = await call(a, 'browser_wait', { ...A, response: '/api/hang', timeout: 10 });
    assert.match(r.text, /"n":"fast"/, r.text);
    assert.ok(Date.now() - t0 < 8000, '15초짜리 요청을 기다리면 안 됨');
  });

  it('새 탭도 외부 프로그램 주소(mailto 등)는 거절', async () => {
    const r = await call(a, 'browser_tab_new', { slot: SLOT, agent: 'A', url: 'mailto:someone@example.com' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Can't open a mailto: URL/);
  });

  it('요청 막기 규칙이 그 탭의 다른 사이트 iframe에도 걸림 (이미 떠 있는 것, 새로 생긴 것)', async () => {
    const A = { slot: SLOT, agent: 'A' };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await call(a, 'browser_navigate', { ...A, url: `${site.url}/xblock` });
    await wait(1200);
    const before = hits.tracker ?? 0;
    assert.ok(before > 0, 'iframe이 요청을 보내고 있어야 함');
    // 이미 떠 있는 iframe에도 걸려야 함
    await call(a, 'browser_block', { ...A, add: ['*tracker.png*'] });
    await wait(400);
    const c1 = hits.tracker ?? 0;
    await wait(1500);
    assert.ok((hits.tracker ?? 0) - c1 <= 1, `이미 떠 있는 iframe의 요청이 막히지 않음 (${(hits.tracker ?? 0) - c1}개 더 들어옴)`);
    // 새로 생긴 iframe(새로고침)도 처음부터 막혀야 함
    await call(a, 'browser_reload', A);
    const c2 = hits.tracker ?? 0;
    await wait(1500);
    assert.ok((hits.tracker ?? 0) - c2 <= 1, '새로 생긴 iframe의 요청이 막히지 않음');
    // 규칙을 풀면 다시 들어옴
    await call(a, 'browser_block', { ...A, clear: true });
    const c3 = hits.tracker ?? 0;
    // 뒤 탭은 Chrome이 타이머를 1초에 한 번으로 늦추므로 넉넉히 기다린다
    await wait(3000);
    assert.ok((hits.tracker ?? 0) - c3 >= 2, '규칙을 풀었는데 요청이 다시 들어오지 않음');
  });

  it('두 세션이 같은 슬롯을 동시에 켜도 한 번만 뜨고 둘 다 성공 (슬롯 잠금)', async () => {
    const slot = SLOT + 7;
    const [ra, rb] = await Promise.all([
      call(a, 'browser_launch', { slot, agent: 'A', headless: true }),
      call(b, 'browser_launch', { slot, agent: 'B', headless: true }),
    ]);
    assert.equal(ra.isError, false, ra.text);
    assert.equal(rb.isError, false, rb.text);
    const launched = [ra.text, rb.text].filter((t) => /Started slot/.test(t)).length;
    const attached = [ra.text, rb.text].filter((t) => /already running; attached/.test(t)).length;
    assert.equal(launched, 1, `한 번만 켜야 함: ${ra.text.slice(-80)} | ${rb.text.slice(-80)}`);
    assert.equal(attached, 1);
    const [ca, cb] = await Promise.all([
      call(a, 'browser_close', { slot, agent: 'A' }),
      call(b, 'browser_close', { slot, agent: 'B' }),
    ]);
    assert.equal(ca.isError || cb.isError, false, ca.text + cb.text);
  });

  it('여러 슬롯을 한 번에 작은 번호부터 켬 (count)', async () => {
    const asked = await call(a, 'browser_launch', { agent: 'A', count: 2 });
    assert.match(asked.text, /\[Confirm\] Slot 2, 3 /);
    const t0 = Date.now();
    const r = await call(a, 'browser_launch', { agent: 'A', count: 2, headless: true });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.indexOf('Started slot 2 ') < r.text.indexOf('Started slot 3 '), r.text);
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

  it('기록부의 Chrome 번호가 틀려도(재부팅 뒤 옛 번호·다른 프로그램이 받은 번호) 저절로 고침', async () => {
    const regFile = path.join(HOME, 'registry.json');
    const ws = new WebSocket(((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const info = await new Promise<{ processInfo: { type: string; id: number }[] }>((r) => {
      ws.addEventListener('message', (m) => r(JSON.parse(String(m.data)).result), { once: true });
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo', params: {} }));
    });
    ws.close();
    const actual = info.processInfo.find((x) => x.type === 'browser')!.id;
    const pidOf = () => JSON.parse(fs.readFileSync(regFile, 'utf8')).slots[String(SLOT)].pid as number;
    const corrupt = () => {
      const r = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      r.slots[String(SLOT)].pid = process.pid; // 살아 있지만 Chrome이 아닌 프로세스
      fs.writeFileSync(regFile, JSON.stringify(r, null, 2));
    };
    assert.equal(pidOf(), actual);
    const c = await connect();
    try {
      if (process.platform === 'win32') {
        // 새로 켜진 CDPM(도구 호출 없음)의 아이콘 감시가 몇 초 안에 고친다
        corrupt();
        for (let i = 0; i < 40 && pidOf() !== actual; i++) await new Promise((r) => setTimeout(r, 250));
        assert.equal(pidOf(), actual, '아이콘 감시가 고쳐야 함');
      }
      // 이미 연결해 둔 프로세스라도, 확인한 번호와 다르면 슬롯에 붙을 때 다시 확인해 고친다
      corrupt();
      const snap = await call(c, 'browser_snapshot', { slot: SLOT, agent: 'C' });
      assert.equal(snap.isError, false, snap.text);
      assert.equal(pidOf(), actual, '슬롯에 붙을 때 고쳐야 함');
    } finally {
      await c.close();
    }
  });

  it('실행 중에 Chrome이 업데이트됐으면(설치 버전과 다름) 새 버전으로 다시 켜고 탭을 다시 엶, 같은 상황에서 반복하지 않음', async () => {
    const slot = 9;
    const port = Number(ENV.CDPM_TEST_PORT_BASE) + slot;
    await call(a, 'browser_launch', { slot, agent: 'A', headless: true, url: site.url });
    await call(a, 'browser_tab_new', { slot, agent: 'A', url: `${site.url}/page2` });
    const pidOf = () => JSON.parse(fs.readFileSync(path.join(HOME, 'registry.json'), 'utf8')).slots[String(slot)]?.pid as number | undefined;
    const before = pidOf();
    const urls = async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string }[])
      .filter((t) => t.type === 'page').map((t) => t.url).sort();
    const beforeUrls = await urls();
    // 디스크의 Chrome이 다른 버전으로 바뀐 것처럼 꾸민 CDPM
    const updated = new Client({ name: 'cdpm-test', version: '0' });
    await updated.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...ENV, CDPM_TEST_INSTALLED_VERSION: '1.0.0.1' } }));
    try {
      const snap = await call(updated, 'browser_snapshot', { slot, agent: 'U' });
      assert.equal(snap.isError, false, snap.text);
      assert.match(snap.text, /updated while running \([\d.]+ → 1\.0\.0\.1\).*reopened 2 tab\(s\)/);
      const after = pidOf();
      assert.ok(after && after !== before, `다시 켜져야 함 (${before} → ${after})`);
      assert.deepEqual(await urls(), beforeUrls, '열려 있던 탭 주소가 그대로 다시 열려야 함');
      // 알림은 에이전트마다 한 번, 같은 버전 쌍으로는 다시 켜지 않음 (감시 주기 지나도)
      await new Promise((r) => setTimeout(r, 12_000));
      const again = await call(updated, 'browser_snapshot', { slot, agent: 'U' });
      assert.doesNotMatch(again.text, /updated while running/);
      assert.equal(pidOf(), after, '같은 상황에서 반복해서 다시 켜면 안 됨');
      const other = await call(a, 'browser_snapshot', { slot, agent: 'A' });
      assert.match(other.text, /updated while running/, '다른 세션의 에이전트에게도 한 번 알림');
    } finally {
      await updated.close();
      await call(a, 'browser_close', { slot, agent: 'A' });
    }
  });

  it('종료 뒤에는 다시 켜지지 않음', async () => {
    const r = await call(a, 'browser_close', { slot: SLOT, agent: 'A' });
    assert.match(r.text, /Closed slot \d+ Chrome/);
    const st = await call(a, 'browser_status', {});
    assert.match(st.text, /No slots running/);
    const again = await call(a, 'browser_navigate', { slot: SLOT, agent: 'A', url: site.url });
    assert.equal(again.isError, true);
    assert.match(again.text, /is off/);
    assert.equal(await portOpen(PORT), false);
  });
});
