# 性能诊断工具与方法

Web 端（`packages/web/`）内置一套 perf 诊断工具，默认关闭、零运行成本。排查卡顿时按 [启用步骤](#启用步骤) 打开即可。

## 工具清单

| 模块 | 文件 | 作用 |
|---|---|---|
| `PERF_ENABLED` | `src/canvas/perfFlag.ts` | 全局开关，由 `localStorage:board:perf` 决定。模块加载时读一次，刷新生效。 |
| `PerfHUD` | `src/canvas/PerfHUD.tsx` | 屏幕右上角面板，实时显示 FPS / 帧耗时 / 各组件 0.5s 内重渲次数。CanvasShell 按 `PERF_ENABLED` 条件挂载。 |
| `renderCounters` | `src/canvas/renderCounters.ts` | 组件级重渲计数器。`renderCounters.bump('Name')` 累加；`PerfHUD` 周期采样并清零。 |
| `perfLog` | `src/canvas/perfLog.ts` | 操作级耗时打点。`record(name, ms?)` 累积，每秒 `console.table` 一次（次数 / 平均 / 最大 / 总耗时）。`once(name, ms?, detail?)` 直接 `console.log`。`timed(name, fn)` 包装同步函数测耗时。 |

## 启用步骤

```js
// Chrome DevTools Console
localStorage.setItem('board:perf', '1');
location.reload();
```

启用后：
- 右上角出现黑底 HUD：`FPS / frame ms / renders/0.5s` 列表
- Console 每秒一次 `console.table`，列出所有 `record()` 调用的次数与耗时

关闭：
```js
localStorage.removeItem('board:perf');
location.reload();
```

## 常驻打点位置

下列打点已写进代码，启用 flag 后立刻能看到：

| 打点名 | 位置 | 含义 |
|---|---|---|
| `OverlayLayer` (counter) | `OverlayLayer.tsx` 顶部 `bump` | 主覆盖层重渲次数 |
| `OverlayLayer.render` | `OverlayLayer.tsx` useEffect | 单次 render 耗时（仅 render 阶段，不含 commit） |
| `ConnectorLayer` / `ConnectorLayer.render` | `ConnectorLayer.tsx` | 连线层 |
| `ElementSlot` | `ElementSlot.tsx` | 单个元素卡槽。memo bail-out 时不增加 |
| `BoardCtx.render` / `BoardCtx.scene-cb` | `BoardContext.tsx` | Context 重渲 / Y.Doc 推送 scene 回调 |
| `YDoc.update` / `YDoc.update[origin]` / `yDocToScene` | `BoardContext.tsx` | Y.Doc update 事件频率、按 origin 分类、scene 投影耗时 |
| `processPointerMove` / `dragStore.setOffset` / `snapForDrag` | `OverlayLayer.tsx` 拖动路径 | 拖动元素时各步耗时 |

## 诊断套路

### 1. 体感卡顿 → 先看 FPS

打开 HUD：
- FPS ≥ 55（绿）：可能不是真卡，是视觉同步问题（如连线没跟随）
- FPS 30~55（黄）：有持续掉帧
- FPS < 30（红）：严重，重点排查

### 2. 哪里在频繁重渲 → 看 HUD 的 renders/0.5s

- 单一组件每秒 > 60 次：**直接异常**，必有 setState 循环
- OverlayLayer 60 次/秒：60FPS 内反复重渲，正常 pan / drag 应该是 0
- ElementSlot 数字应该接近 0（除非元素在变换中）

### 3. 哪一步慢 → 看 console.table

按 `totalMs` 降序看顶部几行。`maxMs` 极端高（>16ms）= 单次卡顿源。

### 4. setState 死循环 → 看 React 警告

`Maximum update depth exceeded` 警告会指到 setState 调用位置。但**真正源头是某个 useEffect 的依赖每次 render 都变**，要往上看 React component stack。

## 历史排查案例

### 案例：pan 整张白板时极卡（2026-05-27）

**现象**：滚轮 / 中键平移面板时 OverlayLayer 一秒重渲 1500+ 次。

**根因链**：
1. `CanvasShell` 直接 `const viewport = useViewport()` 订阅 viewport store
2. 每次平移 → store 通知 → CanvasShell 重渲
3. CanvasShell 是 `OverlayLayer / Minimap / Toolbar / ...` 的父，整棵子树跟着重渲
4. CanvasShell 的 `follow` effect 依赖 `[followingClientId, followed]`，`followed` 是 `.find()` 派生，每次 render 都是新引用 → effect 反复跑 → 触发 `viewportStore.set` → Maximum update depth

**修复**：CanvasShell **完全不订阅** viewport。`zoom%` 显示拆成独立子组件 `<ZoomBadge />`，在它自己内部订阅。pan 时只有 ZoomBadge（一个 `<button>{N}%</button>`）重渲，整棵画布子树零工作。

**经验**：父组件订阅高频 store **等于**整棵子树跟着重渲。订阅必须下放到真正消费数据的最叶子。

### 案例：拖动元素卡（同期）

**根因**：`setDrag({ ...d, offsetX, offsetY })` 每个 pointermove 都触发 OverlayLayer 全量重渲。

**修复**：拖动 offset 抽到外部 `dragStore`，slot 注册 DOM ref 给 store，store 直接 mutate slot 的 `style.transform`，**完全 bypass React**。`setDrag` 仅在 threshold 越过的瞬间调一次。连线跟随通过 `useDragOffsetVersion` 单独订阅 offsetListeners。

### 案例：流式加载延迟（同期）

**现象**：pan 到新区域，新元素不出现，必须点击某处才"加载"。

**根因**：`visibleElements` useMemo 走了虚拟化分支，依赖里没 `viewport`（因 OverlayLayer 不订阅 viewport），所以 pan 时不重算。

**修复**：取消虚拟化，永远返回 `base`。`ElementSlot` 已 memo，off-screen 元素不重渲，仅多占少量 DOM 内存。元素量级 100+ 时如需虚拟化应单独做一层（独立订阅 viewport store 节流后通知 visibility store，OverlayLayer 不参与）。

## 当前架构守则

- **OverlayLayer 不订阅 viewport**：viewport 变化时它不能重渲。需要 zoom/scroll 在事件处理器里 `viewportStore.get()` 读快照。
- **CanvasShell 不订阅 viewport**：同上。zoom% 等少量 UI 走独立小组件。
- **slot transform 由 dragStore DOM mutate**：拖动期间 ElementSlot 不重渲，连线靠 `useDragOffsetVersion` 单独订阅。
- **新加 store 订阅前先想**：父级会被它带着重渲吗？所有子组件都会跟着重渲吗？如果是，把订阅下放到叶子，或者把订阅源拆出独立子组件。
