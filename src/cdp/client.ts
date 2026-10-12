import { CdpmError } from '../errors.js';

type Handler = (params: any) => void;
type SessionHandler = (params: any, sessionId: string) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CdpTimeoutError extends CdpmError {}

/** CDP WebSocket 연결 하나. Node 내장 WebSocket 사용. */
export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  /** 이 연결에 자동으로 붙은 하위 대상(sessionId가 붙은 메시지)의 이벤트. 탭 자신의 이벤트와 섞지 않는다 */
  private sessionHandlers = new Map<string, Set<SessionHandler>>();
  private closedHandlers = new Set<() => void>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CdpmError(`CDP connect timed out: ${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpmError(`CDP connect failed: ${url}`));
      }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpmError(`CDP connection closed (${method}).`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(
          `Chrome did not respond for ${Math.round(timeoutMs / 1000)}s (${method}). ` +
          'The page may be heavy, the network slow, or a dialog open. Retry shortly or check with browser_tabs.',
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** 하위 대상(자동으로 붙은 iframe 등)의 이벤트만 받는다. */
  onSession(event: string, handler: SessionHandler): () => void {
    let set = this.sessionHandlers.get(event);
    if (!set) this.sessionHandlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  onClosed(handler: () => void) {
    this.closedHandlers.add(handler);
  }

  /** 조건에 맞는 이벤트를 기다린다. 시간 안에 안 오면 null. */
  waitFor(event: string, predicate: (p: any) => boolean = () => true, timeoutMs = 30_000): Promise<any | null> {
    return new Promise((resolve) => {
      const off = this.on(event, (p) => {
        if (!predicate(p)) return;
        clearTimeout(timer);
        off();
        resolve(p);
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 무시
    }
    this.onClose();
  }

  private onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpmError(`${p.method} failed: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.sessionId) {
      for (const h of this.sessionHandlers.get(msg.method) ?? []) {
        try {
          h(msg.params, msg.sessionId);
        } catch {
          // 핸들러 오류는 연결에 영향 주지 않음
        }
      }
      return;
    }
    if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) {
        try {
          h(msg.params);
        } catch {
          // 핸들러 오류는 연결에 영향 주지 않음
        }
      }
    }
  }

  private onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpmError(`CDP connection closed (${p.method}). The tab or Chrome may have closed.`));
    }
    this.pending.clear();
    for (const h of this.closedHandlers) h();
  }
}
