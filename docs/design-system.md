# Board 设计系统

> 前端艺术风格规格 ｜ 关联 [[PRD]] §13
> 基调：**Excalidraw 式手绘风 × Claude 官网暖色调**。
> 落地 token 见 `packages/web/src/styles/tokens.css`；视觉示意见 `docs/style-preview.html`。

---

## 1. 设计基调

两条调性交叉：

| 来源 | 取其 | 用在 |
|------|------|------|
| **Excalidraw** | 手绘、随性、轻松；roughjs 笔触；不精确的美感 | **画布与画布内容**（图形、连线、文件卡、区域、文本卡） |
| **Claude 官网** | 暖色、克制、editorial；奶白纸感、陶土橙、近黑文字、留白 | **应用外壳**（工具栏、面板、按钮、菜单、对话框） |

**核心原则——手绘只用在"板上"，外壳保持干净：**
- 画布上的内容元素 = 手绘质感（roughjs 描边、手写体、轻微倾斜）。它们看起来"是被画/贴在白板上的"。
- 工具栏 / 侧栏 / 按钮 / 弹窗 = 干净的暖色 UI（规整边框、清晰字体）。它们是"工具"，要稳、要可读。

这条边界让产品既有 Excalidraw 的亲和力，又有 Claude 官网的高级感，且不牺牲可用性。

---

## 2. 色彩系统

全部颜色偏暖、低饱和，落在 Claude 官网的"奶白 + 陶土"语系内。

### 2.1 基础中性色

| Token | 值 | 用途 |
|-------|----|----|
| `--c-paper` | `#FAF9F5` | 画布背景（"纸"，最浅暖白） |
| `--c-cream` | `#F0EEE6` | 应用外壳背景（Claude 官网那层奶油色） |
| `--c-surface` | `#FFFFFF` | 卡片 / 工具栏 / 面板表面 |
| `--c-surface-sunken` | `#F4F2EA` | 内嵌区、输入框底、hover 凹陷 |
| `--c-ink` | `#1A1915` | 主文字 & 默认手绘描边（暖近黑） |
| `--c-ink-2` | `#6E6B62` | 次要文字（暖灰） |
| `--c-ink-3` | `#A8A498` | 占位符 / 禁用 / 三级信息 |
| `--c-border` | `#E6E3D8` | 默认边框、分隔线 |
| `--c-border-strong` | `#D4D0C0` | 强调边框、聚焦轮廓底色 |

### 2.2 强调色（Claude 陶土橙）

| Token | 值 | 用途 |
|-------|----|----|
| `--c-accent` | `#D97757` | 主强调：主按钮、激活工具、选中、Agent 默认色 |
| `--c-accent-strong` | `#BE5D3E` | hover / pressed |
| `--c-accent-tint` | `#F6E6DD` | 浅填充：选中区域底色、软按钮底、建议高亮 |
| `--c-on-accent` | `#FFFFFF` | 陶土橙上的文字 |

### 2.3 功能色（同样压暖、压饱和）

| Token | 值 | 用途 |
|-------|----|----|
| `--c-success` | `#5E7A52` | 完成、已同步（暖橄榄绿） |
| `--c-warning` | `#C99A3F` | 提醒（暗金） |
| `--c-danger` | `#B5544A` | 删除、冲突、错误（砖红） |
| `--c-info` | `#5B7C99` | 中性信息（灰蓝） |

### 2.4 参与者 / 光标色板（PRD §8.2）

人和 Agent 的在场色从这组取，全部与暖主题协调（不用霓虹色）：

`#D97757` 陶土 ｜ `#5B7C99` 灰蓝 ｜ `#7D8B6A` 鼠尾草 ｜ `#C99A3F` 暗金
`#9B6A8C` 梅紫 ｜ `#736F66` 暖石 ｜ `#B5544A` 砖红 ｜ `#5F8A82` 灰青

### 2.5 对比度

- `--c-ink` on `--c-paper`：≈ 15:1（远超 AA）。
- `--c-ink-2` on `--c-surface`：≈ 5.3:1（达 AA 正文）。
- `--c-on-accent` on `--c-accent`：≈ 3.1:1 → 陶土橙按钮文字用**加粗**且字号 ≥14px（达 AA 大字）；纯色小字场景改用 `--c-ink`。

---

## 3. 字体系统

| Token | 字体栈 | 用途 |
|-------|--------|------|
| `--font-hand` | `'Excalifont','Virgil','Patrick Hand',cursive` | **画布内文字**：图形标签、区域名、文本卡、手写注记 |
| `--font-ui` | `'Inter',system-ui,-apple-system,'Segoe UI',sans-serif` | **应用外壳**：工具栏、面板、按钮、菜单 |
| `--font-serif` | `'Tiempos','Source Serif 4',Georgia,serif` | 大标题 / editorial 场景（呼应 Claude 官网衬线标题），克制使用 |
| `--font-mono` | `'JetBrains Mono','SF Mono',ui-monospace,monospace` | 代码、ID、CLI 输出 |

- 生产环境画布手写体用 **Excalifont**（Excalidraw 开源字体，OFL 许可，与画布图形天然一致）。
- 字号阶：`12 / 13 / 14 / 16 / 20 / 24 / 32`（px；正文 14，画布文字默认 20）。
- 行高：正文 1.5，标题 1.25。
- 字重：UI 用 400 / 500 / 600；手写体仅 400。

---

## 4. 间距 · 圆角 · 阴影

### 4.1 间距（4px 基准）

`4 · 8 · 12 · 16 · 24 · 32 · 48 · 64` → token `--space-1 … --space-9`。

### 4.2 圆角

| Token | 值 | 用途 |
|-------|----|----|
| `--radius-sm` | `6px` | 小控件：工具按钮、标签 |
| `--radius-md` | `10px` | 卡片、面板、输入框 |
| `--radius-lg` | `16px` | 弹窗、大容器 |
| `--radius-pill` | `999px` | 胶囊按钮、Agent 名牌 |

### 4.3 阴影（暖色调、柔和；只用于层级，不滥用）

阴影色用暖深色 `rgba(40,36,28,a)`，非纯黑。

| Token | 值 | 用途 |
|-------|----|----|
| `--shadow-sm` | `0 1px 2px rgba(40,36,28,.06)` | 卡片静置 |
| `--shadow-md` | `0 2px 8px rgba(40,36,28,.08), 0 1px 2px rgba(40,36,28,.06)` | 工具栏、面板、hover 抬升 |
| `--shadow-lg` | `0 10px 30px rgba(40,36,28,.14)` | 弹窗、拖拽中元素 |

---

## 5. 手绘质感的运用

### 5.1 画布内容元素（手绘）

- **描边**：用 roughjs（Excalidraw 同款库）生成，`roughness ≈ 1`、`bowing ≈ 1`；默认描边色 `--c-ink`。文件卡 / 文件夹卡 / 区域 / 文本卡的边框都走 roughjs 路径，而非 CSS `border`。
- **轻微倾斜**：新建的卡片可带 `±0.6°` 随机微旋转（像随手贴上去的便签），由元素 id 派生确定值（同一元素旋转稳定，不抖动）。
- **填充**：区域底色用 `--c-accent-tint` 等浅色 + roughjs `hachure`（斜线）填充选项可选；默认 `solid` 轻填充。
- **手写体**：所有画布内文字用 `--font-hand`。

### 5.2 应用外壳（干净）

- 工具栏 / 面板 / 按钮 / 菜单：规整 CSS `border`（`--c-border`）、`--radius-*`、`--shadow-*`。
- **不**用 roughjs，**不**倾斜。保持安静、可读、像 Claude 官网。
- 允许的"手绘呼应"：激活工具下方一条手绘风格的橙色下划线（一段 roughjs 短线）、空状态用手写体 `--font-hand` 点缀。点到为止。

### 5.3 状态化描边

| 状态 | 描边 |
|------|------|
| committed（正式） | 实线 roughjs，`--c-ink` |
| draft（Agent 进行中，PRD §7.4） | **虚线** roughjs，`opacity .55`，描边 `--c-accent` |
| suggestion（建议，PRD §7.3） | **虚线** roughjs，`--c-accent`，配 "建议" 角标 + 连向原件的虚线 tether |
| selected | 元素外 4px 处一圈 `--c-accent` 选择框（干净细线，非手绘） |
| missing（文件缺失，R6） | 虚线 `--c-ink-3` + 斜纹 |

---

## 6. 动效

| 场景 | 时长 / 缓动 |
|------|------------|
| 微交互（hover / 按钮 / 切换） | 150ms ｜ `cubic-bezier(.2,0,0,1)` |
| 布局变化（面板展开、卡片重排） | 240ms ｜ ease-out |
| 弹窗出现 | 200ms ｜ 轻微缩放 .98→1 + 淡入 |
| draft → committed（提交） | 300ms ｜ 虚线收为实线 + opacity .55→1 |
| Pencil 流式产出 | 内容逐段淡入，每段 120–180ms |
| Agent 光标移动 | 位置 80ms 线性跟随（带轻微滞后，显得"活") |

尊重 `prefers-reduced-motion`：关闭非必要动效。

---

## 7. 组件配方

### 7.1 顶部工具栏
- 背景 `--c-surface`，下边框 `--c-border`，`--shadow-md`；高度 52px。
- 工具按钮 36×36，`--radius-sm`；hover 底 `--c-surface-sunken`；**激活**：底 `--c-accent-tint` + 图标 `--c-accent` + 下方 2px 手绘橙线。

### 7.2 按钮

| 类型 | 静置 | hover | 用途 |
|------|------|-------|------|
| Primary | 底 `--c-accent`、字 `--c-on-accent`、600 | 底 `--c-accent-strong` | 主操作（同意建议、确认） |
| Secondary | 底 `--c-surface`、`1px --c-border`、字 `--c-ink` | 底 `--c-surface-sunken` | 次操作 |
| Ghost | 透明、字 `--c-ink-2` | 底 `--c-surface-sunken` | 工具栏内、低优先 |
| Danger | 字 `--c-danger`、`1px` 同色 | 底 `#F3E3E1` | 删除、拒绝 |

高度 32（紧凑）/ 36（默认）；`--radius-md`；焦点环 `0 0 0 3px rgba(217,119,87,.35)`。

### 7.3 侧栏面板
- 宽 300px，背景 `--c-surface`，左边框 `--c-border`。
- 顶部页签（属性 / Agent / 评论 / 历史）：激活页签字 `--c-ink` + 底部 2px `--c-accent`；非激活 `--c-ink-2`。

### 7.4 文件卡 / 文件夹卡（画布内，手绘）
- roughjs 边框 `--c-ink`，底 `--c-surface`，`--radius-md` 视觉、微旋转。
- 图标区 + 文件名（`--font-hand`）+ 元信息（`--font-ui` 12px `--c-ink-2`）。
- 状态角标右上：新增（橙点）/ 被 Agent 改（小 Agent 头像）/ draft（橙虚环）。

### 7.5 区域（画布内，手绘）
- roughjs 边框；底 `--c-accent-tint` 8% 或自定义色低透明度。
- 头部条：区域名（`--font-hand` 20px）+ 描述（`--c-ink-2`）+ 右侧指派 Agent 头像。
- 折叠态：收成一张紧凑卡。

### 7.6 文本 / Markdown 卡（画布内，手绘）
- roughjs 边框，底 `--c-surface`；正文 Markdown 渲染。
- todo 复选框、链接（`--c-accent`）、代码块（`--c-surface-sunken` 底 + `--font-mono`）。

### 7.7 建议元素（PRD §7.3）
- 虚线 roughjs 边框 `--c-accent`，右上 "建议" 角标（胶囊，`--c-accent-tint` 底）。
- 一条虚线 tether 连到被建议元素 + 两者配对高亮。
- 卡内底部三按钮：`同意`(Primary) `拒绝`(Danger ghost) `描述`(Secondary)。

### 7.8 Pencil 任务卡（PRD §7.4）
- `--c-surface`，左侧 4px Agent 色竖条；标题 + 步骤列表 + 进度条（`--c-accent` 填充）。
- 完成态转为成功色细边 + ✓。

### 7.9 Agent / 在场光标（PRD §8.2）
- 箭头光标用参与者色；紧贴一枚圆形头像 + 胶囊名牌（参与者色底、白字、`--font-ui` 12px）。
- Agent "工作中" 时名牌带一个轻脉冲点。

---

## 8. 图标

- 线性图标，1.5px 描边，圆角线头，与 `--c-ink` 同色；尺寸 16 / 20 / 24。
- 风格在"规整线性"与"略带手感"之间——线条可有极轻微的不平直，呼应手绘但不潦草。
- 建议用一套开源线性图标（如 Lucide）做基底，必要时微调。

---

## 9. 落地

- 全部 token 落在 `packages/web/src/styles/tokens.css`，以 CSS 自定义属性提供。
- 组件样式引用 token，不写死色值。
- 画布渲染层（roughjs）从 token 读取 `--c-ink` / `--c-accent` 等。
- 深色模式：本期不做，token 命名已预留（后续加 `[data-theme="dark"]` 覆盖层）。
