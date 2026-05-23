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
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBoard } from '@board/core/node';
import { guessMime } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
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

/** 尽力通知 server 刷新（写操作后让 Web 实时更新）；server 未运行则忽略。 */
async function pingRefresh(port: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });
  } catch {
    // server 未运行 —— 操作本身已落盘，忽略刷新失败。
  }
}

/**
 * 执行一个 CLI 命令函数，把 CmdResult / CliError 转为 MCP 工具结果。
 * @param refreshPort 传入则在命令成功后 ping server 刷新（写操作用）。
 */
async function runCmd(
  label: string,
  fn: (a: ParsedArgs) => Promise<CmdResult>,
  args: ParsedArgs,
  refreshPort?: string,
): Promise<CallToolResult> {
  try {
    const r = await fn(args);
    const baseText = r.text ?? '';
    if (r.code !== 0) {
      return textResult(`${label}失败：${baseText}`, true);
    }
    if (refreshPort) await pingRefresh(refreshPort);
    const text =
      r.data !== undefined
        ? `${baseText}\n${JSON.stringify(r.data, null, 2)}`.trim()
        : baseText || '(已完成)';
    return textResult(text);
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
  const handle = await loadBoard(dir);
  const el = handle.scene.elements.find((e) => e.id === elementId);
  if (!el) {
    return textResult(`board_get_element 失败：未找到元素 ${elementId}`, true);
  }
  return textResult(JSON.stringify(el, null, 2));
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
): Promise<CallToolResult> {
  const qs = new URLSearchParams();
  if (since !== undefined) qs.set('since', String(since));
  if (region) qs.set('region', region);
  let env: { ok?: boolean; data?: unknown; error?: string | null };
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/events/log?${qs.toString()}`,
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
  return textResult(JSON.stringify(env.data, null, 2));
}

/**
 * 启动 MCP Server（stdio）。Promise 在 Agent 断开 stdio 连接前不会 resolve。
 *
 * @param boardPath 白板目录（.board）路径
 * @param port      board-server 端口（report_progress 与刷新用），默认 4500
 */
export async function runMcpServer(
  boardPath: string,
  port = '4500',
): Promise<void> {
  const server = new McpServer({ name: 'board', version: '0.1.0' });

  // ── 读：白板上下文 ──────────────────────────────────────────
  server.registerTool(
    'board_read_context',
    {
      description:
        '读取白板上下文（Board Context）：区域、元素、连线、建议的概览，供 Agent ' +
        '理解白板当前状态。渐进式披露 —— 先 depth 0 看概览，再按需取更深层级。',
      inputSchema: {
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
    },
    async (a) =>
      runCmd(
        'board_read_context',
        cmdShow,
        mkArgs([boardPath], {
          depth: a.depth !== undefined ? String(a.depth) : undefined,
          region: a.region,
        }),
      ),
  );

  // ── 读：文件树 ──────────────────────────────────────────────
  server.registerTool(
    'board_list_files',
    {
      description: '以文件树形式列出白板 files/ 下的全部文件与文件夹。',
      inputSchema: {},
    },
    async () => runCmd('board_list_files', cmdTree, mkArgs([boardPath])),
  );

  // ── 写：创建区域 ────────────────────────────────────────────
  server.registerTool(
    'board_create_region',
    {
      description: '创建一个区域（= 在 files/ 下建一个文件夹）。',
      inputSchema: {
        name: z.string().describe('区域名'),
        description: z.string().optional().describe('区域用途描述'),
      },
    },
    async (a) =>
      runCmd(
        'board_create_region',
        cmdRegion,
        mkArgs(['create', boardPath, a.name], { desc: a.description }),
        port,
      ),
  );

  // ── 写：添加文本卡片 ────────────────────────────────────────
  server.registerTool(
    'board_add_text',
    {
      description:
        '在白板上添加一张 Markdown 文本卡片。draft=true 时为「进行中」草稿态' +
        '（半透明虚线渲染），可由 report_progress 的 finish 阶段转为正式。',
      inputSchema: {
        markdown: z.string().describe('卡片正文（Markdown）'),
        at: z
          .string()
          .optional()
          .describe(
            '画布坐标 "x,y"（元素左上角）；省略则自动避让落位（不与现有元素' +
              '重叠）。手工指定时务必为相邻元素留足间距，避免方框 / 连线 / 文字重叠',
          ),
        draft: z.boolean().optional().describe('是否为 draft 草稿态'),
        agent: z.string().optional().describe('执行的 Agent id（写入 createdBy）'),
      },
    },
    async (a) =>
      runCmd(
        'board_add_text',
        cmdAdd,
        mkArgs(
          ['text', boardPath, a.markdown],
          { at: a.at, actor: a.agent },
          a.draft ? ['draft'] : [],
        ),
        port,
      ),
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
        'board_text_stream_append 多次追加内容。需要 board-server 在运行。',
      inputSchema: {
        region: z.string().optional().describe('区域名（卡片归属该区域；不传则落画布顶层）'),
        at: z
          .string()
          .optional()
          .describe('坐标 "x,y"：带 region 时为区域内偏移，不带时为画布绝对坐标'),
        size: z.string().optional().describe('大小 "w,h"，默认 480,200'),
        markdown: z.string().optional().describe('初始 markdown（一般留空，靠 append 喂入）'),
        agent: z.string().optional().describe('Agent id（写入 createdBy + Agent 焦点光标）'),
      },
    },
    async (a) =>
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
          },
        ),
        port,
      ),
  );

  server.registerTool(
    'board_text_stream_append',
    {
      description:
        '给已存在的文本卡 markdown 追加一段（Y.Text 字符级 CRDT，浏览器看到 ' +
        '打字动画 + Agent 光标 jitter）。LLM 流式输出的每个 chunk / 段落都可调一次。',
      inputSchema: {
        elementId: z.string().describe('文本卡元素 id（board_text_stream_create 返回值）'),
        chunk: z.string().describe('要追加的文本片段（保留 \\n 等格式字符）'),
        line: z
          .number()
          .optional()
          .describe('行号（0-indexed）—— 让 Agent 焦点光标钉到该行；缺省自动算'),
        agent: z.string().optional().describe('Agent id（写入 updatedBy + Agent 焦点光标）'),
      },
    },
    async (a) =>
      runCmd(
        'board_text_stream_append',
        cmdText,
        mkArgs(
          ['append', a.elementId, a.chunk],
          {
            line: a.line !== undefined ? String(a.line) : undefined,
            actor: a.agent,
          },
        ),
        port,
      ),
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
        agent: z.string().optional().describe('start：执行的 Agent id'),
      },
    },
    async (a): Promise<CallToolResult> => {
      if (a.phase === 'start') {
        if (!a.title) return textResult('start 阶段需要 title', true);
        return runCmd(
          'board_report_progress',
          cmdTask,
          mkArgs(['start'], {
            title: a.title,
            region: a.region,
            at: a.at,
            agent: a.agent,
            port,
          }),
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
        );
      }
      return runCmd(
        'board_report_progress',
        cmdTask,
        mkArgs(['finish', a.taskId], { summary: a.summary, port }),
      );
    },
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
    async (a) =>
      runCmd(
        'board_create_suggestion',
        cmdSuggest,
        mkArgs(
          [boardPath, a.targetId],
          {
            type: a.suggestionType ?? 'replace',
            as: `text:${a.markdown}`,
            reason: a.reason,
            actor: a.agent,
          },
        ),
        port,
      ),
  );

  // ── 写：添加几何图形（画流程图）────────────────────────────
  server.registerTool(
    'board_add_shape',
    {
      description:
        '添加一个几何图形（rectangle / ellipse / diamond）。Agent 画流程图用 —— ' +
        '配合 board_connect 连线即可表达方框 + 箭头的流程图。手绘不开放。' +
        '排版建议：画流程图务必为各节点留足间距 —— 节点默认约 160x72，相邻节点' +
        '纵向中心间隔 ≥200、横向 ≥240，否则方框 / 连线 / 文字会挤成一团。' +
        '省略 at 则自动避让落位（不与现有元素重叠）。',
      inputSchema: {
        kind: z
          .enum(['rectangle', 'ellipse', 'diamond'])
          .describe('图形类型'),
        label: z.string().optional().describe('图形内文字（流程图节点名）'),
        at: z
          .string()
          .optional()
          .describe(
            '画布坐标 "x,y"（元素左上角）；省略则自动避让落位（不与现有元素' +
              '重叠）。手工指定时务必为相邻元素留足间距，避免方框 / 连线 / 文字重叠',
          ),
        size: z
          .string()
          .optional()
          .describe('尺寸 "w,h"；省略用默认 160x72'),
        region: z.string().optional().describe('放入的区域名'),
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a) =>
      runCmd(
        'board_add_shape',
        cmdShape,
        mkArgs(['add', boardPath, a.kind], {
          label: a.label,
          at: a.at,
          size: a.size,
          region: a.region,
          actor: a.agent,
        }),
        port,
      ),
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
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a) =>
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
      ),
  );

  // ── 读：搜索 ────────────────────────────────────────────────
  server.registerTool(
    'board_search',
    {
      description:
        '搜索白板：元素文字 / 文件名 / 文本类文件内容。结果含元素 id 与命中片段。',
      inputSchema: {
        keyword: z.string().describe('搜索关键词（大小写不敏感）'),
      },
    },
    async (a) =>
      runCmd('board_search', cmdSearch, mkArgs([boardPath, a.keyword])),
  );

  // ── 写：删除元素 ────────────────────────────────────────────
  server.registerTool(
    'board_delete_element',
    {
      description:
        '删除一个元素。file 元素的真实文件移入回收站；引用该元素的连线 / 建议' +
        '一并清理。region / folder 元素不在删除范围。',
      inputSchema: {
        elementId: z.string().describe('要删除的元素 id'),
      },
    },
    async (a) =>
      runCmd(
        'board_delete_element',
        cmdRm,
        mkArgs([boardPath, a.elementId]),
        port,
      ),
  );

  // ── 写：加评论 ──────────────────────────────────────────────
  server.registerTool(
    'board_add_comment',
    {
      description: '给某个元素加一条评论（PRD §8.4）。',
      inputSchema: {
        elementId: z.string().describe('被评论的元素 id'),
        text: z.string().describe('评论内容'),
        agent: z.string().optional().describe('评论者 Agent id'),
      },
    },
    async (a) =>
      runCmd(
        'board_add_comment',
        cmdComment,
        mkArgs([boardPath, a.elementId, a.text], { actor: a.agent }),
        port,
      ),
  );

  // ── 写：改区域描述 ──────────────────────────────────────────
  server.registerTool(
    'board_describe_region',
    {
      description: '修改区域描述（同步落地为区域文件夹的 README.md）。',
      inputSchema: {
        region: z.string().describe('区域名'),
        description: z.string().describe('新的区域描述'),
      },
    },
    async (a) =>
      runCmd(
        'board_describe_region',
        cmdRegion,
        mkArgs(['describe', boardPath, a.region], { desc: a.description }),
        port,
      ),
  );

  // ── 写：指派区域给 Agent ────────────────────────────────────
  server.registerTool(
    'board_assign_region',
    {
      description:
        '把区域指派给某个 Agent（PRD §7.6 区域委派）—— Agent 的工作范围聚焦此区域。',
      inputSchema: {
        region: z.string().describe('区域名'),
        agent: z.string().describe('被指派的 Agent id'),
      },
    },
    async (a) =>
      runCmd(
        'board_assign_region',
        cmdRegion,
        mkArgs(['assign', boardPath, a.region], { agent: a.agent }),
        port,
      ),
  );

  // ── 写：改元素样式 ──────────────────────────────────────────
  server.registerTool(
    'board_style_element',
    {
      description:
        '修改元素的统一样式（PRD §6.7）：描边色 / 填充色 / 描边宽度 / 线型 / 透明度。' +
        '可用于给元素做视觉编码（如重要项标红框）。',
      inputSchema: {
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
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a) =>
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
      ),
  );

  // ── 写：添加本地文件 ────────────────────────────────────────
  server.registerTool(
    'board_add_file',
    {
      description:
        '把一个文件添加进白板（复制进 files/，可指定区域）。两种来源二选一：' +
        'source = 本地文件的绝对路径；或 content + filename = 由文本内容直接生成文件。',
      inputSchema: {
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
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a): Promise<CallToolResult> =>
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
      }),
  );

  // ── 写：添加本地目录 ────────────────────────────────────────
  server.registerTool(
    'board_add_folder',
    {
      description: '把一个本地目录（连同内部文件）整体添加进白板的 files/。',
      inputSchema: {
        source: z.string().describe('本地目录的绝对路径'),
        region: z.string().optional().describe('放入的区域名；省略 = 收件区'),
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a) =>
      runCmd(
        'board_add_folder',
        cmdAdd,
        mkArgs(['folder', boardPath, a.source], {
          region: a.region,
          actor: a.agent,
        }),
        port,
      ),
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
        from: z.string().describe('源文件相对 files/ 的路径，如 "tickets.pdf"'),
        to: z
          .string()
          .describe('目标相对路径，如 "路线/tickets.pdf"（即移进「路线」区域）'),
        agent: z.string().optional().describe('执行的 Agent id'),
      },
    },
    async (a) =>
      runCmd(
        'board_move_file',
        cmdMv,
        mkArgs([boardPath, a.from, a.to], { actor: a.agent }),
        port,
      ),
  );

  // ── 读：读取 files/ 内某文件正文 ─────────────────────────────
  server.registerTool(
    'board_read_file',
    {
      description:
        '读取白板 files/ 下某个文件的正文。文本类文件内联返回内容（过长截断），' +
        '二进制文件只返回类型与大小。相对路径可从 board_list_files 获得。',
      inputSchema: {
        path: z.string().describe('相对 files/ 的文件路径，如 "路线/day1.md"'),
      },
    },
    async (a) =>
      safeHandler('board_read_file', () => readBoardFile(boardPath, a.path)),
  );

  // ── 读：取单个元素的完整详情 ────────────────────────────────
  server.registerTool(
    'board_get_element',
    {
      description:
        '取单个元素的完整详情（JSON）。对 suggestion 元素会连同 `thread` —— ' +
        '即「描述」反馈回路里人留下的修改意见 —— 一并返回，Agent 据此修订建议。',
      inputSchema: {
        elementId: z.string().describe('元素 id'),
      },
    },
    async (a) =>
      safeHandler('board_get_element', () =>
        getBoardElement(boardPath, a.elementId),
      ),
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
    },
    async (a) =>
      safeHandler('board_subscribe_events', () =>
        subscribeEvents(port, a.since, a.region),
      ),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[board mcp] MCP Server 已启动（stdio）— 白板：${boardPath}`);

  // 阻塞直到 Agent 断开 stdio 连接 —— 否则进程会立即退出、连接中断。
  await new Promise<void>((resolve) => {
    transport.onclose = (): void => resolve();
  });
}
