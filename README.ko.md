# CDPM — CDP Manager

[English README](README.md)

> **설치를 부탁받았다면 (Claude·AI 에이전트용)** 아래 순서대로 하세요.
> 1. Node.js 22 이상과 Google Chrome이 있는지 확인해요. 없으면 사용자에게 알리고 멈춰요.
> 2. `npm install -g cdpm@latest` 를 실행해요 (이미 설치돼 있어도 그대로 실행 → 최신으로 업데이트).
> 3. `cdpm install` 을 실행해요 (`cdpm`을 못 찾으면 `node "$(npm root -g)/cdpm/dist/cli.js" install`). Claude Code 등록과 상태줄·규칙·서브에이전트·권한 설정을 한 번에 해요. 예전에 git으로 받아 등록해 둔 것도 새 위치로 바꿔요.
> 4. Chrome 슬롯을 켜지 말고, 질문하거나 내부 설명을 덧붙이지 마세요. 성공하면 "CDPM <버전> 설치 완료. Claude Code를 다시 시작하면 쓸 수 있어요." 한 줄만 답해요 (버전은 `cdpm --version`). 실패하면 어느 단계에서 왜 실패했는지만 말해요.

**Chrome 1~30번 슬롯**을 CDP(Chrome DevTools Protocol)로 띄워 두고, 여러 Claude 세션과 서브에이전트가 번호만으로 같은 브라우저를 나눠 쓰고 조종하게 해 주는 MCP 서버예요. *"3번 켜줘"*, *"3번 봐줘"* 한마디면 돼요.

- **순수 CDP**: Playwright, Puppeteer, 우회 패치를 쓰지 않아요. 디버깅 포트만 연 일반 Chrome에 진짜 입력 이벤트를 보내요.
- **번호 슬롯**: 슬롯 N은 CDP 포트 `14049 + N`을 써요 (1번 = 14050 … 30번 = 14079). 흔히 쓰이는 9222와 부딪히지 않도록 고른 구간이고, 이 구간을 다른 프로그램이 쓰면 환경변수 `CDPM_PORT_BASE`로 시작 번호를 옮길 수 있어요. 슬롯마다 프로필 폴더가 따로 있어서 로그인이 슬롯별로 유지돼요. 범위 밖 포트는 다루지 않아요.
- **켜 달라고 할 때만 켜요**: 꺼진 슬롯은 다른 도구가 절대 켜지 않아요. 번호 없이 "켜줘"라고 하면 비어 있는 가장 작은 번호로 켜요.
- **슬롯마다 작업표시줄 버튼**: 슬롯 색 브라우저 창 모양에 번호가 들어간 아이콘으로 버튼이 따로 떠요. 작업표시줄이 아이콘을 줄여 그리는 방식을 미리 보정해서 24px에서도 또렷해요 (Windows 글꼴로 그려서 저장소에 글꼴 파일이 없어요). 창 제목도 "3번"으로 보여요 (Chrome 창 이름 기능이라 페이지는 알 수 없어요).
- **여러 에이전트용 설계**: 모든 도구에 `slot`을 명시해요. 탭마다 누가 열었고 누가 마지막으로 건드렸는지 기록하고, 남이 최근에 쓴 탭을 조작하면 막지 않고 알려줘요. 같은 탭에 동시에 온 명령은 줄 세워 하나씩 실행해요.
- **에이전트끼리 대화**: `slot_send` / `slot_inbox`. 안 읽은 메시지는 모든 도구 결과 맨 위에도 붙어요.
- **상태줄**: `cdpm statusline`이 떠 있는 슬롯을 슬롯 색 번호와 담당 이름으로 출력해요 (`CDPM  1 NAVER  2 Daum`: 마지막으로 조작한 탭의 제목).
- **사용자 PC를 건드리지 않아요**: 창 크기·위치·뷰포트·확대 비율을 바꾸지 않고, 알림창을 처리하지 않고, OS 창(파일 선택·메일 앱 등)을 띄우는 동작은 거부해요. 아래 "하지 않는 것"을 보세요.

> Windows 11과 macOS에서 쓸 수 있어요. 슬롯별 아이콘은 Windows는 작업표시줄, macOS는 Dock에 들어가요 (아래 "macOS" 참고).

## 필요한 것

- Node.js 22 이상
- Google Chrome (자동으로 찾아요. Windows: 레지스트리 `App Paths` → 표준 설치 폴더. macOS: `/Applications` → `~/Applications` → Spotlight)

## 설치

```sh
npm install -g cdpm
cdpm install
```

`cdpm install`이 Claude Code에 CDPM을 등록하고, 상태줄·병렬 처리 규칙·전용 서브에이전트·권한 허용 목록까지 한 번에 설정해요. 끝나면 Claude Code를 다시 시작하세요.

### 직접 받아서 (개발용)

```sh
git clone https://github.com/IGELHARINE/CDPM.git
cd CDPM
npm install
node dist/cli.js install
```

### 업데이트

```sh
npm install -g cdpm@latest
```

그다음 Claude Code를 다시 시작하면 돼요. 직접 받았으면 클론 폴더에서 `git fetch origin && git reset --hard origin/main` 하고 `npm install`. MCP 등록과 상태줄 설정은 그대로 둬도 돼요. 버전은 `node dist/cli.js --version`으로 확인하고, 바뀐 점은 [CHANGELOG.md](CHANGELOG.md)에 있어요.

Claude에게는 "CDPM 업데이트해줘"라고 하면 돼요.

### 설치하면 자동으로 되는 것

MCP 서버가 처음 켜질 때 한 번, 따로 설정하지 않아도 이렇게 해 둬요 (원래 파일은 `.before-cdpm`으로 백업):
- Claude Code 상태줄에 슬롯 표시 켜기 (3초마다 갱신)
- 사용자 `CLAUDE.md`에 "여러 슬롯에 다른 일을 시키면 슬롯마다 서브에이전트로 병렬, 결과물도 나눠 쓰기" 규칙 넣기 (Claude는 MCP 안내보다 사용자 지시를 더 잘 따라요)
- CDPM 전용 서브에이전트 `cdpm-browser` 설치 (`~/.claude/agents/`): CDPM 도구와 파일 쓰기만 갖고 `CLAUDE.md`를 읽지 않아서 빨리 시작해요. 실측으로 슬롯 3개 병렬 작업이 중간값 28.7초 → 20.6초, 사용량 약 37% 감소. 모델과 노력 수준은 메인과 같아요. CDPM을 등록한 이름(예: `cdpm`)을 찾아서 맞춰 만들어요.
- Claude Code 권한 허용 목록(`settings.json`의 `permissions.allow`)에 CDPM 도구 전체(`mcp__cdpm`) 넣기: 자동 모드의 보안 검사가 입력(`browser_type`·`browser_fill` 등)을 막아 작업이 멈추지 않게 해요. 대신 Claude가 CDPM으로 하는 입력·클릭(메일 보내기, 글쓰기 등)을 매번 묻지 않아요.
- 서브에이전트는 동시에 20개까지라, 슬롯 20개가 넘으면 나눠 띄우라고 안내해요 (늘리려면 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).

되돌리기는 `cdpm unsetup`, 처음부터 안 하게 하려면 환경변수 `CDPM_NO_AUTO_SETUP=1`. 한 번 한 뒤에는 직접 지운 설정을 다시 넣지 않아요.

### 상태줄만 다시 설정

`cdpm install`(과 서버가 처음 켜질 때)이 이미 켜 둬요. 상태줄만 다시 하려면 `cdpm statusline-setup`. 상태줄이 없으면 Claude 설정에 넣고, ccstatusline을 쓰면 위젯을 추가하고, 다른 상태줄을 쓰면 바꾸지 않고 덧붙일 명령만 알려줘요. 원래 파일은 `.before-cdpm`으로 백업해요.

## 사용법

> 3번 켜줘 → 네이버로 가줘
> 하나 켜줘 (번호 없음 → 비어 있는 가장 작은 슬롯)
> 3번 헤드리스로 켜줘 (창 모드인지 헤드리스인지 말하지 않으면 Claude가 먼저 물어봐요)
> 서브에이전트 A는 1번, B는 2번 써
> 둘 다 5번 써. A는 가격 조사, B는 리뷰 수집. 서로 얘기하면서 해

### 모든 결과의 모양

```
[3번] 탭 3개 · 2번 탭 [t7]에서 실행함
  1. [t1]     네이버 메인       naver.com           연 사람: (외부)
> 2. [t7] ·앞 쿠팡 노트북 검색  coupang.com/np/...  연 사람: 가격비교  마지막: 가격비교 클릭 (방금)
  3. [t9]     상품 리뷰         coupang.com/vp/...  연 사람: 리뷰수집  마지막: 리뷰수집 스크롤 (12초 전)
[주의] 이 탭 [t7]은 리뷰수집이 8초 전에 입력했어요. 같이 쓰는 중이면 slot_send로 알려 주세요.
새 메시지 1개 (여기서 읽음 처리됨 — slot_inbox에는 다시 나오지 않아요)
  리뷰수집 (5초 전): 나 [t9]에서 리뷰 보고 있어. [t7]은 너 써.
---
(도구 본래 결과)
```

- `>` 이번에 실행한 탭, `·앞` 그 창에서 지금 화면 앞에 보이는 탭 (창이 여러 개면 창마다 하나)
- 탭 번호는 CDPM이 탭을 처음 본 순서이고, `t7` 같은 ID는 탭이 살아 있는 동안 바뀌지 않아요.

### 탭 규칙

| 상황 | 동작 |
|---|---|
| 탭 1개 | 그 탭 |
| 이 에이전트가 이전에 쓴(또는 새로 연) 탭이 있음 | 그 탭 |
| 처음 + 보기 도구 | 앞에 보이는 탭 |
| 처음 + 조작 도구 | `tab`을 지정할 때까지 실행하지 않음 |

### 뒤에 있는 탭

뒤에 있는 탭도 탭을 바꾸지 않고 읽고, 조작하고, 캡처할 수 있어요. Chrome은 뒤 탭을 다시 그리지 않기 때문에, 조작·캡처하는 그 순간에만 `Emulation.setFocusEmulationEnabled`를 켜서 그리게 하고 끝나면 바로 꺼요. 사용자 화면(탭 전환, 창)은 바뀌지 않아요.

### 긴 페이지

`browser_snapshot`은 위에서부터 1쪽(약 1.2만 자)만 보여주고 끝에 "1/8쪽 · 다음: page=2"를 붙여요.
- `page=2`로 이어 보면 쪽 머리에 위쪽 맥락이 붙고, ref 번호는 쪽이 달라도 같아요.
- `find="글자"`는 그 글자가 들어간 줄(띄어쓰기 무시)과 위쪽 맥락, 바로 아래 두 줄을 보여줘요.
- `ref="e40"`은 그 요소 아래만 보여줘요.
- 글 내용은 `browser_text`가 더 짧아요.

같은 요소는 페이지가 바뀌기 전까지 같은 ref 번호를 유지해요. 새 번호는 에이전트마다 탭과 상관없이 겹치지 않게 발급돼서, 다른 탭이나 예전 페이지의 ref를 쓰면 항상 거부돼요.

## 도구

모든 도구는 `slot`(1~30)과 `agent`(내 표시 이름)를 받아요. 조작 도구는 `tab`, `summary`(지금 하는 일 한 줄, browser_status에 표시), `read`도 받아요. `read: "text" | "snapshot" | "changes"`를 넣으면 조작 뒤 화면이 같은 결과에 바로 붙어서 따로 읽으러 갈 필요가 없어요. `changes`는 직전 스냅샷 대비 새로 생기거나 사라진 줄만 보여줘서 가장 짧아요 (클릭 결과 확인용).

| 도구 | 하는 일 |
|---|---|
| `browser_status` | 떠 있는 슬롯, 탭, 연 사람, 마지막 행동, 요약, 알림창 |
| `browser_launch` | 슬롯 켜기 (사용자가 켜 달라고 할 때만). `slot` 생략 시 비어 있는 가장 작은 번호. 여러 개는 `slots`(번호 목록)나 `count`(개수)로 한 번에 작은 번호부터 켜요. `url`(모두 같은 주소)이나 `urls`(슬롯마다)로 켜자마자 시작 페이지를 열어요. 창 모드(보임)·헤드리스(안 보임)는 사용자가 정해요: 말하지 않았으면 Claude가 먼저 물어봐요 (`headless` 없이 부르면 꺼진 슬롯은 켜지 않아요). `headless: true`면 `--headless`만 추가. `proxy`/`proxies`는 사용자가 프록시를 써 달라고 할 때만 넣어요: `주소:포트`, `http://아이디:비번@주소:포트`, `socks5://...`, `주소:포트:아이디:비번`. 넣지 않으면 프록시 관련 인자는 하나도 붙지 않아요. 아이디·비밀번호가 있는 프록시는 그 슬롯 전용 중계 프로그램이 인증을 붙여 주고, 그 Chrome이 꺼지면 같이 꺼져요 |
| `browser_close` | 정상 종료 (프로필 유지) |
| `browser_tabs` / `browser_tab_new` / `browser_tab_close` / `browser_tab_select` | 탭 목록 / 새 탭(뒤에서 열림, ID 반환) / 닫기 / 앞으로 가져오기(사용자가 원할 때만) |
| `browser_snapshot` | 접근성 트리 텍스트 + `[e12]` ref. `page` / `find` / `ref` |
| `browser_text` | 본문 글자 (main/article 우선, `ref`로 요소만, `page`로 이어보기) |
| `browser_screenshot` | 보이는 화면 PNG (뒤 탭도). 전체 페이지 캡처는 없음 |
| `browser_navigate` / `browser_back` | 이동 / 뒤로 (로딩까지 대기, 느린 서버는 오류가 아니라 "아직 로딩 중") |
| `browser_click` | ref를 진짜 마우스로 클릭. 가려져 있으면 알려줌, 새 탭이 열리면 알려줌, 폼 검증에 걸리면 이유를 알려줌 |
| `browser_type` | 글자마다 진짜 키 이벤트로 입력 (`clear`, `submit`, `fast`). 입력 후 실제 값 확인. 날짜·시간 칸은 형식 확인 후 값 지정 |
| `browser_fill` | 같은 페이지의 입력칸 여러 개를 차례로 채우고, 원하면 `submit`("Enter" 또는 버튼 ref). 실패·페이지 바뀜·알림창이면 그 자리에서 멈춤 |
| `browser_forward` / `browser_reload` | 앞으로 / 새로고침 (Chrome 새로고침 그대로, `ignore_cache`) |
| `browser_hover` | 진짜 마우스를 요소 위에 올리기 (마우스를 올려야 열리는 메뉴) |
| `browser_drag` | 진짜 마우스로 끌어 놓기: 드래그 앤 드롭·슬라이더·순서 바꾸기. 놓을 곳은 `to`(ref)·`to_text`(글자)·`dx`/`dy`. HTML 드래그도 OS 드래그 없이 처리. `draggable` 요소에도 ref가 붙어요 |
| `browser_download_wait` | 다운로드가 끝날 때까지 기다리고 저장된 파일 경로 돌려주기 (다운로드 폴더는 사용자 Chrome 설정 그대로) |
| `browser_pdf` | 지금 페이지를 PDF로 저장 (경로를 안 주면 다운로드 폴더에 제목으로) |
| `browser_upload` | 파일 올리기: 파일 칸 ref에 바로 넣거나, "첨부" 버튼을 클릭한 뒤(OS 파일 창은 CDPM이 가로채서 사용자 화면에 안 뜸) ref 없이 넣기 |
| `browser_select` | `<select>` 드롭다운: 포커스 후 키로 이동 (Windows는 화살표 키, macOS는 항목 앞글자 입력. 진짜 이벤트, 목록 창 없음) |
| `browser_press_key` | `Enter`, `Tab`, `Control+A`(macOS는 `Meta+A`) 등 (복사·붙여넣기 키는 거부) |
| `browser_scroll` | ref로 스크롤 또는 정확히 `dy`픽셀 (결과에 위치 A → B) |
| `browser_wait` | 글자(본문·제목)가 나타날 때까지 / `network_idle` / N초 |
| `browser_eval` | JavaScript 실행 (isolated world: DOM은 보이지만 페이지 전역 변수는 안 보임) |
| `browser_network` / `browser_network_detail` | 요청 목록(최근 500개, 30분) / 헤더·보낸 데이터·응답 본문 |
| `browser_block` | 주소 패턴으로 요청 막기·해제 (그 세션이 살아 있는 동안만, 다른 에이전트에게도 표시) |
| `slot_send` / `slot_inbox` | 에이전트에게 메시지 (받는 쪽 슬롯 번호로, 다른 슬롯 담당에게도) / 받기 (`wait`: 오는 즉시 0.1초 안에 돌아옴, 최대 600초). `browser_wait` 중에 메시지가 오면 기다리기가 바로 멈춰요 |

서브에이전트는 부모 세션의 MCP 프로세스를 같이 써요. 그래서 **서브에이전트마다 `agent` 이름을 따로 주세요.** 여러 슬롯에 각각 다른 일을 시키면("3개 띄워서 네이버, 다음, 구글 뉴스") Claude가 기본으로 슬롯마다 서브에이전트를 띄워 병렬로 처리해요. 하나씩 돌아가며 하지 않아요.

## 상태줄

`cdpm statusline`은 한 줄을 출력하고 약 0.1초 만에 끝나요 (로컬 기록부와 켜진 슬롯 포트의 탭만 빠르게 확인). 상태줄 켜기를 하면 3초마다 다시 그려요.

```
CDPM  1 NAVER  2 쿠팡  3
```

켜진 슬롯을 번호 순서로 슬롯 색 번호로 보여줘요. 슬롯마다 마지막으로 조작한 탭의 페이지 제목이 보여요 (에이전트 이름은 넣지 않아요. 빈 탭·새 탭만 남으면 번호만). 켜고 끄기, 작업관리자에서 강제 종료, Chrome 창을 직접 닫는 것(Windows)·Cmd+Q(맥)도 다음 갱신 때 바로 반영돼요. 제목은 그 탭의 지금 제목이에요. 터미널 폭에 맞춰서, 넘치면 제목을 점점 짧게 → 번호만 → 그래도 넘치면 `+N`으로 줄여요 (ccstatusline이 알려 주는 폭 기준). 하나도 없으면 흐린 회색으로 `CDPM  -`를 보여요.

`cdpm install`이나 `cdpm statusline-setup`으로 켜요 (위 "상태줄 켜기"). 직접 넣으려면:

- **ccstatusline**: *Custom Command* 위젯에 `"C:\Program Files\nodejs\node.exe" "C:\경로\CDPM\dist\cli.js" statusline` (preserve colors 켜기)
- **기본 상태줄**: `~/.claude/settings.json`의 `statusLine.command`에 같은 명령

## CLI

```
cdpm                                MCP 서버 실행 (stdio)
cdpm launch [슬롯...]                슬롯 켜기 (여러 개면 작은 번호부터, 번호 없으면 비어 있는 가장 작은 슬롯)
cdpm launch --headless [슬롯...]     창 없이 켜기
cdpm close <슬롯...> | --all         정상 종료
cdpm purge <슬롯>                    꺼진 슬롯의 프로필(로그인 정보) 삭제
cdpm status                         슬롯 현황
cdpm statusline                     상태줄용 한 줄
cdpm statusline-setup               Claude Code 상태줄에 슬롯 표시 켜기 (원래 설정 백업)
```

## macOS

- 슬롯 실행·조작·네트워크·에이전트 대화·상태줄 등 기능은 Windows와 같아요.
- 슬롯마다 Dock 아이콘이 Windows와 같은 슬롯 색·번호 아이콘으로 바뀌어요. Chrome의 CDP 명령 `Browser.setDockTile`을 써서, 앱을 복사하거나 서명을 바꾸지 않아요. CDPM 밖에서 Chrome이 다시 켜지면 기본 아이콘으로 돌아가고, CDPM이 다음에 켜거나 붙을 때 다시 넣어요. 이 코드는 macOS에서만 돌아요.
- 맥 방식대로, 창을 닫아도(빨간 X, Cmd+W) 슬롯은 남아요. 상태줄에는 마지막으로 쓴 탭 제목이 계속 보이고, Cmd+Q로 Chrome을 끝내면 슬롯도 끝나고 상태줄에서 빠져요. (Windows는 마지막 창을 닫으면 슬롯이 끝나요.)
- macOS Chrome은 키 이벤트만으로는 `Cmd+A` 같은 편집 단축키가 동작하지 않아서, `Meta+A`(전체 선택)·`Meta+Z`(되돌리기)·`Meta+←/→`·`Option+←/→` 등은 같은 키 이벤트에 Chrome 편집 명령을 함께 보내요. 사람이 그 키를 눌렀을 때와 같은 동작이에요.
- `<select>`는 화살표 키를 누르면 macOS 목록 창이 떠서, 항목 앞글자를 쳐서 골라요. 앞글자가 같은 항목이 먼저 있어 고르지 못하면 값을 직접 넣고 알려줘요.

## 저장 위치

Windows `%LOCALAPPDATA%\cdpm\`, macOS `~/Library/Application Support/cdpm/` (환경변수 `CDPM_HOME`으로 바꿀 수 있어요)

| 경로 | 내용 |
|---|---|
| `registry.json` | 슬롯, 탭, 연 사람·마지막 행동, 요약, 요청 막기 규칙 |
| `messages\<슬롯>.jsonl` | 슬롯별 메시지 (1000줄 넘으면 최근 500줄) |
| `profiles\<슬롯>\` | 슬롯별 Chrome 프로필 |
| `icons\<슬롯>.ico` | 작업표시줄 아이콘 |
| `config.json` | 선택: `{"chromePath": "...", "extraArgs": []}` |

## CDPM이 하지 않는 것 / 막는 것

- User-Agent·지문 변경, 기기 에뮬레이션, 페이지 스크립트 주입, Chrome 패치를 하지 않아요.
- 실행 인자는 `--remote-debugging-port`, `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, `--window-name=N번`뿐이에요 (헤드리스 요청 시 `--headless` 추가). 헤드리스 Chrome은 User-Agent에 `HeadlessChrome`이 그대로 찍혀요.
- 창 크기·위치·상태, 뷰포트, 확대 비율을 바꾸지 않아요. 페이지가 클릭 때문에 전체 화면이 되면 바로 해제해요.
- `Runtime.enable`을 쓰지 않고, 판단용 스크립트는 전부 isolated world에서 실행해요.
- 알림창(alert/confirm/prompt)을 수락하거나 닫지 않아요. 떠 있으면 알리기만 해요.
- 거부하는 동작: `mailto:`·`tel:`·앱 전용 주소 클릭/이동(다른 프로그램 실행), `<select>` 클릭(목록 창), `Ctrl+C/X/V`·`Shift+Insert`(사용자 클립보드)
- 파일 응답으로 이동해서 다운로드가 시작되면 파일 이름과 함께 알려줘요 (Chrome 기본 다운로드 폴더에 저장돼요).

## 검증

- 단위 테스트 52개, 통합 테스트 30개 (`npm test`, `npm run test:integration` — 테스트 포트 29222~로 진짜 Chrome 사용)
- 서브에이전트 15명이 슬롯 30개를 동시에 쓰는 실사용 테스트: 테스트 전후로 창 30개 위치·크기·상태, 탭 52개 뷰포트(`innerWidth×innerHeight`), 확대 비율이 모두 그대로임을 확인

## 라이선스

MIT
