#!/usr/bin/env node
/**
 * board CLI — 启动引导（bootstrap）
 *
 * 职责：在加载任何业务模块前，先注册 ESM 解析钩子（见 loader.ts），
 * 让无扩展名的编译产物（含 `@board/core` 的 dist）能被 Node 原生 ESM 运行。
 * 之后再动态 import 真正的入口 `cli`。
 *
 * 命令实现与路由见 `cli.ts` 及 `commands/`。
 */
import { register } from 'node:module';

// 注册解析钩子（指向同目录编译产物 loader.js）。
// 第二参数为 parentURL，用本文件 URL，使 './loader.js' 能被定位。
register('./loader.js', import.meta.url);

// 钩子已就位，动态 import 业务入口（其内部的无扩展名 import 由钩子兜底）。
const { run } = await import('./cli.js');
await run();
