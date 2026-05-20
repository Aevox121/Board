/**
 * 建议机制（Suggestion）—— PRD §7.3。
 *
 * Agent 要改不属于自己的内容时，不直接改原件，而是在旁边产生一条「建议」元素，
 * 承载提议的新内容。人对建议有三种处理：
 *  - 同意（accept）：用建议内容替换 / 新增到白板，移除建议元素。
 *  - 拒绝（reject）：删除建议元素，原件不变。
 *  - 描述（describe）：向 Agent 写一段反馈，建议元素保留，形成「建议 ↔ 反馈」回路。
 *
 * 决策权始终在人手里 —— Agent 既能改进人的成果，又不会破坏原始内容。
 *
 * 纯模块，浏览器与 Node 通用。
 */
import type {
  BoardScene,
  Element,
  ParticipantId,
  SuggestionElement,
  ThreadMsg,
} from './types.js';

/** 建议卡默认尺寸（含提议内容 + 建议理由两段，故略高）。 */
export const SUGGESTION_CARD_SIZE = { width: 300, height: 280 } as const;

/** 建议卡与目标元素并排时的水平间距。 */
export const SUGGESTION_GAP = 40;

/** 收集场景内全部 suggestion 元素。 */
export function suggestionsOf(elements: Element[]): SuggestionElement[] {
  return elements.filter(
    (e): e is SuggestionElement => e.type === 'suggestion',
  );
}

/** 建议操作的统一结果。 */
export interface SuggestionResult {
  scene: BoardScene;
  /** 场景是否发生变化（用于决定是否落盘）。 */
  changed: boolean;
  /** 非 null 表示操作失败（建议 / 目标不存在等）。 */
  error: string | null;
}

/** 在场景中查找一个 suggestion 元素。 */
function findSuggestion(
  scene: BoardScene,
  id: string,
): SuggestionElement | undefined {
  return scene.elements.find(
    (e): e is SuggestionElement => e.id === id && e.type === 'suggestion',
  );
}

/**
 * 同意建议（PRD §7.3「同意」）。
 *
 * **只并入 `payload`** —— 建议的「理由」(`reason`) 与「反馈」(`thread`) 是
 * 表明「这是一条建议」的说明，同意时一并随建议元素移除，不进入目标。
 *  - `replace`：用 payload 的内容替换目标元素，保留目标的身份与几何
 *    （id / 坐标 / 尺寸 / 层级 / 归属）；移除建议元素。
 *  - `add`：把 payload 作为新的正式元素加入场景（落在建议卡处）；移除建议元素。
 */
export function acceptSuggestion(
  scene: BoardScene,
  suggestionId: string,
  actor: ParticipantId,
): SuggestionResult {
  const sugg = findSuggestion(scene, suggestionId);
  if (!sugg) {
    return { scene, changed: false, error: `未找到建议元素：${suggestionId}` };
  }
  const ts = new Date().toISOString();

  if (sugg.suggestionType === 'add') {
    // payload 直接成为新的正式元素，落在建议卡所在处。
    const added: Element = {
      ...sugg.payload,
      x: sugg.x,
      y: sugg.y,
      state: 'committed',
      updatedBy: actor,
      updatedAt: ts,
    } as Element;
    const elements = scene.elements
      .filter((e) => e.id !== suggestionId)
      .concat(added);
    return { scene: { ...scene, elements }, changed: true, error: null };
  }

  // replace —— 内容取自 payload，身份与几何保留目标的。
  const target = scene.elements.find((e) => e.id === sugg.targetId);
  if (!target) {
    return {
      scene,
      changed: false,
      error: `建议的目标元素已不存在：${sugg.targetId}`,
    };
  }
  const merged: Element = {
    ...sugg.payload,
    id: target.id,
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    z: target.z,
    parentId: target.parentId,
    createdBy: target.createdBy,
    createdAt: target.createdAt,
    updatedBy: actor,
    updatedAt: ts,
    state: 'committed',
  } as Element;
  const elements = scene.elements
    .filter((e) => e.id !== suggestionId)
    .map((e) => (e.id === target.id ? merged : e));
  return { scene: { ...scene, elements }, changed: true, error: null };
}

/** 拒绝建议（PRD §7.3「拒绝」）—— 删除建议元素，原件不变。 */
export function rejectSuggestion(
  scene: BoardScene,
  suggestionId: string,
): SuggestionResult {
  if (!findSuggestion(scene, suggestionId)) {
    return { scene, changed: false, error: `未找到建议元素：${suggestionId}` };
  }
  const elements = scene.elements.filter((e) => e.id !== suggestionId);
  return { scene: { ...scene, elements }, changed: true, error: null };
}

/**
 * 描述建议（PRD §7.3「描述」）—— 向建议追加一条反馈消息；建议元素保留，
 * Agent 下一轮据此修订建议，形成「建议 ↔ 反馈」迭代回路。
 */
export function describeSuggestion(
  scene: BoardScene,
  suggestionId: string,
  text: string,
  by: ParticipantId,
  role: ThreadMsg['role'],
): SuggestionResult {
  if (!findSuggestion(scene, suggestionId)) {
    return { scene, changed: false, error: `未找到建议元素：${suggestionId}` };
  }
  const ts = new Date().toISOString();
  const msg: ThreadMsg = { by, role, text, ts };
  const elements = scene.elements.map((e) =>
    e.id === suggestionId && e.type === 'suggestion'
      ? { ...e, thread: [...e.thread, msg], updatedBy: by, updatedAt: ts }
      : e,
  );
  return { scene: { ...scene, elements }, changed: true, error: null };
}
