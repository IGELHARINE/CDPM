// 사용자가 슬롯을 멈추고(pause) 다시 시작하기(resume).
// 멈춤 상태는 공용 기록부에 있어서 다른 Claude 세션의 에이전트에게도 바로 적용된다.
// 멈춘 슬롯은 조작 도구가 모두 거절되고, 기다리는 중인 browser_wait도 바로 멈춘다 (화면 읽기는 그대로 됨).
// 다시 시작하면 그 슬롯의 모든 에이전트에게 메시지를 보내 slot_inbox로 기다리던 에이전트를 바로 깨운다.
import { sendMessage } from './registry/messages.js';
import { readRegistry, updateRegistry, type Stamp } from './registry/store.js';
import { ago, josa, nowIso } from './util.js';

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
  const when = ago(p.at);
  return `[멈춤] ${josa(p.agent, '이', '가')} ${when === '방금' ? when : `${when}에`} ${slot}번을 멈췄어요. 사용자가 직접 조작하는 중일 수 있으니 이 슬롯은 조작하지 마세요. ` +
    `slot_inbox(slot=${slot}, wait=600)로 기다리면 다시 시작될 때 메시지가 와요. 메시지를 받으면 화면이 바뀌었을 수 있으니 browser_snapshot으로 다시 읽고 이어 가세요. ` +
    '스스로 다시 시작(slot_resume)하지 마세요: 사용자가 정해요.';
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
      out.push(`${slot}번은 켜져 있지 않아요.`);
      continue;
    }
    await sendMessage(slot, by, `[멈춤] 사용자가 ${slot}번을 멈췄어요. 조작하지 말고 slot_inbox(slot=${slot}, wait=600)로 기다리세요.`, null);
    out.push(`${slot}번을 멈췄어요. 이제 이 슬롯의 조작은 모두 거절되고, 기다리는 중이던 에이전트도 바로 멈춰요.`);
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
      out.push(`${slot}번은 멈춰 있지 않아요.`);
      continue;
    }
    await sendMessage(slot, by, `[다시 시작] 사용자가 ${slot}번을 다시 시작했어요. 멈춘 동안 화면이 바뀌었을 수 있으니 browser_snapshot으로 다시 읽고 하던 일을 이어 가세요.`, null);
    out.push(`${slot}번을 다시 시작했어요. 기다리던 에이전트에게 알렸어요.`);
  }
  return out;
}

/** 지금 멈춰 있는 슬롯 번호들. */
export function pausedSlots(): number[] {
  return Object.entries(readRegistry().slots).filter(([, rec]) => rec.paused).map(([k]) => Number(k)).sort((a, b) => a - b);
}
