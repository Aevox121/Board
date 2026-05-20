/**
 * ESM 解析钩子 — 为「无扩展名」相对 / 子路径 import 补全 `.js`。
 *
 * 背景：本仓库 TS 配置用 `moduleResolution: "Bundler"`，TS 允许源码写
 * `import './x'` 而不带扩展名，且编译时**不会**改写。但 Node 原生 ESM
 * 要求相对 import 必须带扩展名，导致编译产物（含 `@board/core` 的 dist）
 * 直接用 `node` 运行时报 `ERR_MODULE_NOT_FOUND`。
 *
 * 本钩子在解析失败时，依次尝试 `<spec>.js` 与 `<spec>/index.js`，
 * 使无扩展名产物可被 Node 直接执行。仅作用于 cli 进程自身，
 * 通过 `module.register()` 注册，不改动任何其它包的文件。
 */
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/** Node loader resolve 钩子的上下文（仅用到必要字段）。 */
interface ResolveContext {
  parentURL?: string;
  conditions: string[];
  importAttributes: Record<string, string>;
}

/** resolve 钩子的返回值（仅用到必要字段）。 */
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}

/** 下一个 resolve 钩子（链式调用）。 */
type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<ResolveResult>;

/**
 * resolve 钩子：正常解析失败时，尝试补全扩展名再解析。
 */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // 仅处理「模块找不到」一类错误
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND') throw err;

    // 依次尝试 `.js` 和 `/index.js`
    for (const suffix of ['.js', '/index.js']) {
      const candidate = specifier + suffix;
      try {
        const result = await nextResolve(candidate, context);
        // 校验目标文件确实存在（file: URL）
        if (result.url.startsWith('file:')) {
          if (existsSync(fileURLToPath(result.url))) return result;
        } else {
          return result;
        }
      } catch {
        // 继续尝试下一种后缀
      }
    }
    throw err;
  }
}
