// 접근성 트리 → 들여쓰기 텍스트 + ref(eN) ↔ 요소(backendDOMNodeId, frameId).
import { pageSession, type PageSession, type RefTarget } from '../cdp/sessions.js';
import { decodeUrl } from '../util.js';

export interface AXValue { type?: string; value?: unknown }
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/**
 * iframe 요소(backendDOMNodeId) → 그 안의 접근성 트리와 프레임 ID, 또는 'unsupported'(읽지 못한 iframe).
 * 다른 사이트 iframe(별도 프로세스)은 targetId·owner와, 그 안의 요소 ID 공간용 frames·hrefs를 따로 갖는다.
 */
export type FrameTrees = Map<number, FrameTree | 'unsupported'>;
export interface FrameTree {
  nodes: AXNode[];
  frameId?: string;
  targetId?: string;
  owner?: RefTarget;
  frames?: FrameTrees;
  hrefs?: Map<number, string>;
  draggable?: Set<number>;
}

export interface SnapshotOptions {
  /** 요소 → ref 번호 (생략하면 1부터 차례로) */
  assignRef?: (backendNodeId: number, targetId?: string) => string;
  frames?: FrameTrees;
  hrefs?: Map<number, string>;   // backendDOMNodeId → href
  /** draggable="true" 요소 (역할이 없는 div라도 끌어 놓기용 ref를 준다) */
  draggable?: Set<number>;
  baseUrl?: string;
  mainFrameId?: string;
}

export interface Snapshot {
  text: string;
  refs: Map<string, RefTarget>;
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton',
  'listbox', 'treeitem', 'heading', 'textarea', 'ListBoxOption', 'PopUpButton', 'TextField',
  'InputTime', 'date', 'DateTime', 'time', 'colorwell', 'ColorWell',
]);
const HOIST = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'Section', 'group_unnamed']);
const DROP = new Set(['InlineTextBox', 'LineBreak']);
const STATE_PROPS = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'readonly', 'focused'];
const MAX_TEXT = 300;

const str = (v: AXValue | undefined) => (v?.value === undefined || v.value === null ? '' : String(v.value));
// 일부 사이트는 접근성 이름에 강조 태그를 글자 그대로 넣는다 → 읽기 좋게 뺀다.
const clean = (s: string) => s.replace(/<\/?(mark|b|strong|em|i|u|span)>/gi, '').replace(/\s+/g, ' ').trim();
const quote = (s: string) => JSON.stringify(s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

export function formatAxTree(nodes: AXNode[], opts: SnapshotOptions = {}): Snapshot {
  const refs = new Map<string, RefTarget>();
  let refNo = 0;
  const assign = opts.assignRef ?? (() => `e${++refNo}`);

  interface Ctx { frameId?: string; targetId?: string; owner?: RefTarget; frames?: FrameTrees; hrefs?: Map<number, string>; draggable?: Set<number> }
  function render(list: AXNode[], depth0: number, ctx: Ctx): string[] {
    const { frameId, targetId, owner } = ctx;
    const byId = new Map(list.map((n) => [n.nodeId, n]));
    const root = list.find((n) => !n.parentId || !byId.has(n.parentId)) ?? list[0];
    if (!root) return [];

    const visit = (node: AXNode, depth: number, parentName: string): string[] => {
      const role = str(node.role);
      if (DROP.has(role)) return [];
      const name = clean(str(node.name));
      const kids = () => (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AXNode => !!n);

      if (role === 'StaticText') {
        if (!name || name === parentName) return [];
        return [`${pad(depth)}- text ${quote(name)}`];
      }
      const drag = node.backendDOMNodeId !== undefined && !!ctx.draggable?.has(node.backendDOMNodeId);
      if (!drag && (node.ignored || HOIST.has(role) || (!name && role === 'group'))) {
        return kids().flatMap((k) => visit(k, depth, parentName));
      }
      if (role === 'Iframe' || role === 'iframe') {
        const sub = node.backendDOMNodeId !== undefined ? ctx.frames?.get(node.backendDOMNodeId) : undefined;
        const head = `${pad(depth)}- iframe${name ? ` ${quote(name)}` : ''}`;
        if (sub === 'unsupported') return [`${head} (읽지 못함)`];
        if (!sub) return [head];
        // 같은 프로세스 iframe은 요소 ID 공간이 같고, 다른 사이트 iframe은 자기 공간을 쓴다
        return [head, ...render(sub.nodes, depth + 1, sub.targetId
          ? { frameId: sub.frameId, targetId: sub.targetId, owner: sub.owner, frames: sub.frames, hrefs: sub.hrefs, draggable: sub.draggable }
          : { ...ctx, frameId: sub.frameId })];
      }

      const shown = drag && (node.ignored || HOIST.has(role) || role === 'group') ? 'draggable' : role;
      let line = `${pad(depth)}- ${shown === 'RootWebArea' ? 'document' : shown}`;
      if (name) line += ` ${quote(name)}`;
      if ((INTERACTIVE.has(role) || drag) && node.backendDOMNodeId !== undefined) {
        const ref = assign(node.backendDOMNodeId, targetId);
        refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId, ...(targetId ? { targetId, owner } : {}) });
        line += ` [${ref}]`;
      }
      const value = clean(str(node.value));
      if (value && value !== name) line += `: ${quote(value)}`;
      if (role === 'link' && node.backendDOMNodeId !== undefined) {
        const href = ctx.hrefs?.get(node.backendDOMNodeId);
        if (href) line += ` → ${shortHref(href, opts.baseUrl)}`;
      }
      const states = (node.properties ?? [])
        .filter((p) => STATE_PROPS.includes(p.name))
        .map((p) => {
          const v = str(p.value);
          if (v === 'false' || v === '') return '';
          return v === 'true' ? p.name : `${p.name}=${v}`;
        })
        .filter(Boolean);
      if (states.length) line += ` (${states.join(', ')})`;

      const children = kids().flatMap((k) => visit(k, depth + 1, name));
      const structural = !INTERACTIVE.has(role) && role !== 'RootWebArea' && role !== 'image' && role !== 'img';
      if (structural && !name && children.length === 0) return [];
      // 이름 없는 문단 등이 글자 하나만 품으면 한 줄로 합친다.
      if (structural && !name && children.length === 1 && children[0].trimStart().startsWith('- text ')) {
        return [`${line}: ${children[0].trimStart().slice('- text '.length)}`];
      }
      return [line, ...children];
    };
    return visit(root, depth0, '');
  }

  return { text: render(nodes, 0, { frameId: opts.mainFrameId, frames: opts.frames, hrefs: opts.hrefs, draggable: opts.draggable }).join('\n'), refs };
}

function pad(depth: number) {
  return '  '.repeat(depth);
}

function shortHref(href: string, base?: string): string {
  try {
    const u = new URL(href, base);
    if (base) {
      const b = new URL(base);
      if (u.origin === b.origin) return decodeUrl(u.pathname + u.search + u.hash).slice(0, 80);
    }
    return decodeUrl(u.href).slice(0, 100);
  } catch {
    return href.slice(0, 100);
  }
}

// ---------- 긴 스냅샷 보기: 쪽 나누기, 찾기, 영역 ----------

export const PAGE_CHARS = 12_000;

/** 줄 단위로 끊어 쪽을 나눈다. */
export function paginate(text: string, page: number, size = PAGE_CHARS): { body: string; page: number; pages: number; start: number } {
  const lines = text.split('\n');
  const chunks: string[][] = [[]];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > size && chunks.at(-1)!.length) {
      chunks.push([]);
      len = 0;
    }
    chunks.at(-1)!.push(line);
    len += line.length + 1;
  }
  const pages = chunks.length;
  const p = Math.min(Math.max(1, page), pages);
  let start = 0;
  for (let i = 0; i < p - 1; i++) start += chunks[i].length;
  return { body: chunks[p - 1].join('\n'), page: p, pages, start };
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** lineIndex 줄의 위쪽 조상 줄들 (쪽 머리에 맥락으로 보여줄 때). */
export function ancestorsOf(text: string, lineIndex: number): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let indent = indentOf(lines[lineIndex] ?? '');
  for (let j = lineIndex - 1; j >= 0 && indent > 0; j--) {
    const ind = indentOf(lines[j]);
    if (ind < indent) {
      out.unshift(lines[j]);
      indent = ind;
    }
  }
  return out;
}

/** 글자가 들어간 줄과 그 위쪽 조상 줄(맥락)만 남긴다. */
export function findLines(text: string, query: string, max = 150): { body: string; matches: number } {
  const lines = text.split('\n');
  // 띄어쓰기·대소문자 차이는 무시한다 ("IT/과학" ↔ "IT / 과학", "미국 USD" ↔ "미국USD")
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  // "제목|subject"처럼 | 로 여러 낱말을 주면 그중 하나라도 맞는 줄 (사이트 언어를 모를 때)
  const qs = query.split('|').map(norm).filter(Boolean);
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = norm(lines[i]);
    if (!qs.some((q) => line.includes(q))) continue;
    matches++;
    if (matches > max) continue;
    keep.add(i);
    // 바로 아래 두 줄(형제·자식)도 함께: 이름 옆에 붙은 값이 다음 줄에 있는 경우가 많다.
    for (let k = i + 1; k <= i + 2 && k < lines.length && indentOf(lines[k]) >= indentOf(lines[i]); k++) keep.add(k);
    let indent = indentOf(lines[i]);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const ind = indentOf(lines[j]);
      if (ind < indent) {
        keep.add(j);
        indent = ind;
      }
    }
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length) out.push('  …');
    out.push(lines[i]);
    prev = i;
  }
  return { body: out.join('\n'), matches };
}

/** ref 요소와 그 아래 줄만. */
export function subtree(text: string, ref: string): string | undefined {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(`[${ref}]`));
  if (i < 0) return undefined;
  const base = indentOf(lines[i]);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && indentOf(lines[j]) > base; j++) out.push(lines[j]);
  return out.map((l) => l.slice(base)).join('\n');
}

// ---------- 찍기 ----------

interface DomNode {
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
  frameId?: string;
}

/** 한 대상(탭 또는 다른 사이트 iframe)의 링크 주소와 iframe 요소 → 프레임 ID. */
async function domInfo(session: PageSession) {
  const doc = await session.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true }).catch(() => undefined);
  const hrefs = new Map<number, string>();
  const iframeFrame = new Map<number, string>();
  const draggable = new Set<number>();
  const walk = (n: DomNode | undefined) => {
    if (!n) return;
    const attrs = n.attributes ?? [];
    if (n.nodeName === 'A') {
      const i = attrs.indexOf('href');
      if (i >= 0 && i % 2 === 0) hrefs.set(n.backendNodeId, attrs[i + 1]);
    }
    if ((n.nodeName === 'IFRAME' || n.nodeName === 'FRAME') && n.frameId) iframeFrame.set(n.backendNodeId, n.frameId);
    const d = attrs.indexOf('draggable');
    if (d >= 0 && d % 2 === 0 && attrs[d + 1] === 'true') draggable.add(n.backendNodeId);
    n.children?.forEach(walk);
    n.shadowRoots?.forEach(walk);
    walk(n.contentDocument);
  };
  walk(doc?.root);
  return { hrefs, iframeFrame, draggable };
}

/**
 * 접근성 트리 안의 iframe들을 채운다. 같은 프로세스 iframe은 같은 연결로 frameId를 주어 읽고,
 * 다른 사이트 iframe(별도 프로세스)은 그 iframe의 CDP 대상에 직접 연결해 읽는다 (중첩도 따라 들어감).
 */
async function collectFrames(session: PageSession, list: AXNode[], iframeFrame: Map<number, string>, frames: FrameTrees, ctxTarget: string | undefined, ctxOwner: RefTarget | undefined, depth = 0) {
  if (depth > 5) return;
  for (const node of list) {
    const role = str(node.role);
    if ((role !== 'Iframe' && role !== 'iframe') || node.backendDOMNodeId === undefined) continue;
    const frameId = iframeFrame.get(node.backendDOMNodeId);
    if (!frameId) {
      frames.set(node.backendDOMNodeId, 'unsupported');
      continue;
    }
    try {
      const sub = await session.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId });
      frames.set(node.backendDOMNodeId, { nodes: sub.nodes, frameId });
      await collectFrames(session, sub.nodes, iframeFrame, frames, ctxTarget, ctxOwner, depth + 1);
      continue;
    } catch {
      // 같은 프로세스가 아님 → 아래에서 별도 대상으로 시도
    }
    try {
      const child = await pageSession(session.slot, frameId);
      const owner: RefTarget = { backendNodeId: node.backendDOMNodeId, ...(ctxTarget ? { targetId: ctxTarget, owner: ctxOwner } : {}) };
      const [{ nodes }, info] = await Promise.all([child.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {}), domInfo(child)]);
      const childFrames: FrameTrees = new Map();
      frames.set(node.backendDOMNodeId, { nodes, frameId, targetId: frameId, owner, frames: childFrames, hrefs: info.hrefs, draggable: info.draggable });
      await collectFrames(child, nodes, info.iframeFrame, childFrames, frameId, owner, depth + 1);
    } catch {
      frames.set(node.backendDOMNodeId, 'unsupported');
    }
  }
}

/** 탭의 전체 스냅샷을 찍고, ref 매핑과 쪽 넘기기용 사본을 세션에 저장한다. */
export async function takeSnapshot(session: PageSession, agent: string): Promise<Snapshot & { url: string }> {
  await session.ensureNoDialog();
  const [{ nodes }, info, { frameTree }] = await Promise.all([
    session.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {}),
    domInfo(session),
    session.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree'),
  ]);
  const { hrefs } = info;
  const frames: FrameTrees = new Map();
  await collectFrames(session, nodes, info.iframeFrame, frames, undefined, undefined);

  const url = frameTree.frame.url;
  session.mainFrameId = frameTree.frame.id;
  const snap = formatAxTree(nodes, { frames, hrefs, draggable: info.draggable, baseUrl: url, mainFrameId: frameTree.frame.id, assignRef: session.refAllocator(agent) });
  session.setSnapshot(agent, snap.refs, { url, text: snap.text, at: Date.now() });
  return { ...snap, url };
}
