// MCP 도구 정의. 실제 동작은 service / page / registry / cdp 부품을 조합만 한다.
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { wildcard, type BlockRule, type NetEntry } from '../cdp/network.js';
import { browserConnection, forgetSlotVisibility, knownDialog, onAgentForgotten, pageSession, touchAgent, type DialogInfo, type PageSession } from '../cdp/sessions.js';
import { ensureDownloadTracking, waitDownload } from '../cdp/downloads.js';
import { listPrintPreviews, probe } from '../cdp/targets.js';
import { bubbleDetail, bubbleLine, hostsOf, permissionBubbles, pressBubble } from '../chrome/bubbles.js';
import { describeProxy, parseProxy, type ProxySpec } from '../chrome/proxy.js';
import { isClaudeCode } from '../client-info.js';
import { CdpmError } from '../errors.js';
import { withSlotLock } from '../registry/lock.js';
import { pausedInfo, pausedRefusal, pauseSlots, resumeSlots } from '../pause.js';
import * as act from '../page/actions.js';
import { ancestorsOf, findLines, paginate, subtree, takeSnapshot } from '../page/snapshot.js';
import { hasUnread, recentDelivered, sendMessage, takeUnread, waitUnread } from '../registry/messages.js';
import { readRegistry, updateRegistry, type BlockStamp } from '../registry/store.js';
import {
  attachSlot, forgetSlot, freeSlots, launchSlot, liveSlots, markCreated, ownershipWarnings, pickTab, recordAction, syncTabs,
  type TabKind, type TabView,
} from '../service.js';
import { MAX_SLOT, MIN_SLOT, PORT_BASE, portOf } from '../slots.js';
import { ago, decodeUrl, nowIso, pidAlive, secondsSince, shortUrl, sleep, truncate } from '../util.js';
import { formatHeader, formatMessages, formatSlotStatus } from './format.js';
import { readAfter, type ReadMode } from './read.js';

/** 에이전트가 마지막으로 다룬 탭 (보기 도구에서 tab을 생략했을 때 우선). key: `${slot}:${agent}` */
const lastTabOf = new Map<string, string>();

/** 이 MCP 프로세스(= Claude 세션 하나)의 기본 에이전트 이름. */
/** 에이전트마다 최근(60초) 조작한 슬롯. 한 에이전트가 여러 슬롯을 번갈아 쓰면 서브에이전트로 나누라고 알린다. */
const recentSlots = new Map<string, Map<number, number>>();

/**
 * 한 에이전트는 한 슬롯만 맡는다 (병렬 처리 강제). 같은 에이전트가 60초 안에 다른 슬롯을 쓰려 하면 거절하고
 * 서브에이전트로 나누라고 돌려보낸다. 정말 한 에이전트가 여러 슬롯을 함께 봐야 하면(비교 등) multiSlot: true.
 */
function multiSlotRefusal(agent: string, slot: number, allowed: boolean | undefined): string | undefined {
  touchAgent(agent);
  const now = Date.now();
  const m = recentSlots.get(agent) ?? new Map<number, number>();
  for (const [k, at] of m) if (now - at > 60_000) m.delete(k);
  const others = [...m.keys()].filter((k) => k !== slot).sort((x, y) => x - y);
  if (others.length && !allowed) {
    const how = isClaudeCode()
      ? `For different jobs per slot, call the Agent tool once per slot in a single message to launch subagents (subagent_type "cdpm-browser") together, ` +
        `each using its own slot and agent name (e.g. "slot${slot}-agent"). Each subagent writes its own share of the output (report, HTML fragment, etc.); main only merges. `
      : `For different jobs per slot, give each slot its own subagent if available; otherwise use a distinct agent name per slot (e.g. "slot${slot}-agent"). `;
    return `Refused: ${agent} just used slot ${others.join(', ')}, so it won't take slot ${slot}. ` + how +
      `If one agent must handle several slots together (e.g. comparing), call again with multiSlot: true.`;
  }
  m.set(slot, now);
  recentSlots.set(agent, m);
  return undefined;
}

export const DEFAULT_AGENT = `claude-${randomBytes(2).toString('hex')}`;

const SLOT_RANGE = `slot must be a number ${MIN_SLOT}-${MAX_SLOT}`;
const slotArg = z.number({ error: (iss) => (iss.input === undefined ? `slot is required (number ${MIN_SLOT}-${MAX_SLOT})` : SLOT_RANGE) }).int(SLOT_RANGE).min(MIN_SLOT, SLOT_RANGE).max(MAX_SLOT, SLOT_RANGE)
  .describe(`Browser slot ${MIN_SLOT}-${MAX_SLOT}. "3", "slot 3", "browser 3" → 3. If the user gives a port like ${PORT_BASE + 3}, subtract ${PORT_BASE}.`);
const agentArg = z.string().min(1).max(40).optional()
  .describe(`Your display name, shown to other agents. Subagents must always set it. Default "${DEFAULT_AGENT}".`);
const tabArg = z.union([z.string(), z.number()]).optional()
  .describe('Target tab: number (1, 2…) or ID ("t7"). Use the stable ID when agents share a slot. Required for action tools when there are multiple tabs.');
const summaryArg = z.string().max(120).optional()
  .describe('One-line note of what you are doing (e.g. "comparing laptop prices"). Shown in browser_status (not the status line). Omit to keep the previous one.');
const multiSlotArg = z.boolean().optional()
  .describe('true only when one agent must handle several slots together (e.g. comparing). Normally omit (one agent = one slot; use subagents for the rest)');
const readArg = z.enum(['text', 'snapshot', 'changes']).optional()
  .describe('Append the page after the action (no separate read needed): text=body text, snapshot=snapshot page 1 (with refs), changes=only lines added/removed since your last snapshot (shortest; full page if the page changed)');
const pageArg = z.number().int().min(1).optional().describe('Page number for long output (default 1)');

interface Out {
  text: string;
  image?: string;
}

const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

function errorText(e: unknown): string {
  if (e instanceof CdpmError) return e.message;
  return `Error: ${(e as Error)?.message ?? String(e)}`;
}

/** 탭에 걸린 요청 막기 규칙 중, 건 프로세스가 아직 살아 있는 것. */
function liveBlocks(tab: TabView): BlockStamp[] {
  return (tab.rec.blocks ?? []).filter((b) => pidAlive(b.pid));
}

function dialogsOf(slot: number, tabs: TabView[]): Map<string, DialogInfo> {
  const m = new Map<string, DialogInfo>();
  for (const t of tabs) {
    const d = knownDialog(slot, t.targetId);
    if (d) m.set(t.targetId, d);
  }
  return m;
}

/** 에이전트마다 마지막으로 보여준 탭 목록 (슬롯:에이전트 → 목록 요약). 바뀐 게 없으면 머리말을 한 줄로 줄인다. */
const lastTabList = new Map<string, string>();

// 오래 안 나타난 에이전트(끝난 서브에이전트 등)의 기록을 지운다 (오래 켜 두어도 이름별 기록이 늘지 않게)
onAgentForgotten((agent) => {
  recentSlots.delete(agent);
  for (const m of [lastTabOf, lastTabList]) for (const k of m.keys()) if (k.endsWith(`:${agent}`)) m.delete(k);
});

/** 이미 보여준 슬롯 알림 (슬롯:에이전트:시각) */
const shownNotices = new Set<string>();

async function header(slot: number, agent: string, tabs: TabView[], opts: { executed?: string; warnings?: string[]; skipMessages?: boolean; compact?: boolean } = {}) {
  touchAgent(agent);
  const messages = opts.skipMessages ? [] : await takeUnread(slot, agent).catch(() => []);
  const warnings = [...(opts.warnings ?? [])];
  // 슬롯 알림(업데이트 때문에 다시 켬 등)은 에이전트마다 한 번 (10분 안)
  const notice = readRegistry().slots[String(slot)]?.notice;
  if (notice && secondsSince(notice.at) < 600) {
    const k = `${slot}:${agent}:${notice.at}`;
    if (!shownNotices.has(k)) {
      if (shownNotices.size > 500) shownNotices.clear();
      shownNotices.add(k);
      warnings.push(notice.text);
    }
  }
  for (const t of tabs) {
    const blocks = liveBlocks(t);
    if (blocks.length) warnings.push(`[${t.id}] blocking requests: ${blocks.map((b) => `${b.pattern} (${b.agent})`).join(', ')}`);
  }
  // Chrome 권한 요청 말풍선 (페이지 밖 브라우저 화면이라 스냅샷에 안 보인다)
  for (const b of permissionBubbles(slot, hostsOf(tabs.map((t) => t.url)))) warnings.push(bubbleLine(b, await bubbleDetail(b)));
  // 인쇄 미리보기 (탭 목록에는 안 넣는다). 어느 탭 것인지는 제목으로 맞춘다
  for (const p of await listPrintPreviews(slot).catch(() => [])) {
    const owners = tabs.filter((t) => t.title === p.title);
    const where = owners.length === 1 ? `tab ${owners[0].no} [${owners[0].id}]` : `"${truncate(p.title, 40)}"`;
    warnings.push(`Print dialog open on ${where}. ${act.PRINT_NOTE}`);
  }
  const dialogs = dialogsOf(slot, tabs);
  // 탭 목록이 이 에이전트가 지난번에 본 것과 같고 경고·알림창·메시지도 없으면 한 줄로 (읽을 양을 줄여 다음 판단이 빨라지게)
  const key = `${slot}:${agent}`;
  // 다른 에이전트가 한 행동은 서명에 넣어, 남이 건드리면 전체 목록을 다시 보여준다 (내 행동만으로는 줄인 머리말 유지)
  const others = (t: TabView) => (t.rec.last && t.rec.last.agent !== agent ? `${t.rec.last.agent}@${t.rec.last.at}` : '');
  const sig = tabs.map((t) => `${t.id}|${t.active ? 1 : 0}|${t.url}|${t.title}|${others(t)}`).join('\n');
  const same = lastTabList.get(key) === sig;
  lastTabList.set(key, sig);
  if (opts.compact && same && !warnings.length && !messages.length && !dialogs.size) {
    const exec = tabs.find((t) => t.targetId === opts.executed);
    return `[Slot ${slot}] ${tabs.length} tab(s)${exec ? ` · ran on tab ${exec.no} [${exec.id}]` : ''} (tab list unchanged)`;
  }
  return formatHeader({ slot, tabs, executedTargetId: opts.executed, warnings, dialogs, messages });
}

function compose(head: string, out: Out): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: `${head}\n---\n${out.text}` }];
  if (out.image) content.push({ type: 'image', data: out.image, mimeType: 'image/png' });
  return { content };
}

interface TabCall {
  slot: number;
  agent?: string;
  tab?: string | number;
  summary?: string;
  read?: ReadMode;
  multiSlot?: boolean;
}

/**
 * 탭 하나를 대상으로 하는 도구의 공통 흐름 (꺼진 슬롯은 켜지 않음):
 * 슬롯에 붙기 → 탭 맞추기 → 탭 고르기 → (조작이면 소유 경고) → 실행 → (성공하면) 기록 → 새 탭 알림 → 머리말.
 */
async function onTab(args: TabCall, kind: TabKind, action: string | null, fn: (s: PageSession, tab: TabView, agent: string) => Promise<Out>, opts: { render?: boolean } = {}): Promise<CallToolResult> {
  // 조작과 캡처는 화면이 그려져야 정확하다 (뒤에 숨은 탭이면 그 순간만 그리게 함).
  const render = opts.render ?? kind === 'action';
  const agent = args.agent ?? DEFAULT_AGENT;
  const { slot } = args;
  // 다른 슬롯 화면을 보는 것(보기 도구)은 막지 않는다. 조작만 한 에이전트 = 한 슬롯
  const refused = kind === 'action' ? multiSlotRefusal(agent, slot, args.multiSlot) ?? pausedRefusal(slot) : undefined;
  if (refused) return textResult(refused, true);
  let tabs: TabView[] = [];
  try {
    await attachSlot(slot);
    if (kind === 'action') await ensureDownloadTracking(slot); // 이 조작으로 시작될 다운로드를 끝까지 지켜보려고 (한 번만 켜짐)
    tabs = await syncTabs(slot);
    if (tabs.length === 0 && kind === 'action') {
      const browser = await browserConnection(slot);
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true });
      markCreated(targetId, agent);
      tabs = await syncTabs(slot);
    }
    const picked = pickTab(tabs, args.tab, kind, lastTabOf.get(`${slot}:${agent}`));
    if ('error' in picked) {
      return textResult(`${await header(slot, agent, tabs, { skipMessages: true })}\n---\n${picked.error}`, true);
    }
    const tab = picked.tab;
    lastTabOf.set(`${slot}:${agent}`, tab.targetId);
    const warnings = kind === 'action' ? ownershipWarnings(tab, agent) : [];
    const before = new Set(tabs.map((t) => t.targetId));
    const session = await pageSession(slot, tab.targetId);
    if (kind === 'action') session.actionStartedAt.set(agent, Date.now());
    let out: Out;
    try {
      const exec = async () => {
        let r: Out;
        if (kind === 'action') {
          const g = await act.guardAction(session, () => fn(session, tab, agent));
          r = g.value;
          r.text += g.note;
        } else r = await fn(session, tab, agent);
        // read 옵션: 조작 결과에 바뀐 화면을 바로 붙인다 (같은 줄 세우기 안에서, 다른 조작이 끼어들기 전에)
        if (args.read && kind === 'action') r.text += await readAfter(session, agent, args.read);
        return r;
      };
      const run = () => (render ? session.withRendering(exec) : exec());
      // 조작은 탭마다 줄을 세워 하나씩 (같은 탭에 동시에 오면 서로 섞이지 않게)
      out = kind === 'action' || render ? await session.exclusive(run) : await run();
    } catch (e) {
      // 멈춤: 하던 조작을 그 자리에서 그만뒀다 → 어떻게 기다릴지 함께 알린다
      if (e instanceof act.PausedInterrupt) return textResult(`${e.message}\n${pausedRefusal(slot) ?? ''}`, true);
      // 행동 도중 알림창·인쇄 미리보기가 뜬 것은 실패가 아니다 (클릭은 이루어졌음).
      if (!(e instanceof act.DialogInterrupt || e instanceof act.PrintInterrupt)) throw e;
      out = { text: `Action done. Then: ${e.message}` };
    }
    tabs = await syncTabs(slot).catch(() => tabs);
    if (action) {
      // 행동·요약·탭 제목을 기록부에 한 번에 쓴다 (여러 에이전트가 동시에 쓸 때 잠금 횟수를 줄임)
      const acted = tabs.find((t) => t.targetId === tab.targetId);
      const ok = await recordAction(slot, tab.targetId, agent, action, args.summary, !args.agent, acted ? acted.title || shortUrl(acted.url) : undefined);
      if (!ok) warnings.push('Not logged: could not lock the shared registry, so this action was not recorded.');
    }
    const opened = tabs.filter((t) => !before.has(t.targetId));
    if (opened.length) {
      out.text += `\nNew tab opened: ${opened.map((t) => `tab ${t.no} [${t.id}] ${t.url === 'about:blank' || !t.url ? '(loading)' : truncate(t.title || shortUrl(t.url), 40)}`).join(', ')}`;
    }
    if (action && !session.dialog) {
      // 클릭 등으로 페이지가 전체 화면이 되면 사용자 창 상태가 바뀌므로 바로 해제한다.
      const fs = await session.evaluate<boolean>('(() => { if (!document.fullscreenElement) return false; document.exitFullscreen(); return true; })()', { timeoutMs: 1500 }).catch(() => undefined);
      if (fs?.value) out.text += '\n[warning] The page went fullscreen; exited it right away (CDPM never changes window state).';
    }
    return compose(await header(slot, agent, tabs, { executed: tab.targetId, warnings, compact: true }), out);
  } catch (e) {
    const head = tabs.length ? `${await header(slot, agent, tabs, { skipMessages: true }).catch(() => '')}\n---\n` : '';
    return textResult(head + errorText(e), true);
  }
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return textResult(errorText(e), true);
  }
}

function pageFooter(p: { page: number; pages: number }, total: number, extra = ''): string {
  if (p.pages <= 1) return '';
  const next = p.page < p.pages ? ` · next: page=${p.page + 1}` : ' · last page';
  return `\n\n— page ${p.page}/${p.pages} (${total.toLocaleString()} chars total)${next}${extra}`;
}

// ---------- 네트워크 표시 ----------

function fmtSize(n?: number) {
  if (n === undefined) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function netLine(e: NetEntry, rules: BlockRule[] = []): string {
  const blockedBy = e.blockedBy ?? (e.failed && /BLOCKED_BY_CLIENT/.test(e.failed) ? rules.find((r) => wildcard(r.pattern).test(e.url))?.pattern : undefined);
  const status = e.failed
    ? `failed ${e.failed}${blockedBy ? ` (blocked: ${blockedBy})` : ''}`
    : e.status !== undefined ? String(e.status) + (e.fromCache ? ' (cache)' : '') : '…';
  const parts = [`n${e.no}`, e.method, status, e.type, fmtSize(e.size), e.durationMs !== undefined ? `${e.durationMs}ms` : ''].filter(Boolean);
  return `${parts.join('  ')}  ${truncate(decodeUrl(e.url), 140)}`;
}

/** 응답 본문 (글자면 앞 20,000자, 바이너리면 크기만). */
async function responseBody(s: PageSession, e: NetEntry): Promise<string> {
  const b = await s.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: e.requestId }, 10_000).catch(() => undefined);
  if (!b) return '  (unavailable: still loading, already discarded by Chrome, or a redirect)';
  if (b.base64Encoded && !/json|text|xml|javascript|html/i.test(e.mimeType ?? '')) return `  (binary ${fmtSize(Buffer.from(b.body, 'base64').length)}, ${e.mimeType})`;
  const raw = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
  return raw.length > 20_000 ? raw.slice(0, 20_000) + `\n… (truncated: ${raw.length.toLocaleString()} chars total)` : raw;
}

function headersText(h?: Record<string, string>): string {
  if (!h) return '  (none)';
  return Object.entries(h).map(([k, v]) => `  ${k}: ${truncate(String(v), 300)}`).join('\n');
}

/** 도메인만 적으면 그 주소가 들어간 모든 요청으로 넓힌다. */
function normalizePattern(p: string): string {
  const t = p.trim();
  if (!t.includes('*') && !t.includes('?')) return `*${t}*`;
  // "*.png"처럼 끝이 고정된 패턴도 "a.png?v=1"에 걸리도록 끝에 *를 붙인다.
  return t.endsWith('*') ? t : `${t}*`;
}

export function registerTools(server: McpServer) {
  // ---------- 슬롯·탭 ----------
  server.registerTool('browser_status', {
    title: 'Slot status',
    description: 'Shows running Chrome slots (1-30) with their tabs, opener, last action and one-line summary. Pass slot for just that slot.',
    inputSchema: { slot: slotArg.optional(), agent: agentArg },
  }, async ({ slot, agent }) => guard(async () => {
    const live = await liveSlots();
    const target = slot ? live.filter(([s]) => s === slot) : live;
    if (!target.length) return textResult(slot ? `Slot ${slot} Chrome is not running.` : 'No slots running. Start one with browser_launch when the user asks.');
    const parts: string[] = [];
    for (const [s] of target) {
      const tabs = await syncTabs(s).catch(() => null);
      const rec = readRegistry().slots[String(s)];
      let part = formatSlotStatus(s, rec ?? { launchedAt: new Date().toISOString(), nextTabSeq: 1, tabs: {} }, tabs);
      for (const t of tabs ?? []) {
        const d = knownDialog(s, t.targetId);
        if (d) part += `\n  [warning] dialog open (${d.type}) ([${t.id}]): "${truncate(d.message, 80)}"`;
      }
      parts.push(part);
    }
    const me = agent ?? DEFAULT_AGENT;
    return textResult(`${parts.join('\n\n')}\n\n(your name: ${me})`);
  }));

  server.registerTool('browser_launch', {
    title: 'Launch slot',
    description: 'Starts slot Chrome. Call only when the user explicitly asks (other tools never start a closed slot). ' +
      'Without slot, uses the lowest free slot. If already running, just attaches. ' +
      'The user decides windowed (visible) vs headless (hidden): headless: true only if they say "headless/hidden". If unstated, don\'t guess; ask first, then call with headless. ' +
      'Starting a closed slot without headless only returns a confirmation request. ' +
      'Start several slots at once with slots (list) or count (lowest first). For different jobs per slot, after launching give each slot its own subagent in parallel.',
    inputSchema: {
      slot: slotArg.optional().describe('One slot to start (1-30). Omit if the user gave no number → lowest free slot'),
      slots: z.array(slotArg).optional().describe('Slot numbers to start at once (e.g. [1,2,3]), lowest first'),
      count: z.number().int().min(1).max(MAX_SLOT).optional().describe('When the user gives only a count ("start 3"): starts that many free slots, lowest first'),
      url: z.string().optional().describe('Same start URL for every launched slot (e.g. "https://mail.google.com"). For per-slot or partial URLs use urls instead. Pass it when the start page is known so subagents need no separate navigation'),
      urls: z.array(z.string()).optional().describe('Per-slot start URLs, paired in slots order (count: launch order). "" = blank tab. E.g. slots [1,2], urls ["https://www.wehago.com", "https://test.igel.kr"] → 1 opens wehago, 2 opens test.igel.kr'),
      agent: agentArg,
      headless: z.boolean().optional().describe('false = windowed (visible), true = headless (hidden). true only if the user says "headless/hidden/no window", false for "visible/headful". If unstated, omit and ask first (no guessing). Applies only on first launch'),
      proxy: z.string().optional().describe('Only when the user asks for a proxy (never otherwise). As given: "1.2.3.4:8080", "http://user:pass@host:port", "socks5://host:port", "host:port:user:pass", etc. Applies to all launched slots, first launch only'),
      proxies: z.array(z.string()).optional().describe('Per-slot proxies, paired in slots order (count: launch order)'),
    },
  }, async ({ slot: wanted, slots: wantedList, count, agent, headless, url, urls, proxy, proxies }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const picked = !wantedList?.length && wanted === undefined;
    let targets: number[];
    if (wantedList?.length) targets = [...new Set(wantedList)];
    else if (wanted !== undefined) targets = [wanted];
    else {
      targets = await freeSlots(count ?? 1);
      if (targets.length < (count ?? 1)) {
        throw new CdpmError(`Only ${targets.length} free slot(s) (requested ${count ?? 1}). Close unused slots with browser_close.`);
      }
    }
    // 시작 주소: urls는 slots에 준 순서(없으면 켜지는 번호 순서)대로, 나머지는 url
    const order = wantedList?.length ? [...new Set(wantedList)] : [...targets].sort((x, y) => x - y);
    const startUrl = new Map<number, string>();
    order.forEach((t, i) => { const u = urls?.[i] ?? url; if (u) startUrl.set(t, u); });
    // 프록시: 사용자가 부탁했을 때만 값이 온다. 켜기 전에 형식부터 확인한다.
    const proxyOf = new Map<number, ProxySpec>();
    order.forEach((t, i) => { const p = proxies?.[i] ?? proxy; if (p) proxyOf.set(t, parseProxy(p)); });
    for (const u of startUrl.values()) {
      const ext = act.externalScheme(u);
      if (ext) throw new CdpmError(`Can't use a ${ext} URL (${u.slice(0, 80)}) as start URL (it would launch another program on the user's PC).`);
    }
    targets.sort((x, y) => x - y);
    // 모드를 사용자가 정하지 않았으면 꺼진 슬롯은 켜지 않는다 (이미 떠 있으면 그대로 붙는다).
    if (headless === undefined) {
      const states = await Promise.all(targets.map((t) => probe(t)));
      const closed = targets.filter((_, i) => states[i].state !== 'chrome');
      if (closed.length) {
        return textResult(`[Confirm] Slot ${closed.join(', ')} not started yet. Ask the user once: visible window or headless (hidden)? ` +
          `Then call again with headless (windowed false, headless true).`);
      }
    }
    // 작은 번호부터 차례로 켠다 (작업표시줄에도 그 순서로 놓인다). 한 번의 호출로 끝내서 왕복을 줄인다.
    const lines: string[] = [];
    let anyLaunched = false;
    for (const slot of targets) {
      const { launched } = await launchSlot(slot, me, { headless, url: startUrl.get(slot), proxy: proxyOf.get(slot) });
      anyLaunched ||= launched;
      if (launched) await recordAction(slot, '', me, 'launch', undefined, !agent);
      const running = readRegistry().slots[String(slot)];
      const mode = running?.headless ? 'headless' : 'windowed';
      const via = running?.proxy ? `, proxy ${running.proxy}` : '';
      let line = launched ? `Started slot ${slot} Chrome ${mode} (port ${portOf(slot)}${via})${startUrl.get(slot) ? ` → opening ${truncate(startUrl.get(slot)!, 60)}` : ''}.` : `Slot ${slot} Chrome already running; attached.`;
      if (!launched && headless !== undefined && headless !== !!running?.headless) {
        line += ` [warning] Already running ${mode}, attached as is. To change, browser_close then launch again.`;
      }
      const askedProxy = proxyOf.get(slot);
      if (!launched && askedProxy && running?.proxy !== describeProxy(askedProxy)) {
        line += ` [warning] Already running ${running?.proxy ? `with proxy ${running.proxy}` : 'without proxy'}, so the requested proxy was not applied. To apply, browser_close then launch again with proxy.`;
      }
      lines.push(line);
    }
    let msg = lines.join('\n');
    if (anyLaunched && picked) {
      msg += targets.length === 1 ? '\nNo number given; picked the lowest free slot.' : '\nNo numbers given; picked free slots, lowest first.';
    }
    if (targets.length > 1 && !isClaudeCode()) {
      msg += '\n[Next] For different jobs per slot, give each slot its own subagent if available; otherwise process them in turn with a distinct agent name per slot (e.g. "slot1-agent"). ' +
        'If the user must log in, don\'t ask them to "tell me when done"; detect completion with browser_wait url/gone/text.';
    }
    if (targets.length > 1 && isClaudeCode()) {
      msg += '\n[Next] For different jobs per slot, now call the Agent tool once per slot in a single message (run_in_background: true) to launch subagents (subagent_type "cdpm-browser") together. Prompts: slot number, agent name, task only, 1-3 lines ' +
        '(each uses its slot number and own agent name). Subagents do everything from the first navigation; main must not pre-navigate slots or process them in turn. ' +
        'If the user must log in, don\'t ask them to "tell me when done"; let subagents detect it with browser_wait url/gone/text.';
      if (targets.length > 20) {
        msg += `\n[warning] At most 20 subagents run at once (the 21st+ is refused). Launch 20 of ${targets.length} first, then the remaining ${targets.length - 20} as they finish. ` +
          'To launch all at once, the user must raise the env var CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.';
      }
    }
    const first = targets[0];
    return textResult(`${await header(first, me, await syncTabs(first))}\n---\n${msg}`);
  }));

  server.registerTool('browser_close', {
    title: 'Close slot',
    description: 'Closes slot Chrome cleanly (session and cookies saved). The profile (logins) is kept. Reports if another agent used it recently.',
    inputSchema: { slot: slotArg, agent: agentArg },
  }, async ({ slot, agent }) => guard(() => withSlotLock(slot, async () => {
    const me = agent ?? DEFAULT_AGENT;
    if ((await probe(slot)).state !== 'chrome') {
      await forgetSlot(slot);
      return textResult(`Slot ${slot} Chrome is already closed.`);
    }
    const rec = readRegistry().slots[String(slot)];
    const warnings: string[] = [];
    if (rec?.last && rec.last.agent !== me && secondsSince(rec.last.at) <= 120) {
      warnings.push(`${rec.last.agent} used this slot (${ago(rec.last.at)}).`);
    }
    const browser = await browserConnection(slot);
    await browser.send('Browser.close', {}, 5000).catch(() => undefined);
    for (let i = 0; i < 25 && (await probe(slot, 500)).state === 'chrome'; i++) await sleep(200);
    // 포트가 닫혀도 프로세스는 잠깐 더 살아 프로필을 붙잡는다. 끝날 때까지 기다려야 바로 다시 켜도 안전하다.
    for (let i = 0; rec?.pid && i < 50 && pidAlive(rec.pid); i++) await sleep(100);
    await forgetSlot(slot);
    return textResult([...warnings, `Closed slot ${slot} Chrome. The profile is kept, so logins persist next launch.`].join('\n'));
  })));

  server.registerTool('browser_tabs', {
    title: 'List tabs',
    description: 'Slot tab list: number, ID, title, URL, opener, last action, per-tab summary (updated only by actions with summary). "·front" marks the tab currently in front in its window (one per window).',
    inputSchema: { slot: slotArg, agent: agentArg },
  }, async ({ slot, agent }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    const tabs = await syncTabs(slot);
    const head = await header(slot, me, tabs);
    const detail = tabs.filter((t) => t.rec.summary)
      .map((t) => `${t.no}. [${t.id}] summary: ${t.rec.summary!.agent} — ${t.rec.summary!.text} (${ago(t.rec.summary!.at)})`);
    return textResult(`${head}\n---\n${detail.length ? detail.join('\n') : 'No per-tab summaries'}`);
  }));

  server.registerTool('browser_tab_new', {
    title: 'New tab',
    description: 'Opens a new tab in the slot and returns its ID. When agents share a slot, open your own tab and work only by its ID to avoid mixing.',
    inputSchema: { slot: slotArg, agent: agentArg, url: z.string().optional().describe('URL to open (omit for blank tab)'), summary: summaryArg },
  }, async ({ slot, agent, url, summary }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const paused = pausedRefusal(slot);
    if (paused) return textResult(paused, true);
    await attachSlot(slot);
    const browser = await browserConnection(slot);
    const target = url ? (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`) : 'about:blank';
    const ext = act.externalScheme(target);
    if (ext) throw new CdpmError(`Can't open a ${ext} URL (${target.slice(0, 80)}) (it would launch another program on the user's PC).`);
    // background: 사용자가 보고 있는 탭을 바꾸지 않는다.
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: target, background: true });
    markCreated(targetId, me);
    lastTabOf.set(`${slot}:${me}`, targetId);
    await syncTabs(slot);
    await recordAction(slot, targetId, me, 'open tab', summary);
    const tabs = await syncTabs(slot);
    const tab = tabs.find((t) => t.targetId === targetId);
    return compose(await header(slot, me, tabs, { executed: targetId }), { text: `Opened new tab: ${tab ? `tab ${tab.no} [${tab.id}]` : targetId}${url ? ` → ${target} (may still be loading)` : ''}` });
  }));

  server.registerTool('browser_tab_close', {
    title: 'Close tab',
    description: 'Closes a tab. tab is required.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: z.union([z.string(), z.number()]).describe('Tab to close: number or ID ("t7")') },
  }, async ({ slot, agent, tab }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const paused = pausedRefusal(slot);
    if (paused) return textResult(paused, true);
    await attachSlot(slot);
    let tabs = await syncTabs(slot);
    const picked = pickTab(tabs, tab, 'action');
    if ('error' in picked) return textResult(`${await header(slot, me, tabs, { skipMessages: true })}\n---\n${picked.error}`, true);
    const warnings = ownershipWarnings(picked.tab, me);
    const browser = await browserConnection(slot);
    await browser.send('Target.closeTarget', { targetId: picked.tab.targetId });
    await sleep(200);
    tabs = await syncTabs(slot);
    return textResult(`${await header(slot, me, tabs, { warnings })}\n---\nClosed tab: tab ${picked.tab.no} [${picked.tab.id}] ${picked.tab.title}`);
  }));

  server.registerTool('browser_tab_select', {
    title: 'Bring tab to front',
    description: 'Brings a tab to the front of its Chrome window. Changes what the user sees, so use only when the user wants it. (Background tabs can be read, operated and captured; no need to bring them forward to work.)',
    inputSchema: { slot: slotArg, agent: agentArg, tab: z.union([z.string(), z.number()]).describe('Tab to bring forward: number or ID') },
  }, async (args) => onTab(args, 'action', 'select tab', async (s, tab) => {
    const browser = await browserConnection(s.slot);
    await browser.send('Target.activateTarget', { targetId: tab.targetId });
    forgetSlotVisibility(s.slot);
    await sleep(150);
    return { text: `Brought tab ${tab.no} [${tab.id}] to front.` };
  }));

  // ---------- 보기 ----------
  server.registerTool('browser_snapshot', {
    title: 'Snapshot',
    description: 'Reads the tab as accessibility-tree text. Clickable/typable elements get refs like [e12]. ' +
      'Long pages are split; only page 1 (top) is shown (page=2 to continue; refs stay the same across pages). ' +
      'find="text" shows only matching elements with their parent context; ref="e40" shows only that element\'s subtree. Refs change when the page changes, so re-snapshot before acting.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, page: pageArg,
      find: z.string().optional().describe('Only lines containing this text, with parent context (ignores case and spaces). If unsure of site language, use | for alternatives, e.g. "제목|subject"'),
      interactive: z.boolean().optional().describe('Only actionable elements (lines with refs): inputs, buttons, links. Use first to find inputs on big pages like Gmail'),
      ref: z.string().optional().describe('Only this ref element and its subtree'),
    },
  }, async (args) => onTab(args, 'view', null, async (s, tab, agent) => {
    const page = args.page ?? 1;
    const cache = s.snapshotFor(agent);
    const sameUrl = cache && cache.url.split('#')[0] === tab.url.split('#')[0];
    // 2쪽부터는 1쪽을 찍은 그 스냅샷에서 이어 보여준다 (ref 번호 유지).
    const full = page > 1 && cache && sameUrl && Date.now() - cache.at < 5 * 60_000 ? cache.text : (await takeSnapshot(s, agent)).text;
    // interactive: ref가 붙은 줄(조작할 수 있는 요소와 제목)만 → 큰 페이지에서도 몇 쪽 안에 입력칸·버튼이 다 보인다
    const text = args.interactive ? full.split('\n').filter((l) => /\[e\d+\]/.test(l)).map((l) => l.trimStart()).join('\n') : full;
    if (!text) return { text: '(no readable elements)' };
    if (args.ref) {
      const sub = subtree(text, args.ref);
      if (!sub) throw new CdpmError(`[${args.ref}] not found in this snapshot. Re-snapshot without ref to check.`);
      const p = paginate(sub, page);
      return { text: p.body + pageFooter(p, sub.length) };
    }
    if (args.find) {
      const f = findLines(text, args.find);
      if (!f.matches) return { text: `No elements contain "${args.find}". (${text.length.toLocaleString()} chars total)` };
      const p = paginate(f.body, page);
      return { text: `${p.body}\n\n— "${args.find}": ${f.matches} match(es)${f.matches > 150 ? ' (first 150 shown)' : ''}${pageFooter(p, f.body.length)}` };
    }
    const p = paginate(text, page);
    const context = p.page > 1 ? ancestorsOf(text, p.start) : [];
    const head = context.length ? `(parent context of this page)\n${context.join('\n')}\n  ┄┄┄\n` : '';
    return { text: head + p.body + pageFooter(p, text.length, ` · search: find="…" · region: ref="eN"${args.interactive ? '' : ' · inputs/buttons only: interactive=true'}`) };
  }));

  server.registerTool('browser_text', {
    title: 'Read text',
    description: 'Reads the page body text (main/article if present). With ref, only that element\'s text. Shorter and easier than a snapshot for articles/documents. Use page for long text.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().optional().describe('Only this element\'s text'), page: pageArg },
  }, async (args) => onTab(args, 'view', null, async (s, _tab, agent) => ({ text: await act.extractText(s, agent, args.ref, args.page ?? 1) })));

  server.registerTool('browser_screenshot', {
    title: 'Screenshot',
    description: 'Captures the visible area of the tab as PNG, even background tabs (without switching). Never changes window size or viewport, so full-page capture is unsupported (scroll then capture, or use snapshot/text).',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    const data = await act.screenshot(s, await browserConnection(s.slot));
    return { text: 'Captured.', image: data };
  }, { render: true }));

  // ---------- 조작 ----------
  server.registerTool('browser_navigate', {
    title: 'Navigate',
    description: 'Navigates the tab to a URL and waits for the body to load.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, url: z.string().describe('URL to go to'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'navigate', async (s) => ({ text: (await act.navigate(s, args.url)) + act.downloadNote(s) })));

  server.registerTool('browser_back', {
    title: 'Back',
    description: 'Go back.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'back', async (s) => ({ text: await act.back(s) })));

  server.registerTool('browser_forward', {
    title: 'Forward',
    description: 'Go forward (after going back).',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'forward', async (s) => ({ text: await act.forward(s) })));

  server.registerTool('browser_reload', {
    title: 'Reload',
    description: 'Reloads the page (same as Chrome reload). ignore_cache=true bypasses the cache. Careful: unsaved user input on the page is lost.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ignore_cache: z.boolean().optional().describe('Bypass cache (hard reload)'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'reload', async (s) => ({ text: await act.reload(s, args.ignore_cache ?? false) })));

  server.registerTool('browser_dialog', {
    title: 'Handle dialog',
    description: 'Accepts (accept: true) or dismisses (accept: false) an open dialog (alert/confirm/prompt/beforeunload). The tab is frozen while a dialog is open. ' +
      'Usually judge from its content and handle it yourself (accept if it is part of the requested task; close unneeded notices/ads). Ask the user only when it confirms an irreversible action they didn\'t request (payment, deletion, etc.). ' +
      'beforeunload: accept = leave page (input lost), dismiss = stay. For prompt, text is the input.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, accept: z.boolean().describe('true = OK, false = cancel'), text: z.string().optional().describe('Text for a prompt dialog (used only when accepting)'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'dialog', async (s) => ({ text: await act.handleDialog(s, args.accept, args.text) }), { render: false }));

  server.registerTool('browser_permission', {
    title: 'Answer permission bubble',
    description: 'Lists or answers Chrome permission bubbles ("site wants to: access other apps and services on this device / show notifications / know your location…"). ' +
      'They are browser UI: not in snapshot/screenshot, page tools can\'t click them, and the page often waits until they are answered. The header warns when one is open. ' +
      'Without button: shows the open bubbles with their exact button names. With button: presses that button (exact name as listed, e.g. "허용", "Allow", "Block", "Allow while visiting the site"). Windows, windowed slots only.',
    inputSchema: {
      slot: slotArg, agent: agentArg, multiSlot: multiSlotArg,
      button: z.string().optional().describe('Exact button name to press, as listed in the header or by calling without button'),
      site: z.string().optional().describe('Only when several bubbles are open: part of the bubble title (e.g. the site host) to pick one'),
    },
  }, async ({ slot, agent, multiSlot, button, site }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    if (button) {
      const refused = multiSlotRefusal(me, slot, multiSlot) ?? pausedRefusal(slot);
      if (refused) return textResult(refused, true);
    }
    await attachSlot(slot);
    const tabs = await syncTabs(slot);
    const head = async () => header(slot, me, await syncTabs(slot).catch(() => tabs), { skipMessages: true });
    if (process.platform !== 'win32') return textResult(`${await head()}\n---\nPermission bubbles can only be detected and answered on Windows.`, true);
    const hosts = hostsOf(tabs.map((t) => t.url));
    const all = permissionBubbles(slot, hosts);
    const list = site ? all.filter((b) => b.title.includes(site)) : all;
    if (!list.length) return textResult(`${await head()}\n---\nNo Chrome permission bubble is open on slot ${slot}${site ? ` matching "${site}"` : ''}.`);
    if (!button) {
      const lines = await Promise.all(list.map(async (b) => `- ${bubbleLine(b, await bubbleDetail(b))}`));
      return textResult(`${await head()}\n---\n${lines.join('\n')}`);
    }
    if (list.length > 1) return textResult(`${await head()}\n---\n${list.length} bubbles are open; pass site to pick one: ${list.map((b) => `"${b.title}"`).join(', ')}`, true);
    const b = list[0];
    if (!(await pressBubble(b, button))) {
      const d = await bubbleDetail(b);
      return textResult(`${await head()}\n---\nNo button named "${button}" in "${b.title}".${d?.buttons.length ? ` Buttons: ${d.buttons.join(', ')}.` : ''}`, true);
    }
    // 눌린 뒤 말풍선이 닫혔는지 확인 (보통 바로 닫힌다)
    let gone = false;
    for (let i = 0; i < 10 && !gone; i++) {
      await sleep(100);
      gone = !permissionBubbles(slot, hosts).some((x) => x.key === b.key && x.title === b.title);
    }
    const target = tabs.find((t) => hostsOf([t.url]).some((h) => b.title.includes(h)));
    if (target) await recordAction(slot, target.targetId, me, `permission: ${button}`, undefined, !agent).catch(() => false);
    return textResult(`${await head()}\n---\nPressed "${button}" on "${b.title}"${target ? ` (tab ${target.no} [${target.id}])` : ''}${gone ? '; the bubble closed.' : '; the bubble is still open (check again).'}`);
  }));

  server.registerTool('browser_hover', {
    title: 'Hover',
    description: 'Moves the real mouse over a ref element (no click). For hover menus and tooltips. Use read=changes to see the opened menu.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('ref of the element to hover'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'hover', async (s, _tab, agent) => ({ text: await act.hover(s, agent, args.ref) })));

  server.registerTool('browser_drag', {
    title: 'Drag',
    description: 'Drags with the real mouse (press → move in steps → release): drag and drop, sliders, reordering, drag CAPTCHAs, etc. ' +
      'Target: to (element ref), to_text (text at the drop spot), or dx/dy (pixels from from). HTML drag is handled without starting an OS drag.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      from: z.string().describe('ref of the element to drag (including ones marked draggable)'), to: z.string().optional().describe('ref of the drop target'),
      to_text: z.string().optional().describe('Text shown at the drop spot (when it has no ref, e.g. "Drop here")'),
      dx: z.number().optional().describe('Horizontal pixels (right +)'), dy: z.number().optional().describe('Vertical pixels (down +)'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', 'drag', async (s, _tab, agent) => ({ text: await act.drag(s, agent, args.from, args.to, args.dx, args.dy, args.to_text) })));

  server.registerTool('browser_download_wait', {
    title: 'Wait for download',
    description: 'Waits for the most recently started download to finish and returns the saved file path (user\'s Chrome download folder). Call after clicking the download button. Returns as soon as it finishes.',
    inputSchema: { slot: slotArg, agent: agentArg, timeout: z.number().min(1).max(600).optional().describe('Max wait in seconds (default 120)') },
  }, async ({ slot, agent, timeout }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    const stop = () => (hasUnread(slot, me) ? 'Stopped waiting: a new message arrived (check with slot_inbox).' : undefined);
    try {
      return textResult(await waitDownload(slot, timeout ?? 120, stop));
    } catch (e) {
      throw new CdpmError((e as Error).message);
    }
  }));

  server.registerTool('browser_pdf', {
    title: 'Save as PDF',
    description: 'Saves the page as a PDF (receipts, articles, etc.). Without path, saves to the user\'s Downloads folder named after the page title. Doesn\'t change the screen or window.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, path: z.string().optional().describe('File path to save (e.g. C:\\Users\\me\\Desktop\\receipt.pdf)') },
  }, async (args) => onTab(args, 'view', null, async (s, tab) => ({ text: await act.pdf(s, args.path, tab.title) })));

  server.registerTool('browser_click', {
    title: 'Click',
    description: 'Clicks a ref element with real mouse events. If another element covers it, doesn\'t click and reports it. Waits for loading if the click navigates; reports new tabs. ' +
      'Clicking a file input or "attach" button intercepts the OS file picker (not shown); then use browser_upload. Doesn\'t click <select> dropdowns (they open a list popup on the user\'s screen); use browser_select.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('ref from browser_snapshot (e.g. "e12")'), double: z.boolean().optional().describe('Double-click'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'click', async (s, _tab, agent) => ({ text: await act.click(s, agent, args.ref, args.double ?? false) })));

  server.registerTool('browser_type', {
    title: 'Type',
    description: 'Types text into a ref element, sending real key events (keydown/keypress/input/keyup) per character like a human. ' +
      'clear=true clears existing content; submit=true presses Enter after. Verifies the resulting value and reports a mismatch. ' +
      'fast=true inserts very long text at once without key events. Date/time inputs get the value set directly in their format (time "19:30", date "2026-10-08"; change event then has isTrusted=false).',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('ref of the element to type into'), text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing content'), submit: z.boolean().optional().describe('Press Enter after'),
      fast: z.boolean().optional().describe('Very long text: insert at once without key events'), read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', 'type', async (s, _tab, agent) => ({ text: await act.type(s, agent, args.ref, args.text, args.clear ?? false, args.submit ?? false, args.fast ?? false) })));

  server.registerTool('browser_fill', {
    title: 'Fill form',
    description: 'Fills several inputs on the same page in order (each cleared, typed with real key events, value verified). ' +
      'Stops on page change, dialog, or any failed field, and reports how far it got. ' +
      'submit="Enter" presses Enter in the last field; a button ref clicks that button. For dropdowns use browser_select.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      fields: z.array(z.object({ ref: z.string().describe('Input ref'), text: z.string().describe('Text to enter') })).min(1).max(30).describe('Fields to fill (top to bottom)'),
      submit: z.string().optional().describe('After filling: "Enter" or a button ref to click'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', 'fill', async (s, _tab, agent) => {
    const href = async () => (await s.evaluate<string>('location.href', { timeoutMs: 3000 }).catch(() => undefined))?.value;
    const start = await href();
    const done: string[] = [];
    const stop = (why: string) => ({ text: [...done, why].join('\n') });
    for (const [i, f] of args.fields.entries()) {
      if (s.dialog) return stop(`Stopped before field ${i + 1}: a dialog appeared.`);
      if (pausedInfo(args.slot)) return stop(`Stopped before field ${i + 1}: the user paused the slot.\n${pausedRefusal(args.slot)}`);
      if (i > 0 && (await href()) !== start) return stop(`Page changed; field ${i + 1} [${f.ref}] and after were not filled.`);
      try {
        const r = await act.type(s, agent, f.ref, f.text, true, false);
        done.push(`${i + 1}. ${r}`);
        if (r.includes(act.VALUE_MISMATCH)) return stop(`Stopped: field ${i + 1} [${f.ref}] value differs from the intended text (not submitted). Check the value and retry.`);
      } catch (e) {
        if (e instanceof act.DialogInterrupt) throw e;
        return stop(`Stopped at field ${i + 1} [${f.ref}]: ${(e as Error).message}`);
      }
    }
    if (args.submit) {
      if (s.dialog) return stop('Stopped before submit: a dialog appeared.');
      done.push(`Submit: ${args.submit.toLowerCase() === 'enter' ? await act.pressKey(s, 'Enter') : await act.click(s, agent, args.submit, false)}`);
    }
    return { text: done.join('\n') };
  }));

  server.registerTool('browser_upload', {
    title: 'Upload file',
    description: 'Puts files into a file input (no OS file picker shown to the user). Give ref of the file input (<input type=file> or its label), or ' +
      'for a site\'s custom "attach" button, click it first with browser_click (CDPM intercepts the picker) and call without ref. The site gets the same events as a human file pick.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      files: z.array(z.string()).min(1).describe('File paths on this PC (absolute recommended)'),
      ref: z.string().optional().describe('File input ref. Omit to use the file picker just opened by a click'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', 'upload', async (s, _tab, agent) => ({ text: await act.upload(s, agent, args.ref, args.files) })));

  server.registerTool('browser_select', {
    title: 'Select option',
    description: 'Picks an option in a <select> dropdown (by value or visible text; partial match OK). Focuses the dropdown and moves with keys (arrow keys on Windows/Linux, typing the first letters on macOS), so the page gets real events and no list popup opens. If nothing matches, lists the available options.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('ref of the dropdown (combobox)'), option: z.string().describe('Option value or text'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'select', async (s, _tab, agent) => ({ text: await act.select(s, agent, args.ref, args.option) })));

  server.registerTool('browser_press_key', {
    title: 'Press key',
    description: process.platform === 'darwin'
      ? 'Presses a key on the focused element. E.g. Enter, Tab, Escape, ArrowDown, PageDown, Meta+A (select all), Shift+Tab. This PC is macOS, so shortcuts use Meta (Cmd) (Control+A moves to line start).'
      : 'Presses a key on the focused element. E.g. Enter, Tab, Escape, ArrowDown, PageDown, Control+A, Shift+Tab.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, key: z.string().describe(process.platform === 'darwin' ? 'Key name or combo (e.g. "Meta+A")' : 'Key name or combo (e.g. "Control+A")'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'key', async (s) => ({ text: await act.pressKey(s, args.key) })));

  server.registerTool('browser_scroll', {
    title: 'Scroll',
    description: 'Scrolls a ref element into view, or by dy pixels (positive = down, negative = up, default 600). Reports the actual resulting position.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().optional(), dy: z.number().optional(), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'scroll', async (s, _tab, agent) => ({ text: await act.scroll(s, agent, args.ref, args.dy) })));

  server.registerTool('browser_wait', {
    title: 'Wait',
    description: 'Waits until text appears; gone: that text disappears; url: the URL changes; enabled: that button/input becomes enabled; ' +
      'response: a network response for that URL completes (returns its body); network_idle: the network goes quiet; otherwise for seconds. ' +
      'For SPAs (search results, lists, etc.), instead of reading the page, getting the data response (JSON) with response="/api/search" after a click is faster and more accurate (it searches from this agent\'s last action on that tab, so responses that arrived during the click are caught). ' +
      'Only reads, never touches the page, so the user\'s input is not lost (use it to detect login: url, gone="Password" or text="Inbox"). ' +
      'Returns as soon as the condition is met or another agent\'s message arrives. Keep waits minimal: long waits only for humans (login, etc.); to wait for other agents use slot_inbox wait.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      text: z.string().optional().describe('Text to wait for'),
      url: z.string().optional().describe('Until the URL contains this (e.g. "mail.google.com/mail"). "" = until it differs from the current URL'),
      gone: z.string().optional().describe('Until this text disappears from the page (e.g. login form\'s "Password" gone = logged in)'),
      seconds: z.number().min(0).max(60).optional().describe('Plain wait in seconds. Avoid: wait on a condition (text/gone/url) or slot_inbox wait instead'),
      timeout: z.number().min(1).max(600).optional().describe('Max wait in seconds for text/gone/url/enabled/response/network_idle. 300-600 when waiting for a human login, etc.'),
      network_idle: z.boolean().optional().describe('Until no network requests for 0.5s (before capture/read)'),
      enabled: z.string().optional().describe('Until this ref element (button/input) becomes enabled'),
      response: z.string().optional().describe('Until a network response whose URL contains this completes (e.g. "/api/search"). * ? wildcards work (matched against the full URL, e.g. "*api.example.com/v1/items*"). Returns the response body'),
    },
  }, async (args) => onTab(args, 'view', null, async (s, _tab, agent) => {
    // 기다리는 동안 새로 뜬 권한 말풍선도 바로 알린다 (이미 떠 있던 것은 머리말로 이미 알렸으니 제외)
    const hosts = hostsOf((await syncTabs(args.slot).catch(() => [])).map((t) => t.url));
    const known = new Set(permissionBubbles(args.slot, hosts).map((b) => `${b.key}|${b.title}`));
    // 새로 뜬 인쇄 미리보기 (stop은 동기라서 따로 살펴 둔다)
    const printedBefore = new Set((await listPrintPreviews(args.slot).catch(() => [])).map((p) => p.id));
    const printing = new Set<string>();
    const printWatch = setInterval(() => {
      void listPrintPreviews(args.slot).then((l) => { for (const p of l) if (!printedBefore.has(p.id)) printing.add(p.id); }, () => undefined);
    }, 1000);
    // 다른 에이전트가 메시지를 보내면 기다리기를 바로 멈춘다 (메시지는 결과 머리말로 전달됨)
    const stop: act.StopCheck = () => {
      if (pausedInfo(args.slot)) return pausedRefusal(args.slot);
      if (hasUnread(args.slot, agent)) return 'Stopped waiting: a new message arrived (see it in the header above and continue).';
      const fresh = permissionBubbles(args.slot, hosts).find((b) => !known.has(`${b.key}|${b.title}`));
      if (fresh) return `Stopped waiting: Chrome showed a permission bubble "${fresh.title}" (see the header above; answer it with browser_permission).`;
      return printing.size ? 'Stopped waiting: the page opened a print dialog (see the header above).' : undefined;
    };
    try {
      if (args.response !== undefined) {
        if (!args.response.trim()) throw new CdpmError('Put part of the URL to wait for in response (e.g. "/api/search").');
        // 이 에이전트가 이 탭에서 마지막으로 조작한 뒤(2분 안)의 요청부터. 조작 기록이 없으면 지금부터.
        const last = s.actionStartedAt.get(agent);
        const since = last && Date.now() - last < 120_000 ? last : Date.now();
        try {
          const e = await act.waitForResponse(s, args.response, since, args.timeout ?? 30, stop);
          if (e.failed) return { text: `Response failed: ${netLine(e)}` };
          return { text: `Response received: ${netLine(e)}\nURL: ${decodeUrl(e.url).slice(0, 300)}\n\n[Response body]\n${await responseBody(s, e)}` };
        } catch (err) {
          if (err instanceof act.WaitStopped) return { text: err.message };
          throw err;
        }
      }
      if (args.enabled) return { text: await act.waitForEnabled(s, agent, args.enabled, args.timeout ?? 30, stop) };
      if (args.network_idle) return { text: await act.waitNetworkIdle(s, args.timeout ?? 15, 500, stop) };
      if (args.text) return { text: await act.waitForText(s, args.text, args.timeout ?? 30, stop) };
      if (args.url !== undefined) return { text: await act.waitForUrl(s, args.url || undefined, args.timeout ?? 30, stop) };
      if (args.gone) return { text: await act.waitForGone(s, args.gone, args.timeout ?? 30, stop) };
      const sec = args.seconds ?? 1;
      const until = Date.now() + sec * 1000;
      while (Date.now() < until) {
        const why = stop();
        if (why) return { text: why };
        await sleep(Math.min(100, until - Date.now()));
      }
      return { text: `Waited ${sec}s.` };
    } finally {
      clearInterval(printWatch);
    }
  }));

  server.registerTool('browser_eval', {
    title: 'Run JS',
    description: 'Evaluates a JavaScript expression in the tab and returns the result as JSON. Escape hatch only when other tools can\'t do it. ' +
      'Runs in an isolated world: DOM can be read and modified, but globals created by page scripts (window.appVar, etc.) are not visible.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, expression: z.string().describe('JS expression (Promises are awaited)'), summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'eval JS', async (s) => ({ text: await act.evaluate(s, args.expression) })));

  // ---------- 네트워크 ----------
  server.registerTool('browser_network', {
    title: 'Network requests',
    description: 'Tab network request list (newest at bottom). Records the latest 500 since CDPM first attached to the tab. Filter with filter (URL part), type (Document, XHR, Fetch, Script, Image, etc.), failed (failures only). For details pass the n-number to browser_network_detail.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      filter: z.string().optional().describe('Only requests whose URL contains this'),
      type: z.string().optional().describe('Request type (e.g. XHR, Fetch, Document, Script, Image)'),
      failed: z.boolean().optional().describe('Failed requests only'),
      limit: z.number().int().min(1).max(200).optional().describe('Max count (default 40, newest first)'),
    },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    let list = s.network.list();
    const total = list.length;
    if (args.filter) list = list.filter((e) => e.url.toLowerCase().includes(args.filter!.toLowerCase()) || decodeUrl(e.url).toLowerCase().includes(args.filter!.toLowerCase()));
    if (args.type) list = list.filter((e) => e.type.toLowerCase() === args.type!.toLowerCase());
    if (args.failed) list = list.filter((e) => e.failed);
    const limit = args.limit ?? 40;
    const shown = list.slice(-limit);
    const since = new Date(s.network.startedAt).toLocaleTimeString('en-GB', { hour12: false });
    const head = `Recording since ${since} (when CDPM first attached to this tab) · ${list.length} of ${total} recorded match${list.length > limit ? `, newest ${limit} shown` : ''}`;
    return { text: `${head}\n${shown.length ? shown.map((e) => netLine(e, s.network.rules)).join('\n') : '(no matching requests)'}` };
  }));

  server.registerTool('browser_network_detail', {
    title: 'Network request detail',
    description: 'Shows one request\'s headers, sent data and response body (start of it, if text). id is the n-number from browser_network.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, id: z.string().describe('Request number (e.g. "n12")'), body: z.boolean().optional().describe('Include response body (default true)') },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    const e = s.network.find(args.id);
    if (!e) throw new CdpmError(`Request "${args.id}" not found. Check numbers with browser_network (only the latest 500 are kept).`);
    const parts = [netLine(e), '', `URL: ${decodeUrl(e.url)}`, '', '[Request headers]', headersText(e.requestHeaders)];
    if (e.hasPostData) {
      const post = await s.send<{ postData: string }>('Network.getRequestPostData', { requestId: e.requestId }, 5000).catch(() => undefined);
      parts.push('', '[Sent data]', post ? truncate(post.postData, 5000) : '  (unavailable)');
    }
    parts.push('', '[Response headers]', headersText(e.responseHeaders));
    if (args.body !== false && !e.failed && e.status !== undefined) parts.push('', '[Response body]', await responseBody(s, e));
    return { text: parts.join('\n') };
  }));

  server.registerTool('browser_block', {
    title: 'Block requests',
    description: 'Blocks tab network requests matching URL patterns (they fail). add adds, remove removes, clear removes all rules you set. ' +
      'Patterns: * any chars, ? one char. A bare domain matches every request containing it ("ads.example.com" → "*ads.example.com*"). A trailing * is added automatically so query strings still match ("*.png" → "*.png*"). The tab skips the cache while rules exist. ' +
      'Rules last only while this Claude session is alive and are shown to other agents in the header. With no args, shows current rules.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      add: z.array(z.string()).optional().describe('URL patterns to block'),
      remove: z.array(z.string()).optional().describe('Patterns to unblock'),
      clear: z.boolean().optional().describe('Remove all rules set by this session'),
      summary: summaryArg,
    },
  }, async (args) => onTab(args, args.add?.length || args.remove?.length || args.clear ? 'action' : 'view', args.add?.length ? 'block requests' : args.remove?.length || args.clear ? 'unblock requests' : null, async (s, tab, agent) => {
    let rules: BlockRule[] = [...s.network.rules];
    if (args.clear) rules = [];
    for (const p of args.remove ?? []) {
      const n = normalizePattern(p);
      rules = rules.filter((r) => r.pattern !== n && r.pattern !== p.trim());
    }
    for (const p of args.add ?? []) {
      const n = normalizePattern(p);
      if (!rules.some((r) => r.pattern === n)) rules.push({ pattern: n, agent, at: nowIso() });
    }
    const changed = args.clear || args.add?.length || args.remove?.length;
    if (changed) {
      await s.network.setRules(rules);
      await updateRegistry((r) => {
        const t = r.slots[String(s.slot)]?.tabs[tab.targetId];
        if (!t) return;
        const others = (t.blocks ?? []).filter((b) => b.pid !== process.pid && pidAlive(b.pid));
        t.blocks = [...others, ...rules.map((x) => ({ pattern: x.pattern, agent: x.agent, at: x.at, pid: process.pid }))];
        if (!t.blocks.length) delete t.blocks;
      }).catch(() => undefined);
    }
    const others = liveBlocks(tab).filter((b) => b.pid !== process.pid);
    const lines = [
      changed ? 'Block rules updated.' : 'Current block rules:',
      `This session: ${rules.length ? rules.map((r) => `${r.pattern} (${r.agent})`).join(', ') : 'none'}`,
    ];
    if (others.length) lines.push(`Other sessions: ${others.map((b) => `${b.pattern} (${b.agent})`).join(', ')} — only removable from that session`);
    lines.push('Blocked requests show in browser_network as "failed … (blocked: pattern)".');
    return { text: lines.join('\n') };
  }));

  // ---------- 메시지 ----------
  const slotsArg = z.array(slotArg).optional().describe('Multiple slots (e.g. [1,2,3])');
  server.registerTool('slot_pause', {
    title: 'Pause slot',
    description: 'Use only when the user says to pause (e.g. "pause 3"); agents never call it on their own. All action tools on the slot are refused and any browser_wait in progress stops at once. ' +
      'An action already sent to Chrome finishes. Reading still works. Applies immediately to agents in other Claude sessions too. all=true pauses every running slot.',
    inputSchema: { slot: slotArg.optional(), slots: slotsArg, all: z.boolean().optional().describe('All running slots'), agent: agentArg },
  }, async ({ slot, slots, all, agent }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const targets = all ? (await liveSlots()).map(([s]) => s) : [...new Set([...(slots ?? []), ...(slot !== undefined ? [slot] : [])])];
    if (!targets.length) throw new CdpmError('Specify slots to pause (slot, slots or all).');
    return textResult((await pauseSlots(targets, me)).join('\n') + '\nTo resume: slot_resume when the user says so, or `cdpm resume <number>` in a terminal.');
  }));

  server.registerTool('slot_resume', {
    title: 'Resume slot',
    description: 'Use only when the user says to resume (e.g. "continue 3"); the agent owning a paused slot never calls it on its own. Unpauses and messages every agent on the slot to wake it (agents re-read the page and continue). all=true resumes every paused slot.',
    inputSchema: { slot: slotArg.optional(), slots: slotsArg, all: z.boolean().optional().describe('All paused slots'), agent: agentArg },
  }, async ({ slot, slots, all, agent }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const targets = all ? (await import('../pause.js')).pausedSlots() : [...new Set([...(slots ?? []), ...(slot !== undefined ? [slot] : [])])];
    if (!targets.length) return textResult(all ? 'No paused slots.' : 'Specify slots to resume (slot, slots or all).', !all);
    return textResult((await resumeSlots(targets, me)).join('\n'));
  }));

  server.registerTool('slot_send', {
    title: 'Send message',
    description: 'Sends a message to other agents (real-time collaboration). slot = the slot the recipient owns (to reach another slot\'s agent, use that slot number). Omit to to send to everyone on that slot. ' +
      'Recipients get it instantly if waiting in slot_inbox wait, otherwise in their next tool result header (a running browser_wait stops at once). When you finish a step, notify waiting agents right away.',
    inputSchema: { slot: slotArg, agent: agentArg, text: z.string().min(1).max(2000), to: z.string().optional().describe('Recipient agent name') },
  }, async ({ slot, agent, text, to }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const msg = await sendMessage(slot, me, text, to ?? null);
    return textResult(`[Slot ${slot}] Message sent (#${msg.seq}${to ? `, to: ${to}` : ', to everyone'}).`);
  }));

  server.registerTool('slot_inbox', {
    title: 'Check messages',
    description: 'Shows your unread messages. With wait (seconds), waits up to that long for a new message (for real-time conversation). ' +
      'Messages already delivered in another tool\'s header are not unread; when there are no new ones, recently received ones are noted for reference.',
    inputSchema: { slot: slotArg, agent: agentArg, wait: z.number().min(0).max(600).optional().describe('Max seconds to wait for a new message; returns as soon as one arrives (use this instead of repeatedly checking the page while waiting for another agent)') },
  }, async ({ slot, agent, wait }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const msgs = wait ? await waitUnread(slot, me, wait) : await takeUnread(slot, me);
    if (msgs.length) return textResult(`[Slot ${slot}] ${msgs.length} new message(s)\n${formatMessages(msgs).map((l) => `  ${l}`).join('\n')}`);
    const recent = recentDelivered(slot, me);
    const tail = recent.length ? ` (${recent.length} message(s) already delivered via other tool headers in the last 10 min are not repeated)` : '';
    return textResult(`[Slot ${slot}] No new messages${wait ? ` (waited ${wait}s)` : ''}.${tail}`);
  }));
}

const INSTRUCTIONS_CLAUDE_CODE = `CDPM: controls Chrome slots 1-30 over CDP. Slot N's CDP port is ${PORT_BASE}+N (slot 1 = ${PORT_BASE + 1}).
- Always reply to the user in the language the user writes in (these instructions are in English only to save tokens).
- When telling the user about slot work, always name the tab too, not just the slot: e.g. "working in slot 1, tab 3 [t7]" (tab order from the header, plus its ID).
- "Look at 3" / "slot 3" means slot=3. Pass slot to every tool.
- Start Chrome with browser_launch only when the user asks. Other tools never start a closed slot. "Start one" with no number → omit slot (lowest free slot).
- The user decides windowed (visible) vs headless (hidden): headless: true only if they say "headless", "hidden" or "no window"; false for "visible window" or "headful". If unstated, don't guess; ask first (once for multiple slots).
- If the start page is known, pass url (same for all slots) or urls (per slot) to browser_launch so it opens right away (no separate navigation step for subagents).
- Different jobs on multiple slots (e.g. "open 3, one for Naver, one for Daum…", "log in on 1 and open another site on 2") run in parallel by default: main only calls browser_launch once (slots/count, start URLs url/urls), then immediately hands each slot to its own subagent. Subagents do everything from the first navigation (main doesn't pre-navigate slots). Call the Agent tool several times in one message, all with run_in_background: true (don't launch one at a time or wait for earlier ones). Keep subagent prompts to 1-3 lines: slot number, agent name (e.g. "naver-agent", passed as agent on every tool), and the task. cdpm-browser already knows CDPM usage and rules (login detection, signaling, minimal waiting), so don't re-explain (long prompts cost time). Use subagent_type "cdpm-browser" (CDPM-specific subagent, fast start) if available. At most 20 subagents run at once; with more than 20 slots, launch 20 first and the rest as they finish. Main never works through slots serially, unless the user asks for sequential order.
- Different jobs on tabs within one slot (e.g. "log in on slot 1's first tab, do X on another site in the second tab") are split per tab just like slots: one subagent per tab (main doesn't hop between tabs). Each uses only its tab number or opens its own with browser_tab_new, with a distinct agent name per tab (e.g. "slot1-tab1"). Same slot, so the one-agent-one-slot rule doesn't apply, and actions queue per tab and run concurrently. If a tab's job needs another to finish first (e.g. only works after login), its agent waits with slot_inbox(wait) and the other notifies with slot_send as soon as it's done (login carries over to other tabs: same profile).
- Roles of main agent and subagents (multi-slot/multi-tab work, any site, always):
  - Main: talks with the user, starts/stops slots (one browser_launch / browser_close), assigns slots and tasks to subagents (all in one message), merges results and reports to the user. Main does not navigate, read or operate slot pages.
  - Subagent: one slot only. Does everything: navigation, reading, typing, clicking, detecting completion of user login etc., writing its share of the output, and signaling other subagents if needed.
  - Simple jobs that need just one slot can be done by main directly.
- One agent operates one slot. If the same agent operates another slot within 60s, CDPM refuses (viewing is fine; use multiSlot: true only for jobs that must operate several slots together).
- Outputs (reports, HTML, etc.) are written by each subagent for its share; main only merges (main writing everything alone is the slowest step).
- The header at the top of each result shows the slot's tabs, which tab ran, warnings and new messages. Check it every time to decide the next step.
- With multiple tabs, pass tab (number or ID "t7") to action tools. When several agents share a slot, open your own tab with browser_tab_new and use its ID. Background tabs can be read and operated as is.
- Action tools (navigate, click, type, key, back, select, scroll, fill) accept read, which appends the page after the action. If the next decision needs the page, use read instead of a separate read call: text for articles, snapshot when you need buttons/links to click, changes to see only what changed on the same page (shortest).
- Fill several inputs on one page (login, search filters, etc.) with one browser_fill. File attach: browser_upload (file input ref, or click the "attach" button first, then call without ref). Hover menus: browser_hover; drag/sliders: browser_drag; downloads: click the button, then browser_download_wait returns the saved file path.
- browser_snapshot returns only page 1 (top) of long pages. Don't page through: to find inputs/buttons use interactive=true or find="title|subject" (| for alternatives); for text content use browser_text. A summary you leave is visible to other agents in browser_status.
- Keep waits minimal. Never use fixed waits (seconds).
- Waits that may take minutes (bulk collection/processing, waiting for user login, etc.) are not done by main: hand them to a background subagent (run_in_background: true), then tell the user the status right away and keep the conversation going. While main waits in browser_wait or runs a long foreground shell command, it can't answer the user.
- When the user must do something (login, identity verification, CAPTCHA, payment approval, on any site), don't ask them to "tell me when done". Start subagents first; each, without touching the page (no reload or re-navigation: it wipes the user's input), detects completion with browser_wait and continues: URL change (url), login form text gone (gone), or text shown only after login (text). If the user provides an ID/password (e.g. headless), type it and log in.
- When working with other agents (e.g. emailing each other), signal in real time: as soon as your part is done, slot_send(slot=their slot, to=their name) something like "sent"; when waiting for them, don't reload the page repeatedly, use slot_inbox(slot=your slot, wait=120-600) (returns as soon as a message arrives). On a signal, check the page and act right away.
- Other slots' pages can be viewed anytime with view tools (browser_snapshot, browser_text, browser_screenshot); only that slot's owner operates it.
- Never change window size/position or viewport. Use browser_tab_select (changes the tab the user sees) only when the user wants it.
- "Pause N" → slot_pause; "resume" → slot_resume. Actions on a paused slot are refused: its agent must not operate it and waits with slot_inbox(wait=600); on the resume message it re-reads with browser_snapshot and continues (never resumes on its own).
- When a dialog (alert/confirm/prompt/beforeunload) appears, judge from its content and accept/dismiss it yourself with browser_dialog. Ask the user only when it confirms an irreversible action they didn't request (payment, deletion, etc.).
- If a page opens Chrome's print dialog, the header warns; CDPM does not close it (that tab is frozen until a person does). Tell the user it is open and on which slot and tab, and wait. For a PDF use browser_pdf.
- Chrome permission bubbles ("site wants to access other apps and services on this device", notifications, location, camera, mic…) are browser UI the page can wait on; the header warns when one is open (Windows). Answer it yourself with browser_permission when the task needs it (e.g. a work site asking to reach a local app). Ask the user before allowing camera, microphone or location they didn't ask for.`;

/** Claude Code가 아닌 클라이언트(Cursor, Claude Desktop 등)용: Agent 도구·run_in_background·cdpm-browser처럼 Claude Code에만 있는 말을 뺀다. */
const GENERIC_PARALLEL = '- Different jobs on multiple slots (e.g. "open 3, one for Naver, one for Daum…", "log in on 1 and open another site on 2"): if the client supports subagents, hand each slot to one and run them in parallel (main only launches them with one browser_launch). ' +
  'Without subagents, process slots in turn with a distinct agent name per slot (e.g. "slot1-agent", "slot2-agent"); the same agent name operating another slot within 60s is refused.';

function genericInstructions(): string {
  return INSTRUCTIONS_CLAUDE_CODE
    .split('\n')
    // Claude Code 전용 병렬 처리 안내(Agent 도구·cdpm-browser) → 일반 안내로
    .map((l) => (l.startsWith('- Different jobs on multiple slots') ? GENERIC_PARALLEL : l))
    .map((l) => l.replace('Start subagents first; each, without touching', '(With subagents, start them first.) Each agent, without touching'))
    .map((l) => l.replace('hand them to a background subagent (run_in_background: true)', 'hand them to a subagent or background task'))
    .join('\n');
}

/** 클라이언트에 맞는 서버 안내 (initialize 때 정한다). */
export function serverInstructions(claudeCode: boolean): string {
  return claudeCode ? INSTRUCTIONS_CLAUDE_CODE : genericInstructions();
}

/** 예전 이름 (Claude Code용 안내) */
export const SERVER_INSTRUCTIONS = INSTRUCTIONS_CLAUDE_CODE;
