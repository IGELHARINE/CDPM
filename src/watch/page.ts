// 관제 화면 페이지 (서버가 그대로 내려 주는 HTML 한 장, 외부 파일 없음).
// 슬롯마다 색 구역 하나, 그 안에 탭이 모두 같은 크기의 칸으로 놓인다. 칸을 끌어 다른 슬롯 구역에 놓으면 그 슬롯으로 넘긴다.
import { SLOT_COLORS } from '../slots.js';

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { --bg: #111214; --panel: #1b1d21; --ink: #e9eaec; --muted: #8b9099; --line: #2a2d33; --scroll: #33363d; --scrollHover: #4a4e57; --numPct: 72%; --numTo: #fff; --numShadow: rgba(0,0,0,.6); --shot: #16181b; --side: #15171a; --dim: #757b86; --strong: #fff; --txt: #cfd3da; --pop: #1f2126; --popLine: #383b42; --sep: #33363c; --hover: #33363d; --btn: #26282e; --btnLine: #3b3e46; --toastBg: #f2f3f5; --toastInk: #111; --veil: rgba(0,0,0,.8); font: 13px/1.4 -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); display: flex; flex-direction: column; overflow: hidden; }
/* 밝은 테마 (오른쪽 위 버튼으로 바꾼다) */
body.light { --bg: #f3f4f6; --panel: #ffffff; --ink: #1d2025; --muted: #6b717c; --line: #dde0e5; --scroll: #c6cbd3; --scrollHover: #a9afb9; --numPct: 88%; --numTo: #000; --numShadow: rgba(0,0,0,.12); --shot: #e8eaee; --side: #fafbfc; --dim: #7c828c; --strong: #111; --txt: #33373e; --pop: #ffffff; --popLine: #d5d9df; --sep: #e3e6ea; --hover: #eef0f3; --btn: #f6f7f9; --btnLine: #d5d9df; --toastBg: #1d2025; --toastInk: #fff; --veil: rgba(0,0,0,.35); }
button { font: inherit; color: inherit; }
/* 스크롤 막대: 어두운 바탕에 묻히는 가는 막대 (기본 막대는 밝고 두꺼워서 화면과 패널 사이에 흰 줄처럼 보인다) */
#view, #feed, #ask .box { scrollbar-width: thin; scrollbar-color: var(--scroll) transparent; }
#view::-webkit-scrollbar, #feed::-webkit-scrollbar, #ask .box::-webkit-scrollbar { width: 8px; height: 8px; }
#view::-webkit-scrollbar-track, #feed::-webkit-scrollbar-track, #ask .box::-webkit-scrollbar-track { background: transparent; }
#view::-webkit-scrollbar-thumb, #feed::-webkit-scrollbar-thumb, #ask .box::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 4px; border: 2px solid var(--bg); }
#view::-webkit-scrollbar-thumb:hover, #feed::-webkit-scrollbar-thumb:hover { background: var(--scrollHover); }
/* 슬롯 번호: 배경 없이 슬롯 색 전자시계 숫자만 (슬롯 아이콘과 같은 모양). 묶음 왼쪽 여백에 크게 한 번만 나온다 */
.num { --c: #888; display: inline-flex; align-items: center; color: color-mix(in srgb, var(--c) var(--numPct), var(--numTo)); filter: drop-shadow(0 1px 1.5px var(--numShadow)); cursor: pointer; }
.num svg { height: 44px; width: auto; display: block; }
/* 평소에는 비어 있고, 연결이 끊겼을 때만 글이 나온다 */
/* 연결이 끊겼을 때만 메시지 칸 맨 위에 한 줄 뜬다 */
#state { color: #f59e0b; font-size: 12px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: rgba(245,158,11,.08); }
#state:empty { display: none; }
.opts { display: flex; gap: 4px; align-items: center; }
.opts button { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 5px; padding: 3px 9px; cursor: pointer; }
.opts button.on { border-color: #6b7fb3; color: #fff; background: #2a3550; }
#body { flex: 1; min-height: 0; display: flex; }
#view { flex: 1; min-width: 0; overflow: auto; padding: 14px 16px 40px; }
/* 묶음 = 왼쪽 여백(슬롯 숫자) + 칸들. 여백 폭은 모든 묶음이 같아야 칸 크기가 같아진다 (--gw: 가장 넓은 숫자의 폭) */
.group { --c: #888; display: grid; grid-template-columns: var(--gw, 30px) minmax(0, 1fr); gap: 14px; margin-bottom: 22px; border-radius: 10px; outline: 2px dashed transparent; outline-offset: 5px; min-height: 44px; }
/* 끌어다 놓을 때: 묶음 전체를 칠하지 않고, 탭이 놓일 자리(그 슬롯 칸들의 맨 끝)에만 미리보기 칸을 보여 준다 */
.cell.ghost { pointer-events: none; opacity: .6; border: 2px dashed var(--c); box-shadow: none; animation: none; }
.cell.ghost .shot { filter: saturate(.6); }
.cell.ghost.landing { opacity: .4; }
.empty.hide { display: none; }
/* 탭을 멈추게 하는 것(알림창·권한 요청)은 칸 화면 아래쪽에 떠 있다고만 보여 준다 */
.notice:empty { display: none; }
.notice:has(.jsdlg) { all: unset; }
/* 인쇄 창 칸: 탭이 아니라 그 슬롯에 떠 있는 인쇄 창 하나 */
.head .pr { font-style: normal; font-size: 10px; font-weight: 700; color: color-mix(in srgb, var(--c) var(--numPct), var(--numTo)); background: color-mix(in srgb, var(--c) 20%, transparent); border: 1px solid var(--c); border-radius: 3px; padding: 0 4px; margin-right: 6px; }
.cell.print { border-color: var(--c); cursor: zoom-in; }
.cell.perm { cursor: default; }
/* 크롬이 실제로 그리는 알림창·권한 말풍선 모양 (칸 크기에 맞춰 같은 비율로 줄어든다) */
.shot { container-type: inline-size; }
.jsdlg, .pbub { position: absolute; background: #fff; color: #1f1f1f; border-radius: 0.8em; box-shadow: 0 0.25em 1.2em rgba(0,0,0,.35); font: 400 clamp(6px, 2.3cqw, 14px)/1.45 -apple-system, "Segoe UI", "Apple SD Gothic Neo", sans-serif; text-align: left; pointer-events: none; }
.jsdlg { top: 3%; left: 50%; transform: translateX(-50%); width: min(90%, 32em); padding: 1.3em 1.5em 1.1em; }
.pbub { position: relative; width: min(88%, 26em); margin: 6% auto 0; padding: 1.2em 1.3em 1em; }
.jsdlg .ti, .pbub .ti { font-weight: 600; margin-bottom: 0.7em; }
.jsdlg .ms { white-space: pre-wrap; word-break: break-word; max-height: 9em; overflow: hidden; }
.jsdlg .in { border: 1px solid #747775; border-radius: 0.3em; padding: 0.35em 0.5em; margin-top: 0.8em; min-height: 1.45em; }
.pbub .pl { display: flex; align-items: center; gap: 0.6em; padding: 0.3em 0; }
.pbub .pl i { width: 1.1em; height: 1.1em; border-radius: 50%; background: #e8eaed; box-shadow: inset 0 0 0 0.3em #fff, inset 0 0 0 1em #5f6368; flex: none; }
.jsdlg .bt, .pbub .bt { display: flex; justify-content: flex-end; gap: 0.5em; margin-top: 1.1em; }
.jsdlg .bt span, .pbub .bt span { border: 1px solid #747775; border-radius: 2em; padding: 0.4em 1.2em; color: #0b57d0; font-weight: 500; }
.jsdlg .bt span.p { background: #0b57d0; border-color: #0b57d0; color: #fff; }
.notice { position: absolute; left: 8px; right: 8px; bottom: 8px; background: var(--pop); border: 1px solid var(--popLine); border-left: 3px solid #f59e0b; border-radius: 6px; padding: 7px 9px; box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: none; text-align: left; font-size: 12px; color: var(--txt); }
.notice b { display: block; color: var(--strong); font-size: 11.5px; margin-bottom: 2px; }
.notice .msg { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
.ghead { position: sticky; top: 0; align-self: start; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; color: var(--muted); font-size: 10px; cursor: context-menu; }
.ghead .tag { background: #f59e0b; color: #111; font-weight: 700; font-size: 9px; border-radius: 4px; padding: 0 4px; }
/* 접어 둔 슬롯: 숫자만 흐리게 남는다 (누르면 다시 펼친다) */
.group.folded .num { opacity: .3; }
.group.folded .grid { display: none; }
.group.off .num { color: #666; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); }
.empty { color: var(--muted); font-size: 12px; padding: 14px 2px; }
.cell { --c: #888; margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: zoom-in; min-width: 0; }
.cell.big { grid-column: 1 / -1; cursor: zoom-out; }
.cell.dragging { opacity: .35; }
.cell.busy { opacity: .5; pointer-events: none; }
.cell.fresh { animation: pop .45s ease-out; }
@keyframes pop { from { transform: scale(.8); opacity: 0; } }
.head { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; white-space: nowrap; }
/* 탭 번호(t6 등)는 에이전트가 보고할 때 쓰는 이름이라 남기되, 제목보다 눈에 띄지 않게 작고 흐리게 */
.head b { color: var(--muted); font: 500 11px ui-monospace, Menlo, monospace; order: 3; }
.head .star { color: color-mix(in srgb, var(--c) var(--numPct), var(--numTo)); }
.head .t { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; order: 1; }
.head .m { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; max-width: 50%; order: 2; }
.head .lamp { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; order: 4; }
.head .x { order: 5; flex: none; align-self: center; width: 20px; height: 20px; margin: -3px -6px -3px 0; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--muted); font: 16px/20px system-ui, sans-serif; cursor: pointer; }
.head .x:hover { background: color-mix(in srgb, #ef4444 18%, transparent); color: #ef4444; }
.cell.live .lamp { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.25); }
/* 그 창에서 지금 앞에 보이는 탭에만 별을 붙인다 (숨은 탭에는 아무 표시도 하지 않는다) */
.star { font-style: normal; margin-right: 5px; font-size: 11px; }
.shot { position: relative; aspect-ratio: 16 / 9; background: var(--shot); display: flex; align-items: center; justify-content: center; color: var(--muted); }
/* 창 모양이 칸과 비슷하면 칸을 꽉 채운다 (조금 넘치는 쪽이 잘린다). 많이 다르면(.fit: 세로로 긴 창 등) 잘라 키우지 않고
   전체를 제 비율대로 넣는다: 남는 자리는 검은색이 아니라 칸 바탕색이다. 크게 볼 때는 늘 전체를 보여 준다 */
.shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; pointer-events: none; }
.shot img.fit { object-fit: contain; object-position: center; }
/* 크게 볼 때도 작을 때와 같은 고정 비율(16:9)로 둔다. 페이지 비율대로 늘어나 길쭉해지지 않게, 폭만 넓어진다 */
#side { width: 300px; flex: none; border-left: 1px solid var(--line); display: flex; flex-direction: column; background: var(--side); }
/* 조작 막대를 위에 따로 두지 않고(화면 위가 비어 보인다) 패널 맨 위에 둔다: 한 줄 칸 수, 연결이 끊겼을 때의 알림 */
#foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex: none; }
/* 버튼이 줄 전체를 고르게 채운다 (한쪽에 빈 자리가 남지 않게) */
#foot .opts { flex: 1; }
/* 테두리 없이 글자만: 고른 것만 밝고 굵게 */
#foot .opts button { flex: 1; padding: 3px 0; background: none; border: 0; color: var(--dim); }
#foot .opts button:hover { color: var(--ink); }
#foot .opts button.on { background: none; color: var(--strong); font-weight: 700; }
#foot .opts #theme { flex: 1.2; display: inline-flex; align-items: center; justify-content: center; color: var(--ink); cursor: pointer; }
#foot .opts #theme svg { width: 15px; height: 15px; display: block; }
#feed { flex: 1; overflow: auto; padding: 10px 12px 12px; }
.ev { display: grid; grid-template-columns: 56px 1fr; gap: 0 8px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
/* 왼쪽: 시간, 그 아래 슬롯 번호(전자시계 숫자). 묶음 왼쪽 큰 숫자(44px)의 절반 남짓 크기 */
.ev .meta { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.ev time { color: var(--muted); font-variant-numeric: tabular-nums; }
.ev .chip { display: inline-flex; }
.ev .chip svg { height: 24px; width: auto; }
.ev .body { min-width: 0; }
.ev .who { font-weight: 600; }
.ev .txt { color: var(--txt); white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.none { color: var(--muted); padding: 18px 0; font-size: 12px; }
#empty { padding: 60px 16px; text-align: center; color: var(--muted); }
#menu { position: fixed; z-index: 60; min-width: 230px; max-width: 340px; padding: 5px; border-radius: 8px; background: var(--pop); border: 1px solid var(--popLine); box-shadow: 0 18px 50px rgba(0,0,0,.55); display: none; }
#menu.on { display: block; }
#menu .h { padding: 5px 10px 6px; color: var(--muted); font-size: 11.5px; border-bottom: 1px solid var(--sep); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#menu button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 10px; border: 0; background: transparent; text-align: left; border-radius: 5px; cursor: pointer; }
#menu button:hover { background: var(--hover); }
#menu button i { --c: #888; width: 9px; height: 9px; border-radius: 3px; background: var(--c); flex: none; }
#menu .row { display: flex; align-items: center; gap: 10px; padding: 0 4px 0 10px; }
#menu .row > span { flex: 1; white-space: nowrap; }
#menu .chips { display: flex; flex-wrap: wrap; gap: 2px; }
#menu .chips.grid { display: grid; grid-template-columns: repeat(8, 1fr); padding: 2px; max-height: 60vh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--scroll) transparent; }
#menu button.chip { --c: #888; width: auto; min-width: 30px; justify-content: center; padding: 6px 4px; color: color-mix(in srgb, var(--c) var(--numPct), var(--numTo)); font-weight: 700; font-variant-numeric: tabular-nums; }
#menu .more { margin-left: auto; color: var(--muted); }
#menu hr { border: 0; border-top: 1px solid var(--sep); margin: 4px 0; }
#menu .danger { color: #ff8a80; }
#toast { position: fixed; left: 50%; top: 56px; transform: translateX(-50%); z-index: 70; background: var(--toastBg); color: var(--toastInk); padding: 7px 16px; border-radius: 999px; font-size: 12.5px; box-shadow: 0 10px 30px rgba(0,0,0,.4); opacity: 0; transition: opacity .25s; pointer-events: none; max-width: 80vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#toast.on { opacity: 1; }
#ask { position: fixed; inset: 0; z-index: 65; background: var(--veil); display: none; align-items: center; justify-content: center; padding: 30px; }
#ask.on { display: flex; }
#ask .box { background: var(--pop); border: 1px solid var(--popLine); border-radius: 10px; padding: 18px 20px; width: min(520px, 100%); max-height: 100%; overflow: auto; }
#ask h3 { margin: 0 0 10px; font-size: 15px; }
#ask p { margin: 0 0 12px; color: var(--txt); }
#ask ul { margin: 0 0 12px; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
#ask .q { margin-bottom: 14px; }
#ask .q button, #ask .foot button { display: block; width: 100%; text-align: left; padding: 9px 12px; margin-top: 6px; border-radius: 7px; border: 1px solid var(--btnLine); background: var(--btn); cursor: pointer; }
#ask .q button:hover, #ask .foot button:hover { border-color: #8b90a0; }
#ask .q button.sel { border-color: var(--strong); background: var(--hover); }
#ask .q small { display: block; color: var(--muted); font-size: 11.5px; margin-top: 2px; }
#ask .foot { display: flex; gap: 8px; }
#ask .foot button { text-align: center; margin: 0; }
#ask .foot .go { background: var(--strong); color: var(--bg); border-color: var(--strong); font-weight: 600; }
`;

const JS = `
const TOKEN = __TOKEN__, COLORS = __COLORS__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colorOf = (n) => COLORS[(n - 1) % COLORS.length];
// 슬롯 번호는 슬롯 아이콘과 같은 전자시계(7세그먼트) 숫자로 그린다
const LIT = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };
function seg(n) {
  const w = 12, h = 20, t = 2.8, g = .35, lh = w - t - g * 2, lv = (h - t) / 2 - g * 2, q = (h - t) / 4, text = String(n);
  const S = { a: [1, w / 2, t / 2, lh], g: [1, w / 2, h / 2, lh], d: [1, w / 2, h - t / 2, lh], f: [0, t / 2, t / 2 + q, lv], b: [0, w - t / 2, t / 2 + q, lv], e: [0, t / 2, h / 2 + q, lv], c: [0, w - t / 2, h / 2 + q, lv] };
  const poly = ([hz, cx, cy, len], x) => (hz ? [[cx - len / 2, cy], [cx - len / 2 + t / 2, cy - t / 2], [cx + len / 2 - t / 2, cy - t / 2], [cx + len / 2, cy], [cx + len / 2 - t / 2, cy + t / 2], [cx - len / 2 + t / 2, cy + t / 2]] : [[cx, cy - len / 2], [cx + t / 2, cy - len / 2 + t / 2], [cx + t / 2, cy + len / 2 - t / 2], [cx, cy + len / 2], [cx - t / 2, cy + len / 2 - t / 2], [cx - t / 2, cy - len / 2 + t / 2]]).map((p) => (p[0] + x).toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
  // 꺼진 세그먼트도 옅게 깔아 준다: "1"처럼 막대 두 개만 켜지는 숫자도 전자시계 숫자로 읽힌다
  let x = 0, on = '', off = '';
  for (const ch of text) { for (const k of 'abcdefg') { const pg = '<polygon points="' + poly(S[k], x) + '"/>'; if (LIT[ch].includes(k)) on += pg; else off += pg; } x += w + 3.5; }
  return '<svg viewBox="0 0 ' + (x - 3.5).toFixed(2) + ' ' + h + '" fill="currentColor"><g opacity=".32">' + off + '</g>' + on + '</svg>';
}

const q = new URLSearchParams(location.search);
let slots = [], frames = new Map(), msgs = new Map(), clientId = '';
let pick = new Set((q.get('slots') || '').split(',').map(Number).filter(Boolean));   // 비어 있으면 전부
const remember = (k, v) => { try { localStorage.setItem('cdpm-watch-' + k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem('cdpm-watch-' + k); } catch { return null; } };
let cols = Number(q.get('cols')) || Number(recall('cols')) || 4, drag = null, fresh = new Set(), known = null, big = null;
// 접어 둔 슬롯 (숫자만 남고 칸은 숨는다. 접어 둔 동안은 그 슬롯의 화면을 받지 않는다)
const folded = new Set();
const listed = () => slots.filter((s) => !pick.size || pick.has(s.no));
const shown = () => listed().filter((s) => !folded.has(s.no));
const liveNow = (t) => t.last && Date.now() - Date.parse(t.last.at) < 12000;
const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 5 ? 'now' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDPM-Watch': TOKEN }, body: JSON.stringify(body) });
  return r.json();
}
let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3500); }

// 탭은 늘 탭 번호 순서(서버가 정해 준 순서)로 놓는다
// 탭은 탭 번호 순. 다만 크게 본 탭은 그 슬롯 묶음 안에서 맨 위로 올린다 (칸을 꽉 차게 보려고 눌렀으니 위에서 바로 보이게).
const order = (s) => {
  const items = s.tabs.map((t, i) => ({ t, i }));
  const bi = big ? items.findIndex((x) => s.no + ':' + x.t.targetId === big) : -1;
  if (bi > 0) items.unshift(items.splice(bi, 1)[0]);
  return items;
};
function meta(k, t) {
  return t.last ? esc(t.last.agent) + ' ' + esc(t.last.action) + ' ' + ago(t.last.at) : '';
}
const STAR = '<i class="star" title="front tab of its window">★</i>';
// 탭을 멈추게 하는 것 (알림창·권한 요청·응답 없음): 떠 있다는 것과 그 내용만 보여 준다 (답은 브라우저 창에서)
const DIALOG_NAME = { alert: 'Alert', confirm: 'Confirm', prompt: 'Prompt', beforeunload: 'Leave this page?' };
// 크롬이 실제로 그리는 모양대로: 페이지 위쪽 가운데 하얀 창, "<주소> 내용:", 메시지, 확인·취소 (눌리지는 않는다: 답은 브라우저 창에서)
const KO = /^ko/i.test(navigator.language);
const L = KO ? { says: (h) => h + ' 내용:', ok: '확인', cancel: '취소', leaveT: '사이트에서 나가시겠습니까?', leaveM: '변경사항이 저장되지 않을 수 있습니다.', leave: '나가기' }
  : { says: (h) => h + ' says', ok: 'OK', cancel: 'Cancel', leaveT: 'Leave site?', leaveM: 'Changes you made may not be saved.', leave: 'Leave' };
function chromeDialog(t) {
  const d = t.dialog;
  let host = '';
  try { const u = new URL(t.url); host = /^https?:$/.test(u.protocol) ? u.host : ''; } catch { /* about:blank 등 */ }
  const btn = (x, primary) => '<span' + (primary ? ' class="p"' : '') + '>' + esc(x) + '</span>';
  if (d.type === 'beforeunload') return '<div class="jsdlg"><div class="ti">' + esc(L.leaveT) + '</div><div>' + esc(L.leaveM) + '</div><div class="bt">' + btn(L.leave, true) + btn(L.cancel) + '</div></div>';
  return '<div class="jsdlg">' + (host ? '<div class="ti">' + esc(L.says(host)) + '</div>' : '') + '<div class="ms">' + esc(d.message || '') + '</div>'
    + (d.type === 'prompt' ? '<div class="in">' + esc(d.defaultPrompt || '') + '</div>' : '')
    + '<div class="bt">' + btn(L.ok, true) + (d.type === 'alert' ? '' : btn(L.cancel)) + '</div></div>';
}
function notice(t) {
  if (t.dialog) return chromeDialog(t);
  // 관제가 붙기 전에 뜬 알림창은 Chrome이 알려 주지 않는다 (실측). 내용을 모르므로 따로 상자를 띄우지 않는다
  return '';
}
// 칸 제목: 앞 탭 별표, 인쇄 창이면 앞에 Print
const titleHtml = (t) => (t.front ? STAR : '') + (t.print ? '<i class="pr">Print</i>' : '') + esc(t.title || t.url);
// Chrome 권한 요청 말풍선: 슬롯에 따로 한 칸 (화면 대신 말풍선 내용)
function bubbleCell(s, b) {
  const texts = (b.texts || []).filter((x) => x !== b.title);
  // macOS는 창 제목이 "example.com의 권한 요청: 내 위치 확인"처럼 내용까지 담는다 → 제목에서 내용 부분은 떼어 한 번만 보여 준다
  const cut = b.title.lastIndexOf(': ');
  const head = cut > 0 && texts.includes(b.title.slice(cut + 2)) ? b.title.slice(0, cut) : b.title;
  // 크롬 권한 말풍선 모양: 제목, 권한 한 줄(아이콘), 크롬이 단 버튼 이름 그대로 (눌리지는 않는다)
  const buttons = (b.buttons || []).filter((x) => !/^(닫기|close)$/i.test(x));
  return '<figure class="cell print perm" style="--c:' + s.color + '" data-b="' + esc(b.key) + '"><div class="head"><span class="t"><i class="pr">Permission</i>' + esc(head) + '</span></div>'
    + '<div class="shot"><div class="pbub"><div class="ti">' + esc(head) + '</div>' + texts.map((x) => '<div class="pl"><i></i>' + esc(x) + '</div>').join('')
    + (buttons.length ? '<div class="bt">' + buttons.map((x) => '<span>' + esc(x) + '</span>').join('') + '</div>' : '') + '</div></div></figure>';
}
function cell(s, t, i) {
  const k = s.no + ':' + t.targetId, f = frames.get(k);
  return '<figure class="cell ' + (liveNow(t) ? 'live ' : '') + (big === k ? 'big ' : '') + (fresh.has(k) ? 'fresh' : '') + (t.print ? ' print' : '') + '" draggable="' + (t.print ? 'false' : 'true') + '" style="--c:' + s.color + '" data-k="' + k + '"><div class="head"><span class="t" title="' + esc(t.url) + '">' + titleHtml(t) + '</span><b>' + (t.print ? '' : t.id || '#' + (i + 1)) + '</b><span class="m">' + meta(k, t) + '</span><i class="lamp"></i>' + (t.print ? '' : '<button class="x" title="Close tab" aria-label="Close tab">×</button>') + '</div><div class="shot">' + (f ? '<img src="data:image/jpeg;base64,' + f + '" alt="">' : '…') + '<div class="notice">' + notice(t) + '</div></div></figure>';
}
function ghead(s) {
  const flags = [s.running ? '' : 'off', s.headless ? 'headless' : '', s.proxy ? 'proxy' : ''].filter(Boolean);
  return '<div class="ghead" data-s="' + s.no + '"><span class="num" style="--c:' + s.color + '" title="slot ' + s.no + (s.running ? ' · ' + s.tabs.length + ' tabs' : ' · off') + '">' + seg(s.no) + '</span>' + flags.map((f) => '<span>' + f + '</span>').join('') + (s.paused ? '<span class="tag">PAUSED</span>' : '') + '</div>';
}
// 칸 구성 (이게 같으면 칸을 다시 만들지 않는다)
let drawnSig = '';
const layoutSig = () => JSON.stringify([cols, big, [...folded], [...pick], slots.map((s) => [s.no, s.running, !!s.paused, !!s.headless, !!s.proxy, s.tabs.map((t) => t.targetId), (s.bubbles || []).map((b) => b.key + (b.texts ? '+' : ''))])]);
function patchCells() {
  for (const s of slots) for (const t of s.tabs) {
    const k = s.no + ':' + t.targetId, el = document.querySelector('.cell[data-k="' + k + '"]');
    if (!el) continue;
    const tt = el.querySelector('.t'), html = titleHtml(t);
    if (tt.innerHTML !== html) tt.innerHTML = html;
    if (tt.title !== t.url) tt.title = t.url;
    const m = el.querySelector('.m'), mh = meta(k, t);
    if (m.innerHTML !== mh) m.innerHTML = mh;
    const nt = el.querySelector('.notice'), nh = notice(t);
    if (nt && nt.dataset.h !== nh) { nt.dataset.h = nh; nt.innerHTML = nh; }
    el.classList.toggle('live', !!liveNow(t));
  }
}
function render() {
  drawnSig = layoutSig();
  // 모든 묶음이 같은 칸 수와 같은 여백 폭을 쓴다 → 칸 크기가 전부 같다
  const L = listed();
  const most = shown().reduce((a, s) => Math.max(a, s.tabs.length), 0);
  const n = cols || Math.max(1, Math.ceil(Math.sqrt(most)));
  const digits = L.reduce((a, s) => Math.max(a, String(s.no).length), 1);
  const gw = Math.max(44, Math.round((digits * 12 + (digits - 1) * 3.5) / 20 * 44));
  $('view').innerHTML = L.map((s) => '<div class="group ' + (folded.has(s.no) ? 'folded ' : '') + (s.running ? '' : 'off') + '" data-s="' + s.no + '" style="--c:' + s.color + ';--gw:' + gw + 'px">' + ghead(s) + '<div class="grid" style="--n:' + n + '">' + ((order(s).map((x) => cell(s, x.t, x.i)).join('') + (s.bubbles || []).map((b) => bubbleCell(s, b)).join('')) || '<div class="empty">' + (s.running ? 'No tabs. Drop a tab here to move it to this slot.' : 'Slot is off.') + '</div>') + '</div></div>').join('') || '<div id="empty">No slots to show. Launch a slot and it appears here.</div>';
  document.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', Number(b.dataset.c) === cols));
  fresh.clear();
  if (measure()) tell();   // 칸 수나 보는 슬롯이 바뀌어 칸 크기가 달라졌으면 알린다
}
function renderSide() {
  // 새 메시지가 위에 쌓이는데, 아래로 스크롤해 읽던 중이면 통째로 다시 그릴 때 맨 위로 튕긴다.
  // 맨 위(최신)를 보고 있었으면 그대로 위에 두고, 아래로 내려가 있었으면 보던 자리를 유지한다.
  const feed = $('feed'), atTop = feed.scrollTop <= 2, prevTop = feed.scrollTop, prevH = feed.scrollHeight;
  const nums = new Set(shown().map((s) => s.no));
  const chip = (n) => '<span class="chip num" style="--c:' + colorOf(n) + '" title="slot ' + n + '">' + seg(n) + '</span>';
  // 에이전트끼리 주고받은 메시지만 보여 준다 (관제 화면이 보낸 'user (watch)' 안내는 사람이 한 일이라 뺀다)
  const all = [...msgs.entries()].filter(([n]) => nums.has(n)).flatMap(([n, items]) => items.map((m) => ({ ...m, slot: n }))).filter((m) => m.from !== 'user (watch)').sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100);   // 가장 최근 100개만
  // 멈춤·다시 시작 알림은 에이전트에게 주는 긴 지시문이라 사람이 볼 짧은 말로 바꾼다
  const short = (m) => /^\[paused\]/.test(m.text) ? 'Slot ' + m.slot + ' paused' : /^\[resumed\]/.test(m.text) ? 'Slot ' + m.slot + ' resumed' : m.text;
  const html = all.map((m) => '<div class="ev"><div class="meta"><time>' + clock(m.at) + '</time>' + chip(m.slot) + '</div><div class="body"><div><span class="who">' + esc(m.from) + '</span>' + (m.to ? ' → ' + esc(m.to) : '') + '</div><div class="txt">' + esc(short(m)) + '</div></div></div>').join('') || '<div class="none">No agent messages yet.</div>';
  feed.innerHTML = html;
  if (!atTop) feed.scrollTop = prevTop + (feed.scrollHeight - prevH);
}
// 칸이 화면에서 실제로 차지하는 폭(실제 픽셀)을 같이 알린다 → 서버가 그 크기에 맞는 그림을 받는다
let tileW = 0, viewW = 0;
function measure() {
  const el = document.querySelector('.cell:not(.big) .shot'), dpr = window.devicePixelRatio || 1;
  const w = el ? Math.round(el.clientWidth * dpr) : tileW, bw = Math.round($('view').clientWidth * dpr);
  // 몇 픽셀 달라진 정도로는 다시 알리지 않는다
  if (Math.abs(w - tileW) < 40 && Math.abs(bw - viewW) < 40) return false;
  tileW = w; viewW = bw; return true;
}
const tell = () => { measure(); return clientId && api('/api/view', { id: clientId, slots: [...pick], skip: [...folded], focus: big, idle: document.hidden, w: tileW, bw: viewW }); };
let resizeTimer; addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (measure()) tell(); }, 300); });
// 관제 화면이 다른 탭·창 뒤로 가려지면 화면 받기를 쉬게 한다 (안 보는 동안 Chrome에 일을 시키지 않는다)
document.addEventListener('visibilitychange', () => tell());

// ── 서버에서 오는 것 ──
let es;
function connect() {
  es = new EventSource('/events?token=' + TOKEN + '&slots=' + [...pick].join(','));
  es.addEventListener('hello', (e) => { clientId = JSON.parse(e.data).id; $('state').textContent = ''; tell(); });
  es.addEventListener('state', (e) => {
    slots = JSON.parse(e.data);
    const now = new Set(slots.flatMap((s) => s.tabs.map((t) => s.no + ':' + t.targetId)));
    if (known) for (const k of now) if (!known.has(k)) fresh.add(k);   // 새로 열린 탭은 칸이 생길 때 한 번 튄다
    known = now;
    for (const k of frames.keys()) if (!now.has(k)) frames.delete(k);
    // 끄는 중에는 칸을 다시 만들지 않는다 (끌던 칸이 사라져 놓기가 꼬이지 않게). 놓거나 그만두면 그때 다시 그린다
    if (drag || (!fresh.size && layoutSig() === drawnSig)) { patchCells(); if (drag) laterRender = true; } else render();
    renderSide();
  });
  es.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data), k = f.slot + ':' + f.id;
    frames.set(k, f.data);
    const el = document.querySelector('.cell[data-k="' + k + '"] .shot');
    // 첫 화면이면 '…' 글자만 지우고 그림을 안내(.notice) 앞에 넣는다 (안내는 남긴다)
    if (el) { let img = el.querySelector('img'); if (!img) { for (const n of [...el.childNodes]) if (n.nodeType === 3) n.remove(); img = el.insertBefore(document.createElement('img'), el.firstChild); } img.src = 'data:image/jpeg;base64,' + f.data; }
  });
  es.addEventListener('messages', (e) => { const m = JSON.parse(e.data); msgs.set(m.slot, m.items); renderSide(); });
  es.onerror = () => { $('state').textContent = 'reconnecting…'; };
}
// 그림이 들어올 때마다 그 창의 모양을 보고 채울지(비슷함) 전체를 넣을지(많이 다름) 정한다
$('view').addEventListener('load', (e) => { const i = e.target; if (i.tagName !== 'IMG' || !i.naturalHeight) return; const r = i.naturalWidth / i.naturalHeight / (16 / 9); i.classList.toggle('fit', r < 0.85 || r > 1.18); }, true);
// 2초마다 칸 머리의 작은 글(누가 언제 조작했는지)만 새로 쓴다
setInterval(() => {
  for (const s of slots) for (const t of s.tabs) { const k = s.no + ':' + t.targetId, el = document.querySelector('.cell[data-k="' + k + '"]'); if (el) { el.querySelector('.m').innerHTML = meta(k, t); el.classList.toggle('live', !!liveNow(t)); } }
}, 2000);

// ── 한 줄 칸 수 (패널 맨 위) ──
// 한 줄 칸 수 (고른 값은 이 브라우저에 기억), 밝은/어두운 테마
$('foot').onclick = (e) => {
  const c = e.target.closest('[data-c]');
  if (c) { cols = Number(c.dataset.c); remember('cols', String(cols)); render(); }
  if (e.target.closest('#theme')) { const light = !document.body.classList.contains('light'); document.body.classList.toggle('light', light); remember('theme', light ? 'light' : 'dark'); }
};
document.body.classList.toggle('light', recall('theme') === 'light');
// 슬롯 숫자를 누르면 그 슬롯을 접고 편다
function fold(no, only) {
  if (only) { const others = listed().filter((s) => s.no !== no); const allFolded = others.every((s) => folded.has(s.no)); for (const s of others) allFolded ? folded.delete(s.no) : folded.add(s.no); folded.delete(no); }
  else folded.has(no) ? folded.delete(no) : folded.add(no);
  tell(); render(); renderSide();
}

// ── 크게 보기: 칸을 누르면 그 자리에서 한 줄을 다 차지하고, 그 탭만 빠르고 크게 받는다 ──
function zoom(k) { big = big === k ? null : k; tell(); render(); if (big) document.querySelector('.cell.big')?.scrollIntoView({ block: 'nearest' }); }
$('view').addEventListener('click', (e) => {
  const x = e.target.closest('.cell .x'); if (x) { e.stopPropagation(); const c = x.closest('.cell'), k = c.dataset.k; c.classList.add('busy'); return void api('/api/tab', { slot: Number(k.split(':')[0]), targetId: k.slice(k.indexOf(':') + 1), action: 'close' }).then((r) => { if (!r.ok) { c.classList.remove('busy'); toast(r.message || 'Failed'); } }, () => c.classList.remove('busy')); } const num = e.target.closest('.ghead .num'); if (num) return fold(Number(num.closest('.ghead').dataset.s)); const t = e.target.closest('.cell'); if (t?.dataset.k) zoom(t.dataset.k); });

// ── 다른 슬롯으로 넘기기 ──
function dialog(title, text, notes, questions, buttons) {
  return new Promise((resolve) => {
    const answers = {};
    const box = $('ask').querySelector('.box');
    box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '')
      + (questions || []).map((qu) => '<div class="q" data-q="' + qu.id + '"><p>' + esc(qu.text) + '</p>' + qu.options.map((o) => '<button data-v="' + o.value + '">' + esc(o.label) + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</button>').join('') + '</div>').join('')
      + (notes?.length ? '<ul>' + notes.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
      + '<div class="foot">' + buttons.map((b, i) => '<button data-b="' + b.value + '" class="' + (b.primary ? 'go' : '') + '">' + esc(b.label) + '</button>').join('') + '</div>';
    $('ask').classList.add('on');
    box.onclick = (e) => {
      const v = e.target.closest('[data-v]'), b = e.target.closest('[data-b]');
      if (v) { const id = v.closest('.q').dataset.q; answers[id] = v.dataset.v; v.closest('.q').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === v)); if (v.dataset.v === 'no') { $('ask').classList.remove('on'); resolve(null); } }
      if (b) { if (b.dataset.b === 'go' && (questions || []).some((qu) => !answers[qu.id])) return toast('Choose an option first'); $('ask').classList.remove('on'); resolve(b.dataset.b === 'cancel' ? null : { button: b.dataset.b, answers }); }
    };
  });
}
// 탭을 다른 슬롯으로 넘긴다: 받는 슬롯에 같은 주소를 열고 원래 탭을 닫는다. 쿠키·로그인은 넘기지 않는다 (받는 슬롯이 가진 상태 그대로).
async function move(k, to) {
  const from = Number(k.split(':')[0]), targetId = k.slice(k.indexOf(':') + 1);
  if (from === to) return;
  const el = document.querySelector('.cell[data-k="' + k + '"]'); el?.classList.add('busy');
  try {
    const r = await api('/api/move', { from, targetId, to });
    if (r.status !== 'moved') return dialog('Not moved', r.message, r.notes, null, [{ value: 'cancel', label: 'OK', primary: true }]);
    toast(r.message);
    // 액티비티 기록은 서버가 짧게 남긴다 (여기서 긴 안내를 또 쌓지 않는다)
  } finally { el?.classList.remove('busy'); }
}

$('view').addEventListener('dragstart', (e) => { const t = e.target.closest('.cell'); if (!t) return; drag = t.dataset.k; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', drag); });
// 놓일 자리 미리보기: 끌고 있는 칸을 본뜬 반투명 칸을 받을 슬롯 칸들의 맨 끝에 하나만 둔다
let ghostAt = null, laterRender = false;
const afterDrag = () => { if (laterRender) { laterRender = false; render(); } };
function clearGhost() {
  document.querySelectorAll('.cell.ghost:not(.landing)').forEach((el) => el.remove());
  document.querySelectorAll('.empty.hide').forEach((el) => el.classList.remove('hide'));
  ghostAt = null;
}
function showGhost(z) {
  if (ghostAt === z && z.isConnected && z.querySelector('.cell.ghost')) return;
  clearGhost();
  const grid = z.querySelector('.grid'), src = document.querySelector('.cell[data-k="' + drag + '"]');
  if (!grid || !src) return;
  const g = src.cloneNode(true);
  g.className = 'cell ghost';
  g.removeAttribute('data-k'); g.removeAttribute('draggable');
  g.style.setProperty('--c', getComputedStyle(z).getPropertyValue('--c'));
  grid.querySelector('.empty')?.classList.add('hide');
  grid.append(g);
  ghostAt = z;
}
addEventListener('dragend', () => { drag = null; clearGhost(); document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')); afterDrag(); });
// 관제 화면 밖에 놓거나 다른 것을 놓아도 끌던 상태를 지운다
addEventListener('drop', () => { if (drag) setTimeout(() => { drag = null; clearGhost(); afterDrag(); }, 0); });
for (const root of [$('view')]) {
  root.addEventListener('dragover', (e) => {
    if (!drag) return;
    const z = e.target.closest('.group');
    if (!z || Number(z.dataset.s) === Number(drag.split(':')[0]) || z.classList.contains('off')) return clearGhost();
    e.preventDefault();
    showGhost(z);
  });
  root.addEventListener('drop', async (e) => {
    const z = e.target.closest('.group'); if (!z || !drag || !e.dataTransfer?.types.includes('text/plain') || e.dataTransfer.getData('text/plain') !== drag) return;
    e.preventDefault();
    const k = drag; drag = null;
    // 옮기는 동안 미리보기 칸을 그 자리에 남겨 둔다 (진짜 칸이 생기면 지운다)
    const g = z.querySelector('.cell.ghost'); g?.classList.add('landing'); ghostAt = null;
    try { await move(k, Number(z.dataset.s)); } finally { g?.remove(); document.querySelectorAll('.empty.hide').forEach((el) => el.classList.remove('hide')); afterDrag(); }
  });
}

// ── 오른쪽 버튼 메뉴 ──
function openMenu(html, e, onPick) {
  const m = $('menu'); m.innerHTML = html; m.classList.add('on');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
  m.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; m.classList.remove('on'); onPick(b.dataset); };
}
async function act(path, body) { const r = await api(path, body); toast(r.message || (r.ok ? 'Done' : 'Failed')); }
// 탭을 다른 슬롯으로 넘긴다 (받는 슬롯에 주소를 열고 원래 탭은 닫는다)
const SEND = [['move', 'Move to']];
const chips = (a, label, list) => list.map((x) => '<button class="chip" data-a="' + a + '" data-s="' + x.no + '" style="--c:' + x.color + '" title="' + label + ' slot ' + x.no + '">' + x.no + '</button>').join('');
$('view').addEventListener('contextmenu', (e) => {
  const head = e.target.closest('.ghead'); if (head) { e.preventDefault(); return slotMenu(Number(head.dataset.s), e); }
  const el = e.target.closest('.cell'); if (!el) return;
  e.preventDefault();
  if (el.classList.contains('print')) return;   // 인쇄 창 칸에는 탭 메뉴가 없다
  const k = el.dataset.k, no = Number(k.split(':')[0]), id = k.slice(k.indexOf(':') + 1), s = slots.find((x) => x.no === no), t = s.tabs.find((x) => x.targetId === id);
  const others = slots.filter((x) => x.no !== no && x.running);
  openMenu('<div class="h">slot ' + no + ' · ' + esc(t.id || '') + ' · ' + esc(t.title || t.url) + '</div>'
    + (s.headless ? '' : '<button data-a="front">Bring to front in its window</button>') + '<button data-a="reload">Reload</button><button data-a="back">Back</button><button data-a="copy">Copy URL</button>'
    // 슬롯으로 보내는 동작은 종류마다 한 줄뿐이다. 슬롯이 몇 개 없으면 그 줄에 번호를 바로 늘어놓고,
    // 많으면 줄을 눌렀을 때 번호 고르는 판이 따로 뜬다 (슬롯이 99개여도 이 메뉴는 세 줄 그대로다).
    + (others.length ? '<hr>' + SEND.map(([a, label]) => others.length <= 6 ? '<div class="row"><span>' + label + '</span><div class="chips">' + chips(a, label, others) + '</div></div>' : '<button data-a="pick" data-k="' + a + '">' + label + '<span class="more">›</span></button>').join('') : '')
    + '<hr><button data-a="close" class="danger">Close tab</button>', e, pick);
  function pick(d) {
    if (d.a === 'pick') { const [, label] = SEND.find((x) => x[0] === d.k); return void setTimeout(() => openMenu('<div class="h">' + label + ' · ' + esc(t.title || t.url) + '</div><div class="chips grid">' + chips(d.k, label, others) + '</div>', e, pick)); }
    if (d.a === 'copy') return navigator.clipboard.writeText(t.url).then(() => toast('URL copied'), () => toast('Copy failed'));
    if (d.a === 'move') return move(k, Number(d.s));
    act('/api/tab', { slot: no, targetId: id, action: d.a });
  }
});
function slotMenu(no, e) {
  const s = slots.find((x) => x.no === no); if (!s) return;
  e.stopPropagation?.();
  openMenu('<div class="h">slot ' + no + '</div>' + (s.running ? '<button data-a="' + (s.paused ? 'resume' : 'pause') + '">' + (s.paused ? 'Resume (let agents act)' : 'Pause (stop agents)') + '</button><button data-a="newtab">New tab…</button>' : '') + '<button data-a="fold">' + (folded.has(no) ? 'Expand' : 'Collapse') + '</button><button data-a="only">' + (listed().every((x) => x.no === no || folded.has(x.no)) ? 'Expand all slots' : 'Collapse the other slots') + '</button>' + (s.running ? '<hr><button data-a="close" class="danger">Close slot…</button>' : ''), e, async (d) => {
    if (d.a === 'close') {
      const a = await dialog('Close slot ' + no + '?', 'Its browser and all ' + s.tabs.length + ' tab(s) close. Logins stay in the profile; typed input on pages is lost.', null, null, [{ value: 'close', label: 'Close slot', primary: true }, { value: 'cancel', label: 'Cancel' }]);
      if (a?.button === 'close') act('/api/slot', { slot: no, action: 'close' });
      return;
    }
    if (d.a === 'fold') return fold(no);
    if (d.a === 'only') return fold(no, true);
    if (d.a === 'newtab') { const url = prompt('URL to open in slot ' + no, 'https://'); if (!url) return; return act('/api/slot', { slot: no, action: 'newtab', url }); }
    act('/api/slot', { slot: no, action: d.a });
  });
}
addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('menu').classList.remove('on'); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('menu').classList.remove('on'); if (big) zoom(big); } });
connect(); renderSide();
`;

export function watchPage(token: string): string {
  const js = JS.replace('__TOKEN__', JSON.stringify(token)).replace('__COLORS__', JSON.stringify(SLOT_COLORS));
  return `<!doctype html>
<html lang="en" translate="no"><head><meta charset="utf-8"><meta name="google" content="notranslate"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CDPM Watch</title><style>${CSS}</style></head>
<body>
<div id="body"><div id="view"></div>
  <div id="side"><div id="foot"><div class="opts"><button id="theme" title="Light / dark"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg></button><button data-c="1">1</button><button data-c="2">2</button><button data-c="3">3</button><button data-c="4">4</button><button data-c="5">5</button><button data-c="6">6</button><button data-c="7">7</button><button data-c="8">8</button></div></div><div id="state"></div><div id="feed"></div></div></div>
<div id="menu"></div><div id="toast"></div>
<div id="ask"><div class="box"></div></div>
<script>${js}</script>
</body></html>`;
}
