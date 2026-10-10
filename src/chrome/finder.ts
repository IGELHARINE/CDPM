import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CdpmError } from '../errors.js';
import { paths, readConfig } from '../paths.js';

export interface FinderDeps {
  exists: (p: string) => boolean;
  regQuery: (key: string) => string | undefined;
  /** macOS: Spotlight로 찾은 Chrome.app 경로들 */
  spotlight?: () => string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  configPath: string | undefined;
}

const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';

/** 찾을 후보를 우선순위대로 돌려준다. */
export function chromeCandidates(deps: FinderDeps): string[] {
  const out: string[] = [];
  if (deps.configPath) out.push(deps.configPath);
  if (deps.platform === 'win32') {
    for (const hive of ['HKLM', 'HKCU']) {
      const v = deps.regQuery(`${hive}\\${APP_PATHS}`);
      if (v) out.push(v);
    }
    const { ProgramFiles, LOCALAPPDATA } = deps.env;
    const pf86 = deps.env['ProgramFiles(x86)'];
    for (const base of [ProgramFiles, pf86, LOCALAPPDATA]) {
      if (base) out.push(path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (deps.platform === 'darwin') {
    const exe = 'Contents/MacOS/Google Chrome';
    out.push(path.posix.join('/Applications/Google Chrome.app', exe));
    if (deps.env.HOME) out.push(path.posix.join(deps.env.HOME, 'Applications/Google Chrome.app', exe));
    // 다른 폴더에 설치했으면 Spotlight(앱 ID com.google.Chrome)로 찾는다
    for (const app of deps.spotlight?.() ?? []) out.push(path.posix.join(app, exe));
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome');
  }
  return [...new Set(out)];
}

export function findChromeWith(deps: FinderDeps): string {
  const candidates = chromeCandidates(deps);
  const found = candidates.find((p) => deps.exists(p));
  if (found) return found;
  throw new CdpmError(
    'Chrome을 찾지 못했습니다. 찾아본 경로:\n' +
    candidates.map((c) => `  - ${c}`).join('\n') +
    `\n${paths.config()} 파일에 {"chromePath": "Chrome 실행 파일 전체 경로"}를 넣어 직접 지정할 수 있어요.`,
  );
}

function regQuery(key: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    return m ? m[1].trim().replace(/^"|"$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

function spotlight(): string[] {
  try {
    const out = execFileSync('mdfind', ['kMDItemCFBundleIdentifier == "com.google.Chrome"'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app'));
  } catch {
    return [];
  }
}

let cached: string | undefined;

export function findChrome(): string {
  if (cached && fs.existsSync(cached)) return cached;
  cached = findChromeWith({
    exists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    regQuery,
    spotlight: process.platform === 'darwin' ? spotlight : undefined,
    env: process.env,
    platform: process.platform,
    configPath: readConfig().chromePath,
  });
  return cached;
}
