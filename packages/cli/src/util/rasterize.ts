/**
 * SVG → PNG 光栅化（M5 L4 board_render 用）。
 *
 * 用 @resvg/resvg-js（Rust napi，prebuilt 跨平台二进制）把 core 拼出的 SVG 渲成
 * PNG，让 MCP 工具能回一张「真图」给模型读图自查。系统字体渲 CJK（Windows 有
 * 宋体/雅黑，无需 bundle）。动态 import —— 二进制加载失败时调用方可回退 SVG 文本。
 */

/** 把 SVG 渲成 PNG buffer。pixelWidth = 期望输出宽度（px）。 */
export async function svgToPng(svg: string, pixelWidth: number): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(pixelWidth)) },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(r.render().asPng());
}
