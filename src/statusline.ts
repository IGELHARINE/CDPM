// Claude Code 상태줄용 한 줄. 네트워크를 쓰지 않고 기록부와 PID만 본다 (빠르게 끝나야 하므로).
import { readRegistry, type SlotRecord } from './registry/store.js';
import { colorOf, hexToRgb, isValidSlot } from './slots.js';
import { listPages } from './cdp/targets.js';
import { displayWidth, pidAlive, shortUrl, truncate } from './util.js';

const paint = (slot: number, text: string) => {
  const [r, g, b] = hexToRgb(colorOf(slot));
  return `\x1b[1;38;2;${r};${g};${b}m${text}\x1b[0m`;
};

/** 맨 앞 "CDPM" 글자: 조금 어두운 흰색, 굵게 안 함 (색을 쓸 때) */
const LABEL = (color: boolean) => (color ? '[38;2;225;225;225mCDPM[0m  ' : 'CDPM  ');

/** 폭을 모를 때 가정하는 터미널 폭 */
export const DEFAULT_WIDTH = 120;
/** 제목 길이를 이 순서로 줄여 가며 한 줄에 맞춘다 */
const TITLE_STEPS = [20, 16, 12, 8, 5];

/**
 * "CDPM  1 NAVER  2 Daum  3": 슬롯 번호(슬롯 색), 번호 순서. 슬롯마다 마지막으로 조작한 탭의 페이지 제목.
 * 터미널 폭(width)에 맞춘다: 넘치면 제목을 점점 짧게 → 모두에게 붙일 수 없으면 들어가는 만큼 앞 슬롯부터 짧은 제목
 * (남는 칸을 비워 두지 않게) → 번호만으로도 넘치면 앞에서부터 들어가는 만큼 + "+N".
 * 하나도 없으면 "CDPM  -" (CDPM은 흰색, -는 흐린 회색).
 */
export function formatStatusline(entries: [number, SlotRecord][], color = true, width = DEFAULT_WIDTH): string {
  // 켜진 슬롯이 없으면 줄이 비어 보이지 않게 흐린 회색으로 "CDPM  -"
  if (!entries.length) return color ? `${LABEL(true)}[90m-[0m` : 'CDPM  -';
  const sorted = [...entries].sort(([a], [b]) => a - b);
  const room = Math.max(20, width - 2); // 끝에 여유 2칸
  // 멈춘 슬롯은 번호를 슬롯 색 대신 흐린 회색으로 (글자는 늘리지 않아 폭이 그대로)
  const mark = (slot: number, rec?: SlotRecord) => (!color ? String(slot) : rec?.paused ? '[90m' + slot + '[0m' : paint(slot, String(slot)));
  // 폭은 색 코드를 뺀 실제 글자로 잰다
  const num = (slot: number, _rec: SlotRecord) => String(slot);
  // titles[i]: i번째 슬롯 제목 길이 (null = 번호만)
  const plain = (titles: (number | null)[]) => 'CDPM  ' + sorted.map(([slot, rec], i) => (titles[i] && rec.title ? `${num(slot, rec)} ${truncate(rec.title, titles[i]!)}` : num(slot, rec))).join('  ');
  const build = (titles: (number | null)[]) => LABEL(color) + sorted.map(([slot, rec], i) => (titles[i] && rec.title ? `${mark(slot, rec)} ${truncate(rec.title, titles[i]!)}` : mark(slot, rec))).join('  ');
  const all = (t: number | null) => sorted.map(() => t);
  for (const t of TITLE_STEPS) if (displayWidth(plain(all(t))) <= room) return build(all(t));
  if (displayWidth(plain(all(null))) <= room) {
    // 모두에게는 못 붙여도, 남는 칸만큼 앞 슬롯부터 가장 짧은 제목을 붙인다
    const titles = all(null);
    const min = TITLE_STEPS[TITLE_STEPS.length - 1];
    for (let i = 0; i < sorted.length; i++) {
      if (!sorted[i][1].title) continue;
      titles[i] = min;
      if (displayWidth(plain(titles)) > room) titles[i] = null;
    }
    return build(titles);
  }
  // 번호만으로도 넘치면 앞에서부터 들어가는 만큼만 + 나머지 개수
  const shown: string[] = [];
  let used = displayWidth('CDPM  ');
  for (let i = 0; i < sorted.length; i++) {
    const add = (shown.length ? 2 : 0) + displayWidth(num(sorted[i][0], sorted[i][1]));
    const left = sorted.length - i - 1; // 이걸 넣고 나서 남는 개수
    const tail = left ? displayWidth(`  +${left}`) : 0;
    if (used + add + tail > room) return LABEL(color) + shown.join('  ') + `  +${sorted.length - i}`;
    shown.push(mark(sorted[i][0], sorted[i][1]));
    used += add;
  }
  return LABEL(color) + shown.join('  ');
}

/**
 * 상태줄 한 줄. 기록부에 있고 프로세스가 살아 있는 슬롯 중에서, 실제로 탭(창)이 있는 슬롯만 보여준다.
 * 포트가 닫힌(Chrome이 끝난) 슬롯은 빼고, 창을 다 닫은 슬롯은 Windows·Linux에서는 빼고 macOS에서는 남긴다(Cmd+Q로만 끝남).
 * 제목은 마지막으로 조작한 탭(없으면 첫 탭)의 지금 제목, 탭이 없으면 마지막으로 기록된 제목.
 * 응답이 늦으면(0.5초) 기록대로 보여준다 (상태줄은 빨리 끝나야 하므로).
 */
/** 내용이 없는 탭: 빈 탭, Chrome 새 탭 페이지. */
export function isBlankPage(url: string): boolean {
  return !url || url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url) || url.startsWith('chrome-search://local-ntp');
}

export async function statusline(width = DEFAULT_WIDTH): Promise<string> {
  const reg = readRegistry();
  const entries = Object.entries(reg.slots)
    .map(([k, rec]) => [Number(k), rec] as [number, SlotRecord])
    .filter(([slot, rec]) => isValidSlot(slot) && pidAlive(rec.pid));
  const checked = await Promise.all(entries.map(async ([slot, rec]): Promise<[number, SlotRecord] | null> => {
    try {
      const pages = await listPages(slot, 500);
      // 창(탭)이 하나도 없음: macOS는 앱이 살아 있는 게 원래 동작이라 슬롯을 그대로 두고 마지막 탭 제목을 보여준다.
      // 다른 OS에서는 창을 다 닫은 것이므로 뺀다.
      if (!pages.length) return process.platform === 'darwin' ? [slot, rec] : null;
      // 빈 탭·새 탭(about:blank, chrome://newtab 등)은 제목으로 쓰지 않는다. 그런 탭만 남았으면 번호만.
      const real = pages.filter((p) => !isBlankPage(p.url));
      const page = real.find((p) => p.id === rec.lastTarget) ?? real[0];
      return [slot, { ...rec, title: page ? page.title || shortUrl(page.url) : undefined }];
    } catch (e) {
      return (e as Error)?.name === 'TimeoutError' ? [slot, rec] : null;
    }
  }));
  return formatStatusline(checked.filter((x): x is [number, SlotRecord] => x !== null), true, width);
}
