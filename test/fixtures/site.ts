// 통합 테스트용 로컬 페이지 서버.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>테스트 메인</title></head><body>
<h1>테스트 메인</h1><script>window.__pageVar = 1</script>
<label>검색어 <input id="q" type="text" value="기존값"></label>
<label>메모 <input id="memo" type="text"></label>
<button id="go" onclick="document.getElementById('out').textContent='결과: '+document.getElementById('q').value">검색</button>
<p id="out"></p>
<a href="/page2">두번째로 가기</a>
<label><input type="checkbox" id="cb"> 동의</label>
<div style="position:relative;height:60px">
  <button id="under" style="position:absolute;top:0;left:0">가려진 버튼</button>
  <div id="overlay" style="position:absolute;top:0;left:0;width:300px;height:60px;background:rgba(0,0,0,.3)">광고 레이어</div>
</div>
<button id="alertbtn" onclick="alert('안녕하세요')">알림 띄우기</button>
<button onclick="document.getElementById('dlg').textContent = confirm('지울까요?') ? '확인 누름' : '취소 누름'">확인창 띄우기</button>
<button onclick="document.getElementById('dlg').textContent = '입력: ' + prompt('이름은?')">입력창 띄우기</button>
<p id="dlg">알림창 결과 없음</p>
<button id="popup" onclick="window.open('/page2','_blank')">새 창 열기</button>
<iframe src="/frame" title="내부 프레임" style="width:300px;height:80px"></iframe>
<label>크기 <select id="size"><option value="s">작게</option><option value="m">보통</option><option value="l">크게</option></select></label>
<label>배달 시간 <input type="time" id="when"></label>
<label>첨부 <input type="file" id="file"></label>
<button id="api" onclick="fetch('/api/data').then(r=>r.text()).then(t=>document.getElementById('apiout').textContent='API: '+t).catch(()=>document.getElementById('apiout').textContent='API 실패')">API 부르기</button>
<p id="apiout"></p>
</body></html>`,
  '/long': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>긴 페이지</title></head><body>
<h1>긴 페이지</h1>${Array.from({ length: 1500 }, (_, i) => `<p>문단 ${i + 1} 내용입니다 <a href="/page2?i=${i}">링크${i + 1}</a></p>`).join('')}
<button>맨 아래 버튼</button></body></html>`,
  '/cards': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>카드</title>
<style>.card{position:relative;width:300px;padding:10px;border:1px solid #ccc}.card a.stretch{position:absolute;inset:0}</style></head><body>
<div class="card"><h3>카드 기사 제목</h3><p>요약 문장</p><a class="stretch" href="/page2" aria-label="기사 열기"></a></div>
</body></html>`,
  '/xframe': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>교차 프레임</title></head><body>
<h1>교차 프레임</h1><div style="height:1200px">여백</div>
<iframe id="x" title="다른 사이트 프레임" style="width:400px;height:100px"></iframe>
<script>document.getElementById('x').src = 'http://localhost:' + location.port + '/xinner';</script>
</body></html>`,
  '/xblock': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>iframe 막기</title></head><body>
<iframe id="x" width="300" height="80"></iframe>
<script>document.getElementById('x').src = 'http://localhost:' + location.port + '/xtracker';</script>
</body></html>`,
  '/xtracker': `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>추적 iframe
<script>let n = 0; setInterval(() => { new Image().src = '/tracker.png?n=' + (n++) + '&t=' + Date.now(); }, 200);</script>
</body></html>`,
  '/numform': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>숫자 폼</title></head><body>
<form onsubmit="event.preventDefault(); document.getElementById('r').textContent = '제출됨'">
<label>숫자만 <input id="num" oninput="this.value = this.value.replace(/[^0-9]/g, '')"></label>
<label>이름 <input id="nm"></label>
<button>보내기</button></form><p id="r">미제출</p>
</body></html>`,
  '/printpage': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>인쇄</title></head><body>
<button onclick="window.print(); document.getElementById('o').textContent = '인쇄 뒤 이어짐'">인쇄하기</button>
<label>색 <input type="color" id="col" value="#000000"></label>
<p id="o">처음</p>
</body></html>`,
  '/twice': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>두 번 요청</title></head><body>
<button onclick="fetch('/api/hang?slow=1'); setTimeout(() => fetch('/api/hang?n=2').then(r => r.json()).then(d => (document.getElementById('o').textContent = d.n)), 200)">두 번 요청</button><p id="o"></p>
</body></html>`,
  '/xinner': `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>
<label>교차 입력 <input id="i" oninput="document.getElementById('o').textContent='교차 값: '+this.value"></label>
<button onclick="document.getElementById('o').textContent+=' / 교차 눌림'">교차 버튼</button><p id="o">교차 처음</p>
</body></html>`,
  '/spa': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>SPA</title></head><body>
<button id="next" disabled onclick="this.textContent='눌림'">다음</button>
<button onclick="fetch('/api/search?q=' + encodeURIComponent('사과')).then(r => r.json()).then(d => document.getElementById('res').textContent = d.items.length + '개')">검색</button>
<p id="res">결과 없음</p>
<script>setTimeout(() => (document.getElementById('next').disabled = false), 1000)</script>
</body></html>`,
  '/tools': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>도구</title><style>
#menu ul{display:none} #menu:hover ul{display:block} .box{width:120px;height:50px;border:1px solid #333;margin:6px;display:inline-block}</style></head><body>
<div id="menu"><button>상품 메뉴</button><ul><li><a href="#a">숨은 항목</a></li></ul></div>
<div class="box" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','짐')">끌 상자</div>
<div id="dst" class="box" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent='받음: '+event.dataTransfer.getData('text/plain')">놓을 곳</div>
<p><input type="range" min="0" max="100" value="0" aria-label="가격 범위" style="width:300px" oninput="document.getElementById('rv').textContent='값 '+this.value"><span id="rv">값 0</span></p>
<a href="/file.txt">받기</a></body></html>`,
  '/page2': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>두번째</title></head><body>
<h1>두번째 페이지</h1><p>여기는 두번째입니다</p></body></html>`,
  '/frame': `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>
<button onclick="this.textContent='눌림'">프레임 버튼</button></body></html>`,
  '/slow': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>느린 글자</title></head><body>
<script>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<p>늦게 나타남</p>')},800)</script></body></html>`,
};

/** 시험 서버가 받은 요청 수 (요청 막기 확인용) */
export const hits: Record<string, number> = {};

export async function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="cdpm-fixture.txt"' }).end('fixture download');
      return;
    }
    if (path === '/api/search') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q');
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ q, items: [{ name: '사과', price: 1200 }, { name: '풋사과', price: 900 }] })), 300);
      return;
    }
    if (path === '/tracker.png') {
      hits.tracker = (hits.tracker ?? 0) + 1;
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end();
      return;
    }
    if (path === '/api/hang') {
      // slow=1이면 15초 동안 응답하지 않음 (끝나지 않은 같은 주소 요청)
      const slow = new URL(req.url ?? '/', 'http://x').searchParams.get('slow');
      const done = () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n: slow ? 'slow' : 'fast' }));
      if (slow) setTimeout(done, 15_000); else done();
      return;
    }
    if (path === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, n: 42 }));
      return;
    }
    const body = PAGES[path];
    if (!body) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
