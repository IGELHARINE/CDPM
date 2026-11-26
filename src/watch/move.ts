// 탭을 다른 슬롯으로 넘긴다 (관제 화면에서 끌어다 놓기 · 오른쪽 버튼 메뉴).
//
// 슬롯은 서로 다른 Chrome(프로필)이라 탭 자체를 옮길 수는 없다. 그래서 받는 슬롯에서 같은 주소를 새 탭으로 열고,
// 열리는 것을 확인한 뒤 원래 탭을 닫는다. 쿠키·세션·저장소는 넘기지 않는다: 받는 슬롯은 자기가 가진 로그인 상태 그대로 그 주소를 연다
// (구글·은행처럼 로그인을 그 브라우저에 묶어 두는 사이트는 쿠키를 복사해도 어차피 로그인이 따라가지 않고, 복사하려다 원래 로그인까지 끊긴다).
// 실패하면 원래 탭은 늘 남는다: 닫는 것은 맨 마지막, 새 탭이 열린 뒤다.
import { CdpConnection } from '../cdp/client.js';
import { listPages, probe, type PageTarget } from '../cdp/targets.js';
import { sendMessage } from '../registry/messages.js';
import { readRegistry } from '../registry/store.js';
import { canReopen } from './site.js';

/** 관제 화면에서 한 일을 에이전트에게 알릴 때의 보낸 이 */
export const WATCH_AGENT = 'user (watch)';

export interface MoveRequest {
  from: number;
  targetId: string;
  to: number;
}

export interface MoveResult {
  status: 'moved' | 'failed';
  /** 사람에게 보여 줄 한 줄 */
  message: string;
  notes: string[];
  newTargetId?: string;
}

async function browserOf(slot: number): Promise<CdpConnection | undefined> {
  const p = await probe(slot, 3000);
  return p.state === 'chrome' ? CdpConnection.connect(p.version.webSocketDebuggerUrl, 5000) : undefined;
}

const fail = (message: string, notes: string[] = []): MoveResult => ({ status: 'failed', message, notes });

export async function moveTab(req: MoveRequest): Promise<MoveResult> {
  const { from, to, targetId } = req;
  if (from === to) return fail('Same slot.');
  let pages: PageTarget[];
  try {
    pages = await listPages(from, 4000);
  } catch {
    return fail(`Slot ${from} is off.`);
  }
  const page = pages.find((p) => p.id === targetId);
  if (!page) return fail('That tab is already closed.');
  if (!canReopen(page.url)) return fail("This page can't be reopened in another slot (Chrome internal or extension page).");
  const [src, dst] = await Promise.all([browserOf(from), browserOf(to)]);
  const conns: CdpConnection[] = [src, dst].filter((c): c is CdpConnection => !!c);
  const done = <T>(r: T): T => { for (const c of conns) c.close(); return r; };
  if (!src) return done(fail(`Couldn't connect to slot ${from}.`));
  if (!dst) return done(fail(`Slot ${to} is off. Launch it first.`));

  try {
    const tabRec = readRegistry().slots[String(from)]?.tabs[targetId];
    const tabName = tabRec?.id ? `[${tabRec.id}]` : '';
    const title = page.title || page.url;
    const notes: string[] = [];

    // 받는 슬롯에 새 탭으로 같은 주소를 연다
    const { targetId: newId } = await dst.send<{ targetId: string }>('Target.createTarget', { url: page.url, background: true }, 8000);

    // 새 탭이 실제로 생겼는지만 확인하고 닫는다 (로딩 끝까지 기다리지 않는다: 알아서 로딩된다)
    let opened = false;
    for (let i = 0; i < 15 && !opened; i++) {
      opened = (await listPages(to, 2000).catch(() => [] as PageTarget[])).some((p) => p.id === newId);
      if (!opened) await new Promise((r) => setTimeout(r, 200));
    }
    if (!opened) return done(fail(`The tab didn't open in slot ${to}. The original tab is untouched.`, notes));
    notes.push(`The login is whatever slot ${to} already has; nothing was carried from slot ${from}.`);

    // 원래 탭을 닫는다. 마지막 탭을 닫으면 그 슬롯 Chrome이 꺼질 수 있어 빈 탭을 하나 남긴다.
    if (pages.length <= 1) await src.send('Target.createTarget', { url: 'about:blank', background: true }, 5000).catch(() => undefined);
    await src.send('Target.closeTarget', { targetId }, 5000).catch(() => undefined);
    let gone = false;
    for (let i = 0; i < 15 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 200));
      gone = !(await listPages(from, 2000).catch(() => [] as PageTarget[])).some((p) => p.id === targetId);
    }
    if (!gone) notes.push("The original tab didn't close (the page may be blocking it). Close it yourself.");

    const tell = `The user moved tab ${tabName} "${title}" from slot ${from} to slot ${to} with the watch screen (the address only; no login or data was carried).`;
    await sendMessage(from, WATCH_AGENT, `${tell} It is no longer in this slot: don't look for it here. If your task needs that page, tell the user.`, null).catch(() => undefined);
    await sendMessage(to, WATCH_AGENT, `${tell} It is a new tab in this slot now (${page.url}); check browser_tabs for its ID.`, null).catch(() => undefined);
    return done({ status: 'moved', message: `Moved "${title}" to slot ${to}.`, notes, newTargetId: newId });
  } catch (e) {
    return done(fail(`Something went wrong while moving: ${(e as Error).message}`));
  }
}
