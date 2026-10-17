// 살아 있는 슬롯 Chrome 창들에 작업표시줄 아이콘을 적용하고, 새로 생긴 창에도 계속 맞춰 준다.
import { chromeArgs } from '../chrome/launcher.js';
import { findChrome } from '../chrome/finder.js';
import { readRegistry } from '../registry/store.js';
import { portOf } from '../slots.js';
import { pidAlive } from '../util.js';
import { ensureIconFile, ICON_VERSION } from './icon.js';
import { win32 } from './win32.js';

const INTERVAL_MS = 2000;

/**
 * 작업표시줄 앱 ID. 작업표시줄은 이미 있는 버튼의 아이콘 속성이 바뀌어도 다시 그리지 않고,
 * 앱 ID가 바뀌어 버튼이 새로 만들어질 때만 아이콘을 읽는다 → 디자인 버전을 ID에 넣어 바뀌면 새로 그리게 한다.
 */
export const appIdOf = (slot: number) => `cdpm.slot.${slot}.v${ICON_VERSION}`;

/** 창마다 이 프로세스가 지정한 아이콘 경로 */
const appliedIcon = new Map<string, string>();

/** 한 슬롯의 창들에 적용. 이미 같은 ID면 속성은 건너뛰고 창 아이콘만 다시 지정한다. */
export function applyTaskbar(slot: number, pid: number | undefined): number {
  const w = win32();
  if (!w || !pid) return 0;
  const iconPath = ensureIconFile(slot);
  const appId = appIdOf(slot);
  let applied = 0;
  for (const hwnd of w.chromeWindowsOf(pid)) {
    const key = w.windowKey(hwnd);
    // 앱 ID가 다르거나, 이 프로세스가 이 창에 지금 아이콘 경로를 아직 지정하지 않았으면 다시 지정한다 (디자인 변경 반영)
    if (w.getAppId(hwnd) !== appId || appliedIcon.get(key) !== iconPath) {
      // 닫힌 창의 기록은 지워지지 않으므로 많아지면 비운다 (다음에 한 번 다시 지정할 뿐)
      if (appliedIcon.size > 500) appliedIcon.clear();
      appliedIcon.set(key, iconPath);
      const command = [`"${findChrome()}"`, ...chromeArgs(slot).map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ');
      w.setAppProps(hwnd, {
        appId,
        relaunchCommand: command,
        displayName: `Chrome ${slot}번 (${portOf(slot)})`,
        iconPath,
      });
      applied++;
    }
    w.setWindowIcon(hwnd, iconPath);
  }
  return applied;
}

let timer: NodeJS.Timeout | undefined;

/** 기록부 번호를 실제 Chrome 본체 번호로 확인·수정하는 함수 (service.verifySlotPid). 확인한 번호, 못 하면 undefined */
export type PidVerifier = (slot: number) => Promise<number | undefined>;

/** 이 프로세스가 Chrome에게 물어 맞다고 확인한 슬롯 번호 → Chrome 번호 */
const verified = new Map<number, number>();
/** 슬롯마다 마지막 확인 시각 (자주 묻지 않게) */
const lastCheck = new Map<number, number>();
const RECHECK_MS = 10_000;

/**
 * 2초마다 슬롯 창들에 아이콘을 맞춘다. 기록부의 번호는 재부팅 뒤 옛 번호로 남거나 다른 프로그램이 같은 번호를
 * 받았을 수 있으므로, 이 프로세스에서 확인한 번호일 때만 적용한다. 확인 안 된 번호(처음 보거나 바뀌었거나 죽음)면
 * Chrome에게 물어 고친 뒤(슬롯마다 10초에 한 번까지) 다음 주기부터 적용한다.
 */
export function startTaskbarWatcher(verify?: PidVerifier) {
  if (timer || !win32()) return;
  const checking = new Set<number>();
  const check = (slot: number) => {
    if (!verify || checking.has(slot) || Date.now() - (lastCheck.get(slot) ?? 0) < RECHECK_MS) return;
    checking.add(slot);
    lastCheck.set(slot, Date.now());
    verify(slot)
      .then((pid) => (pid ? verified.set(slot, pid) : verified.delete(slot)))
      .catch(() => undefined)
      .finally(() => checking.delete(slot));
  };
  timer = setInterval(() => {
    try {
      const reg = readRegistry();
      for (const [key, rec] of Object.entries(reg.slots)) {
        const slot = Number(key);
        if (verify && (!rec.pid || verified.get(slot) !== rec.pid || !pidAlive(rec.pid))) {
          check(slot);
          continue;
        }
        applyTaskbar(slot, rec.pid);
      }
    } catch {
      // 다음 주기에 다시 시도
    }
  }, INTERVAL_MS);
  timer.unref();
}

/** 시험용: 확인 기록을 비운다 */
export function resetPidVerification() {
  verified.clear();
  lastCheck.clear();
}

export function stopTaskbarWatcher() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
