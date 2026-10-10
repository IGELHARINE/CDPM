#!/usr/bin/env node
// cdpm            → MCP 서버 (stdio)
// cdpm launch 3   → 3번 켜기 (번호 없으면 비어 있는 가장 작은 슬롯)
// cdpm close 3 | --all, cdpm purge 3, cdpm status, cdpm statusline, cdpm statusline-setup
import fs from 'node:fs';
import { CdpmError } from './errors.js';
import { paths } from './paths.js';
import { assertSlot, PORT_BASE, portOf } from './slots.js';
import { pidAlive, sleep } from './util.js';
import { VERSION } from './version.js';

// 상태줄은 10초마다 실행되므로 무거운 모듈(MCP SDK, CDP)은 필요할 때만 불러온다.
const lazy = {
  service: () => import('./service.js'),
  sessions: () => import('./cdp/sessions.js'),
  targets: () => import('./cdp/targets.js'),
  format: () => import('./tools/format.js'),
  registry: () => import('./registry/store.js'),
};

const CLI_AGENT = '사람(CLI)';

const HELP = `cdpm ${VERSION} - CDP Manager

사용법:
  cdpm                     MCP 서버 실행 (stdio)
  cdpm install             Claude Code에 등록하고 자동 설정까지 (npm install -g cdpm 뒤 한 번)
  cdpm launch [슬롯...]     슬롯 Chrome 켜기 (예: cdpm launch 1 2 3, 번호 없으면 비어 있는 가장 작은 슬롯)
  cdpm launch --headless <슬롯...>   창 없이 실행
  cdpm close <슬롯...>      슬롯 Chrome 정상 종료
  cdpm close --all         떠 있는 모든 슬롯 종료
  cdpm purge <슬롯>         꺼진 슬롯의 프로필(로그인 정보) 삭제
  cdpm status              슬롯 현황
  cdpm statusline          상태줄용 한 줄 출력
  cdpm statusline-setup    Claude Code 상태줄에 슬롯 표시 켜기 (원래 설정은 백업)
  cdpm setup               상태줄 + CLAUDE.md 병렬 처리 규칙 + 전용 서브에이전트(cdpm-browser) + 권한 허용 목록 넣기 (MCP 서버가 처음 켜질 때 자동으로도 함)
  cdpm unsetup             CDPM이 넣은 상태줄·CLAUDE.md 규칙·서브에이전트·권한 빼기

슬롯은 1~30번, 슬롯 N의 CDP 포트는 ${PORT_BASE}+N 입니다 (1번=${PORT_BASE + 1}, CDPM_PORT_BASE로 바꿀 수 있음).`;

function slotsFrom(args: string[]): number[] {
  return args.map((a) => {
    const n = Number(a);
    assertSlot(n);
    return n;
  });
}

async function closeSlot(slot: number) {
  const { probe } = await lazy.targets();
  const { browserConnection } = await lazy.sessions();
  const { forgetSlot } = await lazy.service();
  if ((await probe(slot)).state !== 'chrome') {
    await forgetSlot(slot);
    console.log(`${slot}번: 이미 꺼져 있어요.`);
    return;
  }
  const { readRegistry } = await lazy.registry();
  const pid = readRegistry().slots[String(slot)]?.pid;
  const browser = await browserConnection(slot);
  await browser.send('Browser.close', {}, 5000).catch(() => undefined);
  for (let i = 0; i < 25 && (await probe(slot, 500)).state === 'chrome'; i++) await sleep(200);
  for (let i = 0; pid && i < 50 && pidAlive(pid); i++) await sleep(100); // 프로세스가 완전히 끝날 때까지
  await forgetSlot(slot);
  console.log(`${slot}번: 종료했어요.`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'mcp':
      await (await import('./index.js')).startServer();
      return; // 서버는 계속 돈다
    case 'launch': {
      const headless = rest.includes('--headless');
      const slotArgs = rest.filter((a) => a !== '--headless');
      const { launchSlot, firstFreeSlot } = await lazy.service();
      let slots = slotsFrom(slotArgs);
      if (!slots.length) {
        const free = await firstFreeSlot();
        if (free === undefined) throw new CdpmError('비어 있는 슬롯이 없어요 (1~30번 모두 사용 중).');
        slots = [free];
      }
      // 여러 개를 한 번에 켜면 작은 번호부터 (작업표시줄에도 그 순서로 놓인다)
      for (const slot of [...new Set(slots)].sort((a, b) => a - b)) {
        const { launched } = await launchSlot(slot, CLI_AGENT, { headless });
        console.log(`${slot}번 (포트 ${portOf(slot)}): ${launched ? `${headless ? '헤드리스로 ' : ''}실행했어요` : '이미 떠 있어요'}.`);
      }
      break;
    }
    case 'close': {
      const { liveSlots } = await lazy.service();
      const targets = rest.includes('--all') ? (await liveSlots()).map(([s]) => s) : slotsFrom(rest);
      if (!targets.length) {
        console.log(rest.includes('--all') ? '떠 있는 슬롯이 없어요.' : '종료할 슬롯을 적어 주세요. 예: cdpm close 1');
        break;
      }
      for (const slot of targets) await closeSlot(slot);
      break;
    }
    case 'purge': {
      const [slot] = slotsFrom(rest.slice(0, 1));
      if (slot === undefined) throw new CdpmError('슬롯을 적어 주세요. 예: cdpm purge 3');
      const { probe } = await lazy.targets();
      if ((await probe(slot)).state === 'chrome') throw new CdpmError(`${slot}번 Chrome이 떠 있어요. 먼저 cdpm close ${slot}으로 종료하세요.`);
      fs.rmSync(paths.profile(slot), { recursive: true, force: true });
      console.log(`${slot}번 프로필을 삭제했어요: ${paths.profile(slot)}`);
      break;
    }
    case 'status': {
      const { liveSlots, syncTabs } = await lazy.service();
      const { formatSlotStatus } = await lazy.format();
      const live = await liveSlots();
      if (!live.length) {
        console.log('떠 있는 슬롯이 없어요.');
        break;
      }
      for (const [slot, rec] of live) {
        const tabs = await syncTabs(slot).catch(() => null);
        console.log(formatSlotStatus(slot, rec, tabs) + '\n');
      }
      break;
    }
    case 'statusline': {
      // ccstatusline·Claude Code가 표준 입력으로 주는 JSON에 터미널 폭(terminal_width)이 있으면 그 폭에 맞춘다
      const width = await terminalWidthFromStdin();
      const line = await (await import('./statusline.js')).statusline(width);
      if (line) process.stdout.write(line + '\n');
      break;
    }
    case 'statusline-setup': {
      console.log((await import('./statusline-setup.js')).setupStatusline().message);
      break;
    }
    case 'unsetup': {
      // CDPM이 넣은 상태줄·CLAUDE.md 규칙을 빼고, 다시 자동으로 넣지 않게 표시를 남긴다
      console.log((await import('./statusline-setup.js')).removeStatusline());
      console.log((await import('./claude-md-setup.js')).removeClaudeMd());
      console.log((await import('./agent-setup.js')).removeAgent());
      console.log((await import('./agent-setup.js')).removePermissions());
      break;
    }
    case 'install': {
      // npm install -g cdpm 뒤 한 번: Claude Code에 등록 + 자동 설정 (여러 번 해도 됨)
      for (const line of (await import('./install.js')).installIntoClaude()) console.log(line);
      console.log((await import('./statusline-setup.js')).setupStatusline().message);
      console.log((await import('./claude-md-setup.js')).setupClaudeMd());
      console.log((await import('./agent-setup.js')).setupAgent());
      console.log((await import('./agent-setup.js')).setupPermissions());
      console.log('끝났어요. Claude Code를 다시 시작하면 CDPM을 쓸 수 있어요.');
      break;
    }
    case 'setup': {
      // 설치·업데이트 뒤 한 번: 상태줄 + CLAUDE.md 병렬 처리 규칙 (여러 번 해도 됨)
      console.log((await import('./statusline-setup.js')).setupStatusline().message);
      console.log((await import('./claude-md-setup.js')).setupClaudeMd());
      console.log((await import('./agent-setup.js')).setupAgent());
      console.log((await import('./agent-setup.js')).setupPermissions());
      break;
    }
    case '-v':
    case '--version':
      console.log(VERSION);
      break;
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    default:
      throw new CdpmError(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
  }
  await finish();
}

/**
 * process.exit()를 바로 부르면 Windows에서 닫히는 중인 소켓 때문에 libuv assertion이 날 수 있다.
 * 연결을 닫고 이벤트 루프가 스스로 끝나게 둔다. 남은 핸들이 있으면 잠시 뒤 강제 종료.
 */
/** 표준 입력(JSON)에서 터미널 폭을 읽는다. 입력이 없거나 0.3초 안에 안 오면 COLUMNS 환경변수, 그것도 없으면 기본값. */
async function terminalWidthFromStdin(): Promise<number | undefined> {
  const env = Number(process.env.COLUMNS);
  const fallback = Number.isFinite(env) && env > 0 ? env : undefined;
  if (process.stdin.isTTY) return fallback;
  const text = await new Promise<string>((resolve) => {
    let buf = '';
    const done = () => { process.stdin.removeAllListeners('data'); process.stdin.pause(); resolve(buf); };
    const timer = setTimeout(done, 300);
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
  try {
    const w = Number(JSON.parse(text)?.terminal_width);
    return Number.isFinite(w) && w > 0 ? w : fallback;
  } catch {
    return fallback;
  }
}

async function finish(code = 0) {
  process.exitCode = code;
  try {
    (await lazy.sessions()).closeAllConnections();
  } catch {
    // 무시
  }
  setTimeout(() => process.exit(code), 3000).unref();
}

main(process.argv.slice(2)).catch(async (e) => {
  console.error(e instanceof CdpmError ? e.message : e);
  await finish(1);
});
