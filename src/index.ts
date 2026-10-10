#!/usr/bin/env node
// stdio MCP 서버 시작점.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { autoSetupOnce } from './auto-setup.js';
import { startSweeper } from './cdp/sessions.js';
import { startSlotWatcher } from './service.js';
import { startTaskbarWatcher } from './taskbar/watcher.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools/register.js';
import { VERSION } from './version.js';

export async function startServer() {
  const server = new McpServer({ name: 'cdpm', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  await server.connect(new StdioServerTransport());
  autoSetupOnce(); // 처음 한 번: 상태줄 + CLAUDE.md 병렬 규칙 (사용자가 따로 설정하지 않아도 되게)
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
