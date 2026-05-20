# Board

一款类 Excalidraw 的 **Agent 协作白板**——无限画布与真实文件系统二合一，人和 AI Agent 在同一空间里协作。

设计文档与开发约定见 [`CLAUDE.md`](./CLAUDE.md)。来源任务：T-0106。

## 仓库结构

```
packages/
  core/      # 共享：数据模型类型、文件系统映射、自动排版算法（无运行时依赖，keystone）
  server/    # Node 本地服务：文件监听、双向同步、HTTP/WS API、MCP Server
  web/       # React Web 应用：Excalidraw 集成 + DOM 覆盖层
  cli/       # board CLI
```

## 开发

```bash
pnpm install          # 安装依赖
pnpm dev:web          # 启动 Web 应用
pnpm dev:server       # 启动本地服务
pnpm typecheck        # 全量类型检查
pnpm build            # 构建全部包
```

## 当前状态

**M0 调研验证 / 工程骨架**——已搭建 monorepo，`@board/core` 数据模型按规格实现完成；`web` 已可挂载 Excalidraw（M0 烟雾测试），`server`/`cli` 为骨架。

里程碑：M0 调研验证 → M1 单人画布 → M2 空间文件系统 → M3 单 Agent 协作 → M4 多人多 Agent。
