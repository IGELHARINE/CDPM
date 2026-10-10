// 설치하면 따로 설정하지 않아도 되도록, MCP 서버가 처음 켜질 때 한 번 상태줄, CLAUDE.md 규칙, 전용 서브에이전트를 넣는다.
// 한 번 한 뒤에는 표시 파일을 남겨 다시 하지 않는다 (사용자가 직접 지운 설정을 되살리지 않기 위해).
// 끄기: 환경변수 CDPM_NO_AUTO_SETUP=1. 되돌리기: cdpm unsetup.
import fs from 'node:fs';
import path from 'node:path';
import { setupAgent, setupPermissions } from './agent-setup.js';
import { setupClaudeMd } from './claude-md-setup.js';
import { cdpmHome } from './paths.js';
import { setupStatusline } from './statusline-setup.js';

/** 자동 설정 내용이 바뀌면 올린다 (그때 한 번 더 적용). */
const AUTO_SETUP_VERSION = 9; // 2: cdpm-browser 서브에이전트, 3: 권한 허용 목록, 4: 실시간 협업 규칙, 5: 메인은 켜기만·로그인 자동 감지, 6: 역할 구분, 7: 백그라운드로 한꺼번에·짧은 지시, 8: 켜면서 시작 주소 열기, 9: 서브에이전트 도구 추가(업로드·마우스 올리기 등)

export function autoSetupOnce(): string[] {
  if (process.env.CDPM_NO_AUTO_SETUP === '1' || process.env.CDPM_TEST_PORT_BASE) return [];
  const mark = path.join(cdpmHome(), `auto-setup-v${AUTO_SETUP_VERSION}.done`);
  if (fs.existsSync(mark)) return [];
  const done: string[] = [];
  try { done.push(setupStatusline().message); } catch { /* 다음 기회 */ }
  try { done.push(setupClaudeMd()); } catch { /* 다음 기회 */ }
  try { done.push(setupAgent()); } catch { /* 다음 기회 */ }
  try { done.push(setupPermissions()); } catch { /* 다음 기회 */ }
  try {
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, new Date().toISOString() + '\n' + done.join('\n') + '\n');
  } catch { /* 표시 파일을 못 쓰면 다음에 다시 (설정은 여러 번 해도 같음) */ }
  return done;
}
