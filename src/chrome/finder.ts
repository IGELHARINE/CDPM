import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CdpmError } from '../errors.js';
import { paths, readConfig } from '../paths.js';

export interface FinderDeps {
  exists: (p: string) => boolean;
  regQuery: (key: string) => string | undefined;
  /** macOS: Spotlight로 찾은 Chrome.app 경로들 */
  spotlight?: (bundleId: string) => string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  configPath: string | undefined;
  /** 설정의 browser 값 (없으면 chrome) */
  browser?: string;
}

/**
 * 고를 수 있는 브라우저: CDP(원격 디버깅)와 실행 인자가 Chrome과 같은 크로미움 계열만.
 * Firefox·Safari는 CDP가 없거나 달라서 받지 않는다.
 */
interface BrowserSpec {
  label: string;
  /** Windows: App Paths 레지스트리 이름, Program Files 등 아래 상대 경로들 */
  winExe: string;
  winRel: string[];
  /** macOS: 앱 이름(.app), 실행 파일 이름, 번들 ID (Spotlight로 다른 폴더 설치도 찾는다) */
  macApp: string;
  macExe: string;
  bundleId: string;
  linux: string[];
}
export const BROWSERS: Record<string, BrowserSpec> = {
  chrome: { label: 'Google Chrome', winExe: 'chrome.exe', winRel: ['Google\\Chrome\\Application\\chrome.exe'], macApp: 'Google Chrome.app', macExe: 'Google Chrome', bundleId: 'com.google.Chrome', linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'] },
  brave: { label: 'Brave', winExe: 'brave.exe', winRel: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], macApp: 'Brave Browser.app', macExe: 'Brave Browser', bundleId: 'com.brave.Browser', linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave', '/snap/bin/brave'] },
  edge: { label: 'Microsoft Edge', winExe: 'msedge.exe', winRel: ['Microsoft\\Edge\\Application\\msedge.exe'], macApp: 'Microsoft Edge.app', macExe: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'] },
  chromium: { label: 'Chromium', winExe: 'chrome.exe', winRel: ['Chromium\\Application\\chrome.exe'], macApp: 'Chromium.app', macExe: 'Chromium', bundleId: 'org.chromium.Chromium', linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
  vivaldi: { label: 'Vivaldi', winExe: 'vivaldi.exe', winRel: ['Vivaldi\\Application\\vivaldi.exe'], macApp: 'Vivaldi.app', macExe: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi', linux: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable', '/opt/vivaldi/vivaldi'] },
};

/** 설정의 browser 값을 확인한다. 없으면 chrome, 모르는 이름이면 오류. */
export function browserSpec(name: string | undefined): BrowserSpec {
  const key = (name ?? 'chrome').trim().toLowerCase();
  const spec = BROWSERS[key];
  if (!spec) throw new CdpmError(`Unknown browser "${name}". Only Chromium-based browsers work: ${Object.keys(BROWSERS).join(', ')}.`);
  return spec;
}

/** 찾을 후보를 우선순위대로 돌려준다. */
export function chromeCandidates(deps: FinderDeps): string[] {
  const out: string[] = [];
  if (deps.configPath) out.push(deps.configPath);
  const b = browserSpec(deps.browser);
  if (deps.platform === 'win32') {
    // Chromium은 App Paths 이름이 chrome.exe라 Google Chrome과 겹친다 → 레지스트리는 쓰지 않고 폴더로만 찾는다
    if (b !== BROWSERS.chromium) {
      for (const hive of ['HKLM', 'HKCU']) {
        const v = deps.regQuery(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${b.winExe}`);
        if (v) out.push(v);
      }
    }
    const { ProgramFiles, LOCALAPPDATA } = deps.env;
    const pf86 = deps.env['ProgramFiles(x86)'];
    for (const base of [ProgramFiles, pf86, LOCALAPPDATA]) {
      if (base) for (const rel of b.winRel) out.push(path.win32.join(base, rel));
    }
  } else if (deps.platform === 'darwin') {
    const exe = `Contents/MacOS/${b.macExe}`;
    out.push(path.posix.join('/Applications', b.macApp, exe));
    if (deps.env.HOME) out.push(path.posix.join(deps.env.HOME, 'Applications', b.macApp, exe));
    // 다른 폴더에 설치했으면 Spotlight(번들 ID)로 찾는다
    for (const app of deps.spotlight?.(b.bundleId) ?? []) out.push(path.posix.join(app, exe));
  } else {
    out.push(...b.linux);
  }
  return [...new Set(out)];
}

export function findChromeWith(deps: FinderDeps): string {
  const candidates = chromeCandidates(deps);
  const found = candidates.find((p) => deps.exists(p));
  if (found) return found;
  const b = browserSpec(deps.browser);
  throw new CdpmError(
    `${b.label} not found. Searched:\n` +
    candidates.map((c) => `  - ${c}`).join('\n') +
    (b === BROWSERS.chrome ? '' : '\nTo go back to Chrome: cdpm browser chrome') +
    `\nOr set the path manually in ${paths.config()}: {"chromePath": "<full path to the browser executable>"}`,
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

function spotlight(bundleId: string): string[] {
  try {
    const out = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app'));
  } catch {
    return [];
  }
}

const cache = new Map<string, { key: string; path: string }>();

/** 브라우저 이름을 정리한다 (없으면 chrome). 크로미움 계열이 아니면 오류. */
export function browserKey(name: string | undefined): string {
  browserSpec(name);
  return (name ?? 'chrome').trim().toLowerCase();
}

/** 그 브라우저의 실행 파일 (기본 Chrome). config의 chromePath는 Chrome에만 쓴다. */
export function findBrowser(name?: string): string {
  const browser = browserKey(name);
  const configPath = browser === 'chrome' ? readConfig().chromePath : undefined;
  const key = configPath ?? '';
  const hit = cache.get(browser);
  if (hit && hit.key === key && fs.existsSync(hit.path)) return hit.path;
  const found = findChromeWith({
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
    configPath,
    browser,
  });
  cache.set(browser, { key, path: found });
  return found;
}

/** Google Chrome의 실행 파일 (버전 확인 등 Chrome 전용에 쓴다) */
export function findChrome(): string {
  return findBrowser('chrome');
}
