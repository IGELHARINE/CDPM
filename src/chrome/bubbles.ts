// Windows 전용: Chrome이 띄운 권한 요청 말풍선("○○에서 다음 권한을 요청합니다" 등)을 찾고 버튼을 누른다.
// 말풍선은 페이지가 아니라 브라우저 화면이라 CDP(스냅샷·스크린샷·클릭)로는 보이지도 눌리지도 않고,
// 이미 뜬 말풍선은 CDP로 권한을 줘도 닫히지 않는다 (실측). 그래서
//  - 찾기: Chrome 본 창에 딸린 작은 창 중 제목에 탭의 사이트 주소가 들어간 것 (EnumWindows, 1ms 미만).
//    번역·비밀번호 저장 말풍선은 제목에 주소가 없어서 걸러지고, Chrome 표시 언어와도 상관없다.
//  - 버튼 읽기·누르기: Windows UI Automation (PowerShell, 말풍선이 있을 때만 부른다).
// 창이 최소화돼 있거나 다른 창에 가려져 있어도 읽고 누를 수 있다 (실측).
import { execFile } from 'node:child_process';
import { readRegistry } from '../registry/store.js';
import { win32 } from '../taskbar/win32.js';

export interface Bubble {
  key: string;
  /** 창 제목 (예: "example.com에서 다음 권한을 요청합니다.") */
  title: string;
  hwnd: unknown;
}

export interface BubbleDetail {
  /** 말풍선 안의 글 (예: "이 기기의 다른 앱 및 서비스에 액세스") */
  texts: string[];
  buttons: string[];
}

/** 탭 주소들에서 말풍선 제목과 맞춰 볼 호스트 이름을 뽑는다. */
export function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname;
      if (h) hosts.add(h);
    } catch {
      // about:blank 등
    }
  }
  return [...hosts];
}

/** 슬롯 Chrome에 떠 있는 권한 요청 말풍선. Windows가 아니거나 창 모드가 아니면 늘 빈 목록. */
export function permissionBubbles(slot: number, hosts: string[]): Bubble[] {
  const w = win32();
  if (!w || !hosts.length) return [];
  const pid = readRegistry().slots[String(slot)]?.pid;
  if (!pid) return [];
  try {
    return w.ownedWindowsOf(pid)
      .filter((x) => (x.visible || x.ownerMinimized) && hosts.some((h) => x.title.includes(h)))
      .map((x) => ({ key: x.key, title: x.title, hwnd: x.hwnd }));
  } catch {
    return [];
  }
}

const UIA_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$e = $A::FromHandle([IntPtr][long]$env:CDPM_BUBBLE_HWND)
$type = { param($t) New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $t) }
$btns = @($e.FindAll('Descendants', (& $type ([Windows.Automation.ControlType]::Button))))
$texts = @($e.FindAll('Descendants', (& $type ([Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
$pressed = $null
if ($env:CDPM_BUBBLE_PRESS) {
  $b = $btns | Where-Object { $_.Current.Name -eq $env:CDPM_BUBBLE_PRESS } | Select-Object -First 1
  if ($b) { $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $pressed = $true } else { $pressed = $false }
}
@{ texts = @($texts); buttons = @($btns | ForEach-Object { $_.Current.Name } | Where-Object { $_ }); pressed = $pressed } | ConvertTo-Json -Compress
`;
const ENCODED = Buffer.from(UIA_SCRIPT, 'utf16le').toString('base64');

function runUia(b: Bubble, press?: string): Promise<BubbleDetail & { pressed: boolean | null }> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], {
      env: { ...process.env, CDPM_BUBBLE_HWND: b.key, CDPM_BUBBLE_PRESS: press ?? '' },
      timeout: 15_000, windowsHide: true, encoding: 'utf8',
    }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(stdout.trim().split('\n').pop() ?? '');
        const arr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
        resolve({ texts: arr(j.texts), buttons: arr(j.buttons), pressed: typeof j.pressed === 'boolean' ? j.pressed : null });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** 같은 말풍선을 매번 다시 읽지 않게 (말풍선 하나에 PowerShell 한 번, 약 0.6초). */
const details = new Map<string, BubbleDetail>();

export async function bubbleDetail(b: Bubble): Promise<BubbleDetail | undefined> {
  const k = `${b.key}|${b.title}`;
  const hit = details.get(k);
  if (hit) return hit;
  try {
    const d = await runUia(b);
    if (details.size > 50) details.clear();
    details.set(k, { texts: d.texts, buttons: d.buttons });
    return details.get(k);
  } catch {
    return undefined;
  }
}

/** 말풍선의 버튼을 이름 그대로 누른다. 없는 이름이면 false. */
export async function pressBubble(b: Bubble, button: string): Promise<boolean> {
  const r = await runUia(b, button);
  details.delete(`${b.key}|${b.title}`);
  return r.pressed === true;
}

/** 머리말·기다리기에 쓰는 한 줄 안내. */
export function bubbleLine(b: Bubble, d?: BubbleDetail): string {
  const what = d?.texts.filter((t) => t !== b.title).join(' / ');
  const buttons = d?.buttons.length ? ` Buttons: ${d.buttons.join(', ')}.` : '';
  return `Chrome permission bubble open: "${b.title}"${what ? ` (${what})` : ''}.${buttons} ` +
    'It is browser UI (not in snapshot/screenshot; page tools can\'t click it) and the page may be stuck until it is answered. Press a button with browser_permission.';
}
