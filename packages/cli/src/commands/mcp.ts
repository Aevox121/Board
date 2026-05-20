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
import type { ParsedArgs } from '../util/args.js';
import { CliError, type CmdResult } from '../util/io.js';
import { cmdShow } from './show.js';
import { cmdTree } from './tree.js';
import { cmdAdd } from './add.js';
import { cmdRegion } from './region.js';
import { cmdTask } from './task.js';
import { cmdSuggest } from './suggest.js';
import { cmdShape } from './shape.js';
import { cmdConnect } from './connect.js';

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
          .describe('画布坐标 "x,y"；省略则自动排版'),
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
        '配合 board_connect 连线即可表达方框 + 箭头的流程图。手绘不开放。',
      inputSchema: {
        kind: z
          .enum(['rectangle', 'ellipse', 'diamond'])
          .describe('图形类型'),
        label: z.string().optional().describe('图形内文字（流程图节点名）'),
        at: z
          .string()
          .optional()
          .describe('画布坐标 "x,y"；省略则自动排版'),
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
        '在两个元素之间连一条线 / 箭头。两端若都是图形（board_add_shape 建的），' +
        '图形移动时连线自动跟随。画流程图：先 board_add_shape 建节点，再用本工具连。',
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[board mcp] MCP Server 已启动（stdio）— 白板：${boardPath}`);

  // 阻塞直到 Agent 断开 stdio 连接 —— 否则进程会立即退出、连接中断。
  await new Promise<void>((resolve) => {
    transport.onclose = (): void => resolve();
  });
}
