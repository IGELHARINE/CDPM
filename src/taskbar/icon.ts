// 슬롯 번호 아이콘을 외부 라이브러리 없이 그린다: 거리로 계산한 부드러운 가장자리 → PNG → ICO.
// 모양: 배경 없이 슬롯 색 전자시계(7세그먼트) 숫자 + 아래 그림자. 글꼴을 쓰지 않아 Windows·macOS·Linux에서 똑같이 나온다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { paths } from '../paths.js';
import { colorOf, hexToRgb } from '../slots.js';

export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
/**
 * Windows 작업표시줄은 아이콘 파일의 "큰 아이콘" 항목(배율 100%에서 32px)을 꺼내 3/4 크기(24px)로 줄여 그린다.
 * 그대로 두면 흐려지므로, 큰 아이콘 항목에는 3/4 크기로 그린 그림을 줄인 결과가 정확히 그 그림이 되도록 미리 보정해 넣는다.
 * (항목 크기 → 작업표시줄에 보이는 크기: 32→24, 40→30, 48→36, 64→48. 배율 100/125/150/200%)
 */
const TASKBAR_SOURCE: Record<number, number> = { 32: 24, 40: 30, 48: 36, 64: 48 };
/** 그리는 방식을 바꾸면 올린다. 저장된 아이콘을 다시 만들게 된다. */
export const ICON_VERSION = 20;

// ---- 7세그먼트 숫자 (전자시계 모양). 배경 없이 슬롯 색 숫자만 떠 있고, 아래로 옅은 그림자가 진다 ----
/** 숫자마다 켜지는 세그먼트 (a 위, b 오른쪽 위, c 오른쪽 아래, d 아래, e 왼쪽 아래, f 왼쪽 위, g 가운데) */
const LIT: Record<string, string> = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };

/** 세그먼트 하나: 가운데(cx, cy), 길이 len, 두께 t. 양 끝이 뾰족한 육각형 막대. */
interface Bar { cx: number; cy: number; len: number; t: number; horizontal: boolean }

/** 아이콘 크기에 대한 비율: 숫자 높이, 숫자가 쓸 수 있는 폭, 글자 폭(높이 대비), 글자 사이(폭 대비), 세그먼트 두께(폭 대비), 세그먼트 사이 틈(두께 대비) */
const DIGIT_H = 0.8, AREA_W = 0.92, DIGIT_W = 0.56, SPACING = 0.28, THICK = 0.2, GAP = 0.12;
/** 그림자: 아래로 떨어지는 거리, 번지는 반경(아이콘 크기 대비), 진하기 */
const SHADOW_DY = 1.6 / 64, SHADOW_BLUR = 2.4 / 64, SHADOW_ALPHA = 0.55;

/** 번호의 켜진 세그먼트들. 한 자리·두 자리 모두 아이콘 가운데에 온다 ("1"처럼 한쪽만 켜지는 숫자도 보이는 부분 기준으로). */
export function barsFor(text: string, size: number): Bar[] {
  let h = size * DIGIT_H, w = h * DIGIT_W, sp = w * SPACING;
  const fit = Math.min(1, (size * AREA_W) / (text.length * w + (text.length - 1) * sp));
  h *= fit; w *= fit; sp *= fit;
  let t = w * THICK;
  // 작은 크기(작업표시줄 16~48px 등)는 두께와 위치를 정수 픽셀에 맞춘다: 세그먼트의 곧은 변이 픽셀 경계에 놓여 번지지 않는다
  const snap = size <= 64 ? Math.round : (v: number) => v;
  if (size <= 64) {
    t = Math.max(1, Math.round(t));
    h = Math.max(t * 3 + 2, Math.round(h));
    if ((h - t) % 2) h += 1;        // 가운데 세그먼트가 위·아래 한가운데의 정수 픽셀에 오게
    w = Math.max(t * 2 + 1, Math.round(w));
    sp = Math.max(1, Math.round(sp));
  }
  const gap = size <= 64 ? Math.min(0.5, t * GAP) : t * GAP;
  const lh = w - t - gap * 2, lv = (h - t) / 2 - gap * 2, q = (h - t) / 4;
  const x0 = snap((size - (text.length * w + (text.length - 1) * sp)) / 2), y = snap((size - h) / 2);
  const bars: Bar[] = [];
  [...text].forEach((ch, i) => {
    const x = x0 + i * (w + sp);
    const all: Record<string, Bar> = {
      a: { cx: x + w / 2, cy: y + t / 2, len: lh, t, horizontal: true },
      g: { cx: x + w / 2, cy: y + h / 2, len: lh, t, horizontal: true },
      d: { cx: x + w / 2, cy: y + h - t / 2, len: lh, t, horizontal: true },
      f: { cx: x + t / 2, cy: y + t / 2 + q, len: lv, t, horizontal: false },
      b: { cx: x + w - t / 2, cy: y + t / 2 + q, len: lv, t, horizontal: false },
      e: { cx: x + t / 2, cy: y + h / 2 + q, len: lv, t, horizontal: false },
      c: { cx: x + w - t / 2, cy: y + h / 2 + q, len: lv, t, horizontal: false },
    };
    for (const k of LIT[ch] ?? '') bars.push(all[k]);
  });
  // 켜진 부분의 좌우 끝을 기준으로 가운데에 놓는다
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    const half = b.horizontal ? b.len / 2 : b.t / 2;
    lo = Math.min(lo, b.cx - half);
    hi = Math.max(hi, b.cx + half);
  }
  const dx = bars.length ? snap(size / 2 - (lo + hi) / 2) : 0;
  return bars.map((b) => ({ ...b, cx: b.cx + dx }));
}

/** 점에서 세그먼트까지의 거리 (안쪽이 음수). 양 끝은 45°로 뾰족하다. */
function barDist(px: number, py: number, b: Bar): number {
  const along = Math.abs(b.horizontal ? px - b.cx : py - b.cy);
  const across = Math.abs(b.horizontal ? py - b.cy : px - b.cx);
  return across + Math.max(0, along - (b.len / 2 - b.t / 2)) - b.t / 2;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** RGBA 픽셀 (size×size×4, 알파를 곱하지 않은 색). 배경은 투명. shadow: 그림자 진하기 (0이면 그림자 없음). */
export function renderIcon(slot: number, size: number, shadow = SHADOW_ALPHA): Buffer {
  const [cr, cg, cb] = hexToRgb(colorOf(slot));
  const bars = barsFor(String(slot), size);
  const dy = size * SHADOW_DY, blur = Math.max(0.75, size * SHADOW_BLUR);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = Infinity, ds = Infinity;
      for (const b of bars) {
        const v = barDist(px, py, b);
        if (v < d) d = v;
        const s = barDist(px, py - dy, b);
        if (s < ds) ds = s;
      }
      const fg = clamp01(0.5 - d);                                   // 숫자가 이 픽셀을 덮는 정도
      const sh = shadow * clamp01(0.5 - ds / (2 * blur));      // 그림자 (가장자리가 blur만큼 번짐)
      const alpha = fg + sh * (1 - fg);
      const i = (y * size + x) * 4;
      if (alpha <= 0) continue;
      // 숫자(슬롯 색)를 그림자(검정) 위에 올린다
      out[i] = Math.round((cr * fg) / alpha);
      out[i + 1] = Math.round((cg * fg) / alpha);
      out[i + 2] = Math.round((cb * fg) / alpha);
      out[i + 3] = Math.round(255 * alpha);
    }
  }
  return out;
}

export function encodePng(rgba: Buffer, width: number, height = width): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 비트 깊이
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** BGRA(위에서 아래로) → ICO용 32비트 DIB (BITMAPINFOHEADER + 아래에서 위로 픽셀 + AND 마스크). */
export function encodeDib(bgra: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40);
  const maskRow = Math.ceil(size / 32) * 4;
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 색 + 마스크 높이
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]); // 마스크는 0 (투명도는 알파 채널로)
}

/**
 * ICO 만들기. Windows 탐색기(작업표시줄)는 작은 크기의 PNG 항목을 쓰지 않고 256px PNG를 줄여 써서 흐려진다.
 * 그래서 256px만 PNG로, 나머지 크기는 BMP(DIB)로 넣는다.
 */
export function encodeIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/**
 * 작업표시줄이 줄이는 방식(픽셀 하나짜리 시험 아이콘으로 실측): 입력 4칸(a,b,c,d) → 출력 3칸, y0 = ¾a+¼b, y1 = ⅓b+⅔c, y2 = 1/12·c+11/12·d.
 * 칸 4개에 식 3개라 b 하나를 고를 수 있다. 값은 0~1을 넘을 수 없으므로, 잘라낸 뒤 실제로 줄였을 때의 오차가 가장 작은 b를 고르고,
 * 오차가 같으면 이웃 칸끼리 가장 고른 b를 고른다 (평평한 곳은 평평하게 두어 줄이는 방식이 조금 달라도 무늬가 생기지 않게).
 */
function expandLine(y: Float64Array): Float64Array {
  const out = new Float64Array((y.length / 3) * 4);
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let k = 0; k < y.length / 3; k++) {
    const [y0, y1, y2] = [y[3 * k], y[3 * k + 1], y[3 * k + 2]];
    let best = [y0, y0, y0, y0], bestErr = Infinity;
    for (let i = 0; i <= 255; i++) {
      const b = i / 255;
      const a = clamp((y0 - b / 4) / 0.75);
      const c = clamp((y1 - b / 3) / (2 / 3));
      const d = clamp((y2 - c / 12) / (11 / 12));
      const err = (0.75 * a + b / 4 - y0) ** 2 + (b / 3 + (2 * c) / 3 - y1) ** 2 + (c / 12 + (11 * d) / 12 - y2) ** 2;
      const score = err + 1e-4 * ((a - b) ** 2 + (b - c) ** 2 + (c - d) ** 2);
      if (score < bestErr) { bestErr = score; best = [a, b, c, d]; }
    }
    out.set(best, 4 * k);
  }
  return out;
}

/** BGRA(n×n, 위에서 아래로) → 작업표시줄이 3/4로 줄이면 원래 그림이 되는 BGRA(4n/3 × 4n/3). */
export function precompensate(bgra: Buffer, n: number): Buffer {
  const m = (n / 3) * 4;
  // 알파를 곱한 값으로 계산 (보간은 알파를 곱한 색끼리 섞이므로)
  const src = Array.from({ length: 4 }, () => new Float64Array(n * n));
  for (let i = 0; i < n * n; i++) {
    const al = bgra[i * 4 + 3] / 255;
    for (let ch = 0; ch < 3; ch++) src[ch][i] = (bgra[i * 4 + ch] / 255) * al;
    src[3][i] = al;
  }
  const out = Buffer.alloc(m * m * 4);
  const planes = src.map((p) => {
    const rows = new Float64Array(n * m);
    for (let y = 0; y < n; y++) rows.set(expandLine(p.subarray(y * n, (y + 1) * n)), y * m);
    const full = new Float64Array(m * m);
    const col = new Float64Array(n);
    for (let x = 0; x < m; x++) {
      for (let y = 0; y < n; y++) col[y] = rows[y * m + x];
      const e = expandLine(col);
      for (let y = 0; y < m; y++) full[y * m + x] = e[y];
    }
    return full;
  });
  for (let i = 0; i < m * m; i++) {
    const al = planes[3][i];
    out[i * 4 + 3] = Math.round(al * 255);
    for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = al > 0 ? Math.round(Math.min(1, planes[ch][i] / al) * 255) : 0;
  }
  return out;
}

const rgbaToBgra = (rgba: Buffer) => {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) { out[i] = rgba[i + 2]; out[i + 2] = rgba[i]; }
  return out;
};

/** 슬롯 아이콘 파일(.ico) 내용. 모든 크기를 같은 그리기로 만든다. */
export function buildIcon(slot: number): Buffer {
  const pixels = (size: number) => rgbaToBgra(renderIcon(slot, size));
  return encodeIco(ICON_SIZES.map((size) => {
    if (size >= 256) return { size, data: encodePng(renderIcon(slot, size), size) };
    const src = TASKBAR_SOURCE[size];
    return { size, data: encodeDib(src && process.platform === 'win32' ? precompensate(pixels(src), src) : pixels(size), size) };
  }));
}

/**
 * 슬롯 아이콘 파일 경로. 없으면 새로 만든다.
 * 파일 이름에 그리기 버전을 넣는다(예: 3-v2.ico): Windows 작업표시줄은 같은 경로의 아이콘을 캐시해 두므로,
 * 디자인을 바꿔도 경로가 같으면 옛 그림이 계속 보인다. 이전 버전 파일은 지운다.
 */
export function ensureIconFile(slot: number): string {
  const dir = path.dirname(paths.icon(slot));
  const file = path.join(dir, `${slot}-v${ICON_VERSION}.ico`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  // 다른 CDPM이 동시에 만들 수 있으므로 임시 파일에 쓰고 이름을 바꾼다 (반쯤 쓴 아이콘이 쓰이지 않게)
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buildIcon(slot));
  fs.renameSync(tmp, file);
  for (const name of fs.readdirSync(dir)) {
    if (name !== path.basename(file) && (name === `${slot}.ico` || name === `${slot}.ico.v` || new RegExp(`^${slot}-v\\d+\\.ico$`).test(name))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return file;
}
