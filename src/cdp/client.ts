import { CdpmError } from '../errors.js';

type Handler = (params: any) => void;

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
        reject(new CdpmError(`CDP 연결 시간 초과: ${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpmError(`CDP 연결 실패: ${url}`));
      }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpmError(`CDP 연결이 끊어졌습니다 (${method}).`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(
          `Chrome이 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않았어요 (${method}). ` +
          '페이지가 무겁거나, 네트워크가 느리거나, 알림창이 떠 있을 수 있어요. 잠시 뒤 다시 시도하거나 browser_tabs로 상태를 확인하세요.',
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
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
      if (msg.error) p.reject(new CdpmError(`${p.method} 실패: ${msg.error.message}`));
      else p.resolve(msg.result);
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
      p.reject(new CdpmError(`CDP 연결이 끊어졌습니다 (${p.method}). 탭이 닫혔거나 Chrome이 종료됐을 수 있어요.`));
    }
    this.pending.clear();
    for (const h of this.closedHandlers) h();
  }
}
