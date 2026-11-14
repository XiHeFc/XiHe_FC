---
name: xhgcs
description: Use for XiHe_GCS_PRO ground station development, data analysis, serial protocols, AI panel, and local MCP integration.
---

# XiHe_GCS PRO Task Guide

先读仓库根 `AGENTS.md`。本 skill 只放任务路由和常用调用，不重复完整架构。视图插件细节读 `xhgcs-view`。

## 核心入口

- 状态：`window.XHGCS.state`（`data.js`）。原始通道 `channels`，脚本通道 `scriptChannels`，脚本 `scripts`，组件 `components`，视图 `views`，引擎 `engines`。
- 数据链：`X.injectRealValues()` / `X.stepData()` → 通道 → `xhgcs:sample` 事件。新增消费者订阅事件，不轮询数组。
- 分析：`window.XHGCS_ANALYSIS`，`computeFormula()` 本地试算，`runScript()` 执行，`ensureOutputs()` / `runAndAttach()` 建立脚本通道。
- 快速公式：`analysis-ui.js` 同屏即时试算；发布后建立内部脚本 `analysis-live`，每 500ms 更新并切到输出图表。
- 画布：`window.XHGCS_GRAPH` + `XHGCS_GRAPH_UI`；执行拓扑序，输出节点写 `scriptChannels`。
- 视图：`window.XHGCS_VIEWS`；内置也是插件。AI 构图为 `XHGCS_VIEW_BLUEPRINT.compile()` → `XHGCS_AI.composeView()`。
- 布局：`window.XHGCS_LAYOUT`；`xhgcs.layout.v3`。可视化采用 VOFA+ 固定结构：一级活动栏 + 左侧控件箱 + 中央图页 + 右侧 Data/AI Dock；日志开关在绘图工具条，Data/AI 切页不改图宽。
- 折线小窗：控件箱单击用 `window.XHGCS_VIEWS.openChartWork()` 在图上叠加柱状/表格/仪表/地图或自定义视图；主波形保持 wave。双击或 `expandChartWork()` 才切完整图页。全部通道取消时时间轴冻结，悬停显示时间游标和多通道值。
- 数据引擎：输入页 `#view-input`（活动栏「输入」= 串口链路 + 协议合并）；协议卡、已保存引擎、高级配置、AI 生成与「保存」快照都在此页；串口指令台走页头「指令台」进 `#view-serial`。
- 插件内核：`window.XHGCS_CORE`（`host`/`registry`/`commands`/`config`/`statusBar`/`engine`/`ui`）。源码 `src/`（TypeScript），产物 `assets/js/core.bundle.js`（iife，随仓库提交）。**改 `src/` 后必须** `npm run check:core && npm run build:core`。
- 外部插件：`npm run new:plugin -- --id=my.scope --name="我的示波器"` 直接生成清单+代码并登记 `plugins/index.json`；产物注册到 `window.XHGCS_EXTENSIONS[id] = {activate, deactivate}`。类型声明在 `types/xhgcs.d.ts`。贡献点/激活事件/权限细节见 `.codex/docs/plugin-architecture.md`。
- 设计器：`XHGCS_CORE.ui.openDesigner()`；文档 `xhgcs.ui` v2 存 `xhgcs.ui.doc.v1`；插件控件 = 清单 `designerWidgets` + `api.widgets.register(id, impl)`。
- 数据绑定：节点 `bind` → 文档 `bindings`（channel/channels/query + window/normalize/scale），控件只向 `series()` 要数据；key 必须带节点前缀。
- 看板：`XHGCS_CORE.ui.openBoard()`（Ctrl+Shift+B），同一份 UiDoc + DocRuntime，Esc 退出。
- AI 看板：产物类型 `board`（`ai-spec.js`）→ `XHGCS_CORE.ui.composeBoard(spec)` / `applyBoard(spec)`；模型只写窄规格。
- 数据源/回放：`XHGCS_CORE.engine.pipeline.registerSource/startSource`；`engine.recorder` + `engine.replay()`（内存录制 ÷ 倍速）。
- 视图容器：`ui.openViews()` 里同时列出插件视图与旧版 `state.views`（复用 `XHGCS_VIEWS.createViewContext`）。
- 插件视图：`XHGCS_CORE.ui.openViews()`（Ctrl+Shift+V）；实现 = `api.views.register(id,{mount,update,resize,unmount})`，ctx 有 `canvas()/channels()/series()/latest()/theme()/onSample()/onResize()`。
- 常驻引擎：`XHGCS_CORE.engine.pipeline`；`xhgcs:sample` → 有界队列 → `operators` → `sinks`，指标用 `pipeline.metrics()`；插件用 `api.pipeline.registerOperator/registerSink`（`pipeline:own`）。
- 设置页：`src/ui/settings-section.ts` 往老设置弹窗插「扩展与插件」分区。
- AI/MCP：`ai-tools.js` 有 `list_extensions` / `pipeline_metrics`；浏览器桥 payload 带 `extensions[]` 与 `pipeline{}`。
- 验证：`npm run check:core` + `node tools/core-smoke.js`（89 项）+ `npm test`（老功能 73 项）。
- 桥与发布（0.28）：`npm run test:bridge` 验 wire 层（ack data / boardId / 错误语义 / 来源白名单）；桥只认 `XHGCS_ALLOWED_ORIGINS` 精确来源（默认 8123），测试用 `*loopback*`；`release` = build → unit → bridge → smoke → regress → pack → verify。新增贡献点必须补「注册→生效→卸载→回落」用例。
- AI：`window.XHGCS_AI`；`local` 或 `dsh` 后端；`ai-spec.js` 是产物校验唯一来源。
- MCP：`mcp-server/bridge.mjs`，HTTP `127.0.0.1:8787` + stdio；写操作必须带 `X-XHGCS-Token`。

## 常用任务

1. 查看数据：MCP `snapshot(limit=1)`；需要 id/名称/量程/阈值用 `list_channels`；确实需要曲线点才用 `channel_history`。
2. 新建脚本：`create_script`，字段 `name`、`type=functions|python`、`inputs`、`formula` 或 `code`、`outputs`。
3. 新建组件：`create_component`，字段 `name`、`kind=formula|python`、`inputs`、`outputs`、`parameters`、`config`。内置组件只读，修改时复制。
4. 让脚本运行：浏览器桥合并后按 `run` 决定是否立即执行；脚本输出写回对应 `scriptChannels`。
5. 新建画布：`get_canvas` 查看，`create_graph` 传 `nodes` / `edges`，`load:true` 载入浏览器。
6. 协议：`list_protocols`；预设为 `json|ascii|hex|wed|wedfc`。`wedfc` 是 20 通道飞控规格。
7. 新建引擎：`create_engine`，必填 `name` + `preset`；可覆盖 `header/tail/terminator/checksum/byteOrder/hexScale`。WED 激活会自动建通道。
8. 运行分析：`run_analysis`；函数表达式本地算，Python/画布任务排队到浏览器。
9. 查看 AI：`snapshot().ai.tasks` 与 `snapshot().ai.tts`；任务最多 80 条。
10. 新建视图：按 `xhgcs-view` 写代码，`create_view` 后必须 `verify_view`；编辑前才用 `list_views(include_code:true)`。
11. 应用内“画视图”：`composeView()` 直达生成、自检、保存、启用，不走通用确认卡。

## AI 路由

- 无后端时明确提示 Endpoint / DSH 配置；禁止编造本地关键词产物。
- 一句“生成/画一个视图/看板/示波器”等由 `XHGCS_AI.classifyViewPrompt()` 统一分类。
- 简单构图本地编译；雷达/瀑布/散点/热力/地图等复杂图形才走模型。
- 模型失败可回退受控构图，但必须标明来源与自检结果。
- DSH agent 模式用临时 overlay，不修改用户 `~/.dsh`；answer 模式禁止工具。
- 应用内只读工具：`snapshot`、`list_channels`、`list_scripts`、`list_engines`、`list_components`、`list_views`、`get_canvas`。

## 协议摘要

- `json`：JSON 对象 + `\n`，无校验。
- `ascii`：`XH[...]*CRC16\r\n`。
- `hex`：`AA55 ... 55AA` + CRC32，定长 16bit。
- `wed`：`55 AA | len | 40B | SUM8`，20 路 uint16 大端。
- `wedfc`：WED 结构的飞控 20 通道规格，前缀 `wed-fc-`。

## 本地服务

- TTS：`tools/start-all.bat` / `tools/start.ps1`；管理端口 8770，推理端口 9880。
- Electron：`npm start`；网页：`npm run web`；桥：`npm run bridge`。
- 桌面桥会校验 `/api/health` 指纹；桥掉线由 `electron/services.js` 看门狗重建。

## 验证

- `npm test`：audit + 真实 Chromium 回归。
- `npm run check:view -- --all --json`：验证全部视图。
- `npm run audit`：死函数、孤儿 CSS、DOM id、版本串、记忆文件卫生。
- 改 `assets/` 后先 `npm run bump -- <YYYYMMDDX> [--pkg=<版本>]`，再 `npm run dist` 和桌面冒烟。

## Token 规则

- 不整篇输出 `index.html`、`styles.css` 或 `data.js`。
- 默认用 MCP 摘要；曲线点限制 10–100。
- `get_canvas` 只传 `full:true` 前先确认真要编辑。
- 不把完整 skill 注入普通对话；按任务加载。











