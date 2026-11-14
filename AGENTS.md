# XiHe_GCS_PRO 工程指南

本文件是工程默认事实源，只保留当前架构、硬约束和验证入口；任务步骤加载对应 skill，历史复盘查 `.codex/docs/engineering-history.md`（别整篇注入上下文）。

## 当前入口核对（0.30.1 · UI10）

- 当前 `index.html` 是 UI10 壳（样稿 v115 装为前端）：外壳、页签、状态栏、自由工作台都在入口内的 IIFE；`data.js`、`protocol.js`、`serial.js`、`v43-bridge.js` 以外部模块加载（`assets/js/`），前端版本串 20261103A。下文旧壳模块地图描述的是仓库保留能力，不能据此假定模块已经在当前页面运行。
- 外壳与真实数据的接口：`XHGCS.state` 的通道/图页、`xhgcs:sample` 事件 → 外壳 `feedFromApp`（按 `sampleTimeline` 的时间戳/有效性/断流入样）；串口链路由 `XHGCS_SERIAL` 与 `XHGCS_DESKTOP.serial` 驱动，选口面板由 `v43-bridge.js` 提供。工作台画布是样稿自己的页/控件模型，尚未与 `XHGCS.plots` 双向映射——这是 UI10 后续要接的部分。
- 采样可信度约定不变：`X.sampleTimeline(ch)` 返回同长的内存时间戳、墙钟、有效性、越量程标记；缺失/保持值不得再次 scale/offset；显示量程不裁剪实际采样。外壳图表按 `valid/gapLimit` 断笔。
- 验证：`npm run test:samples`（数据核心）。`npm run test:ui` 的断言基于 UI9 壳，UI10 下暂不适用（需按新壳重写）；`npm test`/audit 的旧 DOM 约束同样如此——如实报告失败，不能删断言或跳过门禁冒充通过。

## 文档路由

- 代码、测试输出和运行时行为优先于任何说明文件。
- `AGENTS.md`：默认约束与模块地图；`CLAUDE.md`：短适配层，只指向本文件与 skills。
- `.codex/skills/xhgcs/SKILL.md`（数据链/MCP/AI/脚本/画布任务步骤）、`.codex/skills/xhgcs-view/SKILL.md`（视图硬契约/`ctx` API/画风/自检）。
- `.codex/docs/`：`engineering-history.md` 历史复盘（定位回归按关键词读）；`ai-contracts.md` AI 硬契约（改 AI 前必读）；`release-review-0.27.0.md` 发布评审对表；`plugin-architecture.md` 内核/设计器实现。
- `README.md`：用户安装使用说明，不作架构事实源。

## 项目地图

- `index.html` + `assets/css/styles.css` + `assets/js/*`：零构建前端地面站，双击 `index.html` 可运行。
- `src/`：插件内核（TypeScript）：`src/core/*` 注册表/宿主/命令/配置/状态栏，`src/designer/*` 设计器，`src/engine/*` 协议与算子。
- `assets/js/core.bundle.js`：内核构建产物（iife 普通脚本），`npm run build:core` 生成，**随仓库提交**。
- `plugins/` 外部扩展（`plugins/index.json` 清单，每插件一目录）；`electron/` 主进程、静态服务、串口选择、子进程托管、录制、桌面配置。
- `mcp-server/bridge.mjs`：一个进程同时提供 HTTP `127.0.0.1:8787` 与 MCP stdio。
- `tools/`：静态体检、Chromium 回归、视图验收、内核冒烟、桌面冒烟、打包版本工具；`build/` 构建资源、`dist/` 安装包与 portable，均不参与源码编辑。

## 插件内核（src/）

- 插件内核、贡献点、权限投影、激活事件、设计器/看板存储、数据引擎细节：见 `.codex/docs/plugin-architecture.md`；新增全局只从 `src/core/index.ts` 的 `window.XHGCS_CORE`（host/registry/commands/config/statusBar/engine/ui/boards）进，别再新增全局。
- 权限是**投影**不是提示：没声明的能力（network / data:read / ui:statusBar…）在 `ctx.api` 上不存在；卸载 = `registry.unregisterAll(owner)` + dispose 订阅；任何扩展抛异常都不许影响启动与其他扩展。
- 看板唯一写入口 `src/designer/board-store.ts`（别处禁写 localStorage），v1 自动迁移留 `.bak`；AI 生成看板窄规格由 `composeBoard` 生成 UiDoc、`XHGCS_CORE.ui.applyBoard(spec)` 落库。
- 设计器关闭即保存：`close()` 默认 save（`pagehide` 兜底），外部补丁重开用 `close({save:false})`。

## 状态与持久化

- 唯一应用状态 `window.XHGCS.state`（`assets/js/data.js`），持久化键 `xhgcs.pro.config.v1`。
- 插件配置 `xhgcs.ext.config.v1`（`配置` 贡献点，`扩展id/键` 扁平化）；私有存储 `xhgcs.ext.<id>.*`。**别往主快照加插件字段**：persist 全量序列化。
- 设计器文档 `xhgcs.ui.doc.v1`（纯 JSON，可导出/导入），卸载插件不删；工作区布局 `xhgcs.layout.v3`（旧格式只由 `layout.js` 迁移）。
- 桌面配置 `%APPDATA%\Xuanji\desktop-config.json`（`electron/store.js` 防抖写）；录制只允许 `electron/recorder.js` 写 `%APPDATA%\Xuanji\recordings`，渲染层只走 IPC 批量提交。
- AI 消息内存上限 60 条、持久化留最近 40 条并去掉与 `content` 重复的 `raw`，子任务最多 80 条；localStorage 超限先压缩 AI 历史/任务/阈值再重试，仍失败必须 warning + `xhgcs:persist-failed`。
- MCP 删除墓碑只留最近 200 个 id；渲染进程禁止直接访问 Node 或文件系统，桌面能力只能走 `window.XHGCS_DESKTOP` + preload + `ipcMain.handle`。

## 数据链

- 串口字节由 `serial.js` 拆帧解码，唯一真实数据注入点 `X.injectRealValues()`；仿真由 `X.stepData()` 推进，两者都派发 `xhgcs:sample`。
- 原始通道在 `state.channels`，脚本/分析输出在 `state.scriptChannels`；新消费者订阅 `xhgcs:sample`，别新增轮询通道数组。
- 脚本输出用 `scriptId` + `outputId` 映射；改分析/组件/画布输出时必须保持映射一致。
- WED 飞控规格 `wed-fc`：`55 AA | len | 40B payload | SUM8`，20 路 uint16 大端；协议预设与通道模板从 `protocol.js` 派生，改规格必须补回归。
- 历史点数由 `state.historyHours` / `state.historyPoints` 统一管理，通道写入必须走 `X.pushSample(ch, value)`。
- 性能/引擎/扩展点：`pushSample` 分块裁剪（基准 522×，`npm run bench`）；常驻引擎 `src/engine/pipeline.ts`（`xhgcs:sample` → 有界队列 → 8ms 预算 → Operator* → Sink*，满丢最旧；写回端点默认关闭，面板 `xhgcs.pipeline`）；协议/算子扩展点 `src/engine/protocol.ts`、`operators.ts`（老代码缺口：执行前先问注册表）。

## 快速公式与图表

- 快速公式工作台（`analysis-ui.js`）：即时试算 → 数值/统计/迷你曲线/链路同屏；「运行并查看图表」建内部脚本 `analysis-live`（500ms 刷新，不进普通脚本卡片）；已发布公式改动必须显示「未发布修改」，试算不许污染已发布通道。
- 可视化工作区：活动栏 + 控件箱 + 图页 + 右 Dock（Data/AI 只换内容不改图宽，专注模式可让位），布局在 `XHGCS_LAYOUT`；图页状态 `state.plots`/`state.activePlot`，`channels:null` = 跟随全局。
- 控件箱单击柱状/表格/仪表/地图 = 折线图叠加可拖动小窗（双击/小窗全屏才切图页）；全部通道取消时时间轴冻结；悬停给时间游标与各通道值；主波形支持自动/统一/归一化 Y 轴、聚焦、抽稀与末端标签。
- 数据引擎在「输入」一级页 `#view-input`（活动栏「输入」= 串口链路 + 协议合并；串口指令台走页头命令进 `#view-serial`）；算子参数 `PipelineOperator.params + configure`，`setOperatorParams` 即时生效并落 `xhgcs.pipeline.params.v1`，面板按 schema 生成输入框。

## AI 与可视化视图

- `window.XHGCS_AI` 负责模型对话与产物动作；`ai-spec.js` 是脚本/画布/引擎/组件/视图/**看板/看板补丁**校验与预览的唯一注册表（7 类产物）。
- 无后端时明确提示配置，禁止恢复本地关键词“假生成”；后端为 `local`（OpenAI 兼容）或 `dsh`（DeepSeek Harness）。
- 简单视图请求直达 `composeView()`：分类 → 构图编译/模型生成 → lint → 真挂载自检 → 保存 → 启用；构图板在 `view-blueprint.js`（趋势/对比/占比/指标块生成受控 `ctx.draw`），复杂图形才走模型。
- 视图插件只能用 `ctx` 与浏览器原生 API，禁网络、裸定时器、硬编码色值；规则以 `XHGCS_VIEWS.viewApiDoc` 与 `lintViewCode()` 为准；画布布局算术只允许 `view-kit.js` 的 `ctx.draw.plot/scope/bars/donut`，混画不同量纲用 `normalize:true`。
- AI 生成视图必须以 `XHGCS_VIEW_VERIFY.verify()` 的 9 项检查为准；未通过不能宣称已生成。

## AI 工具边界

- 应用内只读工具：`snapshot`、`channel_history`、`list_channels`、`list_scripts`、`list_engines`、`list_components`、`list_views`、`get_canvas`、`list_extensions`、`pipeline_metrics`、`list_boards`、`get_board`。
- 写操作走动作协议、预览/确认和统一保存入口，不允许从只读工具循环直接落库；不把完整 Skill 拼进普通对话，多轮历史保持有界。
- DSH agent 模式只写系统临时 overlay，运行后删除；不得修改用户 `~/.dsh` 配置。
- **AI 硬契约**（产物自证 / `diagnoseError` 错误模型 / DSH stderr 状态机 / 上下文预算 / 工具面 / 运行态事件 / MCP 写工具四件套）：见 `.codex/docs/ai-contracts.md`，改 AI 链路前必读。

## MCP 桥

- `/api/health` 返回 `name=xhgcs`、代码指纹 `sha` 和 `pid`；桌面版只接管指纹一致的桥，异常退出由 `electron/services.js` 看门狗拉起。
- 写请求必须带 `X-XHGCS-Token`；CORS 只回**精确**白名单（默认 `127.0.0.1:8123`，`XHGCS_ALLOWED_ORIGINS` 覆盖，`*loopback*` 仅测试）；`/api/state` 也要 token；不发 `Access-Control-Allow-Private-Network`。
- 浏览器轮询 `/api/state`、桥排队工具、浏览器 `/api/ack` 回传结果；实时数据工具是异步往返；协议预设 `json`/`ascii`/`hex`/`wed`/`wedfc` 先按 id 精确匹配再走关键词。
- MCP 写工具面：脚本/引擎四件套 `update_script`/`delete_script`/`update_engine`/`delete_engine`（id 或 name 定位；update 保 `id/builtin/origin/createdAt` 重走 normalize；内置只读；活动引擎拒删；墓碑 ≤200 + in-place 合并；`applied:true` 才算成功）。详见 `ai-contracts.md` §7。
- 六个 `*_board` 工具：看板读操作也排队，ack 带 `data`；`update_board` 默认 dry_run；执行体 `XHGCS_BRIDGE.applyBoardAction`；桥 payload 带 `extensions[]`/`pipeline{}`。
- 随机端口起页面的测试（regress/core-smoke）会被精确白名单挡红：注入 `XHGCS_ALLOWED_ORIGINS`，或把 `/api/health` 拒绝当预期噪声（限定 URL + 错误类型）。

## 代码与 UI 约定

- 老前端（`assets/js/*`）用原生 ES5/ES6 IIFE，**不引框架、不改打包**；新模块挂 `window.XHGCS_*`。新内核（`src/**/*.ts`）允许 TS + 类型检查，但**产物必须是单个 iife 普通脚本**（`core.bundle.js`）以保住双击 `index.html` 可运行；禁 ESM 入口与运行时第三方依赖。改了 `src/` 必须 `npm run check:core && npm run build:core` 并提交 `core.bundle.js`。
- DOM 绑定优先稳定 id；共用能力挂 `X`，禁止重复实现 HTML 转义、MCP URL 拼接等基础函数。
- 所有持久化显示状态必须在启动时由状态反向同步：选中态、显隐状态、按钮文案三处一起查；同一状态只保留一个来源，持久化开关的每条点击路径都必须调 `X.persist()`。
- 浮层必须挂 `document.body`（玻璃面板的 `backdrop-filter` 会成为 fixed 子元素包含块）；表单浮层中间滚动、头和动作行固定、页脚不被挤出可视区。
- 可缩放画布容器必须 `position:relative`，canvas 绝对填充；不给受控 `.vp-plot` 内 canvas 手写百分比高度。
- 桌面 IPC 全走 `handleTrusted`（校验 senderFrame origin）；`will-navigate`/`will-redirect` 只放行自身 origin；packaged 关 F12/DevTools；替换 IPC 别把包装器里的 `ipcMain.handle` 一起换掉（自递归）。
- UI 层级只用 `--surf/--edge/--elev/--seam`（`ui-elevation-spec.md`），面板禁 1px `--line`；Esc 走 `overlay-stack.ts`，Dock 舞台级，左栏单击=切页/Alt+单击=小窗；设置页集成走 `src/ui/settings-section.ts`，不改 `app-actions.js`。

## 验证与发布

- 静态检查 `npm run audit`；全量 `npm test`（先 audit 再 Chromium 回归），数量以输出为准。内核：`npm run check:core` + `node tools/core-smoke.js`；构建 `npm run build:core`（开发期 `npm run watch:core`）。
- 视图验收 `npm run check:view -- --all --json`；相关用例 `node tools/regress.js --filter=<关键字>`；桥 wire 契约 `npm run test:bridge`（`tools/bridge-contract-smoke.cjs`）。
- 开发：网页 `npm run web`（`py tools/serve.py`），Electron `npm start`；改 `assets/` 后必须 `npm run bump -- <YYYYMMDDX> [--pkg=<版本>]` 再打包。
- **版本三处同源**：`npm run bump` 只改前端版本串（index.html/boot.js/layout.js/start.ps1）与 `package.json`；`CORE_VERSION` 在 `src/core/manifest.ts:19`（无 `version.ts`）必须手工同步，否则 audit 门禁红。
- 打包 `npm run dist`（代理导致下载失败时只清当前命令的代理环境，别改系统代理）；`release` 不含 `dist`，对外发布 = `release` → `dist` → `verify:dist` → 装机冒烟（`--remote-debugging-port=<port>` 启动装机版 + `npm run smoke --silent -- <port>`，期望 `ERRORS []`；`ELECTRON_RUN_AS_NODE` 非空会让 exe 变 node）。
- 发布门禁 `npm run release`（单测→冒烟→回归→构建→打包→`verify:dist`）；electron-builder 默认排除 `.d.ts`，`types/` 走 `extraResources`。发布前核对：源码版本、安装目录 exe 版本、`app.asar` 哈希、快捷方式目标、装机冒烟必须一致。
- 测试判定：瞬时红先复跑（`--filter` 3 次 + 全量）再判，全绿判脆断言并加稳定性处理，禁 skip/删断言；fixture 必须真实抓包且 `git ls-files` 可见；打桩照上游真实输出；`regress.js` 单写手交接。详见 `.codex/docs/ai-contracts.md` §8。
