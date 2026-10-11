#!/usr/bin/env node
// stdio MCP 서버 시작점.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { autoSetupOnce } from './auto-setup.js';
import { isClaudeCode, setClientName } from './client-info.js';
import { startSweeper } from './cdp/sessions.js';
import { startSlotWatcher } from './service.js';
import { startTaskbarWatcher } from './taskbar/watcher.js';
import { registerTools, serverInstructions } from './tools/register.js';
import { VERSION } from './version.js';

export async function startServer() {
  const server = new McpServer({ name: 'cdpm', version: VERSION }, { instructions: serverInstructions(false) });
  // 연결한 클라이언트(clientInfo.name)를 보고 안내를 고른다. Claude Code만 서브에이전트(Agent 도구·cdpm-browser) 안내를 받는다.
  // SDK가 initialize 응답에 instructions를 넣기 직전에 바꿔 끼운다.
  const inner = server.server as unknown as { _oninitialize: (req: any) => Promise<unknown>; _instructions?: string };
  const onInit = inner._oninitialize.bind(inner);
  inner._oninitialize = (req: any) => {
    setClientName(req?.params?.clientInfo?.name);
    inner._instructions = serverInstructions(isClaudeCode());
    return onInit(req);
  };
  // 자동 설정(상태줄·CLAUDE.md 규칙·cdpm-browser·권한)은 ~/.claude를 바꾸므로 Claude Code가 연결했을 때만 한다
  server.server.oninitialized = () => {
    if (isClaudeCode()) autoSetupOnce();
  };
  registerTools(server);
  await server.connect(new StdioServerTransport());
  startTaskbarWatcher();
  startSlotWatcher();
  startSweeper();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
