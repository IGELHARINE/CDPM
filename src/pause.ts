// 사용자가 슬롯을 멈추고(pause) 다시 시작하기(resume).
// 멈춤 상태는 공용 기록부에 있어서 다른 Claude 세션의 에이전트에게도 바로 적용된다.
// 멈춘 슬롯은 조작 도구가 모두 거절되고, 기다리는 중인 browser_wait도 바로 멈춘다 (화면 읽기는 그대로 됨).
// 다시 시작하면 그 슬롯의 모든 에이전트에게 메시지를 보내 slot_inbox로 기다리던 에이전트를 바로 깨운다.
import { sendMessage } from './registry/messages.js';
import { readRegistry, updateRegistry, type Stamp } from './registry/store.js';
import { ago, nowIso } from './util.js';

export function pausedInfo(slot: number): Stamp | undefined {
  return readRegistry().slots[String(slot)]?.paused;
}

// 조작 중간(키 하나·마우스 이동 하나마다)에 확인하므로 기록부를 매번 읽지 않게 아주 짧게(50ms) 기억한다
const recent = new Map<number, { at: number; paused: boolean }>();
export function isPaused(slot: number): boolean {
  const c = recent.get(slot);
  if (c && Date.now() - c.at < 50) return c.paused;
  const paused = !!pausedInfo(slot);
  recent.set(slot, { at: Date.now(), paused });
  return paused;
}

/** 멈춘 슬롯이면 조작을 거절하는 안내, 아니면 undefined. */
export function pausedRefusal(slot: number): string | undefined {
  const p = pausedInfo(slot);
  if (!p) return undefined;
  return `[paused] ${p.agent} paused slot ${slot} (${ago(p.at)}). The user may be operating it, so don't act on this slot. ` +
    `Wait with slot_inbox(slot=${slot}, wait=600); a message arrives on resume. The page may have changed, so re-read with browser_snapshot and continue. ` +
    "Don't resume it yourself (slot_resume): the user decides.";
}

/** 슬롯들을 멈춘다. 꺼진 슬롯은 건너뛴다. 결과 안내 줄들을 돌려준다. */
export async function pauseSlots(slots: number[], by: string): Promise<string[]> {
  const at = nowIso();
  const done = await updateRegistry((r) => slots.filter((slot) => {
    const rec = r.slots[String(slot)];
    if (!rec) return false;
    rec.paused ??= { agent: by, at };
    return true;
  }));
  const out: string[] = [];
  for (const slot of slots) {
    if (!done.includes(slot)) {
      out.push(`Slot ${slot} is not running.`);
      continue;
    }
    await sendMessage(slot, by, `[paused] The user paused slot ${slot}. Don't act; wait with slot_inbox(slot=${slot}, wait=600).`, null);
    out.push(`Paused slot ${slot}. All actions on it are now refused, and waiting agents stop at once.`);
  }
  return out;
}

export async function resumeSlots(slots: number[], by: string): Promise<string[]> {
  const was = await updateRegistry((r) => slots.filter((slot) => {
    const rec = r.slots[String(slot)];
    if (!rec?.paused) return false;
    delete rec.paused;
    return true;
  }));
  const out: string[] = [];
  for (const slot of slots) {
    if (!was.includes(slot)) {
      out.push(`Slot ${slot} is not paused.`);
      continue;
    }
    await sendMessage(slot, by, `[resumed] The user resumed slot ${slot}. The page may have changed while paused; re-read with browser_snapshot and continue your task.`, null);
    out.push(`Resumed slot ${slot}. Waiting agents were notified.`);
  }
  return out;
}

/** 지금 멈춰 있는 슬롯 번호들. */
export function pausedSlots(): number[] {
  return Object.entries(readRegistry().slots).filter(([, rec]) => rec.paused).map(([k]) => Number(k)).sort((a, b) => a - b);
}
