/**
 * CLI 端 actor 解析 —— 把"谁在操作"这个 ID 集中算一次。
 *
 * 优先级(高 → 低):
 *   1. `--actor <id>` 命令行选项
 *   2. `--agent <id>` 命令行选项(语义上等价于 --actor,但更强调 Agent 身份)
 *   3. `BOARD_AGENT_ID` 环境变量 —— Claude Code / 子 Agent 跑 CLI 时设这一项即可
 *      让所有写命令自动归属为该 Agent,无需逐次传 --actor
 *   4. 默认 `u_local` —— 本地人类用户
 *
 * Agent 命名约定:以 `a_` 开头(如 `a_claude_code`)。server 端 /api/agent-activity
 * 用此前缀判定是否走 Agent 自动注册 + presence 推送流程。
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

/** Agent 显示名(BOARD_AGENT_NAME env);未设走 server 默认(= actorId)。 */
export function resolveAgentName(): string | undefined {
  return process.env.BOARD_AGENT_NAME?.trim() || undefined;
}

/** Agent 主题色(BOARD_AGENT_COLOR env);未设走 server 默认蓝色。 */
export function resolveAgentColor(): string | undefined {
  return process.env.BOARD_AGENT_COLOR?.trim() || undefined;
}

/** 判定一个 actor 是否走 Agent 通路(出现 presence + 自动注册等)。 */
export function isAgentActor(actor: string): boolean {
  return actor.startsWith('a_');
}

/**
 * 把 actor + 焦点元素 拼成 announceAgent 入参 —— 把 name/color 的 env 取值
 * 集中在这里,避免每个命令各自重复;非 Agent actor 也能调,server 端 / 客户端
 * 双层都会 no-op。
 */
export function buildAgentActivity(
  actor: string,
  targetElementId?: string,
): AgentActivityInput {
  return {
    actorId: actor,
    name: resolveAgentName(),
    color: resolveAgentColor(),
    targetElementId,
  };
}
