import fs from 'node:fs';
import { probe, type VersionInfo } from '../cdp/targets.js';
import { CdpmError } from '../errors.js';
import { spawnOrphan } from '../orphan.js';
import { paths, readConfig } from '../paths.js';
import { portOf } from '../slots.js';
import { pidAlive, sleep } from '../util.js';
import { findChrome } from './finder.js';
import { proxyArgs, type ProxySpec } from './proxy.js';

const READY_TIMEOUT_MS = 30_000;

export interface LaunchOptions {
  /** 창 없이 실행. 인자는 `--headless` 하나만 더한다. */
  headless?: boolean;
  /** 켜자마자 열 주소 (없으면 빈 탭) */
  url?: string;
  /** 사용자가 프록시를 써 달라고 했을 때만. 없으면 프록시 관련 인자를 하나도 넣지 않는다. */
  proxy?: ProxySpec;
}

export function chromeArgs(slot: number, opts: LaunchOptions = {}): string[] {
  return [
    `--remote-debugging-port=${portOf(slot)}`,
    `--user-data-dir=${paths.profile(slot)}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-name=${slot}번`,
    ...(opts.headless ? ['--headless'] : []),
    ...(readConfig().extraArgs ?? []),
  ];
}

export interface Launched {
  pid: number | undefined;
  version: VersionInfo;
}

/**
 * 슬롯 Chrome을 띄우고 CDP가 응답할 때까지 기다린다. CDPM·Claude Code·VS Code가 끝나도(줄기째 강제 종료돼도)
 * Chrome은 살아 있도록 부모 없는 프로세스로 띄운다 (orphan.ts).
 */
export async function launchChrome(slot: number, opts: LaunchOptions = {}): Promise<Launched> {
  const chrome = findChrome();
  fs.mkdirSync(paths.profile(slot), { recursive: true });
  const extra = opts.proxy ? await proxyArgs(slot, opts.proxy) : [];
  let pid: number;
  try {
    ({ pid } = await spawnOrphan(chrome, [...chromeArgs(slot, opts), ...extra, opts.url || 'about:blank'], { hide: false }));
  } catch (e) {
    throw new CdpmError(`Failed to launch Chrome: ${(e as Error).message}`);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const p = await probe(slot, 2000);
    if (p.state === 'chrome') return { pid, version: p.version };
    if (!pidAlive(pid)) {
      throw new CdpmError(
        `Slot ${slot} Chrome exited right after launch. ` +
        `If a Chrome using the same profile (${paths.profile(slot)}) is already running without a debugging port, the new one hands its window over and exits. Close that window and launch again.`,
      );
    }
    await sleep(100);
  }
  throw new CdpmError(
    `Slot ${slot} Chrome started, but CDP port ${portOf(slot)} did not open within ${READY_TIMEOUT_MS / 1000}s. ` +
    `A Chrome using the same profile (${paths.profile(slot)}) may already be running without a debugging port. Close it and try again.`,
  );
}
