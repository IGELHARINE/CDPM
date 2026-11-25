// macOS 전용: 슬롯 Chrome의 Dock 아이콘을 슬롯 색·번호 아이콘으로 바꾼다 (Windows 작업표시줄 아이콘과 같은 디자인).
// Chrome의 CDP 명령 Browser.setDockTile을 쓴다. 앱 복사·서명 변경 같은 Chrome 수정은 하지 않는다.
// 다른 OS에서는 아무것도 하지 않는다 (Windows 작업표시줄은 win32.ts / watcher.ts가 따로 맡는다).
import fs from 'node:fs';
import path from 'node:path';
import { browserConnection } from '../cdp/sessions.js';
import { paths } from '../paths.js';
import { encodePng, renderIcon } from './icon.js';

export const DOCK_SUPPORTED = process.platform === 'darwin';

/** 그리는 방식을 바꾸면 올린다 (저장해 둔 그림을 다시 만든다). */
const DOCK_VERSION = 2;
const SIZE = 512;

const pngPath = (slot: number) => path.join(path.dirname(paths.icon(slot)), `${slot}-dock-v${DOCK_VERSION}.png`);

/** Dock에 넣을 그림 (Windows 아이콘과 같은 그리기: 슬롯 색 전자시계 숫자). 한 번 그리면 저장해 두고 다시 쓴다. */
function dockImage(slot: number): string {
  const file = pngPath(slot);
  if (fs.existsSync(file)) return fs.readFileSync(file).toString('base64');
  const png = encodePng(renderIcon(slot, SIZE), SIZE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    // 예전 디자인으로 저장해 둔 그림은 지운다
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (name !== path.basename(file) && new RegExp(`^${slot}-dock-v\\d+\\.png$`).test(name)) fs.rmSync(path.join(path.dirname(file), name), { force: true });
    }
  } catch {
    // 저장을 못 해도 그림은 쓴다 (다음에 다시 그린다)
  }
  return png.toString('base64');
}

/** 이 프로세스가 이미 아이콘을 넣은 Chrome (슬롯:PID) */
const applied = new Set<string>();

/** macOS에서만: 슬롯 Chrome의 Dock 아이콘을 슬롯 아이콘으로. 실패해도 조용히 넘어간다 (보기용 기능). */
export async function applyDock(slot: number, pid: number | undefined): Promise<void> {
  if (!DOCK_SUPPORTED) return;
  const key = `${slot}:${pid}`;
  if (applied.has(key)) return;
  try {
    const image = dockImage(slot);
    const conn = await browserConnection(slot);
    await conn.send('Browser.setDockTile', { image }, 5000);
    if (applied.size > 200) applied.clear(); // 끝난 Chrome(pid)의 기록이 쌓이지 않게
    applied.add(key);
  } catch {
    // 다음에 붙을 때 다시 시도
  }
}
