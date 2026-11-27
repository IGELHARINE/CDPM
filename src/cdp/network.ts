// 탭의 네트워크 요청 기록과 요청 막기.
// 기록: Network 도메인 이벤트 (DevTools 네트워크 탭과 같은 방식, 페이지는 알 수 없음).
// 막기: Fetch 도메인으로 패턴에 맞는 요청만 잡아서 실패시킨다. 규칙은 이 연결이 살아 있는 동안만 유효하다.
import type { CdpConnection } from './client.js';
import { TelemetryLog } from './telemetry.js';
import { siteOf } from '../watch/site.js';

export interface NetEntry {
  no: number;            // 이 탭 기록 안에서의 번호 (n1, n2 …)
  requestId: string;
  method: string;
  url: string;
  type: string;          // Document, XHR, Fetch, Script, Image …
  startedAt: number;     // ms (epoch)
  status?: number;
  mimeType?: string;
  size?: number;         // 전송 바이트
  durationMs?: number;
  failed?: string;       // 실패 사유
  blockedBy?: string;    // CDPM 규칙으로 막았으면 그 패턴
  fromCache?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  hasPostData?: boolean;
}

export interface BlockRule {
  pattern: string;
  agent: string;
  at: string;
  /** fail(기본): 요청을 실패시킨다. empty: 보내지 않고 빈 성공 응답을 준다 (페이지는 막힌 줄 모른다) */
  mode?: 'fail' | 'empty';
  /** 업체·종류 이름으로 막았으면 그 이름 */
  label?: string;
  /** 업체 도메인으로 만든 규칙: 탭에 띄운 사이트 자신의 요청에는 걸지 않는다 (그 업체 사이트를 직접 볼 때) */
  thirdParty?: boolean;
  /** 보내는 요청(POST·beacon)만 막는다 (이름 없는 수집 주소: 같은 주소의 GET은 앱이 쓰는 것일 수 있어서) */
  postOnly?: boolean;
}

/** 규칙 목록을 사람이 읽을 줄로: 같은 이름으로 건 패턴은 한 덩어리로 묶는다. */
export function describeRules(rules: { pattern: string; agent: string; label?: string; mode?: string }[]): string {
  const groups = new Map<string, { n: number; agent: string; quiet: boolean; label?: string }>();
  for (const r of rules) {
    const k = r.label ?? r.pattern;
    const g = groups.get(k) ?? { n: 0, agent: r.agent, quiet: r.mode === 'empty', label: r.label };
    g.n++;
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => `${k}${g.label ? ` [${g.n} pattern${g.n > 1 ? 's' : ''}]` : ''}${g.quiet ? ' (quiet)' : ''} (${g.agent})`).join(', ');
}

/** 슬롯 브라우저 연결을 얻는 함수 (sessions.ts가 넣어 준다: 서로 불러오면 순환이 생겨서) */
let browserOf: ((slot: number) => Promise<CdpConnection>) | undefined;
export function setBrowserProvider(fn: (slot: number) => Promise<CdpConnection>) {
  browserOf = fn;
}

/** 슬롯마다 살아 있는 기록기 (공유 워커에 걸 규칙을 모으려고) */
const recordersOf = new Map<number, Set<NetworkRecorder>>();

const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 60_000;

export class NetworkRecorder {
  readonly startedAt = Date.now();
  private entries: NetEntry[] = [];
  private byId = new Map<string, NetEntry>();
  private seq = 0;
  private wallOffset: number | undefined;
  /** 아직 끝나지 않은 요청 */
  readonly inflight = new Set<string>();
  /** 진행 중 요청이 어느 프레임 것인지 (프레임이 다른 프로세스로 넘어가면 끝 신호가 이 연결로 오지 않아 직접 지운다) */
  private frameOf = new Map<string, string>();
  rules: BlockRule[] = [];
  /** 봇 탐지·세션 녹화·분석 신호 (이미 오는 이벤트만 본다) */
  readonly telemetry = new TelemetryLog();
  /** 규칙이 있는 동안 자동으로 붙은 하위 대상(다른 사이트 iframe 등). 같은 규칙을 건다 */
  private children = new Set<string>();
  /** 탭에 지금 띄운 사이트 (업체 규칙에서 자기 사이트 요청을 빼려고) */
  private topSite = '';
  /** Fetch에서 막았는데 아직 기록 줄이 안 생긴 요청 (networkId → 규칙 표시) */
  private earlyBlocked = new Map<string, string>();

  constructor(private readonly conn: CdpConnection, readonly slot = 0, private readonly targetId = '') {
    if (slot) {
      const set = recordersOf.get(slot) ?? new Set();
      set.add(this);
      recordersOf.set(slot, set);
      conn.onClosed(() => {
        set.delete(this);
        if (this.rules.length) void syncSharedWorkers(slot);
      });
    }
    conn.on('Network.requestWillBeSent', (p) => {
      // 리다이렉트는 같은 requestId로 다시 온다 → 새 줄로 기록
      const wall = p.wallTime ? p.wallTime * 1000 : Date.now();
      this.wallOffset ??= wall - p.timestamp * 1000;
      // 앞 단계(리다이렉트한 요청)의 응답은 여기에 실려 온다: 그 줄에 상태 코드와 걸린 시간을 채운다
      const prev = p.redirectResponse ? this.byId.get(p.requestId) : undefined;
      if (prev) {
        prev.status = p.redirectResponse.status;
        prev.mimeType = p.redirectResponse.mimeType;
        prev.responseHeaders = p.redirectResponse.headers;
        prev.durationMs = this.elapsed(prev, p.timestamp);
      }
      const e: NetEntry = {
        no: ++this.seq, requestId: p.requestId, method: p.request.method, url: p.request.url,
        type: p.type ?? 'Other', startedAt: wall,
        requestHeaders: p.request.headers, hasPostData: !!p.request.hasPostData,
      };
      // 맨 위 문서가 바뀌면 그 사이트를 기억한다 (업체 규칙에서 자기 사이트 요청 빼기, 신호를 사이트별로 알리기)
      if (p.type === 'Document' && this.targetId && p.frameId === this.targetId) this.setTopUrl(p.request.url);
      const early = this.earlyBlocked.get(p.requestId);
      if (early) { e.blockedBy = early; this.earlyBlocked.delete(p.requestId); }
      this.byId.set(p.requestId, e);
      this.entries.push(e);
      this.inflight.add(p.requestId);
      if (p.frameId) this.frameOf.set(p.requestId, p.frameId);
      const post = p.request.postData as string | undefined;
      const postLen = post?.length ?? (p.request.postDataEntries as { bytes?: string }[] | undefined)?.reduce((n, x) => n + Math.floor((x.bytes?.length ?? 0) * 3 / 4), 0);
      this.telemetry.onRequest({ url: e.url, method: e.method, type: e.type, postLen, at: wall });
      if (this.entries.length > MAX_ENTRIES) {
        const old = this.entries.shift()!;
        if (this.byId.get(old.requestId) === old) this.byId.delete(old.requestId);
      }
    });
    conn.on('Network.responseReceived', (p) => {
      const e = this.byId.get(p.requestId);
      if (!e) return;
      e.status = p.response.status;
      e.mimeType = p.response.mimeType;
      // requestServedFromCache(메모리 캐시)가 먼저 표시해 둔 것은 지우지 않는다
      e.fromCache = e.fromCache || p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
      e.responseHeaders = p.response.headers;
      if (e.type === 'Document' && (!this.targetId || p.frameId === this.targetId)) this.telemetry.onDocumentResponse(e.url, p.response.status, e.responseHeaders, Date.now());
    });
    // 웹소켓은 Fetch로 막을 수 없지만, 어디에 붙는지는 신호로 본다
    conn.on('Network.webSocketCreated', (p) => this.telemetry.onRequest({ url: p.url, method: 'GET', type: 'WebSocket', at: Date.now() }));
    // 이 요청에 실제로 실린 쿠키 이름 (봇 탐지 업체 쿠키를 알아보는 데만 쓴다. 값은 보지 않는다)
    conn.on('Network.requestWillBeSentExtraInfo', (p) => {
      const names = (p.associatedCookies as { blockedReasons?: unknown[]; cookie?: { name?: string } }[] | undefined)
        ?.filter((c) => !c.blockedReasons?.length && c.cookie?.name).map((c) => c.cookie!.name!);
      if (names?.length) this.telemetry.onCookies(names, Date.now());
    });
    conn.on('Network.requestServedFromCache', (p) => {
      const e = this.byId.get(p.requestId);
      if (e) e.fromCache = true;
    });
    // 다른 사이트 iframe: 문서를 받는 중에 그 프레임이 별도 프로세스(대상)로 넘어가면 이 연결에는 '떨어져 나감'만 오고
    // 다 받았다는 신호는 오지 않는다 (실측). 그대로 두면 그 요청이 영원히 '진행 중'으로 남아 네트워크 조용함 기다리기가 끝나지 않는다.
    conn.on('Page.frameDetached', (p) => {
      for (const [id, f] of this.frameOf) if (f === p.frameId) { this.inflight.delete(id); this.frameOf.delete(id); }
    });
    conn.on('Network.loadingFinished', (p) => {
      this.inflight.delete(p.requestId);
      this.frameOf.delete(p.requestId);
      const e = this.byId.get(p.requestId);
      if (!e) return;
      e.size = p.encodedDataLength;
      e.durationMs = this.elapsed(e, p.timestamp);
    });
    conn.on('Network.loadingFailed', (p) => {
      this.inflight.delete(p.requestId);
      this.frameOf.delete(p.requestId);
      const e = this.byId.get(p.requestId);
      if (!e) return;
      e.failed = p.blockedReason ? `${p.errorText} (${p.blockedReason})` : p.errorText;
      e.durationMs = this.elapsed(e, p.timestamp);
    });
    conn.on('Fetch.requestPaused', (p) => this.onPaused(p));
    // 다른 사이트 iframe은 Chrome에서 별도 대상이라 탭에 건 Fetch가 닿지 않는다.
    // 규칙이 있는 동안에는 자동으로 붙어서(요청을 보내기 전에 멈춘 채로) 같은 규칙을 건다. 그 안의 iframe도 같은 방식으로.
    const attached = (p: any) => void this.onChild(p.sessionId);
    conn.on('Target.attachedToTarget', attached);
    conn.onSession('Target.attachedToTarget', attached);
    conn.onSession('Fetch.requestPaused', (p, sid) => this.onPaused(p, sid));
    const detached = (p: any) => this.children.delete(p.sessionId);
    conn.on('Target.detachedFromTarget', detached);
    conn.onSession('Target.detachedFromTarget', detached);
  }

  /** 탭에 띄운 페이지 주소를 알려 준다 (규칙을 걸 때 지금 페이지로 맞추고, 이동할 때마다 갱신) */
  setTopUrl(url: string) {
    const site = siteOfUrl(url);
    if (!site) return;
    this.topSite = site;
    this.telemetry.site = site;
  }

  private onPaused(p: any, sessionId?: string) {
    if (!sessionId && p.resourceType === 'Document' && p.frameId === this.targetId) this.setTopUrl(p.request.url);
    const rule = answer(this.conn, this.rules, p, sessionId, { mainFrame: sessionId ? undefined : this.targetId, topSite: this.topSite });
    if (!rule || sessionId || !p.networkId) return;
    const mark = rule.mode === 'empty' ? `${rule.label ?? rule.pattern}, answered empty` : rule.label ?? rule.pattern;
    const e = this.byId.get(p.networkId);
    if (e) e.blockedBy = mark;
    else {
      if (this.earlyBlocked.size > 200) this.earlyBlocked.clear();
      this.earlyBlocked.set(p.networkId, mark);
    }
  }

  private fetchPatterns() {
    return fetchPatterns(this.rules);
  }

  /** 자동으로 붙은 하위 대상: 규칙을 걸고, 그 안의 iframe에도 붙게 한 뒤, 멈춰 있던 대상을 풀어 준다. */
  private async onChild(sessionId: string) {
    this.children.add(sessionId);
    const send = (m: string, p: Record<string, unknown> = {}) => this.conn.send(m, p, 5000, sessionId).catch(() => undefined);
    if (this.rules.length) {
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Fetch.enable', this.fetchPatterns());
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    }
    await send('Runtime.runIfWaitingForDebugger');
  }

  private elapsed(e: NetEntry, monoSec: number): number | undefined {
    if (this.wallOffset === undefined) return undefined;
    return Math.max(0, Math.round(monoSec * 1000 + this.wallOffset - e.startedAt));
  }

  async enable() {
    await this.conn.send('Network.enable', { maxTotalBufferSize: 5_000_000, maxResourceBufferSize: 1_000_000 }, 5000).catch(() => undefined);
  }

  list(): NetEntry[] {
    this.prune();
    return this.entries;
  }

  /** 30분 넘은 기록을 지운다. */
  prune() {
    const cutoff = Date.now() - MAX_AGE_MS;
    while (this.entries.length && this.entries[0].startedAt < cutoff) {
      const old = this.entries.shift()!;
      if (this.byId.get(old.requestId) === old) this.byId.delete(old.requestId);
    }
  }

  find(ref: string): NetEntry | undefined {
    const n = Number(ref.replace(/^n/i, ''));
    return this.entries.find((e) => e.no === n);
  }

  /** 규칙을 바꾸고 Fetch 가로채기 패턴을 다시 건다. */
  async setRules(rules: BlockRule[]) {
    this.rules = rules;
    // 캐시에서 바로 나오는 요청은 가로챌 수 없으므로, 규칙이 있는 동안만 이 탭의 캐시를 끈다.
    await this.conn.send('Network.setCacheDisabled', { cacheDisabled: rules.length > 0 }, 5000).catch(() => undefined);
    if (!rules.length) {
      await this.conn.send('Fetch.disable', {}, 5000).catch(() => undefined);
      // 하위 대상의 규칙도 풀고 자동으로 붙기를 멈춘다
      for (const sid of this.children) {
        await this.conn.send('Fetch.disable', {}, 5000, sid).catch(() => undefined);
        await this.conn.send('Network.setCacheDisabled', { cacheDisabled: false }, 5000, sid).catch(() => undefined);
      }
      await this.conn.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, 5000).catch(() => undefined);
    } else {
      await this.conn.send('Fetch.enable', this.fetchPatterns(), 5000);
      // 이미 붙어 있는 하위 대상은 새 규칙으로 바꾸고, 아직이면 붙는다 (이미 떠 있는 iframe·워커도 이때 붙음)
      for (const sid of this.children) await this.conn.send('Fetch.enable', this.fetchPatterns(), 5000, sid).catch(() => undefined);
      await this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 5000).catch(() => undefined);
    }
    // 공유 워커는 탭에 딸리지 않은 별도 대상이라 슬롯 브라우저 연결에서 따로 붙어 같은 규칙을 건다
    if (this.slot) await syncSharedWorkers(this.slot);
  }
}

function fetchPatterns(rules: BlockRule[]) {
  return { patterns: rules.map((r) => ({ urlPattern: r.pattern, requestStage: 'Request' })) };
}

// 빈 응답: 이미지는 1x1 투명 GIF (빈 몸이면 이미지가 오류로 보인다), 나머지는 비어 있는 몸
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const TYPE_OF: Record<string, string> = { Script: 'application/javascript', Stylesheet: 'text/css', Image: 'image/gif', Document: 'text/html', XHR: 'application/json', Fetch: 'application/json' };

function siteOfUrl(url: string): string {
  try { return siteOf(new URL(url).hostname); } catch { return ''; }
}

/** 멈춘 요청에 규칙대로 답한다 (막기·빈 응답·그대로 보내기). 맞은 규칙을 돌려준다. */
function answer(conn: CdpConnection, rules: BlockRule[], p: any, sessionId?: string, ctx: { mainFrame?: string; topSite?: string } = {}): BlockRule | undefined {
  // 업체 이름으로 건 규칙은 탭에 띄운 페이지 자체와, 그 사이트 자신의 요청은 막지 않는다
  // (예: 세션 녹화를 막은 채 contentsquare.com을 직접 열어도 그 사이트는 멀쩡히 보이게)
  const top = p.resourceType === 'Document' && !!ctx.mainFrame && p.frameId === ctx.mainFrame;
  const own = !!ctx.topSite && siteOfUrl(p.request.url) === ctx.topSite;
  const sending = p.request.method !== 'GET' && p.request.method !== 'HEAD';
  const rule = rules.find((r) => !(top && r.label) && !(own && r.thirdParty) && !(r.postOnly && !sending) && wildcard(r.pattern).test(p.request.url));
  const send = (m: string, params: Record<string, unknown>) => void conn.send(m, params, 5000, sessionId).catch(() => undefined);
  if (!rule) send('Fetch.continueRequest', { requestId: p.requestId });
  else if (rule.mode !== 'empty') send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
  else {
    const origin = Object.entries(p.request.headers ?? {}).find(([k]) => k.toLowerCase() === 'origin')?.[1] as string | undefined;
    const headers = [
      { name: 'Content-Type', value: TYPE_OF[p.resourceType] ?? 'text/plain' },
      { name: 'Cache-Control', value: 'no-store' },
      ...(origin ? [{ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Vary', value: 'Origin' }] : []),
    ];
    const status = p.resourceType === 'Ping' ? 204 : 200;
    // 이미지는 1x1 GIF, fetch/XHR은 빈 JSON({}) (페이지가 res.json()을 불러도 오류가 나지 않게)
    const body = status !== 200 ? undefined : p.resourceType === 'Image' ? GIF : p.resourceType === 'XHR' || p.resourceType === 'Fetch' ? 'e30=' : undefined;
    send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: headers, ...(body ? { body } : {}) });
  }
  return rule;
}

// ── 공유 워커 ──
// 공유 워커(SharedWorker)는 여러 탭이 함께 쓰고 탭 밑에 붙지 않는다. 슬롯에 규칙이 하나라도 있는 동안
// 브라우저 연결에서 공유 워커에만 자동으로 붙어(시작 전에 멈춘 채로) 그 슬롯 규칙 전체를 건다.
interface WorkerGuard { conn: CdpConnection; sessions: Set<string>; rules: BlockRule[]; offs: (() => void)[] }
const guards = new Map<number, WorkerGuard>();

function slotRules(slot: number): BlockRule[] {
  const seen = new Map<string, BlockRule>();
  for (const r of recordersOf.get(slot) ?? []) for (const x of r.rules) if (!seen.has(x.pattern)) seen.set(x.pattern, x);
  return [...seen.values()];
}

// 같은 슬롯의 동기화는 하나씩 (두 탭이 동시에 규칙을 바꿔도 지킴이가 둘 생기지 않게)
const syncing = new Map<number, Promise<void>>();
function syncSharedWorkers(slot: number): Promise<void> {
  const next = (syncing.get(slot) ?? Promise.resolve()).then(() => syncSharedWorkersNow(slot)).catch(() => undefined);
  syncing.set(slot, next);
  void next.finally(() => { if (syncing.get(slot) === next) syncing.delete(slot); });
  return next;
}

async function syncSharedWorkersNow(slot: number) {
  if (!browserOf) return;
  const rules = slotRules(slot);
  let g = guards.get(slot);
  if (!rules.length && !g) return;
  const conn = await browserOf(slot).catch(() => undefined);
  if (!conn) return;
  if (g && (g.conn !== conn || g.conn.closed)) { for (const off of g.offs) off(); guards.delete(slot); g = undefined; }
  const apply = async (sid: string) => {
    const send = (m: string, p: Record<string, unknown> = {}) => conn.send(m, p, 5000, sid).catch(() => undefined);
    // Fetch만 켠다 (실험: 공유 워커에서 Network.enable을 먼저 켜면 Fetch 가로채기가 걸리지 않는다)
    await send(g!.rules.length ? 'Fetch.enable' : 'Fetch.disable', g!.rules.length ? fetchPatterns(g!.rules) : {});
  };
  if (!g) {
    if (!rules.length) return;
    const guard: WorkerGuard = { conn, sessions: new Set(), rules, offs: [] };
    g = guard;
    guards.set(slot, guard);
    guard.offs.push(
      conn.on('Target.attachedToTarget', async (p) => {
        if (p.targetInfo?.type !== 'shared_worker') return;
        // 멈춘 채로 붙은 워커는 무슨 일이 있어도 풀어 준다 (안 풀면 그 워커가 영영 시작하지 않는다)
        if (!guard.sessions.has(p.sessionId) && guards.get(slot) === guard) {
          guard.sessions.add(p.sessionId);
          await apply(p.sessionId);
        }
        await conn.send('Runtime.runIfWaitingForDebugger', {}, 5000, p.sessionId).catch(() => undefined);
      }),
      conn.on('Target.detachedFromTarget', (p) => guard.sessions.delete(p.sessionId)),
      conn.onSession('Fetch.requestPaused', (p, sid) => { if (guard.sessions.has(sid)) answer(conn, guard.rules, p, sid); }),
    );
  }
  g.rules = rules;
  if (rules.length) {
    await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'shared_worker', exclude: false }, { exclude: true }] }, 5000).catch(() => undefined);
    // 이미 돌고 있는 공유 워커에도 붙는다
    const { targetInfos = [] } = await conn.send<{ targetInfos: { targetId: string; type: string; attached: boolean }[] }>('Target.getTargets', {}, 5000).catch(() => ({ targetInfos: [] }));
    // 이미 이 지킴이가 붙은 워커는 다시 붙지 않는다 (붙을 때마다 세션이 하나씩 늘어 요청을 여러 번 가로채게 된다)
    for (const t of targetInfos.filter((x) => x.type === 'shared_worker' && !x.attached)) {
      const r = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true }, 5000).catch(() => undefined);
      if (r && !g.sessions.has(r.sessionId)) { g.sessions.add(r.sessionId); await apply(r.sessionId); }
    }
    for (const sid of g.sessions) await apply(sid);
  } else {
    for (const sid of g.sessions) {
      await apply(sid);
      await conn.send('Target.detachFromTarget', { sessionId: sid }, 5000).catch(() => undefined);
    }
    g.sessions.clear();
    await conn.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, 5000).catch(() => undefined);
    for (const off of g.offs) off();
    guards.delete(slot);
  }
}

/** Fetch 패턴과 같은 규칙: * 는 아무 글자 여러 개, ? 는 한 글자. */
const wildcardCache = new Map<string, RegExp>();
/** 같은 패턴은 한 번만 정규식으로 바꾼다 (요청마다 수백 개를 새로 만들지 않게) */
export function wildcard(pattern: string): RegExp {
  let r = wildcardCache.get(pattern);
  if (r) return r;
  if (wildcardCache.size > 2000) wildcardCache.clear();
  r = wildcardOf(pattern);
  wildcardCache.set(pattern, r);
  return r;
}

function wildcardOf(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}
