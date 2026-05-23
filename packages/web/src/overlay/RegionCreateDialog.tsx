/**
 * 区域弹窗 —— 新建（无 initial 值）/ 编辑（带 initial 值）共用。
 *
 * 含「名称」（必填）与「描述」（选填）两栏。名称即 `files/` 下的文件夹名。
 * Enter 提交、Esc 取消；点遮罩取消。屏幕定位（不随画布缩放）。
 *
 * 编辑模式（PRD §6.6）：双击区域头部打开，名称 / 描述预填当前值，
 * 提交即 patch 元素 label + description；不重命名文件夹（仅 label 变）。
 */
import { useEffect, useRef, useState } from 'react';

export interface RegionCreateDialogProps {
  /** 弹窗中心的屏幕坐标（区域矩形中心换算所得）。 */
  screenX: number;
  screenY: number;
  /** 提交 —— name 已去空白且非空，description 已去空白（可为空串）。 */
  onSubmit: (name: string, description: string) => void;
  /** 取消。 */
  onCancel: () => void;
  /** 编辑模式：名称 / 描述初值；不传则按「新建」处理。 */
  initialName?: string;
  initialDescription?: string;
  /** 标题文案；缺省 = "新建区域"。 */
  title?: string;
  /** 主按钮文案；缺省 = "创建"。 */
  submitLabel?: string;
}

export function RegionCreateDialog({
  screenX,
  screenY,
  onSubmit,
  onCancel,
  initialName,
  initialDescription,
  title,
  submitLabel,
}: RegionCreateDialogProps): JSX.Element {
  const [name, setName] = useState(initialName ?? '');
  const [desc, setDesc] = useState(initialDescription ?? '');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = (): void => {
    const n = name.trim();
    if (!n) {
      nameRef.current?.focus();
      return;
    }
    onSubmit(n, desc.trim());
  };

  return (
    <>
      <div className="ov-region-dialog__backdrop" onPointerDown={onCancel} />
      <div
        className="ov-region-dialog"
        style={{ left: `${screenX}px`, top: `${screenY}px` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="ov-region-dialog__title">{title ?? '新建区域'}</div>

        <label className="ov-region-dialog__label" htmlFor="ov-region-name">
          名称
        </label>
        <input
          id="ov-region-name"
          ref={nameRef}
          className="ov-region-dialog__input"
          value={name}
          placeholder="区域名称（即 files/ 下的文件夹名）"
          onChange={(e) => setName(e.target.value)}
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

        <label className="ov-region-dialog__label" htmlFor="ov-region-desc">
          描述
          <span className="ov-region-dialog__opt">选填</span>
        </label>
        <textarea
          id="ov-region-desc"
          className="ov-region-dialog__textarea"
          value={desc}
          placeholder="区域用途说明（落地为该文件夹的 README.md）"
          rows={3}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="ov-region-dialog__actions">
          <button
            type="button"
            className="ov-region-dialog__btn"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="ov-region-dialog__btn ov-region-dialog__btn--primary"
            onClick={submit}
            disabled={name.trim() === ''}
          >
            {submitLabel ?? '创建'}
          </button>
        </div>
      </div>
    </>
  );
}
