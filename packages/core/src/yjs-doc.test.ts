/**
 * BoardScene ↔ Y.Doc 往返镜像测试（用 node:test 跑，无三方测试框架）。
 *
 * 跑法：
 *   pnpm --filter @board/core build
 *   node --test packages/core/dist/yjs-doc.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { BoardScene, Element, Style } from './types.js';
import { sceneToYDoc, yDocToScene, elementToYMap, yMapToElement } from './yjs-doc.js';

const STYLE: Style = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'none',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  cornerRadius: 8,
  fontFamily: 'hand',
  fontSize: 20,
};

const META = {
  id: 'el_x',
  x: 0, y: 0, width: 100, height: 60,
  angle: 0,
  z: 'a0',
  parentId: null,
  locked: false,
  state: 'committed' as const,
  autoPlaced: false,
  style: STYLE,
  createdBy: 'u_local',
  updatedBy: 'u_local',
  createdAt: '2026-05-23T10:00:00.000Z',
  updatedAt: '2026-05-23T10:00:00.000Z',
};

/** 构造覆盖 10 类元素的 BoardScene。 */
function makeFullScene(): BoardScene {
  const elements: Element[] = [
    { ...META, id: 'el_draw', type: 'draw',
      points: [[0, 0], [10, 5], [20, 10]], pressures: [0.5, 0.7, 0.6] },
    { ...META, id: 'el_shape', type: 'shape',
      shape: 'rectangle', label: { text: '矩形', fontSize: 18 } },
    { ...META, id: 'el_shape_nolbl', type: 'shape',
      shape: 'ellipse', label: null },
    { ...META, id: 'el_conn', type: 'connector',
      start: { elementId: 'el_shape', anchor: 'right', point: [0, 0] },
      end: { elementId: null, anchor: 'auto', point: [100, 50] },
      startArrow: 'none', endArrow: 'arrow',
      routing: 'orthogonal',
      waypoints: [[10, 10], [20, 20]],
      label: { text: '连线' } },
    { ...META, id: 'el_text', type: 'text',
      markdown: '# 标题\n\n正文', autoWidth: false, editMode: 'preview' },
    { ...META, id: 'el_file', type: 'file',
      path: 'rA/foo.md', mime: 'text/markdown', size: 1234,
      displayMode: 'card', previewable: true, version: 1 },
    { ...META, id: 'el_folder', type: 'folder',
      path: 'rA/sub', expanded: true, viewMode: 'list' },
    { ...META, id: 'el_region', type: 'region',
      path: 'rA', label: '区域 A', description: '描述\n第二行',
      autoFile: true, assignedAgentId: null, ownerId: null, collapsed: false },
    { ...META, id: 'el_image', type: 'image',
      assetId: 'asset_1', naturalWidth: 800, naturalHeight: 600 },
    { ...META, id: 'el_sugg', type: 'suggestion',
      targetId: 'el_shape', suggestionType: 'replace',
      payload: { ...META, id: 'el_payload_shape', type: 'shape',
        shape: 'diamond', label: { text: 'payload', fontSize: 14 } },
      reason: '这是 reason', status: 'pending', authorId: 'a_bot',
      thread: [{ by: 'a_bot', role: 'agent', text: 'hi', ts: '2026-05-23T10:00:01.000Z' }] },
    { ...META, id: 'el_embed', type: 'embed',
      url: 'https://example.com', embedType: 'link-card' },
  ];
  return {
    schemaVersion: 1,
    viewport: { x: 100, y: -200, zoom: 1.25 },
    elements,
  };
}

test('sceneToYDoc → yDocToScene 往返无损（10 类元素）', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const out = yDocToScene(doc);
  assert.equal(out.schemaVersion, src.schemaVersion);
  assert.deepEqual(out.viewport, src.viewport);
  assert.equal(out.elements.length, src.elements.length);
  for (let i = 0; i < src.elements.length; i += 1) {
    const ai = out.elements[i]!;
    const bi = src.elements[i]!;
    assert.deepEqual(ai, bi, `element[${i}] (${bi.id}/${bi.type}) 不一致`);
  }
});

test('Y.Text 字段确实是 Y.Text 实例（支持字符级 CRDT）', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const em = doc.getMap<Y.Map<unknown>>('elements');
  // text.markdown
  const textEl = em.get('el_text')!;
  assert.ok(textEl.get('markdown') instanceof Y.Text, 'text.markdown 应为 Y.Text');
  // region.label / region.description
  const regionEl = em.get('el_region')!;
  assert.ok(regionEl.get('label') instanceof Y.Text, 'region.label 应为 Y.Text');
  assert.ok(regionEl.get('description') instanceof Y.Text, 'region.description 应为 Y.Text');
  // shape.label.text
  const shapeEl = em.get('el_shape')!;
  const shapeLbl = shapeEl.get('label') as Y.Map<unknown>;
  assert.ok(shapeLbl instanceof Y.Map, 'shape.label 应为 Y.Map');
  assert.ok(shapeLbl.get('text') instanceof Y.Text, 'shape.label.text 应为 Y.Text');
  // connector.label.text
  const connEl = em.get('el_conn')!;
  const connLbl = connEl.get('label') as Y.Map<unknown>;
  assert.ok(connLbl.get('text') instanceof Y.Text, 'connector.label.text 应为 Y.Text');
});

test('shape.label = null 保留 null 语义', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const em = doc.getMap<Y.Map<unknown>>('elements');
  const sh = em.get('el_shape_nolbl')!;
  assert.equal(sh.get('label'), null);
  const out = yDocToScene(doc);
  const re = out.elements.find((e) => e.id === 'el_shape_nolbl');
  assert.ok(re && re.type === 'shape' && re.label === null);
});

test('style 是 Y.Map（字段级合并）', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const em = doc.getMap<Y.Map<unknown>>('elements');
  const sh = em.get('el_shape')!;
  const st = sh.get('style');
  assert.ok(st instanceof Y.Map, 'style 应为 Y.Map');
  assert.equal((st as Y.Map<unknown>).get('strokeColor'), '#1e1e1e');
});

test('元素顺序按 elementOrder 还原', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const out = yDocToScene(doc);
  for (let i = 0; i < src.elements.length; i += 1) {
    assert.equal(out.elements[i]!.id, src.elements[i]!.id);
  }
});

test('mutate 后再读 —— Y.Text 字符级修改可见', () => {
  const src = makeFullScene();
  const doc = sceneToYDoc(src);
  const em = doc.getMap<Y.Map<unknown>>('elements');
  const regionEl = em.get('el_region')!;
  const label = regionEl.get('label') as Y.Text;
  label.insert(2, '插入');
  const out = yDocToScene(doc);
  const re = out.elements.find((e) => e.id === 'el_region');
  assert.ok(re && re.type === 'region');
  // 「区域 A」index=2 = 在「域」后面，结果「区域插入 A」
  assert.equal((re as Element & { label: string }).label, '区域插入 A');
});

test('两文档对同一元素并发改不同字段 —— Yjs 合并后两改都保留', () => {
  const src = makeFullScene();
  const docA = sceneToYDoc(src);
  // docB 由 docA 的 state 同步初始化(模拟两端持同一份初始 Y.Doc)
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  // A 改 strokeColor
  const emA = docA.getMap<Y.Map<unknown>>('elements');
  const styleA = emA.get('el_shape')!.get('style') as Y.Map<unknown>;
  styleA.set('strokeColor', '#ff0000');
  // B 同时改 strokeWidth
  const emB = docB.getMap<Y.Map<unknown>>('elements');
  const styleB = emB.get('el_shape')!.get('style') as Y.Map<unknown>;
  styleB.set('strokeWidth', 5);
  // 互相 sync
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  // 两端都该看见两改都生效(字段级 CRDT 的核心收益)
  for (const doc of [docA, docB]) {
    const out = yDocToScene(doc);
    const sh = out.elements.find((e) => e.id === 'el_shape')!;
    assert.equal((sh.style as Style).strokeColor, '#ff0000', '并发改:strokeColor 应保留');
    assert.equal((sh.style as Style).strokeWidth, 5, '并发改:strokeWidth 应保留');
  }
});

test('两文档对同一 Y.Text 并发打字 —— 字符级合并', () => {
  const src = makeFullScene();
  const docA = sceneToYDoc(src);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const lblA = docA.getMap<Y.Map<unknown>>('elements').get('el_region')!.get('label') as Y.Text;
  const lblB = docB.getMap<Y.Map<unknown>>('elements').get('el_region')!.get('label') as Y.Text;
  // 初始两端都是「区域 A」
  lblA.insert(0, 'A:');
  lblB.insert(lblB.length, ':B');
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  // 两端合并后都应是「A:区域 A:B」(字符级合并,两端插入都保留)
  assert.equal(lblA.toString(), 'A:区域 A:B');
  assert.equal(lblB.toString(), 'A:区域 A:B');
});
