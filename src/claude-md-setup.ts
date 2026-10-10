// 사용자 전역 지시 파일(~/.claude/CLAUDE.md)에 CDPM 병렬 처리 규칙을 넣는다.
// Claude는 MCP 지침보다 사용자 지시를 훨씬 잘 따르므로, "여러 슬롯 = 서브에이전트" 규칙은 여기에 두는 게 가장 확실하다.
// 표시 줄 사이만 바꾸므로 여러 번 실행해도 한 번만 들어간다. 처음 바꿀 때 원래 파일은 백업한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const START = '<!-- CDPM:START (cdpm setup이 관리하는 부분) -->';
const END = '<!-- CDPM:END -->';

export const CDPM_RULES = `${START}
## CDPM (Chrome 슬롯 MCP) 사용 규칙

- 역할 구분 (여러 슬롯을 쓰는 작업은 사이트와 상관없이 항상):
  - 메인: 사용자와 대화, 슬롯 켜기·끄기, 서브에이전트에게 일 나눠 주기, 결과 합쳐서 보고. 슬롯 화면을 직접 이동·읽기·조작하지 않는다.
  - 서브에이전트(cdpm-browser): 맡은 슬롯 하나의 주소 이동·읽기·입력·클릭, 로그인 등 완료 감지, 자기 몫 결과물, 필요하면 다른 서브에이전트와 신호까지 전부.
  - 슬롯 하나로 끝나는 간단한 일은 메인이 직접 해도 된다.
- 여러 CDPM 슬롯에 각각 다른 일을 시키면(예: "5개 띄워서 하나는 네이버, 하나는 유튜브…") 메인이 직접 처리하지 않는다.
  1. browser_launch 한 번으로 슬롯을 모두 켠다 (slots 또는 count). 시작 페이지를 알면 url/urls로 켜면서 바로 연다. 메인은 여기까지만 하고, 주소 이동·읽기·조작은 처음부터 서브에이전트가 한다.
  2. 한 메시지 안에서 Agent 도구를 슬롯 수만큼 함께 불러 서브에이전트를 한꺼번에 띄운다. 모두 run_in_background: true로 (앞 서브에이전트가 끝나길 기다리지 않게). subagent_type은 "cdpm-browser"(CDPM 전용, 빨리 시작)를 쓴다.
     - 지시는 1~3줄로 짧게: 슬롯 번호, agent 이름(예: "네이버담당"), 할 일만. cdpm-browser는 CDPM 사용법·규칙을 이미 알고 있으니 다시 설명하지 않는다 (긴 지시를 쓰는 시간만큼 늦어진다).
     - 서브에이전트는 동시에 20개까지만 뜬다. 슬롯이 20개를 넘으면 20개를 먼저 띄우고 끝나는 대로 나머지를 띄운다 (늘리려면 환경변수 CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).
  3. 결과물(보고서·HTML 조각·표 등)도 각 서브에이전트가 자기 몫을 써서 돌려주고, 메인은 합치기만 한다.
- 한 에이전트는 한 슬롯만 조작한다 (CDPM이 다른 슬롯 조작을 거절한다. 다른 슬롯 화면 보기는 괜찮다).
- 어느 사이트든 사용자가 로그인·본인 인증·보안문자 등을 해야 해도 "됐다고 알려 달라"고 하지 않는다. 서브에이전트를 먼저 띄워 두고 각자 화면을 건드리지 않고(새로고침 금지) browser_wait url/gone/text로 완료를 감지해 이어서 진행하게 한다.
- 기다림은 최소한으로. 서브에이전트끼리 협업하면(서로 메일 주고받기 등) 일을 끝내는 즉시 slot_send로 상대에게 알리고, 상대를 기다릴 때는 slot_inbox wait로 기다리게 한다 (화면을 반복해서 새로고침하지 않는다). 서브에이전트에게 긴 고정 대기를 지시하지 않는다.
- 화면이 필요하면 조작 도구에 read를 붙여 한 번에 받는다 (글은 text, 누를 게 필요하면 snapshot, 바뀐 것만 보려면 changes).
- When several CDPM slots get different jobs, start one cdpm-browser subagent per slot in a single message (at most 20 at once), let each write its own part of the output, and only merge in the main agent.
${END}`;

export function claudeMdPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'CLAUDE.md');
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
