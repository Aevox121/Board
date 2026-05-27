# Board

一款类 Excalidraw 的 **Agent 协作白板**——无限画布与真实文件系统二合一，人和 AI Agent 在同一空间里协作。

## 项目概述

Board 把"白板"和"文件系统"统一：一个白板在磁盘上就是一个 `.board` 文件夹，画布上的区域 = 文件夹、卡片 = 文件，空间位置关系直接映射为文件组织关系。人和 Agent 作为平等的"参与者"在同一画布上协作，Agent 工作时以"Pencil 式"过程可视化（进行中→结果）实时呈现。白板本身即可交付物——可随时打开、导出为压缩包、内部文件可单独下载。

核心能力：
- **画布**：自研无限画布 —— 手绘 / 图形 / 连线 / 文本，roughjs + perfect-freehand 提供手绘质感。
- **空间文件系统**：文件 / 文件夹 / 区域元素，背后是真实文件，`.board` 文件夹与画布双向同步。
- **Agent 协作**：Agent 默认通过 `board` CLI 操作白板（也支持 MCP、直接改文件夹）；建议机制让 Agent 不破坏人的原始内容；过程可视化。
- **多人协作**：实时同步、在场感知、撤回/复原存档。

目标场景（MVP 验收）：多人 + 各自 Agent 在一块白板上协作完成一份"旅行计划"。

## 来源任务

- 主任务：[[T-0106-Agent协作白板工具开发]]（`Tasks/tasks/T-0106-Agent协作白板工具开发/T-0106-Agent协作白板工具开发.md`）

进度继续在 Tasks 中维护；本目录拥有独立 git。

## 设计文档

设计文件留在 Tasks 中，通过路径引用（不复制）：

- `Tasks/tasks/T-0106-Agent协作白板工具开发/初步设计.md` — 用户撰写的初步设计稿
- `Tasks/tasks/T-0106-Agent协作白板工具开发/PRD.md` — 完整产品需求文档 v0.3（**主参考**，含 16 章 + 决策记录）
- `Tasks/tasks/T-0106-Agent协作白板工具开发/specs/数据模型规格.md` — `board.json`/`meta.json` 完整 Schema、统一样式、文件系统映射规则、自动排版算法、快照格式
- `Tasks/tasks/T-0106-Agent协作白板工具开发/specs/CLI与MCP规格.md` — `board` CLI 命令参考、MCP 工具集签名、事件流
- `Tasks/tasks/T-0106-Agent协作白板工具开发/specs/线框图与里程碑.md` — 关键交互线框图、里程碑工时拆解与风险

> 实现任何模块前，先读对应的规格文件。规格中的字段表为权威定义。

## 技术栈

| 层 | 选型 |
|----|------|
| 画布渲染 | 自研画布层 —— React DOM 统一渲染全部 10 类元素；roughjs（手绘几何）+ perfect-freehand（压感笔迹） |
| 画布交互 | 自有视口（平移/缩放）、工具栏、创建 / 选择 / 变换、撤销重做 |
| 应用框架 | React + TypeScript + Vite |
| 状态/协同 | Yjs（CRDT）+ 自建中继服务器 |
| 本地服务 | Node.js（拥有 `.board` 文件夹、chokidar 文件监听、HTTP/WS API、内嵌 MCP Server） |
| 存储 | 纯 `.board` 文件夹 + `board.json`；压缩用标准 zip |

不做（MVP 范围外）：桌面 App 壳（Tauri/Electron）、P2P 同步、多 Agent 自动编排。

## 仓库结构（建议 monorepo，pnpm workspace）

```
packages/
  core/      # 共享：board.json/meta.json 类型、数据模型、文件系统映射、自动排版算法
  server/    # Node 本地服务：文件监听、双向同步、HTTP/WS API、MCP Server
  web/       # React Web 应用：自研画布层（渲染 + 创建 + 选择变换）
  cli/       # board CLI
```

`core` 是其余三个包的依赖底座，优先实现并稳定其类型与映射逻辑。

## 开发指引

### 数据模型（务必遵循 `specs/数据模型规格.md`）
- 白板根 = `.board` 文件夹：`board.json`（场景）+ `meta.json`（身份/参与者）+ `files/`（真实内容）+ `assets/` + `history/` + `.runtime/`。
- 元素 10 类：`draw`/`shape`/`connector`/`text`/`file`/`folder`/`region`/`image`/`suggestion`/`embed`，共享通用 envelope 字段。
- `z` 用分数索引字符串（协同友好）；ID 前缀 `wb_`/`el_`/`u_`/`a_`/`snap_`。
- 区域/文件夹 ⇄ 文件系统映射遵守规则 R1–R7；`autoPlaced` 标志区分自动排版与手动定位元素。

### Agent 操作模型（`specs/CLI与MCP规格.md`）
- Agent 操作白板**默认走 `board` CLI**；CLI 命令刻意贴近文件目录操作。
- MCP Server 提供与 CLI 等价的工具集；直接改 `.board` 文件夹为备选路径（仅内容类操作）。
- 内容类操作有文件系统对应物；画布类操作（图形/连线/定位/样式/进度/建议）只能经 CLI/MCP。

#### Agent 自报家门（**必读 — 涉及拟人化光标 / 协作可见性**）

任何 AI Agent（Claude Code / Codex / Cursor / 子 Agent...）用 `board` CLI 做**写操作**时必须自报身份，否则 Web 端的协作者看不到你的拟人化光标 / 头像 / 操作动画 —— 写操作"无声"发生、人不知道是你干的，会破坏 PRD §8.2 的协作体验。

写命令格式：
```bash
board <写命令> ... \
  --actor a_<你的标识>           # 必填，a_ 开头（server 端硬约束）
  --agent-name "<显示名>" \      # 可选，默认显示 actor id
  --agent-color "#xxxxxx"        # 可选，默认蓝色 #1971C2
```

涉及的写命令：`add` / `text create|append|set` / `shape` / `connect` / `region create|describe|assign|own` / `mv` / `element move` / `rm` / `style` / `comment` / `suggest create|accept|reject|describe`。

`actor` 解析优先级（高 → 低）：`--actor` > `--agent` > `BOARD_AGENT_ID` env > `u_local`（兜底人类用户）。`--agent-name` / `--agent-color` 同理可读 `BOARD_AGENT_NAME` / `BOARD_AGENT_COLOR` env。**不推荐让 Agent 仰赖 env**：env 易漂移、跨进程难追踪，自己每次显式带 `--actor` 才是契约清晰的做法。

标识建议：`a_claude_code` / `a_codex` / `a_cursor` / `a_<工具名>_<会话短ID>`。颜色按工具固定区分（Claude 紫、Codex 橙、Cursor 绿等）。

server 在跑时若 CLI 默认归属 `u_local`，会往 stderr 打一行提示作为软提醒；`BOARD_SUPPRESS_AGENT_HINT=1` 可关。

**MCP 模式：启动时绑定身份，工具调用不再每次都带**。`board mcp <白板> --actor a_<id> [--agent-name "<名>"] [--agent-color "#hex"]` 启动后，所有工具默认套用该身份；不传 `--actor` 拒绝启动（强契约，避免匿名操作落到 `u_local`）。详见 `specs/CLI与MCP规格.md §3.1`。

### 里程碑（`specs/线框图与里程碑.md`）
M0 调研验证 → M1 单人画布 → M2 空间文件系统 → M3 单 Agent 协作 → M4 多人多 Agent，串行依赖。
**当前阶段**：M4（多人多 Agent）进行中；画布层已完全自研（移除 Excalidraw 依赖，见 T-0106「自研画布层」里程碑）。详细进度在来源任务 T-0106 维护。

### 约定
- 语言 TypeScript（strict）；包管理 pnpm。
- 安全：本地服务仅监听 `127.0.0.1`。
- 数据可移植：`.board` 是纯文件夹，不引入私有数据库锁定。
- 提交信息中文，描述清楚改动；遵循 monorepo 包边界。
- Node 侧包（core/server/cli）源码的相对 import 必须带 `.js` 扩展名——编译产物需可被 Node 原生 ESM 直接运行。

### 关键风险
- ~~Excalidraw 对自定义元素类型支持有限~~ → 已确认「Excalidraw + 覆盖层 + 桥」混合架构不可持续，画布层改为完全自研、Excalidraw 依赖已移除（T-0106「自研画布层」里程碑）。
- 文件夹↔画布双向同步的一致性边界 → 已有原型与冲突规则（reconcile / 操作级同步）。
