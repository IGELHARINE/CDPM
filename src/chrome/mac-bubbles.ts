// macOS 전용: 슬롯 Chrome에 떠 있는 권한 요청 말풍선("example.com의 권한 요청: 내 위치 확인" 등)을 읽는다.
// 말풍선은 페이지가 아니라 브라우저 화면이라 CDP로는 보이지 않는다. Windows는 창 제목으로 찾지만(bubbles.ts),
// macOS는 다른 앱 창의 제목을 읽으려면 손쉬운 사용(접근성) 권한이 필요하다. 그래서
//  - 프로세스 번호로 그 Chrome만 짚어(AXUIElementCreateApplication) 창 목록을 읽는다 (System Events로 찾으면 같은 Chrome 앱의 다른 인스턴스를 읽는다: 실측).
//  - 일반 창이 아니고 제목에 탭의 사이트 주소가 든 창만 권한 요청으로 본다 (번역 제안 같은 다른 말풍선은 거른다).
//  - 1초마다 osascript를 새로 띄우면 무거워서, 도우미 하나를 띄워 두고 한 줄씩 물어본다 (한 번에 약 30ms).
// 접근성 권한이 없으면 빈 목록 (아무것도 하지 않는다).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MacBubble {
  pid: number;
  key: string;
  title: string;
  texts: string[];
  buttons: string[];
}

const SCRIPT = `
ObjC.import('ApplicationServices'); ObjC.import('Foundation');
function attr(el, name) { const ref = Ref(); return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ref[0] : undefined; }
function str(el, name) { const v = attr(el, name); if (v === undefined) return ''; try { const s = ObjC.unwrap(ObjC.castRefToObject(v)); return typeof s === 'string' ? s : ''; } catch (e) { return ''; } }
function kids(el, name) { const v = attr(el, name || 'AXChildren'); if (v === undefined) return []; try { const a = ObjC.castRefToObject(v); const out = []; for (let i = 0; i < a.count; i++) out.push(a.objectAtIndex(i)); return out; } catch (e) { return []; } }
function read(pid) {
  const out = [];
  for (const w of kids($.AXUIElementCreateApplication(pid), 'AXWindows')) {
    if (str(w, 'AXSubrole') === 'AXStandardWindow') continue;
    const info = { pid: pid, title: str(w, 'AXTitle'), texts: [], buttons: [] };
    const walk = (el, d) => {
      if (d > 14 || info.texts.length + info.buttons.length > 30) return;
      for (const k of kids(el)) {
        const role = str(k, 'AXRole');
        if (role === 'AXWebArea') continue;
        const v = str(k, 'AXTitle') || str(k, 'AXDescription') || (role === 'AXStaticText' ? str(k, 'AXValue') : '');
        if (v && role === 'AXButton') info.buttons.push(v); else if (v && role === 'AXStaticText') info.texts.push(v);
        walk(k, d + 1);
      }
    };
    walk(w, 0);
    out.push(info);
  }
  return out;
}
function run() {
  const inp = $.NSFileHandle.fileHandleWithStandardInput, outp = $.NSFileHandle.fileHandleWithStandardOutput;
  const say = (s) => outp.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
  let buf = '';
  for (;;) {
    const data = inp.availableData;
    if (data.length === 0) return;
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!$.AXIsProcessTrusted()) { say(JSON.stringify({ trusted: false, windows: [] })); continue; }
      const windows = [];
      for (const p of line.split(',').map(Number).filter((n) => n > 0)) { try { windows.push(...read(p)); } catch (e) {} }
      say(JSON.stringify({ trusted: true, windows: windows }));
    }
  }
}
`;

let helper: ChildProcessWithoutNullStreams | undefined;
let pending: ((v: { trusted: boolean; windows: Omit<MacBubble, 'key'>[] } | undefined) => void)[] = [];
let outBuf = '';
let busy: Promise<unknown> = Promise.resolve();

function start(): ChildProcessWithoutNullStreams | undefined {
  if (helper && helper.exitCode === null && !helper.killed) return helper;
  try {
    const file = path.join(os.tmpdir(), `cdpm-mac-bubbles-${process.pid}.js`);
    fs.writeFileSync(file, SCRIPT);
    const p = spawn('osascript', ['-l', 'JavaScript', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      outBuf += d;
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
        let v; try { v = JSON.parse(line); } catch { v = undefined; }
        pending.shift()?.(v);
      }
    });
    p.on('exit', () => { for (const r of pending) r(undefined); pending = []; if (helper === p) helper = undefined; fs.rmSync(file, { force: true }); });
    p.on('error', () => undefined);
    p.stderr.resume();
    helper = p;
    return p;
  } catch {
    return undefined;
  }
}

/** 프로세스 번호들(슬롯 Chrome 본체)에 떠 있는 일반 창이 아닌 창들. macOS가 아니면 늘 빈 목록. */
export function macWindows(pids: number[]): Promise<{ trusted: boolean; windows: Omit<MacBubble, 'key'>[] }> {
  if (process.platform !== 'darwin' || !pids.length) return Promise.resolve({ trusted: true, windows: [] });
  // 한 번에 하나씩 묻는다 (답이 순서대로 오도록)
  const next = busy.then(() => new Promise<{ trusted: boolean; windows: Omit<MacBubble, 'key'>[] }>((resolve) => {
    const p = start();
    if (!p) return resolve({ trusted: false, windows: [] });
    const timer = setTimeout(() => { const i = pending.indexOf(done); if (i >= 0) pending.splice(i, 1); resolve({ trusted: true, windows: [] }); }, 3000);
    const done = (v: { trusted: boolean; windows: Omit<MacBubble, 'key'>[] } | undefined) => { clearTimeout(timer); resolve(v ?? { trusted: true, windows: [] }); };
    pending.push(done);
    p.stdin.write(`${pids.join(',')}\n`);
  }));
  busy = next.catch(() => undefined);
  return next;
}

/** 권한 요청 말풍선만: 제목에 탭의 사이트 주소(호스트)가 든 창. */
export async function macPermissionBubbles(pids: number[], hostsOfPid: (pid: number) => string[]): Promise<MacBubble[]> {
  const { windows } = await macWindows(pids);
  return windows
    .filter((w) => w.title && hostsOfPid(w.pid).some((h) => w.title.includes(h)))
    .map((w) => ({ ...w, key: `${w.pid}:${w.title}` }));
}

/** 도우미를 끈다 (관제 서버가 끝날 때). */
export function stopMacBubbles() {
  helper?.kill();
  helper = undefined;
}
