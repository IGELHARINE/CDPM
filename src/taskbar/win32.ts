// Windows 전용: Chrome 창에 슬롯별 AppUserModelID·아이콘을 지정해 작업표시줄 버튼을 분리한다.
import { createRequire } from 'node:module';

export interface WindowAppProps {
  appId: string;
  relaunchCommand: string;
  displayName: string;
  iconPath: string;
}

export interface Win32 {
  chromeWindowsOf(pid: number): unknown[];
  windowKey(hwnd: unknown): string;
  getAppId(hwnd: unknown): string | undefined;
  setAppProps(hwnd: unknown, props: WindowAppProps): boolean;
  setWindowIcon(hwnd: unknown, iconPath: string): void;
}

let instance: Win32 | null | undefined;

/** Windows가 아니거나 koffi를 못 불러오면 null. */
export function win32(): Win32 | null {
  if (instance !== undefined) return instance;
  if (process.platform !== 'win32') return (instance = null);
  try {
    instance = load();
  } catch {
    instance = null;
  }
  return instance;
}

function load(): Win32 {
  const require = createRequire(import.meta.url);
  const koffi = require('koffi');

  const user32 = koffi.load('user32.dll');
  const shell32 = koffi.load('shell32.dll');
  const ole32 = koffi.load('ole32.dll');

  const GUID = koffi.struct('CDPM_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
  const PROPERTYKEY = koffi.struct('CDPM_PROPERTYKEY', { fmtid: GUID, pid: 'uint32' });
  const PROPVARIANT_STR = koffi.struct('CDPM_PROPVARIANT_STR', {
    vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', p: 'str16', pad: 'uint64',
  });

  const EnumProc = koffi.proto('bool __stdcall CDPM_EnumProc(void *hwnd, intptr lp)');
  const EnumWindows = user32.func('bool __stdcall EnumWindows(CDPM_EnumProc *cb, intptr lp)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32 cmd)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *buf, int max)');
  const LoadImageW = user32.func('void * __stdcall LoadImageW(void *inst, str16 name, uint32 type, int cx, int cy, uint32 flags)');
  const SendMessageTimeoutW = user32.func('intptr __stdcall SendMessageTimeoutW(void *hwnd, uint32 msg, uintptr w, void *l, uint32 flags, uint32 timeout, void *result)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
  const CoInitializeEx = ole32.func('long __stdcall CoInitializeEx(void *r, uint32 c)');
  const PropVariantClear = ole32.func('long __stdcall PropVariantClear(void *pv)');
  const SHGetPropertyStoreForWindow = shell32.func('long __stdcall SHGetPropertyStoreForWindow(void *hwnd, CDPM_GUID *riid, _Out_ void **ppv)');

  const GetValueProto = koffi.proto('long __stdcall CDPM_GetValue(void *self, CDPM_PROPERTYKEY *key, void *pv)');
  const SetValueProto = koffi.proto('long __stdcall CDPM_SetValue(void *self, CDPM_PROPERTYKEY *key, CDPM_PROPVARIANT_STR *pv)');
  const CommitProto = koffi.proto('long __stdcall CDPM_Commit(void *self)');
  const ReleaseProto = koffi.proto('uint32 __stdcall CDPM_Release(void *self)');

  CoInitializeEx(null, 2); // COINIT_APARTMENTTHREADED

  const IID_IPropertyStore = { d1: 0x886d8eeb, d2: 0x8cf2, d3: 0x4446, d4: [0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99] };
  const FMTID_AUM = { d1: 0x9f4c2855, d2: 0x9f79, d3: 0x4b39, d4: [0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3] };
  const PID = { relaunchCommand: 2, relaunchIcon: 3, relaunchName: 4, appId: 5 };
  const pkey = (pid: number) => ({ fmtid: FMTID_AUM, pid });
  const VT_LPWSTR = 31;

  const iconCache = new Map<string, { big: unknown; small: unknown }>();

  function withStore<T>(hwnd: unknown, fn: (store: unknown, call: (idx: number, proto: unknown, ...args: unknown[]) => any) => T): T | undefined {
    const out = [null];
    if (SHGetPropertyStoreForWindow(hwnd, IID_IPropertyStore, out) < 0 || !out[0]) return undefined;
    const store = out[0];
    const vtbl = koffi.decode(store, 'void *');
    const call = (idx: number, proto: unknown, ...args: unknown[]) =>
      koffi.call(koffi.decode(vtbl, idx * 8, 'void *'), proto, store, ...args);
    try {
      return fn(store, call);
    } finally {
      call(2, ReleaseProto);
    }
  }

  return {
    chromeWindowsOf(pid) {
      const found: unknown[] = [];
      const cb = koffi.register((hwnd: unknown) => {
        const p = [0];
        GetWindowThreadProcessId(hwnd, p);
        if (p[0] === pid && IsWindowVisible(hwnd) && !GetWindow(hwnd, 4 /* GW_OWNER */)) {
          const buf = Buffer.alloc(512);
          const n = GetClassNameW(hwnd, buf, 256);
          if (buf.toString('utf16le', 0, n * 2) === 'Chrome_WidgetWin_1') found.push(hwnd);
        }
        return true;
      }, koffi.pointer(EnumProc));
      try {
        EnumWindows(cb, 0);
      } finally {
        koffi.unregister(cb);
      }
      return found;
    },

    windowKey(hwnd) {
      return String(koffi.address(hwnd));
    },

    getAppId(hwnd) {
      return withStore(hwnd, (_store, call) => {
        const pv = Buffer.alloc(24);
        if (call(5, GetValueProto, pkey(PID.appId), pv) < 0) return undefined;
        try {
          if (pv.readUInt16LE(0) !== VT_LPWSTR) return undefined;
          return koffi.decode(pv, 8, 'str16') as string;
        } finally {
          PropVariantClear(pv);
        }
      });
    },

    setAppProps(hwnd, props) {
      const ok = withStore(hwnd, (_store, call) => {
        const set = (pid: number, value: string) =>
          call(6, SetValueProto, pkey(pid), { vt: VT_LPWSTR, r1: 0, r2: 0, r3: 0, p: value, pad: 0 });
        // 실행 관련 속성을 먼저, ID는 마지막에.
        set(PID.relaunchCommand, props.relaunchCommand);
        set(PID.relaunchIcon, `${props.iconPath},0`);
        set(PID.relaunchName, props.displayName);
        set(PID.appId, props.appId);
        return call(7, CommitProto) >= 0;
      });
      return ok === true;
    },

    setWindowIcon(hwnd, iconPath) {
      let icons = iconCache.get(iconPath);
      if (!icons) {
        const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10;
        const big = LoadImageW(null, iconPath, IMAGE_ICON, GetSystemMetrics(11 /* SM_CXICON */), GetSystemMetrics(12), LR_LOADFROMFILE);
        const small = LoadImageW(null, iconPath, IMAGE_ICON, GetSystemMetrics(49 /* SM_CXSMICON */), GetSystemMetrics(50), LR_LOADFROMFILE);
        icons = { big, small };
        iconCache.set(iconPath, icons);
      }
      // 창이 응답하지 않아도 멈추지 않도록 시간 제한을 둔다.
      const WM_SETICON = 0x80, SMTO_ABORTIFHUNG = 2;
      if (icons.big) SendMessageTimeoutW(hwnd, WM_SETICON, 1, icons.big, SMTO_ABORTIFHUNG, 500, null);
      if (icons.small) SendMessageTimeoutW(hwnd, WM_SETICON, 0, icons.small, SMTO_ABORTIFHUNG, 500, null);
    },
  };
}
