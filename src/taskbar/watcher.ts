// 살아 있는 슬롯 Chrome 창들에 작업표시줄 아이콘을 적용하고, 새로 생긴 창에도 계속 맞춰 준다.
import { chromeArgs } from '../chrome/launcher.js';
import { findChrome } from '../chrome/finder.js';
import { readRegistry } from '../registry/store.js';
import { portOf } from '../slots.js';
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

export function startTaskbarWatcher() {
  if (timer || !win32()) return;
  timer = setInterval(() => {
    try {
      const reg = readRegistry();
      for (const [slot, rec] of Object.entries(reg.slots)) applyTaskbar(Number(slot), rec.pid);
    } catch {
      // 다음 주기에 다시 시도
    }
  }, INTERVAL_MS);
  timer.unref();
}

export function stopTaskbarWatcher() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
