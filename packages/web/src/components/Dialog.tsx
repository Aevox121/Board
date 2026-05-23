/**
 * 通用对话框组件 —— Board 应用的弹窗统一入口（设计规范见 tokens.css）。
 *
 * 统一行为：
 *  - 居中浮层 + 半透明遮罩；点遮罩或按 Esc 取消（onCancel 提供时）
 *  - 主按钮陶土橙强调色 / 次按钮灰边；danger 变体走 --c-danger
 *  - 入场动画（4px translateY + opacity）；自动锁定背景滚动
 *  - 自动焦点：打开时聚焦主按钮（PromptDialog 等可在 children 内自己抢焦点）
 *
 * 用法：
 *  - 低层 `<Dialog>` —— 自定义 children + 自由按钮
 *  - 高层 `<ConfirmDialog>` —— 「取消 / 确认」二选一
 *  - 高层 `<PromptDialog>` —— 输入一行文本 → 提交
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './Dialog.css';

export interface DialogAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  /** danger=true 时主按钮变红色（删除等不可逆操作）。 */
  danger?: boolean;
}

export interface DialogProps {
  /** 标题（必填，aria-label 兜底）。 */
  title: string;
  /** 主按钮（陶土橙 / 红）。省略时不渲染。 */
  primary?: DialogAction;
  /** 次按钮（灰边）。省略时不渲染。 */
  secondary?: DialogAction;
  /** 点遮罩 / Esc 取消时的回调；省略时禁用这两种关闭方式。 */
  onCancel?: () => void;
  /** 浮层最大宽度（px），默认 360。 */
  width?: number;
  /** 自定义内容（描述 / 表单 / 列表等）。 */
  children?: ReactNode;
}

/** 通用对话框 —— 中心浮层 + 遮罩。 */
export function Dialog({
  title,
  primary,
  secondary,
  onCancel,
  width = 360,
  children,
}: DialogProps): JSX.Element {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // 入场后聚焦主按钮（无主按钮则聚焦卡片，便于 Esc 关）
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (primaryRef.current) primaryRef.current.focus();
      else cardRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && onCancel) {
      e.stopPropagation();
      onCancel();
    }
  };

  // 用 portal 渲到 document.body —— 避免 .ov-root（z-index:3）和工具栏 /
  // 底栏 / 小地图（z-index>=6）的 stacking context 把弹窗罩住、按钮点不到。
  return createPortal(
    <div
      className="bd-dialog__backdrop"
      onPointerDown={() => {
        if (onCancel) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="bd-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ maxWidth: `${width}px` }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="bd-dialog__title">{title}</div>
        {children !== undefined && (
          <div className="bd-dialog__body">{children}</div>
        )}
        {(primary || secondary) && (
          <div className="bd-dialog__actions">
            {secondary && (
              <button
                type="button"
                className="bd-dialog__btn"
                onClick={() => void secondary.onClick()}
                disabled={secondary.disabled}
              >
                {secondary.label}
              </button>
            )}
            {primary && (
              <button
                ref={primaryRef}
                type="button"
                className={
                  'bd-dialog__btn bd-dialog__btn--primary' +
                  (primary.danger ? ' bd-dialog__btn--danger' : '')
                }
                onClick={() => void primary.onClick()}
                disabled={primary.disabled}
              >
                {primary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────── 高层包装 ─────────────────────────

export interface ConfirmDialogProps {
  title: string;
  /** 副文（一行或多行说明）。 */
  body?: ReactNode;
  /** 确认按钮文案（默认「确认」）。 */
  confirmLabel?: string;
  /** 取消按钮文案（默认「取消」）。 */
  cancelLabel?: string;
  /** danger=true 时确认按钮变红（删除等不可逆操作）。 */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** 二选一确认弹窗 —— 取代 window.confirm。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      primary={{ label: confirmLabel, onClick: onConfirm, danger }}
      secondary={{ label: cancelLabel, onClick: onCancel }}
    >
      {body && <div className="bd-dialog__text">{body}</div>}
    </Dialog>
  );
}

export interface PromptDialogProps {
  title: string;
  /** 输入框上方的提示文字。 */
  body?: ReactNode;
  /** 输入框 placeholder。 */
  placeholder?: string;
  /** 输入框 label（不传则不显示）。 */
  label?: string;
  /** label 旁的「选填」徽标（true 时显示）。 */
  optional?: boolean;
  /** 默认值。 */
  defaultValue?: string;
  /** 最大长度（默认 200）。 */
  maxLength?: number;
  /** 是否要求非空（默认 false）。 */
  required?: boolean;
  /** 确认 / 取消按钮文案。 */
  confirmLabel?: string;
  cancelLabel?: string;
  /** value 已 trim 过；空值仅在 required=false 时才会传出。 */
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/** 单行输入对话框 —— 取代 window.prompt。 */
export function PromptDialog({
  title,
  body,
  placeholder,
  label,
  optional,
  defaultValue = '',
  maxLength = 200,
  required = false,
  confirmLabel = '确定',
  cancelLabel = '取消',
  onSubmit,
  onCancel,
}: PromptDialogProps): JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const trimmed = value.trim();
  const disabled = required && trimmed.length === 0;

  const submit = (): void => {
    if (disabled) {
      inputRef.current?.focus();
      return;
    }
    void onSubmit(trimmed);
  };

  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      primary={{ label: confirmLabel, onClick: submit, disabled }}
      secondary={{ label: cancelLabel, onClick: onCancel }}
    >
      {body && <div className="bd-dialog__text">{body}</div>}
      {label && (
        <label className="bd-dialog__label" htmlFor="bd-dialog-input">
          {label}
          {optional && <span className="bd-dialog__opt">选填</span>}
        </label>
      )}
      <input
        id="bd-dialog-input"
        ref={inputRef}
        className="bd-dialog__input"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
    </Dialog>
  );
}
