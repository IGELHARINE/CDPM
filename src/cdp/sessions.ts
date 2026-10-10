import { CdpmError } from '../errors.js';
import { portOf } from '../slots.js';
import { CdpConnection } from './client.js';
import { NetworkRecorder } from './network.js';
import { listFrameTargets, listPages, probe } from './targets.js';

export interface DialogInfo {
  type: string;      // alert | confirm | prompt | beforeunload
  message: string;
  at: string;
}

export type Visibility = 'visible' | 'hidden' | 'unknown';

/** ref가 가리키는 요소: 요소 ID와 그 요소가 속한 프레임 (isolated world를 프레임별로 만들기 위해). */
export interface RefTarget {
  backendNodeId: number;
  frameId?: string;
  /** 다른 사이트 iframe(별도 프로세스) 안의 요소면 그 iframe의 CDP 대상 ID */
  targetId?: string;
  /** 그 iframe 요소 자체 (부모 문서 안의 위치). 클릭 좌표를 화면 전체 기준으로 바꿀 때 쓴다 */
  owner?: RefTarget;
}

/** 에이전트가 마지막으로 찍은 전체 스냅샷 (쪽 넘기기용). */
export interface SnapshotCache {
  url: string;
  text: string;
  at: number;
}

/** 탭 하나에 붙은 연결. dialog 상태와 페이지 이동 이벤트를 추적한다. */
export class PageSession {
  dialog: DialogInfo | undefined;
  /**
   * 에이전트별 ref → backendDOMNodeId. 서브에이전트들은 한 프로세스를 같이 쓰므로,
   * 한 에이전트가 스냅샷을 다시 찍어도 다른 에이전트의 ref가 다른 요소를 가리키지 않게 나눠 둔다.
   */
  private refMaps = new Map<string, Map<string, RefTarget>>();
  private snapshots = new Map<string, SnapshotCache>();
  /** 프레임별 CDPM 전용 실행 공간(isolated world). 페이지 JS는 이 공간을 볼 수 없다. */
  private worlds = new Map<string, Promise<number>>();
  mainFrameId: string | undefined;
  /** 이 탭에서 마지막으로 시작된 다운로드 (사용자 다운로드 폴더에 저장됨) */
  lastDownload: { url: string; file: string; at: number } | undefined;
  /** CDPM 클릭으로 열리려던 파일 선택 창 (OS 창 대신 가로챔). browser_upload가 여기에 파일을 넣는다. */
  fileChooser: { fs: PageSession; backendNodeId: number; multiple: boolean; at: number } | undefined;
  readonly network: NetworkRecorder;
  lastUsed = Date.now();
  /** 붙을 때 알림창 때문에 켜지 못한 기능 (탭이 응답하면 켠다) */
  private pendingEnable = false;
  private renderHolds = 0;
  private emulating = false;
  /** 멈춘 탭이 다시 응답하는지 지켜보는 중인지 */
  private livenessWatch = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** 에이전트별 요소 → ref 번호. 페이지가 바뀌기 전까지 같은 요소는 같은 번호를 쓴다. */
  private refAlloc = new Map<string, { byNode: Map<number | string, string>; next: number }>();
  /** 숨은 탭을 그리기 위해 잠깐 포커스 에뮬레이션 중인지 (이때 visibilityState·hasFocus는 가짜로 보임) */
  get isEmulating() {
    return this.emulating;
  }

  constructor(
    readonly slot: number,
    readonly targetId: string,
    readonly conn: CdpConnection,
  ) {
    this.network = new NetworkRecorder(conn);
    conn.on('Page.javascriptDialogOpening', (p) => {
      this.dialog = { type: p.type, message: p.message, at: new Date().toISOString() };
      this.watchLiveness();
    });
    conn.on('Page.javascriptDialogClosed', () => {
      this.dialog = undefined;
    });
    conn.on('Page.frameNavigated', (p) => {
      // 문서가 바뀌면 그 프레임의 실행 공간은 사라진다.
      this.worlds.delete(p.frame.id);
      if (!p.frame.parentId) {
        this.mainFrameId = p.frame.id;
        this.worlds.clear();
        this.refMaps.clear();
        this.snapshots.clear();
        this.refAlloc.clear();
      }
    });
    conn.on('Page.frameDetached', (p) => this.worlds.delete(p.frameId));
    conn.on('Page.downloadWillBegin', (p) => {
      this.lastDownload = { url: p.url, file: p.suggestedFilename, at: Date.now() };
    });
  }

  /** 같은 탭에 대한 조작을 이 프로세스 안에서 하나씩 실행한다 (동시에 오면 줄 선다). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 스냅샷용 ref 번호 배정기: 이 탭의 같은 요소면 같은 번호, 처음 보면 새 번호.
   * 새 번호는 에이전트마다 프로세스 전체에서 하나씩 늘어난다 → 다른 탭이나 예전 페이지의 번호와 절대 겹치지 않는다.
   */
  refAllocator(agent: string): (backendNodeId: number, targetId?: string) => string {
    let a = this.refAlloc.get(agent);
    if (!a) this.refAlloc.set(agent, (a = { byNode: new Map(), next: 0 }));
    const alloc = a;
    // 다른 사이트 iframe은 요소 ID 번호가 따로 매겨지므로 iframe 대상 ID까지 합쳐서 구분한다
    return (id, targetId) => {
      const key = targetId ? `${targetId}:${id}` : id;
      let ref = alloc.byNode.get(key);
      if (!ref) {
        ref = `e${nextRefNo(agent)}`;
        alloc.byNode.set(key, ref);
      }
      return ref;
    };
  }

  refsFor(agent: string): Map<string, RefTarget> {
    return this.refMaps.get(agent) ?? new Map();
  }

  /** 메인 프레임 ID (처음 한 번 조회 후 이벤트로 갱신). */
  async mainFrame(): Promise<string> {
    if (this.mainFrameId) return this.mainFrameId;
    const { frameTree } = await this.conn.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, 5000);
    this.mainFrameId = frameTree.frame.id;
    return this.mainFrameId;
  }

  /** 프레임의 isolated world 실행 컨텍스트 ID. 없으면 만든다. */
  async world(frameId?: string): Promise<number> {
    const fid = frameId ?? (await this.mainFrame());
    let w = this.worlds.get(fid);
    if (!w) {
      w = this.conn.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: fid, worldName: 'cdpm', grantUniveralAccess: false }, 5000)
        .then((r) => r.executionContextId);
      w.catch(() => this.worlds.delete(fid));
      this.worlds.set(fid, w);
    }
    return w;
  }

  /** 실행 공간이 사라졌다는 오류면 다시 만들어 한 번 더 시도한다. */
  async inWorld<T>(frameId: string | undefined, fn: (contextId: number) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.world(frameId));
    } catch (e) {
      if (!/context|Cannot find|not found/i.test((e as Error).message)) throw e;
      this.worlds.delete(frameId ?? this.mainFrameId ?? '');
      if (!frameId) this.mainFrameId = undefined;
      return fn(await this.world(frameId));
    }
  }

  /** isolated world에서 식을 평가한다. */
  async evaluate<T = unknown>(expression: string, opts: { timeoutMs?: number; awaitPromise?: boolean; frameId?: string } = {}): Promise<{ value?: T; type: string; description?: string; unserializableValue?: string; exception?: string }> {
    return this.inWorld(opts.frameId, async (contextId) => {
      const r = await this.conn.send<{ result: { type: string; value?: T; description?: string; unserializableValue?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        'Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: opts.awaitPromise ?? false }, opts.timeoutMs,
      );
      if (r.exceptionDetails) return { type: 'exception', exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
      return r.result;
    });
  }

  setSnapshot(agent: string, refs: Map<string, RefTarget>, cache: SnapshotCache) {
    this.refMaps.set(agent, refs);
    this.snapshots.set(agent, cache);
  }

  snapshotFor(agent: string): SnapshotCache | undefined {
    return this.snapshots.get(agent);
  }

  /** 오래된 스냅샷 사본(페이지당 수십만 자일 수 있음)을 지운다. */
  pruneSnapshots(maxAgeMs: number) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [agent, snap] of this.snapshots) if (snap.at < cutoff) this.snapshots.delete(agent);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.conn.send<T>(method, params, timeoutMs);
  }

  /** 명령 실행 중 dialog가 뜨면 기다리지 않고 바로 돌아온다 (dialog가 떠 있으면 렌더러가 멈춰 응답이 안 오므로). */
  async sendUnlessDialog<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T | 'dialog'> {
    if (this.dialog) return 'dialog';
    const dialogOpened = this.conn.waitFor('Page.javascriptDialogOpening', () => true, timeoutMs ?? 30_000).then((p) => (p ? 'dialog' as const : new Promise<never>(() => {})));
    return Promise.race([this.conn.send<T>(method, params, timeoutMs), dialogOpened]);
  }

  /**
   * 뒤에 숨은 탭은 Chrome이 다시 그리지 않아서, 숨은 뒤 바뀐 내용은 캡처되지 않고 클릭 위치 판정도 옛 화면 기준이 된다.
   * 그래서 숨은 탭을 조작·캡처하는 동안에만 포커스 에뮬레이션을 켜서 그리게 하고, 끝나면 바로 끈다.
   * 탭 전환·창 이동 같은 사용자 화면 변화는 없다. 앞에 보이는 탭에는 아무것도 하지 않는다.
   */
  async withRendering<T>(fn: () => Promise<T>): Promise<T> {
    if (this.renderHolds === 0 && !this.emulating) {
      if ((await this.visibility()) !== 'hidden') return fn();
      await this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 3000).catch(() => undefined);
      this.emulating = true;
      await new Promise((r) => setTimeout(r, 60)); // 첫 프레임이 그려질 시간
    }
    this.renderHolds++;
    try {
      return await fn();
    } finally {
      if (--this.renderHolds === 0 && this.emulating) {
        this.emulating = false;
        const off = this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: false }, 24 * 3600_000).catch(() => undefined);
        if (!this.dialog) await off; // 알림창이 떠 있으면 응답이 늦으므로 보내 두기만 한다
      }
    }
  }

  /** 탭이 실제로 화면에 보이는지. 포커스 에뮬레이션을 쓰지 않으므로 이 값이 곧 '앞에 있는 탭'이다. */
  async visibility(timeoutMs = 2000): Promise<Visibility> {
    if (this.dialog) {
      this.watchLiveness();
      return 'unknown';
    }
    try {
      const r = await this.evaluate<string>('document.visibilityState', { timeoutMs });
      return r.value === 'visible' ? 'visible' : r.value === 'hidden' ? 'hidden' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private lastVisibility: { value: Visibility; at: number } | undefined;

  /** 앞 탭이 바뀌었을 때(탭 선택) 저장해 둔 보임 상태를 버린다. */
  forgetVisibility() {
    this.lastVisibility = undefined;
  }

  /**
   * 탭 목록의 "·앞" 표시용 보임 상태. 매번 묻되 0.3초만 기다린다: 다른 에이전트의 탭이 무거운 페이지를 그리느라 바빠도
   * 내 호출이 그 탭 때문에 늦어지지 않게 한다. 제때 답이 없으면 마지막으로 잰 값을 쓴다.
   */
  async visibilityForList(): Promise<Visibility> {
    const v = await this.visibility(300);
    if (v !== 'unknown') {
      this.lastVisibility = { value: v, at: Date.now() };
      return v;
    }
    return this.lastVisibility?.value ?? v;
  }

  /**
   * 알림창이 떠 있으면 오류. 단, '닫힘' 신호를 놓쳤을 수 있으므로(다른 프로그램이 닫았거나 연결이 잠깐 끊김)
   * 탭이 짧게라도 응답하면 이미 닫힌 것으로 보고 기록을 지운다. 알림창이 떠 있으면 렌더러가 멈춰 응답이 없다.
   */
  async ensureNoDialog() {
    if (!this.dialog) return;
    this.watchLiveness();
    this.assertNoDialog();
  }

  /**
   * 탭이 멈춰 있는 동안(알림창 등) 명령 하나를 걸어 둔다. 그 명령의 응답이 실제로 도착하는 순간이
   * '다시 움직인다'는 확실한 신호다. 알림창 닫힘 이벤트를 놓쳤어도 이걸로 스스로 회복한다.
   */
  private watchLiveness() {
    if (this.livenessWatch || this.conn.closed) return;
    this.livenessWatch = true;
    this.conn.send('Runtime.evaluate', { expression: '0', returnByValue: true }, 24 * 3600_000)
      .then(async () => {
        this.dialog = undefined;
        if (this.pendingEnable) {
          this.pendingEnable = false;
          await this.network.enable();
        }
      })
      .catch(() => undefined)
      .finally(() => { this.livenessWatch = false; });
  }

  /** 붙을 때 탭이 아직 답하지 않음 (알림창이 떠 있거나 무거운 작업 중). 응답이 오면 자동으로 풀린다. */
  markUnresponsive() {
    this.pendingEnable = true;
    this.dialog ??= { type: '응답 대기', message: '탭이 아직 응답하지 않아요 (알림창이 떠 있거나 무거운 작업 중)', at: new Date().toISOString() };
  }

  /** 붙을 때 보낸 Page.enable이 나중에라도 끝나면: 탭이 다시 움직인다는 신호 */
  enabledLater() {
    if (this.dialog?.type === '응답 대기') this.dialog = undefined;
    if (this.pendingEnable) {
      this.pendingEnable = false;
      void this.network.enable();
    }
  }

  assertNoDialog() {
    if (this.dialog) {
      throw new CdpmError(
        `이 탭에 ${this.dialog.type} 알림창이 떠 있어요: "${this.dialog.message}"\n` +
        'CDPM은 알림창을 처리하지 않습니다. 사용자에게 Chrome 창에서 직접 처리해 달라고 요청하세요.',
      );
    }
  }
}

/** 에이전트별 ref 번호 카운터 (프로세스 전체 공용) */
const refCounters = new Map<string, number>();
function nextRefNo(agent: string): number {
  const n = (refCounters.get(agent) ?? 0) + 1;
  refCounters.set(agent, n);
  return n;
}

const browserConns = new Map<number, CdpConnection>();
const pageSessions = new Map<string, PageSession>();
const connecting = new Map<string, Promise<PageSession>>();

/** 슬롯의 모든 탭 연결이 저장해 둔 보임 상태를 버린다 (앞 탭을 바꾼 뒤). */
export function forgetSlotVisibility(slot: number) {
  for (const [key, s] of pageSessions) if (key.startsWith(`${slot}:`)) s.forgetVisibility();
}

/** 이 프로세스가 이 슬롯 Chrome에 열어 둔 연결이 아직 살아 있는지 (살아 있으면 Chrome도 떠 있다). */
export function hasLiveBrowserConnection(slot: number): boolean {
  const c = browserConns.get(slot);
  return !!c && !c.closed;
}

export async function browserConnection(slot: number): Promise<CdpConnection> {
  const cached = browserConns.get(slot);
  if (cached && !cached.closed) return cached;
  const p = await probe(slot);
  if (p.state !== 'chrome') throw new CdpmError(`${slot}번 Chrome이 떠 있지 않습니다 (포트 ${portOf(slot)}).`);
  const conn = await CdpConnection.connect(p.version.webSocketDebuggerUrl);
  conn.onClosed(() => browserConns.delete(slot));
  browserConns.set(slot, conn);
  return conn;
}

/** 탭 연결을 얻는다. 같은 탭에 동시에 요청이 와도 연결은 하나만 만든다. */
export async function pageSession(slot: number, targetId: string, wsUrl?: string): Promise<PageSession> {
  const key = `${slot}:${targetId}`;
  const cached = pageSessions.get(key);
  if (cached && !cached.conn.closed) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const pending = connecting.get(key);
  if (pending) return pending;
  const p = (async () => {
    let url = wsUrl;
    if (!url) {
      const t = (await listPages(slot)).find((x) => x.id === targetId) ?? (await listFrameTargets(slot)).find((x) => x.id === targetId);
      url = t?.webSocketDebuggerUrl;
    }
    if (!url) throw new CdpmError('탭을 찾을 수 없습니다 (닫혔을 수 있어요).');
    const conn = await CdpConnection.connect(url);
    const session = new PageSession(slot, targetId, conn);
    conn.onClosed(() => pageSessions.delete(key));
    pageSessions.set(key, session);
    // Page.enable: dialog·로딩 이벤트용. 이미 떠 있는 dialog도 이때 알려준다.
    // Runtime.enable(봇 탐지 흔적)과 Emulation.*(사용자 환경 변경)은 쓰지 않는다.
    // 알림창이 떠 있으면 새 연결의 Page.enable은 응답하지 않는다 (렌더러가 멈춤).
    // 오래 기다리지 않고 '알림창이 떠 있을 수 있음'으로 표시해 두면, 탭이 응답하는 순간 자동으로 지워진다.
    // Page.enable은 끝날 때까지 기다리되(시간 제한으로 실패 처리하지 않음), 도구가 멈추지 않도록 1.5초 안에 안 끝나면
    // '응답 대기' 상태로 먼저 돌려준다. 나중에 끝나는 순간 상태가 풀린다.
    const enable = conn.send('Page.enable', {}, 24 * 3600_000).then(() => true, () => false);
    const quick = await Promise.race([enable, new Promise<'later'>((r) => setTimeout(() => r('later'), 1500))]);
    if (quick === 'later') {
      session.markUnresponsive();
      void enable.then((ok) => ok && session.enabledLater());
      return session;
    }
    // 네트워크 기록은 붙는 순간부터 (그 전 요청은 볼 수 없음)
    await session.network.enable();
    return session;
  })();
  connecting.set(key, p);
  try {
    return await p;
  } finally {
    connecting.delete(key);
  }
}

/** 이 프로세스가 붙어 있는 탭의 dialog 상태 (머리말 표시용). */
export function knownDialog(slot: number, targetId: string): DialogInfo | undefined {
  return pageSessions.get(`${slot}:${targetId}`)?.dialog;
}

export function dropSlotConnections(slot: number) {
  browserConns.get(slot)?.close();
  for (const [key, s] of pageSessions) if (s.slot === slot) {
    s.conn.close();
    pageSessions.delete(key);
  }
}

const IDLE_CLOSE_MS = 10 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
let sweeper: NodeJS.Timeout | undefined;

/**
 * 1분마다 정리: 10분 동안 안 쓴 탭 연결은 끊고(그 탭의 네트워크 기록도 멈춤),
 * 오래된 스냅샷 사본과 네트워크 기록을 지운다. 요청 막기 규칙이 걸린 탭은 연결을 유지한다.
 */
export function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of pageSessions) {
      s.pruneSnapshots(SNAPSHOT_MAX_AGE_MS);
      s.network.prune();
      if (now - s.lastUsed > IDLE_CLOSE_MS && !s.network.rules.length && !s.dialog) {
        s.conn.close();
        pageSessions.delete(key);
      }
    }
    for (const [slot, c] of browserConns) {
      const used = [...pageSessions.values()].some((s) => s.slot === slot);
      if (!used) {
        c.close();
        browserConns.delete(slot);
      }
    }
  }, 60_000);
  sweeper.unref();
}

/** 프로세스를 끝내기 전에 모든 CDP 연결을 닫는다. */
export function closeAllConnections() {
  for (const c of browserConns.values()) c.close();
  for (const s of pageSessions.values()) s.conn.close();
  browserConns.clear();
  pageSessions.clear();
}
