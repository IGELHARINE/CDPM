import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import { pidAlive, sleep } from '../util.js';

const RETRY_MS = 30;
/** 잠금 파일을 만든 직후 PID를 쓰기 전의 아주 짧은 순간만 봐주는 시간 (PID 확인이 불가능할 때만 쓰임) */
const UNREADABLE_GRACE_MS = 5000;

export class LockTimeoutError extends Error {}

/**
 * 프로세스 간 잠금. 잠금 파일을 'wx'로 만들 수 있으면 잡은 것. 파일에는 잡은 프로세스의 PID를 적는다.
 * 잠금이 남아 있어도 시간으로 판단하지 않고, 그 PID의 프로세스가 실제로 죽었을 때만 풀어 준다
 * (느린 프로세스의 잠금을 뺏어 기록이 깨지는 일이 없게).
 */
export async function withLock<T>(fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  return withFileLock(paths.lock(), fn, timeoutMs, 'Could not acquire the store lock (another process is holding it).');
}

/** 슬롯 켜기·끄기를 여러 Claude 세션 사이에서 하나씩 (동시에 켜면 Chrome이 두 번 떠서 하나가 실패함). */
export function withSlotLock<T>(slot: number, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(paths.slotLock(slot), fn, 90_000, `Another Claude session is launching or closing slot ${slot}. Try again shortly.`);
}

/** 같은 방식의 잠금을 원하는 파일로 (예: 탭 하나를 여러 Claude 세션이 동시에 조작하지 않게). */
export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      // Windows는 다른 프로세스가 잠금 파일을 지우는 중이면 EEXIST 대신 EPERM/EACCES/EBUSY를 낸다.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
      removeIfOwnerDead(lockPath);
      if (Date.now() > deadline) throw new LockTimeoutError(timeoutMessage);
      await sleep(RETRY_MS + Math.random() * RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      // 내 잠금일 때만 지운다
      if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      // 이미 정리됨
    }
  }
}

/**
 * 잡은 프로세스가 죽은 잠금을 지운다. 지우는 일은 정리용 잠금(.reap)을 잡은 한 프로세스만 한다.
 * 그러지 않으면 "죽었다"고 읽어 둔 두 프로세스 중 늦은 쪽이, 먼저 정리하고 새로 잡은 쪽의 살아 있는 잠금을 지운다.
 */
export function removeIfOwnerDead(lockPath: string) {
  const reap = `${lockPath}.reap`;
  try {
    fs.closeSync(fs.openSync(reap, 'wx'));
  } catch {
    // 다른 프로세스가 정리 중. 정리는 순식간이므로 오래 남아 있으면 정리하던 프로세스가 죽은 것
    try {
      if (Date.now() - fs.statSync(reap).mtimeMs > UNREADABLE_GRACE_MS) fs.unlinkSync(reap);
    } catch {
      // 그 사이 풀렸으면 무시
    }
    return;
  }
  try {
    const owner = Number(fs.readFileSync(lockPath, 'utf8'));
    if (owner > 0) {
      if (!pidAlive(owner)) fs.unlinkSync(lockPath);
      return;
    }
    // PID를 아직 못 읽음 (방금 만들어진 파일이거나 깨진 파일): 깨진 파일만 오래되면 정리
    if (Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_GRACE_MS) fs.unlinkSync(lockPath);
  } catch {
    // 그 사이 풀렸으면 무시
  } finally {
    try { fs.unlinkSync(reap); } catch { /* 무시 */ }
  }
}

const syncWait = new Int32Array(new SharedArrayBuffer(4));

/**
 * 파일을 읽는다. 없으면 undefined. Windows에서 백신·인덱서가 잠깐 잡고 있으면(EBUSY 등) 몇 번 다시 읽고,
 * 그래도 못 읽으면 던진다 (못 읽은 것을 "빈 파일"로 여기고 덮어쓰면 기록이 통째로 사라지므로).
 */
export function readFileIfExists(file: string): string | undefined {
  for (let i = 0; ; i++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (i >= 5) throw e;
      Atomics.wait(syncWait, 0, 0, 10);
    }
  }
}

/** 임시 파일에 쓰고 rename으로 교체. Windows에서 다른 프로세스가 읽는 중이면 잠깐 실패할 수 있어 재시도한다. */
export async function writeFileAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 50 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try { fs.unlinkSync(tmp); } catch { /* 무시 */ }
        throw e;
      }
      await sleep(10);
    }
  }
}
