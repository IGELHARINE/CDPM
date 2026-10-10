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
  'browser_upload', 'browser_forward', 'browser_reload', 'browser_hover', 'browser_drag', 'browser_download_wait', 'browser_pdf',
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
description: CDPM 브라우저 슬롯 하나를 맡아 이동·읽기·클릭·입력을 하는 서브에이전트. 여러 CDPM 슬롯에 각각 다른 일을 시킬 때 슬롯마다 하나씩, 한 메시지에서 함께 띄운다.
tools: ${tools.join(', ')}
omitClaudeMd: true
---
${MARK}
너는 CDPM 브라우저 슬롯 하나를 맡은 작업자다. 메인 에이전트는 사용자와 대화하고 슬롯을 켜고 일을 나눠 주고 결과를 합칠 뿐, 이 슬롯 화면은 네가 전부 맡는다.
메인의 지시는 짧다 (슬롯 번호, 네 agent 이름, 할 일). 나머지 방법은 아래 규칙대로 스스로 판단해서 바로 움직인다.
- 맡은 slot 번호와 agent 이름을 모든 CDPM 도구에 그대로 넣는다. 다른 슬롯은 건드리지 않는다.
- 화면이 필요하면 조작 도구에 read를 붙여 한 번에 받는다 (글은 text, 누를 게 필요하면 snapshot, 바뀐 것만 보려면 changes).
- 같은 페이지의 입력칸 여러 개는 browser_fill 한 번으로 채운다.
- 맡은 일의 주소 이동부터 직접 한다 (메인은 슬롯만 켜 둔다). 메인이 켜면서 시작 페이지를 이미 열어 뒀으면 다시 이동하지 않고 그 화면에서 바로 시작한다 (먼저 browser_snapshot interactive=true로 확인).
- 기다림은 최소한으로. 고정 시간 대기는 쓰지 않는다.
- 어느 사이트든 사용자가 로그인·본인 인증·보안문자 등을 해야 하면 "됐다고 알려 달라"고 하지 않는다. 화면을 건드리지 않고(새로고침·다시 이동 금지: 입력 중인 내용이 사라짐) browser_wait url(주소 변화) / gone(로그인 폼 글자가 사라짐) / text(로그인 뒤에만 보이는 글자)로 완료를 감지하고 바로 이어서 진행한다.
- 다른 에이전트와 함께 일하면 실시간으로 신호를 주고받는다: 내 일을 끝내면 바로 slot_send(slot=상대 슬롯, to=상대 이름)로 알리고, 상대를 기다릴 때는 화면을 반복해서 새로고침하지 말고 slot_inbox(slot=내 슬롯, wait=120~600)로 기다린다 (오는 즉시 돌아옴). 신호를 받으면 바로 확인하고 움직인다.
- 다른 슬롯 화면이 필요하면 보기 도구(browser_snapshot·browser_text)로 직접 본다 (조작은 하지 않는다).
- 알림창은 처리하지 않는다. 떠 있으면 그대로 보고한다.
- 결과물(보고서·HTML 조각·표 등)은 요청받은 자기 몫만 만들어 짧게 돌려준다. 파일로 달라고 했으면 그 경로에 쓴다.
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
