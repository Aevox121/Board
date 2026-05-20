#!/usr/bin/env node
/**
 * board CLI — 入口。
 *
 * 编译产物的相对 import 均带 `.js` 扩展名，可被 Node 原生 ESM 直接解析，
 * 无需解析钩子兜底。命令实现与路由见 `cli.ts` 及 `commands/`。
 */
import { run } from './cli.js';

await run();
