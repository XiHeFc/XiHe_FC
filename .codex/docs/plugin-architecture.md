# XiHe_GCS 插件内核架构

> 目标：把地面站从「一个写死的上位机」变成「一个可被扩展的工作台」。
> 对标物是 VS Code：内核只认识注册表、宿主、渲染器、调度器；所有具体能力（包括内置的波形、协议、AI 工具）都是贡献点。

本文是**当前实现**的说明书，不是路线图。代码与本文冲突时以代码为准。

## 1. 分层

```
index.html
  ├─ assets/js/core.bundle.js      ← src/ 构建产物（iife），加载顺序第一位
  ├─ assets/js/data.js …           ← 老应用，原样未动（回滚点）
  └─ assets/js/boot.js             ← 老应用的懒加载器

src/
  core/     registry · manifest · semver · when · host · api · config · statusbar · storage · commands
  ui/       命令面板 · 扩展管理面板
  designer/ ui-doc · history · renderer · widgets · plot · designer
  engine/   protocol（协议注册表）· operators（算子注册表）
```

为什么内核先加载：它只定义 API、不碰 DOM（除状态栏挂载）。老代码照旧跑，坏掉时删掉
`core.bundle.js` 那一行 `<script>` 就回到改造前。

## 2. 三个对象

| 对象 | 职责 | 不允许做的事 |
|---|---|---|
| `ContributionRegistry` | 按贡献点存 `{id, value, owner}`；卸载=按 owner 清空；变更派发事件 | 不认识任何具体扩展 |
| `ExtensionHost` | 发现→解析→激活→停用；依赖拓扑；失败隔离 | 不直接画 UI |
| `ExtensionApi` | 按权限投影给插件的能力对象 | 不暴露 `window.XHGCS` 内部 |

## 3. 贡献点

| 贡献点 | 载体 | 现状 |
|---|---|---|
| `commands` | 清单数据 + 激活时 register | ✅ 命令面板 / 快捷键 / 状态栏 / 菜单共用 |
| `menus` | 清单数据 | ✅ `rail`（左侧活动栏）已渲染 |
| `keybindings` | 清单数据 | ✅ 全局 keydown，按 `when` 过滤 |
| `views` | 清单数据 + `api.views.register` | ✅ 容器（Ctrl+Shift+V）：左列选中 → onView 激活 → 真挂载 |
| `statusBar` | 清单数据 + `api.statusBar` | ✅ 左/右对齐、优先级、语义色、`when` |
| `configuration` | JSON-Schema 子集 | ✅ 类型/范围/枚举校验、变更订阅、独立持久化、设置页内嵌 |
| `themes` / `protocols` / `operators` / `dataSources` / `aiTools` / `designerWidgets` | 清单数据 | ✅ 注册；协议与算子已接到执行链 |
| `pipeline:own`（运行时） | `api.pipeline` | ✅ Operator/Sink 可注册，常驻引擎带背压与时间戳 |

清单示例：

```json
{
  "id": "xihe.demo.hello",
  "name": "插件示例：链路体检",
  "version": "1.0.0",
  "apiVersion": "1",
  "engines": { "xhgcs": "^0.10.0" },
  "main": "main.js",
  "activationEvents": ["onCommand:demo.linkReport"],
  "permissions": ["data:read", "ui:statusBar", "ui:toast", "config:read"],
  "contributes": {
    "commands": [{ "id": "demo.linkReport", "title": "链路体检", "category": "示例" }],
    "statusBar": [{ "id": "demo.channels", "text": "链路 ✓", "command": "demo.linkReport" }],
    "configuration": { "properties": { "warnChannels": { "type": "number", "default": 8, "minimum": 1, "maximum": 64 } } }
  }
}
```

## 4. 激活事件

| 事件 | 触发点 |
|---|---|
| `onStartup` / `*` | 内核启动 |
| `onCommand:<id>` | 命令第一次被执行（命令未注册时宿主会先按此事件拉起插件再重试） |
| `onPanel:<id>` | 点左侧栏 / 设置页签 |
| `onView:<id>` | 视图第一次被选中（待接） |
| `onConfig:<key>` | 设置项被访问（待用） |
| `onProtocol/Operator/DataSource:<id>` | 引擎里第一次用到该扩展（待用） |

代码只在命中时才 fetch + 执行；未激活的插件只贡献清单数据。

## 5. 权限

权限是**投影**：没有声明就没有属性。

```
data:read data:write ui:view ui:panel ui:statusBar ui:toast ui:menu
config:read config:write storage:own commands:execute
protocols:own operators:own datasources:own network fs:own
```

`network` 默认不授予 —— 插件网络访问必须显式声明并在扩展面板里可见。
跨源 `main` 入口在清单校验阶段就被拒；`watch_view` 那套 lint 仍然管视图代码。

## 6. 可视化设计器

- 文档：`xhgcs.ui` v2 = `{ root(控件树), bindings(绑定表), cols, rowHeight }`，纯 JSON。
- 布局：12 列栅格，控件用 `{x,y,w,h}` 落位。**不用绝对像素做真值**，不同窗口宽度下同一个文档不会错位。
- 属性面板 100% 由控件的 `propSchema` 生成 —— 加控件不用改设计器。
- 撤销重做是**命令式**（inverse patch），不是快照。拖拽/连续输入用 `transaction` 合并成一条，200 步上限。
- 未知控件类型保留节点并渲染「缺少控件」占位；导入非法 JSON 会被 `normalizeDoc` 修补而不是整份丢弃。
- 同一份 `DocRuntime` 同时服务编辑态与预览态，杜绝「设计器里和跑起来不一样」。

内置控件：折线示波、仪表盘、柱状对比、环形占比、数据表、数值卡、文本。
插件控件：清单声明 `designerWidgets` + `api.widgets.register(id, impl)`，`impl` 返回 `{render, resize, setProps, dispose}`。

### 6.1 数据绑定（bindings 是真相）

控件不认识通道。节点上的 `bind: string[]` 指向文档的 `bindings` 表：

```json
{ "bind": ["n1:b1"], "bindings": { "n1:b1": { "source": "channel", "ref": "ch1", "transform": { "fn": "window", "args": { "limit": 120 } } } } }
```

- `source`：`channel` / `channels` / `query`（名字子串，`*` 全选）/ `state`（暂不作为序列）。
- `transform`：`window`（最近 N 点）/ `normalize`（0-1）/ `scale`（×k）。
- 没有 `bind` 时回退 `props.channels`（早期文档兼容），再回退“前三条通道”。
- 解析失败不抛错：返回空序列 + `issues`，属性面板里以黄字列出“哪个通道不存在”。
- 绑定 key 带节点前缀（`<nodeId>:b1`），两个控件各自用 `b1` 也不会互相覆盖。

### 6.2 看板运行态（Kiosk）

`Ctrl+Shift+B` 或设计器头部「⤢ 运行看板」：

- 同一份 `UiDoc` + 同一个 `DocRuntime`，编辑态与运行态不会漂移。
- 全屏、顶部条 2.6s 无操作自动隐去、`F` 切全屏、`Esc` 退出。
- 适合现场投屏/值班大屏；数据每 250ms 刷新。

**看板库（0.16）**

- 存储：`xhgcs.ui.boards.v2` = `{ version, activeId, boards[] }`，单 key 保证迁移原子性，上限 50 块。
- 唯一写入口 `src/designer/board-store.ts`；设计器保存、AI 生成、MCP、看板运行都走它。
- 设计器头部有看板下拉 + `＋` 新建 / `⧉` 复制 / `🗑` 删除；复制与删除会重启设计器以加载新板。
- v1 存档自动迁移并保留原档与 `.bak`；导入 JSON = 新增一块板，不覆盖正在编辑的内容。
- AI 生成看板覆盖**当前活动板**（「做个看板」是替换，不是堆积）。
- 决策记录见 `.codex/docs/adr/0003-board-store-v2.md`。

**看板增量补丁（0.17）**

AI 改看板不重新生成整块，只提交 5 种操作的补丁：

```json
{ "action": "board_patch", "ops": [
  { "op": "update", "id": "n123", "channel": "ch2" },
  { "op": "add", "widget": { "type": "table", "query": "*" } },
  { "op": "move", "id": "n456", "grid": { "x": 0, "y": 6 } },
  { "op": "rename", "name": "姿态总览" }
] }
```

- 实现在 `src/designer/board-patch.ts`：**先全量校验、再原子应用**；任何一处非法（未知 id/通道、非白名单属性、
  ops>50、`baseUpdatedAt` 过期）整包拒绝，文档一个字节都不改。
- `add` 复用 `composeBoard` 生成控件与绑定，栅格没给就取 `findFreeSlot`。
- 应用前整份文档备份到 `xhgcs.ui.patch.backup.v1`，`core.boards.revertPatch()` 一步还原。
- 应用后派发 `xhgcs:board-changed`；打开着的设计器会**自动重开**到最新文档（自己保存不派发，不会自触发）。
- AI 侧：只读工具 `list_boards` / `get_board`（返回里直接提示“改看板请用 board_patch”）；
  产物类型 `board_patch` 走统一确认闸门，预览卡片只显示操作计数。

### 6.3 新旧两套视图统一
视图容器左列现在是两组：

1. **插件视图**：清单 `contributes.views` + `api.views.register()`（新契约，ctx 由内核投影）。
2. **自定义视图（旧版）**：`state.views[]` 里的表达式代码，复用老运行时
   `XHGCS_VIEWS.compileSource` + `XHGCS_VIEWS.createViewContext` 挂载，`update` 按 250ms 驱动。

这样 AI 以前生成的视图不用重写就能进新容器；新写的插件视图也不会被旧体系挡住。

### 6.4 AI 生成看板

模型**不直接写 UiDoc**（嵌套树 + 绑定表，写坏概率太高）。产物注册表里新增了 `board` 类型，
模型只输出窄规格：

```json
{ "action": "board", "name": "姿态看板", "widgets": [
  { "type": "scope", "query": "angle", "points": 120 },
  { "type": "gauge", "channel": "ch1" }
] }
```

- `check`：类型白名单、控件数 1~12、通道 id 必须存在（不存在就回灌可读错误让模型自己改）。
- 预览卡片：几个控件、各类型数量；点「应用」才落库。
- 落库：`XHGCS_CORE.ui.applyBoard(spec)` → `composeBoard` 生成 UiDoc（自动栅格排布 + 逐节点绑定 key）
  → 写 `xhgcs.ui.doc.v1` → 立即全屏运行。
- 同一套 `composeBoard` 也暴露给 MCP/外部脚本，不经过模型也能出看板。

### 6.5 界面约定（踩过的坑）

- **`grid-area` 只允许一处实现**：`renderer.gridAreaOf()`。简写顺序是 `row-start / column-start / row-end / column-end`，
  写反了不会报错，表现是「所有控件挤在左上角互相盖住」。
- **编辑器与看板的高度策略不同**：编辑器按内容算 `minHeight`（留两行余量给拖入），
  看板用 `grid-template-rows: repeat(usedRows, 1fr)` 铺满视口；`DocRuntime.sync()` 会重置 `minHeight`，
  所以看板在每次 `refresh()` 之后都要重新覆盖。
- **不要自动聚焦文本框**：打开设计器就聚焦标题输入框会吞掉 Ctrl+Z / Delete 等画布快捷键
  （浏览器把 Ctrl+Z 当成输入框撤销）。只有真正的文本输入才让快捷键让位，复选框/下拉不算。
- **颜色只用 `var(--*)` 令牌**，半透明边框用 `rgba(255,255,255,.07~.12)`；面板统一 14~16px 圆角 + 大阴影。
- **层级**：命令面板 9600 / 扩展面板 9600 / 设置分区内嵌 / 视图容器 9620 / 设计器 9700 / 看板 9760 / toast 9900。
  看板必须高于设计器，「运行看板」才能从设计器里直接切过去。

#### 0.23 交互基线（UI 整改落地）

- **Esc 只有一个主人**：`src/core/overlay-stack.ts`。新式浮层打开即入栈，Esc 只问栈顶；
  栈顶的 `onEscape()` 可以「先失焦、再取消选中」，返回 `true` 表示已消化。老代码
  （`app-core.js` / `analysis-ui.js` / `serial-picker.js` / `layout.js`）用
  `window.XHGCS_OVERLAY.depth() > 0` 让位，不再出现「一次 Esc 退两层」。
- **焦点可见性**：全局 `:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px }`。
  旧焦点环 `rgba(--k-blue,.45)` 实测只有 2.4:1，低于 WCAG 3:1。
- **令牌补齐**：`--ok`、`--accent`、`--fg`、`--fg-2` 以前只被引用、从未定义（`--ok` 的硬编码回退在浅色下 1.81:1）。
  现在 `--ok` 指向 `--k-green-t`，浅色主题自动加深。
- **注入样式必须用令牌**：`src/ui/**`、`src/designer/**` 里的字面量 `rgba(109,168,210,…)` 已全部换成
  `rgba(var(--acc-rgb), …)`；`--acc-rgb` 在 dark / light / codex 三套主题里各自定义，所以强调色会跟着主题走。
- **命令面板底色**：从写死的深色渐变改成 `var(--bg2) → var(--bg)`，浅色主题对比度从 **1.12:1 提到 15:1**。
- **Dock 是舞台级**：`layout.ensureDockPortal()` 把 `#workspaceDock` 从 `#view-wave` 里提到
  `.stage-main`（与 `.view-stack` 并排），切到串口/告警页不再消失；左栏「AI」只展开 Dock，不再把人拽回可视化。
- **术语收敛**：左栏「引擎」→「协议」（页面标题「协议与帧解析」）；常驻管线面板 →「数据管线」，
  快捷键 `Ctrl+Shift+E`，状态栏文案「管线 N」。
- **空态三分法**：图表区 `#chartEmpty` 区分「没有可见通道 / 有通道但无数据」，给三条出路
  （打开仿真页 / 连接串口 / 查看协议），而不是让用户对着一块空网格猜。
- **AI 优先在 Dock**：`Alt+3` 在任何视图都能开 AI；`Alt+1/5/6/7/8` 直达视图（`2/3` 留给 Dock、`4` 留给日志）。
- **控件箱折叠**：`#btnCollapseSwitch` 以前没有任何监听（点了没反应），现在接 `LAYOUT.toggleSwitchCollapsed()` 并持久化。
- **层级模型（0.26）**：`--surf-0..3` + `--surf-inset` 定义窗底/面板/卡片/浮层/凹槽，`--edge-hair/soft/strong` 管描边，`--elev-1..3` + `--elev-inset` 管阴影，`--seam-x/y` 把面板边界从 1px 硬线改成拼接缝。`--bg/--bg2/--bg3/--well` 全部别名到 surf 令牌，存量 400+ 处引用自动跟随。**面板级容器禁止 `1px solid var(--line)`**；卡片靠"底色差 + 发丝边 + 阴影"浮起。规范见 `.codex/docs/ui-elevation-spec.md`。`n- **左栏点击语义统一（0.24）**：单击任意项 = 切换整页（含自定义视图）；`Alt+单击` 或工具条「▣ 小窗」= 叠加预览。原来内置项单击开小窗、自定义项双击弹编辑器，同一列三种语义。窄屏（≤1200）隐藏小窗下拉，键盘路径仍可用。
- **视觉收口（0.27）**：`.chl-tabs` / `.chl` / `.chl-val` 用窄选择器 + `!important` 做级联隔离（旧主题覆盖层 16 条规则互相争夺，选中态被压平）；数值 22px/650 独占一行、量程退第二行、3px 色脊替代 8px 圆点；图表画布改 `--surf-inset` 同色（浅色不再是一块白屏）；三条标题带对齐到 84px、两条底栏对齐到 910px；浅色墨阶拆成 `--heading #101822` / `--text #33404f` / `--num #0b111a`。

## 7. 数据引擎
```
serial.js ──parseFrame()──► engine.protocols.decode(engine, raw)  ──null──► 内置分支
graph-engine ──runGraph()──► engine.operators.run(node, ctx)      ──null──► 内置分支
```

两条都是**可回滚的缺口**：注册表没命中时行为与改造前逐字节一致。
新增第六种协议：写一个 `ProtocolAdapter`（`protocols:['MYBIN']` + `decode` + 可选 `ingest/encode/definitions`），
不再需要改 `serial.js`。

## 7.1 常驻数据引擎（Source → Operator → Sink）

分析画布是「按需跑一次的 DAG」；管线是「每个采样点都流经的常驻链路」。两者不共用执行器，
因为约束完全不同：画布要拓扑序，管线要背压和帧预算。

```
xhgcs:sample 事件 ──► attachLegacySampleSource ──► ingress 队列（有界 4096）
                                                      │  满 → 丢最旧帧（dropped++）
                                                      ▼
                              requestAnimationFrame 里按 8ms 预算 drain
                                                      ▼
                            Operator*（按 order 串行，插件可注册）──► Sink*（指标 / 写回通道 / 插件端点）
```

- **每帧带时间戳**：`{ t, wall, source, values, filled }`。`wall` 让跨源对齐和回放可行，
  `t` 与通道时间轴同语义，`filled` 保留前向填充标记。
- **背压**：入口有界；处理按 `budgetMs` 切分，超预算就留到下一帧，UI 帧率优先。
- **失败隔离**：阶段或端点抛错只计数 + 记最近 5 条，继续处理下一帧。
- **默认链路**：`builtin.pass` + `builtin.metrics`。写回通道的 `builtin.channels` 端点**注册但默认关闭** ——
  双写通道会让用户看到两份数据。
- 插件：`api.pipeline.registerOperator({id,label,order,process})` / `registerSink({id,label,write})`，
  需要 `pipeline:own` 权限。
- 观测：`Ctrl+Shift+P → 数据引擎监视`（或 `xhgcs.pipeline`）看队列/丢弃/错误/阶段开关；状态栏常驻「引擎 N」。

**数据源与回放**

- 源契约只有一个：`{ id, label, start(emit), stop() }`。背压/调度都在管线，源不需要关心。
- 内置两个：`builtin.legacy-sample`（主数据链 `xhgcs:sample` → 最新值快照，启动即接上）
  与 `builtin.replay`（内存录制按原始 `wall` 间隔 ÷ 倍速重放，保留原始 `t`）。
- 录制：`FrameRecorder`（默认 6000 帧容量）既是 Sink 也能被回放源读取；录制端点
  `builtin.record` **默认关闭**，在引擎面板里一键开启，面板上能看到已录帧数。
- 回放时 `t` 是数据时间、`wall` 换成当前时间 —— 这正是“数据时间与到达时间分离”的最小验证。

## 7.2 视图容器

`views` 贡献点有了消费者：`Ctrl+Shift+V`（或左侧栏「视图」）打开容器。

- 左列是清单里声明的视图，右列是真实挂载区；选中时先 `fireEvent('onView', id)` 拉起插件，再取实现挂载。
- 契约：`api.views.register(id, { mount?(ctx), update?(ctx), resize?(ctx), unmount?(ctx) })`，四个都是可选的。
- `ctx` 只给能力不给全局：`width/height/theme()/channels()/latest()/series()/canvas()/onSample()/onResize()/toast()/esc()`。
  `canvas()` 自带 dpr 适配，`onSample` 合并到每帧一次。
- 切换/关闭时一定调 `unmount`；更新抛错只写脚注，不炸掉容器。

## 7.3 设置页与 AI 可观测面

- **设置页集成**：老设置弹窗里多一个「扩展与插件」分区，包含扩展列表（启停/重载）与 schema 生成的配置表单。
  实现不改 `app-actions.js`，而是自己插按钮 + section 并复刻 active 切换，避免被老代码重构带崩。
- **AI 工具**：`list_extensions`、`pipeline_metrics` 两个只读工具进 `ai-tools.js`，模型能自己查
  “插件在不在、引擎跑没跑”。
- **MCP**：浏览器桥 `buildPayload()` 每轮带上 `extensions[]` 与 `pipeline{}` 摘要，外部 MCP 客户端
  拿 `snapshot` 就能看到内核状态，不需要新增工具面。

## 7.4 长跑热点（已做 / 待做）

已做：

- `persist()` 去重：序列化结果与上次写入一致、且存储未被外部改动时跳过写盘。**语义仍是同步写** ——
  调用后立刻读 `localStorage` 必须拿到最新状态，这一点被回归用例钉死，不允许改成延迟写。
- 设计器数据解析带耗时告警：单节点解析超过 8ms 会在控制台点名，方便定位慢绑定。
- 告警扫描快路径：没有阈值、也没有历史告警态的通道直接跳过，避免每帧给全部通道构造告警对象（语义不变）。

待做（按收益排序）：

1. `pushSample` 的 `push + splice(0, n)` 是 O(n) 热路径（180k 点 × 20 通道）。改成 RingBuffer 或分块裁剪，
   但会改变 `ch.data` 的可见长度，必须连带改录制/CSV/视图读取点。
2. `updateAlarms()` 每帧全通道扫描，可改为 10Hz + 脏通道。
3. 上帝循环里的固定节拍（50ms 重绘 / 100ms 日志 / 300ms 统计）应改为事件驱动。

## 7.5 用户扩展目录（装机版，0.18）

- 目录：`%APPDATA%\XiHe GCS PRO\extensions\<id>\`，首启自动创建；
  `XHGCS_DESKTOP.extensions` 暴露 `dir / list / openDir`。
- 静态服务新增 `/ext` 挂载点：`createStaticServer(root, { mounts: [{ url, dir }] })`，
  **每个挂载点单独做 canonical path 检查** —— 加一条路由不能顺带把 `..` 放出去。
- 主进程扫描规则：只认 `<id>/xhgcs.extension.json`、清单 id 必须等于目录名、
  入口文件必须留在插件目录内（符号链接逃逸一并拒绝），并把 `main` 改写成 `/ext/<id>/main.js`。
- 内核 `host.discoverUserExtensions()` 在启动时调用；与内置 id 冲突时保留内置并告警；
  Web / file:// 模式没有这个 API，直接跳过，行为不变。
- 设置页「扩展与插件」分区新增「打开用户插件目录」直达按钮。

**授权与启停（0.19）**

- `granted = 清单声明 ∩ 用户勾选`；用户扩展未授权时停在 `pending`，**代码不会被加载**。
- 指纹 = 版本 + 权限集合 + 入口标识。任何一项变化都要求重新授权 —— 插件升级偷加 `network` 会被挡住。
- 高风险能力（`network` / `fs:own` / `data:write`）在授权页**默认不勾选**；其余默认勾选。
- 扩展面板里逐项勾选后「授权并启用」；设置页列表提供一键「授权」（高风险仍需去扩展面板勾）。
- 停用状态持久化在 `xhgcs.ext.state.v1`，重启后保持停用；`host.applyPersistedState()` 在启动时套用。
- 撤销授权会先 `deactivate` 再回到 `pending`，已注册的贡献点全部回收。
- 仍然是**能力投影，不是沙箱**：安装来源必须可信，这条在 ADR 0002 里写死。

## 7.6 算子参数（0.20）

- 阶段契约：`PipelineOperator` 增加可选的 `params: OperatorParamSpec[]` 与 `configure(values)`；
  没有 params 的阶段与以前行为完全一致。
- 运行时：`pipeline.operatorParamValues(id)` 给出「默认值 + 用户改过的」，`setOperatorParams(id, patch)`
  **立即 configure 生效**、记错误、并广播给订阅者。热重载后注册时自动套用已存参数。
- 持久化：`xhgcs.pipeline.params.v1`，由 `engine.bindPipelineParamPersistence()` 在启动时套用、之后每次改动落盘。
  放在引擎入口而不是面板里，是因为 MCP / 脚本也可能改参数，必须同一处写。
- 面板：引擎监视面板按 schema 生成输入框（数字/文本/开关），改完即生效。
- 内置可调阶段：线性缩放（channel/k/b）、一阶低通（α）、滑动均值（通道/窗口）、阈值标记（通道/上下限），默认关闭。
- 版本号的坑：`satisfies()` 对认不出的比较符会默认放行，所以清单校验先用 `isValidRange()` 拦住非法区间
  （这条是单元测试发现的真实缺陷）。

## 8. 写一个插件

一条命令起步：

```bash
npm run new:plugin -- --id=my.scope --name="我的示波器"
# 生成 plugins/my.scope/{xhgcs.extension.json, main.js} 并自动登记 plugins/index.json
```

生成物不是空壳：清单里已经有一条命令 + 一个状态栏项 + 一项配置，`main.js` 里的命令真能跑
（统计通道数、按阈值标色）。改完在扩展面板点「重载」即可热更新，不用重启。

类型补全：把 `types/xhgcs.d.ts` 引入插件工程，`/** @type {XhgcsExtension} */` 就能拿到
ctx / api / manifest 的完整类型。

手工写也只需要两个文件：

```
plugins/
  index.json                     { "extensions": [{ "manifest": "my.plugin/xhgcs.extension.json" }] }
  my.plugin/
    xhgcs.extension.json
    main.js
```

`main.js`：

```js
window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};
window.XHGCS_EXTENSIONS['my.plugin'] = {
  activate(ctx) {
    ctx.api.commands.register('my.hello', () => ctx.api.toast('hello'));
    ctx.subscriptions.add(ctx.api.config.onDidChange((key, value) => ctx.log(key + '=' + value)));
  },
  deactivate() { /* 内核会自动注销贡献与订阅 */ }
};
```

调试：`window.XHGCS_CORE.host.list()` 看状态，Ctrl+Shift+X 打开扩展管理，`host.reload('my.plugin')` 热重载。

## 9. 验证

```bash
npm run test:unit         # 内核纯函数单测（semver / when / manifest）
npm run check:core        # 类型
npm run build:core        # 产物
node tools/core-smoke.js  # 88 项内核冒烟（真 Chromium）
npm test                  # 73 项老功能回归，必须保持全绿
npm run verify:dist:self  # 打包验收脚本自检
```

发布门禁（一条命令）：

```bash
npm run release           # 单测 → 冒烟 → 回归 → 类型 → 内核构建 → 打包 → verify:dist
```

`tools/verify-dist.cjs` 会比对 `app.asar` 里必须存在的文件（内核产物、示例插件、`types/xhgcs.d.ts`、
架构文档等）。**插件目录和类型声明不进包**是这类项目最典型的发布事故 —— 源码全绿、装机版缺文件，
所以它必须是一条硬门禁，而不是人肉检查。

新增贡献点时的最低要求：core-smoke 加一条「注册 → 生效 → 卸载 → 回落」的用例。

## 9.1 MCP 看板工具（0.21）

- 工具：`list_boards / get_board / create_board / update_board / open_board / undo_board`。
- 看板文档在浏览器 localStorage 里，桥看不到，所以读操作也走「排队 → 浏览器执行 → ack 带 `data` 回传」。
  为此 `waitForQueueBatch` 的结果增加了 `data` 字段，浏览器侧 `results.push({id,ok,error,data})`。
- `update_board` **默认 dry_run**：只跑 `core.boards.previewPatch` 校验，不落库；`dry_run:false` 才应用，
  应用前整份文档备份，`undo_board` 一步回退。
- 浏览器侧执行体是 `window.XHGCS_BRIDGE.applyBoardAction`，测试与真实 MCP 调用共用同一条路径
  （避免「测试绿的、线上另一套实现」）。

## 10. 现在还没做的（0.22.0 视角）

**按 ADR 0001 明确不做**（是决策，不是遗漏）：

- 插件市场、代码签名/PKI、iframe/Worker 沙箱；
- 实时管线分支/合并 —— 多条 Sink 已经能扇出，真正的 DAG 编译器成本远超收益；
- 多窗口、云同步、自动更新、看板轮播、zip 插件包导入。

**仍欠的（按优先级）**：

1. 告警扫描仍是每帧全通道过一遍（有「无阈值通道」快路径），应改成 10Hz + 脏通道通知。
2. 上帝循环的固定节拍（50ms 重绘 / 100ms 日志 / 300ms 统计）应改为事件驱动；改动面大，未动。
3. `serial.js` 的 JSON/ASCII/HEX 文本协议仍在老代码里，迁移到协议适配器是下一步。
4. 装机版手工验收 runbook（授权弹窗、用户目录装插件、全屏看板、断线重连）还没固化成脚本。
5. 设计器对齐辅助线（吸附）未做；当前靠 12 列栅格 + 方向键微调 + Shift 改尺寸。
6. 插件热替换只做到「重载」，没有灰度/自动回滚。

**性能基线**：`npm run bench` 生成 `.codex/docs/perf-baseline.md`。
通道历史分块裁剪（窗口 + 2048 才 splice）在 20 通道 × 20 万点的微基准里快 **522×**；
真实收益随窗口填充时间增长，长跑才是主战场。







