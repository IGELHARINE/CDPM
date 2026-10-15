// CDPM 전용 서브에이전트(cdpm-browser)를 사용자 Claude 설정(~/.claude/agents)에 설치한다.
// CDPM 도구와 파일 쓰기만 갖고 CLAUDE.md를 읽지 않아서, 일반 서브에이전트보다 빨리 시작하고 사용량이 적다
// (실측: 슬롯 3개 병렬 작업 중간값 28.7초 → 20.6초, 사용량 약 37% 감소). 모델·노력 수준은 메인과 같다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '<!-- cdpm:agent (cdpm setup이 관리하는 파일) -->';

/** 서브에이전트가 쓸 CDPM 도구 (켜기·끄기·상태줄 설정은 메인이 한다). */
const AGENT_TOOLS = [
  'browser_navigate', 'browser_back', 'browser_text', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_fill', 'browser_select', 'browser_press_key', 'browser_scroll', 'browser_wait', 'browser_tabs', 'browser_tab_new',
  'browser_tab_close', 'browser_eval', 'browser_network', 'browser_network_detail', 'browser_block', 'slot_send', 'slot_inbox',
  'browser_upload', 'browser_forward', 'browser_reload', 'browser_hover', 'browser_drag', 'browser_download_wait', 'browser_pdf', 'browser_dialog', 'browser_permission',
];

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function agentPath(): string {
  return path.join(claudeDir(), 'agents', 'cdpm-browser.md');
}

/** Claude 설정(~/.claude.json)에서 CDPM이 어떤 이름으로 등록됐는지 찾는다. 못 찾으면 'cdpm'. */
export function registeredNames(configFile = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json')): string[] {
  const names = new Set<string>();
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const scan = (servers: Record<string, any> | undefined) => {
      for (const [name, s] of Object.entries(servers ?? {})) {
        const cmd = [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].join(' ');
        if (/cdpm/i.test(cmd) || /cdp[_-]?mcp/i.test(cmd) || /cdpm/i.test(name)) names.add(name);
      }
    };
    scan(cfg.mcpServers);
    for (const p of Object.values<any>(cfg.projects ?? {})) scan(p?.mcpServers);
  } catch {
    // 설정을 못 읽으면 기본 이름
  }
  return names.size ? [...names] : ['cdpm'];
}

export function agentFile(names: string[]): string {
  const tools = [...names.flatMap((n) => AGENT_TOOLS.map((t) => `mcp__${n}__${t}`)), 'Write'];
  return `---
name: cdpm-browser
description: Subagent that owns one CDPM browser slot and navigates, reads, clicks and types in it. When several CDPM slots get different jobs, start one per slot, all in a single message.
tools: ${tools.join(', ')}
omitClaudeMd: true
---
${MARK}
You own one CDPM browser slot. The main agent talks to the user, launches slots, hands out work and merges results; everything on this slot's screen is yours.
Instructions from the main agent are short (slot number, your agent name, the task). Work out the rest from these rules and act right away.
- Report back in the language the main agent/user uses. In the report, name the slot and the tab you worked in (e.g. "slot 1, tab 3 [t7]"), not just the slot.
- Pass your slot number and agent name to every CDPM tool. Never touch other slots.
- If assigned a specific tab, pass that tab to every tool and leave other tabs alone. If told to use a new tab, open one with browser_tab_new and use its ID. If your work depends on another tab's owner finishing first, wait for their signal with slot_inbox(wait); when your own work is done, notify whoever is waiting with slot_send immediately.
- When you need the screen, add read to the action tool to get it in one call (text for content, snapshot when you need things to click, changes to see only what changed).
- Fill multiple fields on the same page with a single browser_fill.
- Do your own navigation (the main agent only launches the slot). If the start page is already open from launch, start there without navigating again (check first with browser_snapshot interactive=true).
- Keep waiting to a minimum; never use fixed-time sleeps. For jobs that take minutes (e.g. bulk collection), check progress briefly now and then and return results as soon as it finishes. To wait for a button to enable, use browser_wait enabled. For pages that load data in the background (search results, lists), click and then use browser_wait response (URL fragment) to get the response JSON directly instead of reading the screen.
- When the user must log in, verify identity, solve a CAPTCHA, etc. on any site, never ask them to tell you when done. Leave the screen alone (no reload or re-navigation: it wipes their input) and detect completion with browser_wait url (URL change) / gone (login form text disappears) / text (text shown only after login), then continue.
- When working with other agents, signal in real time: as soon as your part is done, notify them with slot_send(slot=their slot, to=their name); when waiting on them, don't keep refreshing the screen, use slot_inbox(slot=your slot, wait=120-600) (returns as soon as a message arrives). Act on signals immediately.
- If the user pauses the slot, actions are rejected with a pause notice. Then stop acting and wait with slot_inbox(slot=your slot, wait=600); on the resume message, re-read the screen with browser_snapshot and continue. Never resume on your own.
- To see another slot's screen, use read-only tools (browser_snapshot, browser_text) on it directly (no actions).
- When a dialog appears, normally read it and accept/dismiss it yourself with browser_dialog. Only if it confirms something irreversible outside your task (payment, deletion, etc.), leave it and report to the main agent.
- If the header warns about a Chrome permission bubble (browser UI, not in snapshots), the page may be waiting on it: answer it with browser_permission when your task needs it (e.g. a work site reaching a local app). Don't allow camera, microphone or location the user didn't ask for; report to the main agent instead.
- Return only your own requested part of the output (report, HTML fragment, table, etc.), briefly. If asked for a file, write it to that path.
`;
}

/** 설치(또는 최신으로 갱신). 사용자가 직접 만든 같은 이름의 파일은 건드리지 않는다. */
export function setupAgent(file = agentPath(), names = registeredNames()): string {
  const next = agentFile(names);
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (!current.includes(MARK)) return `${file}이(가) 이미 있는데 CDPM이 만든 파일이 아니라서 건드리지 않았어요.`;
    if (current === next) return `CDPM 전용 서브에이전트(cdpm-browser)가 이미 최신이에요.`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return `CDPM 전용 서브에이전트(cdpm-browser)를 설치했어요 (${file}, 등록 이름: ${names.join(', ')}). 새 세션부터 쓸 수 있어요.`;
}

export function removeAgent(file = agentPath()): string {
  if (!fs.existsSync(file)) return 'cdpm-browser 서브에이전트가 없어요.';
  if (!fs.readFileSync(file, 'utf8').includes(MARK)) return `${file}은(는) CDPM이 만든 파일이 아니라서 지우지 않았어요.`;
  fs.rmSync(file);
  return `cdpm-browser 서브에이전트를 지웠어요 (${file}).`;
}

/**
 * Claude Code 권한 허용 목록(settings.json의 permissions.allow)에 CDPM 도구 전체(mcp__<등록 이름>)를 넣는다.
 * 자동 모드의 보안 검사가 입력(browser_type·browser_fill 등)을 막아 작업이 멈추지 않게 하기 위해서다.
 */
export function setupPermissions(settingsFile = path.join(claudeDir(), 'settings.json'), names = registeredNames()): string {
  let cfg: any = {};
  if (fs.existsSync(settingsFile)) {
    try {
      cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      return `${settingsFile}을(를) 읽지 못해서(JSON 형식 오류) 권한은 넣지 않았어요.`;
    }
  }
  const allow: string[] = Array.isArray(cfg.permissions?.allow) ? cfg.permissions.allow : [];
  const want = names.map((n) => `mcp__${n}`);
  const missing = want.filter((w) => !allow.includes(w));
  if (!missing.length) return `CDPM 도구는 이미 권한 허용 목록에 있어요 (${want.join(', ')}).`;
  if (fs.existsSync(settingsFile) && !fs.existsSync(`${settingsFile}.before-cdpm`)) fs.copyFileSync(settingsFile, `${settingsFile}.before-cdpm`);
  cfg.permissions = { ...(cfg.permissions ?? {}), allow: [...allow, ...missing] };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tmp = `${settingsFile}.cdpm-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, settingsFile);
  return `CDPM 도구를 권한 허용 목록에 넣었어요 (${missing.join(', ')}). 입력·클릭이 매번 막히지 않아요. 새 세션부터 적용돼요.`;
}

export function removePermissions(settingsFile = path.join(claudeDir(), 'settings.json'), names = registeredNames()): string {
  if (!fs.existsSync(settingsFile)) return '권한 설정 파일이 없어요.';
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return `${settingsFile}을(를) 읽지 못했어요.`;
  }
  const want = new Set(names.map((n) => `mcp__${n}`));
  const allow: string[] = Array.isArray(cfg.permissions?.allow) ? cfg.permissions.allow : [];
  const next = allow.filter((a) => !want.has(a));
  if (next.length === allow.length) return '권한 허용 목록에 CDPM이 없어요.';
  cfg.permissions.allow = next;
  fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2) + '\n');
  return `권한 허용 목록에서 CDPM을 뺐어요 (${[...want].join(', ')}).`;
}
