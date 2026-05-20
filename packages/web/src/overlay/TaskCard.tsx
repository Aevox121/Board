/**
 * 任务卡片 —— Pencil 式过程可视化的「占位任务卡」（PRD §7.4 / §7.5）。
 *
 * 渲染一个 BoardTask，呈现 Agent「进行中 → 结果」的过程：
 *  - running —— ◴ + 标题 + 步骤列表 + 进度条，呈现「Agent 正在工作」。
 *  - done    —— ✔ + 标题 + 结果说明，占位卡转为结果说明态。
 *
 * 完成态任务卡的去留：可经卡上 × 手动关闭，亦在 TASK_DONE_TTL_MS 后自动淡出；
 * 两条路径都先做淡出动画，再请求 server 移除该任务。
 *
 * 任务卡是过程态、非画布元素 —— 不可拖拽，只作可视化呈现。
 */
import { useEffect, useState } from 'react';
import { TASK_DONE_TTL_MS, type BoardTask } from '@board/core';
import { cardRotation } from './util';
import { dismissTask } from '../server/client';

export interface TaskCardProps {
  task: BoardTask;
}

/** 卡片高度有限，步骤列表只显示最近若干条。 */
const MAX_VISIBLE_STEPS = 4;
/** 淡出动画时长（须与 .ov-task--fading 的 CSS transition 一致）。 */
const FADE_MS = 600;

export function TaskCard({ task }: TaskCardProps): JSX.Element {
  const running = task.status === 'running';
  const steps = task.steps.slice(-MAX_VISIBLE_STEPS);
  const rotation = cardRotation(task.id);
  // 淡出中 —— × 手动关闭或完成态超时触发。
  const [fading, setFading] = useState(false);

  // 完成态：到达 TTL（自 finish 起算）即开始淡出。
  useEffect(() => {
    if (task.status !== 'done') return;
    const age = Date.now() - new Date(task.updatedAt).getTime();
    const remain = Math.max(0, TASK_DONE_TTL_MS - age);
    const timer = setTimeout(() => setFading(true), remain);
    return () => clearTimeout(timer);
  }, [task.status, task.updatedAt]);

  // 淡出动画结束后请求 server 移除该任务（× 手动关闭也走此路径）。
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => {
      void dismissTask(task.id).catch(() => {
        // server 不可达 —— 卡片已淡出不可见，忽略即可。
      });
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, task.id]);

  return (
    <div
      className={
        'ov-card ov-task' +
        (running ? ' ov-task--running' : ' ov-task--done') +
        (fading ? ' ov-task--fading' : '')
      }
      style={{ transform: `rotate(${rotation}deg)` }}
      title={task.title}
    >
      <div className="ov-task__bar">
        <span className="ov-task__icon" aria-hidden="true">
          {running ? '◴' : '✔'}
        </span>
        <span className="ov-task__status">
          {running ? '正在工作' : '已完成'}
        </span>
        <span className="ov-task__agent">{task.agentId}</span>
        {running ? null : (
          <button
            type="button"
            className="ov-task__close"
            onClick={() => setFading(true)}
            title="关闭任务卡"
            aria-label="关闭任务卡"
          >
            ×
          </button>
        )}
      </div>

      <div className="ov-task__title">{task.title}</div>

      {running ? (
        <>
          {steps.length > 0 ? (
            <ul className="ov-task__steps">
              {steps.map((s, i) => (
                <li key={i} className="ov-task__step">
                  {s.text}
                </li>
              ))}
            </ul>
          ) : (
            <div className="ov-task__steps ov-task__hint">准备中…</div>
          )}
          <div className="ov-task__progress">
            <div className="ov-task__track">
              <div
                className="ov-task__fill"
                style={{ width: `${task.percent}%` }}
              />
            </div>
            <span className="ov-task__percent">{task.percent}%</span>
          </div>
        </>
      ) : (
        <div className="ov-task__summary">{task.summary ?? '已完成'}</div>
      )}
    </div>
  );
}
