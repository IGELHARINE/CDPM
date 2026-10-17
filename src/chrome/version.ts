// 디스크에 설치된 Chrome 실행 파일의 버전. 실행 중인 슬롯 Chrome의 버전과 다르면 "실행 중에 업데이트된" 것이다:
// Windows는 업데이트가 chrome.exe를 새 버전으로 바꿔치기하는데, 옛 버전으로 도는 본체가 새 탭용 렌더러를 띄울 때
// 바뀐 chrome.exe를 실행해 버전이 맞지 않아 렌더러가 바로 죽는다 → 새 탭·다른 사이트로 이동한 탭이 빈 채로 멈춘다 (실측).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findChrome } from './finder.js';

/** Windows 실행 파일(PE)의 버전 정보에서 ProductVersion 값을 읽는다 (예: "155.0.8059.82"). */
export function peProductVersion(buf: Buffer): string | undefined {
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  for (let at = buf.indexOf(key); at >= 0; at = buf.indexOf(key, at + 2)) {
    let p = at + key.length;
    while (p % 4) p++; // 값은 4바이트 경계에서 시작한다
    let end = p;
    while (end + 1 < buf.length && end - p < 128 && (buf[end] | buf[end + 1]) !== 0) end += 2;
    const v = buf.toString('utf16le', p, end).trim();
    if (/^\d+(\.\d+){1,3}$/.test(v)) return v;
  }
  return undefined;
}

let cache: { key: string; version?: string } | undefined;

/**
 * 설치된 Chrome 버전. 실행 파일이 바뀔 때만 다시 읽는다. 바꿔치기는 이름만 바꾸는 것이라 수정 시각이 그대로일 수 있어서
 * 파일 번호(ino)·크기까지 함께 본다. 알 수 없으면 undefined (그때는 비교하지 않는다).
 */
export function installedChromeVersion(): string | undefined {
  if (process.env.CDPM_TEST_INSTALLED_VERSION) return process.env.CDPM_TEST_INSTALLED_VERSION; // 시험용
  try {
    const exe = findChrome();
    const st = fs.statSync(exe, { bigint: true });
    const key = `${exe}|${st.ino}|${st.size}|${st.mtimeMs}`;
    if (cache?.key === key) return cache.version;
    let version: string | undefined;
    if (process.platform === 'win32') version = peProductVersion(fs.readFileSync(exe));
    else if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(path.dirname(exe), '..', 'Info.plist'), 'utf8');
      version = /<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist)?.[1];
    } else {
      const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      version = /(\d+(?:\.\d+){1,3})/.exec(out)?.[1];
    }
    cache = { key, version };
    return version;
  } catch {
    return undefined;
  }
}

/** /json/version의 Browser 값("Chrome/154.0.8037.98", "HeadlessChrome/...")에서 버전만 */
export function runningVersion(browser: string | undefined): string | undefined {
  return /\/(\d+(?:\.\d+){1,3})/.exec(browser ?? '')?.[1];
}
