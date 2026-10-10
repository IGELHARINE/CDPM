import { portOf } from '../slots.js';

export interface VersionInfo {
  Browser: string;
  webSocketDebuggerUrl: string;
  'Protocol-Version'?: string;
  'User-Agent'?: string;
}

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export type ProbeResult =
  | { state: 'chrome'; version: VersionInfo }
  | { state: 'free' }
  | { state: 'slow' }                       // 연결은 됐지만 제때 답하지 않음 (바쁜 Chrome일 가능성)
  | { state: 'other'; detail: string };

/** 슬롯 포트에 무엇이 있는지 확인한다. */
export async function probe(slot: number, timeoutMs = 1500): Promise<ProbeResult> {
  const url = `http://127.0.0.1:${portOf(slot)}/json/version`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') return { state: 'slow' };
    const code = (e as any)?.cause?.code;
    if (code === 'ECONNREFUSED') return { state: 'free' };
    return { state: 'other', detail: String(code ?? (e as Error).message) };
  }
  try {
    const body = (await res.json()) as VersionInfo;
    if (body && typeof body.Browser === 'string' && body.webSocketDebuggerUrl) return { state: 'chrome', version: body };
    return { state: 'other', detail: `HTTP ${res.status}` };
  } catch {
    return { state: 'other', detail: `HTTP ${res.status} (JSON 아님)` };
  }
}

/** 탭(page) 목록. Chrome이 돌려주는 순서 그대로 (첫 번째가 가장 최근 활성 탭). */
export async function listPages(slot: number, timeoutMs = 10_000): Promise<PageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${portOf(slot)}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  const all = (await res.json()) as PageTarget[];
  return all
    .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map((t) => ({ ...t, title: decodeEntities(t.title) }));
}

/** 다른 사이트 iframe(별도 프로세스) 대상들. 대상 ID는 그 iframe의 프레임 ID와 같다. */
export async function listFrameTargets(slot: number, timeoutMs = 10_000): Promise<PageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${portOf(slot)}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  return ((await res.json()) as PageTarget[]).filter((t) => t.type === 'iframe');
}

/** /json/list는 제목을 HTML 엔티티로 준다 (&lt; 등). */
function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|#39|#x27|nbsp);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' } as Record<string, string>)[e]);
}
