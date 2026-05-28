/**
 * `board mcp <白板路径>` — 启动 MCP Server（stdio），把白板操作暴露为与 CLI
 * 等价的 MCP 工具集（规格 §3 / §4）。
 *
 * 设计：每个 MCP 工具直接复用对应的 CLI 命令函数（`cmd*`）—— 工具与 CLI
 * 「同源、能力等价」，无逻辑分叉。Agent 运行时（Claude Code / Codex）在其
 * MCP 配置中以 stdio 方式接入：
 *   { "command": "board", "args": ["mcp", "<白板路径>"] }
 *
 * 注意：stdout 被 MCP JSON-RPC 协议独占 —— 本进程任何诊断信息只走 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { guessMime, renderSceneSvg, regionsOf, type RenderOptions } from '@board/core';
import { readBoard } from '../util/board-io.js';
import { svgToPng } from '../util/rasterize.js';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { cmdNew } from './new.js';
import { cmdShow } from './show.js';
import { cmdTree } from './tree.js';
import { cmdAdd } from './add.js';
import { cmdMv } from './mv.js';
import { cmdRegion } from './region.js';
import { cmdTask } from './task.js';
import { cmdSuggest } from './suggest.js';
import { cmdShape } from './shape.js';
import { cmdConnect } from './connect.js';
import { cmdRm } from './rm.js';
import { cmdSearch } from './search.js';
import { cmdComment } from './comment.js';
import { cmdStyle } from './style.js';
import { cmdText } from './text.js';
import { cmdExport } from './export.js';
import { cmdImport } from './import.js';
import { cmdShare } from './share.js';
import { cmdLs } from './ls.js';
import { cmdDelete } from './delete.js';
import { cmdSnapshot, cmdRestore } from './snapshot.js';
import { cmdLog } from './log.js';
import { cmdElement } from './element.js';
import { cmdInfo } from './info.js';
import { cmdArrangeCommand } from './arrange.js';
import { cmdFlow } from './flow.js';

/** 由位置参数 / 选项 / 开关构造一个 ParsedArgs（喂给 cmd* 函数）。 */
function mkArgs(
  positionals: string[],
  options: Record<string, string | undefined> = {},
  flags: string[] = [],
): ParsedArgs {
  const opt = new Map<string, string>();
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) opt.set(k, v);
  }
  return { positionals, flags: new Set(flags), options: opt };
}

/** 文本型工具结果。 */
function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * 结构化工具结果 —— text 作为人类可读 fallback，data 作为机器可读载荷
 * 落到 MCP `structuredContent`（带 `outputSchema` 的工具用，spec 2024-11 后支持）。
 * 旧版客户端不读 structuredContent，只看 text，向后兼容。
 */
function structuredResult(text: string, data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * 尽力通知 server 刷新(写操作后让 Web 实时更新);server 未运行则忽略。
 * 多白板模式:传 boardId 时走 `/api/boards/<id>/refresh`,server 会精确广播给
 * 该 board 的订阅者;不传走 `/api/refresh`(server 回退到默认 board)。
 */
async function pingRefresh(port: string, boardId?: string): Promise<void> {
  const prefix =
    boardId !== undefined && boardId !== ''
      ? `/api/boards/${encodeURIComponent(boardId)}`
      : '/api';
  try {
    await fetch(`http://127.0.0.1:${port}${prefix}/refresh`, { method: 'POST' });
  } catch {
    // server 未运行 —— 操作本身已落盘,忽略刷新失败。
  }
}

/**
 * 执行一个 CLI 命令函数，把 CmdResult / CliError 转为 MCP 工具结果。
 * 内部使用 —— `runMcpServer` 里包了一层同名 `runCmd` 闭包来注入启动绑定的
 * Agent 身份，所有 registerTool 回调透过本地 `runCmd` 调用。
 * @param refreshPort 传入则在命令成功后 ping server 刷新（写操作用）。
 */
async function runCmdBare(
  label: string,
  fn: (a: ParsedArgs) => Promise<CmdResult>,
  args: ParsedArgs,
  refreshPort?: string,
  injectBoardIdFrom?: string,
): Promise<CallToolResult> {
  // server-direct 命令(cmdTask/cmdText/cmdSnapshot/cmdLog)位置参数不是 boardPath,
  // 它们读 'board-id' 选项决定 server 路由前缀。MCP 工具调用时给 injectBoardIdFrom
  // 传当前 boardPath,这里派生 boardId 注入 args.options。
  if (injectBoardIdFrom && !args.options.has('board-id')) {
    const id = injectBoardIdFrom.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
    args.options.set('board-id', id.replace(/\.board$/i, ''));
  }
  try {
    const r = await fn(args);
    const baseText = r.text ?? '';
    if (r.code !== 0) {
      return textResult(`${label}失败：${baseText}`, true);
    }
    if (refreshPort) {
      // 从 args 取 board-id(若工具 mkArgs 时塞了),让 refresh 走多白板路由。
      await pingRefresh(refreshPort, args.options.get('board-id'));
    }
    const text =
      r.data !== undefined
        ? `${baseText}\n${JSON.stringify(r.data, null, 2)}`.trim()
        : baseText || '(已完成)';
    // r.data 一律落到 structuredContent（带 outputSchema 的 read 工具直接消费；
    // 其余工具的客户端不读 structuredContent 则无害）。
    return r.data !== undefined ? structuredResult(text, r.data) : textResult(text);
  } catch (err) {
    const msg =
      err instanceof CliError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return textResult(`${label}失败：${msg}`, true);
  }
}

/**
 * 包装一个「直接处理器」（不经 cmd 函数的 MCP 工具），统一捕获异常转为错误结果。
 * board_read_file / board_get_element 等 MCP 专属工具用。
 */
async function safeHandler(
  label: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`${label}失败：${msg}`, true);
  }
}

/**
 * board_read_file 实现 —— 读 files/ 下某文件正文。MCP 专属（规格 §4 无对应
 * CLI 命令），故直接处理：目录穿越防护 + 仅文本类内联、二进制只给元信息。
 */
async function readBoardFile(
  boardPath: string,
  relPath: string,
): Promise<CallToolResult> {
  const rel = relPath.replace(/^[/\\]+/, '');
  if (rel === '' || rel.split(/[/\\]+/).includes('..')) {
    return textResult('board_read_file 失败：相对路径非法（为空或含 ".."）', true);
  }
  const dir = resolveBoardDir(boardPath, undefined);
  const filesRoot = join(dir, 'files');
  const abs = resolve(filesRoot, rel);
  const rootPrefix = filesRoot.endsWith(sep) ? filesRoot : filesRoot + sep;
  if (!abs.startsWith(rootPrefix)) {
    return textResult('board_read_file 失败：路径越出 files/ 范围', true);
  }
  if (!existsSync(abs)) {
    return textResult(`board_read_file 失败：文件不存在 files/${rel}`, true);
  }
  const mime = guessMime(rel);
  if (!(mime.startsWith('text/') || mime === 'application/json')) {
    const { size } = await stat(abs);
    return textResult(`（files/${rel} —— ${mime}，${size} 字节，二进制不内联）`);
  }
  const raw = await readFile(abs, 'utf8');
  const CAP = 20_000;
  return textResult(
    raw.length > CAP
      ? `${raw.slice(0, CAP)}\n…（已截断，原文共 ${raw.length} 字符）`
      : raw,
  );
}

/**
 * board_get_element 实现 —— 取单个元素的完整 JSON。MCP 专属（规格 §4 无对应
 * CLI 命令）。关键用途：取 suggestion 元素时连 `thread`（「描述」反馈回路里人
 * 留下的修改意见）一并返回，Agent 据此读回意见并修订建议（PRD §7.3）。
 */
async function getBoardElement(
  boardPath: string,
  elementId: string,
): Promise<CallToolResult> {
  const dir = resolveBoardDir(boardPath, undefined);
  const { scene } = await readBoard(dir);
  const el = scene.elements.find((e) => e.id === elementId);
  if (!el) {
    return textResult(`board_get_element 失败：未找到元素 ${elementId}`, true);
  }
  return structuredResult(JSON.stringify(el, null, 2), { element: el });
}

/**
 * board_render 实现 —— 渲白板缩略图，**回一张 PNG image content 让模型读图自查**
 * （M5 L4）。MCP 专属（无对应 CLI 命令直接产 image content）。
 *
 * 默认 png：core 拼 SVG → resvg 光栅化 → base64 image block，模型能真看到版面
 * （对齐 / 成组 / 出框 / 越界）。resvg 加载失败时回退返回 SVG 文本 + 提示。
 * format=svg 时直接回 SVG 文本（轻、可程序化检查，但模型不一定能「看」）。
 */
async function renderBoardImage(
  boardPath: string,
  a: { region?: string; bbox?: string; maxSize?: number; format?: 'png' | 'svg' },
): Promise<CallToolResult> {
  const dir = resolveBoardDir(boardPath, undefined);
  const { scene } = await readBoard(dir);

  const opts: RenderOptions = {};
  if (a.maxSize !== undefined) opts.maxSize = a.maxSize;
  if (a.bbox) {
    const p = a.bbox.split(',').map((s) => Number(s.trim()));
    if (p.length === 4 && p.every((n) => Number.isFinite(n)) && p[2]! > 0 && p[3]! > 0) {
      opts.bbox = { x: p[0]!, y: p[1]!, width: p[2]!, height: p[3]! };
    } else {
      return textResult('board_render 失败：bbox 必须形如 "x,y,w,h"（w/h 为正）', true);
    }
  }
  if (a.region) {
    const region = regionsOf(scene.elements).find(
      (r) => r.label === a.region || r.path === a.region,
    );
    if (!region) {
      return textResult(`board_render 失败：未找到区域 ${a.region}`, true);
    }
    opts.regionId = region.id;
  }

  const result = renderSceneSvg(scene, opts);
  const note =
    `已渲染 ${result.elementCount} 个元素 · ${result.pixelWidth}×${result.pixelHeight}px · ` +
    `视图 bbox=${result.bbox.x},${result.bbox.y},${result.bbox.width},${result.bbox.height}`;

  if (a.format === 'svg') {
    return {
      content: [{ type: 'text', text: `${note}\n\n${result.svg}` }],
    };
  }

  try {
    const png = await svgToPng(result.svg, result.pixelWidth);
    return {
      content: [
        { type: 'text', text: note },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: `${note}\n\n[PNG 光栅化失败，回退 SVG 文本：${msg}]\n\n${result.svg}`,
        },
      ],
      isError: false,
    };
  }
}

/**
 * board_subscribe_events 实现 —— 按游标增量拉取白板事件流。MCP 专属（规格 §5）。
 *
 * MCP 工具是请求/响应式、非长连接 —— 故以「游标轮询」落地：每次返回自 `since`
 * 以来的事件 + 最新 `cursor`，Agent 拿 cursor 作下次 since 再调。事件留存于
 * 运行中的 board-server（`GET /api/events/log`），server 未运行则报错。
 */
async function subscribeEvents(
  port: string,
  since: number | undefined,
  region: string | undefined,
  boardId?: string,
): Promise<CallToolResult> {
  const qs = new URLSearchParams();
  if (since !== undefined) qs.set('since', String(since));
  if (region) qs.set('region', region);
  const prefix =
    boardId !== undefined && boardId !== ''
      ? `/api/boards/${encodeURIComponent(boardId)}`
      : '/api';
  let env: { ok?: boolean; data?: unknown; error?: string | null };
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}${prefix}/events/log?${qs.toString()}`,
    );
    env = (await r.json()) as typeof env;
  } catch {
    return textResult(
      'board_subscribe_events 失败：无法连接 board-server —— 事件流需 server 在运行。',
      true,
    );
  }
  if (!env.ok) {
    return textResult(
      `board_subscribe_events 失败：${env.error ?? '未知错误'}`,
      true,
    );
  }
  return structuredResult(JSON.stringify(env.data, null, 2), env.data);
}

// ── read 工具的输出 schema（spec §4） ────────────────────────────
// MCP 客户端拿到这些 schema 可以验证 / typed-access structuredContent。
// shape 写宽松：未知字段 passthrough，避免与 cmd* 实现进化时不同步。

const ElementBriefShape = z
  .object({
    id: z.string(),
    type: z.string(),
    path: z.string().optional(),
    summary: z.string(),
    content: z.string().optional(),
  })
  .passthrough();

const RegionViewShape = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    fileCount: z.number(),
    elementCount: z.number(),
    elements: z.array(ElementBriefShape).optional(),
  })
  .passthrough();

const ConnectorViewShape = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    label: z.string().nullable(),
  })
  .passthrough();

const SuggestionViewShape = z
  .object({
    id: z.string(),
    targetId: z.string(),
    suggestionType: z.string(),
    status: z.string(),
    author: z.string(),
    reason: z.string(),
    threadLength: z.number(),
    payload: z.unknown().optional(),
    thread: z.array(z.unknown()).optional(),
  })
  .passthrough();

const ReadContextOutput = {
  name: z.string(),
  depth: z.number(),
  regions: z.array(RegionViewShape),
  loose: z
    .object({
      fileCount: z.number(),
      elementCount: z.number(),
      elements: z.array(ElementBriefShape).optional(),
    })
    .passthrough()
    .optional(),
  connectorCount: z.number().optional(),
  suggestionCount: z.number().optional(),
  connectors: z.array(ConnectorViewShape).optional(),
  suggestions: z.array(SuggestionViewShape).optional(),
};

const SearchOutput = {
  keyword: z.string(),
  count: z.number(),
  hits: z.array(
    z
      .object({
        elementId: z.string(),
        type: z.string(),
        field: z.string(),
        snippet: z.string(),
      })
      .passthrough(),
  ),
};

const GetElementOutput = {
  element: z.record(z.string(), z.unknown()),
};

const LogOutput = {
  entries: z.array(
    z
      .object({
        ts: z.string(),
        actor: z.string(),
        op: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
  source: z.enum(['server', 'disk']),
};

const InfoOutput = {
  id: z.string(),
  name: z.string(),
  elements: z.number(),
  regions: z.number(),
  files: z.number(),
  participants: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const SubscribeEventsOutput = {
  events: z.array(
    z
      .object({
        type: z.string(),
        actor: z.string().optional(),
        ts: z.string().optional(),
        payload: z.unknown().optional(),
      })
      .passthrough(),
  ),
  cursor: z.number(),
};

/** 判断目录是否为有效 .board(含 board.json)。 */
function isBoardDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, 'board.json'));
  } catch {
    return false;
  }
}

/** 从一个 root 目录扫一层 + 直接子层,找所有 .board 目录。 */
function scanBoardsRoot(root: string): string[] {
  const found = new Set<string>();
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '_trash' || e.name === 'node_modules') continue;
    const full = join(root, e.name);
    if (isBoardDir(full)) {
      found.add(full);
      continue;
    }
    // 下钻一层
    let subEntries: Dirent[] = [];
    try {
      subEntries = readdirSync(full, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const se of subEntries) {
      if (!se.isDirectory()) continue;
      const subFull = join(full, se.name);
      if (isBoardDir(subFull)) found.add(subFull);
    }
  }
  return [...found].sort();
}

/** boardPath → boardId(取 basename 去掉 .board 后缀)。 */
function deriveBoardId(boardPath: string): string {
  return basename(boardPath).replace(/\.board$/i, '');
}

/**
 * 启动 MCP Server(stdio)。Promise 在 Agent 断开 stdio 连接前不会 resolve。
 *
 * 多白板模式(2026-05):MCP 进程内维护「当前白板」状态,工具按以下优先级解析白板:
 *  1. 工具入参 `boardPath`(显式绝对路径或相对 boardsRoot)
 *  2. 工具入参 `boardId`(扫 boardsRoot 找匹配的 .board)
 *  3. 闭包状态 `currentBoardPath`(`board_open_board` 设置)
 *  4. 都没有 → 报错让 Agent 先 open_board
 *
 * @param opts.boardsRoot      boards 根目录(可选,缺省 cwd),用于扫描 / 新建 / boardId 解析
 * @param opts.initialBoard    启动期预选的当前白板(可选),给一个直接能用的 currentBoardPath
 * @param opts.port            board-server 端口(report_progress 与刷新用),默认 4500
 * @param opts.agentIdentity   启动时绑定的 Agent 身份;所有 MCP 工具默认以此
 *   归属操作,工具入参里仍可显式 `actor` 覆盖。`actor` 必填且以 `a_` 开头,
 *   `name` / `color` 可选。
 */
export async function runMcpServer(
  opts: {
    boardsRoot?: string;
    initialBoard?: string;
    port?: string;
    agentIdentity?: {
      actor?: string;
      name?: string;
      color?: string;
    };
  } = {},
): Promise<void> {
  const port = opts.port ?? '4500';
  const boardsRoot = opts.boardsRoot
    ? isAbsolute(opts.boardsRoot)
      ? opts.boardsRoot
      : resolve(process.cwd(), opts.boardsRoot)
    : process.cwd();
  const boundActor = opts.agentIdentity?.actor;
  const boundName = opts.agentIdentity?.name;
  const boundColor = opts.agentIdentity?.color;

  /** 当前白板路径(运行时可经 board_open_board 切换)。 */
  let currentBoardPath: string | undefined = undefined;
  if (opts.initialBoard !== undefined) {
    const abs = isAbsolute(opts.initialBoard)
      ? opts.initialBoard
      : resolve(boardsRoot, opts.initialBoard);
    if (isBoardDir(abs)) currentBoardPath = abs;
    else
      console.error(
        `[board mcp] 初始白板 ${opts.initialBoard} 不是有效 .board,忽略`,
      );
  }

  /**
   * 解析工具调用对应的白板路径。
   * 优先级:显式 boardPath > 显式 boardId > 当前白板。
   * @throws CliError 找不到白板时。调用方应 catch 转 textResult。
   */
  function resolveBoard(a?: {
    boardId?: string;
    boardPath?: string;
  }): string {
    if (a?.boardPath !== undefined && a.boardPath !== '') {
      const abs = isAbsolute(a.boardPath)
        ? a.boardPath
        : resolve(boardsRoot, a.boardPath);
      if (!isBoardDir(abs)) {
        throw new CliError(
          `boardPath 不是有效 .board(缺 board.json): ${a.boardPath}`,
          EXIT.NOT_FOUND,
        );
      }
      return abs;
    }
    if (a?.boardId !== undefined && a.boardId !== '') {
      const candidates = [
        join(boardsRoot, `${a.boardId}.board`),
        join(boardsRoot, a.boardId),
      ];
      for (const c of candidates) {
        if (isBoardDir(c)) return c;
      }
      // 兜底:扫一层子目录找 <id>.board
      for (const found of scanBoardsRoot(boardsRoot)) {
        if (deriveBoardId(found) === a.boardId) return found;
      }
      throw new CliError(
        `boardId "${a.boardId}" 在 boards-root(${boardsRoot}) 下找不到`,
        EXIT.NOT_FOUND,
      );
    }
    if (currentBoardPath !== undefined) return currentBoardPath;
    throw new CliError(
      '当前未选择白板:先调用 board_open_board 选,或工具入参里显式传 boardId/boardPath',
      EXIT.USAGE,
    );
  }

  /**
   * handler 包装器:resolveBoard 抛错时转为 MCP 错误结果,正常时把
   * boardPath 作为第一个参数喂给真正的 handler。
   */
  function withBoard<T extends { boardId?: string; boardPath?: string }>(
    fn: (boardPath: string, a: T) => Promise<CallToolResult>,
  ): (a: T) => Promise<CallToolResult> {
    return async (a) => {
      let bp: string;
      try {
        bp = resolveBoard(a);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(msg, true);
      }
      return fn(bp, a);
    };
  }

  /**
   * 把启动时绑定的 Agent 身份注入到本次 ParsedArgs:
   *   - `actor` 已显式传(工具入参 override) → 不动;
   *   - 未传 → 设为 boundActor。
   *   - `agent-name` / `agent-color` 同理:未显式传则填 bound 值。
   *
   * 注:`agent` 键在某些命令里是 payload(如 region assign 的被指派人),
   * 故只设 `actor`,不动 `agent`。resolveActor 优先取 actor 故无歧义。
   */
  function bindAgent(args: ParsedArgs): ParsedArgs {
    if (boundActor !== undefined && !args.options.has('actor')) {
      args.options.set('actor', boundActor);
    }
    if (boundName !== undefined && !args.options.has('agent-name')) {
      args.options.set('agent-name', boundName);
    }
    if (boundColor !== undefined && !args.options.has('agent-color')) {
      args.options.set('agent-color', boundColor);
    }
    return args;
  }

  /**
   * 本地 runCmd —— 注入身份后委托给模块级 runCmdBare。
   * `injectBoardIdFrom`(boardPath):传给走 server-direct 路径的 cmd*,让其
   * 多白板模式下正确路由(否则 server 回退默认 board → 撞错白板)。
   */
  const runCmd = (
    label: string,
    fn: (a: ParsedArgs) => Promise<CmdResult>,
    args: ParsedArgs,
    refreshPort?: string,
    injectBoardIdFrom?: string,
  ): Promise<CallToolResult> =>
    runCmdBare(label, fn, bindAgent(args), refreshPort, injectBoardIdFrom);

  /** 工具入参常用的「白板选择」字段(所有现存工具的 inputSchema 都加这俩)。 */
  const boardSelector = {
    boardId: z
      .string()
      .optional()
      .describe(
        '显式指定白板 id(= .board 目录名去掉 .board 后缀);省略 = 用当前白板' +
          '(board_open_board 切换的那个)。与 boardPath 二选一。',
      ),
    boardPath: z
      .string()
      .optional()
      .describe(
        '显式指定白板路径(绝对路径,或相对 boards-root);与 boardId 二选一。',
      ),
  };

  const server = new McpServer({ name: 'board', version: '0.2.0' });

  // ══ 白板管理工具(多白板模式新增) ══════════════════════════════
  //
  // 启动期 MCP 不绑死一个白板;Agent 经下面三个工具列出 / 切换 / 新建白板,
  // 其余 25 个工具默认对「当前白板」生效。

  // ── 管理:列出 boards-root 下所有白板 ─────────────────────────
  server.registerTool(
    'board_list_boards',
    {
      description:
        '列出 boards-root 下所有 .board 白板(扫一层 + 下钻一层),含当前白板' +
        '标记。board-server 在跑时优先取 server 托管列表(权威),否则扫盘。',
      inputSchema: {},
    },
    async () => {
      // 优先走 server(权威 — 含运行时新建的 board)
      // server 端 GET /api/boards 返回 `{boards: BoardSummary[]}`,不是 envelope。
      const serverBoards: Array<{
        id: string;
        name: string;
        dir: string;
        isDefault: boolean;
      }> = [];
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/boards`);
        if (r.ok) {
          const body = (await r.json()) as { boards?: typeof serverBoards };
          if (body.boards) serverBoards.push(...body.boards);
        }
      } catch {
        /* server 未起,回退到扫盘 */
      }

      const diskBoards = scanBoardsRoot(boardsRoot).map((dir) => ({
        id: deriveBoardId(dir),
        dir,
        source: 'disk' as const,
      }));

      // 合并:server 优先(标记 source=server),不在 server 的从 disk 补
      const merged = new Map<string, {
        id: string;
        name?: string;
        dir: string;
        source: 'server' | 'disk';
        isDefault?: boolean;
        isCurrent: boolean;
      }>();
      for (const b of serverBoards) {
        merged.set(b.id, {
          id: b.id,
          name: b.name,
          dir: b.dir,
          source: 'server',
          isDefault: b.isDefault,
          isCurrent: currentBoardPath === b.dir,
        });
      }
      for (const b of diskBoards) {
        if (!merged.has(b.id)) {
          merged.set(b.id, {
            id: b.id,
            dir: b.dir,
            source: 'disk',
            isCurrent: currentBoardPath === b.dir,
          });
        }
      }
      const list = [...merged.values()];
      const currentId =
        currentBoardPath !== undefined ? deriveBoardId(currentBoardPath) : null;
      const text =
        list.length === 0
          ? `boards-root(${boardsRoot}) 下未发现白板。`
          : list
              .map(
                (b) =>
                  `${b.isCurrent ? '* ' : '  '}${b.id}${b.name ? `  ${b.name}` : ''}  [${b.source}${b.isDefault ? ',default' : ''}]\n    ${b.dir}`,
              )
              .join('\n');
      return structuredResult(
        `boards-root: ${boardsRoot}\n当前白板: ${currentId ?? '(未选择)'}\n\n${text}`,
        { boardsRoot, current: currentId, boards: list },
      );
    },
  );

  // ── 管理:切换当前白板 ────────────────────────────────────────
  server.registerTool(
    'board_open_board',
    {
      description:
        '把指定白板设为当前白板(此后所有不显式带 boardId/boardPath 的工具' +
        '都默认对它生效)。boardId 或 boardPath 二选一。',
      inputSchema: {
        boardId: z
          .string()
          .optional()
          .describe('要打开的白板 id(= .board 目录名去掉 .board)。'),
        boardPath: z
          .string()
          .optional()
          .describe('要打开的白板路径(绝对或相对 boards-root)。'),
      },
    },
    async (a) => {
      let bp: string;
      try {
        bp = resolveBoard(a);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(msg, true);
      }
      currentBoardPath = bp;
      const id = deriveBoardId(bp);
      return structuredResult(
        `已切换当前白板为 ${id}\n  ${bp}`,
        { boardId: id, boardPath: bp },
      );
    },
  );

  // ── 管理:新建白板 ───────────────────────────────────────────
  server.registerTool(
    'board_create_board',
    {
      description:
        '新建一个空白白板。board-server 在跑时经 POST /api/boards 让 server ' +
        '装入运行时(Web 端即时可见);否则回退到 fs 直建(cmd new --dir boards-root)。' +
        '建好后默认不切换为当前白板,需 Agent 显式调用 board_open_board。',
      inputSchema: {
        name: z.string().describe('白板名称(将作为目录名 <name>.board)'),
        openAfterCreate: z
          .boolean()
          .optional()
          .describe('建好后立即设为当前白板(默认 false)'),
      },
    },
    async (a) => {
      // 优先 server。server POST /api/boards 成功返回 201 + BoardSummary(非 envelope);
      // 失败走 fail() 信封 `{ok:false, error: ...}`。
      let created: { id: string; name: string; dir: string } | null = null;
      let serverReached = false;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/boards`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: a.name }),
        });
        serverReached = true;
        const body = (await r.json()) as
          | { id: string; name: string; dir: string }
          | { ok?: false; error?: string };
        if (!r.ok) {
          const msg =
            (body as { error?: string }).error ?? `HTTP ${r.status}`;
          return textResult(`board_create_board 失败(server):${msg}`, true);
        }
        created = body as { id: string; name: string; dir: string };
      } catch {
        /* server 未起 — 回退到 cmd new */
      }
      if (!created && !serverReached) {
        try {
          const r = await cmdNew(
            mkArgs([a.name], { dir: boardsRoot }),
          );
          if (r.code !== 0) {
            return textResult(`board_create_board 失败:${r.text ?? ''}`, true);
          }
          const data = r.data as { dir: string; id: string; name: string };
          created = data;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`board_create_board 失败:${msg}`, true);
        }
      }
      if (!created) {
        return textResult('board_create_board 失败:未知原因,无返回数据', true);
      }
      if (a.openAfterCreate) currentBoardPath = created.dir;
      return structuredResult(
        `已创建白板 ${created.id}  ${created.name}\n  ${created.dir}${a.openAfterCreate ? '\n(已设为当前白板)' : ''}`,
        created,
      );
    },
  );

  // ── 读：白板上下文 ──────────────────────────────────────────
  server.registerTool(
    'board_read_context',
    {
      description:
        '读取白板上下文（Board Context）：区域、元素、连线、建议的概览，供 Agent ' +
        '理解白板当前状态。渐进式披露 —— 先 depth 0 看概览，再按需取更深层级。',
      inputSchema: {
        ...boardSelector,
        depth: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe('渐进式披露层级：0 概览 / 1 含元素列表 / 2 含元素正文'),
        region: z
          .string()
          .optional()
          .describe('只看某个区域时传其名称；省略 = 全板'),
      },
      outputSchema: ReadContextOutput,
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_read_context',
        cmdShow,
        mkArgs([boardPath], {
          depth: a.depth !== undefined ? String(a.depth) : undefined,
          region: a.region,
        }),
      )),
  );

  // ── 读：白板元信息 + 统计 ────────────────────────────────────
  server.registerTool(
    'board_info',
    {
      description:
        '取白板的元信息与全板统计(对照 board_read_context: 那是场景/区域结构,' +
        '本工具是 meta + counts)。返回 id / name / 元素数 / 区域数 / 文件数 / ' +
        '参与者数 / 创建与更新时间。',
      inputSchema: { ...boardSelector },
      outputSchema: InfoOutput,
    },
    withBoard(async (boardPath) => runCmd('board_info', cmdInfo, mkArgs([boardPath]))),
  );

  // ── 读：文件树 ──────────────────────────────────────────────
  server.registerTool(
    'board_list_files',
    {
      description: '以文件树形式列出白板 files/ 下的全部文件与文件夹。',
      inputSchema: { ...boardSelector },
    },
    withBoard(async (boardPath) => runCmd('board_list_files', cmdTree, mkArgs([boardPath]))),
  );

  // ── 写：创建区域 ────────────────────────────────────────────
  server.registerTool(
    'board_create_region',
    {
      description: '创建一个区域（= 在 files/ 下建一个文件夹）。',
      inputSchema: {
        ...boardSelector,
        name: z.string().describe('区域名'),
        description: z.string().optional().describe('区域用途描述'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_create_region',
        cmdRegion,
        mkArgs(['create', boardPath, a.name], { desc: a.description }),
        port,
      )),
  );

  // ── 写：添加文本卡片 ────────────────────────────────────────
  server.registerTool(
    'board_add_text',
    {
      description:
        '在白板上添加一张 Markdown 文本卡片。draft=true 时为「进行中」草稿态' +
        '（半透明虚线渲染），可由 report_progress 的 finish 阶段转为正式。',
      inputSchema: {
        ...boardSelector,
        markdown: z.string().describe('卡片正文（Markdown）'),
        at: z
          .string()
          .optional()
          .describe(
            '锚点坐标 "x,y"（元素左上角偏好位置）。**引擎保证不堆叠**：放在 at，' +
              '若被占则自动就近避让到空位。省略则纯自动落位。推荐用 at（不必精算间距）。',
          ),
        forceAt: z
          .string()
          .optional()
          .describe(
            '硬坐标 "x,y"，跳过避让直接落（你自负不与他人重叠）。仅在你已自行算好' +
              '整批互不重叠坐标时用；一般用 at 即可。与 at 互斥。',
          ),
        size: z
          .string()
          .optional()
          .describe(
            '尺寸 "w" 或 "w,h"。文本卡宽度固定、高度随内容自适应 —— 给宽度 w ' +
              '控制折行（默认 280，装长文 / 大标题时建议加宽到 400-600 免得被撑太高）；' +
              'h 可选，仅作初值（web 仍按实际渲染精修高度）。',
          ),
        draft: z.boolean().optional().describe('是否为 draft 草稿态'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_add_text',
        cmdAdd,
        mkArgs(
          ['text', boardPath, a.markdown],
          { at: a.at, 'force-at': a.forceAt, size: a.size, actor: a.agent },
          a.draft ? ['draft'] : [],
        ),
        port,
      )),
  );

  // ── 写：流式文本卡 ──────────────────────────────────────────
  // 与 board_add_text 区别：先开空卡得 elementId，再多次 append 追加 markdown。
  // 浏览器看到打字动画 + Agent 焦点光标按行号同步移动（PRD §7.4）。
  // LLM 流式输出可直接接入：for chunk in stream → board_text_stream_append。
  server.registerTool(
    'board_text_stream_create',
    {
      description:
        '开一张空 Markdown 文本卡（流式工作流起手）。返回 elementId，后续用 ' +
        'board_text_stream_append 多次追加内容。' +
        '\n\n⚠️ 关键约束：**文本卡 bbox 会随内容生长（高度自适应，不会滚动）**。' +
        '宽度按你指定的 width 固定（用于文字换行）；高度自动撑大到容纳全部行。' +
        '所以摆放时 **务必估算最终行数 × 20px 余量**：要写 N 行就在该卡下方至少留 ' +
        'N × 22px 的纵向空间，否则会与下方元素重叠。' +
        '需要 board-server 在运行。',
      inputSchema: {
        ...boardSelector,
        region: z.string().optional().describe('区域名（卡片归属该区域；不传则落画布顶层）'),
        at: z
          .string()
          .optional()
          .describe('坐标 "x,y"：带 region 时为区域内偏移，不带时为画布绝对坐标'),
        size: z
          .string()
          .optional()
          .describe(
            '大小 "w,h"，默认 480,200。h 是初始高度，实际会按内容自适应增长。' +
              'w 决定文字换行，要为预期最长行留够宽度。',
          ),
        markdown: z.string().optional().describe('初始 markdown（一般留空，靠 append 喂入）'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_text_stream_create',
        cmdText,
        mkArgs(
          ['create'],
          {
            region: a.region,
            at: a.at,
            size: a.size,
            markdown: a.markdown,
            actor: a.agent,
            port,
          },
        ),
        port,
        boardPath,
      )),
  );

  server.registerTool(
    'board_text_stream_append',
    {
      description:
        '给已存在的文本卡 markdown 追加一段（Y.Text 字符级 CRDT，浏览器看到 ' +
        '打字动画 + Agent 光标 jitter）。LLM 流式输出的每个 chunk / 段落都可调一次。' +
        '\n\n⚠️ 追加会导致文本卡高度增长（向下扩展）；如果下方紧邻其它元素会' +
        '产生视觉重叠 —— 摆位时应预留余量，或在追加前用 board_add_text / ' +
        '其它工具调整周围元素位置。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('文本卡元素 id（board_text_stream_create 返回值）'),
        chunk: z.string().describe('要追加的文本片段（保留 \\n 等格式字符）'),
        line: z
          .number()
          .optional()
          .describe('行号（0-indexed）—— 让 Agent 焦点光标钉到该行；缺省自动算'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_text_stream_append',
        cmdText,
        mkArgs(
          ['append', a.elementId, a.chunk],
          {
            line: a.line !== undefined ? String(a.line) : undefined,
            actor: a.agent,
            port,
          },
        ),
        port,
        boardPath,
      )),
  );

  // ── 写：整体替换文本卡 markdown ────────────────────────────
  // 与 stream_append 区别:这是「Agent 改主意了,这版用这个」的整体重置;
  // 走 server 的 Y.Text reset,保证 Y.Doc 与 disk 同步(disk 直写会被 Y.Doc
  // stale 内容覆盖)。位置/尺寸/连线不动,仅换文本。
  server.registerTool(
    'board_edit_text',
    {
      description:
        '整体替换一张 text 元素的 markdown(不动位置/尺寸/连线)。Agent 修订' +
        'draft 内容、重写整段时使用 —— 比删元素重建保留 elementId 与既有连线。' +
        '\n\n与 board_text_stream_append 区别:append 是字符级 CRDT 追加(打字' +
        '动画,流式),本工具是整体重置(一次性,无动画)。需 board-server 在运行。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('目标 text 元素 id'),
        markdown: z.string().describe('新 markdown 全文(覆盖原内容)'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_edit_text',
        cmdText,
        mkArgs(['set', a.elementId], {
          markdown: a.markdown,
          actor: a.agent,
          port,
        }),
        port,
        boardPath,
      )),
  );

  // ── 写：上报任务进度（Pencil 式过程可视化）──────────────────
  server.registerTool(
    'board_report_progress',
    {
      description:
        'Pencil 式过程可视化：上报 Agent 任务进度。phase=start 新建占位任务卡' +
        '（返回 taskId）；progress 追加步骤 / 更新百分比；finish 完成任务并把' +
        ' draft 元素转为正式。需 board-server 在运行。',
      inputSchema: {
        ...boardSelector,
        phase: z.enum(['start', 'progress', 'finish']).describe('任务阶段'),
        title: z.string().optional().describe('start：任务标题（在做什么）'),
        region: z.string().optional().describe('start：任务卡所在区域名'),
        at: z
          .string()
          .optional()
          .describe('start：任务卡画布坐标 "x,y"（与 region 二选一）'),
        taskId: z.string().optional().describe('progress / finish：任务 id'),
        step: z.string().optional().describe('progress：步骤描述'),
        percent: z.number().optional().describe('progress：进度百分比 0–100'),
        summary: z.string().optional().describe('finish：结果说明'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写（仅 start 阶段生效）'),
      },
    },
    withBoard(async (boardPath, a): Promise<CallToolResult> => {
      if (a.phase === 'start') {
        if (!a.title) return textResult('start 阶段需要 title', true);
        return runCmd(
          'board_report_progress',
          cmdTask,
          mkArgs(['start'], {
            title: a.title,
            region: a.region,
            at: a.at,
            actor: a.agent,
            port,
          }),
          port,
          boardPath,
        );
      }
      if (!a.taskId) {
        return textResult(`${a.phase} 阶段需要 taskId`, true);
      }
      if (a.phase === 'progress') {
        return runCmd(
          'board_report_progress',
          cmdTask,
          mkArgs(['progress', a.taskId], {
            step: a.step,
            percent: a.percent !== undefined ? String(a.percent) : undefined,
            port,
          }),
          port,
          boardPath,
        );
      }
      return runCmd(
        'board_report_progress',
        cmdTask,
        mkArgs(['finish', a.taskId], { summary: a.summary, port }),
        port,
        boardPath,
      );
    }),
  );

  // ── 写：创建建议（建议机制，PRD §7.3）────────────────────────
  server.registerTool(
    'board_create_suggestion',
    {
      description:
        '对某个元素创建一条建议（PRD §7.3）。Agent 要改不属于自己的内容时，' +
        '不直接改原件，而是在旁边产生一条「建议」，由人决定同意 / 拒绝 / 描述。' +
        'replace = 提议替换目标内容，add = 提议新增一个元素。' +
        '关键：`markdown` 只放「同意后会并入白板的纯内容」，把「为什么这么改」' +
        '之类的说明放进 `reason` —— 二者分开，同意时只并入 markdown，reason 不并入。',
      inputSchema: {
        ...boardSelector,
        targetId: z.string().describe('被建议的目标元素 id'),
        markdown: z
          .string()
          .describe('提议内容（Markdown）—— 同意后并入目标的纯内容，不要混入理由'),
        reason: z
          .string()
          .optional()
          .describe('建议理由：为什么这么改 / 改了什么；只在建议卡展示，同意时不并入目标'),
        suggestionType: z
          .enum(['replace', 'add'])
          .optional()
          .describe('replace 替换目标 / add 新增元素，默认 replace'),
        agent: z
          .string()
          .optional()
          .describe('发起建议的 Agent id（写入 authorId）'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_create_suggestion',
        cmdSuggest,
        mkArgs(
          ['create', boardPath, a.targetId],
          {
            type: a.suggestionType ?? 'replace',
            as: `text:${a.markdown}`,
            reason: a.reason,
            actor: a.agent,
          },
        ),
        port,
      )),
  );

  // ── 写：处理建议 — accept / reject / describe（PRD §7.3 反馈回路）─────
  // 决策权不只在人手里 —— Agent-to-Agent 建议同样适用：被指派区域的 Agent
  // 可以直接处理别人提给它的建议（如 Codex 给 Claude 提的建议,Claude 可
  // accept/reject/describe）。
  server.registerTool(
    'board_accept_suggestion',
    {
      description:
        '同意一条建议：replace 替换目标内容 / add 落地新元素,移除建议元素。' +
        'Agent 处理「提给自己的建议」时使用本工具。',
      inputSchema: {
        ...boardSelector,
        suggestionId: z.string().describe('被处理的建议元素 id'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_accept_suggestion',
        cmdSuggest,
        mkArgs(['accept', boardPath, a.suggestionId], { actor: a.agent }),
        port,
      )),
  );

  server.registerTool(
    'board_reject_suggestion',
    {
      description:
        '拒绝一条建议：删除建议元素,原件不变。Agent 不接受别人提给它的建议时使用。',
      inputSchema: {
        ...boardSelector,
        suggestionId: z.string().describe('被拒绝的建议元素 id'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_reject_suggestion',
        cmdSuggest,
        mkArgs(['reject', boardPath, a.suggestionId], { actor: a.agent }),
        port,
      )),
  );

  server.registerTool(
    'board_describe_suggestion',
    {
      description:
        '向建议追加一条反馈（写入 thread,建议元素保留）。形成「建议 ↔ 反馈」' +
        '迭代回路：下一轮提建议方读 thread 修订建议。Agent 收到不满意的建议' +
        '但想给出修改方向时使用,默认 role=agent；人在 Web 端写描述时 role=human。' +
        '读 thread 用 board_get_element(对 suggestion 元素会返回 thread 字段)。',
      inputSchema: {
        ...boardSelector,
        suggestionId: z.string().describe('被反馈的建议元素 id'),
        text: z.string().describe('反馈正文（说明哪里不满意 / 想怎么改）'),
        role: z
          .enum(['human', 'agent'])
          .optional()
          .describe('反馈来源,默认 agent（本工具被 Agent 调用时合理默认）'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_describe_suggestion',
        cmdSuggest,
        mkArgs(['describe', boardPath, a.suggestionId], {
          text: a.text,
          role: a.role,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：添加几何图形（画流程图）────────────────────────────
  server.registerTool(
    'board_add_shape',
    {
      description:
        '添加一个几何图形（rectangle / ellipse / diamond）。Agent 画流程图用 —— ' +
        '配合 board_connect 连线即可表达方框 + 箭头的流程图。手绘不开放。' +
        '**摆放由引擎仲裁、保证不堆叠**：给 at 当锚点、被占自动避让，省略则自动落位。' +
        '画多个节点想要规整网格时，建议直接用 board_add_flow（引擎整体排版）。',
      inputSchema: {
        ...boardSelector,
        kind: z
          .enum(['rectangle', 'ellipse', 'diamond'])
          .describe('图形类型'),
        label: z.string().optional().describe('图形内文字（流程图节点名）'),
        at: z
          .string()
          .optional()
          .describe(
            '锚点坐标 "x,y"（偏好位置）。引擎放在 at、被占则就近避让到空位（不堆叠）。' +
              '省略则纯自动落位。推荐用 at，不必精算间距。',
          ),
        forceAt: z
          .string()
          .optional()
          .describe(
            '硬坐标 "x,y"，跳过避让直接落（自负不重叠）。仅在已算好整批互不重叠坐标时用。与 at 互斥。',
          ),
        size: z
          .string()
          .optional()
          .describe('尺寸 "w,h"；省略用默认 160x72'),
        region: z.string().optional().describe('放入的区域名'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_add_shape',
        cmdShape,
        mkArgs(['add', boardPath, a.kind], {
          label: a.label,
          at: a.at,
          'force-at': a.forceAt,
          size: a.size,
          region: a.region,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：在两元素间连线 ──────────────────────────────────────
  server.registerTool(
    'board_connect',
    {
      description:
        '在两个元素之间连一条线 / 箭头。可连接任意元素 —— 图形 / 文件卡 / ' +
        '文本卡 / 区域；连线自动贴元素边缘、随元素移动与缩放实时跟随，不会戳进' +
        '卡片内部。画流程图：先 board_add_shape 建节点，再用本工具连。',
      inputSchema: {
        ...boardSelector,
        from: z.string().describe('源元素 id'),
        to: z.string().describe('目标元素 id'),
        label: z.string().optional().describe('连线上的文字'),
        arrow: z
          .enum(['none', 'arrow', 'triangle', 'dot'])
          .optional()
          .describe('末端箭头样式，默认 arrow；none = 纯直线'),
        routing: z
          .enum(['straight', 'orthogonal', 'curved'])
          .optional()
          .describe('走线方式，默认 straight'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_connect',
        cmdConnect,
        mkArgs([boardPath, a.from, a.to], {
          label: a.label,
          arrow: a.arrow,
          routing: a.routing,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：把一批元素重排成整齐布局（M5 L3）────────────────────
  server.registerTool(
    'board_arrange',
    {
      description:
        '把一批**已有**元素重排成整齐布局（grid / row / column）。' +
        '用于：你逐个 add 了若干元素（引擎已保证它们不堆叠、但只是散落）后，' +
        '一次把它们排成网格 / 一行 / 一列。算完整批坐标原子写回，结果即整齐。' +
        '目标二选一：elementIds（按给定顺序）或 region（该区域全部子元素）。' +
        'connector / region / folder 不参与（连线跟随端点、容器移动不带子元素）。' +
        '需要「节点+边」的流程图 / 树状层级，用 board_add_flow（dagre）而非本工具。',
      inputSchema: {
        ...boardSelector,
        layout: z
          .enum(['grid', 'row', 'column'])
          .describe('布局：grid 网格 / row 一行平铺 / column 一列堆叠'),
        elementIds: z
          .array(z.string())
          .optional()
          .describe('要排版的元素 id 列表（按此顺序排布）；与 region 二选一'),
        region: z
          .string()
          .optional()
          .describe('排版该区域内的全部子元素（按场景顺序）；与 elementIds 二选一'),
        gap: z.number().optional().describe('元素间距 px，默认 24'),
        cols: z
          .number()
          .int()
          .optional()
          .describe('grid 列数；省略 = 自动 ceil(sqrt(n))（接近正方形）'),
        at: z
          .string()
          .optional()
          .describe(
            '整块左上角锚点 "x,y"；省略 = 维持当前包围盒左上角（原地重排）。' +
              '想把整块挪到空白处时传一个空位坐标。',
          ),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_arrange',
        cmdArrangeCommand,
        mkArgs([boardPath], {
          layout: a.layout,
          ids: a.elementIds && a.elementIds.length > 0 ? a.elementIds.join(',') : undefined,
          region: a.region,
          gap: a.gap !== undefined ? String(a.gap) : undefined,
          cols: a.cols !== undefined ? String(a.cols) : undefined,
          at: a.at,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：声明式流程图（M5 L3，dagre 分层）────────────────────
  server.registerTool(
    'board_add_flow',
    {
      description:
        '声明式画一张流程图 / 有向图：你只给「节点 + 边 + 方向」，引擎用 dagre 算出' +
        '互不重叠、按数据流分层的整批坐标，一次性建好全部节点（shape）+ 连线（connector），' +
        '返回每个节点 id → 实际元素 id。**画结构化的图（流程 / 树状 / 依赖）首选本工具**，' +
        '省去逐个 board_add_shape + 精算坐标 + board_connect。节点高度按 label 自动撑高（不出框）。' +
        '只是把若干无连线的卡片排齐用 board_arrange；单个图形用 board_add_shape。',
      inputSchema: {
        ...boardSelector,
        nodes: z
          .array(
            z.object({
              id: z.string().describe('节点局部 id（仅用于在 edges 里引用，与画布元素 id 无关）'),
              label: z.string().optional().describe('节点内文字'),
              kind: z
                .enum(['rectangle', 'ellipse', 'diamond'])
                .optional()
                .describe('图形类型，默认 rectangle'),
              width: z.number().optional().describe('显式宽度，默认 160'),
              height: z.number().optional().describe('显式高度；省略按 label 折行自动撑高'),
            }),
          )
          .describe('节点列表'),
        edges: z
          .array(
            z.object({
              from: z.string().describe('源节点 id（nodes 里的 id）'),
              to: z.string().describe('目标节点 id'),
              label: z.string().optional().describe('连线上的文字'),
            }),
          )
          .optional()
          .describe('有向边列表；省略 = 无连线（只分层摆节点）'),
        direction: z
          .enum(['TB', 'BT', 'LR', 'RL'])
          .optional()
          .describe('布局方向，默认 TB（自上而下）'),
        at: z
          .string()
          .optional()
          .describe('整图左上角锚点 "x,y"；省略 = 自动找空位（不压现有元素）'),
        region: z.string().optional().describe('把整图放进该区域（节点 parentId 设为区域）'),
        arrow: z
          .enum(['none', 'arrow', 'triangle', 'dot'])
          .optional()
          .describe('连线末端箭头，默认 arrow'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_add_flow',
        cmdFlow,
        mkArgs([boardPath], {
          nodes: JSON.stringify(a.nodes),
          edges: JSON.stringify(a.edges ?? []),
          direction: a.direction,
          at: a.at,
          region: a.region,
          arrow: a.arrow,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 读：搜索 ────────────────────────────────────────────────
  server.registerTool(
    'board_search',
    {
      description:
        '搜索白板：元素文字 / 文件名 / 文本类文件内容。结果含元素 id 与命中片段。',
      inputSchema: {
        ...boardSelector,
        keyword: z.string().describe('搜索关键词（大小写不敏感）'),
      },
      outputSchema: SearchOutput,
    },
    withBoard(async (boardPath, a) =>
      runCmd('board_search', cmdSearch, mkArgs([boardPath, a.keyword]))),
  );

  // ── 写：删除元素 ────────────────────────────────────────────
  server.registerTool(
    'board_delete_element',
    {
      description:
        '删除一个元素（text / shape / file / connector / image / suggestion）。file 元素的' +
        '真实文件移入回收站；引用该元素的连线 / 建议一并清理。' +
        '删区域请用 board_delete_region（级联 + 回收站）；folder 元素不在删除范围。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('要删除的元素 id'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_delete_element',
        cmdRm,
        mkArgs([boardPath, a.elementId]),
        port,
      )),
  );

  // ── 写：加评论 ──────────────────────────────────────────────
  server.registerTool(
    'board_add_comment',
    {
      description: '给某个元素加一条评论（PRD §8.4）。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('被评论的元素 id'),
        text: z.string().describe('评论内容'),
        agent: z.string().optional().describe('覆盖启动绑定的评论者 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_add_comment',
        cmdComment,
        mkArgs([boardPath, a.elementId, a.text], { actor: a.agent }),
        port,
      )),
  );

  // ── 写：改区域描述 ──────────────────────────────────────────
  server.registerTool(
    'board_describe_region',
    {
      description: '修改区域描述（同步落地为区域文件夹的 README.md）。',
      inputSchema: {
        ...boardSelector,
        region: z.string().describe('区域名'),
        description: z.string().describe('新的区域描述'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_describe_region',
        cmdRegion,
        mkArgs(['describe', boardPath, a.region], { desc: a.description }),
        port,
      )),
  );

  // ── 写：删除区域（级联 + 回收站）────────────────────────────
  server.registerTool(
    'board_delete_region',
    {
      description:
        '删除一个区域：级联删除其内的文件 / 子区域，引用被删元素的连线一并清理，' +
        '区域文件夹移入回收站（.runtime/trash/，可恢复）。按区域名删。' +
        '（区域是 file 元素的容器，不能用 board_delete_element 删——那个针对单个非容器元素。）',
      inputSchema: {
        ...boardSelector,
        region: z.string().describe('要删除的区域名'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_delete_region',
        cmdRegion,
        mkArgs(['rm', boardPath, a.region]),
        port,
      )),
  );

  // ── 写：指派区域给 Agent ────────────────────────────────────
  server.registerTool(
    'board_assign_region',
    {
      description:
        '把区域指派给某个 Agent（PRD §7.6 区域委派）—— Agent 的工作范围聚焦此区域。',
      inputSchema: {
        ...boardSelector,
        region: z.string().describe('区域名'),
        agent: z.string().describe('被指派的 Agent id'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_assign_region',
        cmdRegion,
        mkArgs(['assign', boardPath, a.region], { agent: a.agent }),
        port,
      )),
  );

  // ── 写：改元素样式 ──────────────────────────────────────────
  server.registerTool(
    'board_style_element',
    {
      description:
        '修改元素的统一样式（PRD §6.7）：描边色 / 填充色 / 描边宽度 / 线型 / 透明度。' +
        '可用于给元素做视觉编码（如重要项标红框）。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('目标元素 id'),
        stroke: z.string().optional().describe('描边色（hex 或颜色名）'),
        fill: z
          .string()
          .optional()
          .describe('填充 / 背景色；transparent 表示无'),
        strokeWidth: z.number().optional().describe('描边宽度 1–8'),
        strokeStyle: z
          .enum(['solid', 'dashed', 'dotted'])
          .optional()
          .describe('描边线型'),
        opacity: z.number().optional().describe('不透明度 0–100'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_style_element',
        cmdStyle,
        mkArgs([boardPath, a.elementId], {
          stroke: a.stroke,
          fill: a.fill,
          'stroke-width':
            a.strokeWidth !== undefined ? String(a.strokeWidth) : undefined,
          'stroke-style': a.strokeStyle,
          opacity: a.opacity !== undefined ? String(a.opacity) : undefined,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：添加本地文件 ────────────────────────────────────────
  server.registerTool(
    'board_add_file',
    {
      description:
        '把一个文件添加进白板（复制进 files/，可指定区域）。两种来源二选一：' +
        'source = 本地文件的绝对路径；或 content + filename = 由文本内容直接生成文件。',
      inputSchema: {
        ...boardSelector,
        source: z
          .string()
          .optional()
          .describe('本地文件的绝对路径（与 content 二选一）'),
        content: z
          .string()
          .optional()
          .describe('文件文本内容（与 source 二选一，需同时给 filename）'),
        filename: z
          .string()
          .optional()
          .describe('content 模式下生成的文件名（含扩展名）'),
        region: z.string().optional().describe('放入的区域名；省略 = 收件区'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a): Promise<CallToolResult> =>
      safeHandler('board_add_file', async () => {
        let src = a.source;
        let tmpDir: string | undefined;
        if (!src) {
          if (a.content === undefined || !a.filename) {
            return textResult(
              'board_add_file 失败：需要 source，或同时给出 content + filename',
              true,
            );
          }
          // content 模式：在临时目录里以目标文件名落盘，再走与 source 相同的
          // 复制路径（cmdAdd 取 basename 作 files/ 内的文件名）。
          tmpDir = await mkdtemp(join(tmpdir(), 'board-add-'));
          src = join(tmpDir, a.filename);
          await writeFile(src, a.content, 'utf8');
        }
        try {
          return await runCmd(
            'board_add_file',
            cmdAdd,
            mkArgs(['file', boardPath, src], {
              region: a.region,
              actor: a.agent,
            }),
            port,
          );
        } finally {
          if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
        }
      })),
  );

  // ── 写：添加本地目录 ────────────────────────────────────────
  server.registerTool(
    'board_add_folder',
    {
      description: '把一个本地目录（连同内部文件）整体添加进白板的 files/。',
      inputSchema: {
        ...boardSelector,
        source: z.string().describe('本地目录的绝对路径'),
        region: z.string().optional().describe('放入的区域名；省略 = 收件区'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_add_folder',
        cmdAdd,
        mkArgs(['folder', boardPath, a.source], {
          region: a.region,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：按画布坐标摆位元素（与 Web 端拖拽 / 缩放等价）────────
  server.registerTool(
    'board_move_element',
    {
      description:
        '按画布坐标重新摆位一个元素（可选改尺寸）。与 Web 端用户拖拽 / 缩放元素' +
        '等价。`board_move_file` 改的是 files/ 内的文件路径（=改归属 region），' +
        '本工具改的是元素在画布上的 (x, y) / (w, h)。' +
        '注意：`connector` 不能直接移动（位置由两端点派生，自动跟随被连元素）。' +
        '排版建议：流程图节点纵向中心间隔 ≥200、横向 ≥240，避免方框 / 连线 / 文字重叠。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('目标元素 id'),
        to: z
          .string()
          .describe('新画布坐标 "x,y"（元素左上角）'),
        size: z
          .string()
          .optional()
          .describe('新尺寸 "w,h"；省略 = 保持原尺寸'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_move_element',
        cmdElement,
        mkArgs(['move', boardPath, a.elementId], {
          to: a.to,
          size: a.size,
          actor: a.agent,
        }),
        port,
      )),
  );

  // ── 写：移动 files/ 内的文件（改归属 / 改名）─────────────────
  server.registerTool(
    'board_move_file',
    {
      description:
        '移动 / 重命名 files/ 内的一个文件，用相对 files/ 的路径表达。把文件移进' +
        '某区域文件夹即「改归属」（与 Web 端拖拽文件卡改归属等价）。文件的相对' +
        '路径可从 board_list_files 或 board_read_context 获得。',
      inputSchema: {
        ...boardSelector,
        from: z.string().describe('源文件相对 files/ 的路径，如 "tickets.pdf"'),
        to: z
          .string()
          .describe('目标相对路径，如 "路线/tickets.pdf"（即移进「路线」区域）'),
        agent: z.string().optional().describe('覆盖启动绑定的 Agent id；通常无需填写'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_move_file',
        cmdMv,
        mkArgs([boardPath, a.from, a.to], { actor: a.agent }),
        port,
      )),
  );

  // ── 读：读取 files/ 内某文件正文 ─────────────────────────────
  server.registerTool(
    'board_read_file',
    {
      description:
        '读取白板 files/ 下某个文件的正文。文本类文件内联返回内容（过长截断），' +
        '二进制文件只返回类型与大小。相对路径可从 board_list_files 获得。',
      inputSchema: {
        ...boardSelector,
        path: z.string().describe('相对 files/ 的文件路径，如 "路线/day1.md"'),
      },
    },
    withBoard(async (boardPath, a) =>
      safeHandler('board_read_file', () => readBoardFile(boardPath, a.path))),
  );

  // ── 读：取单个元素的完整详情 ────────────────────────────────
  server.registerTool(
    'board_get_element',
    {
      description:
        '取单个元素的完整详情（JSON）。对 suggestion 元素会连同 `thread` —— ' +
        '即「描述」反馈回路里人留下的修改意见 —— 一并返回，Agent 据此修订建议。',
      inputSchema: {
        ...boardSelector,
        elementId: z.string().describe('元素 id'),
      },
      outputSchema: GetElementOutput,
    },
    withBoard(async (boardPath, a) =>
      safeHandler('board_get_element', () =>
        getBoardElement(boardPath, a.elementId),
      )),
  );

  // ── 读：渲染白板缩略图（M5 L4，回 PNG 让模型读图自查）──────────
  server.registerTool(
    'board_render',
    {
      description:
        '把白板渲成一张缩略图并**直接返回 PNG 图片**，让你「看见」自己摆出来的版面 —— ' +
        '检查对齐 / 成组 / 留白 / 出框 / 越界这类肉眼才好判断的问题（堆叠已由摆放引擎兜住）。' +
        '建议：批量摆放 / 画流程图后调一次本工具自查，发现问题再用 board_arrange / element move 调整。' +
        '可选 region（只渲某区域）或 bbox（只渲某画布范围）聚焦细节。',
      inputSchema: {
        ...boardSelector,
        region: z.string().optional().describe('只渲染该区域（含其子元素）'),
        bbox: z
          .string()
          .optional()
          .describe('只渲染某画布范围 "x,y,w,h"；与 region 二选一，都不给则渲全板'),
        maxSize: z
          .number()
          .int()
          .optional()
          .describe('输出图最大边长 px，默认 1200；细看可调大'),
        format: z
          .enum(['png', 'svg'])
          .optional()
          .describe('png（默认，可视）/ svg（文本，轻量但模型不一定能看）'),
      },
    },
    withBoard(async (boardPath, a) =>
      safeHandler('board_render', () =>
        renderBoardImage(boardPath, {
          region: a.region,
          bbox: a.bbox,
          maxSize: a.maxSize,
          format: a.format,
        }),
      )),
  );

  // ── 读：订阅白板事件流（增量游标）─────────────────────────────
  server.registerTool(
    'board_subscribe_events',
    {
      description:
        '订阅白板事件流（specs §5）：取自上次游标以来的新事件 —— 元素增改移删 / ' +
        '文件变化 / 区域 / 建议 / Agent 任务等。用法：首次不传 since 拿到当前 ' +
        'events + cursor；之后每次把上次返回的 cursor 作为 since 再调，即可增量' +
        '获知白板变化，省去反复全量 board_read_context。需 board-server 在运行。',
      inputSchema: {
        ...boardSelector,
        since: z
          .number()
          .int()
          .optional()
          .describe('上次返回的 cursor；省略 = 从最早留存事件取起'),
        region: z
          .string()
          .optional()
          .describe('只看某区域的事件时传其名称；省略 = 全板'),
      },
      outputSchema: SubscribeEventsOutput,
    },
    withBoard(async (boardPath, a) =>
      safeHandler('board_subscribe_events', () =>
        subscribeEvents(port, a.since, a.region, deriveBoardId(boardPath)),
      )),
  );

  // ── 导出 / 导入 / 分享（PRD §10.2 与 CLI 对齐）─────────────────────
  //
  // 全部包装 cmdExport / cmdImport / cmdShare 等 CLI 函数 —— 与 CLI 同源
  // 同语义，避免逻辑分叉。其中 board_import 不绑当前白板（zip 解到任意
  // 目录新建一份），其他工具默认指向 MCP 启动时绑定的 `boardPath`。

  // 导出：默认 json 写 stdout / out 路径；zip 默认写 <name>.board.zip。
  server.registerTool(
    'board_export',
    {
      description:
        '导出整个白板。format=json 把 board.json 内容返回；out 指定时写到该路径。' +
        'format=zip 把 .board 目录全打包成 zip（含 board.json/meta.json/files/' +
        '/assets/...），out 缺省落到 cwd 的 <name>.board.zip。等价于 CLI ' +
        '`board export`，与 Web 顶栏的「导出 board.json / 导出 zip」对等。',
      inputSchema: {
        ...boardSelector,
        format: z
          .enum(['json', 'zip'])
          .optional()
          .describe('导出格式；默认 json'),
        out: z
          .string()
          .optional()
          .describe('输出路径；json 不传则把内容回到 MCP 调用方，zip 不传则 cwd'),
      },
    },
    withBoard(async (boardPath, a) => {
      const opts: Record<string, string | undefined> = {};
      if (a.out) opts['out'] = a.out;
      const flags = [a.format === 'zip' ? 'zip' : 'json'];
      return runCmd(
        'board_export',
        cmdExport,
        mkArgs([boardPath], opts, flags),
      );
    }),
  );

  // 导入：把 zip 还原成一个新 .board 目录；不绑当前白板。
  server.registerTool(
    'board_import',
    {
      description:
        '把 board export --zip 产生的压缩包恢复成一个 .board 目录。zip 根必须' +
        '含 board.json + meta.json；目标 = <dir>/<name>.board，目标已存在时拒绝' +
        '覆盖（请改 name 或先移走原目录）。',
      inputSchema: {
        zipPath: z.string().describe('要导入的 zip 文件路径'),
        name: z
          .string()
          .optional()
          .describe('新白板名（白板目录名 = <name>.board）；缺省取 zip 内 meta.name'),
        dir: z
          .string()
          .optional()
          .describe('新白板的父目录；缺省 cwd'),
      },
    },
    async (a) => {
      const opts: Record<string, string | undefined> = {};
      if (a.name) opts['name'] = a.name;
      if (a.dir) opts['dir'] = a.dir;
      return runCmd(
        'board_import',
        cmdImport,
        mkArgs([a.zipPath], opts),
      );
    },
  );

  // 分享：产出可分享 URL（M4 中继服务器，PRD §4.2）。
  server.registerTool(
    'board_share',
    {
      description:
        '生成可分享的白板 URL，形如 http://<host>:<port>/?board=<boardId>&token=...。' +
        '对应的 board-server 须以多 board 模式启动并加载该白板。host/port/scheme/' +
        'no_token 都可选；默认取 BOARD_SHARE_HOST / BOARD_SHARE_PORT 环境变量或 ' +
        'localhost:4510。',
      inputSchema: {
        ...boardSelector,
        host: z.string().optional().describe('URL 的 host；省略走环境变量或 localhost'),
        port: z.string().optional().describe('URL 的端口；省略走环境变量或 4510'),
        scheme: z.enum(['http', 'https']).optional().describe('默认 http'),
        no_token: z
          .boolean()
          .optional()
          .describe('true 时不在 URL 里拼 token（用于 BOARD_REQUIRE_TOKEN=false 部署）'),
      },
    },
    withBoard(async (boardPath, a) => {
      const opts: Record<string, string | undefined> = {};
      if (a.host) opts['host'] = a.host;
      if (a.port) opts['port'] = a.port;
      if (a.scheme) opts['scheme'] = a.scheme;
      const flags = a.no_token ? ['no-token'] : [];
      return runCmd(
        'board_share',
        cmdShare,
        mkArgs([boardPath], opts, flags),
      );
    }),
  );

  // ── 存档点（PRD §8.5，依赖运行中的 board-server）────────────────
  // 写操作（create / restore / delete）经 server HTTP；list 也走 server。
  // 因此这四个工具都要求 board-server 正在运行（与 CLI 同样语义）。

  server.registerTool(
    'board_snapshot_create',
    {
      description:
        '建一份手动存档点（PRD §8.5）。server 把当前 board.json/meta.json/files/ ' +
        '完整复制进 history/snapshots/<id>/。需 board-server 正在运行。',
      inputSchema: {
        ...boardSelector,
        name: z
          .string()
          .optional()
          .describe('快照名；缺省 = 自动生成（含时间戳）'),
      },
    },
    withBoard(async (boardPath, a) => {
      const opts: Record<string, string | undefined> = {};
      if (a.name) opts['name'] = a.name;
      return runCmd(
        'board_snapshot_create',
        cmdSnapshot,
        mkArgs(['create'], opts),
        port,
        boardPath,
      );
    }),
  );

  server.registerTool(
    'board_snapshot_list',
    {
      description:
        '列出当前白板的全部存档点（含手动 / 自动 / 复原前自动档）。需 board-server 正在运行。',
      inputSchema: { ...boardSelector },
    },
    withBoard(async (boardPath) =>
      runCmd('board_snapshot_list', cmdSnapshot, mkArgs(['ls']), undefined, boardPath)),
  );

  server.registerTool(
    'board_snapshot_delete',
    {
      description:
        '删除一份存档点（含磁盘目录 + meta 索引）。需 board-server 正在运行。',
      inputSchema: {
        ...boardSelector,
        snapshotId: z.string().describe('要删除的存档 id（取自 board_snapshot_list）'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_snapshot_delete',
        cmdSnapshot,
        mkArgs(['rm', a.snapshotId]),
        port,
        boardPath,
      )),
  );

  server.registerTool(
    'board_restore',
    {
      description:
        '一键复原到指定存档点。server 会先自动建 pre-restore 档（保留当前状态），' +
        '再把整套 board.json/meta.json/files/ 换成快照内容；Y.Doc 重新同步给所有 ' +
        'ws 客户端。需 board-server 正在运行。',
      inputSchema: {
        ...boardSelector,
        snapshotId: z.string().describe('要复原到的存档 id'),
      },
    },
    withBoard(async (boardPath, a) =>
      runCmd(
        'board_restore',
        cmdRestore,
        mkArgs([a.snapshotId]),
        port,
        boardPath,
      )),
  );

  // ── 操作日志（PRD §6.9）────────────────────────────────────
  // server 在跑就经 HTTP 拉；不在跑回退到磁盘直读 history/oplog.jsonl。
  server.registerTool(
    'board_log',
    {
      description:
        '读 oplog（PRD §6.9），按时间倒序后再正序输出末尾 N 条；server 不可达' +
        '时回退磁盘直读 history/oplog.jsonl。每条含 ts / actor / op / details。' +
        '比 board_subscribe_events 留存更长（事件流是内存环），适合事后审计。',
      inputSchema: {
        ...boardSelector,
        tail: z
          .number()
          .int()
          .optional()
          .describe('要拉取的末尾条数（默认 50，上限 1000）'),
      },
      outputSchema: LogOutput,
    },
    withBoard(async (boardPath, a) => {
      const opts: Record<string, string | undefined> = { port };
      if (a.tail !== undefined) opts['tail'] = String(a.tail);
      return runCmd(
        'board_log',
        cmdLog,
        mkArgs([boardPath], opts),
        undefined,
        boardPath,
      );
    }),
  );

  // 列出某根目录下所有 .board（fs 扫描，不依赖 server）。
  server.registerTool(
    'board_list',
    {
      description:
        '列出指定 root 目录及其一层子目录下的 .board 文件夹。等价于 CLI `board ls [root]`。' +
        'root 省略时取 cwd。仅扫描文件系统，不依赖 board-server。',
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe('要扫描的根目录；省略 = cwd'),
      },
    },
    async (a) => {
      const positionals = a.root ? [a.root] : [];
      return runCmd('board_list', cmdLs, mkArgs(positionals, {}));
    },
  );

  // 删除一个 .board 目录 —— 移到同级 _trash/<timestamp>-<basename>，不真删。
  server.registerTool(
    'board_delete',
    {
      description:
        '删除一个白板 —— 把 .board 目录移到同级 _trash/<timestamp>-<basename>，' +
        '不真删，必要时人工恢复。等价于 CLI `board delete <.board 目录>`。' +
        '⚠️ 该 board 若正被 board-server 加载，应先用 DELETE /api/boards/<id> ' +
        '关 runtime，再调用此工具，避免 chokidar 内存集不一致。',
      inputSchema: {
        boardDir: z
          .string()
          .describe('.board 目录路径（绝对或相对 cwd）'),
      },
    },
    async (a) => runCmd('board_delete', cmdDelete, mkArgs([a.boardDir], {})),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const idLine = boundActor
    ? `Agent=${boundActor}${boundName ? ` "${boundName}"` : ''}${boundColor ? ` ${boundColor}` : ''}`
    : 'Agent=（未绑定，回退 u_local）';
  const currentLine =
    currentBoardPath !== undefined
      ? `当前白板：${deriveBoardId(currentBoardPath)} (${currentBoardPath})`
      : '当前白板：（未选择 — Agent 需先 board_open_board）';
  console.error(
    `[board mcp] MCP Server 已启动（stdio）｜ boards-root: ${boardsRoot} ｜ ${currentLine} ｜ ${idLine}`,
  );

  // 阻塞直到 Agent 断开 stdio 连接 —— 否则进程会立即退出、连接中断。
  await new Promise<void>((resolve) => {
    transport.onclose = (): void => resolve();
  });
}
