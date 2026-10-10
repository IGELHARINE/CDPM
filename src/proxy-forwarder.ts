// 슬롯 하나 전용 프록시 중계 프로그램 (src/chrome/proxy.ts가 띄운다).
// Chrome은 아이디·비밀번호가 있는 프록시를 플래그로 받지 못하므로, Chrome은 인증 없이 여기(127.0.0.1)로 보내고
// 여기서 원래 프록시(http/https/socks5)에 인증을 붙여 넘긴다. 그 슬롯 Chrome이 꺼지면 스스로 끝난다.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { ProxySpec } from './chrome/proxy.js';

const up: ProxySpec = JSON.parse(process.env.CDPM_PROXY_UPSTREAM ?? '{}');
const cdpPort = Number(process.env.CDPM_PROXY_CDP_PORT);
const basic = up.user !== undefined ? 'Basic ' + Buffer.from(`${up.user}:${up.pass ?? ''}`).toString('base64') : undefined;

function connectUpstream(): net.Socket {
  const host = up.host.replace(/^\[|\]$/g, ''); // IPv6는 [::1]처럼 대괄호로 온다
  return up.scheme === 'https'
    ? tls.connect({ host, port: up.port, servername: net.isIP(host) ? undefined : host })
    : net.connect({ host, port: up.port });
}

/** 원래 프록시를 거쳐 host:port로 가는 연결(터널)을 만든다. */
function tunnel(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = connectUpstream();
    const fail = (e: Error) => { s.destroy(); reject(e); };
    s.once('error', fail);
    s.setTimeout(20_000, () => fail(new Error('프록시 응답 없음')));
    const ready = () => { s.setTimeout(0); s.removeListener('error', fail); resolve(s); };
    s.once(up.scheme === 'https' ? 'secureConnect' : 'connect', () => {
      if (up.scheme === 'socks5') return socks5(s, host, port).then(ready, fail);
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${basic ? `Proxy-Authorization: ${basic}\r\n` : ''}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        s.removeListener('data', onData);
        s.pause(); // 다 읽은 뒤 멈춰 둬야, 이어서 온 데이터가 읽는 쪽이 붙기 전에 버려지지 않는다
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1'))?.[1];
        if (status !== '200') return fail(new Error(`프록시가 연결을 거절했어요 (HTTP ${status ?? '?'})`));
        const rest = buf.subarray(end + 4);
        if (rest.length) s.unshift(rest);
        ready();
      };
      s.on('data', onData);
    });
  });
}

function readBytes(s: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < n) return;
      s.removeListener('data', onData);
      s.removeListener('close', onClose);
      s.pause();
      if (buf.length > n) s.unshift(buf.subarray(n));
      resolve(buf.subarray(0, n));
    };
    const onClose = () => reject(new Error('프록시가 연결을 끊었어요'));
    s.on('data', onData);
    s.once('close', onClose);
    s.resume(); // 앞에서 멈춰 둔 소켓은 data 리스너만으로는 다시 흐르지 않는다
  });
}

async function socks5(s: net.Socket, host: string, port: number): Promise<void> {
  s.write(Buffer.from(basic ? [5, 2, 0, 2] : [5, 1, 0]));
  const [, method] = await readBytes(s, 2);
  if (method === 2) {
    const u = Buffer.from(up.user ?? ''), p = Buffer.from(up.pass ?? '');
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, ok] = await readBytes(s, 2);
    if (ok !== 0) throw new Error('socks5 프록시가 아이디·비밀번호를 거절했어요');
  } else if (method !== 0) throw new Error('socks5 프록시가 인증 방식을 받지 않았어요');
  // 주소 이름을 그대로 넘겨 DNS도 프록시 쪽에서 풀게 한다 (이 PC의 DNS로 새지 않게)
  const h = host.replace(/^\[|\]$/g, '');
  const ipType = net.isIP(h);
  const addr = ipType === 4 ? Buffer.from([1, ...h.split('.').map(Number)])
    : ipType === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(h)])
    : Buffer.concat([Buffer.from([3, Buffer.byteLength(h)]), Buffer.from(h)]);
  s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  const head = await readBytes(s, 4);
  if (head[1] !== 0) throw new Error(`socks5 프록시가 연결을 거절했어요 (코드 ${head[1]})`);
  const len = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readBytes(s, 1))[0];
  await readBytes(s, len + 2);
}

function ipv6Bytes(ip: string): Buffer {
  const [a, b = ''] = ip.split('::');
  const hs = (x: string) => (x ? x.split(':') : []);
  const left = hs(a), right = hs(b);
  const all = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(all.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; }));
}

function splitHostPort(v: string, def: number): [string, number] {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(v);
  return m ? [m[1], Number(m[2] ?? def)] : [v, def];
}

const server = http.createServer((req, res) => {
  // https가 아닌 일반 http 요청 (Chrome은 전체 주소를 보낸다)
  let target: URL;
  try { target = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  const done = (e: Error) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`CDPM 프록시 중계 오류: ${e.message}`); };
  if (up.scheme === 'socks5') {
    const port = Number(target.port || 80);
    tunnel(target.hostname, port).then((sock) => {
      sock.resume(); // 터널을 만들며 멈춰 둔 소켓 (http 요청은 스스로 다시 켜지 않는다)
      const r = http.request({ method: req.method, path: target.pathname + target.search, headers, createConnection: () => sock });
      r.on('response', (pr) => { res.writeHead(pr.statusCode ?? 502, pr.headers); pr.pipe(res); });
      r.on('error', done);
      req.pipe(r);
    }, done);
    return;
  }
  const out = http.request({
    method: req.method, path: req.url, headers: { ...headers, ...(basic ? { 'proxy-authorization': basic } : {}) },
    createConnection: () => connectUpstream(), // 원래 프록시로 (https 프록시면 TLS, IPv6 대괄호 처리 포함)
  });
  out.on('response', (pr) => { res.writeHead(pr.statusCode ?? 502, pr.headers); pr.pipe(res); });
  out.on('error', done);
  req.pipe(out);
});

server.on('connect', (req, client, head) => {
  const [host, port] = splitHostPort(req.url ?? '', 443);
  client.on('error', () => undefined);
  tunnel(host, port).then((remote) => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) remote.write(head);
    remote.on('error', () => client.destroy());
    client.on('close', () => remote.destroy());
    remote.on('close', () => client.destroy());
    remote.pipe(client);
    client.pipe(remote);
  }, (e: Error) => {
    client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\nCDPM 프록시 중계 오류: ${e.message}`);
  });
});

/** 그 슬롯 포트에 떠 있는 Chrome의 고유 주소 (Chrome마다 다름). 응답이 없으면 undefined. */
function chromeId(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/version', timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b).webSocketDebuggerUrl); } catch { resolve(undefined); } });
    });
    r.on('error', () => resolve(undefined));
    r.on('timeout', () => { r.destroy(); resolve(undefined); });
  });
}

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as net.AddressInfo;
  process.stdout.write(`LISTEN ${addr.port}\n`);
  // Chrome이 뜨기를 1분까지 기다린다. 뜬 뒤에는 그 Chrome이 꺼지거나(두 번 연속 응답 없음)
  // 같은 포트에 다른 Chrome이 뜨면(슬롯을 끄고 다시 켬) 끝난다.
  const started = Date.now();
  let mine: string | undefined, misses = 0;
  const check = async () => {
    const id = await chromeId();
    if (id && !mine) mine = id;
    if (id && mine && id !== mine) process.exit(0);
    if (!id && (mine ? ++misses >= 2 : Date.now() - started > 60_000)) process.exit(0);
    if (id) misses = 0;
    // 내 Chrome을 알아보기 전에는 자주 본다 (금방 꺼지는 Chrome도 놓치지 않게)
    setTimeout(check, mine ? 2000 : 300);
  };
  setTimeout(check, 300);
});
