/**
 * BoardScene ↔ Yjs 文档双向镜像（PRD §7 M4 实时同步工作包）。
 *
 * Y.Doc 结构:
 *   - viewport      : Y.Map { x, y, zoom }
 *   - elements      : Y.Map<elementId, Y.Map>   每元素一张 Y.Map
 *   - elementOrder  : Y.Array<elementId>        BoardScene.elements 数组顺序
 *
 * 字段映射规则:
 *   - 标量字段(number / string / boolean / null)→ Y.Map 槽直接 set
 *   - 嵌套对象(style / shape.label / connector.label / Endpoint)→ Y.Map
 *     —— 字段级 CRDT 合并(两人同时改不同字段都保留)
 *   - 文字字段 → Y.Text(字符级 CRDT,两人同时打字字符级合并):
 *       text.markdown / region.label / region.description /
 *       shape.label.text / connector.label.text
 *   - 数组与 record(points / pressures / waypoints / groupIds /
 *     comments / thread / meta / suggestion.payload)→ 以下:
 *       · suggestion.payload 嵌套 Element → 递归 elementToYMap
 *       · 其余按不可变值整体 set(Board 场景下不需要更细粒度)
 *
 * 撤销 / 重做：按你 2026-05-23 拍板「先单端」,栈在 BoardContext 维护,
 * 不在本文件涉及。
 */
import * as Y from 'yjs';
import type { BoardScene, Element } from './types.js';
import { SCHEMA_VERSION } from './types.js';

/** 顶层 Y.Text 字段（按元素类型）。 */
const TOP_TEXT_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  text: new Set(['markdown']),
  region: new Set(['label', 'description']),
};

/** 嵌套 Y.Map 字段（按元素类型）—— 槽里放 Y.Map 而非原始对象。 */
const NESTED_MAP_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  draw: new Set(['style']),
  shape: new Set(['style', 'label']),
  connector: new Set(['style', 'label', 'start', 'end']),
  text: new Set(['style']),
  file: new Set(['style']),
  folder: new Set(['style']),
  region: new Set(['style']),
  image: new Set(['style']),
  suggestion: new Set(['style']),
  embed: new Set(['style']),
};

/** 把一个 Element 字段写进给定 Y.Map（就地，幂等覆盖）。 */
function fillYMapFromElement(m: Y.Map<unknown>, el: Element): void {
  const type = el.type;
  const textFields = TOP_TEXT_FIELDS[type] ?? new Set<string>();
  const mapFields = NESTED_MAP_FIELDS[type] ?? new Set<string>();
  for (const [key, value] of Object.entries(el)) {
    if (textFields.has(key) && typeof value === 'string') {
      // 顶层 Y.Text(region.label/description、text.markdown)
      const t = new Y.Text();
      m.set(key, t);
      if (value.length > 0) t.insert(0, value);
      continue;
    }
    if (mapFields.has(key)) {
      if (value === null || value === undefined) {
        // label 可为 null —— 保留 null 语义
        m.set(key, value as null);
        continue;
      }
      if (typeof value !== 'object') {
        m.set(key, value);
        continue;
      }
      const child = new Y.Map<unknown>();
      m.set(key, child);
      if (key === 'label' && (type === 'shape' || type === 'connector')) {
        // { text: string, fontSize?: number } —— text 升 Y.Text
        const lo = value as { text: string; fontSize?: number };
        const lt = new Y.Text();
        child.set('text', lt);
        if (lo.text.length > 0) lt.insert(0, lo.text);
        if (typeof lo.fontSize === 'number') child.set('fontSize', lo.fontSize);
      } else {
        // style / Endpoint(start/end)—— 一律标量场,直接搬运
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          child.set(k, v);
        }
      }
      continue;
    }
    if (key === 'payload' && type === 'suggestion' && value && typeof value === 'object') {
      // suggestion.payload 是嵌套 Element —— 递归镜像
      const pm = new Y.Map<unknown>();
      m.set(key, pm);
      fillYMapFromElement(pm, value as Element);
      continue;
    }
    // 普通标量 / 数组 / record —— 整体 set,不参与内部 CRDT 合并
    m.set(key, value);
  }
}

/** 单元素 → Y.Map（脱离任何 Doc，调用方再挂载到 elements Y.Map 上）。 */
export function elementToYMap(el: Element): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  fillYMapFromElement(m, el);
  return m;
}

/** Y.Map → 纯 JS Element（深拷贝，与原元素深等于）。 */
export function yMapToElement(m: Y.Map<unknown>): Element {
  const result: Record<string, unknown> = {};
  for (const key of Array.from(m.keys())) {
    const v = m.get(key);
    if (v instanceof Y.Text) {
      result[key] = v.toString();
    } else if (v instanceof Y.Array) {
      result[key] = v.toArray();
    } else if (v instanceof Y.Map) {
      if (key === 'payload') {
        result[key] = yMapToElement(v as Y.Map<unknown>);
      } else if (key === 'label') {
        // shape/connector label: { text: Y.Text, fontSize?: number }
        const text = v.get('text');
        const obj: Record<string, unknown> = {
          text: text instanceof Y.Text ? text.toString() : String(text ?? ''),
        };
        const fs = v.get('fontSize');
        if (typeof fs === 'number') obj.fontSize = fs;
        result[key] = obj;
      } else {
        // style / start / end —— 平铺标量
        const obj: Record<string, unknown> = {};
        for (const k of Array.from(v.keys())) {
          obj[k] = v.get(k);
        }
        result[key] = obj;
      }
    } else {
      result[key] = v;
    }
  }
  return result as unknown as Element;
}

/**
 * BoardScene → Y.Doc（产新 Doc）。
 * 调用方一般在 server 启动时按 board.json 构 Doc，之后 Doc 即权威源。
 */
export function sceneToYDoc(scene: BoardScene): Y.Doc {
  const doc = new Y.Doc();
  const vp = doc.getMap<number>('viewport');
  vp.set('x', scene.viewport.x);
  vp.set('y', scene.viewport.y);
  vp.set('zoom', scene.viewport.zoom);
  const elements = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');
  doc.transact(() => {
    for (const el of scene.elements) {
      elements.set(el.id, elementToYMap(el));
      order.push([el.id]);
    }
  });
  return doc;
}

/**
 * Y.Doc → BoardScene（每次读出最新投影）。
 * elements 数组顺序按 elementOrder 还原；order 里没有的 id 按 keys 顺序追加
 * 兜底（防 mutate 漏写 order）。
 */
export function yDocToScene(doc: Y.Doc): BoardScene {
  const vp = doc.getMap<number>('viewport');
  const elementsMap = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');
  const elements: Element[] = [];
  const seen = new Set<string>();
  for (const id of order.toArray()) {
    const m = elementsMap.get(id);
    if (m && !seen.has(id)) {
      elements.push(yMapToElement(m));
      seen.add(id);
    }
  }
  for (const id of Array.from(elementsMap.keys())) {
    if (!seen.has(id)) {
      const m = elementsMap.get(id);
      if (m) elements.push(yMapToElement(m));
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: {
      x: Number(vp.get('x') ?? 0),
      y: Number(vp.get('y') ?? 0),
      zoom: Number(vp.get('zoom') ?? 1),
    },
    elements,
  };
}
