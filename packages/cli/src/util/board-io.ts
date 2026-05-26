/**
 * CLI 端 board 读写抽象 —— "server 在跑就走 HTTP,否则回退 fs"。
 *
 * 用法:把命令里的
 *     const handle = await loadBoard(dir);
 *     ... 改 handle.scene ...
 *     await saveBoard(dir, handle.meta, scene);
 * 替换为
 *     const session = await openBoard(dir);
 *     ... 改 session.scene ...
 *     await session.save(session.scene);
 *
 * 为什么不直接修改 @board/core/node 的 loadBoard/saveBoard:
 *   core/node 也被 server 自身用 —— server 内部肯定走 fs。本抽象只对
 *   "外部进程"(CLI) 有意义,放在 CLI 包里。
 */
import { loadBoard, saveBoard, type BoardHandle } from '@board/core/node';
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
  /** 当前会话是否走的 server —— 极少数命令需要分支(如 files/ 操作)。 */
  readonly viaServer: boolean;
}

/**
 * 打开一份白板会话。优先尝试 server 旁路,失败回退 fs。
 *
 * `dir` 必须已是绝对路径(由 resolveBoardDir 保证)。
 */
export async function openBoard(dir: string): Promise<BoardSession> {
  const server = await findServerForBoard(dir);
  if (server) {
    return openViaServer(dir, server);
  }
  const handle = await loadBoard(dir);
  return openViaFs(handle);
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

function openViaFs(handle: BoardHandle): BoardSession {
  return {
    dir: handle.dir,
    meta: handle.meta,
    scene: handle.scene,
    viaServer: false,
    async save(next: BoardScene): Promise<void> {
      await saveBoard(handle.dir, handle.meta, next);
    },
    async refreshFilesOnly(): Promise<void> {
      // fs 模式下 CLI 自己负责把 reconcile 后的 scene 通过 save 写盘 ——
      // 没有外部进程需要被"通知",所以这里 no-op。
      return;
    },
    async announceAgent(): Promise<void> {
      // 服务不在,没有 Web 客户端在监听 SSE —— 推 presence 给谁?直接跳过。
      return;
    },
  };
}
