// 슬롯 실행 보장, 탭 목록과 기록부 맞추기, 행동 기록.
import { launchChrome, type LaunchOptions } from './chrome/launcher.js';
import { describeProxy } from './chrome/proxy.js';
import { browserConnection, dropSlotConnections, hasLiveBrowserConnection, pageSession } from './cdp/sessions.js';
import { listPages, probe, type PageTarget } from './cdp/targets.js';
import { CdpmError } from './errors.js';
import { newSlotRecord, readRegistry, updateRegistry, type SlotRecord, type TabRecord } from './registry/store.js';
import { MAX_SLOT, portOf } from './slots.js';
import { applyDock, DOCK_SUPPORTED } from './taskbar/dock.js';
import { applyTaskbar } from './taskbar/watcher.js';
import { ago, josa, nowIso, pidAlive, secondsSince, sleep } from './util.js';

export const EXTERNAL = '(외부)';

/** 이 프로세스가 직접 만든 탭 → 만든 에이전트. 기록부에 처음 올릴 때 openedBy로 쓴다. */
const createdBy = new Map<string, string>();

export function markCreated(targetId: string, agent: string) {
  createdBy.set(targetId, agent);
}

export interface EnsureResult {
  launched: boolean;
}

export const notRunningMessage = (slot: number) =>
  `${slot}번 Chrome은 꺼져 있어요. CDPM은 사용자가 켜 달라고 할 때만 Chrome을 켭니다. ` +
  `사용자에게 켤지 물어보고, 켜라고 하면 browser_launch를 쓰세요.`;

/** 떠 있는 슬롯에 붙는다 (기록·작업표시줄 맞춤). 꺼져 있으면 켜지 않고 오류. */
/** 포트 확인. 늦게 답하면(바쁜 Chrome) 길게 한 번 더 묻는다. */
async function probeSure(slot: number) {
  let p = await probe(slot);
  if (p.state === 'slow') p = await probe(slot, 8000);
  if (p.state === 'slow') {
    throw new CdpmError(`${slot}번 포트(${portOf(slot)})가 8초 넘게 응답하지 않아요. Chrome이 매우 바쁘거나 멈췄을 수 있어요. 잠시 뒤 다시 시도하세요.`);
  }
  return p;
}

export async function attachSlot(slot: number): Promise<void> {
  // 빠른 길: 이 프로세스의 연결이 살아 있고 기록된 Chrome도 살아 있으면 포트에 다시 묻지 않는다.
  const known = readRegistry().slots[String(slot)];
  if (known?.pid && pidAlive(known.pid) && hasLiveBrowserConnection(slot)) return;
  const p = await probeSure(slot);
  if (p.state === 'other') throw portBusy(slot, p.detail);
  if (p.state === 'free') {
    await forgetSlot(slot);
    throw new CdpmError(notRunningMessage(slot));
  }
  const rec = readRegistry().slots[String(slot)];
  let pid = rec?.pid;
  if (!pid || !pidAlive(pid)) {
    // 기록이 없거나 기록된 Chrome이 이미 죽었으면, 포트에 응답하는 Chrome이 이 PC의 프로세스인지 확인한다.
    // SSH 터널(ssh -L 9222:...)처럼 다른 PC의 Chrome이 이 포트로 보이는 경우 그 PID는 이 PC에 없다.
    pid = await browserPid(slot);
    if (!pid || !pidAlive(pid)) {
      await forgetSlot(slot);
      throw new CdpmError(`${slot}번 포트(${portOf(slot)})에 이 PC가 아닌 Chrome이 연결돼 있어요 (SSH 터널 등). 그 연결을 닫거나 다른 슬롯을 쓰세요.`);
    }
    await updateRegistry((r) => {
      const s = (r.slots[String(slot)] ??= newSlotRecord(EXTERNAL, nowIso()));
      s.pid = pid;
    });
  }
  applyTaskbar(slot, pid);
  if (DOCK_SUPPORTED && !rec?.headless) void applyDock(slot, pid); // macOS만
}

function portBusy(slot: number, detail: string) {
  return new CdpmError(`${slot}번 슬롯의 포트 ${portOf(slot)}를 Chrome이 아닌 프로그램이 사용 중입니다 (${detail}). 그 프로그램을 종료하거나 다른 슬롯을 쓰세요.`);
}

/** 사용자가 켜라고 했을 때만 부른다. 이미 떠 있으면 붙기만 한다. */
export async function launchSlot(slot: number, agent: string, opts: LaunchOptions = {}): Promise<EnsureResult> {
  const p = await probeSure(slot);
  if (p.state === 'other') throw portBusy(slot, p.detail);
  if (p.state === 'chrome') {
    await attachSlot(slot);
    return { launched: false };
  }
  // 방금 끈 Chrome은 포트를 닫은 뒤에도 잠깐 살아서 프로필을 붙잡고 있다. 그때 새로 켜면 새 Chrome이
  // 꺼지는 중인 옛 Chrome에 넘어가 버리므로, 기록된 프로세스가 끝날 때까지(최대 5초) 기다린다.
  const old = readRegistry().slots[String(slot)]?.pid;
  for (let i = 0; old && i < 50 && pidAlive(old); i++) await sleep(100);
  await forgetSlot(slot); // 남아 있던 죽은 기록 정리
  const launched = await launchChrome(slot, opts);
  const pid = launched.pid ?? (await browserPid(slot));
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
          openedBy = by ? `${by} (페이지가 염)` : `${s.tabs[opener]?.id ?? '다른 탭'}에서 페이지가 염`;
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
    const list = tabs.map((t) => `${t.no}번 [${t.id}]`).join(', ');
    return { error: `없는 탭이에요: "${s}". 지금 있는 탭: ${list || '없음'}` };
  }
  if (tabs.length === 1) return { tab: tabs[0] };
  if (tabs.length === 0) return { error: '열린 탭이 없어요.' };
  // 이 에이전트가 마지막으로 쓴(또는 새로 연) 탭이 있으면 보기·조작 모두 그 탭
  const mine = tabs.find((t) => t.targetId === preferred);
  if (mine) return { tab: mine };
  // 보기 도구: 앞에 보이는 탭 → 첫 탭. 조작 도구: 쓴 적 있는 탭이 없으면 지정을 요구한다.
  if (kind === 'view') return { tab: tabs.find((t) => t.active) ?? tabs[0] };
  return { error: `탭이 ${tabs.length}개 있고 이 에이전트가 아직 쓴 탭이 없어요. 어느 탭에서 실행할지 tab에 번호나 ID(예: "${tabs[0].id}")를 지정하세요.` };
}

/** 다른 에이전트가 최근(2분 안)에 조작한 탭을 조작할 때 붙일 경고 (막지는 않음). */
export function ownershipWarnings(tab: TabView, agent: string): string[] {
  const last = tab.rec.last;
  if (!last || last.agent === agent || secondsSince(last.at) > 120) return [];
  const when = ago(last.at);
  return [`이 탭 [${tab.id}]은 ${josa(last.agent, '이', '가')} ${when === '방금' ? when : `${when}에`} ${last.action}했어요. 같이 쓰는 중이면 slot_send로 알려 주세요.`];
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
    checkClosedWindows().catch(() => undefined).finally(() => (busy = false));
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
