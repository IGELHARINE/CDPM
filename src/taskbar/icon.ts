// 슬롯 번호 아이콘을 외부 라이브러리 없이 그린다: 거리장(SDF) 안티앨리어싱 → PNG → ICO.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { paths } from '../paths.js';
import { colorOf, hexToRgb } from '../slots.js';
import { renderPngsWithGdi } from './icon-gdi.js';

export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
/**
 * Windows 작업표시줄은 아이콘 파일의 "큰 아이콘" 항목(배율 100%에서 32px)을 꺼내 3/4 크기(24px)로 줄여 그린다.
 * 그대로 두면 흐려지므로, 큰 아이콘 항목에는 3/4 크기로 그린 그림을 줄인 결과가 정확히 그 그림이 되도록 미리 보정해 넣는다.
 * (항목 크기 → 작업표시줄에 보이는 크기: 32→24, 40→30, 48→36, 64→48. 배율 100/125/150/200%)
 */
const TASKBAR_SOURCE: Record<number, number> = { 32: 24, 40: 30, 48: 36, 64: 48 };
const RENDER_SIZES = [...new Set([...ICON_SIZES.filter((s) => !(s in TASKBAR_SOURCE)), ...Object.values(TASKBAR_SOURCE)])].sort((a, b) => a - b);
/** 그리는 방식을 바꾸면 올린다. 저장된 아이콘을 다시 만들게 된다. */
export const ICON_VERSION = 19;

type Pt = [number, number];
type Seg = [Pt, Pt];

// ---- 숫자 글리프 (단위 상자: 폭 GW, 높이 1, y는 아래로) ----
const GW = 0.6;
const STROKE = 0.17;
const M = STROKE / 2;
const L = M, R = GW - M, T = M, B = 1 - M, CX = GW / 2, MID = 0.5;
const RX = (R - L) / 2;

function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

function quad(p0: Pt, c: Pt, p1: Pt, n = 16): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return pts;
}

const poly = (...pts: Pt[]): Pt[] => pts;

function six(): Pt[][] {
  const ry = (B - 0.4) / 2;
  const cy = B - ry;
  return [
    arc(CX, cy, RX, ry, 0, 360, 40),
    quad([R - 0.04, T + 0.02], [L, T + 0.02], [L, cy]),
  ];
}

const GLYPHS: Record<string, Pt[][]> = {
  '0': [[...arc(CX, T + RX, RX, RX, 180, 360), ...arc(CX, B - RX, RX, RX, 0, 180), [L, T + RX]]],
  '1': [poly([CX + 0.06, T], [CX + 0.06, B]), poly([CX + 0.06, T], [L + 0.02, T + 0.2])],
  '2': [[...arc(CX, T + RX * 0.95, RX, RX * 0.95, 195, 375), [L, B], [R, B]]],
  '3': [
    arc(CX, T + (MID - T) / 2, RX * 0.92, (MID - T) / 2, 200, 450),
    arc(CX, MID + (B - MID) / 2, RX, (B - MID) / 2, 270, 520),
  ],
  '4': [poly([R - 0.1, B], [R - 0.1, T], [L, 0.68], [R, 0.68])],
  '5': [
    poly([R, T], [L + 0.03, T], [L + 0.01, 0.47]),
    arc(CX, B - (B - 0.4) / 2, RX, (B - 0.4) / 2, 215, 505),
  ],
  '6': six(),
  '7': [poly([L, T], [R, T], [L + 0.1, B])],
  '8': [
    arc(CX, T + (MID - T) / 2, RX * 0.86, (MID - T) / 2, 0, 360, 40),
    arc(CX, MID + (B - MID) / 2, RX, (B - MID) / 2, 0, 360, 40),
  ],
  '9': six().map((line) => line.map(([x, y]) => [GW - x, 1 - y] as Pt)),
};

function segmentsFor(text: string, size: number): { segs: Seg[]; stroke: number } {
  const gap = 0.1;
  const advance = GW + gap;
  const textW = text.length * GW + (text.length - 1) * gap;
  // 한 자리는 높이로, 두 자리는 폭으로 크기가 정해진다.
  const scale = Math.min(size * 0.64, (size * 0.8) / textW);
  const ox = (size - textW * scale) / 2;
  const oy = (size - scale) / 2;
  const segs: Seg[] = [];
  [...text].forEach((ch, i) => {
    for (const line of GLYPHS[ch] ?? []) {
      for (let k = 0; k + 1 < line.length; k++) {
        const a = line[k], b = line[k + 1];
        segs.push([
          [ox + (a[0] + i * advance) * scale, oy + a[1] * scale],
          [ox + (b[0] + i * advance) * scale, oy + b[1] * scale],
        ]);
      }
    }
  });
  return { segs, stroke: STROKE * scale };
}

function distToSeg(px: number, py: number, [[ax, ay], [bx, by]]: Seg): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/** 둥근 사각형의 부호 있는 거리 (안쪽이 음수). */
function roundRectSdf(px: number, py: number, size: number, r: number): number {
  const h = size / 2;
  const qx = Math.abs(px - h) - (h - r);
  const qy = Math.abs(py - h) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** RGBA 픽셀 (size×size×4). */
export function renderIcon(slot: number, size: number): Buffer {
  const [br, bg, bb] = hexToRgb(colorOf(slot));
  const { segs, stroke } = segmentsFor(String(slot), size);
  const half = stroke / 2;
  const radius = size * 0.2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const bgCov = clamp01(0.5 - roundRectSdf(px, py, size, radius));
      let d = Infinity;
      for (const s of segs) {
        const v = distToSeg(px, py, s);
        if (v < d) d = v;
      }
      const fg = clamp01(half - d + 0.5);
      const i = (y * size + x) * 4;
      out[i] = Math.round(br + (255 - br) * fg);
      out[i + 1] = Math.round(bg + (255 - bg) * fg);
      out[i + 2] = Math.round(bb + (255 - bb) * fg);
      out[i + 3] = Math.round(255 * bgCov);
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

/** Windows에서는 GDI+로 유리 브라우저 창 디자인을, 그 밖에서는 기본 그리기(둥근 사각형 + 선 숫자)를 쓴다. */
export function buildIcon(slot: number): Buffer {
  const gdi = renderPngsWithGdi(slot, colorOf(slot), RENDER_SIZES);
  const pixels = (size: number) => (gdi ? gdi.get(size)!.bgra : rgbaToBgra(renderIcon(slot, size)));
  return encodeIco(ICON_SIZES.map((size) => {
    if (size >= 256) return { size, data: gdi ? gdi.get(size)!.png : encodePng(renderIcon(slot, size), size) };
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
  fs.writeFileSync(file, buildIcon(slot));
  for (const name of fs.readdirSync(dir)) {
    if (name !== path.basename(file) && (name === `${slot}.ico` || name === `${slot}.ico.v` || new RegExp(`^${slot}-v\\d+\\.ico$`).test(name))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return file;
}
