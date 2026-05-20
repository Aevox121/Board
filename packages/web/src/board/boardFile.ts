/**
 * board.json 文件 I/O —— 浏览器侧的导出下载与导入读取。
 *
 * M1 不依赖 server：导出 = 用 `serializeScene` 生成文本并触发浏览器下载；
 * 导入 = 用 `<input type=file>` 读取文本，经 `parseScene` 解析为 `BoardScene`。
 */
import {
  type BoardScene,
  serializeScene,
  parseScene,
  BoardParseError,
} from '@board/core';

/** 把当前场景导出为 board.json 并触发浏览器下载。 */
export function downloadBoardJSON(scene: BoardScene, fileName = 'board.json'): void {
  const text = serializeScene(scene);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 释放对象 URL（下载已由浏览器接管）。
  URL.revokeObjectURL(url);
}

/**
 * 弹出文件选择框，读取并解析一个 board.json。
 * @returns 解析成功的场景；用户取消选择时返回 null。
 * @throws  BoardParseError —— 文件内容非法。
 */
export function pickAndParseBoardJSON(): Promise<BoardScene | null> {
  return new Promise<BoardScene | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        try {
          const text = String(reader.result ?? '');
          resolve(parseScene(text));
        } catch (e) {
          reject(
            e instanceof BoardParseError
              ? e
              : new BoardParseError(`读取 board.json 失败：${String(e)}`),
          );
        }
      });
      reader.addEventListener('error', () => {
        reject(new BoardParseError('文件读取失败'));
      });
      reader.readAsText(file);
    });

    // 注：用户在系统对话框点「取消」不会触发 change，Promise 保持挂起——
    // M1 可接受（不会泄漏可见状态）；后续可加 window focus 兜底检测。
    input.click();
  });
}
