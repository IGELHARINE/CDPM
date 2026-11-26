// 버전은 package.json 한 곳에서만 관리한다 (dist/version.js 기준으로 ../package.json).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 설치본은 dist/version.js → ../package.json. 시험 빌드는 dist-test/src/version.js → ../../package.json.
const PACKAGE_JSON = ['../package.json', '../../package.json']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((file) => fs.existsSync(file)) ?? fileURLToPath(new URL('../package.json', import.meta.url));

/** 이 프로세스가 켜질 때 읽어 들인 버전 (지금 돌고 있는 코드의 버전) */
export const VERSION: string = (JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version;

/** 지금 디스크에 깔려 있는 버전 (업데이트되면 돌고 있는 코드와 달라진다). 못 읽으면 undefined. */
export function installedVersion(file = PACKAGE_JSON): string | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

let checkedAt = 0;
let outdated = false;

/**
 * 이 프로세스가 낡았는지: 켜진 뒤 CDPM이 업데이트돼 디스크의 버전이 돌고 있는 코드와 달라졌다.
 * Claude Code 창을 여러 개 켜 두면 창마다 CDPM이 따로 돌고, 업데이트 뒤에 다시 연결하지 않은 창은 옛 코드로 남는다.
 * 그런 프로세스가 슬롯 아이콘 같은 "보이는 것"을 계속 손대면 새 프로세스와 서로 덮어쓴다 (옛 아이콘 ↔ 새 아이콘이 번갈아 나옴).
 * 그래서 낡은 프로세스는 보이는 것에서 손을 뗀다 (브라우저 조작은 그대로 한다). 10초에 한 번만 파일을 읽는다.
 */
export function isOutdated(now = Date.now()): boolean {
  if (now - checkedAt > 10_000) {
    checkedAt = now;
    const disk = installedVersion();
    outdated = disk !== undefined && disk !== VERSION;
  }
  return outdated;
}
