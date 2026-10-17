// 슬롯 실행 보장, 탭 목록과 기록부 맞추기, 행동 기록.
import { launchChrome, type LaunchOptions } from './chrome/launcher.js';
import { describeProxy } from './chrome/proxy.js';
import { installedChromeKey, installedChromeVersion, runningVersion } from './chrome/version.js';
import { browserConnection, dropSlotConnections, hasLiveBrowserConnection, pageSession } from './cdp/sessions.js';
import { listPages, probe, type PageTarget } from './cdp/targets.js';
import { CdpmError } from './errors.js';
import { withSlotLock } from './registry/lock.js';
import { newSlotRecord, readRegistry, updateRegistry, type SlotRecord, type TabRecord } from './registry/store.js';
import { MAX_SLOT, portOf } from './slots.js';
import { applyDock, DOCK_SUPPORTED } from './taskbar/dock.js';
import { applyTaskbar } from './taskbar/watcher.js';
import { ago, nowIso, pidAlive, secondsSince, sleep } from './util.js';

export const EXTERNAL = '(external)';

/** 이 프로세스가 Chrome에게 직접 물어(또는 직접 띄워) 맞다고 확인한 슬롯 → Chrome 본체 번호 */
const confirmedPid = new Map<number, number>();

/** 이 프로세스가 직접 만든 탭 → 만든 에이전트. 기록부에 처음 올릴 때 openedBy로 쓴다. */
const createdBy = new Map<string, string>();
const createdAt = new Map<string, number>();

export function markCreated(targetId: string, agent: string) {
  createdBy.set(targetId, agent);
  createdAt.set(targetId, Date.now());
  // 기록부에 올리기 전에 닫힌 탭은 지워지지 않으므로, 10분 넘은 것은 정리한다
  if (createdAt.size > 100) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, at] of createdAt) if (at < cutoff) { createdAt.delete(id); createdBy.delete(id); }
  }
}

export interface EnsureResult {
  launched: boolean;
}

export const notRunningMessage = (slot: number) =>
  `Chrome on slot ${slot} is off. CDPM starts Chrome only when the user asks. ` +
  `Ask the user whether to start it; if yes, use browser_launch.`;

/** 떠 있는 슬롯에 붙는다 (기록·작업표시줄 맞춤). 꺼져 있으면 켜지 않고 오류. */
/** 포트 확인. 늦게 답하면(바쁜 Chrome) 길게 한 번 더 묻는다. */
async function probeSure(slot: number) {
  let p = await probe(slot);
  if (p.state === 'slow') p = await probe(slot, 8000);
  if (p.state === 'slow') {
    throw new CdpmError(`Slot ${slot} port (${portOf(slot)}) has not responded for over 8s. Chrome may be very busy or hung. Retry shortly.`);
  }
  return p;
}

export async function attachSlot(slot: number, opts: { inLock?: boolean } = {}): Promise<void> {
  // 빠른 길: 이 프로세스의 연결이 살아 있고 기록된 Chrome도 살아 있으면 포트에 다시 묻지 않는다.
  const known = readRegistry().slots[String(slot)];
  // 기록된 번호는 이 프로세스가 확인한 것일 때만 믿는다 (다른 세션이 다시 켰거나 재부팅 뒤 옛 번호일 수 있음)
  if (known?.pid && confirmedPid.get(slot) === known.pid && pidAlive(known.pid) && hasLiveBrowserConnection(slot)) return;
  const p = await probeSure(slot);
  if (p.state === 'other') throw portBusy(slot, p.detail);
  if (p.state === 'free') {
    await forgetSlot(slot);
    throw new CdpmError(notRunningMessage(slot));
  }
  const rec = readRegistry().slots[String(slot)];
  let pid = rec?.pid;
  // 기록된 번호가 살아 있어도 지금 포트의 Chrome 본체가 맞는지 Chrome에게 직접 묻는다 (이 프로세스에서 슬롯마다 한 번).
  // 재부팅 뒤 Windows가 Chrome을 다시 띄우면 번호가 바뀌고, 옛 번호를 다른 프로그램이 받을 수도 있다.
  const actual = await browserPid(slot);
  if (actual !== undefined && !pidAlive(actual)) {
    // SSH 터널(ssh -L 9222:...)처럼 다른 PC의 Chrome이 이 포트로 보이는 경우 그 PID는 이 PC에 없다.
    await forgetSlot(slot);
    throw new CdpmError(`Slot ${slot} port (${portOf(slot)}) is connected to a Chrome on another machine (SSH tunnel, etc.). Close that connection or use another slot.`);
  }
  if (actual !== undefined && actual !== pid) {
    pid = actual;
    await updateRegistry((r) => {
      const s = (r.slots[String(slot)] ??= newSlotRecord(EXTERNAL, nowIso()));
      s.pid = actual;
    });
  } else if (!pid || !pidAlive(pid)) {
    // Chrome에게 물을 수 없었고 기록도 쓸 수 없음
    await forgetSlot(slot);
    throw new CdpmError(`Slot ${slot} port (${portOf(slot)}) answers, but its Chrome process could not be identified. Try again.`);
  }
  if (actual !== undefined) confirmedPid.set(slot, actual);
  applyTaskbar(slot, pid);
  if (DOCK_SUPPORTED && !rec?.headless) void applyDock(slot, pid);
  // 실행 중에 Chrome이 업데이트됐으면(새 탭이 안 열림) 새 버전으로 다시 켠다
  if (!opts.inLock && p.state === 'chrome') await restartIfUpdated(slot, p.version.Browser); // macOS만
}

function portBusy(slot: number, detail: string) {
  return new CdpmError(`Slot ${slot} port ${portOf(slot)} is used by a non-Chrome program (${detail}). Close it or use another slot.`);
}

/** 사용자가 켜라고 했을 때만 부른다. 이미 떠 있으면 붙기만 한다. */
export function launchSlot(slot: number, agent: string, opts: LaunchOptions = {}): Promise<EnsureResult> {
  // 여러 세션이 같은 슬롯을 동시에 켜면 둘 다 "비어 있음"으로 보고 Chrome을 두 번 띄운다 → 슬롯 잠금 안에서 하나씩
  return withSlotLock(slot, () => launchSlotLocked(slot, agent, opts));
}

async function launchSlotLocked(slot: number, agent: string, opts: LaunchOptions): Promise<EnsureResult> {
  const p = await probeSure(slot);
  if (p.state === 'other') throw portBusy(slot, p.detail);
  if (p.state === 'chrome') {
    await attachSlot(slot, { inLock: true });
    return { launched: false };
  }
  // 방금 끈 Chrome은 포트를 닫은 뒤에도 잠깐 살아서 프로필을 붙잡고 있다. 그때 새로 켜면 새 Chrome이
  // 꺼지는 중인 옛 Chrome에 넘어가 버리므로, 기록된 프로세스가 끝날 때까지(최대 5초) 기다린다.
  const old = readRegistry().slots[String(slot)]?.pid;
  for (let i = 0; old && i < 50 && pidAlive(old); i++) await sleep(100);
  await forgetSlot(slot); // 남아 있던 죽은 기록 정리
  const launched = await launchChrome(slot, opts);
  const pid = launched.pid ?? (await browserPid(slot));
  if (pid) confirmedPid.set(slot, pid);
  const pages = await listPages(slot).catch(() => [] as PageTarget[]);
  for (const page of pages) markCreated(page.id, agent);
  // macOS만: Dock 아이콘을 슬롯 아이콘으로 (첫 빈 탭이 있을 때 그림을 그려 저장해 둔다)
  if (DOCK_SUPPORTED && !opts.headless) await applyDock(slot, pid);
  await updateRegistry((r) => {
    r.slots[String(slot)] = { ...newSlotRecord(agent, nowIso(), pid), ...(opts.headless ? { headless: true } : {}), ...(opts.proxy ? { proxy: describeProxy(opts.proxy) } : {}) };
  });
  // 처음 열린 탭을 지금(이 프로세스 안에서) 기록해야 "연 사람"이 실행한 에이전트로 남는다.
  await syncTabs(slot).catch(() => undefined);
  // 창이 뜨는 데 시간이 걸리므로 창이 나타날 때까지 적용을 시도 (창이 나타나는 것이 신호; 이후는 watcher가 맡음).
  // 헤드리스는 창이 없으니 기다리지 않는다.
  for (let i = 0; !opts.headless && i < 50; i++) {
    if (applyTaskbar(slot, pid) > 0) break;
    await sleep(100);
  }
  return { launched: true };
}

/** 포트가 비어 있는(Chrome도 다른 프로그램도 없는) 슬롯을 작은 번호부터 n개. 모자라면 있는 만큼. */
export async function freeSlots(n: number): Promise<number[]> {
  const states = await Promise.all(Array.from({ length: MAX_SLOT }, (_, i) => probe(i + 1, 2000)));
  return states.flatMap((s, i) => (s.state === 'free' ? [i + 1] : [])).slice(0, n);
}

/** 포트가 비어 있는 가장 작은 슬롯. 없으면 undefined. */
export async function firstFreeSlot(): Promise<number | undefined> {
  return (await freeSlots(1))[0];
}

/** 실행 중 업데이트로 다시 켠 버전 쌍 (슬롯 → "옛>새"). 다시 켜도 버전이 안 맞으면 같은 쌍으로 또 켜지 않는다 (무한 반복 방지) */
const updateRestarted = new Map<number, string>();

/** 슬롯 Chrome(/json/version의 Browser)이 디스크에 설치된 Chrome과 버전이 다르면 두 버전. 알 수 없으면 undefined */
export function staleVersion(browser: string | undefined): { running: string; installed: string } | undefined {
  const running = runningVersion(browser);
  const installed = installedChromeVersion();
  return running && installed && running !== installed ? { running, installed } : undefined;
}

const isBlankUrl = (u: string) => !u || u === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(u) || u.startsWith('chrome-search://');

async function setNotice(slot: number, text: string) {
  await updateRegistry((r) => {
    const s = r.slots[String(slot)];
    if (s) s.notice = { text, at: nowIso() };
  }).catch(() => undefined);
}

/**
 * 슬롯 Chrome이 실행 중에 업데이트됐으면(디스크의 Chrome과 버전이 다름) 새 버전으로 다시 켠다. 옛 버전 본체는 바뀐
 * 실행 파일로 렌더러를 띄우지 못해 새 탭·다른 사이트로 넘어간 탭이 빈 채로 멈추기 때문이다. 열려 있던 탭 주소를 순서대로
 * 다시 열고, 창 모드·헤드리스는 그대로 둔다 (로그인은 프로필에 남음). 프록시 슬롯은 접속 정보가 기록에 없어 다시 켜지
 * 않고 알리기만 한다. 다시 켰으면 true.
 */
export async function restartIfUpdated(slot: number, browser?: string): Promise<boolean> {
  const first = staleVersion(browser);
  if (!first) return false;
  const pair = `${first.running}>${first.installed}`;
  if (updateRestarted.get(slot) === pair) return false;
  updateRestarted.set(slot, pair);
  return withSlotLock(slot, async () => {
    // 잠금을 기다리는 동안 다른 세션이 이미 다시 켰을 수 있다
    const p = await probe(slot, 1500);
    const stale = p.state === 'chrome' ? staleVersion(p.version.Browser) : undefined;
    if (!stale) return false;
    const rec = readRegistry().slots[String(slot)];
    const from = `${stale.running} → ${stale.installed}`;
    if (rec?.proxy) {
      await setNotice(slot, `Slot ${slot} Chrome was updated while running (${from}), so new tabs and cross-site navigations may hang. It uses a proxy, so CDPM did not restart it: ask the user to restart it (browser_close, then browser_launch with the same proxy).`);
      return false;
    }
    const tabs = await syncTabs(slot).catch(() => [] as TabView[]);
    const urls = tabs.map((t) => t.url).filter((u) => !isBlankUrl(u));
    const browserConn = await browserConnection(slot);
    await browserConn.send('Browser.close', {}, 5000).catch(() => undefined);
    for (let i = 0; i < 25 && (await probe(slot, 500)).state === 'chrome'; i++) await sleep(200);
    // 포트가 닫혀도 프로세스는 잠깐 더 살아 프로필을 붙잡는다. 끝날 때까지 기다려야 다시 켤 수 있다.
    for (let i = 0; rec?.pid && i < 50 && pidAlive(rec.pid); i++) await sleep(100);
    await forgetSlot(slot);
    const launched = await launchChrome(slot, { headless: rec?.headless, url: urls[0] });
    const pid = launched.pid ?? (await browserPid(slot));
    if (pid) confirmedPid.set(slot, pid);
    const text = `Slot ${slot} Chrome had been updated while running (${from}), so new tabs could not load. CDPM restarted it on the new version` +
      `${urls.length ? ` and reopened ${urls.length} tab(s)` : ''}. Logins are kept, but tab IDs changed and unsaved page input was lost.`;
    await updateRegistry((r) => {
      r.slots[String(slot)] = {
        ...newSlotRecord(rec?.launchedBy ?? EXTERNAL, nowIso(), pid),
        ...(rec?.headless ? { headless: true } : {}),
        notice: { text, at: nowIso() },
      };
    });
    const conn = await browserConnection(slot).catch(() => undefined);
    for (const u of urls.slice(1)) await conn?.send('Target.createTarget', { url: u, background: true }).catch(() => undefined);
    await syncTabs(slot).catch(() => undefined);
    for (let i = 0; !rec?.headless && i < 50; i++) {
      if (applyTaskbar(slot, pid) > 0) break;
      await sleep(100);
    }
    return true;
  });
}

/**
 * 슬롯 감시: 10초마다 설치된 chrome.exe가 바뀌었는지만 본다 (파일 정보만, 슬롯에는 묻지 않음).
 * 바뀌었을 때(그리고 이 CDPM이 처음 확인할 때 한 번)만 슬롯마다 버전을 물어 비교하고, 다르면 다시 켠다.
 * 업데이트는 슬롯이 켜져 있는 동안에도 일어난다 (평소 쓰는 Chrome을 껐다 켜는 순간 같은 chrome.exe가 바뀜).
 */
let lastInstalledKey: string | undefined;
let lastUpdateCheck = 0;
export async function checkUpdatedChrome(): Promise<number[]> {
  if (Date.now() - lastUpdateCheck < 10_000) return [];
  lastUpdateCheck = Date.now();
  const key = installedChromeKey();
  if (!key || key === lastInstalledKey) return [];
  const restarted: number[] = [];
  let unsure = false;
  for (const s of Object.keys(readRegistry().slots)) {
    const slot = Number(s);
    const p = await probe(slot, 1500);
    if (p.state === 'slow') unsure = true; // 바쁜 슬롯은 다음 확인 때 다시
    if (p.state !== 'chrome' || !staleVersion(p.version.Browser)) continue;
    if (await restartIfUpdated(slot, p.version.Browser).catch(() => false)) restarted.push(slot);
  }
  // 모든 슬롯을 확인했으면 이 실행 파일은 끝. 응답이 늦은 슬롯이 있었으면 다음 주기에 다시 비교한다
  if (!unsure) lastInstalledKey = key;
  return restarted;
}

/**
 * 기록부의 Chrome 번호가 지금 포트의 Chrome 본체와 같은지 확인하고, 다르면 고친다. 확인한 번호를 돌려준다.
 * 포트가 비어 있거나(Chrome 꺼짐) 확인할 수 없으면 undefined (기록은 그대로).
 */
export async function verifySlotPid(slot: number): Promise<number | undefined> {
  if (!readRegistry().slots[String(slot)]) return undefined;
  const p = await probe(slot, 1500);
  if (p.state !== 'chrome') return undefined;
  const actual = await browserPid(slot);
  if (!actual || !pidAlive(actual)) return undefined;
  await updateRegistry((r) => {
    const s = r.slots[String(slot)];
    if (s && s.pid !== actual) s.pid = actual;
  });
  confirmedPid.set(slot, actual);
  return actual;
}

async function browserPid(slot: number): Promise<number | undefined> {
  try {
    const conn = await browserConnection(slot);
    const info = await conn.send<{ processInfo: { type: string; id: number }[] }>('SystemInfo.getProcessInfo', {}, 5000);
    return info.processInfo.find((x) => x.type === 'browser')?.id;
  } catch {
    return undefined;
  }
}

export interface TabView {
  no: number;
  targetId: string;
  id: string;
  title: string;
  url: string;
  active: boolean;
  rec: TabRecord;
}

/** Chrome의 실제 탭 목록과 기록부를 맞추고, 처음 본 순서대로 돌려준다. */
export async function syncTabs(slot: number): Promise<TabView[]> {
  const pages = await listPages(slot);
  const live = new Set(pages.map((p) => p.id));
  // 바뀐 게 없으면 기록부를 쓰지 않는다 (여러 에이전트가 동시에 쓸 때 잠금 경쟁을 줄임).
  let slotRec = readRegistry().slots[String(slot)];
  // 처음 보는 탭은 Chrome에게 '누가 열었는지(openerId)'를 물어 둔다 (시간으로 추측하지 않음).
  const openers = new Map<string, string | undefined>();
  const unseen = pages.filter((p) => !slotRec?.tabs[p.id] && !createdBy.has(p.id));
  if (unseen.length) {
    const browser = await browserConnection(slot).catch(() => undefined);
    await Promise.all(unseen.map(async (p) => {
      const info = await browser?.send<{ targetInfo: { openerId?: string } }>('Target.getTargetInfo', { targetId: p.id }, 10_000).catch(() => undefined);
      openers.set(p.id, info?.targetInfo.openerId);
    }));
  }
  const deadBlocks = (t: TabRecord) => (t.blocks ?? []).some((b) => !pidAlive(b.pid));
  const changed = !slotRec || pages.some((p) => !slotRec!.tabs[p.id]) || Object.keys(slotRec.tabs).some((id) => !live.has(id))
    || Object.values(slotRec.tabs).some(deadBlocks);
  if (changed) {
    slotRec = await updateRegistry((r) => {
      const s = (r.slots[String(slot)] ??= newSlotRecord(EXTERNAL, nowIso()));
      for (const id of Object.keys(s.tabs)) if (!live.has(id)) delete s.tabs[id];
      // 규칙을 건 세션(프로세스)이 끝났으면 Chrome에서도 이미 풀린 규칙이다.
      for (const t of Object.values(s.tabs)) {
        if (!t.blocks) continue;
        t.blocks = t.blocks.filter((b) => pidAlive(b.pid));
        if (!t.blocks.length) delete t.blocks;
      }
      for (const p of pages) {
        if (s.tabs[p.id]) continue;
        let openedBy = createdBy.get(p.id);
        const opener = openers.get(p.id);
        if (!openedBy && opener) {
          const by = s.tabs[opener]?.last?.agent;
          openedBy = by ? `${by} (via page)` : `page in ${s.tabs[opener]?.id ?? 'another tab'}`;
        }
        const seq = s.nextTabSeq++;
        s.tabs[p.id] = { id: `t${seq}`, seq, seenAt: nowIso(), openedBy: openedBy ?? EXTERNAL };
        createdBy.delete(p.id);
      }
      return s;
    }).catch(() => readRegistry().slots[String(slot)] ?? newSlotRecord(EXTERNAL, nowIso()));
  }
  // 앞에 있는 탭: 각 탭의 실제 보임 상태로 판단한다 (/json/list 순서는 탭을 바꿔도 갱신되지 않음).
  const visible = await Promise.all(pages.map(async (p) => {
    try {
      const session = await pageSession(slot, p.id, p.webSocketDebuggerUrl);
      return (await session.visibilityForList()) === 'visible';
    } catch {
      return false;
    }
  }));
  const rec = slotRec!;
  return pages
    .map((p, i) => ({ p, visible: visible[i], rec: rec.tabs[p.id] ?? { id: '?', seq: Number.MAX_SAFE_INTEGER, seenAt: nowIso(), openedBy: EXTERNAL } }))
    .sort((a, b) => a.rec.seq - b.rec.seq)
    .map(({ p, visible: v, rec: r }, i) => ({ no: i + 1, targetId: p.id, id: r.id, title: p.title, url: p.url, active: v, rec: r }));
}

export type TabKind = 'view' | 'action';

/** 탭 선택 규칙. 정할 수 없으면 이유. */
export function pickTab(tabs: TabView[], tabArg: string | number | undefined, kind: TabKind, preferred?: string): { tab: TabView } | { error: string } {
  if (tabArg !== undefined && tabArg !== '') {
    const s = String(tabArg).trim();
    const byId = /^t\d+$/i.test(s) ? tabs.find((t) => t.id.toLowerCase() === s.toLowerCase()) : undefined;
    const byNo = /^\d+$/.test(s) ? tabs.find((t) => t.no === Number(s)) : undefined;
    const found = byId ?? byNo;
    if (found) return { tab: found };
    const list = tabs.map((t) => `${t.no} [${t.id}]`).join(', ');
    return { error: `No such tab: "${s}". Open tabs: ${list || 'none'}` };
  }
  if (tabs.length === 1) return { tab: tabs[0] };
  if (tabs.length === 0) return { error: 'No open tabs.' };
  // 이 에이전트가 마지막으로 쓴(또는 새로 연) 탭이 있으면 보기·조작 모두 그 탭
  const mine = tabs.find((t) => t.targetId === preferred);
  if (mine) return { tab: mine };
  // 보기 도구: 앞에 보이는 탭 → 첫 탭. 조작 도구: 쓴 적 있는 탭이 없으면 지정을 요구한다.
  if (kind === 'view') return { tab: tabs.find((t) => t.active) ?? tabs[0] };
  return { error: `There are ${tabs.length} tabs and this agent has not used any yet. Set tab to a number or ID (e.g. "${tabs[0].id}").` };
}

/** 다른 에이전트가 최근(2분 안)에 조작한 탭을 조작할 때 붙일 경고 (막지는 않음). */
export function ownershipWarnings(tab: TabView, agent: string): string[] {
  const last = tab.rec.last;
  if (!last || last.agent === agent || secondsSince(last.at) > 120) return [];
  const when = ago(last.at);
  return [`Tab [${tab.id}] was used by ${last.agent} ${when} (${last.action}). If sharing it, tell them via slot_send.`];
}

/** 행동 기록. 기록부 잠금에 실패해도 도구 동작은 성공으로 두고 false를 돌려준다. */
export async function recordAction(slot: number, targetId: string, agent: string, action: string, summary?: string, anon = false, title?: string): Promise<boolean> {
  try {
    await updateRegistry((r) => {
      const s = r.slots[String(slot)];
      if (!s) return;
      const at = nowIso();
      s.last = { agent, action, at, ...(anon ? { anon: true } : {}) };
      if (targetId) s.lastTarget = targetId;
      if (title !== undefined) s.title = title;
      const t = s.tabs[targetId];
      if (t) t.last = { agent, action, at };
      if (summary?.trim()) {
        const stamp = { agent, text: summary.trim(), at };
        s.summary = stamp;
        if (t) t.summary = stamp;
      }
    });
    return true;
  } catch {
    return false;
  }
}

export async function forgetSlot(slot: number) {
  dropSlotConnections(slot);
  await updateRegistry((r) => {
    delete r.slots[String(slot)];
  });
}

/**
 * 사용자가 슬롯 Chrome의 창을 직접 모두 닫았는데 프로세스가 남은 경우 그 슬롯을 끝낸다 (Windows·Linux).
 * 탭(페이지)이 하나도 없는 상태가 2번 연속(2초 간격) 보이면 Browser.close로 정상 종료하고 기록을 지운다.
 * 켠 지 10초가 안 된 슬롯은 건너뛴다 (첫 탭이 생기기 전일 수 있음).
 * macOS는 하지 않는다: 맥에서는 창을 닫아도 앱이 살아 있는 게 원래 동작이라, 슬롯은 Cmd+Q(앱 종료)로만 끝난다.
 */
const emptySeen = new Map<number, number>();
let slotWatcher: NodeJS.Timeout | undefined;

export async function checkClosedWindows(): Promise<number[]> {
  const closed: number[] = [];
  if (process.platform === 'darwin') return closed;
  const reg = readRegistry();
  await Promise.all(Object.entries(reg.slots).map(async ([key, rec]) => {
    const slot = Number(key);
    if (!pidAlive(rec.pid) || secondsSince(rec.launchedAt) < 10) return;
    let pages: PageTarget[];
    try {
      pages = await listPages(slot, 2000);
    } catch {
      return; // 응답이 없으면 판단하지 않는다 (바쁘거나 이미 꺼지는 중)
    }
    if (pages.length) {
      emptySeen.delete(slot);
      return;
    }
    const n = (emptySeen.get(slot) ?? 0) + 1;
    emptySeen.set(slot, n);
    if (n < 2) return;
    emptySeen.delete(slot);
    const browser = await browserConnection(slot).catch(() => undefined);
    await browser?.send('Browser.close', {}, 5000).catch(() => undefined);
    await forgetSlot(slot).catch(() => undefined);
    closed.push(slot);
  }));
  return closed;
}

export function startSlotWatcher(intervalMs = 2000) {
  if (slotWatcher) return;
  let busy = false;
  slotWatcher = setInterval(() => {
    if (busy) return;
    busy = true;
    checkClosedWindows().catch(() => undefined)
      .then(() => checkUpdatedChrome().catch(() => undefined))
      .finally(() => (busy = false));
  }, intervalMs);
  slotWatcher.unref();
}

/** 1~30번 중 실제로 Chrome이 떠 있는 슬롯 (CDPM 밖에서 띄운 것 포함). 기록부의 죽은 슬롯은 정리한다. */
export async function liveSlots(): Promise<[number, SlotRecord][]> {
  const reg = readRegistry();
  const out: [number, SlotRecord][] = [];
  const dead: number[] = [];
  await Promise.all(Array.from({ length: MAX_SLOT }, (_, i) => i + 1).map(async (slot) => {
    const rec = reg.slots[String(slot)];
    // 기록이 있는 슬롯은 넉넉히 기다린다 (바쁜 Chrome을 꺼진 것으로 오해해 기록을 지우지 않게)
    const p = await probe(slot, rec ? 5000 : 800);
    if (p.state === 'chrome' || (p.state === 'slow' && rec)) out.push([slot, rec ?? newSlotRecord(EXTERNAL, nowIso())]);
    else if (rec && p.state === 'free') dead.push(slot);
  }));
  if (dead.length) {
    for (const slot of dead) dropSlotConnections(slot);
    await updateRegistry((r) => {
      for (const slot of dead) delete r.slots[String(slot)];
    }).catch(() => undefined);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
