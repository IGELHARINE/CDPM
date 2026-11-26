// 관제 화면 서버 (`cdpm watch`). MCP 서버와 따로 도는 작은 웹 서버다.
//  - 슬롯 Chrome의 디버깅 포트에 직접 붙어 탭 화면을 받아, 보는 페이지에 한 줄 연결(SSE)로 흘려보낸다.
//  - 관제 화면에서 누른 것(탭 닫기·넘기기·슬롯 멈추기 등)은 AI를 거치지 않고 여기서 Chrome에 바로 시킨다.
//    에이전트에게는 슬롯 메시지로 "사용자가 이렇게 했다"고만 알린다.
//  - 이 PC 안에서만 열리고(127.0.0.1), 요청마다 이 서버가 만든 표(token)를 확인한다:
//    화면에 로그인된 내용이 그대로 나오고 탭을 닫을 수도 있으므로, 다른 웹 페이지가 이 주소를 부르지 못하게 한다.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CdpConnection } from '../cdp/client.js';
import { listPages, probe, type PageTarget } from '../cdp/targets.js';
import { cdpmHome, paths } from '../paths.js';
import { pauseSlots, resumeSlots } from '../pause.js';
import { sendMessage, type Message } from '../registry/messages.js';
import { withSlotLock } from '../registry/lock.js';
import { readRegistry } from '../registry/store.js';
import { forgetSlot } from '../service.js';
import { pidAlive, sleep } from '../util.js';
import { colorOf, isValidSlot, portOf } from '../slots.js';
import { VERSION } from '../version.js';
import { moveTab, WATCH_AGENT, type MoveRequest } from './move.js';
import { watchPage } from './page.js';

export const WATCH_PORT = 14900;
const SCAN_MS = 1000;       // 탭 목록·기록부를 다시 보는 간격
const FAST_MS = 1000;       // 화면이 바뀌고 있는 탭을 찍는 간격
const SLOW_MS = 3000;       // 가만히 있는 탭
const FOCUS_MS = 250;       // 크게 보고 있는 탭
const SMALL_W = 640, BIG_W = 1600;
// 녹화 스트림의 폭은 관제 화면에서 칸이 실제로 그려지는 크기에 맞춘다 (작게 받아 크게 늘리면 글자가 뭉개진다).
// 자주 다시 시작하지 않게 몇 단계로만 나눈다.
const WIDTHS = [640, 960, 1280, 1600, 2000, 2560];
const fitWidth = (px: number) => WIDTHS.find((w) => w >= px) ?? WIDTHS[WIDTHS.length - 1];
const IDLE_EXIT_MS = 10 * 60_000;

export const watchInfoFile = () => path.join(cdpmHome(), 'watch.json');

interface TabState {
  targetId: string;
  conn?: CdpConnection;
  watching: boolean;
  hidden?: boolean;
  casting?: number;       // 지금 받고 있는 녹화 스트림의 폭
  last?: string;
  lastHash: string;
  same: number;
  /** 녹화 스트림에서 마지막으로 그림이 온 때, 직접 한 장 찍은 때 */
  castAt?: number;
  shotAt?: number;
  /** 탭 목록에서 본 주소·제목 (페이지를 건드리지 않고 바뀐 것을 안다) */
  seenUrl?: string;
  seenTitle?: string;
  /** 뒤에 숨은 탭: 주소·제목이 바뀌어 한 장 찍어야 함 / 자리 잡힌 뒤 한 번 더 찍을 시각 */
  dirty?: boolean;
  /** 바뀐 뒤 다시 찍을 때들 (뒤에 숨은 탭은 늦게 다 그려지므로 몇 번 나눠 찍는다) */
  settleAt?: number[];
  /** 기다리는 중인 이 탭의 확인 루프를 바로 깨운다 */
  wake?: () => void;
}

interface TabInfo {
  targetId: string;
  id: string;
  /** CDPM이 이 탭을 처음 본 순서 (탭 번호 t1, t2 …의 순서) */
  seq: number;
  title: string;
  url: string;
  hidden?: boolean;
  /** 그 슬롯 창에서 앞에 있는 탭 (보이는 탭. 창이 최소화·가려져 보이는 탭이 없으면 마지막으로 앞에 있던 탭) */
  front?: boolean;
  openedBy?: string;
  last?: { agent: string; action: string; at: string };
  summary?: string;
}

interface SlotInfo {
  no: number;
  color: string;
  running: boolean;
  headless?: boolean;
  paused?: { agent: string; at: string };
  proxy?: boolean;
  /** Chrome이 아닌 브라우저로 켠 슬롯이면 그 이름 (brave 등) */
  browser?: string;
  tabs: TabInfo[];
}

interface Activity { at: string; slot: number; tab?: string; who: string; what: string; title?: string }

interface Client { res: http.ServerResponse; slots: Set<number> | 'all'; focus?: string; /** 관제 화면이 다른 탭 뒤에 가려져 안 보이는 중 (그동안은 화면을 받지 않는다) */ idle?: boolean; /** 관제 화면에서 접어 둔 슬롯 (탭 목록은 주고 화면은 받지 않는다) */ skip?: Set<number>; /** 칸 하나, 크게 본 칸이 화면에서 차지하는 폭 (실제 픽셀) */ w?: number; bw?: number }

export async function startWatchServer(wantPort = WATCH_PORT): Promise<{ port: number; token: string; close: (exit?: boolean) => void }> {
  /** 실제로 열린 포트 (0을 주면 빈 포트를 골라 준다: 시험용) */
  let port = wantPort;
  const token = randomBytes(18).toString('hex');
  const clients = new Set<Client>();
  const tabs = new Map<string, TabState>();          // key: `${slot}:${targetId}`
  let slots: SlotInfo[] = [];
  let lastState = '';
  const activity: Activity[] = [];
  const messages = new Map<number, { mtime: number; items: Message[] }>();
  const seenAction = new Map<string, string>();      // 탭 → 마지막으로 본 조작 시각
  let known = new Set<string>();
  let idleSince = Date.now();

  const push = (event: string, data: unknown, only?: (c: Client) => boolean) => {
    const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) if (!only || only(c)) c.res.write(s);
  };
  const wants = (c: Client, slot: number) => c.slots === 'all' || c.slots.has(slot);
  // 보고 있는 사람이 있는 슬롯만 화면을 받는다 (관제 화면이 가려져 있으면 그 사람은 안 보는 것으로 친다)
  const anyWants = (slot: number) => [...clients].some((c) => !c.idle && wants(c, slot) && !c.skip?.has(slot));
  // 활동 기록은 관제 화면에서 더 보여 주지 않는다 → 보내지 않고 최근 것만 조금 남긴다 (나중에 쓸 때를 위해)
  const note = (a: Activity) => { activity.push(a); if (activity.length > 200) activity.shift(); };

  // ── 화면 받기 ──
  // 앞에 보이는 탭: 녹화 스트림 (Chrome이 이미 그리고 있는 화면을 줄여 보내 줄 뿐이라 창에 변화가 없다).
  // 뒤에 숨은 탭: 그 순간의 화면을 한 장 찍는다. 숨은 탭도 최신 화면이 찍히고, 페이지는 계속 숨은 상태로 남는다.
  //   (숨은 탭을 계속 그리게 하는 포커스 에뮬레이션은 쓰지 않는다: Chrome이 수십 %씩 바빠지고 페이지가 "보이는 중"으로 안다.
  //    크기를 줄여 찍는 옵션(clip·scale)도 쓰지 않는다: 찍는 순간 실제 창이 검게 깜빡인다.)
  const deliver = (slot: number, t: TabState, data: string) => {
    const hash = createHash('md5').update(data).digest('hex');
    if (hash === t.lastHash) { t.same++; return; }
    t.lastHash = hash; t.same = 0; t.last = data;
    push('frame', { slot, id: t.targetId, data }, (c) => wants(c, slot));
  };
  /** 슬롯 안에서 앞 탭이 바뀐 것 같을 때: 그 슬롯 탭들의 보임 상태를 바로 다시 보고, 상태를 곧 보낸다 */
  const wakeSlot = (slot: number) => {
    for (const [key, x] of tabs) if (key.startsWith(`${slot}:`)) x.wake?.();
    soonScan();
  };
  let soonTimer: NodeJS.Timeout | undefined;
  const soonScan = () => { if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = undefined; void scan(); }, 120); };
  /** 슬롯마다 마지막으로 앞에 있던 탭 (창이 최소화·가려지면 이 탭에 별표를 둔다) */
  const lastFront = new Map<number, string>();
  const focused = (slot: number, t: TabState) => [...clients].some((c) => c.focus === `${slot}:${t.targetId}`);

  async function watchTab(slot: number, t: TabState, wsUrl: string) {
    try {
      t.conn = await CdpConnection.connect(wsUrl, 5000);
    } catch {
      t.watching = false;
      return;
    }
    const conn = t.conn;
    conn.on('Page.screencastFrame', (p: { data: string; sessionId: number }) => {
      // 받았다는 답을 늦추면 Chrome이 그만큼 다음 그림을 늦게 만든다
      setTimeout(() => void conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }, 3000).catch(() => undefined), focused(slot, t) ? FOCUS_MS : FAST_MS);
      t.castAt = Date.now();
      if (t.watching) deliver(slot, t, p.data);
    });
    // 녹화 중인(앞에 있던) 탭이 가려지거나 다시 보이면 Chrome이 바로 알려 준다 → 같은 슬롯의 다른 탭들도 곧바로 다시 본다
    conn.on('Page.screencastVisibilityChanged', () => wakeSlot(slot));
    const castOff = async () => { if (t.casting) { t.casting = undefined; await conn.send('Page.stopScreencast', {}, 3000).catch(() => undefined); } };
    // 탭이 보이는지는 격리된 세계에서 읽는다. 페이지 본래 세계에서 읽으면 사이트가 그 속성에 걸어 둔 함정(getter)에
    // 바깥에서 읽은 흔적이 남는다 (실측). 격리된 세계는 이동하면 없어지므로 못 읽으면 다시 만든다.
    let iso: number | undefined;
    const visibility = async (): Promise<string | undefined> => {
      for (let i = 0; i < 2; i++) {
        if (!iso) {
          const tree = await conn.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, 3000).catch(() => undefined);
          if (!tree) return undefined;
          iso = (await conn.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'cdpm-watch' }, 3000).catch(() => undefined))?.executionContextId;
          if (!iso) return undefined;
        }
        const r = await conn.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'document.visibilityState', contextId: iso, returnByValue: true }, 3000).catch(() => undefined);
        if (typeof r?.result?.value === 'string') return r.result.value;
        iso = undefined;
      }
      return undefined;
    };
    const shoot = async (big: boolean) => {
      t.shotAt = Date.now();
      const shot = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: big ? 60 : 40 }, 5000).catch(() => undefined);
      if (shot?.data) deliver(slot, t, shot.data);
    };
    while (t.watching && !conn.closed) {
      const began = Date.now();
      const big = focused(slot, t);
      const hidden = (await visibility()) === 'hidden';
      if (hidden !== t.hidden) { const was = t.hidden; t.hidden = hidden; lastState = ''; if (was !== undefined) wakeSlot(slot); }
      if (hidden) {
        await castOff();
        // 뒤에 숨은 탭을 찍으면 그때마다 화면을 새로 그려서, 원래 멈춰 있어야 할 requestAnimationFrame이 돈다 (사이트가 셀 수 있다, 실측).
        // 그래서 계속 찍지 않고, 처음 볼 때·주소나 제목이 바뀌었을 때·에이전트가 조작했을 때(그리고 그 뒤 몇 번 더)만 찍는다.
        // 사용자가 크게 보고 있는 탭만 계속 찍는다 (그 탭은 사람이 직접 지켜보겠다고 고른 것).
        // 뒤에서 연 탭은 Chrome이 늦게 그리므로(다른 슬롯에서 옮겨 온 탭, 에이전트가 뒤에서 연 탭) 바뀐 뒤 3초·10초·30초에 한 장씩 더 찍는다.
        if (big || !t.last || t.dirty) {
          if (t.dirty || !t.last) t.settleAt = [3000, 10_000, 30_000].map((ms) => Date.now() + ms);
          t.dirty = false;
          await shoot(big);
        } else if (t.settleAt?.length && Date.now() >= t.settleAt[0]) {
          t.settleAt.shift();
          await shoot(false);
        }
      } else {
        const seen = [...clients].filter((c) => !c.idle && wants(c, slot));
        const width = big ? fitWidth(Math.max(BIG_W, ...seen.map((c) => c.bw ?? 0))) : fitWidth(Math.max(SMALL_W, ...seen.map((c) => c.w ?? 0)));
        if (t.casting !== width) {
          await castOff();
          t.casting = width;
          await conn.send('Page.startScreencast', { format: 'jpeg', quality: big ? 70 : 50, maxWidth: width, maxHeight: width, everyNthFrame: 1 }, 3000).catch(() => undefined);
        }
        // 녹화 스트림은 화면이 바뀔 때만 그림을 준다. 가만히 있는 페이지, 다른 창에 가려진 창, 창 없이 켠 슬롯은
        // 한 장도 안 올 수 있어서(칸이 검게 남는다), 스트림이 조용하면 가끔 직접 한 장 찍는다. 같은 그림이면 보내지 않는다.
        const now = Date.now();
        if (now - (t.castAt ?? 0) > SLOW_MS && now - (t.shotAt ?? 0) > (t.last ? SLOW_MS : 0)) {
          t.shotAt = now;
          const shot = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: big ? 60 : 40 }, 5000).catch(() => undefined);
          if (shot?.data && Date.now() - (t.castAt ?? 0) > SLOW_MS) deliver(slot, t, shot.data);
        }
      }
      // 숨은 탭은 느리게 보되, 슬롯에 보이는 탭이 하나도 없으면(창이 최소화·가려짐) 다시 나타나는 순간을 빨리 알도록 1초마다
      const slotVisible = [...tabs].some(([key, x]) => key.startsWith(`${slot}:`) && x.hidden === false);
      const gap = big ? FOCUS_MS : hidden ? (slotVisible ? SLOW_MS : FAST_MS) : FAST_MS;
      await new Promise<void>((r) => { const tm = setTimeout(r, Math.max(50, gap - (Date.now() - began))); t.wake = () => { clearTimeout(tm); r(); }; });
      t.wake = undefined;
    }
    await castOff();
    conn.close();
    t.conn = undefined;
  }

  // ── 슬롯·탭 목록, 활동, 메시지 ──
  // 훑기가 겹치지 않게: 도는 중에 또 부르면 끝난 뒤 한 번 더 돈다
  let scanning = false, again = false;
  async function scan(): Promise<void> {
    if (scanning) { again = true; return; }
    scanning = true;
    try { await scanOnce(); } finally { scanning = false; if (again) { again = false; void scan(); } }
  }
  async function scanOnce() {
    const reg = readRegistry();
    const asked = new Set<number>();
    let all = false;
    for (const c of clients) { if (c.slots === 'all') all = true; else for (const s of c.slots) asked.add(s); }
    const nums = new Set<number>([...asked, ...(all ? Object.keys(reg.slots).map(Number).filter(isValidSlot) : [])]);
    const out: SlotInfo[] = [];
    const live = new Set<string>();
    await Promise.all([...nums].sort((a, b) => a - b).map(async (no) => {
      const rec = reg.slots[String(no)];
      let pages: PageTarget[] | undefined;
      try {
        pages = await listPages(no, 2500);
      } catch {
        pages = undefined;
      }
      const info: SlotInfo = { no, color: colorOf(no), running: !!pages, headless: rec?.headless, paused: rec?.paused, proxy: !!rec?.proxy, ...(rec?.browser ? { browser: rec.browser } : {}), tabs: [] };
      for (const p of pages ?? []) {
        if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|$)`).test(p.url)) continue; // 관제 화면 자신 (어느 슬롯에 띄워도 자기 자신은 관제에서 뺀다)
        const key = `${no}:${p.id}`;
        live.add(key);
        const tr = rec?.tabs[p.id];
        let t = tabs.get(key);
        if (!t) tabs.set(key, (t = { targetId: p.id, watching: false, lastHash: '', same: 0 }));
        if (t.seenUrl !== p.url || t.seenTitle !== p.title) { if (t.seenUrl !== undefined) t.dirty = true; t.seenUrl = p.url; t.seenTitle = p.title; }
        if (anyWants(no) && !t.watching) { t.watching = true; void watchTab(no, t, p.webSocketDebuggerUrl ?? `ws://127.0.0.1:${portOf(no)}/devtools/page/${p.id}`); }
        if (!anyWants(no)) t.watching = false;
        info.tabs.push({ targetId: p.id, id: tr?.id ?? '', seq: tr?.seq ?? Number.MAX_SAFE_INTEGER, title: p.title, url: p.url, hidden: t.hidden, openedBy: tr?.openedBy, last: tr?.last && { agent: tr.last.agent, action: tr.last.action, at: tr.last.at }, summary: tr?.summary?.text });
        // 활동 기록: 조작 시각이 바뀐 탭
        if (tr?.last && seenAction.get(key) !== tr.last.at) {
          // 에이전트가 이 탭을 조작했다 → 숨은 탭이어도 바뀐 화면을 찍는다 (주소·제목이 그대로인 조작: 입력·클릭·스크롤 등)
          if (seenAction.has(key) || known.has(key)) t.dirty = true;
          if (seenAction.has(key) || Date.now() - Date.parse(tr.last.at) < 5000) note({ at: tr.last.at, slot: no, tab: tr.id, who: tr.last.agent, what: tr.last.action, title: p.title });
          seenAction.set(key, tr.last.at);
        }
        if (known.size && !known.has(key)) note({ at: new Date().toISOString(), slot: no, tab: tr?.id, who: tr?.openedBy ?? '', what: 'new tab', title: p.title || p.url });
      }
      // Chrome이 주는 순서는 "최근에 앞에 있던 순"이라 볼 때마다 바뀐다 → 탭 번호 순서로 고정한다
      info.tabs.sort((a, b) => a.seq - b.seq);
      const visible = info.tabs.filter((x) => x.hidden === false);
      if (visible.length) { for (const x of visible) x.front = true; lastFront.set(no, visible[0].targetId); }
      else { const keep = info.tabs.find((x) => x.targetId === lastFront.get(no)); if (keep) keep.front = true; }
      out.push(info);
    }));
    for (const [key, t] of tabs) {
      if (live.has(key)) continue;
      t.watching = false;
      tabs.delete(key);
      seenAction.delete(key);
      if (known.has(key)) note({ at: new Date().toISOString(), slot: Number(key.split(':')[0]), who: '', what: 'tab closed' });
    }
    known = live;
    slots = out.sort((a, b) => a.no - b.no);
    const json = JSON.stringify(slots);
    if (json !== lastState) { lastState = json; for (const c of clients) c.res.write(`event: state\ndata: ${JSON.stringify(slots.filter((s) => wants(c, s.no)))}\n\n`); }
    // 슬롯 메시지: 파일이 바뀐 슬롯만 다시 읽는다
    for (const no of nums) {
      let mtime = 0;
      try { mtime = fs.statSync(paths.messages(no)).mtimeMs; } catch { /* 메시지 없음 */ }
      const had = messages.get(no);
      if (had?.mtime === mtime) continue;
      const items = mtime ? readMessages(no) : [];
      messages.set(no, { mtime, items });
      push('messages', { slot: no, items }, (c) => wants(c, no));
    }
  }

  function readMessages(slot: number): Message[] {
    try {
      return fs.readFileSync(paths.messages(slot), 'utf8').split('\n').filter(Boolean).slice(-80).map((l) => JSON.parse(l) as Message);
    } catch {
      return [];
    }
  }

  // ── 관제 화면에서 누른 것: Chrome에 바로 시킨다 ──
  async function browserOf(slot: number): Promise<CdpConnection> {
    const p = await probe(slot, 3000);
    if (p.state !== 'chrome') throw new Error(`Slot ${slot} is off.`);
    return CdpConnection.connect(p.version.webSocketDebuggerUrl, 5000);
  }
  const tabLabel = (slot: number, targetId: string) => {
    const t = slots.find((s) => s.no === slot)?.tabs.find((x) => x.targetId === targetId);
    return { id: t?.id ? `[${t.id}]` : '', title: t?.title || t?.url || '' };
  };

  async function tabAction(body: { slot: number; targetId: string; action: string }): Promise<string> {
    const { slot, targetId, action } = body;
    const { id, title } = tabLabel(slot, targetId);
    if (action === 'close' || action === 'front') {
      const b = await browserOf(slot);
      try {
        if (action === 'front') { await b.send('Target.activateTarget', { targetId }, 5000); return 'Brought the tab to the front of its window.'; }
        // 마지막 탭을 닫으면 그 슬롯 Chrome이 꺼질 수 있다 → 빈 탭을 하나 남긴다
        if ((await listPages(slot, 3000)).length <= 1) await b.send('Target.createTarget', { url: 'about:blank', background: true }, 5000);
        await b.send('Target.closeTarget', { targetId }, 5000);
      } finally {
        b.close();
      }
      await sendMessage(slot, WATCH_AGENT, `The user closed tab ${id} "${title}" with the watch screen. If your task needs that page, tell the user.`, null).catch(() => undefined);
      note({ at: new Date().toISOString(), slot, tab: id.replace(/[[\]]/g, ''), who: 'you', what: 'closed tab', title });
      return 'Tab closed.';
    }
    const page = await CdpConnection.connect(`ws://127.0.0.1:${portOf(slot)}/devtools/page/${targetId}`, 5000);
    try {
      if (action === 'reload') { await page.send('Page.reload', {}, 5000); note({ at: new Date().toISOString(), slot, tab: id.replace(/[[\]]/g, ''), who: 'you', what: 'reload', title }); return 'Reloaded.'; }
      if (action === 'back' || action === 'forward') {
        const h = await page.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory', {}, 5000);
        const e = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
        if (!e) return action === 'back' ? 'Nothing to go back to.' : 'Nothing to go forward to.';
        await page.send('Page.navigateToHistoryEntry', { entryId: e.id }, 5000);
        return action === 'back' ? 'Went back.' : 'Went forward.';
      }
    } finally {
      page.close();
    }
    throw new Error('Unknown action.');
  }

  async function slotAction(body: { slot: number; action: string; url?: string }): Promise<string> {
    const { slot, action } = body;
    if (action === 'pause') { await pauseSlots([slot], WATCH_AGENT); lastState = ''; return `Slot ${slot} paused. Agents won't act until you resume it.`; }
    if (action === 'resume') { await resumeSlots([slot], WATCH_AGENT); lastState = ''; return `Slot ${slot} resumed.`; }
    if (action === 'close') {
      // 슬롯 브라우저 전체를 끈다: 정상 종료를 부탁하고, 포트가 닫히고 프로세스가 끝날 때까지 기다린다.
      // 그래도 본체 프로세스가 남아 있으면(먹통 등) 그 프로세스만 강제로 끝내 메모리를 남기지 않는다. 로그인은 프로필에 남는다.
      await sendMessage(slot, WATCH_AGENT, `The user closed slot ${slot} (its whole browser) with the watch screen. Its tabs are gone; don't use this slot unless the user launches it again.`, null).catch(() => undefined);
      let forced = false;
      await withSlotLock(slot, async () => {
        const rec = readRegistry().slots[String(slot)];
        const b = await browserOf(slot).catch(() => undefined);
        if (b) { await b.send('Browser.close', {}, 5000).catch(() => undefined); b.close(); }
        for (let i = 0; i < 25 && (await probe(slot, 500)).state === 'chrome'; i++) await sleep(200);
        for (let i = 0; rec?.pid && i < 50 && pidAlive(rec.pid); i++) await sleep(100);
        if (rec?.pid && pidAlive(rec.pid)) { try { process.kill(rec.pid); forced = true; } catch { /* 이미 끝남 */ } }
        await forgetSlot(slot);
      });
      lastState = '';
      void scan();
      return `Closed slot ${slot}.${forced ? ' It did not exit by itself, so its process was ended.' : ''}`;
    }
    if (action === 'newtab') {
      const url = (body.url ?? '').trim() || 'about:blank';
      if (!/^(https?:|file:|about:blank$)/i.test(url)) throw new Error('Only http(s) addresses can be opened.');
      const b = await browserOf(slot);
      try { await b.send('Target.createTarget', { url, background: true }, 8000); } finally { b.close(); }
      await sendMessage(slot, WATCH_AGENT, `The user opened a new tab in this slot with the watch screen: ${url}`, null).catch(() => undefined);
      return `Opened a new tab in slot ${slot}.`;
    }
    throw new Error('Unknown action.');
  }

  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    // 다른 이름으로 이 서버를 부르는 것(다른 웹 페이지가 주소를 돌려 부르는 수법)을 막는다
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return json(403, { error: 'bad host' });
    if (url.pathname === '/ping') return json(200, { cdpmWatch: VERSION, pid: process.pid });
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(watchPage(token));
    }
    const given = url.searchParams.get('token') ?? req.headers['x-cdpm-watch'];
    if (given !== token) return json(403, { error: 'bad token' });
    if (url.pathname === '/events') {
      const list = (url.searchParams.get('slots') ?? '').split(',').map(Number).filter(isValidSlot);
      const c: Client = { res, slots: list.length ? new Set(list) : 'all' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(c);
      (res as any).cdpmClient = c;
      res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, id: (c as any).id = randomBytes(6).toString('hex') })}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(slots.filter((s) => wants(c, s.no)))}\n\n`);
      for (const [key, t] of tabs) { const slot = Number(key.split(':')[0]); if (t.last && wants(c, slot)) res.write(`event: frame\ndata: ${JSON.stringify({ slot, id: t.targetId, data: t.last })}\n\n`); }
      for (const [slot, m] of messages) if (wants(c, slot)) res.write(`event: messages\ndata: ${JSON.stringify({ slot, items: m.items })}\n\n`);
      for (const a of activity.slice(-60)) if (wants(c, a.slot)) res.write(`event: activity\ndata: ${JSON.stringify(a)}\n\n`);
      void scan();
      req.on('close', () => { clients.delete(c); idleSince = Date.now(); void scan(); });
      return;
    }
    if (req.method !== 'POST') return json(404, { error: 'not found' });
    try {
      const body = await readBody(req);
      if (url.pathname === '/api/move') {
        const r = await moveTab(body as MoveRequest);
        if (r.status === 'moved') note({ at: new Date().toISOString(), slot: (body as MoveRequest).to, who: 'you', what: `moved from slot ${(body as MoveRequest).from}` });
        void scan();
        return json(200, r);
      }
      if (url.pathname === '/api/tab') { const message = await tabAction(body); void scan(); return json(200, { ok: true, message }); }
      if (url.pathname === '/api/slot') { const message = await slotAction(body); void scan(); return json(200, { ok: true, message }); }
      if (url.pathname === '/api/view') {
        // 보는 슬롯과 크게 보는 탭을 바꾼다 (그 탭만 빠르고 크게 받는다)
        const c = [...clients].find((x) => (x as any).id === body.id);
        if (c) {
          if (Array.isArray(body.slots)) c.slots = body.slots.length ? new Set(body.slots.map(Number).filter(isValidSlot)) : 'all';
          c.focus = typeof body.focus === 'string' ? body.focus : undefined;
          c.idle = !!body.idle;
          c.w = Number(body.w) > 0 ? Math.min(4000, Number(body.w)) : undefined;
          c.bw = Number(body.bw) > 0 ? Math.min(4000, Number(body.bw)) : undefined;
          c.skip = new Set(Array.isArray(body.skip) ? body.skip.map(Number).filter(isValidSlot) : []);
          lastState = '';
          void scan();
        }
        return json(200, { ok: true });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(200, { ok: false, message: (e as Error).message });
    }
  });

  let runningCheckedAt = 0, running = true;
  const slotsRunning = (): boolean => {
    if (Date.now() - runningCheckedAt < 30_000) return running;
    runningCheckedAt = Date.now();
    try { running = Object.values(readRegistry().slots).some((r) => !!r.pid && pidAlive(r.pid)); } catch { running = false; }
    return running;
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(wantPort, '127.0.0.1', resolve); });
  port = (server.address() as { port: number }).port;
  const timer = setInterval(() => {
    // 아무도 안 보고(보는 사람이 없으면 탭에 붙지도 않는다) 켜진 슬롯도 없이 10분이 지나면 스스로 끝낸다.
    // 슬롯이 켜져 있는 동안은 끄지 않는다: 잠깐 다른 화면을 보다 돌아왔을 때 관제 주소가 안 열리면 안 되니까.
    if (clients.size || slotsRunning()) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_EXIT_MS) close();
    void scan().catch(() => undefined);
  }, SCAN_MS);
  fs.mkdirSync(cdpmHome(), { recursive: true });
  fs.writeFileSync(watchInfoFile(), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  function close(exit = true) {
    clearInterval(timer);
    for (const t of tabs.values()) t.watching = false;
    for (const c of clients) c.res.end();
    server.close();
    try { fs.unlinkSync(watchInfoFile()); } catch { /* 이미 없음 */ }
    if (exit) setTimeout(() => process.exit(0), 400).unref();
  }
  return { port, token, close };
}
