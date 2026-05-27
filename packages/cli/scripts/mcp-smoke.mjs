#!/usr/bin/env node
/**
 * MCP 集成 smoke 测试 —— 真实环境跑一遍
 *
 * 起一个临时 .board + board-server + board mcp 子进程,用 MCP SDK Client
 * 串接调用核心工具,验证:
 *  1. 启动时 --actor 绑定,后续工具调用无需重复带 agent;
 *  2. read 类工具返回 structuredContent 且字段形状对齐 outputSchema;
 *  3. 写操作落盘 + 事件流/日志能看到;
 *  4. 错误路径(缺 actor / 越界路径等)被正确拒绝。
 *
 * 用法:  node packages/cli/scripts/mcp-smoke.mjs
 * 退出码: 0 全过 / 1 有失败
 *
 * 注:此脚本依赖 `pnpm --filter @board/cli build` 已跑过(读取 dist/index.js)。
 *    server 用 tsx 直接跑 src,无需 build。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..'); // → Dev/Board
const CLI_DIST = resolve(REPO, 'packages/cli/dist/index.js');
const SERVER_DIST = resolve(REPO, 'packages/server/dist/index.js');

const SERVER_PORT = '4599'; // 避开 dev 默认 4500
const ACTOR = 'a_smoke_test';
const AGENT_NAME = 'Smoke Test';
const AGENT_COLOR = '#ff00aa';

// ── 小工具 ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function ok(label, extra = '') {
  passed++;
  process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}${extra ? '  ' + extra : ''}\n`);
}
function bad(label, reason) {
  failed++;
  failures.push(`${label}: ${reason}`);
  process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n      ${reason}\n`);
}
function section(name) {
  process.stdout.write(`\n\x1b[36m── ${name} ──\x1b[0m\n`);
}

async function waitForServer(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not come up on :${port} within ${timeoutMs}ms`);
}

// ── 主流程 ─────────────────────────────────────────────────────────
async function main() {
  // 1. 建临时 .board
  section('准备临时白板');
  const tmpRoot = await mkdtemp(join(tmpdir(), 'board-smoke-'));
  const boardPath = join(tmpRoot, 'smoke.board');
  await new Promise((res, rej) => {
    const p = spawn(process.execPath, [CLI_DIST, 'new', 'smoke', '--dir', tmpRoot], {
      stdio: 'inherit',
    });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error('board new failed'))));
  });
  ok('board new', boardPath);

  // 2. 起 board-server(后台,绑定该 board)
  section('启动 board-server');
  const serverProc = spawn(
    process.execPath,
    [SERVER_DIST, boardPath],
    {
      env: { ...process.env, BOARD_PORT: SERVER_PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  serverProc.stdout.on('data', (b) => process.stderr.write(`[server stdout] ${b}`));
  serverProc.stderr.on('data', (b) => process.stderr.write(`[server stderr] ${b}`));

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { serverProc.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try { await rm(tmpRoot, { recursive: true, force: true }); } catch {}
  };
  process.on('SIGINT', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer(SERVER_PORT);
    ok('server 上线', `:${SERVER_PORT}`);
  } catch (e) {
    bad('server 启动', e.message);
    await cleanup();
    process.exit(1);
  }

  // 3. 连 board mcp(绑定 actor)
  section('连接 MCP Server(stdio)');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      CLI_DIST,
      'mcp',
      boardPath,
      '--actor', ACTOR,
      '--agent-name', AGENT_NAME,
      '--agent-color', AGENT_COLOR,
      '--port', SERVER_PORT,
    ],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (b) => process.stderr.write(`[mcp stderr] ${b}`));

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  ok('client.connect');

  // 4. 拉工具清单
  section('list tools');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  if (names.includes('board_read_context') && names.includes('board_text_stream_append')) {
    ok('listTools', `共 ${names.length} 个`);
  } else {
    bad('listTools', `expected board_read_context + stream tools, got: ${names.join(', ')}`);
  }
  // outputSchema 应出现在 read 工具上
  const readCtx = tools.tools.find((t) => t.name === 'board_read_context');
  if (readCtx?.outputSchema) {
    ok('board_read_context.outputSchema 已声明');
  } else {
    bad('board_read_context.outputSchema', 'missing');
  }

  // helper: 调用并取 structuredContent
  async function call(name, args) {
    const r = await client.callTool({ name, arguments: args ?? {} });
    if (r.isError) {
      throw new Error(`tool ${name} returned isError: ${JSON.stringify(r.content)}`);
    }
    return r;
  }

  // 4b. board_info —— 白板 meta + 统计
  section('board_info');
  {
    const r = await call('board_info', {});
    const s = r.structuredContent;
    if (s?.name === 'smoke' && typeof s.id === 'string' && typeof s.elements === 'number') {
      ok('info 形状', `id=${s.id} name=${s.name} elements=${s.elements}`);
    } else bad('info 形状', JSON.stringify(s));
  }

  // 5. 初始 read_context(空板)
  section('board_read_context (depth 0)');
  {
    const r = await call('board_read_context', { depth: 0 });
    const s = r.structuredContent;
    if (!s) bad('structuredContent 存在', 'undefined');
    else if (s.name !== 'smoke') bad('name=smoke', `got ${s.name}`);
    else if (!Array.isArray(s.regions)) bad('regions 是数组', `got ${typeof s.regions}`);
    else ok('structured 形状对齐', `name=${s.name} regions=${s.regions.length}`);
  }

  // 6. 建区域(write — 验证 actor 绑定)
  section('board_create_region');
  let regionElementId;
  {
    const r = await call('board_create_region', { name: '路线', description: '放路线相关' });
    const s = r.structuredContent;
    if (s?.elementId) {
      regionElementId = s.elementId;
      ok('create_region', `elementId=${s.elementId}`);
    } else bad('create_region 返回 elementId', JSON.stringify(s));
  }

  // 7. 加文本卡
  section('board_add_text');
  let textElementId;
  {
    const r = await call('board_add_text', { markdown: 'day 1: high speed rail' });
    const s = r.structuredContent;
    if (s?.elementId) {
      textElementId = s.elementId;
      ok('add_text', `elementId=${s.elementId}`);
    } else bad('add_text 返回 elementId', JSON.stringify(s));
  }

  // 8. read_context depth 1 应能看到 1 region + 1 loose 元素
  section('board_read_context (depth 1)');
  {
    const r = await call('board_read_context', { depth: 1 });
    const s = r.structuredContent;
    if (s?.regions?.length === 1 && s?.loose?.elementCount === 1) {
      ok('depth 1 拓扑', `regions=1 loose=${s.loose.elementCount}`);
    } else {
      bad('depth 1 拓扑', `regions=${s?.regions?.length} loose.elementCount=${s?.loose?.elementCount}`);
    }
  }

  // 9. 搜索
  section('board_search');
  {
    const r = await call('board_search', { keyword: 'rail' });
    const s = r.structuredContent;
    if (s?.count >= 1 && s.hits?.[0]?.elementId === textElementId) {
      ok('search 命中', `count=${s.count}`);
    } else {
      bad('search 命中 textElementId', `count=${s?.count} firstHit=${s?.hits?.[0]?.elementId}`);
    }
  }

  // 10. get_element 验证 createdBy = bound actor
  section('board_get_element (验证 actor 绑定生效)');
  {
    const r = await call('board_get_element', { elementId: textElementId });
    const s = r.structuredContent;
    if (s?.element?.createdBy === ACTOR) {
      ok('createdBy 套用绑定', `${s.element.createdBy}`);
    } else {
      bad('createdBy 应为 ' + ACTOR, `got ${s?.element?.createdBy}`);
    }
  }

  // 10a2. board_edit_text 整体替换 markdown(走 server,Y.Text reset)
  // 必须用 stream_create 建在 Y.Doc 里的卡 —— board_add_text 走 disk 直写,
  // Y.Doc 里没这个元素,edit_text 会找不到(已知 Y.Doc vs disk 双写 gap)。
  section('board_edit_text');
  {
    const rCreate = await call('board_text_stream_create', {
      markdown: '初版内容',
      at: '50,50',
      size: '480,200',
    });
    const streamCardId = rCreate.structuredContent?.elementId;
    if (!streamCardId) { bad('stream_create 拿不到 elementId', JSON.stringify(rCreate.structuredContent)); return; }
    ok('stream_create 建在 Y.Doc 的卡', streamCardId);

    const newMd = 'day 1: 改为高铁去重庆(整体替换)';
    const rEdit = await call('board_edit_text', {
      elementId: streamCardId,
      markdown: newMd,
    });
    if (rEdit.structuredContent?.ok === true && rEdit.structuredContent?.length === newMd.length) {
      ok('edit_text 返回', `length=${rEdit.structuredContent.length}`);
    } else bad('edit_text 返回', JSON.stringify(rEdit.structuredContent));
  }

  // 10b. board_move_element 验证按画布坐标摆位
  section('board_move_element');
  {
    const r = await call('board_move_element', {
      elementId: textElementId,
      to: '300,400',
      size: '480,200',
    });
    const s = r.structuredContent;
    if (s?.x === 300 && s?.y === 400 && s?.width === 480 && s?.height === 200) {
      ok('move_element', `→ (${s.x},${s.y}) size=${s.width}x${s.height}`);
    } else bad('move_element', JSON.stringify(s));
    // 再读元素确认落盘
    const r2 = await call('board_get_element', { elementId: textElementId });
    const el = r2.structuredContent?.element;
    if (el?.x === 300 && el?.y === 400 && el?.autoPlaced === false) {
      ok('move 落盘 + autoPlaced=false', `x=${el.x} y=${el.y}`);
    } else bad('move 落盘', `x=${el?.x} y=${el?.y} autoPlaced=${el?.autoPlaced}`);
  }

  // 10c. connector 应拒绝移动 —— 先连一根线再试
  section('board_move_element (connector 应拒绝)');
  {
    // 先建第二个 text 卡作为连线终点
    const r1 = await call('board_add_text', { markdown: 'day 2', at: '600,400' });
    const otherId = r1.structuredContent?.elementId;
    const rc = await call('board_connect', { from: textElementId, to: otherId, label: 'next' });
    const connectorId = rc.structuredContent?.elementId;
    const rm = await client.callTool({
      name: 'board_move_element',
      arguments: { elementId: connectorId, to: '0,0' },
    });
    if (rm.isError && /connector/.test(rm.content?.[0]?.text ?? '')) {
      ok('connector 拒绝移动');
    } else {
      bad('connector 应被拒', JSON.stringify(rm.content));
    }
  }

  // 10d. 建议处理回路 — create → describe(agent 反馈) → reject 全链路
  section('建议机制 — Agent-to-Agent 处理回路');
  {
    // 用另一个 actor 给 textElementId 提建议(模拟另一 Agent)
    const PEER = 'a_peer_agent';
    const rCreate = await call('board_create_suggestion', {
      targetId: textElementId,
      markdown: '改成: day 1: 高铁去重庆',
      reason: '原句太英文化',
      suggestionType: 'replace',
      agent: PEER,
    });
    const suggestionId = rCreate.structuredContent?.suggestionId;
    if (!suggestionId) { bad('create_suggestion', JSON.stringify(rCreate.structuredContent)); return; }
    ok('peer 提建议', `${suggestionId} authorId=${PEER}`);

    // 启动绑定的 a_smoke_test 作为"被指派者"读 suggestion 验证 thread 字段在
    const rRead = await call('board_get_element', { elementId: suggestionId });
    if (rRead.structuredContent?.element?.thread !== undefined) {
      ok('suggestion 含 thread 字段(初始空)');
    } else bad('suggestion.thread', '字段缺失');

    // describe — Agent(a_smoke_test) 反馈给提建议方
    const rDesc = await call('board_describe_suggestion', {
      suggestionId,
      text: '方向对,但保留"高铁"二字',
      // role 不传 → 默认 agent
    });
    if (rDesc.structuredContent?.op === 'describe' && rDesc.structuredContent?.role === 'agent') {
      ok('describe(agent 反馈)');
    } else bad('describe', JSON.stringify(rDesc.structuredContent));

    // 再读确认 thread 长度=1
    const rRead2 = await call('board_get_element', { elementId: suggestionId });
    const thread = rRead2.structuredContent?.element?.thread ?? [];
    if (thread.length === 1 && thread[0]?.role === 'agent' && thread[0]?.by === ACTOR) {
      ok('thread 写入', `len=1 role=agent by=${thread[0].by}`);
    } else bad('thread 写入', JSON.stringify(thread));

    // reject — Agent 不接受建议
    const rRej = await call('board_reject_suggestion', { suggestionId });
    if (rRej.structuredContent?.op === 'reject') {
      ok('reject');
    } else bad('reject', JSON.stringify(rRej.structuredContent));

    // 再读应找不到(被删除)
    const rGone = await client.callTool({
      name: 'board_get_element',
      arguments: { elementId: suggestionId },
    });
    if (rGone.isError && /未找到/.test(rGone.content?.[0]?.text ?? '')) {
      ok('reject 后建议元素已移除');
    } else bad('建议应已被删除', JSON.stringify(rGone.content));
  }

  // 11. log 只验 schema 形状 —— entries 内容受架构限制(见下)
  // 已知 gap:CLI/MCP 走 disk 直写绕过 Y.Doc,server.recordChange 比对的是
  // room.getScene()(Y.Doc 视图)且 drafts.count=0,因此 oplog 不写。要让
  // MCP 写入也进 oplog,需 server 端把 disk 变更 reconcile 进 Y.Doc。
  section('board_log (shape only,内容存在已知 gap)');
  {
    const r = await call('board_log', { tail: 10 });
    const s = r.structuredContent;
    if (Array.isArray(s?.entries) && (s.source === 'server' || s.source === 'disk')) {
      ok('log 形状', `entries=${s.entries.length} source=${s.source}（entries 空是已知 gap,见注释）`);
    } else {
      bad('log 形状', JSON.stringify(s)?.slice(0, 100));
    }
  }

  // 12. subscribe_events 拉一把
  section('board_subscribe_events');
  {
    const r = await call('board_subscribe_events', {});
    const s = r.structuredContent;
    if (Array.isArray(s?.events) && typeof s.cursor === 'number') {
      ok('事件流形状', `events=${s.events.length} cursor=${s.cursor}`);
    } else {
      bad('事件流字段', JSON.stringify(s)?.slice(0, 100));
    }
  }

  // 13. 错误路径:不存在的 elementId
  section('错误路径 — get_element 不存在');
  {
    const r = await client.callTool({ name: 'board_get_element', arguments: { elementId: 'el_does_not_exist' } });
    if (r.isError && /未找到/.test(r.content?.[0]?.text ?? '')) {
      ok('正确报错');
    } else {
      bad('应 isError + 含「未找到」', JSON.stringify(r.content));
    }
  }

  // ── 收尾 ────────────────────────────────────────────────────────
  await client.close();
  await cleanup();

  process.stdout.write(
    `\n\n\x1b[1m结果: ${passed} 通过 / ${failed} 失败\x1b[0m\n`,
  );
  if (failed > 0) {
    process.stdout.write('\n失败:\n');
    failures.forEach((f) => process.stdout.write(`  - ${f}\n`));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
