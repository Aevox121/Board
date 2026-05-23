/**
 * `computeEditAnchor` 单元测试 —— 各元素类型的编辑锚点偏移。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeEditAnchor } from './edit-anchor.js';
import type {
  Element,
  ConnectorElement,
  RegionElement,
  ShapeElement,
  TextElement,
  FileElement,
} from './types.js';
import { makeDefaultStyle } from './style.js';

function baseEl(
  partial: Partial<Element> & Pick<Element, 'type' | 'width' | 'height'>,
): Element {
  return {
    id: 'el_test',
    x: 0,
    y: 0,
    angle: 0,
    z: '00000000',
    parentId: null,
    locked: false,
    state: 'committed',
    autoPlaced: false,
    style: makeDefaultStyle(),
    createdBy: 'u_test',
    updatedBy: 'u_test',
    createdAt: '2026-05-23T00:00:00Z',
    updatedAt: '2026-05-23T00:00:00Z',
    ...partial,
  } as Element;
}

describe('computeEditAnchor', () => {
  it('text: line 0 落到 body 顶部内', () => {
    const el = baseEl({
      type: 'text',
      width: 320,
      height: 180,
      markdown: 'hello',
      autoWidth: false,
      editMode: 'preview',
    }) as TextElement;
    const a = computeEditAnchor(el);
    // header(24) + body padding-top(8) + lineHeight/2(10) = 42
    assert.equal(a.y, 42);
    // body padding-left(12) + insetX(16) = 28
    assert.equal(a.x, 28);
  });

  it('text: line N 步进 lineHeight=20', () => {
    const el = baseEl({
      type: 'text',
      width: 320,
      height: 180,
      markdown: '',
      autoWidth: false,
      editMode: 'preview',
    }) as TextElement;
    const a3 = computeEditAnchor(el, { lineIndex: 3 });
    // 42 + 3 * 20 = 102
    assert.equal(a3.y, 102);
  });

  it('text: charIndex 按 8px 步进 x', () => {
    const el = baseEl({
      type: 'text',
      width: 320,
      height: 180,
      markdown: '',
      autoWidth: false,
      editMode: 'preview',
    }) as TextElement;
    const a = computeEditAnchor(el, { lineIndex: 1, charIndex: 5 });
    // x: 12 + 16 + 5 * 8 = 68
    assert.equal(a.x, 68);
  });

  it('shape: 几何中心', () => {
    const el = baseEl({
      type: 'shape',
      width: 200,
      height: 100,
      shape: 'rectangle',
      label: null,
    }) as ShapeElement;
    const a = computeEditAnchor(el);
    assert.deepEqual(a, { x: 100, y: 50 });
  });

  it('region: 头部 label 锚点', () => {
    const el = baseEl({
      type: 'region',
      width: 720,
      height: 520,
      path: 'foo',
      label: 'Foo',
      description: '',
      autoFile: true,
      assignedAgentId: null,
      ownerId: null,
      collapsed: false,
    }) as RegionElement;
    const a = computeEditAnchor(el);
    // header padding (12, 8) + label baseline 16 → (12, 24)
    assert.deepEqual(a, { x: 12, y: 24 });
  });

  it('connector: 折线中点（两点直线 → 中点）', () => {
    const el = baseEl({
      type: 'connector',
      width: 100,
      height: 0,
      start: { elementId: null, anchor: 'auto', point: [0, 0] },
      end: { elementId: null, anchor: 'auto', point: [100, 0] },
      startArrow: 'none',
      endArrow: 'arrow',
      routing: 'straight',
      label: null,
    }) as ConnectorElement;
    const a = computeEditAnchor(el);
    assert.deepEqual(a, { x: 50, y: 0 });
  });

  it('connector: 端点 point 缺失时取 bbox 兜底', () => {
    const el = baseEl({
      type: 'connector',
      width: 200,
      height: 80,
      start: { elementId: 'el_a', anchor: 'auto' },
      end: { elementId: 'el_b', anchor: 'auto' },
      startArrow: 'none',
      endArrow: 'arrow',
      routing: 'straight',
      label: null,
    }) as ConnectorElement;
    const a = computeEditAnchor(el);
    // (0,0) → (200, 80) 中点
    assert.deepEqual(a, { x: 100, y: 40 });
  });

  it('connector: waypoints 折线中点', () => {
    const el = baseEl({
      type: 'connector',
      width: 200,
      height: 100,
      start: { elementId: null, anchor: 'auto', point: [0, 0] },
      end: { elementId: null, anchor: 'auto', point: [200, 0] },
      waypoints: [[100, 100]],
      startArrow: 'none',
      endArrow: 'arrow',
      routing: 'straight',
      label: null,
    }) as ConnectorElement;
    const a = computeEditAnchor(el);
    // 折线 (0,0)→(100,100)→(200,0)，每段长度 sqrt(20000)≈141.42，总长 282.84
    // 中点在第 1 段末尾（141.42 半程），即 (100, 100)
    assert.equal(a.x, 100);
    assert.equal(a.y, 100);
  });

  it('file: 顶栏锚点', () => {
    const el = baseEl({
      type: 'file',
      width: 280,
      height: 360,
      path: 'foo.md',
      mime: 'text/markdown',
      size: 100,
      displayMode: 'card',
    }) as FileElement;
    const a = computeEditAnchor(el);
    assert.deepEqual(a, { x: 12, y: 20 });
  });
});
