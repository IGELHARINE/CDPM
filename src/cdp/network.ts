// 탭의 네트워크 요청 기록과 요청 막기.
// 기록: Network 도메인 이벤트 (DevTools 네트워크 탭과 같은 방식, 페이지는 알 수 없음).
// 막기: Fetch 도메인으로 패턴에 맞는 요청만 잡아서 실패시킨다. 규칙은 이 연결이 살아 있는 동안만 유효하다.
import type { CdpConnection } from './client.js';

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
}

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
  rules: BlockRule[] = [];

  constructor(private readonly conn: CdpConnection) {
    conn.on('Network.requestWillBeSent', (p) => {
      // 리다이렉트는 같은 requestId로 다시 온다 → 새 줄로 기록
      const wall = p.wallTime ? p.wallTime * 1000 : Date.now();
      this.wallOffset ??= wall - p.timestamp * 1000;
      const e: NetEntry = {
        no: ++this.seq, requestId: p.requestId, method: p.request.method, url: p.request.url,
        type: p.type ?? 'Other', startedAt: wall,
        requestHeaders: p.request.headers, hasPostData: !!p.request.hasPostData,
      };
      this.byId.set(p.requestId, e);
      this.entries.push(e);
      this.inflight.add(p.requestId);
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
      e.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
      e.responseHeaders = p.response.headers;
    });
    conn.on('Network.requestServedFromCache', (p) => {
      const e = this.byId.get(p.requestId);
      if (e) e.fromCache = true;
    });
    conn.on('Network.loadingFinished', (p) => {
      this.inflight.delete(p.requestId);
      const e = this.byId.get(p.requestId);
      if (!e) return;
      e.size = p.encodedDataLength;
      e.durationMs = this.elapsed(e, p.timestamp);
    });
    conn.on('Network.loadingFailed', (p) => {
      this.inflight.delete(p.requestId);
      const e = this.byId.get(p.requestId);
      if (!e) return;
      e.failed = p.blockedReason ? `${p.errorText} (${p.blockedReason})` : p.errorText;
      e.durationMs = this.elapsed(e, p.timestamp);
    });
    conn.on('Fetch.requestPaused', (p) => {
      // Fetch 패턴에 걸린 요청 = 막을 요청
      const rule = this.rules.find((r) => wildcard(r.pattern).test(p.request.url));
      const e = p.networkId ? this.byId.get(p.networkId) : undefined;
      if (e && rule) e.blockedBy = rule.pattern;
      if (rule) void conn.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      else void conn.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
    });
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
      return;
    }
    await this.conn.send('Fetch.enable', {
      patterns: rules.map((r) => ({ urlPattern: r.pattern, requestStage: 'Request' })),
    }, 5000);
  }
}

/** Fetch 패턴과 같은 규칙: * 는 아무 글자 여러 개, ? 는 한 글자. */
export function wildcard(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}
