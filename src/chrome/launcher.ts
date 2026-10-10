import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { probe, type VersionInfo } from '../cdp/targets.js';
import { CdpmError } from '../errors.js';
import { paths, readConfig } from '../paths.js';
import { portOf } from '../slots.js';
import { sleep } from '../util.js';
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

/** 슬롯 Chrome을 띄우고 CDP가 응답할 때까지 기다린다. MCP가 끝나도 Chrome은 살아 있도록 분리 실행. */
export async function launchChrome(slot: number, opts: LaunchOptions = {}): Promise<Launched> {
  const chrome = findChrome();
  fs.mkdirSync(paths.profile(slot), { recursive: true });
  const extra = opts.proxy ? await proxyArgs(slot, opts.proxy) : [];
  const child = spawn(chrome, [...chromeArgs(slot, opts), ...extra, opts.url || 'about:blank'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  let spawnError: Error | undefined;
  let exitedCode: number | null | undefined;
  child.on('error', (e) => (spawnError = e));
  child.on('exit', (code) => (exitedCode = code));
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new CdpmError(`Chrome 실행 실패: ${spawnError.message}`);
    const p = await probe(slot, 2000);
    if (p.state === 'chrome') return { pid: child.pid, version: p.version };
    if (exitedCode !== undefined) {
      throw new CdpmError(
        `${slot}번 Chrome이 켜지자마자 종료됐어요 (종료 코드 ${exitedCode}). ` +
        `같은 프로필(${paths.profile(slot)})을 쓰는 Chrome이 디버깅 포트 없이 이미 떠 있으면, 새 Chrome은 그쪽에 창만 넘기고 끝나요. 그 창을 닫고 다시 켜 주세요.`,
      );
    }
    await sleep(100);
  }
  throw new CdpmError(
    `${slot}번 Chrome을 실행했지만 ${READY_TIMEOUT_MS / 1000}초 안에 CDP 포트(${portOf(slot)})가 열리지 않았습니다. ` +
    `같은 프로필(${paths.profile(slot)})을 쓰는 Chrome이 디버깅 포트 없이 이미 떠 있을 수 있어요. 그 창을 닫고 다시 시도해 주세요.`,
  );
}
