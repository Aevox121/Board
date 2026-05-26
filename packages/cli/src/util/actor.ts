/**
 * CLI 端 actor 解析 + Agent 身份拼装 —— 工具自描述的核心入口。
 *
 * 每个 Agent 调 board CLI 必须自报家门,否则 Web 端看不到拟人化光标:
 *   --actor a_<标识>          —— 必填,以 a_ 开头(server 端硬约束)
 *   --agent-name "<显示名>"   —— 可选,默认显示 actor id
 *   --agent-color "#xxxxxx"   —— 可选,默认蓝色
 *
 * 优先级(高 → 低):
 *   1. 命令行选项 (--actor / --agent / --agent-name / --agent-color)
 *   2. 环境变量 (BOARD_AGENT_ID / BOARD_AGENT_NAME / BOARD_AGENT_COLOR)
 *      —— 容器化部署或本地 dev 时一次性配上,不推荐让 Agent 仰赖 env
 *   3. actor 兜底 `u_local`(人类本地用户)
 *
 * Agent 命名约定:以 `a_` 开头(如 `a_claude_code`)。前缀决定 server 端是否
 * 走 Agent 自动注册 + presence 推送流程。
 */
import type { ParsedArgs } from './args.js';
import type { AgentActivityInput } from './server-client.js';

/** 无任何来源时的默认 —— 本地人类操作者。 */
const DEFAULT_ACTOR = 'u_local';

/**
 * 取本次命令的 actor id —— 见模块注释的优先级。
 *
 * @param fallback 都没命中时的兜底;默认 `u_local`。少数命令(如 suggest)
 * 语义上必须是 Agent,可传 `a_agent` 改默认。
 */
export function resolveActor(args: ParsedArgs, fallback: string = DEFAULT_ACTOR): string {
  return (
    args.options.get('actor') ??
    args.options.get('agent') ??
    (process.env.BOARD_AGENT_ID?.trim() || undefined) ??
    fallback
  );
}

/** Agent 显示名 —— 优先 --agent-name,再 BOARD_AGENT_NAME env;都没设走 server 默认(=actorId)。 */
export function resolveAgentName(args: ParsedArgs): string | undefined {
  return (
    args.options.get('agent-name') ??
    (process.env.BOARD_AGENT_NAME?.trim() || undefined)
  );
}

/** Agent 主题色 —— 优先 --agent-color,再 BOARD_AGENT_COLOR env;都没设走 server 默认蓝色。 */
export function resolveAgentColor(args: ParsedArgs): string | undefined {
  return (
    args.options.get('agent-color') ??
    (process.env.BOARD_AGENT_COLOR?.trim() || undefined)
  );
}

/** 判定一个 actor 是否走 Agent 通路(出现 presence + 自动注册等)。 */
export function isAgentActor(actor: string): boolean {
  return actor.startsWith('a_');
}

/**
 * 把 actor + 焦点元素 拼成 announceAgent 入参 —— 把 name/color 的解析集中
 * 在这里,避免每个命令各自重复;非 Agent actor 也能调,server 端 / 客户端
 * 双层都会 no-op(后者顺带打 stderr hint 提醒"你忘了报家门")。
 */
export function buildAgentActivity(
  args: ParsedArgs,
  actor: string,
  targetElementId?: string,
): AgentActivityInput {
  return {
    actorId: actor,
    name: resolveAgentName(args),
    color: resolveAgentColor(args),
    targetElementId,
  };
}
