// 사용자 전역 지시 파일(~/.claude/CLAUDE.md)에 CDPM 병렬 처리 규칙을 넣는다.
// Claude는 MCP 지침보다 사용자 지시를 훨씬 잘 따르므로, "여러 슬롯 = 서브에이전트" 규칙은 여기에 두는 게 가장 확실하다.
// 표시 줄 사이만 바꾸므로 여러 번 실행해도 한 번만 들어간다. 처음 바꿀 때 원래 파일은 백업한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const START = '<!-- CDPM:START (cdpm setup이 관리하는 부분) -->';
const END = '<!-- CDPM:END -->';

export const CDPM_RULES = `${START}
## CDPM (Chrome slot MCP) rules

- Reply to the user in the user's language.
- When telling the user about slot work, always name the tab too, not just the slot: e.g. "working in slot 1, tab 3 [t7]".
- Roles (always, for any job using multiple slots or tabs, on any site):
  - Main: talks to the user, launches/closes slots, hands work to subagents, merges and reports results. Never navigates, reads or acts on slot screens itself.
  - Subagent (cdpm-browser): everything on its one slot: navigation, reading, typing, clicking, detecting login completion, its own part of the output, and signaling other subagents when needed.
  - A simple job on a single slot can be done by the main agent directly.
- Windowed (visible) vs headless is the user's call: headless: true only if the user says "headless", "hidden", "no window"; false for "show the window", "headful" (in any language). If unspecified, don't guess; ask first (once for multiple slots).
- When several CDPM slots get different jobs (e.g. "open 5, one for Naver, one for YouTube...", "log in on slot 1 and open another site on slot 2"), the main agent does not do them itself.
  1. Launch all slots with one browser_launch (slots or count). If start pages are known, open them at launch with url/urls. The main agent stops there; subagents do all navigation, reading and actions from the start.
  2. In one message, call the Agent tool once per slot to start all subagents together, each with run_in_background: true (don't wait for one to finish). Use subagent_type "cdpm-browser" (CDPM-only, starts fast).
     - Keep instructions to 1-3 lines: slot number, agent name (e.g. "naver"), task. cdpm-browser already knows CDPM usage and rules; don't repeat them (long instructions only add delay).
     - At most 20 subagents run at once. With more than 20 slots, start 20 first and the rest as they finish (raise via env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).
  3. Each subagent writes and returns its own part of the output (report, HTML fragment, table, etc.); the main agent only merges.
- If tabs within one slot get different jobs (e.g. "slot 1 first tab logs in, second tab does X on another site"), assign one subagent per tab just like slots (the main agent doesn't switch tabs doing them in turn). Each uses only its assigned tab number or opens its own with browser_tab_new, with a distinct agent name per tab (e.g. "slot1-tab1"). Same slot, so the one-agent-one-slot rule doesn't apply; actions queue per tab and run concurrently. If a tab's job depends on another finishing first (e.g. needs login), the dependent owner waits with slot_inbox(wait) and the other notifies with slot_send as soon as done (login carries over to other tabs since they share the profile).
- One agent acts on one slot only (CDPM rejects actions on another slot; viewing other slots is fine).
- When the user must log in, verify identity, solve a CAPTCHA, etc. on any site, never ask them to say when done. Start the subagents first and have each detect completion with browser_wait url/gone/text without touching the screen (no reload), then continue.
- Waits that may take minutes (bulk collection/processing, waiting for user login, etc.) are not done by the main agent: hand them to a background subagent (run_in_background: true), tell the user the current status right away and keep talking. While the main agent blocks on browser_wait or a long foreground shell command, it can't answer the user.
- Keep waiting minimal. When subagents collaborate (e.g. exchanging emails), each notifies the other with slot_send as soon as its part is done and waits with slot_inbox wait (no repeated screen refreshes). Never instruct subagents to use long fixed waits.
- When you need the screen, add read to the action tool to get it in one call (text for content, snapshot when you need things to click, changes to see only what changed).
${END}`;

export function claudeMdPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'CLAUDE.md');
}

/** CLAUDE.md에 CDPM 규칙 블록이 들어 있는지. */
export function hasCdpmRules(file = claudeMdPath()): boolean {
  try {
    const current = fs.readFileSync(file, 'utf8');
    return current.includes(START) && current.includes(END);
  } catch {
    return false;
  }
}

export function setupClaudeMd(file = claudeMdPath()): string {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const a = current.indexOf(START), b = current.indexOf(END);
  let next: string;
  if (a >= 0 && b > a) next = current.slice(0, a) + CDPM_RULES + current.slice(b + END.length);
  else next = current + (current && !current.endsWith('\n') ? '\n' : '') + (current ? '\n' : '') + CDPM_RULES + '\n';
  if (next === current) return `CLAUDE.md에 CDPM 규칙이 이미 최신으로 들어 있어요 (${file}).`;
  if (current && !fs.existsSync(`${file}.before-cdpm`)) fs.copyFileSync(file, `${file}.before-cdpm`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return `CLAUDE.md에 CDPM 병렬 처리 규칙을 ${a >= 0 ? '최신으로 바꿨어요' : '넣었어요'} (${file}).` + (current ? ` 원래 파일은 ${file}.before-cdpm에 백업했어요.` : '') + ' 새 세션부터 적용돼요.';
}

/** CLAUDE.md에서 CDPM 규칙 부분을 뺀다. */
export function removeClaudeMd(file = claudeMdPath()): string {
  if (!fs.existsSync(file)) return 'CLAUDE.md가 없어요.';
  const current = fs.readFileSync(file, 'utf8');
  const a = current.indexOf(START), b = current.indexOf(END);
  if (a < 0 || b < a) return 'CLAUDE.md에 CDPM 규칙이 없어요.';
  fs.writeFileSync(file, (current.slice(0, a) + current.slice(b + END.length)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n');
  return `CLAUDE.md에서 CDPM 규칙을 뺐어요 (${file}).`;
}
