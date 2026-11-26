// 슬롯 Chrome의 다운로드 진행을 지켜본다 (탭마다 오는 Page.downloadWillBegin / Page.downloadProgress).
//
// Browser.setDownloadBehavior(eventsEnabled)는 쓰지 않는다. 한 번이라도 부르면 Chrome이 다운로드 관리자를 DevTools용으로
// 바꿔 끼우고 Chrome을 끌 때까지 되돌리지 않는데, 그 관리자는 "폴더 열기"·"파일 열기"를 원래 관리자에게 넘기지 않는다
// → 사용자가 다운로드 목록에서 "폴더 열기"를 눌러도 아무 일도 일어나지 않는다 (behavior: 'default'여도 같다).
// 탭 이벤트에는 저장 경로가 없으므로, 끝난 뒤 다운로드 폴더에서 그 파일을 찾아 경로를 알려 준다.
// CDPM이 아직 붙지 않은 탭(클릭이 새 탭을 열고 그 탭이 곧바로 다운로드로 바뀐 경우)의 다운로드는 시작 신호를 못 받는다.
// 그때는 다운로드 폴더의 받는 중 파일(.crdownload)을 보고 끝나기를 기다린다.
// (브라우저 연결로 새 탭에 자동으로 붙는 방법은 쓰지 않는다: 페이지가 연 새 탭이 멈춘다.)
import fs from 'node:fs';
import { readRegistry } from '../registry/store.js';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../paths.js';

export interface Download {
  guid: string;
  url: string;
  file: string;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  totalBytes: number;
  filePath?: string;
  at: number;
  reported?: boolean;
}

const bySlot = new Map<number, Map<string, Download>>();

function listOf(slot: number): Map<string, Download> {
  let list = bySlot.get(slot);
  if (!list) bySlot.set(slot, (list = new Map()));
  return list;
}

/** 탭이 알려 온 다운로드 시작. 같은 다운로드를 여러 연결이 알려 와도 한 번만 적는다. */
export function noteDownloadBegin(slot: number, p: { guid: string; url: string; suggestedFilename: string }) {
  const list = listOf(slot);
  if (list.has(p.guid)) return;
  list.set(p.guid, { guid: p.guid, url: p.url, file: p.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0, at: Date.now() });
  // 오래된 기록은 정리 (최근 50개만)
  if (list.size > 50) list.delete(list.keys().next().value!);
}

/** 탭이 알려 온 다운로드 진행. */
export function noteDownloadProgress(slot: number, p: { guid: string; state: Download['state']; receivedBytes: number; totalBytes: number }) {
  const d = bySlot.get(slot)?.get(p.guid);
  if (!d || d.state !== 'inProgress') return;
  d.state = p.state;
  d.receivedBytes = p.receivedBytes;
  d.totalBytes = p.totalBytes;
}

/** 이 슬롯에서 since(ms) 뒤에 다운로드가 시작됐는지. */
export function downloadStartedSince(slot: number, since: number): boolean {
  for (const d of bySlot.get(slot)?.values() ?? []) if (d.at >= since) return true;
  return false;
}

/**
 * 슬롯 Chrome이 파일을 저장하는 폴더. 사용자가 Chrome 설정에서 바꿨으면 그 폴더, 아니면 OS의 다운로드 폴더.
 * "받을 때마다 위치 묻기"가 켜져 있으면 알 수 없다 (undefined).
 */
function downloadDir(slot: number): string | undefined {
  const fallback = path.join(os.homedir(), 'Downloads');
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(paths.profile(slot, readRegistry().slots[String(slot)]?.browser), 'Default', 'Preferences'), 'utf8')) as { download?: { default_directory?: string; prompt_for_download?: boolean } };
    if (prefs.download?.prompt_for_download) return undefined;
    return prefs.download?.default_directory || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 다 받은 파일의 실제 경로. Chrome은 받는 동안 임시 이름(.crdownload)으로 쓰다가 끝나면 원래 이름으로 바꾸고,
 * 같은 이름이 있으면 "이름 (1).확장자"로 저장한다. 이 다운로드가 시작된 뒤에 생긴 그런 파일 중 가장 새것을 고른다.
 */
function findSaved(slot: number, d: Download): string | undefined {
  const dir = downloadDir(slot);
  if (!dir || !d.file) return undefined;
  const ext = path.extname(d.file);
  const stem = d.file.slice(0, d.file.length - ext.length);
  const want = d.state === 'completed' ? d.receivedBytes || d.totalBytes : d.totalBytes;
  let best: { file: string; at: number } | undefined;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (name !== d.file) {
      if (!name.startsWith(`${stem} (`) || !name.endsWith(`)${ext}`)) continue;
      if (!/^\d+$/.test(name.slice(stem.length + 2, name.length - ext.length - 1))) continue;
    }
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile() || st.mtimeMs < d.at - 3000) continue;
      if (want > 0 && st.size !== want) continue;
      if (!best || st.mtimeMs > best.at) best = { file: path.join(dir, name), at: st.mtimeMs };
    } catch {
      // 그 사이 지워졌으면 건너뜀
    }
  }
  return best?.file;
}

/** 다운로드 폴더에서 받는 중인 파일(.crdownload, 최근 10분 안에 쓰인 것)이 있는지. */
function partialInDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => n.endsWith('.crdownload') && Date.now() - fs.statSync(path.join(dir, n)).mtimeMs < 10 * 60_000);
  } catch {
    return false;
  }
}

/** since(ms) 뒤에 다 받아진(임시 이름이 아닌) 파일 중 가장 새것. */
function newestSince(dir: string, since: number): string | undefined {
  let best: { file: string; at: number } | undefined;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.crdownload') || n.startsWith('.')) continue;
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile() && st.mtimeMs >= since && (!best || st.mtimeMs > best.at)) best = { file: path.join(dir, n), at: st.mtimeMs };
    }
  } catch {
    // 못 읽으면 없는 것으로
  }
  return best?.file;
}

/** 가장 최근 다운로드(아직 돌려주지 않은 것)가 끝날 때까지 기다린다. */
export async function waitDownload(slot: number, timeoutSec: number, stop?: () => string | undefined): Promise<string> {
  const until = Date.now() + timeoutSec * 1000;
  const dir = downloadDir(slot);
  /** 시작 신호 없이 폴더에서 발견한 받는 중 파일을 처음 본 시각 */
  let untrackedAt = 0;
  for (let round = 1; ; round++) {
    // 끝난 지 오래된(10분) 다운로드는 돌려주지 않는다. 아직 받는 중인 것은 오래 걸려도 계속 지켜본다
    const list = [...(bySlot.get(slot)?.values() ?? [])].filter((d) => !d.reported && (d.state === 'inProgress' || Date.now() - d.at < 10 * 60_000));
    const d = list.at(-1);
    // 끝났다는 신호를 놓쳤어도(탭이 닫힘·연결이 정리됨) 파일이 원래 이름으로 생겼으면 다 받은 것이다
    if (d && d.state === 'inProgress' && round % 10 === 0) {
      const saved = findSaved(slot, d);
      if (saved) {
        d.state = 'completed';
        d.filePath = saved;
        d.receivedBytes ||= fs.statSync(saved).size;
      }
    }
    if (d && d.state !== 'inProgress') {
      d.reported = true;
      if (d.state === 'canceled') return `Download canceled: ${d.file}`;
      d.filePath ??= findSaved(slot, d);
      const size = d.totalBytes || d.receivedBytes;
      const kb = size ? ` (${(size / 1024).toFixed(1)}KB)` : '';
      if (d.filePath) return `Download finished: ${d.filePath}${kb}`;
      return `Download finished: ${d.file}${kb} — saved in the browser's download folder${dir ? ` (${dir})` : ' (the user picks the location each time)'}, but the exact path could not be confirmed.`;
    }
    // 시작 신호를 못 받은 다운로드 (CDPM이 붙기 전의 새 탭에서 시작): 폴더의 받는 중 파일로 알아챈다
    if (!d && dir && round % 3 === 1) {
      if (partialInDir(dir)) untrackedAt ||= Date.now() - 1000;
      else if (untrackedAt) {
        const saved = newestSince(dir, untrackedAt);
        if (saved) return `Download finished: ${saved} (${(fs.statSync(saved).size / 1024).toFixed(1)}KB)`;
        return 'Download ended, but no new file appeared in the download folder (it may have been canceled).';
      }
    }
    const why = stop?.();
    if (why) return why;
    if (Date.now() > until) {
      if (d) return `Download not finished after ${timeoutSec}s: ${d.file} (${d.receivedBytes}/${d.totalBytes || '?'} bytes). Call again to keep waiting.`;
      if (untrackedAt) return `Download not finished after ${timeoutSec}s (still being written in ${dir}). Call again to keep waiting.`;
      throw new Error('No download in progress or recently started. Call this after clicking the download button.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
