// 슬롯 번호 ↔ CDP 포트 변환과 슬롯별 색.
import { CdpmError } from './errors.js';

export const MIN_SLOT = 1;
/**
 * 슬롯은 99번까지 (예전에는 30번까지). 번호가 두 자리 안이라 아이콘·창 이름·상태줄에서 한눈에 읽힌다.
 * 실제로 몇 개까지 켤 수 있는지는 PC 메모리가 정한다 (Chrome 하나가 수백 MB).
 */
export const MAX_SLOT = 99;
/** 켜진 슬롯·빈 슬롯을 찾을 때 한 번에 살펴보는 번호 묶음 (포트 99개를 매번 다 두드리지 않게) */
export const SCAN_BLOCK = 30;

/**
 * 슬롯 N의 포트 = PORT_BASE + N (기본 1번=14050, 30번=14079, 99번=14148).
 * 다른 도구가 흔히 쓰는 9222를 피하려고 잘 안 쓰는 구간을 쓴다. 그 구간을 다른 프로그램이 쓰면 CDPM_PORT_BASE로 옮긴다.
 * 통합 테스트는 CDPM_TEST_PORT_BASE로 실제 슬롯과 부딪히지 않게 한다.
 */
export const DEFAULT_PORT_BASE = 14049;
export const PORT_BASE = portBaseFrom(process.env.CDPM_TEST_PORT_BASE || process.env.CDPM_PORT_BASE);

export function portBaseFrom(value: string | undefined): number {
  const n = Number(value);
  // 예약 포트(1023 이하)와 65535를 넘는 값은 받지 않는다
  // (전에 받던 값은 계속 받는다: 30번까지 들어가면 된다. 그 뒤 번호는 포트가 65535를 넘지 않는 데까지만 쓸 수 있다)
  return Number.isInteger(n) && n >= 1023 && n + 30 <= 65535 ? n : DEFAULT_PORT_BASE;
}

export function portOf(slot: number): number {
  assertSlot(slot);
  return PORT_BASE + slot;
}

export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= MIN_SLOT && slot <= MAX_SLOT && PORT_BASE + slot <= 65535;
}

export function assertSlot(slot: unknown): asserts slot is number {
  if (!isValidSlot(slot)) {
    throw new CdpmError(`Slot must be ${MIN_SLOT}-${MAX_SLOT} (got: ${String(slot)})`);
  }
}

/**
 * 슬롯 N은 항상 같은 색을 쓴다. 모두 흰 글씨 대비 4.5:1 이상.
 * 1–10: 서로 가장 잘 구분되는 기본색, 11–30: 진한 톤 변형. 31번부터는 1번 색부터 다시 돈다 (31번 = 1번 색; 번호로 구분한다).
 */
export const SLOT_COLORS: readonly string[] = [
  '#2563EB', // 1 파랑
  '#C2410C', // 2 주황
  '#15803D', // 3 초록
  '#DC2626', // 4 빨강
  '#9333EA', // 5 보라
  '#0E7490', // 6 청록
  '#BE185D', // 7 분홍
  '#B45309', // 8 호박
  '#0F766E', // 9 틸
  '#4338CA', // 10 남색
  '#BE123C', // 11 장미
  '#3F6212', // 12 라임
  '#0369A1', // 13 하늘
  '#A21CAF', // 14 자홍
  '#047857', // 15 에메랄드
  '#6D28D9', // 16 바이올렛
  '#854D0E', // 17 겨자
  '#1E40AF', // 18 진파랑
  '#9A3412', // 19 진주황
  '#166534', // 20 진초록
  '#991B1B', // 21 진빨강
  '#6B21A8', // 22 진보라
  '#155E75', // 23 진청록
  '#9D174D', // 24 진분홍
  '#115E59', // 25 진틸
  '#312E81', // 26 진남색
  '#475569', // 27 슬레이트
  '#57534E', // 28 스톤
  '#92400E', // 29 진호박
  '#0C4A6E', // 30 진하늘
];

export function colorOf(slot: number): string {
  assertSlot(slot);
  return SLOT_COLORS[(slot - 1) % SLOT_COLORS.length];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
