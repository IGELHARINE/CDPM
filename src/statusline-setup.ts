// Claude Code 상태줄에 CDPM 슬롯 표시를 켠다. MCP 설치만으로는 상태줄이 바뀌지 않으므로,
// 사용자가 원할 때 이 기능으로 설정 파일에 한 줄을 넣는다. 바꾸기 전 원래 파일은 백업해 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableNodePath } from './paths.js';

export interface SetupPaths {
  claudeSettings: string;
  ccstatusline: string;
}

export function defaultSetupPaths(): SetupPaths {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    claudeSettings: path.join(claudeDir, 'settings.json'),
    ccstatusline: path.join(os.homedir(), '.config', 'ccstatusline', 'settings.json'),
  };
}

/** 상태줄이 부를 명령: 지금 이 cdpm의 node와 cli.js를 그대로 쓴다. */
export function statuslineCommand(): string {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return `"${stableNodePath()}" "${cli}" statusline`;
}

// JSON 파일 안에서는 따옴표가 \" 로 저장되므로 앞의 역슬래시도 허용한다
/** 상태줄을 다시 그리는 주기(초). 슬롯을 켜고 끄는 것은 대화와 상관없이 일어나므로 주기적으로 갱신해야 실시간으로 보인다. */
const REFRESH_SECONDS = 3;

const MARK = /(?:cli\.js|cdpm)\\?["']?\s+statusline(?!-)/;

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 처음 바꿀 때만 원래 파일을 <파일>.before-cdpm 으로 남긴다. */
function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const to = `${file}.before-cdpm`;
  if (!fs.existsSync(to)) fs.copyFileSync(file, to);
  return to;
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cdpm-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 상태줄에 CDPM 표시가 이미 들어가 있는지. */
export function isStatuslineConfigured(p: SetupPaths = defaultSetupPaths()): boolean {
  const claude = readJson(p.claudeSettings);
  const cmd: string = claude?.statusLine?.command ?? '';
  if (MARK.test(cmd)) return true;
  return /ccstatusline/i.test(cmd) && MARK.test(readText(p.ccstatusline));
}

export interface SetupResult {
  state: 'already' | 'claude' | 'ccstatusline' | 'other';
  message: string;
}

export function setupStatusline(p: SetupPaths = defaultSetupPaths(), command = statuslineCommand()): SetupResult {
  if (isStatuslineConfigured(p)) {
    // 이미 켜져 있어도 다시 그리는 주기가 없거나 3초보다 길면 3초로 (예전 버전으로 켠 경우: 대화가 없으면 상태줄이 옛 화면에 머묾)
    const current = readJson(p.claudeSettings);
    if (current?.statusLine && !(current.statusLine.refreshInterval <= REFRESH_SECONDS)) {
      backup(p.claudeSettings);
      writeJson(p.claudeSettings, { ...current, statusLine: { ...current.statusLine, refreshInterval: REFRESH_SECONDS } });
      return { state: 'already', message: `상태줄은 이미 켜져 있었고, ${REFRESH_SECONDS}초마다 다시 그리도록 설정을 더했어요 (새 세션부터).` };
    }
    return { state: 'already', message: '상태줄에 CDPM 슬롯 표시가 이미 켜져 있어요.' };
  }
  const claude = readJson(p.claudeSettings);
  if (fs.existsSync(p.claudeSettings) && !claude) {
    return { state: 'other', message: `${p.claudeSettings} 파일을 읽지 못해서(JSON 형식 오류) 건드리지 않았어요.` };
  }
  const current: string = claude?.statusLine?.command ?? '';

  // 상태줄이 없으면: Claude 설정에 CDPM 상태줄을 넣는다.
  if (!current) {
    const saved = backup(p.claudeSettings);
    writeJson(p.claudeSettings, { ...(claude ?? {}), statusLine: { type: 'command', command, padding: 0, refreshInterval: REFRESH_SECONDS } });
    return {
      state: 'claude',
      message: `Claude Code 상태줄에 CDPM 슬롯 표시를 켰어요 (${p.claudeSettings}).` +
        (saved ? ` 원래 설정은 ${saved}에 백업했어요.` : '') + ' 새 세션부터 보여요.',
    };
  }

  // ccstatusline을 쓰고 있으면: 내용이 있는 마지막 줄 다음 줄에 위젯을 넣는다 (3줄을 다 쓰고 있으면 마지막 줄 끝에).
  if (/ccstatusline/i.test(current)) {
    const cc = readJson(p.ccstatusline);
    if (cc && Array.isArray(cc.lines)) {
      const saved = backup(p.ccstatusline);
      const widget = { id: 'cdpm', type: 'custom-command', commandPath: command, preserveColors: true, timeout: 2000 };
      const lines: unknown[][] = cc.lines.map((l: unknown) => (Array.isArray(l) ? l : []));
      const used = lines.reduce((n, l, i) => (l.length ? i + 1 : n), 0); // 마지막으로 내용이 있는 줄 다음
      if (used < 3) {
        while (lines.length <= used) lines.push([]);
        lines[used] = [widget];
      } else {
        lines[used - 1].push({ id: 'cdpm-sep', type: 'separator' }, widget);
      }
      writeJson(p.ccstatusline, { ...cc, lines });
      // 슬롯 상태가 대화 없이도 바뀌므로, 상태줄이 3초마다 다시 그려지게 한다 (이미 3초 이하면 그대로)
      if (claude?.statusLine && !(claude.statusLine.refreshInterval <= REFRESH_SECONDS)) {
        backup(p.claudeSettings);
        writeJson(p.claudeSettings, { ...claude, statusLine: { ...claude.statusLine, refreshInterval: REFRESH_SECONDS } });
      }
      return {
        state: 'ccstatusline',
        message: `ccstatusline에 CDPM 슬롯 표시 위젯을 추가했어요 (${p.ccstatusline}).` +
          (saved ? ` 원래 설정은 ${saved}에 백업했어요.` : ''),
      };
    }
  }

  // 다른 상태줄 프로그램을 쓰고 있으면 덮어쓰지 않는다.
  return {
    state: 'other',
    message: '이미 다른 상태줄을 쓰고 있어서 바꾸지 않았어요. 그 상태줄에서 아래 명령의 출력을 한 줄 덧붙이면 돼요:\n' + command,
  };
}

/** CDPM이 넣은 상태줄 설정을 뺀다 (ccstatusline 위젯, 또는 CDPM만 쓰는 Claude 상태줄). */
export function removeStatusline(p: SetupPaths = defaultSetupPaths()): string {
  const out: string[] = [];
  const cc = readJson(p.ccstatusline);
  if (cc && Array.isArray(cc.lines)) {
    const lines = cc.lines.map((l: any[]) => (Array.isArray(l) ? l.filter((w) => w?.id !== 'cdpm' && w?.id !== 'cdpm-sep' && !MARK.test(String(w?.commandPath ?? ''))) : l));
    if (JSON.stringify(lines) !== JSON.stringify(cc.lines)) {
      writeJson(p.ccstatusline, { ...cc, lines });
      out.push(`ccstatusline에서 CDPM 위젯을 뺐어요 (${p.ccstatusline}).`);
    }
  }
  const claude = readJson(p.claudeSettings);
  if (claude?.statusLine && MARK.test(String(claude.statusLine.command ?? ''))) {
    const { statusLine: _, ...rest } = claude;
    writeJson(p.claudeSettings, rest);
    out.push(`Claude 상태줄에서 CDPM을 뺐어요 (${p.claudeSettings}).`);
  }
  return out.length ? out.join('\n') : '상태줄에 CDPM 설정이 없어요.';
}
