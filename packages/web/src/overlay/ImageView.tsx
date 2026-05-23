/**
 * 画布原生图片渲染 —— 把一个 `image` 元素渲染为 `<img>`（数据模型 §6.8）。
 *
 * 图源二选一：`path`（files/ 内文件，走 `/api/files/`）或 `assetId`
 * （assets/ 内画布素材，走 `/api/assets/`）。两者皆无则显示缺失占位。
 */
import type { ImageElement } from '@board/core';
import { apiUrl } from '../server/boardSession';

/** 图片元素的源 URL —— files/ 走 /api/files，assets/ 走 /api/assets。 */
export function imageSrc(el: ImageElement): string | null {
  if (el.path) {
    return apiUrl(
      '/files/' + el.path.split('/').map(encodeURIComponent).join('/'),
    );
  }
  if (el.assetId) return apiUrl('/assets/' + encodeURIComponent(el.assetId));
  return null;
}

export function ImageView({ element }: { element: ImageElement }): JSX.Element {
  const src = imageSrc(element);
  return (
    <div className="ov-image">
      {src ? (
        <img
          className="ov-image__img"
          src={src}
          alt=""
          // 禁用原生图片拖拽 —— 拖拽由卡槽指针逻辑接管。
          draggable={false}
        />
      ) : (
        <div className="ov-image__missing">图片缺失</div>
      )}
    </div>
  );
}
