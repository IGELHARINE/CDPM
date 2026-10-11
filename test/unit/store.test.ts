import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runAutoSetup } from '../../src/auto-setup.js';
import { isStatuslineConfigured, setupStatusline } from '../../src/statusline-setup.js';
import { buildIcon, encodePng, precompensate, renderIcon, ICON_SIZES } from '../../src/taskbar/icon.js';

const run = promisify(execFile);
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-unit-'));
  process.env.CDPM_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('기록부', () => {
  it('여러 프로세스가 동시에 써도 하나도 잃지 않음', async () => {
    const storeUrl = new URL('../../src/registry/store.js', import.meta.url).href;
    const script = `
      const { updateRegistry } = await import(${JSON.stringify(storeUrl)});
      for (let i = 0; i < 20; i++) {
        await updateRegistry((r) => {
          const s = (r.slots['1'] ??= { launchedAt: '', nextTabSeq: 1, tabs: {} });
          const seq = s.nextTabSeq++;
          s.tabs['T' + process.pid + '-' + i] = { id: 't' + seq, seq, seenAt: '', openedBy: 'x' };
        });
      }`;
    await Promise.all(Array.from({ length: 5 }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CDPM_HOME: home } })));
    const { readRegistry } = await import('../../src/registry/store.js');
    const s = readRegistry().slots['1'];
    assert.equal(Object.keys(s.tabs).length, 100);
    assert.equal(s.nextTabSeq, 101);
    assert.equal(new Set(Object.values(s.tabs).map((t) => t.id)).size, 100);
  });

  it('잠금을 쥔 프로세스가 죽었으면 풀고 진행', async () => {
    const { paths } = await import('../../src/paths.js');
    const { withLock } = await import('../../src/registry/lock.js');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(paths.lock(), '4194300'); // 존재하지 않는 PID
    assert.equal(await withLock(() => 42), 42);
    assert.ok(!fs.existsSync(paths.lock()));
  });

  it('잠금을 쥔 프로세스가 살아 있으면 오래돼도 뺏지 않음', async () => {
    const { paths } = await import('../../src/paths.js');
    const { withLock, LockTimeoutError } = await import('../../src/registry/lock.js');
    fs.writeFileSync(paths.lock(), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.lock(), old, old);
    await assert.rejects(withLock(() => 1, 200), LockTimeoutError);
  });
});

describe('메시지', () => {
  it('보내기, 받는 사람 필터, 읽음 처리', async () => {
    const { sendMessage, takeUnread } = await import('../../src/registry/messages.js');
    await sendMessage(1, 'A', '모두에게', null);
    await sendMessage(1, 'A', 'B에게만', 'B');
    await sendMessage(1, 'B', 'B가 보냄', null);
    const forB = await takeUnread(1, 'B');
    assert.deepEqual(forB.map((m) => m.text), ['모두에게', 'B에게만']);
    assert.deepEqual(await takeUnread(1, 'B'), []);
    const forC = await takeUnread(1, 'C');
    assert.deepEqual(forC.map((m) => m.text), ['모두에게', 'B가 보냄']);
    await sendMessage(1, 'A', '새 소식', null);
    assert.deepEqual((await takeUnread(1, 'B')).map((m) => m.text), ['새 소식']);
  });

  it('1000줄을 넘으면 최근 500줄만 남김', async () => {
    const { sendMessage } = await import('../../src/registry/messages.js');
    const { paths } = await import('../../src/paths.js');
    fs.mkdirSync(path.dirname(paths.messages(2)), { recursive: true });
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ seq: i + 1, at: '', from: 'A', to: null, text: String(i) }));
    fs.writeFileSync(paths.messages(2), lines.join('\n') + '\n');
    const m = await sendMessage(2, 'A', '마지막', null);
    assert.equal(m.seq, 1001);
    const kept = fs.readFileSync(paths.messages(2), 'utf8').trim().split('\n');
    assert.equal(kept.length, 500);
    assert.equal(JSON.parse(kept.at(-1)!).text, '마지막');
  });

  it('wait: 기다리는 동안 온 메시지를 받음', async () => {
    const { sendMessage, waitUnread, takeUnread } = await import('../../src/registry/messages.js');
    await takeUnread(3, 'B');
    setTimeout(() => void sendMessage(3, 'A', '왔다', null), 300);
    const got = await waitUnread(3, 'B', 5);
    assert.deepEqual(got.map((m) => m.text), ['왔다']);
  });
});

describe('아이콘', () => {
  it('PNG 시그니처와 크기', () => {
    const png = encodePng(renderIcon(7, 32), 32);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 32);
    assert.equal(png.readUInt32BE(20), 32);
  });
  it('ICO에 모든 크기가 들어감 (256은 0으로 표기)', () => {
    const ico = buildIcon(30);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
    const sizes = ICON_SIZES.map((_, i) => ico[6 + i * 16]);
    assert.deepEqual(sizes, ICON_SIZES.map((s) => (s >= 256 ? 0 : s)));
  });
  it('큰 아이콘 보정: 작업표시줄 방식(실측한 4칸→3칸 보간)으로 줄이면 원래 그림이 된다', () => {
    const n = 24, m = 32;
    const src = renderIcon(7, n);
    const big = precompensate(src, n);
    const sample = (o: number) => { const p = 4 * Math.floor(o / 3) + [0.25, 5 / 3, 35 / 12][o % 3]; const i = Math.floor(p); return [i, p - i] as const; };
    let total = 0, count = 0;
    for (let oy = 0; oy < n; oy++) for (let ox = 0; ox < n; ox++) for (let ch = 0; ch < 4; ch++) {
      if (src[(oy * n + ox) * 4 + 3] < 255 && ch < 3) continue; // 반투명 가장자리 색은 알파와 함께 비교하기 어려워 알파로만 본다
      const [ix, fx] = sample(ox), [iy, fy] = sample(oy);
      const v = (x: number, y: number) => big[(Math.min(y, m - 1) * m + Math.min(x, m - 1)) * 4 + ch];
      const got = (v(ix, iy) * (1 - fx) + v(ix + 1, iy) * fx) * (1 - fy) + (v(ix, iy + 1) * (1 - fx) + v(ix + 1, iy + 1) * fx) * fy;
      total += Math.abs(got - src[(oy * n + ox) * 4 + ch]); count++;
    }
    assert.ok(total / count <= 2, `평균 차이 ${total / count}`);
  });
  it('가운데에 흰 글자, 모서리는 투명', () => {
    const size = 64;
    const px = renderIcon(1, size);
    const at = (x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    assert.equal(at(0, 0)[3], 0);
    let white = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at(x, y).slice(0, 3).every((v) => v > 240)) white++;
    assert.ok(white > 100, `흰 픽셀 ${white}`);
  });
});

describe('상태줄 켜기', () => {
  const CMD = '"node" "/x/dist/cli.js" statusline';
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-sl-'));
    return { dir, p: { claudeSettings: path.join(dir, 'claude', 'settings.json'), ccstatusline: path.join(dir, 'cc', 'settings.json') } };
  };
  const write = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); };
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

  it('상태줄이 없으면 Claude 설정에 넣고 다른 설정은 그대로, 백업 남김', () => {
    const { p } = setup();
    write(p.claudeSettings, { model: 'x' });
    assert.equal(isStatuslineConfigured(p), false);
    assert.equal(setupStatusline(p, CMD).state, 'claude');
    const s = read(p.claudeSettings);
    assert.equal(s.model, 'x');
    assert.equal(s.statusLine.command, CMD);
    assert.equal(s.statusLine.refreshInterval, 3);
    assert.ok(fs.existsSync(p.claudeSettings + '.before-cdpm'));
    assert.equal(setupStatusline(p, CMD).state, 'already');
  });
  it('ccstatusline이면 내용 있는 마지막 줄 다음에 위젯 추가', () => {
    const { p } = setup();
    write(p.claudeSettings, { statusLine: { type: 'command', command: 'ccstatusline.exe' } });
    write(p.ccstatusline, { version: 3, lines: [[{ id: '1', type: 'model' }], [], []] });
    assert.equal(setupStatusline(p, CMD).state, 'ccstatusline');
    const cc = read(p.ccstatusline);
    assert.equal(cc.lines.length, 3);
    assert.equal(cc.lines[1][0].commandPath, CMD);
    assert.equal(cc.version, 3);
    assert.equal(read(p.claudeSettings).statusLine.refreshInterval, 3);
    assert.ok(isStatuslineConfigured(p));
  });
  it('이미 켜져 있어도 다시 그리는 주기가 없거나 길면 3초로', () => {
    const { p } = setup();
    write(p.claudeSettings, { statusLine: { type: 'command', command: CMD, refreshInterval: 10 } });
    assert.equal(setupStatusline(p, CMD).state, 'already');
    assert.equal(read(p.claudeSettings).statusLine.refreshInterval, 3);
    assert.equal(read(p.claudeSettings).statusLine.command, CMD);
  });
  it('다른 상태줄이면 바꾸지 않음', () => {
    const { p } = setup();
    write(p.claudeSettings, { statusLine: { type: 'command', command: 'my-line.sh' } });
    assert.equal(setupStatusline(p, CMD).state, 'other');
    assert.equal(read(p.claudeSettings).statusLine.command, 'my-line.sh');
  });
});

describe('자동 설정 (업데이트 때 항목별 판단)', () => {
  const fake = (name: string, store: Set<string>, calls: string[]) => ({
    name,
    present: () => store.has(name),
    apply: () => { calls.push(name); store.add(name); return `${name} 넣음`; },
  });
  const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-as-')), 'auto-setup.json');

  it('처음에는 모두 넣고, 같은 버전에서는 다시 하지 않음', () => {
    const file = tmpState();
    const store = new Set<string>();
    const calls: string[] = [];
    const items = ['a', 'b'].map((n) => fake(n, store, calls));
    runAutoSetup(items, file, 5);
    assert.deepEqual(calls, ['a', 'b']);
    runAutoSetup(items, file, 5);
    assert.deepEqual(calls, ['a', 'b'], '같은 버전이면 아무것도 안 함');
  });

  it('업데이트하면 남아 있는 것만 갱신하고, 사용자가 지운 것은 되살리지 않음', () => {
    const file = tmpState();
    const store = new Set<string>();
    const calls: string[] = [];
    const items = ['a', 'b'].map((n) => fake(n, store, calls));
    runAutoSetup(items, file, 5);
    store.delete('b'); // 사용자가 b를 지움 (cdpm unsetup 포함)
    calls.length = 0;
    runAutoSetup([...items, fake('c', store, calls)], file, 6); // 새 버전, 새 항목 c
    assert.deepEqual(calls, ['a', 'c'], 'a는 갱신, b는 되살리지 않음, 새 항목 c는 넣음');
    assert.equal(store.has('b'), false);
  });

  it('넣지 못한 항목이 있으면 이 버전을 끝난 것으로 적지 않고 다음에 다시', () => {
    const file = tmpState();
    const store = new Set<string>();
    const calls: string[] = [];
    let broken = true; // 처음에는 설정 파일이 깨져 있어서 안 들어감
    const flaky = { name: 'x', present: () => store.has('x'), apply: () => { calls.push('x'); if (!broken) store.add('x'); return ''; } };
    runAutoSetup([flaky], file, 7);
    assert.deepEqual(calls, ['x']);
    broken = false;
    runAutoSetup([flaky], file, 7); // 같은 버전이어도 다시 시도
    assert.deepEqual(calls, ['x', 'x']);
    assert.equal(store.has('x'), true);
    runAutoSetup([flaky], file, 7); // 이제 끝났으니 다시 하지 않음
    assert.deepEqual(calls, ['x', 'x']);
  });

  it('예전 표시 파일(auto-setup-vN.done)만 있는 사용자도 지운 것은 되살리지 않음', () => {
    const file = tmpState();
    fs.writeFileSync(path.join(path.dirname(file), 'auto-setup-v9.done'), 'x');
    const store = new Set<string>(['statusline']); // claudeMd는 사용자가 지운 상태
    const calls: string[] = [];
    runAutoSetup([fake('statusline', store, calls), fake('claudeMd', store, calls)], file, 13);
    assert.deepEqual(calls, ['statusline']);
  });
});
