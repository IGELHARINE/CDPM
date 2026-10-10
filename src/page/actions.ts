// 클릭·입력·선택·키·스크롤·이동·대기·평가·본문·캡처.
// 원칙: 진짜 입력 이벤트(Input.*)를 보내고, 판단용 스크립트는 전부 isolated world에서 실행한다.
// 창 크기·뷰포트·포커스 같은 사용자 환경은 절대 바꾸지 않는다.
import type { CdpConnection } from '../cdp/client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpTimeoutError } from '../cdp/client.js';
import { downloadStartedSince } from '../cdp/downloads.js';
import { pageSession, type PageSession, type RefTarget } from '../cdp/sessions.js';
import { CdpmError } from '../errors.js';
import { decodeUrl, sleep } from '../util.js';
import { charKey, KNOWN_KEYS, macCommands, parseCombo, type KeyCombo } from './keys.js';
import { paginate } from './snapshot.js';

/** 브라우저 안에서 열리는 주소 종류. 그 밖(mailto:, tel:, 앱 전용 주소 등)은 OS의 다른 프로그램을 띄우므로 막는다. */
const SAFE_SCHEMES = ['http:', 'https:', 'about:', 'data:', 'blob:', 'file:', 'javascript:'];

export function externalScheme(url: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (!m) return undefined;
  const scheme = m[1].toLowerCase() + ':';
  return SAFE_SCHEMES.includes(scheme) ? undefined : scheme;
}

/** 사용자 클립보드를 쓰거나 읽는 키. 클립보드는 사람과 같이 쓰므로 보내지 않는다. */
const CLIPBOARD_COMBOS = [/^(control|ctrl|meta|cmd)\+(c|x|v)$/i, /^(control|ctrl)\+insert$/i, /^shift\+(insert|delete)$/i];
const IS_MAC = process.platform === 'darwin';

const DIALOG_NOTE = 'CDPM은 알림창을 처리하지 않습니다. 사용자에게 Chrome 창에서 직접 처리해 달라고 요청하세요.';

/** 행동 도중 페이지가 알림창을 띄움. 행동 자체는 이루어진 것이므로 오류가 아니라 결과로 알린다. */
export class DialogInterrupt extends CdpmError {}

async function send<T = any>(s: PageSession, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const r = await s.sendUnlessDialog<T>(method, params, timeoutMs);
  if (r === 'dialog') {
    const d = s.dialog;
    throw new DialogInterrupt(`${d ? `${d.type} 알림창이 떴어요: "${d.message}"\n` : '알림창이 떴어요.\n'}${DIALOG_NOTE}`);
  }
  return r;
}

function targetOf(s: PageSession, agent: string, ref: string): RefTarget {
  const t = s.refsFor(agent).get(ref.trim());
  if (!t) {
    throw new CdpmError(`모르는 ref예요: "${ref}". 페이지가 바뀌었거나, 다른 탭의 ref이거나, 이 에이전트(${agent})가 이 탭에서 찍은 스냅샷이 없어요. browser_snapshot을 다시 찍으세요.`);
  }
  return t;
}

/**
 * ref가 속한 대상과, 그 대상 화면 좌표를 탭 화면 전체 좌표로 바꾸는 차이.
 * 다른 사이트 iframe(별도 프로세스) 안의 요소는 그 iframe의 연결(fs)로 다루고, 마우스·키는 탭(s)으로 보낸다
 * (Chrome이 그 좌표·포커스에 맞는 iframe으로 진짜 입력을 전달한다).
 */
interface Located { fs: PageSession; dx: number; dy: number }
async function locate(s: PageSession, t: RefTarget): Promise<Located> {
  if (!t.targetId || !t.owner) return { fs: s, dx: 0, dy: 0 };
  const parent = await locate(s, t.owner);
  await send(parent.fs, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: t.owner.backendNodeId }).catch((e) => {
    if (e instanceof DialogInterrupt) throw e;
  });
  // 스크롤한 뒤 화면이 실제로 다시 그려질 때까지 (그 전에 누르면 옛 위치 기준으로 판정돼 iframe 밖이 눌림. 뒤 탭에서 특히)
  await parent.fs.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true, timeoutMs: 3000 }).catch(() => undefined);
  let content: number[];
  try {
    ({ model: { content } } = await send<{ model: { content: number[] } }>(parent.fs, 'DOM.getBoxModel', { backendNodeId: t.owner.backendNodeId }));
  } catch (e) {
    if (e instanceof DialogInterrupt) throw e;
    throw new CdpmError('iframe의 위치를 구할 수 없어요 (iframe이 숨겨졌거나 사라졌을 수 있어요). browser_snapshot을 다시 찍으세요.');
  }
  const fs = await pageSession(s.slot, t.targetId);
  return { fs, dx: parent.dx + content[0], dy: parent.dy + content[1] };
}

/** 요소를 isolated world 객체로 가져온다. */
async function objectOf(s: PageSession, t: RefTarget): Promise<string> {
  try {
    return await s.inWorld(t.frameId, async (executionContextId) => {
      const { object } = await send<{ object: { objectId: string } }>(s, 'DOM.resolveNode', { backendNodeId: t.backendNodeId, executionContextId, objectGroup: 'cdpm' });
      return object.objectId;
    });
  } catch (e) {
    if (e instanceof DialogInterrupt) throw e;
    throw new CdpmError('요소가 페이지에서 사라졌어요. browser_snapshot을 다시 찍으세요.');
  }
}

async function callOn<T = any>(s: PageSession, objectId: string, fn: string, args: { objectId?: string; value?: unknown }[] = []): Promise<T> {
  const r = await send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(s, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: fn, arguments: args, returnByValue: true,
  });
  if (r.exceptionDetails) throw new CdpmError(`페이지 함수 실행 오류: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value as T;
}

/** 함수 결과를 값이 아니라 객체로 받는다 (예: 섀도 DOM의 호스트 요소). */
async function callOnObject(s: PageSession, objectId: string, fn: string): Promise<string | undefined> {
  const r = await send<{ result: { objectId?: string } }>(s, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, objectGroup: 'cdpm' });
  return r.result.objectId;
}

/** 알림창이 떠 있으면 렌더러가 멈춰 응답이 없으므로 건너뛴다. */
const release = async (s: PageSession) => {
  if (s.dialog) return;
  await s.send('Runtime.releaseObjectGroup', { objectGroup: 'cdpm' }, 2000).catch(() => undefined);
};

// ---------- 요소 정보 ----------

const DATE_LIKE = ['date', 'time', 'datetime-local', 'month', 'week'];
const DATE_FORMAT: Record<string, string> = {
  date: 'YYYY-MM-DD (예: 2026-10-08)',
  time: 'HH:MM 24시간 (예: 19:30)',
  'datetime-local': 'YYYY-MM-DDTHH:MM (예: 2026-10-08T19:30)',
  month: 'YYYY-MM (예: 2026-10)',
  week: 'YYYY-Www (예: 2026-W41)',
};

interface ElementInfo {
  tag: string;
  inputType: string;
  /** 날짜·시간 입력칸이면 그 type (요소 자신이거나, 그 입력칸 내부의 칸일 때) */
  dateType: string;
  inDateHost: boolean;
  fileInput: boolean;
  select: boolean;
  editable: 'value' | 'content' | 'none';
  connected: boolean;
}

const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const tag = el ? el.tagName.toLowerCase() : '';
  const host = el && el.getRootNode && el.getRootNode().host;
  const dateOf = (n) => n && n.tagName === 'INPUT' && ${JSON.stringify(DATE_LIKE)}.includes(n.type) ? n.type : '';
  const selfDate = dateOf(el), hostDate = dateOf(host);
  const control = tag === 'label' ? el.control : null;
  const isFile = (n) => !!n && n.tagName === 'INPUT' && n.type === 'file';
  return {
    tag, inputType: tag === 'input' ? el.type : '',
    dateType: selfDate || hostDate, inDateHost: !selfDate && !!hostDate,
    fileInput: isFile(el) || isFile(control),
    select: tag === 'select' || tag === 'option',
    editable: (tag === 'input' || tag === 'textarea') ? 'value' : (el && el.isContentEditable ? 'content' : 'none'),
    connected: !!el && el.isConnected,
  };
}`;

async function describe(s: PageSession, objectId: string, ref?: string): Promise<ElementInfo> {
  const info = await callOn<ElementInfo>(s, objectId, DESCRIBE);
  if (!info.connected) {
    throw new CdpmError(`오래된 ref예요${ref ? `: "${ref}"` : ''}. 그 요소는 페이지가 바뀌면서 사라졌어요 (새 요소로 교체됨). browser_snapshot을 다시 찍으세요.`);
  }
  return info;
}

// ---------- 좌표·가림 ----------

async function clickPoint(s: PageSession, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send(s, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch((e) => {
    if (e instanceof DialogInterrupt) throw e;
  });
  let quads: number[][];
  try {
    ({ quads } = await send<{ quads: number[][] }>(s, 'DOM.getContentQuads', { backendNodeId }));
  } catch (e) {
    if (e instanceof DialogInterrupt) throw e;
    throw new CdpmError('요소의 위치를 구할 수 없어요 (화면에 그려지지 않는 요소일 수 있어요). browser_snapshot을 다시 찍어 보세요.');
  }
  const q = quads.find((quad) => area(quad) > 1);
  if (!q) throw new CdpmError('요소가 화면에서 크기가 0이에요 (숨겨져 있을 수 있어요).');
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

function area(q: number[]) {
  let a = 0;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    a += q[i] * q[j + 1] - q[j] * q[i + 1];
  }
  return Math.abs(a / 2);
}

type Cover = { blocked: string } | { overlay: string; href: string } | null;

/**
 * 그 좌표에 실제로 대상 요소(또는 그 자손)가 있는지. 아니면 가린 요소 설명.
 * 예외: 카드 전체를 덮는 투명 링크(같은 카드 안에 있고 대상을 다 덮는 a/button)는 사람이 눌러도 그 링크가 눌리므로
 * 막지 않고 overlay로 돌려준다 (구글 뉴스 카드 등).
 */
async function coveringElement(s: PageSession, t: RefTarget, targetObj: string, x: number, y: number): Promise<Cover> {
  let hit: number;
  try {
    ({ backendNodeId: hit } = await send<{ backendNodeId: number }>(s, 'DOM.getNodeForLocation', {
      x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true,
    }));
  } catch (e) {
    if (e instanceof DialogInterrupt) throw e;
    return null; // 확인 불가 → 그냥 클릭
  }
  if (hit === t.backendNodeId) return null;
  let hitObj: string;
  try {
    hitObj = await objectOf(s, { backendNodeId: hit, frameId: t.frameId });
  } catch (e) {
    if (e instanceof DialogInterrupt) throw e;
    return null; // 다른 프레임의 요소(보통 iframe 자체) → 그냥 클릭
  }
  return callOn<Cover>(s, targetObj, `function (hit, x, y) {
    if (hit.nodeName === 'IFRAME' || hit.nodeName === 'FRAME') return null;
    const inside = (n) => { while (n) { if (n === this) return true; n = n.parentNode || n.host; } return false; };
    if (inside(hit)) return null;
    // pointer-events:none인 투명 덮개 등은 클릭을 받지 않는다: 실제로 클릭을 받을 요소를 다시 확인
    let real = document.elementFromPoint(x, y);
    while (real && real.shadowRoot) { const inner = real.shadowRoot.elementFromPoint(x, y); if (!inner || inner === real) break; real = inner; }
    if (real && inside(real)) return null;
    const el = hit.nodeType === 1 ? hit : hit.parentElement;
    if (!el) return { blocked: '알 수 없는 요소' };
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('alt') || '').trim().slice(0, 40);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const desc = '<' + el.tagName.toLowerCase() + id + cls + '>' + (label ? ' "' + label + '"' : '');
    // 카드를 덮는 투명 링크인지: 대상에서 6단계 안의 가까운 공통 조상을 갖고, 대상의 상자를 다 덮는 링크·버튼
    const link = el.closest('a[href], button, [role=link], [role=button]');
    if (link) {
      let common = this, depth = 0;
      while (common && !common.contains(link) && depth < 6) { common = common.parentElement; depth++; }
      const a = link.getBoundingClientRect(), b = this.getBoundingClientRect();
      const covers = a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
      if (common && common.contains(link) && common !== document.body && common !== document.documentElement && covers) {
        return { overlay: desc, href: link.href || '' };
      }
    }
    return { blocked: desc };
  }`, [{ objectId: hitObj }, { value: x }, { value: y }]);
}

async function mouseClick(s: PageSession, x: number, y: number, clickCount: number, visible: boolean) {
  // 뒤에 숨은 탭은 그리기가 멈춰 있어 mouseMoved가 수 초씩 걸린다 → 보이는 탭에서만 보낸다.
  if (visible) await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  for (let c = 1; c <= clickCount; c++) {
    await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c });
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c });
  }
}

// ---------- 페이지 이동 대기 ----------

type LoadState = 'complete' | 'interactive' | 'timeout' | 'download';

const LOAD_NOTE: Record<LoadState, string> = {
  complete: '로딩 완료',
  interactive: '본문 로딩 완료, 네트워크도 조용해짐 (load 이벤트 전)',
  timeout: '아직 로딩 중이에요 (네트워크가 느릴 수 있어요). 필요하면 browser_wait로 더 기다리세요',
  download: '파일 다운로드로 바뀌어서 페이지는 그대로예요',
};

/** 행동 뒤 페이지 이동이 시작되면 로딩을 기다린다. 이동이 없으면 거의 바로 돌아온다. */
async function settleAfter(s: PageSession, action: () => Promise<void>): Promise<string> {
  let started = false;
  let committed = false;
  let wake: () => void = () => {};
  const offs = [
    s.conn.on('Page.frameStartedNavigating', (p) => {
      if (p.navigationType !== 'sameDocument' && (!s.mainFrameId || p.frameId === s.mainFrameId)) { started = true; wake(); }
    }),
    s.conn.on('Page.frameRequestedNavigation', (p) => {
      if (!s.mainFrameId || p.frameId === s.mainFrameId) { started = true; wake(); }
    }),
    s.conn.on('Page.frameNavigated', (p) => {
      if (!p.frame.parentId) { started = committed = true; wake(); }
    }),
  ];
  try {
    await action();
    // 페이지에 가벼운 명령을 한 번 보내 응답을 받는다 = 페이지가 클릭·키 처리(링크 이동 요청 포함)를 다 끝냈다는 신호.
    // 이동을 요청했다면 그 이벤트는 이 왕복이 끝날 때쯤 이미 도착해 있다. 한 번 더 왕복해 늦게 오는 이벤트까지 받는다.
    for (let i = 0; i < 2 && !started; i++) {
      await s.evaluate('0', { timeoutMs: 10_000 }).catch(() => undefined);
      await s.send('Page.getNavigationHistory', {}, 10_000).catch(() => undefined);
    }
  } finally {
    offs.forEach((off) => off());
  }
  void wake;
  if (!started) return '';
  const state = await waitLoad(s, !committed);
  return `\n(페이지 이동: ${LOAD_NOTE[state]})`;
}

/**
 * 새 문서가 들어오고(needCommit) 로딩이 끝날 때까지. 시간이 아니라 신호로 판단한다.
 * - load 이벤트 → 완료
 * - DOMContentLoaded 뒤 네트워크 활동(요청 시작·끝)이 0.5초 동안 없음 → 본문 완료
 * - 상한(기본 30초)에 닿으면 오류가 아니라 '아직 로딩 중'이라는 사실만 알린다.
 */
async function waitLoad(s: PageSession, needCommit: boolean, maxMs = 30_000): Promise<LoadState> {
  const until = Date.now() + maxMs;
  const began = Date.now() - 2000; // 클릭 직후 시작된 다운로드도 잡도록 조금 앞부터
  let loaded = false;
  let dcl = false;
  let lastActivity = Date.now();
  let download = false;
  let navigated = false;
  const bump = () => { lastActivity = Date.now(); };
  const offs = [
    // 이동하려던 주소가 파일 다운로드로 바뀌면 페이지는 그대로 남는다 → 바로 끝낸다 (로딩을 기다리지 않음)
    s.conn.on('Page.downloadWillBegin', () => { download = true; }),
    s.conn.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) navigated = true; }),
    s.conn.on('Page.loadEventFired', () => { loaded = true; }),
    s.conn.on('Page.domContentEventFired', () => { dcl = true; bump(); }),
    s.conn.on('Network.requestWillBeSent', bump),
    s.conn.on('Network.loadingFinished', bump),
    s.conn.on('Network.loadingFailed', bump),
  ];
  try {
    if (needCommit) {
      while (!navigated && !loaded && !download && Date.now() < until) {
        if (downloadStartedSince(s.slot, began)) download = true;
        else await sleep(50);
      }
      if (download) return 'download';
      if (!navigated && !loaded) return 'timeout';
    }
    // 이미 끝났을 수도 있으니 한 번은 현재 상태를 직접 확인
    const r = await s.evaluate<string>('document.readyState', { timeoutMs: 10_000 }).catch(() => undefined);
    if (r?.value === 'complete') return 'complete';
    if (r?.value === 'interactive') dcl = true;
    while (Date.now() < until) {
      if (download || downloadStartedSince(s.slot, began)) return 'download';
      if (loaded || s.dialog) return 'complete';
      if (dcl && Date.now() - lastActivity >= 500) return 'interactive';
      await sleep(50);
    }
    return dcl ? 'interactive' : 'timeout';
  } finally {
    offs.forEach((off) => off());
  }
}

// ---------- 도구별 동작 ----------

export async function click(s: PageSession, agent: string, ref: string, double = false): Promise<string> {
  await s.ensureNoDialog();
  const t = targetOf(s, agent, ref);
  const { fs, dx, dy } = await locate(s, t);
  try {
    const obj = await objectOf(fs, t);
    const info = await describe(fs, obj, ref);
    if (info.select) {
      throw new CdpmError(`클릭하지 않았어요: [${ref}]는 드롭다운(<select>)이라 누르면 사용자 화면에 목록 창이 떠요. browser_select로 항목을 고르세요.`);
    }
    const href = await callOn<string>(fs, obj, 'function () { const a = this.closest && this.closest("a[href]"); return a ? a.href : ""; }');
    const ext = href ? externalScheme(href) : undefined;
    if (ext) {
      throw new CdpmError(`클릭하지 않았어요: [${ref}]는 ${ext} 주소(${href.slice(0, 80)})라 누르면 사용자 PC의 다른 프로그램(메일·전화·앱 등)이 실행돼요.`);
    }
    const visible = (await s.visibility()) === 'visible';
    const local = await clickPoint(fs, t.backendNodeId);
    const x = local.x + dx, y = local.y + dy;
    const cover = await coveringElement(fs, t, obj, local.x, local.y);
    if (cover && 'blocked' in cover) throw new CdpmError(`클릭하지 않았어요: ${cover.blocked}이(가) [${ref}]를 가리고 있어요. 팝업을 닫거나 스크롤한 뒤 다시 시도하세요.`);
    const overlayExt = cover && cover.href ? externalScheme(cover.href) : undefined;
    if (overlayExt) {
      throw new CdpmError(`클릭하지 않았어요: [${ref}]를 덮은 링크가 ${overlayExt} 주소(${cover!.href.slice(0, 80)})라 누르면 사용자 PC의 다른 프로그램이 실행돼요.`);
    }
    // 이 클릭이 파일 선택 창을 열면(파일 칸·"첨부" 버튼 등) OS 창을 띄우지 않고 가로챈다 (CDPM이 누르는 동안만. 사람이 누르면 평소대로 뜸)
    let chooser: { backendNodeId: number; mode: string } | undefined;
    const offChooser = fs.conn.on('Page.fileChooserOpened', (p) => { chooser = p; });
    await fs.send('Page.setInterceptFileChooserDialog', { enabled: true }, 3000).catch(() => undefined);
    let note: string;
    try {
      note = await settleAfter(s, () => mouseClick(s, x, y, double ? 2 : 1, visible));
      if (!chooser) await fs.evaluate('0', { timeoutMs: 3000 }).catch(() => undefined);
    } finally {
      offChooser();
      await fs.send('Page.setInterceptFileChooserDialog', { enabled: false }, 3000).catch(() => undefined);
    }
    if (chooser) {
      s.fileChooser = { fs, backendNodeId: chooser.backendNodeId, multiple: chooser.mode === 'selectMultiple', at: Date.now() };
      note += `
파일 선택 창이 열리려 해서 사용자 화면에 띄우지 않고 대기 중이에요. browser_upload(files=[파일 경로${s.fileChooser.multiple ? ', 여러 개 가능' : ''}])로 바로 넣으세요.`;
    }
    let extra = '';
    if (!note && !s.dialog) {
      // 제출 버튼인데 페이지가 이동하지 않았으면, 폼 검증에 걸렸는지 확인해 알려준다
      const invalid = await callOn<string>(fs, obj, `function () {
        const btn = this.closest && this.closest('button, input[type=submit], input[type=image]');
        const form = btn && btn.form;
        if (!form || (btn.type && btn.type !== 'submit' && btn.type !== 'image')) return '';
        const bad = [...form.elements].find((e) => e.willValidate && !e.checkValidity());
        if (!bad) return '';
        const label = (bad.labels && bad.labels[0] && bad.labels[0].innerText.trim()) || bad.name || bad.id || bad.type;
        return label + ': ' + bad.validationMessage;
      }`).catch(() => '');
      if (invalid) extra = `\n[주의] 폼이 제출되지 않았어요 (페이지 검증에 걸림) — ${invalid}`;
    }
    return `${double ? '더블클릭' : '클릭'}했어요: [${ref}]${note}${extra}${downloadNote(s)}`;
  } finally {
    await release(fs);
  }
}

async function pressCombo(s: PageSession, combo: KeyCombo) {
  for (const m of combo.modifierKeys) {
    await send(s, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: combo.modifiers });
  }
  const { main } = combo;
  // 조합키(Shift 제외)가 있으면 글자를 입력하지 않는다.
  const text = combo.modifiers & ~8 ? undefined : main.text;
  const commands = IS_MAC ? macCommands(combo) : [];
  await send(s, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', key: main.key, code: main.code, windowsVirtualKeyCode: main.keyCode,
    modifiers: combo.modifiers, ...(text ? { text, unmodifiedText: text } : {}), ...(commands.length ? { commands } : {}),
  });
  await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: main.key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers: combo.modifiers });
  for (const m of [...combo.modifierKeys].reverse()) {
    await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: 0 });
  }
}

/** 이 탭이 사람이 지금 쓰고 있는 창(OS 포커스)인지. 그렇다면 키보드 입력이 사람 입력과 섞일 수 있다. */
async function humanFocusNote(s: PageSession): Promise<string> {
  if (s.isEmulating) return ''; // 숨은 탭을 그리는 중이면 hasFocus가 가짜로 true
  const r = await s.evaluate<boolean>('document.hasFocus()', { timeoutMs: 800 }).catch(() => undefined);
  return r?.value ? '\n[주의] 이 탭은 지금 사람이 쓰고 있는 창일 수 있어요 (Chrome 창이 맨 앞이고 이 탭이 열려 있음). 사람이 입력 중이면 글자가 섞일 수 있어요.' : '';
}

export async function pressKey(s: PageSession, key: string): Promise<string> {
  await s.ensureNoDialog();
  if (CLIPBOARD_COMBOS.some((re) => re.test(key.replace(/\s+/g, '')))) {
    throw new CdpmError(`"${key}"는 보내지 않았어요: 복사·붙여넣기는 사용자 PC의 클립보드를 덮어쓰거나 읽어요. 글자는 browser_type, 내용 확인은 browser_text를 쓰세요.`);
  }
  const combo = parseCombo(key);
  if (!combo) throw new CdpmError(`알 수 없는 키: "${key}". 예: Enter, Tab, Escape, ArrowDown, Control+A. 지원 키: ${KNOWN_KEYS.join(', ')}, 글자 한 개`);
  const human = await humanFocusNote(s);
  const note = await settleAfter(s, () => pressCombo(s, combo));
  return `키를 눌렀어요: ${key}${note}${human}`;
}

/** 날짜·시간 입력칸: 칸별 키 입력은 로케일마다 달라 불안정하므로 값을 직접 넣고 input/change 이벤트를 낸다. */
async function setDateLike(s: PageSession, obj: string, info: ElementInfo, text: string, ref: string): Promise<string> {
  const target = info.inDateHost ? await callOnObject(s, obj, 'function () { return this.getRootNode().host; }') : obj;
  if (!target) throw new CdpmError(`[${ref}] 날짜·시간 입력칸을 찾지 못했어요.`);
  // 형식이 틀리면 브라우저가 값을 비워 버리므로, 먼저 넣어 보고 틀리면 원래 값으로 되돌린다. 이벤트는 맞을 때만 낸다.
  const r = await callOn<{ ok: boolean; prev: string }>(s, target, `function (v) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const prev = this.value;
    set.call(this, v);
    if (this.value !== v) { set.call(this, prev); return { ok: false, prev }; }
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, prev };
  }`, [{ value: text }]);
  if (!r.ok) {
    throw new CdpmError(`[${ref}]는 ${info.dateType} 입력칸이에요. 형식이 맞지 않아 넣지 않았어요 (원래 값 ${JSON.stringify(r.prev)} 유지). 형식: ${DATE_FORMAT[info.dateType] ?? info.dateType}`);
  }
  return `입력했어요: [${ref}] ${JSON.stringify(text)} (${info.dateType} 입력칸에 값을 직접 넣음)`;
}

/** 글자마다 진짜 키 이벤트(keydown → keypress → input → keyup)를 보낸다. 사람이 친 것과 같은 이벤트 순서. */
async function typeChars(s: PageSession, text: string) {
  for (const ch of text) {
    const { def, shift } = charKey(ch);
    const modifiers = shift ? 8 : 0;
    await send(s, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers,
      text: def.text ?? ch, unmodifiedText: def.text ?? ch,
    });
    await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
  }
}

export async function type(s: PageSession, agent: string, ref: string, text: string, clear: boolean, submit: boolean, fast = false): Promise<string> {
  await s.ensureNoDialog();
  const t = targetOf(s, agent, ref);
  const { fs, dx, dy } = await locate(s, t);
  try {
    const obj = await objectOf(fs, t);
    const info = await describe(fs, obj, ref);
    if (info.dateType) {
      const msg = await setDateLike(fs, obj, info, text, ref);
      return submit ? msg + (await settleAfter(s, () => pressCombo(s, parseCombo('Enter')!))) : msg;
    }
    if (info.select) throw new CdpmError(`[${ref}]는 드롭다운(<select>)이에요. browser_select로 항목을 고르세요.`);
    if (info.fileInput) throw new CdpmError(`[${ref}]는 파일 선택 칸이에요. 파일은 browser_upload(ref="${ref}", files=[파일 경로])로 넣으세요.`);

    await send(fs, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId }).catch((e) => {
      if (e instanceof DialogInterrupt) throw e;
    });
    try {
      await send(fs, 'DOM.focus', { backendNodeId: t.backendNodeId });
    } catch (e) {
      if (e instanceof DialogInterrupt) throw e;
      // 포커스가 안 되는 요소면 클릭으로 포커스
      const { x, y } = await clickPoint(fs, t.backendNodeId);
      await mouseClick(s, x + dx, y + dy, 1, (await s.visibility()) === 'visible');
    }
    if (clear) {
      await callOn(fs, obj, `function () {
        if (typeof this.select === 'function' && ('value' in this)) { this.select(); return; }
        const r = document.createRange(); r.selectNodeContents(this);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }`);
      await pressCombo(s, parseCombo('Backspace')!);
    }
    if (text) {
      if (fast) await send(s, 'Input.insertText', { text });
      else await typeChars(s, text);
    }

    // 실제로 들어갔는지 확인 (사이트가 입력을 막거나 바꿀 수 있음)
    let warn = '';
    if (info.editable !== 'none' && text) {
      const now = await callOn<string>(fs, obj, `function () { return ('value' in this && typeof this.value === 'string') ? this.value : (this.innerText || ''); }`);
      if (!now.includes(text)) warn = `\n[주의] 입력한 뒤 값이 예상과 달라요 (현재 값: ${JSON.stringify(now.slice(0, 100))}). 사이트가 입력을 막거나 형식을 바꿨을 수 있어요.`;
    } else if (info.editable === 'none') {
      warn = `\n[주의] [${ref}]는 입력칸이 아니라서(${info.tag}) 포커스된 곳에 글자를 보냈어요. 결과를 스냅샷으로 확인하세요.`;
    }
    let note = '';
    const human = await humanFocusNote(s);
    if (submit) note = await settleAfter(s, () => pressCombo(s, parseCombo('Enter')!));
    warn += human;
    return `입력했어요: [${ref}] ${JSON.stringify(text)}${clear ? ' (기존 내용 지움)' : ''}${fast ? ' (빠른 입력: 키 이벤트 없이 한 번에)' : ''}${submit ? ' + Enter' : ''}${warn}${note}`;
  } finally {
    await release(fs);
  }
}

/**
 * <select>에서 항목 고르기 (값 또는 보이는 글자로).
 * 드롭다운에 포커스를 두고 화살표 키로 옮긴다 → 페이지는 진짜 input/change 이벤트를 받고, 목록 창은 뜨지 않는다.
 */
export async function select(s: PageSession, agent: string, ref: string, option: string): Promise<string> {
  await s.ensureNoDialog();
  const t = targetOf(s, agent, ref);
  const { fs } = await locate(s, t);
  try {
    const obj = await objectOf(fs, t);
    const find = await callOn<{ ok: boolean; index?: number; label?: string; value?: string; options?: string[]; error?: string; multiple?: boolean }>(fs, obj, `function (want) {
      const sel = this.tagName === 'SELECT' ? this : this.closest && this.closest('select');
      if (!sel) return { ok: false, error: 'notselect' };
      const opts = [...sel.options];
      const norm = (x) => x.replace(/\\s+/g, ' ').trim();
      const o = opts.find((o) => o.value === want) || opts.find((o) => norm(o.text) === norm(want)) ||
        opts.find((o) => norm(o.text).includes(norm(want)));
      if (!o) return { ok: false, options: opts.slice(0, 40).map((o) => norm(o.text) + (o.value !== norm(o.text) ? ' (값: ' + o.value + ')' : '')) };
      if (o.disabled) return { ok: false, error: 'disabled', label: norm(o.text) };
      return { ok: true, index: o.index, label: norm(o.text), value: o.value, multiple: sel.multiple };
    }`, [{ value: option }]);
    if (!find.ok) {
      if (find.error === 'notselect') throw new CdpmError(`[${ref}]는 <select> 드롭다운이 아니에요. 사이트가 직접 만든 목록이면 browser_click으로 열고 항목을 클릭하세요.`);
      if (find.error === 'disabled') throw new CdpmError(`"${find.label}" 항목은 비활성이라 고를 수 없어요.`);
      throw new CdpmError(`"${option}"에 맞는 항목이 없어요. 고를 수 있는 항목:\n${(find.options ?? []).map((o) => `  - ${o}`).join('\n')}`);
    }
    await send(fs, 'DOM.focus', { backendNodeId: t.backendNodeId });
    const current = () => callOn<number>(fs, obj, `function () { const sel = this.tagName === 'SELECT' ? this : this.closest('select'); return sel.selectedIndex; }`);
    const arrowDown = parseCombo('ArrowDown')!;
    const arrowUp = parseCombo('ArrowUp')!;
    let idx = await current();
    if (IS_MAC && idx !== find.index) {
      // 맥 Chrome은 닫힌 드롭다운에서 화살표 키를 누르면 OS 목록 창을 띄운다. 대신 항목 글자를 쳐서 고른다(타입어헤드, 창 안 뜸).
      // 스페이스도 목록 창을 띄울 수 있어 첫 공백 앞까지만 친다.
      const prefix = (find.label ?? '').split(' ')[0];
      if (prefix) {
        await typeChars(s, prefix);
        idx = await current();
      }
    }
    for (let step = 0; !IS_MAC && idx !== find.index && step < 500; step++) {
      await pressCombo(s, idx < find.index! ? arrowDown : arrowUp);
      const next = await current();
      if (next === idx) break; // 더 움직이지 않음 (끝이거나 막힘)
      idx = next;
    }
    if (idx === find.index) return `골랐어요: [${ref}] "${find.label}" (값: ${find.value})`;
    // 키로 고르지 못한 경우(맥에서 앞글자가 같은 항목이 먼저 있을 때 등): 값을 직접 넣고 input/change 이벤트를 낸다 (이 이벤트는 isTrusted=false).
    const forced = await callOn<number>(fs, obj, `function (i) {
      const sel = this.tagName === 'SELECT' ? this : this.closest('select');
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.selectedIndex;
    }`, [{ value: find.index }]);
    if (forced !== find.index) throw new CdpmError(`"${find.label}" 항목으로 옮기지 못했어요. 페이지가 선택을 막고 있을 수 있어요.`);
    return `골랐어요: [${ref}] "${find.label}" (값: ${find.value}) — 키로 고르지 못해 값을 직접 넣었어요 (change 이벤트 isTrusted=false)`;
  } finally {
    await release(fs);
  }
}

/** 화면 가운데의 스크롤 대상(가장 가까운 스크롤 가능한 조상, 없으면 문서)을 찾아 정보를 돌려주거나 스크롤한다. */
const SCROLL_FN = (dy: number | null) => `(() => {
  const isScrollable = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
  };
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && !isScrollable(el)) el = el.parentElement;
  const t = el || document.scrollingElement || document.documentElement;
  ${dy === null ? '' : `t.scrollBy({ top: ${dy}, behavior: 'instant' });`}
  return { top: Math.round(t.scrollTop), max: Math.max(0, Math.round(t.scrollHeight - t.clientHeight)), inner: !!el };
})()`;

export async function scroll(s: PageSession, agent: string, ref: string | undefined, dy: number | undefined): Promise<string> {
  await s.ensureNoDialog();
  if (ref) {
    const t = targetOf(s, agent, ref);
    const { fs } = await locate(s, t);
    await send(fs, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId });
    return `[${ref}]가 보이도록 스크롤했어요.`;
  }
  const amount = dy ?? 600;
  // 휠 이벤트는 비동기로 늦게 적용돼 결과를 추측해야 한다 → 스크립트로 정확한 양을 즉시 움직이고 위치를 바로 확정한다.
  const info = async (move: number | null) => (await s.evaluate<{ top: number; max: number; inner: boolean }>(SCROLL_FN(move), { timeoutMs: 10_000 })).value!;
  const before = await info(null);
  const after = await info(amount);
  const where = `${after.inner ? '안쪽 스크롤 영역 ' : ''}위치 ${before.top} → ${after.top} / 최대 ${after.max}`;
  const moved = Math.abs(after.top - before.top);
  if (!moved) {
    const edge = amount > 0 ? '이미 맨 아래' : '이미 맨 위';
    return `더 스크롤할 수 없어요 (${edge}, ${where}).`;
  }
  const partial = moved < Math.abs(amount) - 1 ? ` (요청 ${Math.abs(amount)}px 중 끝에 닿아 ${moved}px만)` : '';
  return `${amount > 0 ? '아래로' : '위로'} ${moved}px 스크롤했어요${partial} (${where}).`;
}

export async function navigate(s: PageSession, rawUrl: string): Promise<string> {
  await s.ensureNoDialog();
  let url = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  // charset 없는 data:text/html은 한글이 깨진다 → utf-8로 해석하게 한다
  if (/^data:text\/html,/i.test(url)) url = url.replace(/^data:text\/html,/i, 'data:text/html;charset=utf-8,');
  const ext = externalScheme(url);
  if (ext) throw new CdpmError(`이동하지 않았어요: ${ext} 주소는 브라우저가 아니라 사용자 PC의 다른 프로그램을 실행해요.`);
  // 이전 문서의 'complete'를 새 문서로 착각하지 않도록, 새 문서가 들어오는 이벤트를 먼저 기다린다.
  const committed = s.conn.waitFor('Page.frameNavigated', (p) => !p.frame.parentId, 30_000);
  let r: { errorText?: string; loaderId?: string };
  try {
    // Page.navigate는 서버가 첫 응답을 줄 때까지 돌아오지 않는다 → 느린 네트워크를 넉넉히 기다린다.
    r = await send<{ errorText?: string; loaderId?: string }>(s, 'Page.navigate', { url }, 60_000);
  } catch (e) {
    if (e instanceof CdpTimeoutError) return `이동을 시작했지만 60초 동안 서버 응답이 없어요: ${decodeUrl(url)}\n(네트워크가 느리거나 서버가 응답하지 않는 중이에요. browser_wait나 browser_snapshot으로 나중에 확인하세요)`;
    throw e;
  }
  if (r.errorText) {
    await new Promise((res) => setImmediate(res));
    const dl = downloadNote(s);
    if (dl) return `이동 대신 파일 내려받기가 시작됐어요 (페이지가 아니라 파일 응답이에요).${dl}`;
    throw new CdpmError(`이동 실패 (${decodeUrl(url)}): ${r.errorText}${/TIMED_OUT|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION/.test(r.errorText) ? ' — 인터넷 연결이나 주소를 확인하세요' : ''}`);
  }
  // loaderId가 없으면 같은 문서 안 이동(#해시)이라 새로 로딩하지 않는다.
  if (!r.loaderId) return `이동했어요: ${decodeUrl(url)} (같은 페이지 안 이동)`;
  const state = (await committed) ? await waitLoad(s, false) : 'timeout';
  return `이동했어요: ${decodeUrl(url)}${state === 'complete' ? '' : `\n(${LOAD_NOTE[state]})`}`;
}

export async function back(s: PageSession): Promise<string> {
  return history(s, -1);
}

export async function forward(s: PageSession): Promise<string> {
  return history(s, 1);
}

async function history(s: PageSession, delta: -1 | 1): Promise<string> {
  await s.ensureNoDialog();
  const word = delta < 0 ? '뒤로' : '앞으로';
  const h = await send<{ currentIndex: number; entries: { id: number; url: string }[] }>(s, 'Page.getNavigationHistory');
  const entry = h.entries[h.currentIndex + delta];
  if (!entry) throw new CdpmError(`${word} 갈 페이지가 없어요.`);
  const cur = h.entries[h.currentIndex];
  const sameDoc = cur.url.split('#')[0] === entry.url.split('#')[0];
  if (sameDoc) {
    await send(s, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    await sleep(100);
    return `${word} 갔어요: ${decodeUrl(entry.url)} (같은 페이지 안 이동)`;
  }
  const committed = s.conn.waitFor('Page.frameNavigated', (p) => !p.frame.parentId, 30_000);
  await send(s, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  const nav = await committed;
  const state = nav ? await waitLoad(s, false) : 'timeout';
  return `${word} 갔어요: ${decodeUrl(entry.url)}${state === 'complete' ? '' : `
(${LOAD_NOTE[state]})`}`;
}

/** 지금 페이지를 다시 불러온다 (진짜 새로고침, 주소로 다시 이동하는 것과 달리 Chrome의 새로고침 그대로). */
export async function reload(s: PageSession, ignoreCache = false): Promise<string> {
  await s.ensureNoDialog();
  const committed = s.conn.waitFor('Page.frameNavigated', (p) => !p.frame.parentId, 30_000);
  await send(s, 'Page.reload', { ignoreCache });
  const nav = await committed;
  const state = nav ? await waitLoad(s, false) : 'timeout';
  return `새로고침했어요${ignoreCache ? ' (캐시 무시)' : ''}${state === 'complete' ? '' : `
(${LOAD_NOTE[state]})`}${downloadNote(s)}`;
}

/** 요소 위에 진짜 마우스를 올린다 (마우스를 올려야 열리는 메뉴 등). */
export async function hover(s: PageSession, agent: string, ref: string): Promise<string> {
  await s.ensureNoDialog();
  const t = targetOf(s, agent, ref);
  const { fs, dx, dy } = await locate(s, t);
  const p = await clickPoint(fs, t.backendNodeId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + dx, y: p.y + dy, button: 'none' });
  // 메뉴가 그려질 시간: 다음 프레임 두 번
  await fs.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true, timeoutMs: 3000 }).catch(() => undefined);
  return `마우스를 올렸어요: [${ref}]`;
}

/**
 * 끌어 놓기 (진짜 마우스: 누르고 → 조금씩 움직이고 → 놓기). 슬라이더·순서 바꾸기·드래그형 보안문자 등.
 * 페이지가 HTML 드래그(draggable)를 쓰면 Chrome이 OS 드래그를 시작하지 않게 가로채서, 같은 데이터로 놓을 곳에 drop 한다.
 * 끝점: to(놓을 요소 ref) 또는 from 기준 dx·dy 픽셀.
 */
export async function drag(s: PageSession, agent: string, fromRef: string, toRef: string | undefined, dx: number | undefined, dy: number | undefined, toText?: string): Promise<string> {
  await s.ensureNoDialog();
  if (!toRef && !toText && dx === undefined && dy === undefined) throw new CdpmError('놓을 곳을 주세요: to(요소 ref), to_text(놓을 곳의 글자), 또는 dx·dy(픽셀).');
  const from = targetOf(s, agent, fromRef);
  const a = await locate(s, from);
  const startPoint = async () => { const p = await clickPoint(a.fs, from.backendNodeId); return { x: p.x + a.dx, y: p.y + a.dy }; };
  const frame = () => s.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true, timeoutMs: 3000 }).catch(() => undefined);
  const move = (x: number, y: number, buttons: number) => send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons });
  // 시작점으로 마우스를 먼저 옮긴 뒤 위치를 다시 잰다: 마우스가 움직이면 펼쳐져 있던 메뉴가 닫히는 등 화면이 바뀔 수 있어서
  let start = await startPoint();
  await move(start.x, start.y, 0);
  await frame();
  start = await startPoint();
  await move(start.x, start.y, 0);
  const endPoint = async (): Promise<{ x: number; y: number }> => {
    if (toRef) {
      const to = targetOf(s, agent, toRef);
      const b = await locate(s, to);
      const p1 = await clickPoint(b.fs, to.backendNodeId);
      return { x: p1.x + b.dx, y: p1.y + b.dy };
    }
    if (toText) {
      // 놓을 곳은 역할이 없는 칸(div)인 경우가 많아 ref가 없다 → 그 글자가 들어 있는 가장 작은 보이는 요소의 가운데
      const r = await s.evaluate<{ x: number; y: number } | null>(`(() => {
        const t = ${JSON.stringify(toText)};
        let best = null, area = Infinity;
        for (const el of document.querySelectorAll('body *')) {
          if (!(el.innerText || '').includes(t)) continue;
          const b = el.getBoundingClientRect();
          if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight) continue;
          if (b.width * b.height < area) { area = b.width * b.height; best = b; }
        }
        return best && { x: best.left + best.width / 2, y: best.top + best.height / 2 };
      })()`, { timeoutMs: 5000 });
      if (!r.value) throw new CdpmError(`"${toText}"이(가) 들어간 놓을 곳을 화면에서 찾지 못했어요 (화면 밖이면 browser_scroll로 둘 다 보이게 한 뒤 다시).`);
      return r.value;
    }
    return { x: start.x + (dx ?? 0), y: start.y + (dy ?? 0) };
  };
  const end = await endPoint();
  let dragData: unknown;
  const off = s.conn.on('Input.dragIntercepted', (p) => { dragData = p.data; });
  await s.send('Input.setInterceptDrags', { enabled: true }, 3000).catch(() => undefined);
  try {
    await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps && !dragData; i++) {
      await move(start.x + ((end.x - start.x) * i) / steps, start.y + ((end.y - start.y) * i) / steps, 1);
    }
    if (dragData) {
      // HTML 드래그: 놓을 곳에 들어가고 → 위에 있다가 → 놓기
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await send(s, 'Input.dispatchDragEvent', { type, x: end.x, y: end.y, data: dragData });
      }
    }
    await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    off();
    await s.send('Input.setInterceptDrags', { enabled: false }, 3000).catch(() => undefined);
  }
  await s.evaluate('0', { timeoutMs: 5000 }).catch(() => undefined);
  return `끌어 놓았어요: [${fromRef}] → ${toRef ? `[${toRef}]` : toText ? `"${toText}"` : `${dx ?? 0}, ${dy ?? 0}픽셀`}${dragData ? ' (HTML 드래그)' : ''}`;
}

/** 지금 페이지를 PDF로 저장한다. 경로를 안 주면 사용자 다운로드 폴더에 제목으로 저장. */
export async function pdf(s: PageSession, outPath: string | undefined, title: string): Promise<string> {
  await s.ensureNoDialog();
  const { data } = await send<{ data: string }>(s, 'Page.printToPDF', { printBackground: true }, 60_000);
  const safe = (title || 'page').replace(/[\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'page';
  const file = outPath ? path.resolve(outPath) : path.join(os.homedir(), 'Downloads', `${safe}.pdf`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return `PDF로 저장했어요: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)}KB)`;
}

/** 기다리는 도중 바로 멈출 이유 (예: 다른 에이전트의 메시지). 있으면 그 문구를 돌려준다. */
export type StopCheck = () => string | undefined;

export async function waitForText(s: PageSession, text: string, timeoutSec: number, stop?: StopCheck): Promise<string> {
  const until = Date.now() + timeoutSec * 1000;
  const expression = `(() => { const t = ${JSON.stringify(text)}; const b = document.body; return (!!b && b.innerText.includes(t)) || document.title.includes(t); })()`;
  while (Date.now() < until) {
    await s.ensureNoDialog();
    const why = stop?.();
    if (why) return why;
    try {
      const r = await s.evaluate<boolean>(expression, { timeoutMs: 3000 });
      if (r.value) return `글자가 나타났어요: ${JSON.stringify(text)}`;
    } catch (e) {
      if (e instanceof CdpTimeoutError) await s.ensureNoDialog();
    }
    await sleep(200);
  }
  throw new CdpmError(`${timeoutSec}초 동안 ${JSON.stringify(text)}이(가) 나타나지 않았어요.`);
}

/**
 * 주소가 바뀔 때까지 기다린다 (로그인 완료 감지 등). contains를 주면 그 글자가 들어간 주소가 될 때까지,
 * 없으면 지금 주소와 달라질 때까지. 0.25초마다 확인해서 바뀌는 즉시 돌려준다.
 */
/** 글자가 페이지에서 사라질 때까지 (예: 로그인 폼의 "비밀번호"가 사라짐 = 로그인 완료). 화면은 건드리지 않고 읽기만 한다. */
export async function waitForGone(s: PageSession, text: string, timeoutSec: number, stop?: StopCheck): Promise<string> {
  const until = Date.now() + timeoutSec * 1000;
  const expression = `(() => { const t = ${JSON.stringify(text)}; const b = document.body; return !((!!b && b.innerText.includes(t)) || document.title.includes(t)); })()`;
  while (Date.now() < until) {
    await s.ensureNoDialog();
    const why = stop?.();
    if (why) return why;
    const r = await s.evaluate<boolean>(expression, { timeoutMs: 3000 }).catch(() => undefined);
    if (r?.value) return `글자가 사라졌어요: ${JSON.stringify(text)}`;
    await sleep(100);
  }
  throw new CdpmError(`${timeoutSec}초 동안 ${JSON.stringify(text)}이(가) 사라지지 않았어요.`);
}

export async function waitForUrl(s: PageSession, contains: string | undefined, timeoutSec: number, stop?: StopCheck): Promise<string> {
  const href = async () => (await s.evaluate<string>('location.href', { timeoutMs: 3000 }).catch(() => undefined))?.value;
  const start = await href();
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    await s.ensureNoDialog();
    const why = stop?.();
    if (why) return why;
    const now = await href();
    if (now && (contains ? decodeUrl(now).includes(contains) || now.includes(contains) : now !== start)) {
      return `주소가 바뀌었어요: ${decodeUrl(now).slice(0, 200)}`;
    }
    await sleep(100);
  }
  throw new CdpmError(`${timeoutSec}초 동안 주소가 ${contains ? `"${contains}"이(가) 들어간 주소로` : ''} 바뀌지 않았어요 (지금: ${decodeUrl(start ?? '').slice(0, 120)}).`);
}

/**
 * 파일 칸에 파일을 넣는다 (OS 파일 선택 창 없이). ref가 있으면 그 파일 칸(또는 그 칸의 label)에,
 * 없으면 방금 CDPM 클릭으로 열리려던 파일 선택 창(가로챈 것)에 넣는다. 사이트는 사람이 고른 것과 같은 input·change 이벤트를 받는다.
 */
export async function upload(s: PageSession, agent: string, ref: string | undefined, files: string[]): Promise<string> {
  await s.ensureNoDialog();
  const paths = files.map((f) => path.resolve(f));
  const missing = paths.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
  if (missing.length) throw new CdpmError(`파일을 찾지 못했어요: ${missing.join(', ')}`);
  const names = paths.map((p) => path.basename(p)).join(', ');
  if (!ref) {
    const c = s.fileChooser;
    if (!c || Date.now() - c.at > 10 * 60_000) {
      throw new CdpmError('넣을 곳이 없어요. 파일 칸의 ref를 주거나, 먼저 "파일 첨부" 버튼을 browser_click으로 누르세요 (파일 선택 창을 가로채 둠).');
    }
    if (!c.multiple && paths.length > 1) throw new CdpmError('이 파일 칸은 파일을 하나만 받아요.');
    await send(c.fs, 'DOM.setFileInputFiles', { files: paths, backendNodeId: c.backendNodeId });
    s.fileChooser = undefined;
    return `파일을 넣었어요 (${paths.length}개): ${names}`;
  }
  const t = targetOf(s, agent, ref);
  const { fs: fsess } = await locate(s, t);
  try {
    const obj = await objectOf(fsess, t);
    const info = await describe(fsess, obj, ref);
    if (!info.fileInput) throw new CdpmError(`[${ref}]는 파일 칸이 아니에요. 사이트가 만든 "첨부" 버튼이면 browser_click으로 누른 뒤 ref 없이 browser_upload를 부르세요.`);
    const input = await callOnObject(fsess, obj, 'function () { return this.tagName === "LABEL" ? this.control : this; }');
    if (!input) throw new CdpmError(`[${ref}]의 파일 칸을 찾지 못했어요.`);
    const multiple = await callOn<boolean>(fsess, input, 'function () { return !!this.multiple; }');
    if (!multiple && paths.length > 1) throw new CdpmError(`[${ref}]는 파일을 하나만 받아요.`);
    await send(fsess, 'DOM.setFileInputFiles', { files: paths, objectId: input });
    const count = await callOn<number>(fsess, input, 'function () { return this.files ? this.files.length : 0; }');
    return `파일을 넣었어요: [${ref}] ${count}개 (${names})`;
  } finally {
    await release(fsess);
  }
}

export async function evaluate(s: PageSession, expression: string): Promise<string> {
  await s.ensureNoDialog();
  const r = await s.evaluate(expression, { awaitPromise: true, timeoutMs: 30_000 });
  if (r.exception) throw new CdpmError(`JS 오류: ${r.exception}`);
  if (r.type === 'undefined') return 'undefined';
  if (r.unserializableValue) return r.unserializableValue;
  if ('value' in r) {
    const json = JSON.stringify(r.value, null, 2) ?? String(r.value);
    return json.length > 20_000 ? json.slice(0, 20_000) + '\n… (잘렸음)' : json;
  }
  return r.description ?? String(r.type);
}

/** 본문 글자 (전체 또는 ref 요소). 긴 글은 쪽으로 나눈다. */
export async function extractText(s: PageSession, agent: string, ref: string | undefined, page: number): Promise<string> {
  await s.ensureNoDialog();
  let text: string;
  if (ref) {
    const t = targetOf(s, agent, ref);
    const { fs } = await locate(s, t);
    const obj = await objectOf(fs, t);
    try {
      text = await callOn<string>(fs, obj, 'function () { return (this.innerText || this.textContent || "").trim(); }');
    } finally {
      await release(fs);
    }
  } else {
    const r = await s.evaluate<string>(`(() => {
      const main = document.querySelector('main, article, [role=main]');
      const el = main && main.innerText.trim().length > 200 ? main : document.body;
      return el ? el.innerText.trim() : '';
    })()`, { timeoutMs: 10_000 });
    text = r.value ?? '';
  }
  text = text.replace(/\n{3,}/g, '\n\n');
  if (!text) return '(글자가 없어요)';
  const p = paginate(text, page);
  return `${p.body}\n\n— ${p.page}/${p.pages}쪽 (전체 ${text.length.toLocaleString()}자)${p.page < p.pages ? ` · 다음: page=${p.page + 1}` : ' · 끝'}`;
}

/**
 * 화면 캡처. 탭을 앞으로 가져오거나 뷰포트를 바꾸지 않는다.
 * 보이는 탭은 바로 캡처, 뒤에 숨은 탭은 화면 녹화 스트림에서 프레임 하나를 받는다 (그리기가 멈춘 탭도 한 프레임은 그려 준다).
 */
export async function screenshot(s: PageSession, browser: CdpConnection): Promise<string> {
  await s.ensureNoDialog();
  if (!s.isEmulating && (await s.visibility()) === 'visible') {
    // 스크롤 직후 등: 다음 프레임 두 번이 실제로 그려질 때까지 기다린 뒤 찍는다 (옛 화면이 찍히지 않게)
    await s.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true, timeoutMs: 10_000 }).catch(() => undefined);
    try {
      const { data } = await send<{ data: string }>(s, 'Page.captureScreenshot', { format: 'png' }, 5000);
      return data;
    } catch (e) {
      if (e instanceof DialogInterrupt) throw e;
      // 아래 스트림 방식으로 다시 시도
    }
  }
  // 뒤에 있는 탭: 화면 스트림은 시작한 뒤 새로 그린 프레임을 보내므로 프레임을 따로 기다리지 않는다 (무거운 페이지에서 프레임 두 번만큼 빨라짐)
  const frame = s.conn.waitFor('Page.screencastFrame', () => true, 5000);
  await send(s, 'Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  const f = await frame;
  if (f) await s.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  await s.send('Page.stopScreencast').catch(() => undefined);
  if (f) return f.data as string;

  // 실패 원인 안내: 창이 최소화돼 있으면 그릴 화면 자체가 없다
  try {
    const { windowId } = await browser.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: s.targetId }, 3000);
    const { bounds } = await browser.send<{ bounds: { windowState: string } }>('Browser.getWindowBounds', { windowId }, 3000);
    if (bounds.windowState === 'minimized') {
      throw new CdpmError('Chrome 창이 최소화돼 있어서 캡처할 수 없어요. CDPM은 창 상태를 바꾸지 않습니다. 필요하면 사용자에게 창을 띄워 달라고 하세요. (텍스트 스냅샷과 본문 읽기는 됩니다)');
    }
  } catch (e) {
    if (e instanceof CdpmError) throw e;
  }
  throw new CdpmError('캡처하지 못했어요 (5초 동안 화면 프레임이 오지 않았어요). 페이지가 무겁거나 멈춰 있을 수 있어요. 텍스트 스냅샷이나 browser_text로 확인해 보세요.');
}

/** 진행 중인 네트워크 요청이 quietMs 동안 없고 문서 로딩도 끝났을 때까지 기다린다 (스크린샷·읽기 전에). */
export async function waitNetworkIdle(s: PageSession, timeoutSec: number, quietMs = 500, stop?: StopCheck): Promise<string> {
  const until = Date.now() + timeoutSec * 1000;
  let quietSince = 0;
  while (Date.now() < until) {
    await s.ensureNoDialog();
    const why = stop?.();
    if (why) return why;
    const ready = (await s.evaluate<string>('document.readyState', { timeoutMs: 5000 }).catch(() => undefined))?.value;
    if (s.network.inflight.size || ready !== 'complete') quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return `네트워크가 잠잠해졌어요 (문서 로딩 완료, ${quietMs}ms 동안 진행 중인 요청 없음).`;
    await sleep(100);
  }
  const pending = s.network.list().filter((e) => s.network.inflight.has(e.requestId)).slice(-3).map((e) => `  - ${e.type} ${decodeUrl(e.url).slice(0, 100)}`);
  return `${timeoutSec}초 안에 네트워크가 잠잠해지지 않았어요 (진행 중 ${s.network.inflight.size}개). 계속 요청을 보내는 페이지일 수 있어요.${pending.length ? `\n진행 중인 요청 예:\n${pending.join('\n')}` : ''}`;
}

/** 방금(10초 안) 이 탭에서 다운로드가 시작됐으면 알림 문구 */
export function downloadNote(s: PageSession): string {
  const d = s.lastDownload;
  if (!d || Date.now() - d.at > 10_000) return '';
  s.lastDownload = undefined;
  return `\n[주의] 파일 내려받기가 시작됐어요: ${d.file} (${decodeUrl(d.url).slice(0, 80)}) — 사용자 PC의 다운로드 폴더에 저장돼요. 끝나면 저장 경로를 받으려면 browser_download_wait.`;
}
