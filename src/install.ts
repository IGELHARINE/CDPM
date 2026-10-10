// `cdpm install`: npm으로 설치한 뒤 한 번 실행하면 Claude Code에 CDPM을 등록하고 자동 설정까지 끝낸다.
// MCP 서버를 띄우는 프로세스에 node가 PATH에 없어도 되도록 node와 cli.js를 절대경로로 등록한다.
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stableNodePath } from './paths.js';

function claude(args: string[]): { ok: boolean; out: string } {
  try {
    const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 60_000 };
    // Windows는 claude가 .cmd일 수 있어 셸로 실행한다 (인자는 직접 따옴표로 묶음)
    const out = process.platform === 'win32'
      ? execSync(['claude', ...args.map((a) => (/[\s"]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a))].join(' '), opts)
      : execFileSync('claude', args, opts);
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout ?? '') + String(e?.stderr ?? e?.message ?? '') };
  }
}

export function installIntoClaude(name = 'cdpm'): string[] {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const node = stableNodePath();
  const out: string[] = [];
  if (!claude(['--version']).ok) {
    return ['Claude Code(claude 명령)를 찾지 못했어요. Claude Code를 설치한 뒤 다시 `cdpm install`을 실행하세요.'];
  }
  // 예전 위치(직접 받은 폴더 등)로 등록돼 있으면 지금 설치된 위치로 바꾼다
  claude(['mcp', 'remove', name, '-s', 'user']);
  const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : s);
  const add = claude(['mcp', 'add', name, '--scope', 'user', '--', q(node), q(cli)]);
  if (!add.ok) return [`Claude Code에 등록하지 못했어요: ${add.out.trim().slice(0, 300)}`];
  out.push(`Claude Code에 CDPM을 등록했어요 (이름: ${name}, ${cli}).`);
  return out;
}
