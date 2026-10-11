// 연결한 MCP 클라이언트가 누구인지 (initialize 때 clientInfo.name으로 알려 줌).
// Claude Code만 서브에이전트(Agent 도구·cdpm-browser)와 ~/.claude 설정을 쓰므로, 그 안내와 자동 설정은 Claude Code일 때만 한다.
let clientName = '';

export function setClientName(name: string | undefined) {
  clientName = name ?? '';
}

export function getClientName(): string {
  return clientName;
}

/** Claude Code는 MCP 서버에 "claude-code"라는 이름으로 접속한다. */
export function isClaudeCode(name = clientName): boolean {
  return /^claude[-_ ]?code/i.test(name);
}
