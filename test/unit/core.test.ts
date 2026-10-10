import type { SlotRecord } from '../../src/registry/store.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromeCandidates, findChromeWith } from '../../src/chrome/finder.js';
import { macCommands, parseCombo } from '../../src/page/keys.js';
import { pickTab, ownershipWarnings, type TabView } from '../../src/service.js';
import { describeProxy, parseProxy } from '../../src/chrome/proxy.js';
import { stableNodePath } from '../../src/paths.js';
import { colorOf, hexToRgb, isValidSlot, portBaseFrom, portOf, SLOT_COLORS } from '../../src/slots.js';
import { formatStatusline, isBlankPage } from '../../src/statusline.js';
import { formatHeader } from '../../src/tools/format.js';
import { ago, displayWidth, josa, shortUrl, truncate } from '../../src/util.js';
import { wildcard } from '../../src/cdp/network.js';

function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('슬롯', () => {
  it('포트는 14049 + 슬롯, 시작 번호는 CDPM_PORT_BASE로', () => {
    assert.equal(portOf(1), 14050);
    assert.equal(portOf(30), 14079);
    assert.equal(portBaseFrom('20000'), 20000);
    assert.equal(portBaseFrom(undefined), 14049);
    assert.equal(portBaseFrom('80'), 14049);
    assert.equal(portBaseFrom('65530'), 14049);
  });
  it('범위 검사', () => {
    assert.ok(isValidSlot(1) && isValidSlot(30));
    for (const bad of [0, 31, 1.5, -1, '3', NaN]) assert.ok(!isValidSlot(bad));
    assert.throws(() => portOf(31), /1~30번/);
  });
  it('30색이 모두 다르고 흰 글씨 대비 4.5 이상', () => {
    assert.equal(SLOT_COLORS.length, 30);
    assert.equal(new Set(SLOT_COLORS.map((c) => c.toUpperCase())).size, 30);
    for (const c of SLOT_COLORS) {
      const ratio = 1.05 / (luminance(c) + 0.05);
      assert.ok(ratio >= 4.5, `${c} 대비 ${ratio.toFixed(2)}`);
    }
    assert.equal(colorOf(1), SLOT_COLORS[0]);
  });
});

describe('Chrome 찾기', () => {
  const deps = (over: Partial<Parameters<typeof findChromeWith>[0]> = {}) => ({
    exists: () => false,
    regQuery: () => undefined,
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    platform: 'win32' as NodeJS.Platform,
    configPath: undefined,
    ...over,
  });
  it('설정 → 레지스트리 → 표준 경로 순서', () => {
    const c = chromeCandidates(deps({ configPath: 'D:\\c.exe', regQuery: (k) => (k.startsWith('HKLM') ? 'E:\\reg\\chrome.exe' : undefined) }));
    assert.equal(c[0], 'D:\\c.exe');
    assert.equal(c[1], 'E:\\reg\\chrome.exe');
    assert.ok(c[2].startsWith('C:\\Program Files\\Google'));
  });
  it('macOS: 표준 경로 → 사용자 Applications → Spotlight', () => {
    const c = chromeCandidates(deps({ platform: 'darwin', env: { HOME: '/Users/u' }, spotlight: () => ['/Volumes/X/Google Chrome.app'] }));
    assert.deepEqual(c, [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Volumes/X/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
  });
  it('있는 첫 후보를 고름', () => {
    const p = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    assert.equal(findChromeWith(deps({ exists: (x) => x === p })), p);
  });
  it('없으면 찾아본 경로를 알려줌', () => {
    assert.throws(() => findChromeWith(deps()), /찾아본 경로[\s\S]*Program Files/);
  });
});

describe('키 조합', () => {
  it('Control+A', () => {
    const c = parseCombo('Control+A')!;
    assert.equal(c.modifiers, 2);
    assert.equal(c.main.code, 'KeyA');
  });
  it('별칭과 대소문자', () => {
    assert.equal(parseCombo('ctrl+shift+tab')!.modifiers, 10);
    assert.equal(parseCombo('enter')!.main.key, 'Enter');
    assert.equal(parseCombo('esc')!.main.key, 'Escape');
  });
  it('모르는 키는 undefined', () => {
    assert.equal(parseCombo('없는키'), undefined);
    assert.equal(parseCombo('A+B'), undefined);
  });
});

const tab = (no: number, id: string, extra: Partial<TabView> = {}): TabView => ({
  no, targetId: `T${no}`, id, title: `탭${no}`, url: `https://example.com/${no}`, active: false,
  rec: { id, seq: no, seenAt: new Date().toISOString(), openedBy: '(외부)' }, ...extra,
});

describe('탭 선택 규칙', () => {
  const tabs = [tab(1, 't1'), tab(2, 't5', { active: true })];
  it('탭 1개면 그 탭', () => {
    const r = pickTab([tab(1, 't1')], undefined, 'action');
    assert.ok('tab' in r && r.tab.id === 't1');
  });
  it('여러 개 + 보기 → 앞 탭', () => {
    const r = pickTab(tabs, undefined, 'view');
    assert.ok('tab' in r && r.tab.id === 't5');
  });
  it('여러 개 + 조작 → 지정 요구', () => {
    const r = pickTab(tabs, undefined, 'action');
    assert.ok('error' in r && /탭이 2개/.test(r.error));
  });
  it('번호와 ID 모두 지정 가능', () => {
    const a = pickTab(tabs, 2, 'action');
    const b = pickTab(tabs, 'T5', 'action');
    assert.ok('tab' in a && a.tab.id === 't5');
    assert.ok('tab' in b && b.tab.id === 't5');
    assert.ok('error' in pickTab(tabs, 't9', 'action'));
  });
});

describe('소유 경고', () => {
  it('다른 에이전트가 2분 안에 조작한 탭이면 경고 (받침에 맞는 조사)', () => {
    const now = new Date().toISOString();
    const t = tab(1, 't1', { rec: { id: 't1', seq: 1, seenAt: now, openedBy: '가격비교', last: { agent: '리뷰수집', action: '클릭', at: now } } });
    const w = ownershipWarnings(t, '나');
    assert.equal(w.length, 1);
    assert.match(w[0], /이 탭 \[t1\]은 리뷰수집이 방금 클릭했어요/);
    const t2 = tab(2, 't2', { rec: { id: 't2', seq: 2, seenAt: now, openedBy: 'x', last: { agent: '가격비교', action: '입력', at: now } } });
    assert.match(ownershipWarnings(t2, '나')[0], /가격비교가 /);
  });
  it('남이 열었어도 최근 조작이 없거나, 내가 마지막이면 경고 없음', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    assert.deepEqual(ownershipWarnings(tab(1, 't1', { rec: { id: 't1', seq: 1, seenAt: '', openedBy: '준비' } }), '나'), []);
    assert.deepEqual(ownershipWarnings(tab(1, 't1', { rec: { id: 't1', seq: 1, seenAt: '', openedBy: '남', last: { agent: '남', action: '클릭', at: old } } }), '나'), []);
    assert.deepEqual(ownershipWarnings(tab(1, 't1', { rec: { id: 't1', seq: 1, seenAt: '', openedBy: '남', last: { agent: '나', action: '클릭', at: new Date().toISOString() } } }), '나'), []);
  });
  it('없는 탭을 지정하면 지금 있는 탭을 알려줌', () => {
    const r = pickTab([tab(1, 't1'), tab(2, 't4')], 9, 'action');
    assert.ok('error' in r && /지금 있는 탭: 1번 \[t1\], 2번 \[t4\]/.test(r.error));
  });
});

describe('조사와 패턴', () => {
  it('받침에 따라 이/가', () => {
    assert.equal(josa('준비', '이', '가'), '준비가');
    assert.equal(josa('검색담당', '이', '가'), '검색담당이');
    assert.equal(josa('A', '이', '가'), 'A이(가)');
  });
  it('요청 막기 패턴: * 와 ?', () => {
    assert.ok(wildcard('*api/data*').test('http://127.0.0.1:5000/api/data?x=1'));
    assert.ok(wildcard('*.mp4').test('https://cdn.example.com/v/a.mp4'));
    assert.ok(!wildcard('*.mp4').test('https://cdn.example.com/v/a.mp4?t=1'));
    assert.ok(wildcard('https://a.com/?').test('https://a.com/x'));
  });
});

describe('머리말', () => {
  it('실행한 탭 표시, 경고, 메시지', () => {
    const tabs = [tab(1, 't1'), tab(2, 't7')];
    const h = formatHeader({
      slot: 3, tabs, executedTargetId: 'T2', warnings: ['조심'],
      messages: [{ seq: 1, at: new Date().toISOString(), from: 'A', to: null, text: '안녕' }],
      dialogs: new Map([['T1', { type: 'alert', message: '로그인 필요', at: '' }]]),
    });
    assert.match(h, /^\[3번\] 탭 2개 · 2번 탭 \[t7\]에서 실행함/);
    assert.match(h, /\n> 2\. \[t7\]/);
    assert.match(h, /\[주의\] alert 알림창 떠 있음 \(1번 탭 \[t1\]\): "로그인 필요"/);
    assert.match(h, /\[주의\] 조심/);
    assert.match(h, /새 메시지 1개 \(여기서 읽음 처리됨[^)]*\)\n {2}A \(방금\): 안녕/);
  });
});

describe('상태줄', () => {
  const rec = (agent: string, text?: string, at = new Date().toISOString()) => ({
    launchedAt: at, launchedBy: agent, nextTabSeq: 1, tabs: {},
    ...(text ? { summary: { agent, text, at } } : {}),
  });
  it('번호 순서, 에이전트 이름 없이 마지막으로 조작한 탭 제목만', () => {
    const acted = (agent: string, title?: string) => ({ ...rec('켠사람'), ...(title ? { title } : {}), last: { agent, at: '2026-01-01T00:00:00Z', action: '클릭' } });
    const line = formatStatusline([
      [2, acted('다음담당', 'Daum')],
      [1, acted('검색담당', 'NAVER')],
      [3, acted('claude-main')],
    ], false);
    assert.equal(line, 'CDPM  1 NAVER  2 Daum  3');
  });
  it('빈 탭·새 탭은 내용 없는 탭으로 봄', () => {
    for (const u of ['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/', 'chrome-search://local-ntp/local-ntp.html']) assert.equal(isBlankPage(u), true, u);
    for (const u of ['https://www.naver.com/', 'chrome://settings/']) assert.equal(isBlankPage(u), false, u);
  });
  it('터미널 폭에 맞춰 제목을 줄이고, 그래도 넘치면 번호만, 그래도 넘치면 +N', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => [i + 1, { ...rec('x'), title: '아주 긴 페이지 제목입니다 정말로 길어요' }] as [number, SlotRecord]);
    const wide = formatStatusline(many(3), false, 200);
    assert.match(wide, /^CDPM  1 아주 긴 페이지 제목…  2/);
    const mid = formatStatusline(many(8), false, 120);
    assert.ok(displayWidth(mid) <= 118, mid);
    assert.match(mid, /1 아주/);
    const nums = formatStatusline(many(30), false, 120);
    assert.equal(nums, 'CDPM  ' + Array.from({ length: 30 }, (_, i) => i + 1).join('  '));
    const tiny = formatStatusline(many(30), false, 40);
    assert.ok(displayWidth(tiny) <= 38, tiny);
    assert.match(tiny, /  \+\d+$/);
  });
  it('13개 이상이면 번호만', () => {
    const many = Array.from({ length: 13 }, (_, i) => [i + 1, rec(`a${i + 1}`)] as [number, ReturnType<typeof rec>]);
    assert.match(formatStatusline(many, false), /^CDPM  1  2  3 /);
  });
  it('없으면 흐린 "CDPM  -", 색은 ANSI 24비트', () => {
    assert.equal(formatStatusline([], false), 'CDPM  -');
    assert.equal(formatStatusline([]), '[90mCDPM  -[0m');
    assert.match(formatStatusline([[1, rec('a')]]), /\x1b\[1;38;2;37;99;235m1\x1b\[0m$/);
  });
});

describe('유틸', () => {
  it('한글 폭과 자르기', () => {
    assert.equal(displayWidth('가a'), 3);
    assert.equal(truncate('가나다라', 5), '가나…');
  });
  it('짧은 주소', () => {
    assert.equal(shortUrl('https://www.naver.com/'), 'naver.com');
    assert.equal(shortUrl('about:blank'), 'about:blank');
  });
  it('지난 시간', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    assert.equal(ago('2026-01-01T00:09:59Z', now), '방금');
    assert.equal(ago('2026-01-01T00:09:30Z', now), '30초 전');
    assert.equal(ago('2026-01-01T00:07:00Z', now), '3분 전');
  });
});

describe('macOS 편집 명령', () => {
  it('Cmd 조합을 Chrome 편집 명령으로', () => {
    assert.deepEqual(macCommands(parseCombo('Meta+A')!), ['selectAll']);
    assert.deepEqual(macCommands(parseCombo('cmd+shift+z')!), ['redo']);
    assert.deepEqual(macCommands(parseCombo('Shift+Meta+ArrowLeft')!), ['moveToBeginningOfLineAndModifySelection']);
    assert.deepEqual(macCommands(parseCombo('Enter')!), []);
    assert.deepEqual(macCommands(parseCombo('Control+A')!), []);
  });
});

describe('stableNodePath', () => {
  const yes = () => true;
  it('Homebrew 버전 폴더는 opt 바로가기로 바꾼다', () => {
    assert.equal(stableNodePath('/opt/homebrew/Cellar/node/26.7.0/bin/node', yes), '/opt/homebrew/opt/node/bin/node');
    assert.equal(stableNodePath('/usr/local/Cellar/node@22/22.9.0_1/bin/node', yes), '/usr/local/opt/node@22/bin/node');
  });
  it('바로가기가 없거나 Homebrew가 아니면 그대로', () => {
    assert.equal(stableNodePath('/opt/homebrew/Cellar/node/26.7.0/bin/node', () => false), '/opt/homebrew/Cellar/node/26.7.0/bin/node');
    assert.equal(stableNodePath('C:\Program Files\nodejs\node.exe', yes), 'C:\Program Files\nodejs\node.exe');
    assert.equal(stableNodePath('/usr/bin/node', yes), '/usr/bin/node');
  });
});

describe('parseProxy', () => {
  it('여러 형식을 알아본다', () => {
    assert.deepEqual(parseProxy('1.2.3.4:8080'), { scheme: 'http', host: '1.2.3.4', port: 8080 });
    assert.deepEqual(parseProxy('socks5://u:p@h.example:1080'), { scheme: 'socks5', host: 'h.example', port: 1080, user: 'u', pass: 'p' });
    assert.deepEqual(parseProxy('u:p@1.2.3.4:3128'), { scheme: 'http', host: '1.2.3.4', port: 3128, user: 'u', pass: 'p' });
    assert.deepEqual(parseProxy('1.2.3.4:8080:kim:p@ss:wd'), { scheme: 'http', host: '1.2.3.4', port: 8080, user: 'kim', pass: 'p@ss:wd' });
    assert.deepEqual(parseProxy('https://a%40b:c%3Ad@[::1]:8443/'), { scheme: 'https', host: '[::1]', port: 8443, user: 'a@b', pass: 'c:d' });
  });
  it('알 수 없는 형식은 거절하고, 보여 줄 때는 비밀번호를 가린다', () => {
    assert.throws(() => parseProxy('garbage'));
    assert.throws(() => parseProxy('ftp://1.2.3.4:21'));
    assert.throws(() => parseProxy('socks4://u:p@1.2.3.4:1080'));
    assert.equal(describeProxy(parseProxy('1.2.3.4:8080:kim:secret')), 'http://kim:***@1.2.3.4:8080');
  });
});
