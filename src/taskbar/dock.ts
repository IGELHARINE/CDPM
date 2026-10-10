// macOS 전용: 슬롯 Chrome의 Dock 아이콘을 슬롯 색·번호 아이콘으로 바꾼다 (Windows 작업표시줄 아이콘과 같은 디자인).
// Chrome의 CDP 명령 Browser.setDockTile을 쓴다. 앱 복사·서명 변경 같은 Chrome 수정은 하지 않는다.
// 다른 OS에서는 아무것도 하지 않는다 (Windows 작업표시줄은 win32.ts / watcher.ts가 따로 맡는다).
import fs from 'node:fs';
import path from 'node:path';
import { browserConnection, pageSession } from '../cdp/sessions.js';
import { listPages } from '../cdp/targets.js';
import { paths } from '../paths.js';
import { colorOf } from '../slots.js';
import { encodePng, renderIcon } from './icon.js';

export const DOCK_SUPPORTED = process.platform === 'darwin';

/** 그리는 방식을 바꾸면 올린다 (저장해 둔 그림을 다시 만든다). */
const DOCK_VERSION = 1;
const SIZE = 512;

const pngPath = (slot: number) => path.join(path.dirname(paths.icon(slot)), `${slot}-dock-v${DOCK_VERSION}.png`);

/**
 * 아이콘 그리기 (Chrome 캔버스, 격리된 실행 공간). Windows 아이콘과 같은 모양:
 * 슬롯 색 둥근 사각형(위→아래 조금 옅어짐), 진한 위 막대 + 점 3개, 흰 테두리, 가운데 굵은 번호(한 자리·두 자리 같은 크기).
 * macOS Dock 아이콘 격자에 맞춰 둘레에 여백(약 10%)을 둔다.
 */
export function drawScript(slot: number, color: string): string {
  return `(async () => {
    const S = ${SIZE}, pad = Math.round(S * 0.1), C = S - pad * 2, k = C / 64;
    const cv = new OffscreenCanvas(S, S), g = cv.getContext('2d');
    const hex = ${JSON.stringify(color)}, r = parseInt(hex.slice(1, 3), 16), gr = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const rgba = (a) => 'rgba(' + r + ',' + gr + ',' + b + ',' + a + ')';
    const rr = (x, y, w, h, rad) => { g.beginPath(); g.roundRect(x, y, w, h, rad); };
    const radius = Math.round(11 * k), barH = Math.round(16 * k), pw = Math.max(1, Math.round(k));
    g.save();
    rr(pad, pad, C, C, radius); g.clip();
    const grad = g.createLinearGradient(0, pad, 0, pad + C); grad.addColorStop(0, rgba(1)); grad.addColorStop(1, rgba(205 / 255));
    g.fillStyle = grad; g.fillRect(pad, pad, C, C);
    g.fillStyle = 'rgba(0,0,0,' + (85 / 255) + ')'; g.fillRect(pad, pad, C, barH);
    g.fillStyle = 'rgba(255,255,255,' + (70 / 255) + ')'; g.fillRect(pad, pad + barH, C, pw);
    g.restore();
    const dotD = Math.max(2, Math.round(6.4 * k)), gap = Math.max(1, Math.round(2.6 * k)), dotX = pad + Math.max(1, Math.round(6.5 * k));
    g.fillStyle = 'rgba(255,255,255,' + (245 / 255) + ')';
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(dotX + i * (dotD + gap) + dotD / 2, pad + barH / 2, dotD / 2, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = 'rgba(255,255,255,' + (128 / 255) + ')'; g.lineWidth = pw;
    rr(pad + pw / 2, pad + pw / 2, C - pw, C - pw, Math.max(1, radius - pw / 2)); g.stroke();
    const text = ${JSON.stringify(String(slot))};
    g.font = 'bold ' + Math.round(33 * k) + 'px -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    const m = g.measureText(text);
    const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const top = pad + barH + pw, bottom = pad + C - pw;
    const x = pad + (C - inkW) / 2 + m.actualBoundingBoxLeft;
    const y = top + (bottom - top - inkH) / 2 + m.actualBoundingBoxAscent;
    g.fillStyle = '#fff'; g.fillText(text, x, y);
    const bytes = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  })()`;
}

/** 저장해 둔 그림, 없으면 이 슬롯의 빈 탭(about:blank)에서 그려 저장. 빈 탭이 없으면 기본 그리기. */
async function dockImage(slot: number): Promise<string> {
  const file = pngPath(slot);
  if (fs.existsSync(file)) return fs.readFileSync(file).toString('base64');
  let b64: string | undefined;
  const blank = (await listPages(slot, 3000).catch(() => [])).find((p) => p.url === 'about:blank');
  if (blank) {
    const s = await pageSession(slot, blank.id).catch(() => undefined);
    const r = await s?.evaluate<string>(drawScript(slot, colorOf(slot)), { awaitPromise: true, timeoutMs: 5000 }).catch(() => undefined);
    if (typeof r?.value === 'string' && r.value.length > 100) b64 = r.value;
  }
  if (!b64) return encodePng(renderIcon(slot, SIZE), SIZE).toString('base64'); // 저장하지 않음: 다음에 빈 탭이 있으면 제대로 그린다
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return b64;
}

/** 이 프로세스가 이미 아이콘을 넣은 Chrome (슬롯:PID) */
const applied = new Set<string>();

/** macOS에서만: 슬롯 Chrome의 Dock 아이콘을 슬롯 아이콘으로. 실패해도 조용히 넘어간다 (보기용 기능). */
export async function applyDock(slot: number, pid: number | undefined): Promise<void> {
  if (!DOCK_SUPPORTED) return;
  const key = `${slot}:${pid}`;
  if (applied.has(key)) return;
  try {
    const image = await dockImage(slot);
    const conn = await browserConnection(slot);
    await conn.send('Browser.setDockTile', { image }, 5000);
    applied.add(key);
  } catch {
    // 다음에 붙을 때 다시 시도
  }
}
