/**
 * 任务卡片 —— Pencil 式过程可视化的「占位任务卡」（PRD §7.4 / §7.5）。
 *
 * 渲染一个 BoardTask，呈现 Agent「进行中 → 结果」的过程：
 *  - running —— ◴ + 标题 + 步骤列表 + 进度条，呈现「Agent 正在工作」。
 *  - done    —— ✔ + 标题 + 结果说明，占位卡转为结果说明态。
 *
 * 任务卡是过程态、非画布元素 —— 不可拖拽，只作可视化呈现。
 */
import type { BoardTask } from '@board/core';
import { cardRotation } from './util';

export interface TaskCardProps {
  task: BoardTask;
}

/** 卡片高度有限，步骤列表只显示最近若干条。 */
const MAX_VISIBLE_STEPS = 4;

export function TaskCard({ task }: TaskCardProps): JSX.Element {
  const running = task.status === 'running';
  const steps = task.steps.slice(-MAX_VISIBLE_STEPS);
  const rotation = cardRotation(task.id);

  return (
    <div
      className={
        'ov-card ov-task' +
        (running ? ' ov-task--running' : ' ov-task--done')
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
