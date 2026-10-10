// 모든 도구 결과 앞에 붙는 머리말과 현황 표.
import type { DialogInfo } from '../cdp/sessions.js';
import type { Message } from '../registry/messages.js';
import type { SlotRecord } from '../registry/store.js';
import type { TabView } from '../service.js';
import { portOf } from '../slots.js';
import { ago, displayWidth, padEnd, shortUrl, truncate } from '../util.js';

export interface HeaderInput {
  slot: number;
  tabs: TabView[];
  executedTargetId?: string;
  warnings?: string[];
  dialogs?: Map<string, DialogInfo>;
  messages?: Message[];
}

export function tabLines(tabs: TabView[], markTargetId?: string, withSummary = false): string[] {
  const titles = tabs.map((t) => truncate(t.title || '(제목 없음)', 34));
  const urls = tabs.map((t) => shortUrl(t.url, 34));
  const tw = Math.max(0, ...titles.map(displayWidth));
  const uw = Math.max(0, ...urls.map(displayWidth));
  const lines: string[] = [];
  tabs.forEach((t, i) => {
    const mark = t.targetId === markTargetId ? '>' : ' ';
    const last = t.rec.last ? `  마지막: ${t.rec.last.agent} ${t.rec.last.action} (${ago(t.rec.last.at)})` : '';
    const active = t.active ? ' ·앞' : '';
    lines.push(`${mark} ${t.no}. [${t.id}]${active} ${padEnd(titles[i], tw)}  ${padEnd(urls[i], uw)}  연 사람: ${t.rec.openedBy}${last}`);
    if (withSummary && t.rec.summary) {
      lines.push(`       요약: ${t.rec.summary.agent} — ${t.rec.summary.text} (${ago(t.rec.summary.at)})`);
    }
  });
  return lines;
}

export function formatHeader(h: HeaderInput): string {
  const exec = h.tabs.find((t) => t.targetId === h.executedTargetId);
  const lines = [`[${h.slot}번] 탭 ${h.tabs.length}개${exec ? ` · ${exec.no}번 탭 [${exec.id}]에서 실행함` : ''}`];
  lines.push(...tabLines(h.tabs, h.executedTargetId));
  for (const t of h.tabs) {
    const d = h.dialogs?.get(t.targetId);
    if (d) lines.push(`[주의] ${d.type} 알림창 떠 있음 (${t.no}번 탭 [${t.id}]): "${truncate(d.message, 80)}" — 사용자에게 Chrome 창에서 직접 처리해 달라고 요청하세요`);
  }
  for (const w of h.warnings ?? []) lines.push(`[주의] ${w}`);
  if (h.messages?.length) {
    lines.push(`새 메시지 ${h.messages.length}개 (여기서 읽음 처리됨 — slot_inbox에는 다시 나오지 않아요)`);
    lines.push(...formatMessages(h.messages).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}

export function formatMessages(msgs: Message[]): string[] {
  return msgs.map((m) => `${m.from}${m.to ? ` → ${m.to}` : ''} (${ago(m.at)}): ${m.text}`);
}

export function formatSlotStatus(slot: number, rec: SlotRecord, tabs: TabView[] | null): string {
  const mode = rec.headless ? ' · 헤드리스' : '';
  const lines = [`[${slot}번] 포트 ${portOf(slot)}${mode} · 탭 ${tabs ? `${tabs.length}개` : '?'} · 띄운 쪽: ${rec.launchedBy ?? '(외부)'} (${ago(rec.launchedAt)})`];
  if (rec.summary) lines.push(`  요약: ${rec.summary.agent} — ${rec.summary.text} (${ago(rec.summary.at)})`);
  if (tabs) lines.push(...tabLines(tabs, undefined, true).map((l) => `  ${l}`));
  return lines.join('\n');
}
