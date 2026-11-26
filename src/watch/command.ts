// `cdpm watch`: 관제 화면을 띄운다.
//   cdpm watch              켜져 있는 슬롯 전부
//   cdpm watch 1 2          1번·2번 슬롯만
//   cdpm watch 1 2 --cols 4 한 줄에 4칸
//   cdpm watch --stop       관제 서버 끄기
// 서버는 따로 떨어진 프로세스로 띄우고 이 명령은 주소만 알려 주고 끝난다 (에이전트가 실행해도 기다리지 않게).
// 이미 떠 있으면 다시 띄우지 않고 그 주소를 연다. 아무도 안 보면 10분 뒤 서버가 스스로 끝난다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidSlot } from '../slots.js';
import { startWatchServer, WATCH_PORT, watchInfoFile } from './server.js';

async function alive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(800) });
    return r.ok && typeof ((await r.json()) as { cdpmWatch?: string }).cdpmWatch === 'string';
  } catch {
    return false;
  }
}

function openInBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

export async function watchCommand(args: string[]): Promise<void> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(flag('--port')) || WATCH_PORT;
  if (args.includes('--serve')) {
    // 서버 본체 (떨어진 프로세스에서 이 모양으로 불린다)
    await startWatchServer(port);
    return;
  }
  if (args.includes('--stop')) {
    try {
      const info = JSON.parse(fs.readFileSync(watchInfoFile(), 'utf8')) as { pid: number };
      process.kill(info.pid);
      fs.rmSync(watchInfoFile(), { force: true });
      console.log('관제 화면 서버를 껐어요.');
    } catch {
      console.log('관제 화면 서버가 떠 있지 않아요.');
    }
    return;
  }
  // --cols 4, --port 14990 처럼 값을 받는 옵션의 값은 슬롯 번호로 보지 않는다
  const valued = new Set(['--cols', '--port']);
  const slots = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? '')).map(Number).filter(isValidSlot);
  if (!(await alive(port))) {
    spawn(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'watch', '--serve', '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 150)); up = await alive(port); }
    if (!up) throw new Error(`관제 화면 서버를 띄우지 못했어요 (포트 ${port}). 다른 프로그램이 그 포트를 쓰고 있으면 --port로 바꿔 주세요.`);
  }
  const q = new URLSearchParams();
  if (slots.length) q.set('slots', [...new Set(slots)].join(','));
  if (Number(flag('--cols'))) q.set('cols', String(Number(flag('--cols'))));
  const url = `http://127.0.0.1:${port}/${q.size ? `?${q}` : ''}`;
  if (!args.includes('--no-open')) openInBrowser(url);
  console.log(`관제 화면: ${url}${slots.length ? ` (${slots.join('·')}번 슬롯)` : ' (켜져 있는 슬롯 전부)'}`);
}
