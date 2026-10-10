export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nowIso(): string {
  return new Date().toISOString();
}

/** "방금", "12초 전", "3분 전" */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3) return '방금';
  if (s < 60) return `${s}초 전`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

export function secondsSince(iso: string | undefined, now = Date.now()): number {
  return iso ? (now - Date.parse(iso)) / 1000 : Infinity;
}

/** 표시 폭 기준으로 자르기 (한글 등 넓은 문자는 2칸). */
export function truncate(text: string, maxWidth: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > maxWidth) return out + '…';
    width += w;
    out += ch;
  }
  return out;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)
  ) return 2;
  return 1;
}

/** 주소를 "호스트/경로 앞부분"으로 줄이기. */
export function shortUrl(url: string, max = 36): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:' || u.protocol === 'chrome:' || u.protocol === 'data:') return truncate(decodeUrl(url), max);
    return truncate(decodeUrl(u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname)), max);
  } catch {
    return truncate(url, max);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new TimeoutError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class TimeoutError extends Error {}

/** 받침에 맞는 조사: josa('준비', '이', '가') → '준비가'. 한글이 아니면 '이(가)' 형태. */
export function josa(word: string, withBatchim: string, without: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return word + ((code - 0xac00) % 28 ? withBatchim : without);
  return `${word}${withBatchim}(${without})`;
}

/** 퍼센트 인코딩을 사람이 읽을 수 있게 푼다 (실패하면 그대로). */
export function decodeUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** 프로세스가 살아 있는지 (Windows 포함). */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
