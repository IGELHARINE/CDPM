import fs from 'node:fs';
import { paths } from '../paths.js';
import { withLock, writeFileAtomic } from './lock.js';

export interface Stamp {
  agent: string;
  at: string;
}

export interface ActionStamp extends Stamp {
  action: string;
  /** agent 이름을 정하지 않고(기본 이름) 한 행동 */
  anon?: boolean;
}

export interface SummaryStamp extends Stamp {
  text: string;
}

export interface TabRecord {
  id: string;            // t1, t2 … 슬롯 안에서 재사용하지 않음
  seq: number;           // 처음 본 순서
  seenAt: string;
  openedBy: string;      // 에이전트 이름, "(외부)", "<에이전트> (페이지가 염)"
  last?: ActionStamp;
  summary?: SummaryStamp;
  /** 이 탭에 걸린 요청 막기 규칙 (건 프로세스가 살아 있는 동안만 유효) */
  blocks?: BlockStamp[];
}

export interface BlockStamp extends Stamp {
  pattern: string;
  pid: number;
}

export interface SlotRecord {
  pid?: number;
  launchedBy?: string;
  launchedAt: string;
  headless?: boolean;
  /** 프록시로 켰으면 그 주소 (비밀번호는 가림) */
  proxy?: string;
  summary?: SummaryStamp;
  last?: ActionStamp;     // 슬롯 안에서 마지막 행동 (팝업 귀속, 종료 경고용)
  /** 마지막으로 조작한 탭의 페이지 제목 (상태줄용) */
  title?: string;
  /** 마지막으로 조작한 탭의 CDP targetId (상태줄이 그 탭의 지금 제목을 읽을 때 씀) */
  lastTarget?: string;
  nextTabSeq: number;
  tabs: Record<string, TabRecord>;   // key: CDP targetId
}

export interface Registry {
  version: 1;
  slots: Record<string, SlotRecord>;
}

const empty = (): Registry => ({ version: 1, slots: {} });

export function readRegistry(): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(paths.registry(), 'utf8')) as Registry;
    if (r && r.version === 1 && r.slots) return r;
  } catch {
    // 없거나 깨졌으면 빈 저장소
  }
  return empty();
}

/** 잠금을 잡고 읽고-고치고-쓴다. mutator의 반환값을 돌려준다. */
export async function updateRegistry<T>(mutator: (r: Registry) => T): Promise<T> {
  return withLock(() => {
    const r = readRegistry();
    const result = mutator(r);
    writeFileAtomic(paths.registry(), JSON.stringify(r, null, 2));
    return result;
  });
}

export function newSlotRecord(launchedBy: string | undefined, at: string, pid?: number): SlotRecord {
  return { pid, launchedBy, launchedAt: at, nextTabSeq: 1, tabs: {} };
}
