// 사용자가 프록시를 써 달라고 할 때만 슬롯 Chrome에 프록시를 붙인다.
// 아이디·비밀번호가 없으면 --proxy-server로 바로 넘기고, 있으면(Chrome은 플래그로 인증을 받지 못함)
// 인증을 대신 붙여 주는 중계 프로그램(proxy-forwarder.js)을 이 슬롯 전용으로 띄워 Chrome이 그쪽을 보게 한다.
import { fileURLToPath } from 'node:url';
import { CdpmError } from '../errors.js';
import { spawnOrphan } from '../orphan.js';
import { portOf } from '../slots.js';

export interface ProxySpec {
  scheme: 'http' | 'https' | 'socks5' | 'socks4';
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

const SCHEMES: Record<string, ProxySpec['scheme']> = { http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5', socks4: 'socks4', socks4a: 'socks4' };

/**
 * 받는 형식: `주소:포트`, `http://주소:포트`, `socks5://아이디:비번@주소:포트`, `아이디:비번@주소:포트`,
 * 그리고 프록시 판매처가 흔히 주는 `주소:포트:아이디:비번`.
 */
export function parseProxy(input: string): ProxySpec {
  let s = input.trim();
  const bad = () => new CdpmError(`Unrecognized proxy: "${maskProxyText(input)}". Examples: 1.2.3.4:8080, http://user:pass@1.2.3.4:8080, socks5://1.2.3.4:1080, 1.2.3.4:8080:user:pass`);
  let scheme: ProxySpec['scheme'] = 'http';
  const m = /^([a-z0-9]+):\/\//i.exec(s);
  if (m) {
    const sc = SCHEMES[m[1].toLowerCase()];
    if (!sc) throw new CdpmError(`Unsupported proxy scheme: ${m[1]} (use http, https, socks5 or socks4)`);
    scheme = sc;
    s = s.slice(m[0].length);
  }
  s = s.replace(/\/+$/, '');
  let user: string | undefined;
  let pass: string | undefined;
  let hostPort = s;
  const parts = s.split(':');
  const at = s.lastIndexOf('@');
  // 주소:포트:아이디:비번 을 먼저 본다 (비밀번호에 @가 들어 있어도 이 형식으로 읽게)
  if (parts.length >= 4 && /^\d+$/.test(parts[1]) && !parts[0].includes('@')) {
    hostPort = `${parts[0]}:${parts[1]}`;
    user = parts[2];
    pass = parts.slice(3).join(':');
  } else if (at >= 0) {
    const cred = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const c = cred.indexOf(':');
    user = c >= 0 ? cred.slice(0, c) : cred;
    pass = c >= 0 ? cred.slice(c + 1) : '';
  }
  const hp = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(hostPort);
  if (!hp) throw bad();
  const port = Number(hp[2]);
  if (port < 1 || port > 65535) throw bad();
  const dec = (v: string | undefined) => {
    if (v === undefined) return undefined;
    try { return decodeURIComponent(v); } catch { return v; }
  };
  user = dec(user);
  pass = dec(pass);
  if (user && scheme === 'socks4') throw new CdpmError('socks4 proxies do not support username/password. Use socks5 or http.');
  return { scheme, host: hp[1], port, ...(user ? { user, pass: pass ?? '' } : {}) };
}

/** 결과에 보여 줄 때: 비밀번호는 가린다. */
export function describeProxy(p: ProxySpec): string {
  return `${p.scheme}://${p.user ? `${p.user}:***@` : ''}${p.host}:${p.port}`;
}

function maskProxyText(s: string): string {
  return s.replace(/(:\/\/[^:@/]*:)[^@]*@/, '$1***@').replace(/^([^:/@]+:\d+:[^:]+:).+$/, '$1***');
}

/** Chrome에 넘길 인자. 인증이 필요하면 중계 프로그램을 띄우고 그 주소를 넘긴다. */
export async function proxyArgs(slot: number, p: ProxySpec): Promise<string[]> {
  // 프록시를 쓸 때 WebRTC가 프록시를 거치지 않는 UDP로 실제 IP를 드러내지 않게 한다
  const common = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  if (!p.user) return [`--proxy-server=${p.scheme}://${p.host}:${p.port}`, ...common];
  const local = await startForwarder(slot, p);
  return [`--proxy-server=http://127.0.0.1:${local}`, ...common];
}

async function startForwarder(slot: number, p: ProxySpec): Promise<number> {
  const script = fileURLToPath(new URL('../proxy-forwarder.js', import.meta.url));
  // 비밀번호가 프로세스 목록(명령줄)에 보이지 않도록 환경변수로 넘긴다.
  // Chrome처럼 부모 없는 프로세스로 띄워서 VS Code 등이 닫히며 줄기째 종료해도 살아 있게 한다 (그 Chrome이 꺼지면 스스로 끝남).
  try {
    const { line } = await spawnOrphan(process.execPath, [script], {
      hide: true,
      waitLine: 'LISTEN [0-9]+',
      env: { ...process.env, CDPM_PROXY_UPSTREAM: JSON.stringify(p), CDPM_PROXY_CDP_PORT: String(portOf(slot)) },
    });
    return Number(/LISTEN (\d+)/.exec(line ?? '')?.[1]);
  } catch (e) {
    throw new CdpmError(`Failed to start proxy forwarder: ${(e as Error).message}`);
  }
}
