// 슬롯 Chrome(과 프록시 중계 프로그램)을 CDPM·Claude Code·VS Code와 끊어서 띄운다.
// VS Code 등은 닫힐 때 자기가 띄운 프로세스를 "자식의 자식까지" 줄기째 강제 종료한다(taskkill /T 등).
// detached로 띄워도 Windows는 부모-자식 관계를 기억하므로 Chrome까지 같이 꺼진다.
// 그래서 중간 다리 프로세스가 대상을 띄우고 바로 끝난다 → 대상은 부모가 없는 프로세스가 되어 줄기 종료가 닿지 않는다.
// (macOS·Linux도 같음: 다리가 끝나면 대상은 launchd/init 밑으로 옮겨진다)
import { spawn } from 'node:child_process';
import { CdpmError } from './errors.js';

const BRIDGE = `
const { spawn } = require('child_process');
const o = JSON.parse(process.env.CDPM_ORPHAN);
delete process.env.CDPM_ORPHAN;
const say = (s) => process.stdout.write(s + '\\n');
const c = spawn(o.cmd, o.args, { detached: true, stdio: ['ignore', o.waitLine ? 'pipe' : 'ignore', 'ignore'], windowsHide: !!o.hide });
c.on('error', (e) => { say('ERR ' + e.message); process.exit(1); });
if (!o.waitLine) { say('PID ' + c.pid); c.unref(); process.exit(0); }
else {
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d;
    const m = new RegExp(o.waitLine).exec(buf);
    if (!m) return;
    say('PID ' + c.pid); say('LINE ' + m[0]);
    c.stdout.destroy(); c.unref(); process.exit(0);
  });
  c.on('exit', (code) => { say('EXIT ' + code); process.exit(1); });
  setTimeout(() => { say('TIMEOUT'); process.exit(1); }, o.timeoutMs || 5000);
}
`;

export interface OrphanOptions {
  env?: NodeJS.ProcessEnv;
  /** 대상의 창을 숨길지 (Chrome은 창이 보여야 하므로 false) */
  hide?: boolean;
  /** 대상이 표준 출력에 이 정규식에 맞는 줄을 쓸 때까지 기다렸다가 그 줄을 돌려준다 (준비 신호) */
  waitLine?: string;
  timeoutMs?: number;
}

/** 대상을 부모 없는 프로세스로 띄우고 PID(와 기다린 줄)를 돌려준다. */
export function spawnOrphan(cmd: string, args: string[], opts: OrphanOptions = {}): Promise<{ pid: number; line?: string }> {
  return new Promise((resolve, reject) => {
    const bridge = spawn(process.execPath, ['-e', BRIDGE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...(opts.env ?? process.env), CDPM_ORPHAN: JSON.stringify({ cmd, args, hide: opts.hide, waitLine: opts.waitLine, timeoutMs: opts.timeoutMs }) },
    });
    let out = '';
    bridge.stdout!.on('data', (d) => (out += String(d)));
    bridge.on('error', (e) => reject(new CdpmError(`Failed to start: ${e.message}`)));
    bridge.on('exit', () => {
      const pid = Number(/PID (\d+)/.exec(out)?.[1]);
      const line = /LINE (.*)/.exec(out)?.[1];
      if (pid && (!opts.waitLine || line)) return resolve({ pid, line });
      const why = /ERR (.*)/.exec(out)?.[1] ?? (/EXIT (.*)/.exec(out) ? `exited immediately (code ${/EXIT (.*)/.exec(out)![1]})` : /TIMEOUT/.test(out) ? 'no ready signal' : out.trim());
      reject(new CdpmError(`Failed to start: ${why}`));
    });
  });
}
