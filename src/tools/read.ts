// 조작 결과에 바로 화면을 붙이는 read 옵션 (text / snapshot / changes).
// 조작한 뒤 따로 읽으러 가는 호출을 없애서, 에이전트가 매 단계 실제 화면을 보고 바로 다음을 정하게 한다.
import type { PageSession } from '../cdp/sessions.js';
import * as act from '../page/actions.js';
import { paginate, takeSnapshot } from '../page/snapshot.js';

export type ReadMode = 'text' | 'snapshot' | 'changes';

const MAX_REMOVED_SHOWN = 15;

function footer(p: { page: number; pages: number }, total: number): string {
  if (p.pages <= 1) return '';
  return `\n— 1/${p.pages}쪽 (전체 ${total.toLocaleString()}자) · 이어 보기: browser_snapshot page=2`;
}

/** 스냅샷 1쪽 (browser_snapshot과 같은 모양). */
async function snapshotPage1(s: PageSession, agent: string): Promise<string> {
  const { text } = await takeSnapshot(s, agent);
  if (!text) return '(읽을 수 있는 요소가 없어요)';
  const p = paginate(text, 1);
  return p.body + footer(p, text.length);
}

/**
 * 직전 스냅샷과 비교해 새로 생긴 줄(+)과 사라진 줄(-)만. 같은 요소는 페이지가 바뀌기 전까지 같은 ref를 쓰므로 줄 단위로 비교된다.
 * 직전 스냅샷이 없거나 다른 페이지로 이동했으면 전체 1쪽을 준다.
 */
async function changes(s: PageSession, agent: string): Promise<string> {
  const prev = s.snapshotFor(agent);
  const { text, url } = await takeSnapshot(s, agent);
  const samePage = prev && prev.url.split('#')[0] === url.split('#')[0];
  if (!prev || !samePage) {
    if (!text) return '(읽을 수 있는 요소가 없어요)';
    const p = paginate(text, 1);
    return `(${prev ? '다른 페이지로 바뀌어서' : '비교할 직전 화면이 없어서'} 전체를 보여줘요)\n${p.body}${footer(p, text.length)}`;
  }
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const oldLines = prev.text.split('\n'), newLines = text.split('\n');
  const oldCount = count(oldLines), newCount = count(newLines);
  // 줄 개수까지 비교 (같은 글자의 줄이 여러 개인 목록도 정확히)
  const added: string[] = [];
  const seenNew = new Map<string, number>();
  for (const l of newLines) {
    const n = (seenNew.get(l) ?? 0) + 1;
    seenNew.set(l, n);
    if (n > (oldCount.get(l) ?? 0)) added.push(l);
  }
  const removed: string[] = [];
  const seenOld = new Map<string, number>();
  for (const l of oldLines) {
    const n = (seenOld.get(l) ?? 0) + 1;
    seenOld.set(l, n);
    if (n > (newCount.get(l) ?? 0)) removed.push(l);
  }
  if (!added.length && !removed.length) return '(화면 변화 없음)';
  const out: string[] = [`바뀐 부분 (직전 화면 대비): 새로 생김 ${added.length}줄 · 사라짐 ${removed.length}줄`];
  if (added.length) {
    const p = paginate(added.map((l) => `+ ${l.trimStart()}`).join('\n'), 1);
    out.push(p.body + (p.pages > 1 ? `\n— 새로 생긴 줄이 많아 일부만 보여줘요 (전체: browser_snapshot)` : ''));
  }
  if (removed.length) {
    out.push(...removed.slice(0, MAX_REMOVED_SHOWN).map((l) => `- ${l.trimStart()}`));
    if (removed.length > MAX_REMOVED_SHOWN) out.push(`- … 외 ${removed.length - MAX_REMOVED_SHOWN}줄`);
  }
  return out.join('\n');
}

/** 조작 결과 뒤에 붙일 화면. 알림창이 떠 있으면 읽지 않는다 (페이지가 멈춰 있음). */
export async function readAfter(s: PageSession, agent: string, mode: ReadMode): Promise<string> {
  if (s.dialog) return '';
  try {
    const body = mode === 'text' ? await act.extractText(s, agent, undefined, 1) : mode === 'snapshot' ? await snapshotPage1(s, agent) : await changes(s, agent);
    return `\n\n[화면: ${mode === 'text' ? '본문' : mode === 'snapshot' ? '스냅샷' : '바뀐 부분'}]\n${body}`;
  } catch (e) {
    return `\n\n[화면 읽기 실패: ${(e as Error).message}]`;
  }
}
