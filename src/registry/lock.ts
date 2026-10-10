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
  const lockPath = paths.lock();
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
      if (Date.now() > deadline) throw new LockTimeoutError('저장소 잠금을 얻지 못했어요 (다른 프로세스가 오래 쓰는 중).');
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

function removeIfOwnerDead(lockPath: string) {
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
  }
}

/** 임시 파일에 쓰고 rename으로 교체. Windows에서 다른 프로세스가 읽는 중이면 잠깐 실패할 수 있어 재시도한다. */
export function writeFileAtomic(file: string, data: string) {
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
      const until = Date.now() + 10;
      while (Date.now() < until) { /* 짧게 대기 */ }
    }
  }
}
