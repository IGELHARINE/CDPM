// 설치하면 따로 설정하지 않아도 되도록, MCP 서버가 처음 켜질 때 상태줄, CLAUDE.md 규칙, 전용 서브에이전트, 권한 허용 목록을 넣는다.
// 자동 설정 내용이 바뀐 버전으로 업데이트하면 한 번 더 도는데, 이때 항목마다 따로 판단한다:
// - 처음 보는 항목은 넣는다.
// - 전에 넣었고 아직 있으면 새 내용으로 갱신한다.
// - 전에 넣었는데 없어졌으면 사용자가 지운 것(cdpm unsetup 포함)으로 보고 다시 넣지 않는다.
// 다시 넣으려면 cdpm setup. 끄기: 환경변수 CDPM_NO_AUTO_SETUP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentPath, registeredNames, setupAgent, setupPermissions } from './agent-setup.js';
import { claudeMdPath, hasCdpmRules, setupClaudeMd } from './claude-md-setup.js';
import { cdpmHome } from './paths.js';
import { isStatuslineConfigured, setupStatusline } from './statusline-setup.js';

/** 자동 설정 내용이 바뀌면 올린다 (그때 한 번 더 적용). */
export const AUTO_SETUP_VERSION = 15; // 2: cdpm-browser 서브에이전트, 3: 권한 허용 목록, 4: 실시간 협업 규칙, 5: 메인은 켜기만·로그인 자동 감지, 6: 역할 구분, 7: 백그라운드로 한꺼번에·짧은 지시, 8: 켜면서 시작 주소 열기, 9: 서브에이전트 도구 추가(업로드·마우스 올리기 등), 10: 알림창 처리(browser_dialog), 11: 알림창은 웬만하면 직접 처리, 12: browser_wait enabled·response, 13: 멈춤·다시 시작, 14: 헤드리스는 말했을 때만·긴 기다림은 백그라운드·슬롯별 다른 일 예시·한 슬롯 안 탭마다 다른 일도 서브에이전트, 15: 슬롯과 탭을 함께 말하기·권한 말풍선 처리(browser_permission)

export interface SetupItem {
  name: string;
  /** 지금 설정이 들어 있는지 */
  present: () => boolean;
  /** 넣거나 새 내용으로 갱신한다. 결과 안내 한 줄 */
  apply: () => string;
}

export interface SetupState {
  version: number;
  /** CDPM이 한 번이라도 넣은 항목 */
  applied: Record<string, boolean>;
}

export function setupItems(): SetupItem[] {
  return [
    { name: 'statusline', present: () => isStatuslineConfigured(), apply: () => setupStatusline().message },
    { name: 'claudeMd', present: () => hasCdpmRules(claudeMdPath()), apply: () => setupClaudeMd() },
    { name: 'agent', present: () => fs.existsSync(agentPath()), apply: () => setupAgent() },
    { name: 'permissions', present: () => hasPermissions(), apply: () => setupPermissions() },
  ];
}

function hasPermissions(): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const allow: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).permissions?.allow;
    return Array.isArray(allow) && registeredNames().every((n) => allow.includes(`mcp__${n}`));
  } catch {
    return false;
  }
}

export const stateFile = () => path.join(cdpmHome(), 'auto-setup.json');

/** 저장된 상태. 없으면: 예전 버전의 표시 파일(auto-setup-vN.done)이 있으면 그때 전부 넣은 것으로 본다. */
export function readState(file = stateFile()): SetupState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof s.version === 'number' && s.applied && typeof s.applied === 'object') return s;
  } catch {
    // 없거나 깨짐
  }
  let old = false;
  try {
    old = fs.readdirSync(path.dirname(file)).some((n) => /^auto-setup-v\d+\.done$/.test(n));
  } catch {
    // 폴더 없음
  }
  return old
    ? { version: 0, applied: { statusline: true, claudeMd: true, agent: true, permissions: true } }
    : { version: 0, applied: {} };
}

function writeState(state: SetupState, file = stateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  } catch {
    // 못 쓰면 다음에 다시 (설정은 여러 번 해도 같음)
  }
}

/** 항목마다 판단해서 적용한다 (시험하기 쉽게 항목·상태 파일·버전을 받는다). */
export function runAutoSetup(items: SetupItem[], file = stateFile(), version = AUTO_SETUP_VERSION): string[] {
  const state = readState(file);
  if (state.version >= version) return [];
  const out: string[] = [];
  let failed = false;
  for (const item of items) {
    try {
      // 전에 넣었는데 지금 없으면 사용자가 지운 것 → 되살리지 않는다
      if (state.applied[item.name] && !item.present()) continue;
      out.push(item.apply());
      if (item.present()) state.applied[item.name] = true;
      else failed = true; // 넣으려 했는데 안 들어감 (설정 파일 형식 오류 등) → 다음에 다시
    } catch {
      failed = true; // 이 항목은 다음에 켜질 때 다시
    }
  }
  // 실패한 항목이 있으면 이 버전을 끝난 것으로 적지 않는다 (들어간 항목 기록은 남겨서, 그 뒤 지우면 되살리지 않음)
  if (!failed) state.version = version;
  writeState(state, file);
  return out;
}

export function autoSetupOnce(): string[] {
  if (process.env.CDPM_NO_AUTO_SETUP === '1' || process.env.CDPM_TEST_PORT_BASE) return [];
  return runAutoSetup(setupItems());
}

/** cdpm setup·install: 사용자가 직접 실행했으므로 지웠던 항목도 모두 다시 넣는다. */
export function setupAll(): string[] {
  const state = readState();
  const out: string[] = [];
  for (const item of setupItems()) {
    try {
      out.push(item.apply());
      if (item.present()) state.applied[item.name] = true;
    } catch (e) {
      out.push(`${item.name} 설정 실패: ${(e as Error).message}`);
    }
  }
  state.version = AUTO_SETUP_VERSION;
  writeState(state);
  return out;
}
