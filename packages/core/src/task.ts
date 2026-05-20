/**
 * Agent 任务模型 — Pencil 式过程可视化（PRD §7.4 / §7.5）。
 *
 * 「任务」是 Agent 一次工作的运行时呈现：在画布上是一张「占位任务卡」，显示
 * 正在做什么、步骤进度；完成后转为结果说明。任务**不是画布元素**——它有独立的
 * `task_` 命名空间、属运行时态，存于 `.board/.runtime/`（reconcile R7 忽略项），
 * 不进 board.json（board.json 只存「成果」，任务是「过程」）。
 *
 * 任务流（PRD §7.5）：
 *   task.start  → 在目标位置放占位卡
 *   task.progress → 追加步骤 / 更新进度（其间 Agent 流式产出 draft 态元素）
 *   task.finish → 转结果说明；其 draft 态元素一并转 committed
 *
 * 纯模块，浏览器与 Node 通用。
 */
import type { BoardScene, Element, ISO8601, ParticipantId } from './types.js';
import { newTaskId } from './ids.js';

/** 任务进度步骤。 */
export interface TaskStep {
  /** 步骤描述（如「已联网查询」「找到 3 个车次」） */
  text: string;
  ts: ISO8601;
}

/** `running` 进行中 / `done` 已完成。 */
export type TaskStatus = 'running' | 'done';

/** 一个 Agent 任务 —— 占位任务卡的数据。 */
export interface BoardTask {
  /** `task_` + 8 位十六进制 */
  id: string;
  /** 在做什么（占位卡标题） */
  title: string;
  /** 执行该任务的参与者 id */
  agentId: ParticipantId;
  /** 任务卡所在区域元素 id；null = 收件区 / 游离画布 */
  regionId: string | null;
  /** 任务卡画布坐标与尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 进度步骤列表（按时间追加） */
  steps: TaskStep[];
  /** 进度百分比 0–100 */
  percent: number;
  status: TaskStatus;
  /** 完成结果说明；`running` 时为 null */
  summary: string | null;
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

/** 占位任务卡的默认尺寸。 */
export const TASK_CARD_SIZE = { width: 300, height: 184 } as const;

/**
 * 完成态任务卡的存活时长（毫秒）—— 自 `task.finish`（updatedAt）起算。
 * 超过即自动淡出移除（用户也可经卡上 × 手动关闭）。server 与 web 共用此常量：
 * web 据此定时淡出，server 据此在启动时清理过期完成态任务。
 */
export const TASK_DONE_TTL_MS = 60_000;

/** 新建任务的入参。 */
export interface CreateTaskInit {
  title: string;
  agentId: ParticipantId;
  /** 所属区域元素 id；不给 = 收件区 */
  regionId?: string | null;
  /** 任务卡画布坐标 */
  x: number;
  y: number;
}

/** 新建一个进行中的任务。 */
export function createTask(init: CreateTaskInit): BoardTask {
  const ts = new Date().toISOString();
  return {
    id: newTaskId(),
    title: init.title,
    agentId: init.agentId,
    regionId: init.regionId ?? null,
    x: init.x,
    y: init.y,
    width: TASK_CARD_SIZE.width,
    height: TASK_CARD_SIZE.height,
    steps: [],
    percent: 0,
    status: 'running',
    summary: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** 百分比钳制到 0–100 整数。 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 把场景中所有 `draft` 态元素转为 `committed`（PRD §7.4 第 6 点：
 * task.finish 后 draft 元素提交为正式内容）。
 *
 * @returns 新场景与是否发生变化；无 draft 元素时返回原场景。
 */
export function commitDraftElements(
  scene: BoardScene,
  actor: ParticipantId,
): { scene: BoardScene; changed: boolean } {
  let changed = false;
  const ts = new Date().toISOString();
  const elements = scene.elements.map((e): Element => {
    if (e.state !== 'draft') return e;
    changed = true;
    return { ...e, state: 'committed', updatedBy: actor, updatedAt: ts };
  });
  return changed ? { scene: { ...scene, elements }, changed } : { scene, changed };
}
