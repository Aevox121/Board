/**
 * CLI 端 board 写会话 —— **必须经 server / Y.Doc 路径**。
 *
 * 设计原则(2026-05 立项):CLI / MCP 的写操作不能 disk 直写 board.json,因为
 *   server 用 Y.Doc 作运行态权威源 + 节流投影回盘;若 CLI 直写 fs,会和
 *   Y.Doc 反向丢写 + 跳过 oplog/SSE 事件流。Agent 直接修改 `.board/files/`
 *   下的文件是允许的(用自己的 fs 工具),由 server 的 chokidar 自动 reconcile;
 *   `board` CLI/MCP 的范围只覆盖"通过命令修改内容"。
 *
 * 用法:
 *     const session = await openBoard(dir);   // server 不可达直接抛错,不回退 fs
 *     ... 改 session.scene ...
 *     await session.save(session.scene);
 *
 * 读操作不走本抽象 —— info/show/search/export 直接用 @board/core/node 的
 * loadBoard 读 disk(server 节流投影后 disk 总是接近最新)。
 */
import { CliError, EXIT } from './io.js';
import type { BoardMeta, BoardScene } from '@board/core';
import {
  findServerForBoard,
  type AgentActivityInput,
  type ServerHandle,
} from './server-client.js';

/** 一次 CLI 命令的白板会话 —— 拿初始 meta/scene,写完调 save(scene)。 */
export interface BoardSession {
  /** .board 目录绝对路径(始终给,无论后端是哪种)。 */
  dir: string;
  /** 当前 meta —— save 后并不一定同步刷新,仅供命令读取。 */
  meta: BoardMeta;
  /** 当前 scene —— save 后并不自动重读,命令自己改这份再传回 save。 */
  scene: BoardScene;
  /**
   * 写整个 scene。
   *  - server 模式:PUT /api/boards/<id>/board —— 服务自负 Y.Doc / 落盘 / 广播。
   *  - fs 模式:saveBoard(dir, meta, scene) —— 与旧版完全等价。
   */
  save(scene: BoardScene): Promise<void>;
  /**
   * 仅文件系统侧变更(如往 files/ 复制文件)后调用,通知服务重新对账。
   *  - server 模式:依赖 chokidar 自然 reconcile(默认 250ms 间隔 + 200ms 防抖),
   *    本调用额外发 POST /api/refresh 推一次事件流广播。
   *  - fs 模式:no-op(本会话内已经/将要走 save 落 board.json)。
   */
  refreshFilesOnly(actor?: string): Promise<void>;
  /**
   * 通知服务"Agent 干完一票了" —— 自动注册 participant + 推 presence 帧,
   * Web 端据此渲染 Agent 头像与围绕 targetElementId 的轨道动画。
   *  - actorId 不以 `a_` 开头时:no-op(避免 server 端 400)。
   *  - server 模式 + Agent actor:POST /api/agent-activity。
   *  - fs 模式:no-op(没有客户端在监听)。
   */
  announceAgent(opts: AgentActivityInput): Promise<void>;
  /** 当前会话是否走的 server —— 历史字段,严格模式后恒为 true。 */
  readonly viaServer: boolean;
  /**
   * 底层 server handle —— 暴露给需要直接调 endpoint 的 cmd(uploadFile /
   * moveFile / deleteElement / suggestionOp 等),省得每个 cmd 再 findServerForBoard。
   */
  readonly server: ServerHandle;
}

/**
 * 读 board 最新状态 —— 写路径上 server 是权威源(Y.Doc),disk 投影有 ~300ms
 * 节流;若 server 可达,**读也必须经 server**,否则会读到过期 disk 快照。
 *
 * read-only 命令(info/show/search/get_element 等)用本函数;server 不可达
 * 回退 loadBoard 读 disk(read 不像 write 那样有数据竞争,允许 fallback)。
 */
export async function readBoard(
  dir: string,
): Promise<{ meta: BoardMeta; scene: BoardScene }> {
  const server = await findServerForBoard(dir);
  if (server) return server.fetchBoard();
  const { loadBoard } = await import('@board/core/node');
  const h = await loadBoard(dir);
  return { meta: h.meta, scene: h.scene };
}

/**
 * 打开一份白板会话(写操作专用)。server 不可达直接抛 USAGE 错。
 *
 * `dir` 必须已是绝对路径(由 resolveBoardDir 保证)。
 */
export async function openBoard(dir: string): Promise<BoardSession> {
  const server = await findServerForBoard(dir);
  if (!server) {
    throw new CliError(
      'board 写命令需要 board-server 在跑且管理本白板。' +
        '请先 `board serve <白板路径>`(或确认 BOARD_SERVER_URL / 默认 :4500 指向了正确的 server)。' +
        '\n\n设计原则:CLI/MCP 的写操作必须经 server/Y.Doc;Agent 想直接改 .board/files/ 内文件请用 fs 工具(server 的 chokidar 会自动同步)。',
      EXIT.GENERAL,
    );
  }
  return openViaServer(dir, server);
}

/** 同一进程内只对"忘了报家门"提示一次,避免一条命令多次写盘时刷屏。 */
let agentHintShown = false;

async function openViaServer(
  dir: string,
  server: ServerHandle,
): Promise<BoardSession> {
  const { meta, scene } = await server.fetchBoard();
  return {
    dir,
    meta,
    scene,
    viaServer: true,
    server,
    async save(next: BoardScene): Promise<void> {
      await server.putBoard(next);
    },
    async refreshFilesOnly(actor?: string): Promise<void> {
      await server.refresh(actor);
    },
    async announceAgent(opts: AgentActivityInput): Promise<void> {
      // server 在跑 + 写命令归属默认 u_local → 大概率是 Agent 调用却忘了
      // 自报家门;打一行 stderr 让 Agent 看见。设 BOARD_SUPPRESS_AGENT_HINT=1
      // 关掉(适合知道自己是人类、确认不想要光标的本地用户)。
      if (
        !opts.actorId.startsWith('a_') &&
        !agentHintShown &&
        !process.env.BOARD_SUPPRESS_AGENT_HINT
      ) {
        agentHintShown = true;
        console.error(
          '[board] 注意:本次操作归属 u_local(默认本地用户)。\n' +
            '       如你是 Agent,务必自报家门 —— 用 --actor a_<你的标识>\n' +
            '       [--agent-name "<显示名>"] [--agent-color "#xxxxxx"],\n' +
            '       Web 端才能看到拟人化光标 + 头像。\n' +
            '       (设 BOARD_SUPPRESS_AGENT_HINT=1 关闭此提示)',
        );
      }
      await server.agentActivity(opts);
    },
  };
}

