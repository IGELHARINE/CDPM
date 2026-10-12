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
  const titles = tabs.map((t) => truncate(t.title || '(untitled)', 34));
  const urls = tabs.map((t) => shortUrl(t.url, 34));
  const tw = Math.max(0, ...titles.map(displayWidth));
  const uw = Math.max(0, ...urls.map(displayWidth));
  const lines: string[] = [];
  tabs.forEach((t, i) => {
    const mark = t.targetId === markTargetId ? '>' : ' ';
    const last = t.rec.last ? `  last: ${t.rec.last.agent} ${t.rec.last.action} (${ago(t.rec.last.at)})` : '';
    const active = t.active ? ' ·front' : '';
    lines.push(`${mark} ${t.no}. [${t.id}]${active} ${padEnd(titles[i], tw)}  ${padEnd(urls[i], uw)}  opened by: ${t.rec.openedBy}${last}`);
    if (withSummary && t.rec.summary) {
      lines.push(`       summary: ${t.rec.summary.agent} — ${t.rec.summary.text} (${ago(t.rec.summary.at)})`);
    }
  });
  return lines;
}

export function formatHeader(h: HeaderInput): string {
  const exec = h.tabs.find((t) => t.targetId === h.executedTargetId);
  const lines = [`[Slot ${h.slot}] ${h.tabs.length} tab(s)${exec ? ` · ran on tab ${exec.no} [${exec.id}]` : ''}`];
  lines.push(...tabLines(h.tabs, h.executedTargetId));
  for (const t of h.tabs) {
    const d = h.dialogs?.get(t.targetId);
    if (d) lines.push(`[warning] dialog open (${d.type}) on tab ${t.no} [${t.id}]: "${truncate(d.message, 80)}" — read it and handle it yourself with browser_dialog (ask the user only for confirmations of unrequested payment/deletion etc.)`);
  }
  for (const w of h.warnings ?? []) lines.push(`[warning] ${w}`);
  if (h.messages?.length) {
    lines.push(`${h.messages.length} new message(s) (marked read here; won't appear again in slot_inbox)`);
    lines.push(...formatMessages(h.messages).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}

export function formatMessages(msgs: Message[]): string[] {
  return msgs.map((m) => `${m.from}${m.to ? ` → ${m.to}` : ''} (${ago(m.at)}): ${m.text}`);
}

export function formatSlotStatus(slot: number, rec: SlotRecord, tabs: TabView[] | null): string {
  const mode = rec.headless ? ' · headless' : '';
  const lines = [`[Slot ${slot}] port ${portOf(slot)}${mode} · ${tabs ? `${tabs.length}` : '?'} tab(s) · launched by: ${rec.launchedBy ?? '(external)'} (${ago(rec.launchedAt)})`];
  if (rec.summary) lines.push(`  summary: ${rec.summary.agent} — ${rec.summary.text} (${ago(rec.summary.at)})`);
  if (tabs) lines.push(...tabLines(tabs, undefined, true).map((l) => `  ${l}`));
  return lines.join('\n');
}
