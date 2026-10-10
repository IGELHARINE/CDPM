// MCP 도구 정의. 실제 동작은 service / page / registry / cdp 부품을 조합만 한다.
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { wildcard, type BlockRule, type NetEntry } from '../cdp/network.js';
import { browserConnection, forgetSlotVisibility, knownDialog, pageSession, type DialogInfo, type PageSession } from '../cdp/sessions.js';
import { ensureDownloadTracking, waitDownload } from '../cdp/downloads.js';
import { probe } from '../cdp/targets.js';
import { describeProxy, parseProxy, type ProxySpec } from '../chrome/proxy.js';
import { CdpmError } from '../errors.js';
import * as act from '../page/actions.js';
import { ancestorsOf, findLines, paginate, subtree, takeSnapshot } from '../page/snapshot.js';
import { hasUnread, recentDelivered, sendMessage, takeUnread, waitUnread } from '../registry/messages.js';
import { readRegistry, updateRegistry, type BlockStamp } from '../registry/store.js';
import {
  attachSlot, forgetSlot, freeSlots, launchSlot, liveSlots, markCreated, ownershipWarnings, pickTab, recordAction, syncTabs,
  type TabKind, type TabView,
} from '../service.js';
import { MAX_SLOT, MIN_SLOT, PORT_BASE, portOf } from '../slots.js';
import { ago, decodeUrl, josa, nowIso, pidAlive, secondsSince, shortUrl, sleep, truncate } from '../util.js';
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
  const now = Date.now();
  const m = recentSlots.get(agent) ?? new Map<number, number>();
  for (const [k, at] of m) if (now - at > 60_000) m.delete(k);
  const others = [...m.keys()].filter((k) => k !== slot).sort((x, y) => x - y);
  if (others.length && !allowed) {
    return `거절했어요: ${agent}은(는) 방금 ${others.join(', ')}번 슬롯을 쓰고 있어서 ${slot}번은 맡지 않아요. ` +
      `슬롯마다 다른 일이면 한 메시지 안에서 Agent 도구를 슬롯 수만큼 함께 불러 서브에이전트(subagent_type "cdpm-browser")를 한꺼번에 띄우고, ` +
      `각자 자기 slot과 agent 이름(예: "${slot}번담당")으로 일하게 하세요. 결과물(보고서·HTML 조각 등)도 각 서브에이전트가 자기 몫을 쓰고 메인은 합치기만 하세요. ` +
      `한 에이전트가 여러 슬롯을 함께 봐야 하는 일(비교 등)이면 multiSlot: true를 넣어 다시 부르세요.`;
  }
  m.set(slot, now);
  recentSlots.set(agent, m);
  return undefined;
}

export const DEFAULT_AGENT = `claude-${randomBytes(2).toString('hex')}`;

const SLOT_RANGE = `슬롯은 ${MIN_SLOT}~${MAX_SLOT}번 숫자입니다`;
const slotArg = z.number({ error: (iss) => (iss.input === undefined ? `slot을 지정하세요 (${MIN_SLOT}~${MAX_SLOT}번 숫자)` : SLOT_RANGE) }).int(SLOT_RANGE).min(MIN_SLOT, SLOT_RANGE).max(MAX_SLOT, SLOT_RANGE)
  .describe(`브라우저 슬롯 번호 ${MIN_SLOT}~${MAX_SLOT}. 사용자가 "3번", "3번 브라우저"라고 하면 3. 사용자가 ${PORT_BASE + 3}처럼 포트로 말하면 ${PORT_BASE}을 빼서 슬롯으로 바꾼다.`);
const agentArg = z.string().min(1).max(40).optional()
  .describe(`내 이름. 다른 에이전트에게 보이는 표시용 이름이다. 서브에이전트는 반드시 자기 이름을 넣는다. 생략하면 "${DEFAULT_AGENT}".`);
const tabArg = z.union([z.string(), z.number()]).optional()
  .describe('대상 탭: 번호(1, 2…) 또는 ID("t7"). 여러 에이전트가 같은 슬롯을 쓸 때는 바뀌지 않는 ID를 쓴다. 탭이 여러 개일 때 조작 도구는 반드시 지정해야 한다.');
const summaryArg = z.string().max(120).optional()
  .describe('지금 하는 일을 한 줄로 (예: "쿠팡 노트북 가격 비교 중"). browser_status에 보인다 (상태줄에는 안 보임). 생략하면 이전 요약 유지.');
const multiSlotArg = z.boolean().optional()
  .describe('한 에이전트가 여러 슬롯을 함께 봐야 하는 일(비교 등)에만 true. 평소에는 넣지 않는다 (한 에이전트 = 한 슬롯, 나머지는 서브에이전트)');
const readArg = z.enum(['text', 'snapshot', 'changes']).optional()
  .describe('조작한 뒤 화면을 결과에 바로 붙인다 (따로 읽으러 갈 필요 없음): text=본문, snapshot=스냅샷 1쪽(ref 포함), changes=직전 스냅샷 대비 새로 생기거나 사라진 줄만 (가장 짧음, 다른 페이지로 바뀌면 전체)');
const pageArg = z.number().int().min(1).optional().describe('쪽 번호 (긴 결과를 나눠 볼 때, 기본 1)');

interface Out {
  text: string;
  image?: string;
}

const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

function errorText(e: unknown): string {
  if (e instanceof CdpmError) return e.message;
  return `오류: ${(e as Error)?.message ?? String(e)}`;
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

async function header(slot: number, agent: string, tabs: TabView[], opts: { executed?: string; warnings?: string[]; skipMessages?: boolean; compact?: boolean } = {}) {
  const messages = opts.skipMessages ? [] : await takeUnread(slot, agent).catch(() => []);
  const warnings = [...(opts.warnings ?? [])];
  for (const t of tabs) {
    const blocks = liveBlocks(t);
    if (blocks.length) warnings.push(`[${t.id}]에서 요청을 막는 중: ${blocks.map((b) => `${b.pattern} (${b.agent})`).join(', ')}`);
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
    return `[${slot}번] 탭 ${tabs.length}개${exec ? ` · ${exec.no}번 탭 [${exec.id}]에서 실행함` : ''} (탭 목록 변화 없음)`;
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
  const refused = kind === 'action' ? multiSlotRefusal(agent, slot, args.multiSlot) : undefined;
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
    let out: Out;
    try {
      const exec = async () => {
        const r = await fn(session, tab, agent);
        // read 옵션: 조작 결과에 바뀐 화면을 바로 붙인다 (같은 줄 세우기 안에서, 다른 조작이 끼어들기 전에)
        if (args.read && kind === 'action') r.text += await readAfter(session, agent, args.read);
        return r;
      };
      const run = () => (render ? session.withRendering(exec) : exec());
      // 조작은 탭마다 줄을 세워 하나씩 (같은 탭에 동시에 오면 서로 섞이지 않게)
      out = kind === 'action' || render ? await session.exclusive(run) : await run();
    } catch (e) {
      // 행동 도중 알림창이 뜬 것은 실패가 아니다 (클릭은 이루어졌음).
      if (!(e instanceof act.DialogInterrupt)) throw e;
      out = { text: `행동은 실행됐고, 그 결과 ${e.message}` };
    }
    tabs = await syncTabs(slot).catch(() => tabs);
    if (action) {
      // 행동·요약·탭 제목을 기록부에 한 번에 쓴다 (여러 에이전트가 동시에 쓸 때 잠금 횟수를 줄임)
      const acted = tabs.find((t) => t.targetId === tab.targetId);
      const ok = await recordAction(slot, tab.targetId, agent, action, args.summary, !args.agent, acted ? acted.title || shortUrl(acted.url) : undefined);
      if (!ok) warnings.push('기록 실패: 공용 기록부를 잠그지 못해 이번 행동은 기록되지 않았어요.');
    }
    const opened = tabs.filter((t) => !before.has(t.targetId));
    if (opened.length) {
      out.text += `\n새 탭이 열렸어요: ${opened.map((t) => `${t.no}번 [${t.id}] ${t.url === 'about:blank' || !t.url ? '(로딩 중)' : truncate(t.title || shortUrl(t.url), 40)}`).join(', ')}`;
    }
    if (action && !session.dialog) {
      // 클릭 등으로 페이지가 전체 화면이 되면 사용자 창 상태가 바뀌므로 바로 해제한다.
      const fs = await session.evaluate<boolean>('(() => { if (!document.fullscreenElement) return false; document.exitFullscreen(); return true; })()', { timeoutMs: 1500 }).catch(() => undefined);
      if (fs?.value) out.text += '\n[주의] 페이지가 전체 화면으로 바뀌어서 바로 해제했어요 (CDPM은 창 상태를 바꾸지 않습니다).';
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
  const next = p.page < p.pages ? ` · 다음: page=${p.page + 1}` : ' · 마지막 쪽';
  return `\n\n— ${p.page}/${p.pages}쪽 (전체 ${total.toLocaleString()}자)${next}${extra}`;
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
    ? `실패 ${e.failed}${blockedBy ? ` (막음: ${blockedBy})` : ''}`
    : e.status !== undefined ? String(e.status) + (e.fromCache ? ' (캐시)' : '') : '…';
  const parts = [`n${e.no}`, e.method, status, e.type, fmtSize(e.size), e.durationMs !== undefined ? `${e.durationMs}ms` : ''].filter(Boolean);
  return `${parts.join('  ')}  ${truncate(decodeUrl(e.url), 140)}`;
}

function headersText(h?: Record<string, string>): string {
  if (!h) return '  (없음)';
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
    title: '슬롯 현황',
    description: '떠 있는 Chrome 슬롯(1~30번)과 각 슬롯의 탭, 연 사람, 마지막 행동, 한 줄 요약을 보여준다. slot을 주면 그 슬롯만.',
    inputSchema: { slot: slotArg.optional(), agent: agentArg },
  }, async ({ slot, agent }) => guard(async () => {
    const live = await liveSlots();
    const target = slot ? live.filter(([s]) => s === slot) : live;
    if (!target.length) return textResult(slot ? `${slot}번 Chrome은 떠 있지 않아요.` : '떠 있는 슬롯이 없어요. 사용자가 켜 달라고 하면 browser_launch로 켜세요.');
    const parts: string[] = [];
    for (const [s] of target) {
      const tabs = await syncTabs(s).catch(() => null);
      const rec = readRegistry().slots[String(s)];
      let part = formatSlotStatus(s, rec ?? { launchedAt: new Date().toISOString(), nextTabSeq: 1, tabs: {} }, tabs);
      for (const t of tabs ?? []) {
        const d = knownDialog(s, t.targetId);
        if (d) part += `\n  [주의] ${d.type} 알림창 떠 있음 ([${t.id}]): "${truncate(d.message, 80)}"`;
      }
      parts.push(part);
    }
    const me = agent ?? DEFAULT_AGENT;
    return textResult(`${parts.join('\n\n')}\n\n(내 이름: ${me})`);
  }));

  server.registerTool('browser_launch', {
    title: '슬롯 켜기',
    description: '슬롯 Chrome을 켠다. 사용자가 켜 달라고 명시적으로 말했을 때만 호출한다 (다른 도구는 꺼진 슬롯을 켜지 않는다). ' +
      'slot을 생략하면 비어 있는 슬롯 중 가장 작은 번호로 켠다. 이미 떠 있으면 붙기만 한다. ' +
      '창 모드(브라우저 보임)인지 헤드리스(안 보임)인지는 사용자가 정한다: 사용자가 말하지 않았으면 추측하지 말고 먼저 물어본 뒤 headless를 넣어 호출한다. ' +
      'headless 없이 꺼진 슬롯을 켜려 하면 켜지 않고 확인 요청만 돌려준다. ' +
      '여러 슬롯은 slots(번호 목록)나 count(개수)로 한 번에 켠다 (작은 번호부터 차례로). 슬롯마다 다른 일을 맡기면, 켠 뒤 슬롯마다 서브에이전트를 띄워 병렬로 처리한다.',
    inputSchema: {
      slot: slotArg.optional().describe('켤 슬롯 하나 (1~30). 사용자가 번호를 말하지 않았으면 생략 → 비어 있는 가장 작은 번호'),
      slots: z.array(slotArg).optional().describe('여러 슬롯을 한 번에 켤 때 번호 목록 (예: [1,2,3]). 작은 번호부터 차례로 켠다'),
      count: z.number().int().min(1).max(MAX_SLOT).optional().describe('번호 없이 "3개 켜줘"처럼 개수만 말했을 때: 비어 있는 슬롯을 작은 번호부터 그 개수만큼 켠다'),
      url: z.string().optional().describe('켜자마자 모든 슬롯에서 열 주소 (예: "https://mail.google.com"). 시작 페이지를 알면 넣어서, 서브에이전트가 따로 이동할 필요가 없게 한다'),
      urls: z.array(z.string()).optional().describe('슬롯마다 다른 시작 주소. slots에 준 순서(count면 켜지는 번호 순서)대로 짝지어진다'),
      agent: agentArg,
      headless: z.boolean().optional().describe('false = 창 모드(브라우저 보임), true = 헤드리스(안 보임). 사용자가 고른 값만 넣는다. 처음 켤 때만 적용'),
      proxy: z.string().optional().describe('사용자가 프록시를 써 달라고 했을 때만 넣는다 (아니면 절대 넣지 않는다). 사용자가 준 그대로: "1.2.3.4:8080", "http://아이디:비번@주소:포트", "socks5://주소:포트", "주소:포트:아이디:비번" 등. 켜는 모든 슬롯에 적용, 처음 켤 때만'),
      proxies: z.array(z.string()).optional().describe('슬롯마다 다른 프록시. slots에 준 순서(count면 켜지는 번호 순서)대로 짝지어진다'),
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
        throw new CdpmError(`비어 있는 슬롯이 ${targets.length}개뿐이에요 (요청 ${count ?? 1}개). 안 쓰는 슬롯을 browser_close로 꺼 주세요.`);
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
      if (ext) throw new CdpmError(`시작 주소로 ${ext} 주소(${u.slice(0, 80)})는 쓸 수 없어요 (사용자 PC의 다른 프로그램이 실행돼요).`);
    }
    targets.sort((x, y) => x - y);
    // 모드를 사용자가 정하지 않았으면 꺼진 슬롯은 켜지 않는다 (이미 떠 있으면 그대로 붙는다).
    if (headless === undefined) {
      const states = await Promise.all(targets.map((t) => probe(t)));
      const closed = targets.filter((_, i) => states[i].state !== 'chrome');
      if (closed.length) {
        return textResult(`[확인 필요] ${closed.join(', ')}번은 아직 켜지 않았어요. 사용자에게 창이 보이게(창 모드) 켤지, 안 보이게(헤드리스) 켤지 한 번만 물어본 뒤 ` +
          `headless(창 모드 false, 헤드리스 true)를 넣어 다시 호출하세요.`);
      }
    }
    // 작은 번호부터 차례로 켠다 (작업표시줄에도 그 순서로 놓인다). 한 번의 호출로 끝내서 왕복을 줄인다.
    const lines: string[] = [];
    let anyLaunched = false;
    for (const slot of targets) {
      const { launched } = await launchSlot(slot, me, { headless, url: startUrl.get(slot), proxy: proxyOf.get(slot) });
      anyLaunched ||= launched;
      if (launched) await recordAction(slot, '', me, '켜기', undefined, !agent);
      const running = readRegistry().slots[String(slot)];
      const mode = running?.headless ? '헤드리스' : '창 모드';
      const via = running?.proxy ? `, 프록시 ${running.proxy}` : '';
      let line = launched ? `${slot}번 Chrome을 ${mode}로 켰어요 (포트 ${portOf(slot)}${via})${startUrl.get(slot) ? ` → ${truncate(startUrl.get(slot)!, 60)} 여는 중` : ''}.` : `${slot}번 Chrome은 이미 떠 있어요. 붙었어요.`;
      if (!launched && headless !== undefined && headless !== !!running?.headless) {
        line += ` [주의] 이미 ${mode}로 떠 있어서 그대로 붙었어요. 바꾸려면 browser_close로 끈 뒤 다시 켜세요.`;
      }
      const askedProxy = proxyOf.get(slot);
      if (!launched && askedProxy && running?.proxy !== describeProxy(askedProxy)) {
        line += ` [주의] 이미 ${running?.proxy ? `프록시 ${running.proxy}로` : '프록시 없이'} 떠 있어서 요청한 프록시를 붙이지 못했어요. 붙이려면 browser_close로 끈 뒤 proxy를 넣어 다시 켜세요.`;
      }
      lines.push(line);
    }
    let msg = lines.join('\n');
    if (anyLaunched && picked) {
      msg += targets.length === 1 ? '\n번호를 지정하지 않아서 비어 있는 가장 작은 슬롯을 골랐어요.' : '\n번호를 지정하지 않아서 비어 있는 슬롯을 작은 번호부터 골랐어요.';
    }
    if (targets.length > 1) {
      msg += '\n[다음 할 일] 슬롯마다 다른 일을 맡겼다면, 지금 한 메시지 안에서 Agent 도구를 슬롯 수만큼 함께 불러(run_in_background: true) 서브에이전트(subagent_type "cdpm-browser")를 한꺼번에 띄우세요. 지시는 슬롯 번호·agent 이름·할 일만 1~3줄로 짧게 ' +
        '(각자 slot 번호와 자기 agent 이름을 쓰게). 주소 이동부터 서브에이전트가 하고, 메인은 슬롯마다 이동해 두거나 돌아가며 직접 처리하지 마세요. ' +
        '사용자 로그인이 필요하면 "됐다고 알려 달라"고 하지 말고, 서브에이전트가 browser_wait url/gone/text로 스스로 감지하게 하세요.';
      if (targets.length > 20) {
        msg += `\n[주의] 서브에이전트는 동시에 20개까지만 떠요 (21번째부터는 거절됨). ${targets.length}개 중 20개를 먼저 띄우고, 끝나는 대로 나머지 ${targets.length - 20}개를 띄우세요. ` +
          '한 번에 다 띄우려면 사용자가 환경변수 CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS를 늘려야 해요.';
      }
    }
    const first = targets[0];
    return textResult(`${await header(first, me, await syncTabs(first))}\n---\n${msg}`);
  }));

  server.registerTool('browser_close', {
    title: '슬롯 종료',
    description: '슬롯 Chrome을 정상 종료한다 (세션·쿠키 저장). 프로필(로그인 정보)은 지우지 않는다. 다른 에이전트가 최근에 썼으면 결과에 알려준다.',
    inputSchema: { slot: slotArg, agent: agentArg },
  }, async ({ slot, agent }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    if ((await probe(slot)).state !== 'chrome') {
      await forgetSlot(slot);
      return textResult(`${slot}번 Chrome은 이미 꺼져 있어요.`);
    }
    const rec = readRegistry().slots[String(slot)];
    const warnings: string[] = [];
    if (rec?.last && rec.last.agent !== me && secondsSince(rec.last.at) <= 120) {
      const when = ago(rec.last.at);
      warnings.push(`${josa(rec.last.agent, '이', '가')} ${when === '방금' ? when : `${when}에`} 이 슬롯을 썼어요.`);
    }
    const browser = await browserConnection(slot);
    await browser.send('Browser.close', {}, 5000).catch(() => undefined);
    for (let i = 0; i < 25 && (await probe(slot, 500)).state === 'chrome'; i++) await sleep(200);
    // 포트가 닫혀도 프로세스는 잠깐 더 살아 프로필을 붙잡는다. 끝날 때까지 기다려야 바로 다시 켜도 안전하다.
    for (let i = 0; rec?.pid && i < 50 && pidAlive(rec.pid); i++) await sleep(100);
    await forgetSlot(slot);
    return textResult([...warnings, `${slot}번 Chrome을 종료했어요. 프로필은 남아 있어서 다음에 켜면 로그인이 유지돼요.`].join('\n'));
  }));

  server.registerTool('browser_tabs', {
    title: '탭 목록',
    description: '슬롯의 탭 목록: 번호, ID, 제목, 주소, 연 사람, 마지막 행동, 탭별 요약(summary를 넣은 행동만 갱신). "·앞"은 그 창에서 지금 화면 앞에 보이는 탭 (창이 여러 개면 창마다 하나).',
    inputSchema: { slot: slotArg, agent: agentArg },
  }, async ({ slot, agent }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    const tabs = await syncTabs(slot);
    const head = await header(slot, me, tabs);
    const detail = tabs.filter((t) => t.rec.summary)
      .map((t) => `${t.no}. [${t.id}] 요약: ${t.rec.summary!.agent} — ${t.rec.summary!.text} (${ago(t.rec.summary!.at)})`);
    return textResult(`${head}\n---\n${detail.length ? detail.join('\n') : '탭별 요약 없음'}`);
  }));

  server.registerTool('browser_tab_new', {
    title: '새 탭',
    description: '슬롯에 새 탭을 열고 탭 ID를 돌려준다. 여러 에이전트가 같은 슬롯을 쓸 때는 자기 전용 탭을 열고 그 ID로만 작업하면 서로 섞이지 않는다.',
    inputSchema: { slot: slotArg, agent: agentArg, url: z.string().optional().describe('열 주소 (생략하면 빈 탭)'), summary: summaryArg },
  }, async ({ slot, agent, url, summary }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    const browser = await browserConnection(slot);
    const target = url ? (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`) : 'about:blank';
    // background: 사용자가 보고 있는 탭을 바꾸지 않는다.
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: target, background: true });
    markCreated(targetId, me);
    lastTabOf.set(`${slot}:${me}`, targetId);
    await syncTabs(slot);
    await recordAction(slot, targetId, me, '탭 열기', summary);
    const tabs = await syncTabs(slot);
    const tab = tabs.find((t) => t.targetId === targetId);
    return compose(await header(slot, me, tabs, { executed: targetId }), { text: `새 탭을 열었어요: ${tab ? `${tab.no}번 [${tab.id}]` : targetId}${url ? ` → ${target} (로딩 중일 수 있어요)` : ''}` });
  }));

  server.registerTool('browser_tab_close', {
    title: '탭 닫기',
    description: '탭을 닫는다. tab은 반드시 지정한다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: z.union([z.string(), z.number()]).describe('닫을 탭: 번호 또는 ID("t7")') },
  }, async ({ slot, agent, tab }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    let tabs = await syncTabs(slot);
    const picked = pickTab(tabs, tab, 'action');
    if ('error' in picked) return textResult(`${await header(slot, me, tabs, { skipMessages: true })}\n---\n${picked.error}`, true);
    const warnings = ownershipWarnings(picked.tab, me);
    const browser = await browserConnection(slot);
    await browser.send('Target.closeTarget', { targetId: picked.tab.targetId });
    await sleep(200);
    tabs = await syncTabs(slot);
    return textResult(`${await header(slot, me, tabs, { warnings })}\n---\n탭을 닫았어요: ${picked.tab.no}번 [${picked.tab.id}] ${picked.tab.title}`);
  }));

  server.registerTool('browser_tab_select', {
    title: '탭 앞으로',
    description: '탭을 Chrome 창 맨 앞으로 가져온다. 사람이 보는 화면이 바뀌므로 사용자가 원할 때만 쓴다. (뒤에 있는 탭도 읽기·조작·캡처가 되므로 작업하려고 앞으로 가져올 필요는 없다.)',
    inputSchema: { slot: slotArg, agent: agentArg, tab: z.union([z.string(), z.number()]).describe('앞으로 가져올 탭: 번호 또는 ID') },
  }, async (args) => onTab(args, 'action', '탭 선택', async (s, tab) => {
    const browser = await browserConnection(s.slot);
    await browser.send('Target.activateTarget', { targetId: tab.targetId });
    forgetSlotVisibility(s.slot);
    await sleep(150);
    return { text: `${tab.no}번 [${tab.id}] 탭을 앞으로 가져왔어요.` };
  }));

  // ---------- 보기 ----------
  server.registerTool('browser_snapshot', {
    title: '화면 읽기',
    description: '탭 화면을 접근성 트리 텍스트로 읽는다. 클릭·입력할 요소에는 [e12] 같은 ref가 붙는다. ' +
      '긴 페이지는 위에서부터 쪽으로 나눠 1쪽만 보여준다 (page=2로 이어보기, ref 번호는 쪽이 달라도 같다). ' +
      'find="글자"로 그 글자가 들어간 요소와 위쪽 맥락만, ref="e40"으로 그 요소 아래만 볼 수 있다. 페이지가 바뀌면 ref도 바뀌므로 조작 전에 다시 찍는다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, page: pageArg,
      find: z.string().optional().describe('이 글자가 들어간 줄과 그 위쪽 맥락만 (대소문자·띄어쓰기 무시). 사이트 언어를 모르면 "제목|subject"처럼 | 로 여러 낱말'),
      interactive: z.boolean().optional().describe('입력칸·버튼·링크 등 조작할 수 있는 요소(ref 있는 줄)만. Gmail 같은 큰 페이지에서 입력칸을 찾을 때 먼저 쓴다'),
      ref: z.string().optional().describe('이 ref 요소와 그 아래만'),
    },
  }, async (args) => onTab(args, 'view', null, async (s, tab, agent) => {
    const page = args.page ?? 1;
    const cache = s.snapshotFor(agent);
    const sameUrl = cache && cache.url.split('#')[0] === tab.url.split('#')[0];
    // 2쪽부터는 1쪽을 찍은 그 스냅샷에서 이어 보여준다 (ref 번호 유지).
    const full = page > 1 && cache && sameUrl && Date.now() - cache.at < 5 * 60_000 ? cache.text : (await takeSnapshot(s, agent)).text;
    // interactive: ref가 붙은 줄(조작할 수 있는 요소와 제목)만 → 큰 페이지에서도 몇 쪽 안에 입력칸·버튼이 다 보인다
    const text = args.interactive ? full.split('\n').filter((l) => /\[e\d+\]/.test(l)).map((l) => l.trimStart()).join('\n') : full;
    if (!text) return { text: '(읽을 수 있는 요소가 없어요)' };
    if (args.ref) {
      const sub = subtree(text, args.ref);
      if (!sub) throw new CdpmError(`[${args.ref}]를 이 스냅샷에서 찾지 못했어요. ref 없이 다시 찍어서 확인하세요.`);
      const p = paginate(sub, page);
      return { text: p.body + pageFooter(p, sub.length) };
    }
    if (args.find) {
      const f = findLines(text, args.find);
      if (!f.matches) return { text: `"${args.find}"이(가) 들어간 요소가 없어요. (전체 ${text.length.toLocaleString()}자)` };
      const p = paginate(f.body, page);
      return { text: `${p.body}\n\n— "${args.find}" ${f.matches}곳${f.matches > 150 ? ' (처음 150곳만 표시)' : ''}${pageFooter(p, f.body.length)}` };
    }
    const p = paginate(text, page);
    const context = p.page > 1 ? ancestorsOf(text, p.start) : [];
    const head = context.length ? `(이 쪽의 위쪽 맥락)\n${context.join('\n')}\n  ┄┄┄\n` : '';
    return { text: head + p.body + pageFooter(p, text.length, ` · 글자로 찾기: find="…" · 영역만: ref="eN"${args.interactive ? '' : ' · 입력칸·버튼만: interactive=true'}`) };
  }));

  server.registerTool('browser_text', {
    title: '본문 읽기',
    description: '페이지 본문 글자를 읽는다 (main/article이 있으면 그 부분). ref를 주면 그 요소의 글자만. 기사·문서 내용을 읽을 때 스냅샷보다 짧고 읽기 쉽다. 긴 글은 page로 이어 본다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().optional().describe('이 요소의 글자만'), page: pageArg },
  }, async (args) => onTab(args, 'view', null, async (s, _tab, agent) => ({ text: await act.extractText(s, agent, args.ref, args.page ?? 1) })));

  server.registerTool('browser_screenshot', {
    title: '화면 캡처',
    description: '탭의 보이는 화면을 PNG로 캡처한다. 뒤에 있는 탭도 탭을 바꾸지 않고 캡처한다. 창 크기나 뷰포트는 절대 바꾸지 않으므로 페이지 전체 캡처는 지원하지 않는다 (아래쪽은 스크롤 후 캡처, 또는 스냅샷·본문 읽기).',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    const data = await act.screenshot(s, await browserConnection(s.slot));
    return { text: '캡처했어요.', image: data };
  }, { render: true }));

  // ---------- 조작 ----------
  server.registerTool('browser_navigate', {
    title: '주소 이동',
    description: '탭을 주소로 이동하고 본문이 뜰 때까지 기다린다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, url: z.string().describe('이동할 주소'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '이동', async (s) => ({ text: (await act.navigate(s, args.url)) + act.downloadNote(s) })));

  server.registerTool('browser_back', {
    title: '뒤로',
    description: '뒤로 가기.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '뒤로', async (s) => ({ text: await act.back(s) })));

  server.registerTool('browser_forward', {
    title: '앞으로',
    description: '앞으로 가기 (뒤로 간 뒤 다시 앞 페이지로).',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '앞으로', async (s) => ({ text: await act.forward(s) })));

  server.registerTool('browser_reload', {
    title: '새로고침',
    description: '지금 페이지를 새로고침한다 (Chrome의 새로고침 그대로). ignore_cache=true면 캐시를 무시하고 새로 받는다. 사용자가 입력 중인 페이지에서는 입력 내용이 사라지니 주의.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ignore_cache: z.boolean().optional().describe('캐시 무시 (강력 새로고침)'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '새로고침', async (s) => ({ text: await act.reload(s, args.ignore_cache ?? false) })));

  server.registerTool('browser_hover', {
    title: '마우스 올리기',
    description: 'ref 요소 위에 진짜 마우스를 올린다 (클릭하지 않음). 마우스를 올려야 펼쳐지는 메뉴·툴팁에 쓴다. read=changes로 펼쳐진 메뉴를 바로 본다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('마우스를 올릴 요소의 ref'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '마우스 올리기', async (s, _tab, agent) => ({ text: await act.hover(s, agent, args.ref) })));

  server.registerTool('browser_drag', {
    title: '끌어 놓기',
    description: '진짜 마우스로 끌어 놓는다 (누르고 → 조금씩 움직이고 → 놓기): 드래그 앤 드롭, 슬라이더, 순서 바꾸기, 드래그형 보안문자 등. ' +
      '놓을 곳은 to(요소 ref), to_text(놓을 곳의 글자), 또는 from 기준 dx·dy(픽셀). HTML 드래그도 OS 드래그를 띄우지 않고 처리한다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      from: z.string().describe('끌 요소의 ref (draggable로 표시된 요소 포함)'), to: z.string().optional().describe('놓을 요소의 ref'),
      to_text: z.string().optional().describe('놓을 곳에 적힌 글자 (놓을 곳에 ref가 없을 때, 예: "여기에 놓으세요")'),
      dx: z.number().optional().describe('가로로 움직일 픽셀 (오른쪽 +)'), dy: z.number().optional().describe('세로로 움직일 픽셀 (아래 +)'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', '끌어 놓기', async (s, _tab, agent) => ({ text: await act.drag(s, agent, args.from, args.to, args.dx, args.dy, args.to_text) })));

  server.registerTool('browser_download_wait', {
    title: '다운로드 기다리기',
    description: '가장 최근에 시작된 다운로드가 끝날 때까지 기다리고, 저장된 파일 경로를 돌려준다 (사용자 Chrome의 다운로드 폴더 설정 그대로). 다운로드 버튼을 누른 뒤 부른다. 끝나는 즉시 돌아온다.',
    inputSchema: { slot: slotArg, agent: agentArg, timeout: z.number().min(1).max(600).optional().describe('최대 기다릴 시간(초, 기본 120)') },
  }, async ({ slot, agent, timeout }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    await attachSlot(slot);
    const stop = () => (hasUnread(slot, me) ? '새 메시지가 와서 기다리기를 바로 멈췄어요 (slot_inbox로 확인하세요).' : undefined);
    try {
      return textResult(await waitDownload(slot, timeout ?? 120, stop));
    } catch (e) {
      throw new CdpmError((e as Error).message);
    }
  }));

  server.registerTool('browser_pdf', {
    title: 'PDF로 저장',
    description: '지금 페이지를 PDF 파일로 저장한다 (영수증·기사 보관 등). path를 안 주면 사용자 다운로드 폴더에 페이지 제목으로 저장한다. 화면·창은 바뀌지 않는다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, path: z.string().optional().describe('저장할 파일 경로 (예: C:\Users\me\Desktop\영수증.pdf)') },
  }, async (args) => onTab(args, 'view', null, async (s, tab) => ({ text: await act.pdf(s, args.path, tab.title) })));

  server.registerTool('browser_click', {
    title: '클릭',
    description: 'ref 요소를 진짜 마우스 이벤트로 클릭한다. 다른 요소가 가리고 있으면 클릭하지 않고 알려준다. 클릭으로 페이지가 이동하면 로딩까지 기다리고, 새 탭이 열리면 알려준다. ' +
      '파일 칸이나 "첨부" 버튼을 누르면 OS 파일 선택 창을 띄우지 않고 가로채 두므로, 이어서 browser_upload로 파일을 넣는다. <select> 드롭다운은 사용자 화면에 목록 창이 떠서 클릭하지 않는다 (browser_select).',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('browser_snapshot의 ref (예: "e12")'), double: z.boolean().optional().describe('더블클릭'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '클릭', async (s, _tab, agent) => ({ text: await act.click(s, agent, args.ref, args.double ?? false) })));

  server.registerTool('browser_type', {
    title: '입력',
    description: 'ref 요소에 글자를 입력한다. 사람이 치는 것처럼 글자마다 진짜 키 이벤트(keydown·keypress·input·keyup)를 보낸다. ' +
      'clear=true면 기존 내용을 지우고, submit=true면 입력 뒤 Enter를 누른다. 입력 후 실제 값을 확인해서 다르면 알려준다. ' +
      'fast=true는 아주 긴 글을 키 이벤트 없이 한 번에 넣는다. 날짜·시간 입력칸은 형식에 맞춰 값을 직접 넣는다 (time "19:30", date "2026-10-08"; 이때 change 이벤트는 isTrusted=false).',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('입력할 요소의 ref'), text: z.string().describe('입력할 글자'),
      clear: z.boolean().optional().describe('기존 내용 지우기'), submit: z.boolean().optional().describe('입력 후 Enter'),
      fast: z.boolean().optional().describe('아주 긴 글: 키 이벤트 없이 한 번에 넣기'), read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', '입력', async (s, _tab, agent) => ({ text: await act.type(s, agent, args.ref, args.text, args.clear ?? false, args.submit ?? false, args.fast ?? false) })));

  server.registerTool('browser_fill', {
    title: '폼 채우기',
    description: '같은 페이지의 입력칸 여러 개를 차례로 채운다 (칸마다 기존 내용을 지우고 진짜 키 이벤트로 입력, 값 확인). ' +
      '채우는 도중 페이지가 바뀌거나 알림창이 뜨거나 한 칸이라도 실패하면 그 자리에서 멈추고 어디까지 했는지 알려준다. ' +
      'submit="Enter"면 마지막 칸에서 Enter, 버튼 ref면 그 버튼을 클릭한다. 드롭다운은 browser_select를 쓴다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      fields: z.array(z.object({ ref: z.string().describe('입력칸 ref'), text: z.string().describe('넣을 글자') })).min(1).max(30).describe('채울 칸들 (위에서부터 차례로)'),
      submit: z.string().optional().describe('다 채운 뒤: "Enter" 또는 누를 버튼의 ref'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', '폼 채우기', async (s, _tab, agent) => {
    const href = async () => (await s.evaluate<string>('location.href', { timeoutMs: 3000 }).catch(() => undefined))?.value;
    const start = await href();
    const done: string[] = [];
    const stop = (why: string) => ({ text: [...done, why].join('\n') });
    for (const [i, f] of args.fields.entries()) {
      if (s.dialog) return stop(`${i + 1}번째 칸 전에 알림창이 떠서 멈췄어요.`);
      if (i > 0 && (await href()) !== start) return stop(`페이지가 바뀌어서 ${i + 1}번째 칸 [${f.ref}]부터는 채우지 않았어요.`);
      try {
        done.push(`${i + 1}. ${await act.type(s, agent, f.ref, f.text, true, false)}`);
      } catch (e) {
        if (e instanceof act.DialogInterrupt) throw e;
        return stop(`${i + 1}번째 칸 [${f.ref}]에서 멈췄어요: ${(e as Error).message}`);
      }
    }
    if (args.submit) {
      if (s.dialog) return stop('제출 전에 알림창이 떠서 멈췄어요.');
      done.push(`제출: ${args.submit.toLowerCase() === 'enter' ? await act.pressKey(s, 'Enter') : await act.click(s, agent, args.submit, false)}`);
    }
    return { text: done.join('\n') };
  }));

  server.registerTool('browser_upload', {
    title: '파일 올리기',
    description: '파일 칸에 파일을 넣는다 (사용자 화면에 OS 파일 선택 창을 띄우지 않음). ref로 파일 칸(<input type=file> 또는 그 label)을 주거나, ' +
      '사이트가 만든 "첨부" 버튼은 먼저 browser_click으로 누른 뒤(열리려던 파일 선택 창을 CDPM이 가로채 둠) ref 없이 부른다. 사이트는 사람이 파일을 고른 것과 같은 이벤트를 받는다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      files: z.array(z.string()).min(1).describe('올릴 파일의 경로 (이 PC 기준, 절대 경로 권장)'),
      ref: z.string().optional().describe('파일 칸의 ref. 생략하면 방금 클릭으로 열리려던 파일 선택 창에 넣는다'),
      read: readArg, summary: summaryArg,
    },
  }, async (args) => onTab(args, 'action', '파일 올리기', async (s, _tab, agent) => ({ text: await act.upload(s, agent, args.ref, args.files) })));

  server.registerTool('browser_select', {
    title: '드롭다운 선택',
    description: '<select> 드롭다운에서 항목을 고른다 (값 또는 보이는 글자, 일부만 맞아도 됨). 드롭다운에 포커스를 두고 키로 옮기므로(Windows·Linux는 화살표 키, macOS는 항목 앞글자 입력) 페이지는 진짜 이벤트를 받고, 목록 창은 뜨지 않는다. 맞는 항목이 없으면 고를 수 있는 항목을 알려준다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().describe('드롭다운(combobox)의 ref'), option: z.string().describe('고를 항목의 값 또는 글자'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '선택', async (s, _tab, agent) => ({ text: await act.select(s, agent, args.ref, args.option) })));

  server.registerTool('browser_press_key', {
    title: '키 입력',
    description: process.platform === 'darwin'
      ? '포커스된 곳에 키를 누른다. 예: Enter, Tab, Escape, ArrowDown, PageDown, Meta+A(전체 선택), Shift+Tab. 이 PC는 macOS라 단축키는 Meta(Cmd)를 쓴다 (Control+A는 줄 맨 앞으로 이동).'
      : '포커스된 곳에 키를 누른다. 예: Enter, Tab, Escape, ArrowDown, PageDown, Control+A, Shift+Tab.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, key: z.string().describe(process.platform === 'darwin' ? '키 이름 또는 조합 (예: "Meta+A")' : '키 이름 또는 조합 (예: "Control+A")'), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '키 입력', async (s) => ({ text: await act.pressKey(s, args.key) })));

  server.registerTool('browser_scroll', {
    title: '스크롤',
    description: 'ref 요소가 보이도록 스크롤하거나, dy 픽셀만큼 스크롤한다 (양수=아래, 음수=위, 기본 600). 실제로 움직인 위치를 알려준다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, ref: z.string().optional(), dy: z.number().optional(), read: readArg, summary: summaryArg },
  }, async (args) => onTab(args, 'action', '스크롤', async (s, _tab, agent) => ({ text: await act.scroll(s, agent, args.ref, args.dy) })));

  server.registerTool('browser_wait', {
    title: '기다리기',
    description: 'text가 페이지에 나타날 때까지, gone이면 그 글자가 사라질 때까지, url이면 주소가 바뀔 때까지, network_idle이면 네트워크가 잠잠해질 때까지, 아니면 seconds초 동안 기다린다. ' +
      '화면은 건드리지 않고 읽기만 해서, 사용자가 입력 중인 내용이 사라지지 않는다 (로그인 완료 감지에 쓴다: url 또는 gone="비밀번호" 또는 text="받은편지함"). ' +
      '조건이 맞거나 다른 에이전트의 메시지가 오는 즉시 돌아온다. 기다림은 최소로: 사람(로그인 등)을 기다릴 때만 길게 쓰고, 다른 에이전트를 기다릴 때는 slot_inbox wait를 쓴다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      text: z.string().optional().describe('나타나길 기다릴 글자'),
      url: z.string().optional().describe('이 글자가 들어간 주소가 될 때까지 (예: "mail.google.com/mail"). 빈 글자 ""면 지금 주소에서 달라질 때까지'),
      gone: z.string().optional().describe('이 글자가 페이지에서 사라질 때까지 (예: 로그인 폼의 "비밀번호"가 사라짐 = 로그인 완료)'),
      seconds: z.number().min(0).max(60).optional().describe('그냥 기다릴 시간(초). 가급적 쓰지 않는다: 기다릴 일은 text·gone·url이나 slot_inbox wait로 조건을 걸어 기다린다'),
      timeout: z.number().min(1).max(600).optional().describe('text·url·network_idle 대기 최대 시간(초). 사람의 로그인 등을 기다릴 때는 300~600'),
      network_idle: z.boolean().optional().describe('진행 중인 네트워크 요청이 0.5초 동안 없을 때까지 (캡처·읽기 전에)'),
    },
  }, async (args) => onTab(args, 'view', null, async (s, _tab, agent) => {
    // 다른 에이전트가 메시지를 보내면 기다리기를 바로 멈춘다 (메시지는 결과 머리말로 전달됨)
    const stop: act.StopCheck = () => (hasUnread(args.slot, agent) ? '새 메시지가 와서 기다리기를 바로 멈췄어요 (위 머리말의 메시지를 보고 이어서 하세요).' : undefined);
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
    return { text: `${sec}초 기다렸어요.` };
  }));

  server.registerTool('browser_eval', {
    title: 'JS 실행',
    description: '탭에서 JavaScript 식을 실행하고 결과를 JSON으로 돌려준다. 다른 도구로 안 될 때만 쓰는 탈출구. ' +
      '페이지와 분리된 실행 공간(isolated world)에서 돌아서 DOM은 읽고 바꿀 수 있지만, 페이지 스크립트가 만든 전역 변수(window.앱변수 등)는 보이지 않는다.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, expression: z.string().describe('실행할 JS 식 (Promise면 기다림)'), summary: summaryArg },
  }, async (args) => onTab(args, 'action', 'JS 실행', async (s) => ({ text: await act.evaluate(s, args.expression) })));

  // ---------- 네트워크 ----------
  server.registerTool('browser_network', {
    title: '네트워크 요청 보기',
    description: '탭의 네트워크 요청 목록 (최근 것이 아래). CDPM이 그 탭에 처음 붙은 때부터 최근 500개를 기록한다. filter(주소 일부), type(Document, XHR, Fetch, Script, Image 등), failed(실패만)로 거른다. 자세히 보려면 browser_network_detail에 n번호.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      filter: z.string().optional().describe('주소에 이 글자가 들어간 요청만'),
      type: z.string().optional().describe('요청 종류 (예: XHR, Fetch, Document, Script, Image)'),
      failed: z.boolean().optional().describe('실패한 요청만'),
      limit: z.number().int().min(1).max(200).optional().describe('최대 개수 (기본 40, 최근 것부터)'),
    },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    let list = s.network.list();
    const total = list.length;
    if (args.filter) list = list.filter((e) => e.url.toLowerCase().includes(args.filter!.toLowerCase()) || decodeUrl(e.url).toLowerCase().includes(args.filter!.toLowerCase()));
    if (args.type) list = list.filter((e) => e.type.toLowerCase() === args.type!.toLowerCase());
    if (args.failed) list = list.filter((e) => e.failed);
    const limit = args.limit ?? 40;
    const shown = list.slice(-limit);
    const since = new Date(s.network.startedAt).toLocaleTimeString('ko-KR', { hour12: false });
    const head = `기록 시작: ${since} (CDPM이 이 탭에 처음 붙은 때부터) · 기록 ${total}개 중 조건에 맞는 ${list.length}개${list.length > limit ? `, 최근 ${limit}개 표시` : ''}`;
    return { text: `${head}\n${shown.length ? shown.map((e) => netLine(e, s.network.rules)).join('\n') : '(해당하는 요청이 없어요)'}` };
  }));

  server.registerTool('browser_network_detail', {
    title: '네트워크 요청 자세히',
    description: '요청 하나의 헤더, 보낸 데이터, 응답 본문(글자면 앞부분)을 보여준다. id는 browser_network의 n번호.',
    inputSchema: { slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg, id: z.string().describe('요청 번호 (예: "n12")'), body: z.boolean().optional().describe('응답 본문 포함 (기본 true)') },
  }, async (args) => onTab(args, 'view', null, async (s) => {
    const e = s.network.find(args.id);
    if (!e) throw new CdpmError(`요청 "${args.id}"을(를) 찾을 수 없어요. browser_network로 번호를 확인하세요 (최근 500개만 보관).`);
    const parts = [netLine(e), '', `주소: ${decodeUrl(e.url)}`, '', '[요청 헤더]', headersText(e.requestHeaders)];
    if (e.hasPostData) {
      const post = await s.send<{ postData: string }>('Network.getRequestPostData', { requestId: e.requestId }, 5000).catch(() => undefined);
      parts.push('', '[보낸 데이터]', post ? truncate(post.postData, 5000) : '  (가져올 수 없어요)');
    }
    parts.push('', '[응답 헤더]', headersText(e.responseHeaders));
    if (args.body !== false && !e.failed && e.status !== undefined) {
      const b = await s.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: e.requestId }, 10_000).catch(() => undefined);
      let bodyText: string;
      if (!b) bodyText = '  (가져올 수 없어요: 아직 받는 중이거나, Chrome이 이미 버렸거나, 리다이렉트예요)';
      else if (b.base64Encoded && !/json|text|xml|javascript|html/i.test(e.mimeType ?? '')) bodyText = `  (바이너리 ${fmtSize(Buffer.from(b.body, 'base64').length)}, ${e.mimeType})`;
      else {
        const raw = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        bodyText = raw.length > 20_000 ? raw.slice(0, 20_000) + `\n… (잘렸음: 전체 ${raw.length.toLocaleString()}자)` : raw;
      }
      parts.push('', '[응답 본문]', bodyText);
    }
    return { text: parts.join('\n') };
  }));

  server.registerTool('browser_block', {
    title: '요청 막기',
    description: '탭에서 주소 패턴에 맞는 네트워크 요청을 막는다 (실패 처리). add로 추가, remove로 해제, clear로 내가 건 규칙 전부 해제. ' +
      '패턴: * 아무 글자, ? 한 글자. 도메인만 적으면 그 글자가 들어간 모든 요청 (예: "ads.example.com" → "*ads.example.com*"). 끝에는 자동으로 *가 붙어 쿼리 문자열이 있어도 걸린다 ("*.png" → "*.png*"). 규칙이 있는 동안 그 탭은 캐시를 쓰지 않는다. ' +
      '규칙은 이 Claude 세션이 살아 있는 동안만 유지되고, 다른 에이전트에게도 머리말로 보인다. 아무 인자 없이 부르면 지금 규칙만 보여준다.',
    inputSchema: {
      slot: slotArg, agent: agentArg, tab: tabArg, multiSlot: multiSlotArg,
      add: z.array(z.string()).optional().describe('막을 주소 패턴들'),
      remove: z.array(z.string()).optional().describe('해제할 패턴들'),
      clear: z.boolean().optional().describe('내가(이 세션이) 건 규칙 전부 해제'),
      summary: summaryArg,
    },
  }, async (args) => onTab(args, args.add?.length || args.remove?.length || args.clear ? 'action' : 'view', args.add?.length ? '요청 막기' : args.remove?.length || args.clear ? '요청 막기 해제' : null, async (s, tab, agent) => {
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
      changed ? '요청 막기 규칙을 바꿨어요.' : '지금 요청 막기 규칙:',
      `이 세션의 규칙: ${rules.length ? rules.map((r) => `${r.pattern} (${r.agent})`).join(', ') : '없음'}`,
    ];
    if (others.length) lines.push(`다른 세션의 규칙: ${others.map((b) => `${b.pattern} (${b.agent})`).join(', ')} — 그 세션에서만 해제할 수 있어요`);
    lines.push('막힌 요청은 browser_network에서 "실패 … (막음: 패턴)"으로 보여요.');
    return { text: lines.join('\n') };
  }));

  // ---------- 메시지 ----------
  server.registerTool('slot_send', {
    title: '메시지 보내기',
    description: '다른 에이전트에게 메시지를 보낸다 (실시간 협업). slot에는 받는 쪽 에이전트가 맡은 슬롯 번호를 넣는다 (다른 슬롯 담당에게도 그 슬롯 번호로 보내면 됨). to를 생략하면 그 슬롯의 모두에게. ' +
      '상대는 slot_inbox wait로 기다리고 있으면 즉시, 아니면 다음 도구 결과 머리말로 받는다 (browser_wait 중이면 기다리기가 바로 멈춤). 일을 하나 끝내면 기다리는 상대에게 바로 알린다.',
    inputSchema: { slot: slotArg, agent: agentArg, text: z.string().min(1).max(2000), to: z.string().optional().describe('받을 에이전트 이름') },
  }, async ({ slot, agent, text, to }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const msg = await sendMessage(slot, me, text, to ?? null);
    return textResult(`[${slot}번] 메시지를 보냈어요 (#${msg.seq}${to ? `, 받는 사람: ${to}` : ', 모두에게'}).`);
  }));

  server.registerTool('slot_inbox', {
    title: '메시지 확인',
    description: '내게 온 안 읽은 메시지를 본다. wait초를 주면 새 메시지가 올 때까지 최대 그만큼 기다린다 (실시간 대화용). ' +
      '다른 도구의 결과 머리말로 이미 받은 메시지는 "안 읽은 메시지"가 아니므로, 새 메시지가 없을 때는 최근에 받은 메시지를 참고로 함께 보여준다.',
    inputSchema: { slot: slotArg, agent: agentArg, wait: z.number().min(0).max(600).optional().describe('새 메시지를 기다릴 최대 시간(초). 메시지가 오는 즉시 돌아온다 (다른 에이전트의 일이 끝나길 기다릴 때 화면을 반복해서 보지 말고 이걸 쓴다)') },
  }, async ({ slot, agent, wait }) => guard(async () => {
    const me = agent ?? DEFAULT_AGENT;
    const msgs = wait ? await waitUnread(slot, me, wait) : await takeUnread(slot, me);
    if (msgs.length) return textResult(`[${slot}번] 새 메시지 ${msgs.length}개\n${formatMessages(msgs).map((l) => `  ${l}`).join('\n')}`);
    const recent = recentDelivered(slot, me);
    const tail = recent.length ? ` (최근 10분 안에 다른 도구의 머리말로 이미 받은 메시지 ${recent.length}개는 다시 보여주지 않아요)` : '';
    return textResult(`[${slot}번] 새 메시지가 없어요${wait ? ` (${wait}초 기다림)` : ''}.${tail}`);
  }));
}

export const SERVER_INSTRUCTIONS = `CDPM: Chrome 슬롯 1~30번을 CDP로 조종한다. 슬롯 N의 CDP 포트는 ${PORT_BASE}+N (1번=${PORT_BASE + 1}).
- 사용자가 "3번 봐줘"라고 하면 slot=3. 모든 도구에 slot을 넣는다.
- Chrome은 사용자가 켜 달라고 말할 때만 browser_launch로 켠다. 꺼진 슬롯은 다른 도구가 켜지 않는다. 번호 없이 "켜줘"라고 하면 slot을 생략한다 (비어 있는 가장 작은 번호).
- 켤 때 창 모드(보임)인지 헤드리스(안 보임)인지 사용자가 말하지 않았으면 먼저 물어본다. 여러 슬롯을 한꺼번에 켜면 한 번만 묻는다.
- 시작할 페이지를 알면 browser_launch에 url(모든 슬롯 같은 주소)이나 urls(슬롯마다 다른 주소)를 넣어 켜자마자 바로 연다 (서브에이전트가 따로 이동하는 단계가 없어진다).
- 여러 슬롯에 각각 다른 일을 시키면(예: "3개 띄워서 하나는 네이버, 하나는 다음…") 기본은 병렬이다: 메인은 browser_launch 한 번(slots/count, 시작 주소 url/urls)으로 슬롯을 켜는 것까지만 하고, 곧바로 슬롯마다 서브에이전트를 하나씩 맡긴다. 주소 이동·읽기·조작은 처음부터 서브에이전트가 한다 (메인이 슬롯마다 이동해 두지 않는다). 서브에이전트는 한 메시지 안에서 Agent 도구를 여러 번 함께 부르고, 모두 run_in_background: true로 띄운다 (하나씩 띄우거나 앞 서브에이전트가 끝나길 기다리지 않는다). 서브에이전트에게 주는 지시는 1~3줄로 짧게: 슬롯 번호, agent 이름(예: "네이버담당", 모든 도구의 agent에 넣게), 할 일만. cdpm-browser는 CDPM 사용법·규칙(로그인 감지, 신호 주고받기, 기다림 최소화)을 이미 알고 있으니 다시 설명하지 않는다 (긴 지시를 쓰는 시간만큼 늦어진다). subagent_type "cdpm-browser"(CDPM 전용 서브에이전트, 빨리 시작)가 있으면 그걸 쓴다. 서브에이전트는 동시에 20개까지라, 슬롯이 20개를 넘으면 20개를 먼저 띄우고 끝나는 대로 나머지를 띄운다. 메인이 슬롯을 돌아가며 직렬로 처리하지 않는다. 사용자가 순서대로 하라고 한 경우만 직렬로 한다.
- 메인 에이전트와 서브에이전트의 역할 (여러 슬롯을 쓰는 작업, 사이트와 상관없이 항상):
  - 메인: 사용자와 대화, 슬롯 켜기·끄기(browser_launch 한 번 / browser_close), 서브에이전트에게 슬롯과 할 일 나눠 주기(한 메시지에서 한꺼번에), 결과 합쳐서 사용자에게 보고. 메인은 슬롯 화면을 이동·읽기·조작하지 않는다.
  - 서브에이전트: 맡은 슬롯 하나만. 주소 이동부터 읽기·입력·클릭, 사용자 로그인 등 완료 감지, 자기 몫의 결과물 작성, 필요하면 다른 서브에이전트와 신호 주고받기까지 전부 한다.
  - 슬롯 하나로 끝나는 간단한 일은 메인이 직접 해도 된다.
- 한 에이전트는 한 슬롯만 조작한다. 같은 에이전트가 60초 안에 다른 슬롯을 조작하면 CDPM이 거절한다 (보기는 괜찮음, 여러 슬롯을 함께 조작해야 하는 일만 multiSlot: true).
- 결과물(보고서·HTML 등)도 서브에이전트가 각자 자기 몫을 써서 돌려주고, 메인은 합치기만 한다 (메인이 혼자 다 쓰면 그 단계가 가장 느리다).
- 결과 맨 위 머리말에 슬롯의 탭 목록, 어느 탭에서 실행했는지, 경고, 새 메시지가 나온다. 매번 확인하고 다음 행동을 정한다.
- 탭이 여러 개면 조작 도구에 tab(번호 또는 ID "t7")을 지정한다. 같은 슬롯을 여럿이 쓸 때는 browser_tab_new로 자기 탭을 열고 그 ID를 쓴다. 뒤에 있는 탭도 그대로 읽고 조작할 수 있다.
- 조작 도구(이동·클릭·입력·키·뒤로·선택·스크롤·폼 채우기)에 read를 넣으면 조작 뒤 화면이 결과에 바로 붙는다. 다음 판단에 화면이 필요하면 따로 읽지 말고 read를 쓴다: 기사·글은 text, 버튼·링크를 눌러야 하면 snapshot, 같은 페이지에서 뭐가 바뀌었는지만 보면 되면 changes (가장 짧다).
- 같은 페이지의 입력칸 여러 개(로그인, 검색 조건 등)는 browser_fill 한 번으로 채운다. 파일 첨부는 browser_upload (파일 칸 ref, 또는 "첨부" 버튼을 클릭한 뒤 ref 없이). 마우스를 올려야 열리는 메뉴는 browser_hover, 드래그·슬라이더는 browser_drag, 다운로드는 버튼을 누른 뒤 browser_download_wait로 저장된 파일 경로를 받는다.
- 긴 페이지는 browser_snapshot이 위에서부터 1쪽만 준다. 쪽을 넘기지 말고, 입력칸·버튼을 찾을 때는 interactive=true나 find="제목|subject"(| 로 여러 낱말), 글 내용은 browser_text를 쓴다. summary를 남기면 browser_status에서 다른 에이전트가 볼 수 있다.
- 기다림은 최소한으로. 고정 시간 대기(seconds)는 쓰지 않는다.
- 사용자가 직접 할 일(어느 사이트든 로그인·본인 인증·보안문자·결제 승인 등)이 있으면 "됐다고 알려 달라"고 하지 않는다. 서브에이전트를 먼저 띄워 두고, 각자 화면을 건드리지 않은 채(새로고침·다시 이동 금지: 입력 중인 내용이 사라짐) browser_wait로 완료를 스스로 감지해 이어서 진행한다: 주소 변화(url), 로그인 폼 글자가 사라짐(gone), 로그인 뒤에만 보이는 글자(text). 사용자가 아이디·비밀번호를 알려 주면(헤드리스 등) 그대로 입력해 로그인한다.
- 다른 에이전트와 함께 일할 때(예: 서로 메일 주고받기)는 실시간으로 신호를 주고받는다: 자기 일을 끝내면 바로 slot_send(slot=상대가 맡은 슬롯, to=상대 이름)로 "보냈어" 같이 알리고, 상대를 기다릴 때는 화면을 반복해서 새로고침하지 말고 slot_inbox(slot=내 슬롯, wait=120~600)로 기다린다 (오는 즉시 돌아옴). 신호를 받으면 바로 화면을 확인하고 움직인다.
- 다른 슬롯의 화면은 보기 도구(browser_snapshot·browser_text·browser_screenshot)로 언제든 볼 수 있다 (조작만 그 슬롯 담당이 한다).
- 창 크기·위치·뷰포트는 절대 바꾸지 않는다. 사용자가 보는 탭을 바꾸는 browser_tab_select는 사용자가 원할 때만 쓴다.
- 알림창(alert/confirm/prompt)은 절대 처리하지 않는다. 떠 있으면 사용자에게 Chrome 창에서 직접 처리해 달라고 알린다.`;
