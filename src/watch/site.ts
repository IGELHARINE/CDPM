// 관제 화면에서 탭을 다른 슬롯으로 넘길 때 쓰는 순수 함수들 (Chrome 없이 시험할 수 있다).
// 슬롯은 서로 다른 Chrome(프로필)이라 탭을 통째로 옮길 수는 없다. 받는 슬롯에서 같은 주소를 새로 열고 원래 탭을 닫는다.
// 쿠키·세션은 넘기지 않는다: 받는 슬롯은 자기가 가진 로그인 상태 그대로 그 주소를 연다.

const SECOND_LEVEL = new Set(['co', 'or', 'go', 'ne', 'ac', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu']);

/** 호스트에서 "사이트"(등록 가능한 도메인)를 뽑는다. 예: mail.naver.com → naver.com */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || !h.includes('.')) return h; // IP, localhost
  const p = h.split('.');
  const two = p.length >= 3 && p[p.length - 1].length === 2 && SECOND_LEVEL.has(p[p.length - 2]);
  return p.slice(two ? -3 : -2).join('.');
}

/** 다른 슬롯에서 다시 열 수 있는 주소인지. Chrome 내부 페이지·확장 페이지·blob은 못 연다. */
export function canReopen(url: string): boolean {
  return /^(https?|file|data|blob):/i.test(url) ? !/^blob:/i.test(url) : url === 'about:blank';
}
