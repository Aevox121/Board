/**
 * `board suggest <白板路径> <目标元素id> --type <replace|add> --as <内容>`
 * —— 建议机制（PRD §7.3）。
 *
 * Agent 要改不属于自己的内容时不直接改原件，而是在旁边产生一条「建议」元素。
 * 人之后在 Web 端对建议做「同意 / 拒绝 / 描述」处理（决策权在人手里）。
 *
 * 规格 §2.5：board suggest <目标元素id> --type <replace|add> --as <内容来源>
 *  - `--type` —— `replace` 替换目标内容 / `add` 新增元素；默认 `replace`。
 *  - `--as`   —— 建议内容来源；当前支持 `text:<markdown>` 形式。
 *  - `--actor` / `--agent` —— 发起建议的 Agent id（默认 `a_agent`）。
 */
import { loadBoard, saveBoard } from '@board/core/node';
import {
  createSuggestionElement,
  createTextElement,
  defaultSizeFor,
  nextZ,
  SUGGESTION_CARD_SIZE,
  SUGGESTION_GAP,
  type SuggestionType,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 无 `--actor` / `--agent` 时建议归属的默认 Agent id。 */
const DEFAULT_AGENT = 'a_agent';

/** 命令用法提示。 */
const USAGE =
  'board suggest <白板路径> <目标元素id> --type <replace|add> --as text:"<markdown>"';

/** 执行 suggest 命令。 */
export async function cmdSuggest(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const targetId = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${USAGE}`, EXIT.USAGE);
  }
  if (targetId === undefined) {
    throw new CliError(`缺少目标元素 id。用法: ${USAGE}`, EXIT.USAGE);
  }

  // --type replace|add（默认 replace）
  const typeRaw = args.options.get('type') ?? 'replace';
  if (typeRaw !== 'replace' && typeRaw !== 'add') {
    throw new CliError(
      `--type 必须为 replace 或 add（实际：${typeRaw}）`,
      EXIT.USAGE,
    );
  }
  const suggestionType: SuggestionType = typeRaw;

  // --as text:<markdown>
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

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);
  const { scene } = handle;

  // 目标元素必须存在
  const target = scene.elements.find((e) => e.id === targetId);
  if (!target) {
    throw new CliError(`未找到目标元素：${targetId}`, EXIT.NOT_FOUND);
  }

  const actor =
    args.options.get('actor') ?? args.options.get('agent') ?? DEFAULT_AGENT;
  const z = nextZ(scene.elements);
  // 建议卡并排在目标右侧。
  const x = target.x + target.width + SUGGESTION_GAP;
  const y = target.y;

  // payload —— 提议的文本元素（同意 replace 时替换目标内容，add 时成为新元素）。
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
    authorId: actor,
  });

  scene.elements.push(suggestion);
  await saveBoard(dir, handle.meta, scene);

  return {
    code: EXIT.OK,
    text: `已创建建议 ${suggestion.id}（针对 ${targetId}，类型 ${suggestionType}）`,
    data: {
      suggestionId: suggestion.id,
      targetId,
      suggestionType,
      status: suggestion.status,
      x,
      y,
    },
  };
}
