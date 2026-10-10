// 슬롯 Chrome의 다운로드 진행을 지켜본다 (Browser.downloadWillBegin / downloadProgress).
// 저장 위치는 사용자의 Chrome 설정 그대로 둔다 (behavior: 'default'). 끝나면 저장된 파일 경로를 알 수 있다.
import { browserConnection } from './sessions.js';

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
const tracking = new Map<number, unknown>();

/** 이 슬롯의 다운로드 이벤트를 받기 시작한다 (한 번만). 실패해도 조용히 넘어간다. */
export async function ensureDownloadTracking(slot: number): Promise<void> {
  try {
    const conn = await browserConnection(slot);
    if (tracking.get(slot) === conn) return;
    tracking.set(slot, conn);
    const list = bySlot.get(slot) ?? new Map<string, Download>();
    bySlot.set(slot, list);
    conn.on('Browser.downloadWillBegin', (p) => {
      list.set(p.guid, { guid: p.guid, url: p.url, file: p.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0, at: Date.now() });
      // 오래된 기록은 정리 (최근 50개만)
      if (list.size > 50) list.delete(list.keys().next().value!);
    });
    conn.on('Browser.downloadProgress', (p) => {
      const d = list.get(p.guid);
      if (!d) return;
      d.state = p.state;
      d.receivedBytes = p.receivedBytes;
      d.totalBytes = p.totalBytes;
      if (p.filePath) d.filePath = p.filePath;
    });
    conn.onClosed(() => tracking.delete(slot));
    await conn.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }, 5000);
  } catch {
    tracking.delete(slot);
  }
}

/** 이 슬롯에서 since(ms) 뒤에 다운로드가 시작됐는지 (창 모드 Chrome은 탭이 아니라 브라우저 쪽으로만 알려 줄 때가 있다). */
export function downloadStartedSince(slot: number, since: number): boolean {
  for (const d of bySlot.get(slot)?.values() ?? []) if (d.at >= since) return true;
  return false;
}

/** 가장 최근 다운로드(아직 돌려주지 않은 것)가 끝날 때까지 기다린다. */
export async function waitDownload(slot: number, timeoutSec: number, stop?: () => string | undefined): Promise<string> {
  await ensureDownloadTracking(slot);
  const until = Date.now() + timeoutSec * 1000;
  for (;;) {
    const list = [...(bySlot.get(slot)?.values() ?? [])].filter((d) => !d.reported && Date.now() - d.at < 10 * 60_000);
    const d = list.at(-1);
    if (d && d.state !== 'inProgress') {
      d.reported = true;
      if (d.state === 'canceled') return `다운로드가 취소됐어요: ${d.file}`;
      const size = d.totalBytes || d.receivedBytes;
      return `다운로드가 끝났어요: ${d.filePath ?? d.file}${size ? ` (${(size / 1024).toFixed(1)}KB)` : ''}`;
    }
    const why = stop?.();
    if (why) return why;
    if (Date.now() > until) {
      if (d) return `${timeoutSec}초 안에 다운로드가 끝나지 않았어요: ${d.file} (${d.receivedBytes}/${d.totalBytes || '?'}바이트). 더 기다리려면 다시 부르세요.`;
      throw new Error('진행 중이거나 최근에 시작된 다운로드가 없어요. 다운로드 버튼을 누른 뒤에 부르세요.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
