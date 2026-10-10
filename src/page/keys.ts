// 키 이름 → CDP Input.dispatchKeyEvent 인자.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ctrl: 'Control', control: 'Control', cmd: 'Meta', meta: 'Meta',
  win: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', space: 'Space', spacebar: 'Space', pgup: 'PageUp', pgdn: 'PageDown',
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function lookup(name: string): KeyDef | undefined {
  const canonical = ALIASES[name.toLowerCase()] ?? Object.keys(NAMED).find((k) => k.toLowerCase() === name.toLowerCase());
  if (canonical) return NAMED[canonical];
  if (name.length === 1) {
    const ch = name;
    const upper = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
    if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    return { key: ch, code: '', keyCode: 0, text: ch };
  }
  return undefined;
}

export interface KeyCombo {
  modifiers: number;
  modifierKeys: KeyDef[];
  main: KeyDef;
}

/** "Control+Shift+A" 같은 조합을 해석한다. */
export function parseCombo(combo: string): KeyCombo | undefined {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (combo.endsWith('++')) parts.push('+');
  if (!parts.length) return undefined;
  const mainName = parts.pop()!;
  let modifiers = 0;
  const modifierKeys: KeyDef[] = [];
  for (const p of parts) {
    const def = lookup(p);
    if (!def || MODIFIER_BITS[def.key] === undefined) return undefined;
    modifiers |= MODIFIER_BITS[def.key];
    modifierKeys.push(def);
  }
  const main = lookup(mainName);
  if (!main) return undefined;
  return { modifiers, modifierKeys, main };
}

export const KNOWN_KEYS = Object.keys(NAMED);

/**
 * macOS의 Chrome은 CDP 키 이벤트만으로는 Cmd+A 같은 편집 단축키를 실행하지 않는다 (메뉴·텍스트 시스템이 처리하므로).
 * 그래서 맥에서는 같은 키 이벤트에 Chrome 편집 명령 이름을 함께 보낸다. 사람이 그 키를 눌렀을 때와 같은 동작이다.
 */
const MAC_COMMANDS: Record<string, string> = {
  'Meta+a': 'selectAll',
  'Meta+z': 'undo',
  'Meta+Shift+z': 'redo',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
  'Meta+ArrowLeft': 'moveToBeginningOfLine',
  'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Meta+Shift+ArrowLeft': 'moveToBeginningOfLineAndModifySelection',
  'Meta+Shift+ArrowRight': 'moveToEndOfLineAndModifySelection',
  'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
};

/** 맥에서 이 조합에 해당하는 Chrome 편집 명령 (없으면 빈 배열). */
export function macCommands(combo: KeyCombo): string[] {
  const mods = (['Alt', 'Control', 'Meta', 'Shift'] as const).filter((m) => combo.modifiers & MODIFIER_BITS[m]);
  const order = ['Meta', 'Control', 'Alt', 'Shift'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const key = combo.main.key.length === 1 ? combo.main.key.toLowerCase() : combo.main.key;
  const cmd = MAC_COMMANDS[[...mods, key].join('+')];
  return cmd ? [cmd] : [];
}

/** 글자 하나를 칠 때의 키 정의. 대문자는 Shift를 함께 누른 것으로 보낸다. 한글 등은 key=글자로 보낸다. */
export function charKey(ch: string): { def: KeyDef; shift: boolean } {
  if (ch === '\n' || ch === '\r') return { def: NAMED.Enter, shift: false };
  if (ch === ' ') return { def: NAMED.Space, shift: false };
  if (/^[A-Z]$/.test(ch)) return { def: { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch }, shift: true };
  if (/^[a-z]$/.test(ch)) return { def: { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch }, shift: false };
  if (/^[0-9]$/.test(ch)) return { def: { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch }, shift: false };
  return { def: { key: ch, code: '', keyCode: 0, text: ch }, shift: false };
}
