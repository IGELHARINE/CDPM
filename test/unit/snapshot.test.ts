import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLines, formatAxTree, paginate, subtree, type AXNode, type FrameTrees } from '../../src/page/snapshot.js';

let seq = 0;
type TreeNode = AXNode & { kids: TreeNode[] };
function n(role: string, name = '', children: TreeNode[] = [], extra: Partial<AXNode> = {}): TreeNode {
  return { nodeId: String(++seq), role: { value: role }, name: { value: name }, backendDOMNodeId: 1000 + seq, kids: children, ...extra };
}

/** 트리 → getFullAXTree 형태의 평평한 목록 */
function flat(root: TreeNode): AXNode[] {
  const out: AXNode[] = [];
  const walk = (node: TreeNode, parent?: string) => {
    out.push({ ...node, parentId: parent, childIds: node.kids.map((k) => k.nodeId) });
    node.kids.forEach((k) => walk(k, node.nodeId));
  };
  walk(root);
  return out;
}

describe('스냅샷 변환', () => {
  it('역할, 이름, ref, 값, 상태, 링크 주소(인코딩 풀기)', () => {
    const link = n('link', '두번째', [n('StaticText', '두번째')]);
    const button = n('button', '검색', [n('StaticText', '검색', [n('InlineTextBox', '검색')])]);
    const tree = n('RootWebArea', '메인', [
      n('generic', '', [
        n('heading', '제목', [n('StaticText', '제목')]),
        n('textbox', '검색어', [], { value: { value: '노트북' } }),
        button,
        n('checkbox', '동의', [], { properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: false } }] }),
        link,
      ]),
      n('paragraph', '', [n('StaticText', '본문 글')]),
      n('list', '', []),
    ]);
    const snap = formatAxTree(flat(tree), { hrefs: new Map([[link.backendDOMNodeId!, '/wiki/%EA%B5%AC%EA%B8%80?x=1']]), baseUrl: 'http://a.test/', mainFrameId: 'MAIN' });
    assert.equal(snap.text, [
      '- document "메인"',
      '  - heading "제목" [e1]',
      '  - textbox "검색어" [e2]: "노트북"',
      '  - button "검색" [e3]',
      '  - checkbox "동의" [e4] (checked)',
      '  - link "두번째" [e5] → /wiki/구글?x=1',
      '  - paragraph: "본문 글"',
    ].join('\n'));
    assert.equal(snap.refs.size, 5);
    assert.deepEqual(snap.refs.get('e3'), { backendNodeId: button.backendDOMNodeId, frameId: 'MAIN' });
  });

  it('무시된 노드는 자식을 올리고, iframe은 하위 트리를 붙이며 ref에 프레임을 기억', () => {
    const iframe = n('Iframe', '광고');
    const ignoredWrap = n('generic', '', [n('button', '안쪽')], { ignored: true });
    const payment = n('Iframe', '결제');
    const tree = n('RootWebArea', '', [ignoredWrap, iframe, payment]);
    const sub = flat(n('RootWebArea', '', [n('button', '프레임 버튼')]));
    const frames: FrameTrees = new Map<number, { nodes: AXNode[]; frameId?: string } | 'unsupported'>([[iframe.backendDOMNodeId!, { nodes: sub, frameId: 'F1' }], [payment.backendDOMNodeId!, 'unsupported']]);
    const snap = formatAxTree(flat(tree), { frames, mainFrameId: 'MAIN' });
    assert.match(snap.text, /^- document\n {2}- button "안쪽" \[e1\]\n {2}- iframe "광고"\n {4}- document\n {6}- button "프레임 버튼" \[e2\]\n {2}- iframe "결제" \(읽지 못함\)$/);
    assert.equal(snap.refs.get('e1')!.frameId, 'MAIN');
    assert.equal(snap.refs.get('e2')!.frameId, 'F1');
  });
});

describe('긴 스냅샷 보기', () => {
  const big = ['- document', ...Array.from({ length: 2000 }, (_, i) => `  - link "링크${i + 1}" [e${i + 1}] → /p${i + 1}`)].join('\n');

  it('쪽 나누기: 줄 단위로 끊고 쪽 크기를 넘지 않음', () => {
    const p1 = paginate(big, 1, 5000);
    assert.equal(p1.page, 1);
    assert.ok(p1.pages > 5);
    assert.ok(p1.body.length <= 5000);
    assert.ok(p1.body.startsWith('- document'));
    const last = paginate(big, 999, 5000);
    assert.equal(last.page, last.pages);
    assert.match(last.body, /링크2000/);
    // 모든 쪽을 이으면 원문과 같음
    const all = Array.from({ length: p1.pages }, (_, i) => paginate(big, i + 1, 5000).body).join('\n');
    assert.equal(all, big);
  });

  it('찾기: 맞는 줄과 조상 줄만, 끊긴 곳은 …', () => {
    const text = ['- document', '  - navigation "메뉴"', '    - link "홈" [e1]', '  - main', '    - list', '      - link "날씨 보기" [e2]', '    - text "끝"'].join('\n');
    const r = findLines(text, '날씨');
    assert.equal(r.matches, 1);
    assert.equal(r.body, ['- document', '  …', '  - main', '    - list', '      - link "날씨 보기" [e2]'].join('\n'));
    assert.equal(findLines(text, '없음').matches, 0);
  });

  it('영역: ref 요소와 그 아래만, 들여쓰기는 왼쪽으로 당김', () => {
    const text = ['- document', '  - navigation "메뉴" [e1]', '    - link "홈" [e2]', '    - link "뉴스" [e3]', '  - main', '    - text "본문"'].join('\n');
    assert.equal(subtree(text, 'e1'), ['- navigation "메뉴" [e1]', '  - link "홈" [e2]', '  - link "뉴스" [e3]'].join('\n'));
    assert.equal(subtree(text, 'e99'), undefined);
  });
});
