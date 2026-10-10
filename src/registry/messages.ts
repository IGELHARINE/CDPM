import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import { nowIso, sleep } from '../util.js';
import { withLock, writeFileAtomic } from './lock.js';

export interface Message {
  seq: number;
  at: string;
  from: string;
  to: string | null;
  text: string;
}

const MAX_LINES = 1000;
const KEEP_LINES = 500;
const FIRST_VISIT_BACKLOG = 20;

function readAll(slot: number): Message[] {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.messages(slot), 'utf8');
  } catch {
    return [];
  }
  const out: Message[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Message);
    } catch {
      // 깨진 줄은 건너뜀
    }
  }
  return out;
}

function readCursors(slot: number): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(paths.cursors(slot), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function sendMessage(slot: number, from: string, text: string, to: string | null): Promise<Message> {
  return withLock(() => {
    const all = readAll(slot);
    const msg: Message = { seq: (all.at(-1)?.seq ?? 0) + 1, at: nowIso(), from, to, text };
    const file = paths.messages(slot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (all.length + 1 > MAX_LINES) {
      const kept = [...all.slice(-(KEEP_LINES - 1)), msg];
      writeFileAtomic(file, kept.map((m) => JSON.stringify(m)).join('\n') + '\n');
    } else {
      fs.appendFileSync(file, JSON.stringify(msg) + '\n');
    }
    return msg;
  });
}

function visibleTo(agent: string, m: Message) {
  return m.from !== agent && (m.to === null || m.to === agent);
}

/** 안 읽은 메시지를 가져오고 읽음 처리한다. */
export async function takeUnread(slot: number, agent: string): Promise<Message[]> {
  const all = readAll(slot);
  const cursors = readCursors(slot);
  const lastSeq = all.at(-1)?.seq ?? 0;
  const cursor = cursors[agent];
  let unread: Message[];
  if (cursor === undefined) {
    unread = all.filter((m) => visibleTo(agent, m)).slice(-FIRST_VISIT_BACKLOG);
  } else {
    unread = all.filter((m) => m.seq > cursor && visibleTo(agent, m));
  }
  if (cursor !== lastSeq) {
    await withLock(() => {
      const c = readCursors(slot);
      c[agent] = Math.max(c[agent] ?? 0, lastSeq);
      // 에이전트 이름이 계속 늘어나도 파일이 커지지 않게, 가장 오래 안 읽은 이름부터 지운다.
      const names = Object.keys(c);
      if (names.length > 200) names.sort((a, b) => c[a] - c[b]).slice(0, names.length - 200).forEach((n) => delete c[n]);
      writeFileAtomic(paths.cursors(slot), JSON.stringify(c, null, 2));
    });
  }
  return unread;
}

/** 읽음 처리하지 않고, 이 에이전트에게 새 메시지가 왔는지만 본다 (기다리는 도중 바로 멈추기 위해). */
export function hasUnread(slot: number, agent: string): boolean {
  const cursor = readCursors(slot)[agent];
  const since = Date.now() - 60_000;
  return readAll(slot).some((m) => visibleTo(agent, m) && (cursor === undefined ? Date.parse(m.at) >= since : m.seq > cursor));
}

/** 안 읽은 메시지가 생길 때까지 최대 waitSec초 기다린다. */
export async function waitUnread(slot: number, agent: string, waitSec: number): Promise<Message[]> {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const got = await takeUnread(slot, agent);
    if (got.length || Date.now() >= deadline) return got;
    await sleep(100); // 메시지가 오면 0.1초 안에 알아챈다
  }
}

/** 이미 읽음 처리된(머리말로 전달된) 최근 메시지. inbox에 새 메시지가 없을 때 참고로 보여준다. */
export function recentDelivered(slot: number, agent: string, max = 5, withinSec = 600): Message[] {
  const cursor = readCursors(slot)[agent] ?? 0;
  const since = Date.now() - withinSec * 1000;
  return readAll(slot)
    .filter((m) => m.seq <= cursor && visibleTo(agent, m) && Date.parse(m.at) >= since)
    .slice(-max);
}
