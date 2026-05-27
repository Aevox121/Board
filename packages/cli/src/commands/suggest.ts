/**
 * `board suggest <子命令> ...` — 建议机制（PRD §7.3）。
 *
 * Agent 要改不属于自己的内容时不直接改原件，而是在旁边产生一条「建议」元素，
 * 由人 / 另一 Agent 决定 同意 / 拒绝 / 描述。**Agent-to-Agent 建议同样适用** ——
 * 区域被指派给 Agent 时，由其他参与者（人或别的 Agent）提出的建议，被指派者
 * 也可以直接 accept / reject / describe（决定权归被指派者所在的"责任范围"）。
 *
 * 子命令：
 *   create   —— 创建建议（原 `board suggest <白板> <目标元素id> ...` 等价）
 *   accept   —— 同意建议：replace 替换目标内容 / add 落地新元素，移除建议元素
 *   reject   —— 拒绝建议：删除建议元素，原件不变
 *   describe —— 向建议追加一条反馈（写入 thread，建议元素保留；下一轮 Agent
 *               读 thread 修订建议，形成「建议 ↔ 反馈」迭代回路）
 */
import {
  acceptSuggestion,
  createSuggestionElement,
  createTextElement,
  defaultSizeFor,
  describeSuggestion,
  nextZ,
  rejectSuggestion,
  SUGGESTION_CARD_SIZE,
  SUGGESTION_GAP,
  type SuggestionType,
  type ThreadMsg,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 无 `--actor` / `--agent` / `BOARD_AGENT_ID` 时建议归属的默认 Agent id。 */
const DEFAULT_AGENT = 'a_agent';

/** `board suggest create <白板> <目标元素id> --type <replace|add> --as text:"<md>" [--reason ...]` */
async function suggestCreate(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[1];
  const targetId = args.positionals[2];
  const usage =
    'board suggest create <白板路径> <目标元素id> --type <replace|add> --as text:"<md>" [--reason "<理由>"]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (targetId === undefined) {
    throw new CliError(`缺少目标元素 id。用法: ${usage}`, EXIT.USAGE);
  }

  const typeRaw = args.options.get('type') ?? 'replace';
  if (typeRaw !== 'replace' && typeRaw !== 'add') {
    throw new CliError(
      `--type 必须为 replace 或 add（实际：${typeRaw}）`,
      EXIT.USAGE,
    );
  }
  const suggestionType: SuggestionType = typeRaw;

  const asRaw = args.options.get('as');
  if (!asRaw) {
    throw new CliError(`缺少 --as。当前支持 --as text:"<markdown>"`, EXIT.USAGE);
  }
  if (!asRaw.startsWith('text:')) {
    throw new CliError(
      `--as 暂只支持 text:<markdown> 形式（实际前缀：${asRaw.slice(0, 12)}…）`,
      EXIT.USAGE,
    );
  }
  const markdown = asRaw.slice('text:'.length);
  if (markdown.trim() === '') {
    throw new CliError('建议内容不能为空。', EXIT.USAGE);
  }

  const reason = args.options.get('reason') ?? '';

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const { scene } = handle;

  const target = scene.elements.find((e) => e.id === targetId);
  if (!target) {
    throw new CliError(`未找到目标元素：${targetId}`, EXIT.NOT_FOUND);
  }

  const actor = resolveActor(args, DEFAULT_AGENT);
  const z = nextZ(scene.elements);
  const x = target.x + target.width + SUGGESTION_GAP;
  const y = target.y;

  const textSize = defaultSizeFor('text');
  const payload = createTextElement({
    x,
    y,
    width: textSize.width,
    height: textSize.height,
    createdBy: actor,
    z,
    markdown,
  });

  const suggestion = createSuggestionElement({
    x,
    y,
    width: SUGGESTION_CARD_SIZE.width,
    height: SUGGESTION_CARD_SIZE.height,
    createdBy: actor,
    z,
    targetId,
    suggestionType,
    payload,
    reason,
    authorId: actor,
  });

  scene.elements.push(suggestion);
  await handle.save(scene);
  await handle.announceAgent(buildAgentActivity(args, actor, suggestion.id));

  return {
    code: EXIT.OK,
    text: `已创建建议 ${suggestion.id}（针对 ${targetId}，类型 ${suggestionType}${
      reason.trim() ? '，带理由' : ''
    }）`,
    data: {
      suggestionId: suggestion.id,
      targetId,
      suggestionType,
      status: suggestion.status,
      hasReason: reason.trim() !== '',
      x,
      y,
    },
  };
}

/** `board suggest accept <白板> <suggestionId>` */
async function suggestAccept(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[1];
  const suggestionId = args.positionals[2];
  if (boardPath === undefined || suggestionId === undefined) {
    throw new CliError(
      '用法: board suggest accept <白板路径> <suggestionId>',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const actor = resolveActor(args);
  const result = acceptSuggestion(handle.scene, suggestionId, actor);
  if (result.error) {
    const code = result.error.includes('目标元素已不存在')
      ? EXIT.CONFLICT
      : EXIT.NOT_FOUND;
    throw new CliError(result.error, code);
  }
  if (result.changed) {
    await handle.save(result.scene);
  }
  await handle.announceAgent(buildAgentActivity(args, actor, suggestionId));

  return {
    code: EXIT.OK,
    text: `已同意建议 ${suggestionId}`,
    data: { suggestionId, op: 'accept', actor },
  };
}

/** `board suggest reject <白板> <suggestionId>` */
async function suggestReject(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[1];
  const suggestionId = args.positionals[2];
  if (boardPath === undefined || suggestionId === undefined) {
    throw new CliError(
      '用法: board suggest reject <白板路径> <suggestionId>',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const actor = resolveActor(args);
  const result = rejectSuggestion(handle.scene, suggestionId);
  if (result.error) {
    throw new CliError(result.error, EXIT.NOT_FOUND);
  }
  if (result.changed) {
    await handle.save(result.scene);
  }
  await handle.announceAgent(buildAgentActivity(args, actor, suggestionId));

  return {
    code: EXIT.OK,
    text: `已拒绝建议 ${suggestionId}`,
    data: { suggestionId, op: 'reject', actor },
  };
}

/** `board suggest describe <白板> <suggestionId> --text "<反馈>" [--role human|agent]` */
async function suggestDescribe(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[1];
  const suggestionId = args.positionals[2];
  if (boardPath === undefined || suggestionId === undefined) {
    throw new CliError(
      '用法: board suggest describe <白板路径> <suggestionId> --text "<反馈>" [--role human|agent]',
      EXIT.USAGE,
    );
  }
  const text = (args.options.get('text') ?? '').trim();
  if (!text) {
    throw new CliError('--text 不能为空', EXIT.USAGE);
  }
  const roleRaw = args.options.get('role') ?? 'agent';
  if (roleRaw !== 'human' && roleRaw !== 'agent') {
    throw new CliError(
      `--role 必须为 human 或 agent（实际：${roleRaw}）`,
      EXIT.USAGE,
    );
  }
  const role = roleRaw as ThreadMsg['role'];

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const actor = resolveActor(args);
  const result = describeSuggestion(handle.scene, suggestionId, text, actor, role);
  if (result.error) {
    throw new CliError(result.error, EXIT.NOT_FOUND);
  }
  if (result.changed) {
    await handle.save(result.scene);
  }
  await handle.announceAgent(buildAgentActivity(args, actor, suggestionId));

  return {
    code: EXIT.OK,
    text: `已向建议 ${suggestionId} 追加 ${role} 反馈`,
    data: { suggestionId, op: 'describe', actor, role },
  };
}

/** `board suggest <子命令>` 路由。 */
export async function cmdSuggest(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '用法: board suggest <create|accept|reject|describe> ...',
      EXIT.USAGE,
    );
  }
  switch (sub) {
    case 'create':
      return suggestCreate(args);
    case 'accept':
      return suggestAccept(args);
    case 'reject':
      return suggestReject(args);
    case 'describe':
      return suggestDescribe(args);
    default:
      throw new CliError(
        `未知子命令 "suggest ${sub}"。可用: create, accept, reject, describe`,
        EXIT.USAGE,
      );
  }
}
