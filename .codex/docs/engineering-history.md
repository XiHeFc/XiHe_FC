# XiHe_GCS_PRO 历史工程笔记（按需检索）

> 这是 2026-10-19 从原 `AGENTS.md` 原样归档的历史资料，保留具体 UI 复盘、截图结论和排障过程。
> 它**不会**作为默认 Agent 指令自动加载；代码与当前 `AGENTS.md` 优先。遇到历史回归、布局细节或旧问题对照时再按关键词搜索。

# XiHe_GCS_PRO 仓库说明

## 核心事实
- 纯前端地面站：直接双击 `index.html` 即可运行，无需构建。
- 数据状态统一存在 `window.XHGCS.state`（`assets/js/data.js`），localStorage 键为 `xhgcs.pro.config.v1`。
- 原始通道在 `state.channels`，算法/脚本输出在 `state.scriptChannels`；通道面板 Tab 切换 `state.channelTab`。
- 脚本库在 `state.scripts`，可复用组件库在 `state.components`（CRUD：`X.addComponent/updateComponent/removeComponent/getComponent`）；函数/分析执行器为 `window.XHGCS_ANALYSIS`；节点画布在 `state.analysis.canvas`，引擎为 `window.XHGCS_GRAPH`，UI 为 `window.XHGCS_GRAPH_UI`；数据引擎在 `state.engines`。
- 公式作用域与公式名：`X.formulaScope()` 把**全部**通道（含脚本通道）按公式名绑进作用域，`X.formulaAlias(id)` 给非法标识符的通道 id 取稳定别名（飞控 `wed-fc-01 → c01`，中文通道名本身合法就直接用）；`XHGCS_ANALYSIS.computeFormula` 不再只绑勾选通道，单通道 `mean(ch1)` 就是它自己的历史均值，MCP 桥 `runFunctionScript` 同一套 alias；带减号的 id 直接写进公式会给出可照做的提示而不是 `SyntaxError`。`X.createScriptFromPrompt(prompt, options)` 的输入优先级：对话框勾选 → 描述里点名的通道 → `state.analysis.inputs` → 第一个通道；找不到通道时不要回退成 `ch1,ch2,ch3`。
- 数据分析画布是一级视图 `#view-analysis`（左侧竖列第 4 个入口，`data-nav="analysis"`），由 `navigate()` 与 `state.view` 驱动：`XHGCS_ANALYSIS_UI.open()/close()` 只是 `navigate('analysis')` / `navigate('visual')` 的快捷方式，不要再把它弹回 `#analysisModal` 那种二级浮层。
- 可视化视图为插件：`window.XHGCS_VIEWS`（`assets/js/views-plugins.js`），内置波形/柱状/数据表/仪表/地图也是插件（`builtin:true`），自定义视图存在 `state.views` 并随配置导入导出。可视化页采用 VS Code 式工作区：视图/通道/AI/日志是右侧活动栏控制的互斥抽屉，图表在抽屉打开时仍保持全宽；布局状态在 `xhgcs.layout.v2`，入口是 `window.XHGCS_LAYOUT`。
- 「画一个数据视图」走 `assets/js/view-blueprint.js`：趋势/对比/占比/指标块先形成结构化构图，再由 `XHGCS_VIEW_BLUEPRINT.compile()` 生成受控 `ctx.draw` 代码；`XHGCS_AI.composeView()` 一次完成生成、真挂载自检、保存与启用，简单构图优先本地编译，不等待外部 Agent。
- 数据源在 `state.simulation.enabled`；`assets/js/serial.js` 提供 `window.XHGCS_SERIAL`，负责 Web Serial 连接与 JSON/ASCII/HEX/WED 帧解析。仿真关闭后真实帧通过 `X.injectRealValues()` 写入原始通道。
- 主题：`state.theme`（`dark`/`light`/`auto`，默认 dark），`X.setTheme/themeName/applyTheme` 与设置页「外观主题」联动，落在 `html[data-theme]`；CSS 变量见 `styles.css` 的 `html[data-theme="light"]` 段。画布内颜色不走 CSS 变量，必须用 `X.canvasColors()`（bg/grid/frame/axisText/tagBg 等），新增画布视图同理。
- 玻璃面板带 `backdrop-filter`，会成为 `position: fixed` 子元素的包含块；浮层（如 `#chartTooltip`）必须挂在 `document.body` 下，不能留在面板内部。
- 通信协议模块 `assets/js/protocol.js` 提供 `window.XHGCS_PROTOCOL`，内置 JSON/ASCII/HEX/WED 预设与 `PRESETS/presetArray/presetFor`；WED 帧结构统一为 `55 AA | len | 40B 负载 | SUM8`（20 路 uint16 大端），走二进制解析，切换数据引擎会清空串口缓冲。WED 按 `protocolId` 分规格：`WED_PROFILES` 里 `wed-telemetry`（传感器，通道 id 前缀 `wed-`）与 `wed-fc`（飞控，前缀 `wed-fc-`），`wedProfileId(engine)`/`wedProfile(engine)`/`definitions(engine)` 一律按规格取值；两种规格 id 前缀故意不重合，老脚本按 id 引用通道不会被顶掉。
- AI 面板和浏览器内 AI 为 `window.XHGCS_AI`，界面绑定在 `ai-ui.js`；引擎界面在 `engine-ui.js`。AI 面板输入“生成/画一个视图/看板/仪表盘”会直达 `composeView`，不再进入通用动作确认卡；左侧画笔与「＋ → 画一个视图」打开构图板。
- 快速公式是一个同屏工作台：`analysis-ui.js` 在公式输入后即时调用 `XHGCS_ANALYSIS.computeFormula()` 显示数值、统计、迷你曲线和「输入→公式→输出」链路；「运行并查看图表」会写入 `analysis-live` 实时脚本、持续每 500ms 更新，并切到只显示该输出的波形页。脚本库默认收起，避免再次挤掉结果区；`analysis-live` 不出现在普通脚本卡片里。
- AI 产物语义（脚本 / 画布 / 引擎 / 组件 / 视图的校验、归一、确认卡片、动作示例）只有一份：`assets/js/ai-spec.js`（`window.XHGCS_AI_SPEC`）。生成入口、聊天动作、确认卡片都从这里取；`mcp-server/bridge.mjs` 的 MCP 工具 schema 由 `tools/regress.js` 的契约用例对齐，别在桥里另写一套判定。
- 应用内只读工具在 `assets/js/ai-tools.js`（`window.XHGCS_AI_TOOLS`）：模型可以先调 `snapshot` / `list_channels` / `list_scripts` / `list_engines` / `list_components` / `list_views` / `get_canvas` 再回答。**写操作不进工具循环**——创建类动作仍走动作协议 + 确认卡片，否则会绕过「先预览、点应用才落库」那道门。
- AI 子任务在 `state.ai.tasks`，每次脚本/画布/引擎/分析操作与 AI 回复都会记录；设置“AI 子任务”页可查看、试听、复制、删除。
- TTS 模块 `assets/js/tts.js` 提供 `window.XHGCS_TTS`，支持 Edge 浏览器本地语音与 GPT-SoVITS `/v1/audio/speech`，配置在 `state.ai.tts`；`assets/js/tts-worker.js` 提供 `window.XHGCS_TTS_WORKER` 后台串行播报队列，`assets/js/tts-audio-worker.js` 负责 GPT-SoVITS 音频合成，支持 `chat` / `alarm` / `both` 三种模式。
- 本地 SoVITS 启动脚本为 `tools/start-sovits.ps1`，先检查 9880 推理端口，再启动 8770 管理代理。
- 一键启动器为 `tools/start-all.bat` / `tools/start.ps1`：同时拉起 8123 静态页、8787 MCP 桥与 8770/9880 本地 TTS，静态页就绪后立即打开浏览器，TTS 在后台并行加载。
- 本地 TTS 依赖 `D:\GPT-SoVITS-src`（管理代理与推理引擎）与 `D:\GPT-SoVITS-v2pro-20250604`（模型/NLTK/FFmpeg 资源）；启动器会注入 FFmpeg `PATH`、`NLTK_DATA`，日志在 `D:\GPT-SoVITS-src\logs`。
- 任务顺序：`data.js -> protocol.js -> serial.js -> analysis.js -> graph-engine.js -> ai.js -> tts.js -> views-* -> app-* -> layout.js -> analysis-ui.js -> graph-ui.js -> engine-ui.js -> ai-ui.js -> bridge.js`。
- `boot.js` 在首帧后并行加载 AI/TTS/画布；`tools/serve.py` 对带 `?v=` 的版本资源返回一年 immutable 缓存、HTML 不缓存，画布滚轮直接缩放、端口连线带 32px 吸附，波形图按采样间隔节流绘制。
- 桌面版为 Electron：入口 `electron/main.js`，`npm start` 开发运行、`npm run dist` 打包到 `dist/`（NSIS + portable，x64）。`electron/static-server.js` 内置静态服务（缓存策略同 `tools/serve.py`），`electron/services.js` 用 `ELECTRON_RUN_AS_NODE` 托管 `mcp-server/bridge.mjs` 并按需启动本地 TTS，`electron/store.js` 把窗口状态/串口记忆写到 `%APPDATA%\XiHe GCS PRO\desktop-config.json`。
- 渲染进程只能通过 `electron/preload.js` 暴露的 `window.XHGCS_DESKTOP` 使用桌面能力；`assets/js/desktop.js` 负责“设置 → 桌面版”面板与首次自动启用 MCP 桥，网页版靠 `body:not(.is-desktop) .desktop-only` 隐藏这些入口。串口选择由主进程 `select-serial-port` 接管并记住 `lastSerialPort`。
- 桌面版与网页版同源 `http://127.0.0.1:8123`，共用同一份 localStorage；验证桌面版用 `node tools/desktop-smoke.js <cdpPort> [--settings]`（先以 `--remote-debugging-port` 启动）。
- 长时数据落盘：主进程 `electron/recorder.js` 是唯一写盘方（`fs.writeSync` 同步追加、按大小轮转、超总量上限删最旧会话），目录 `%APPDATA%\XiHe GCS PRO\recordings`，会话为 `session-*/data-000N.csv` + `manifest.json`；渲染层 `assets/js/recorder.js`（`window.XHGCS_RECORDER`）只做批量缓冲，经 `window.XHGCS_DESKTOP.recordings` 走 IPC，配置在 `state.recordings`。
- 工程化命令都在 `package.json`：`npm test` = 静态体检 `tools/audit.cjs`（死函数 / 孤儿 CSS 类 / `$('#id')` 指向不存在的节点 / 前端版本串不一致 / CSS 括号配平，任一不干净 exit 1）**先跑**，再跑 `tools/regress.js` 的真实 Chromium 回归（11 个用例，约 12 秒，不接串口、不开 Electron，用本机 ms-playwright 的 chromium）。另有 `npm run audit`（只体检）、`npm run bump -- <新日期串> --pkg=<新版本>`、`npm run smoke --silent -- <cdpPort>`（装机版冒烟，期望 `ERRORS []`）。
- 共用实现只留一份，挂 `window.XHGCS`：桥接地址拼接 `X.mcpUrl(path)`（`bridge.js` / `ai.js` / `analysis.js` / `graph-engine.js` 都调它）、Python 降级解析 `X.pythonOneLine(code)`、HTML 转义 `X.esc(value)`。同类语义不同实现的函数不要重名（`engine-ui.js` 的转义叫 `escapeControlChars`，不是 `esc`）。改了 `assets/` 下的前端代码后必须 `npm run bump` 升版本串，再 `npm run dist` → 静默安装 → `npm run smoke`，别让仓库和装机版对不上。

## 数据链路
- `app-core.js` 的 `requestAnimationFrame` 每步调用 `X.stepData()`，随后异步执行关联脚本的 `XHGCS_ANALYSIS.tick()`。
- 脚本输出通过 `outputId` 映射回对应脚本通道，脚本删除时同步删除其脚本通道。
- 节点画布按拓扑序计算 source/math/filter/fft/python/component/output；`component` 节点按 `config.componentId` 引用组件库，运行和渲染优先使用组件库当前定义，`config.componentSnapshot` 只在组件缺失时兜底；保存画布脚本时嵌入 `componentSnapshots`，MCP/AI 创建的画布也会内置快照。公式组件支持 `mean/sum/rms/std/min/max/slope/lowpass/add/sub/mul/div` 与 `x1/x2/v1/v2/p_参数名`。输出节点写入 `scriptChannels`；修改输出标签后需保证 `scriptId`/`outputId` 一致。
- 仿真帧由 `X.encodeEngineFrame()` 按当前数据引擎生成；真实帧由 `serial.js` 解析并调用 `X.injectRealValues()`。修改引擎后调用 `X.setActiveEngine(id)` 并保存。
- 每个采样点都会派发 `xhgcs:sample`（`detail.source = simulation|serial`）：`stepData()` 与 `injectRealValues()` 各一次，落盘等外部消费统一挂这个钩子，不要新增轮询读数组。
- WED 引擎激活时调用 `X.applyProtocolChannels(engine)` 会按该引擎的规格重建 20 个原始通道；偏置换算落在通道侧——`channelScale` 写进通道 `scale`、`channelOffset:-bias` 写进通道 `offset`，用户能在界面「倍率/偏移」里改，`def.scale` 保持 1，decode 不做二次缩放。MCP 创建并激活 WED 引擎、AI 生成 WED 引擎都会自动执行。
- 飞控 WED 规格 `wed-fc`（预设 key `wedfc`，`PRESETS.wedfc.sample` 是可对拍的合法帧）槽位：0-2 姿态角(°) / 3-5 姿态角速度(°/s) / 6-8 陀螺原始(°/s) / 9-11 LADRC 控制量 / 12-15 电机 PWM（阈值 1040/1480，怠速 1100 不算低值）/ 16 观测器 z1 角度估计 / 17-18 观测器 z2 与低通 / 19 机体 Z 加速度。

## MCP 桥
- 本地桥：`mcp-server/bridge.mjs`，同时提供 HTTP(`127.0.0.1:8787`) 和 MCP stdio。
- `/api/health` 回报 `sha`（`bridge.mjs`+`bytes.mjs` 的摘要）与 `pid`。桌面版启动时以此判断 8787 上已有的桥：指纹一致才接管；不一致（含没有指纹的旧版）就结束那个进程、起自己的。两端算法必须保持一致（`electron/services.js` 的 `bridgeFingerprint`）。
- 浏览器启用“MCP 桥”才会持续 POST `/api/state`；Agent 通过 MCP 工具创建脚本/画布/引擎/组件后，浏览器下次轮询自动合并、挂载并运行。
- 模型列表：浏览器通过 `POST /api/ai/models` 让桥向**用户配置的那个端点**请求 `/v1/models`；不再扫描本机进程或常见端口。对话仍然走 `POST /api/ai/chat` 代理，也可在设置中关闭代理后由浏览器直连。`state.ai.disableThinking` 默认开启，DeepSeek 等思考模型会发送 `thinking:{type:"disabled"}`，避免推理耗尽 Token 导致无内容。
- MCP `list_protocols` 返回内置协议摘要；`create_engine` 推荐 `preset=json|ascii|hex|wed|wedfc`（`wedfc` = 飞控 20 通道规格），支持字段覆盖与 `payloadBytes`/`channelCount`/`checksum`/`byteOrder`/`hexScale`。认预设必须**先按 id/protocolId 精确匹配再走关键词**，否则 `wed` 这类关键词会一律命中传感器规格。
- 数据引擎预设卡与通道模板都从 `protocol.js` 的规格表派生，改规格必须同步 `PRESETS`/`WED_PROFILES`/`channelTemplates` 三处并在 `tools/regress.js` 补对拍用例。
- MCP 组件工具：`list_components`、`create_component`、`update_component`、`delete_component`。公式组件使用 `config.formula`，Python 组件使用 `config.code`；创建组件后可先 `create_graph` 再引用 `component` 节点。
- MCP 视图工具：`list_views`、`create_view`、`update_view`、`delete_view`，外加 `verify_view`（真挂载自检）。`code` 是返回 `{id,mount(ctx),update(ctx)}` 的 JS 表达式；浏览器桥自动编译并写入 `state.views`，`snapshot()` 返回视图摘要。视图的接口/画风/自检规范见 `.codex/skills/xhgcs-view/SKILL.md`，MCP 队列 `view_verify` 让浏览器跑自检并把报告经 `verifyReports` 回传（`assets/js/bridge.js`）。
- MCP `snapshot` 同时返回 `ai.tasks` 摘要与 `ai.tts` 状态。
- MCP `list_channels` 列出原始与脚本通道（id / 名称 / 单位 / 量程 / `warnLow,warnHigh`（null=未设）/ 最新值 / 样本数）；`snapshot` 的通道也带阈值，`serial.rate` 是实测采样率，`recording` 说明当前是否在录制。
- 验证：`node --check` 全部 JS；`node mcp-server\bridge.mjs`；`Invoke-RestMethod http://127.0.0.1:8787/api/health`。
- 不要在回答中让用户重复读取大文件；优先使用 MCP `snapshot` 和 `channel_history`，默认限制长度。

## 约定
- 使用原生 ES5/ES6 IIFE，不要引入构建工具或第三方前端依赖。
- 所有 DOM 绑定使用 id，新文件统一挂到 `window.XHGCS_*`。
- 新增桌面能力时统一走 `window.XHGCS_DESKTOP` + `ipcMain.handle`，不要在渲染进程引入 Node 或第三方依赖；改前端后同步升 `index.html`/`boot.js`/`layout.js` 的 `VERSION`。
- 修改分析或脚本映射时，必须保持 `scriptId`/`outputId` 与 `state.scriptChannels` 一致。
- 删除组件不会自动删除画布节点；被引用时先确认，缺失组件会在画布标记“组件不存在”并阻止运行。
- AI 后端有两种，都在 `state.ai.backend`：`dsh`（默认；DeepSeek 官方 CLI，走桥的 `/api/ai/dsh`）与 `local`（任意 OpenAI 兼容 API，走桥的 `/api/ai/chat`）。浏览器起不了进程，DSH 必须由 `mcp-server/bridge.mjs` 代跑，桥不在线时 DSH 后端不可用。**内置的本地意图匹配已经删除**：没配后端时 `send()` 直接给出引导，`generate*` 明确失败，不再用关键词表造产物。
- DSH 的 `state.ai.dshMode`：`agent`（默认）会在 `runDshTask` 里写一份临时 overlay（`--patch`）挂上 `@deepseek-ai/dsh-mcp-client` → 本地 `bridge.mjs --mcp-stdio` 代理，并设 `DSH_PERMISSION_MODE=danger-full-access`；`answer` 只做纯问答、明确禁止工具。overlay 写在系统临时目录、跑完即删，**不要改用户的 `~/.dsh` 配置**。`--mcp-stdio` 只走 stdio、不绑 HTTP，`tools/call` 转发给正在跑的主桥（令牌从 `/api/health` 现取）。
- 后端不流式时正文只在 `result.content` 里：`send()` 的 content 变量是靠 `onDelta` 累积的，非流式（DSH、或关掉「流式输出」）拿不到任何 delta，必须回填 `result.content`，否则回复被吞成空串、而 meta 里的 ms/finish 一切正常。
- 视图插件只能用 `ctx` 与浏览器原生 API，禁止网络请求和裸定时器（用 `ctx.interval/ctx.frame`）；内置视图不可删除，自定义视图删除只移除插件。
- 视图插件画风必须走令牌：颜色/字体取 `ctx.theme()`（= `X.canvasColors()`，新增了 `font{body,strong,title,mono}`），DOM 版用 `styles.css` 的 `.vp-*` 工具类；**禁止**插件里硬编码色值。`XHGCS_VIEWS.lintViewCode()` 是生成端（AI/设计器）与自检端（`assets/js/view-verify.js`）共用的唯一规则表；用了 `ctx.draw.*` 原语就等同满足画风要求（原语内部走令牌），不要再单看代码文本里有没有 `ctx.theme()`。`XHGCS_VIEW_VERIFY.verify()` 会离屏真挂载跑若干帧并给出 contract/mount/update/render/style/dom/dpr/fit/teardown 九项检查；AI 生成视图后必须自检，不许只说「已生成」。
- 画布图的坐标轴/图例宽度/量程/裁切只允许走 `assets/js/view-kit.js`（`window.XHGCS_VIEW_KIT`，经 `ctx.draw.plot/scope/bars/donut` 暴露给插件）：让模型逐行手算「图例画多宽、刻度取多少」，结果必然是图例被右边裁掉、曲线挤成一条、图例名字全变成 `P…`。新增绘图形状先往 view-kit 加原语，不要在插件里再写一套布局算术。
- 插件里的画布尺寸一律用受控槽 `.vp-plot`（`ctx.draw.plot()` 自带）：**不要**给嵌套在 `.vp-card`/`.vp-wrap` 里的 canvas 手写 `height:100%`——父级高度不确定时百分比高度退化成 auto，浏览器改用 `canvas.height` 属性当 CSS 像素，画布会逐帧放大直到撑破宿主（`fit` 检查就是抓这个）。直接挂在 `.view-plugin-host` 下的 canvas 仍走 `width/height:100%`，别改。
- AI 生成视图统一走 `XHGCS_AI.generateView()`：注入真实通道清单（`XHGCS_VIEWS.channelDigest()`）→ 出代码 → lint + 真挂载自检 → 不合格就带错误清单让模型自动修正一次 → 仍不合格才回退本地模板。对话里的「生成一个XX视图」也走这条链，不要再直接贴 `fallbackTemplate`。
- MCP 桥的 `mergeComponent/mergeView` 只按内容指纹判定变化（忽略 `updatedAt/createdAt`），且只在真正写入了脚本数据时才 `switchChannelTab('script')`；否则每轮轮询都会把用户手选的通道页签抢回脚本数据。
- 画布视口 `state.analysis.canvas.viewport` 是 `{x,y,zoom}` 对象而不是数组，`ensureCanvas()` 每帧都会跑，任何把它当数组判断的写法都会在每次渲染时把画布重置回原点；新增节点用 `freeSpotNear()` 找空位，不要改回固定偏移。
- 设置里的 Voice 是真实下拉框：浏览器引擎列出 `speechSynthesis.getVoices()` 的系统语音，SoVITS 引擎列出接口音色；传给 `SpeechSynthesisUtterance` 的 `voice` 必须是真实的 `SpeechSynthesisVoice`，`lang` 必须是合法 BCP-47。
- 保持说明和 skill 精简，以降低后续 agent token 消耗。
- AI 生成有两个入口，产物必须一眼分清：画布工具条的「AI 生成流程」（`#btnGraphAiFlow`）产出节点流程，脚本库的「AI 生成脚本（函数 / Python）」（`#btnAnalysisAiScript`）只产算式。两者共用 `#scriptDialog`，靠 `openScriptDialog({ mode:'flow' })` 切模式（流程模式隐藏「输出标签 / 类型」`#sdRow`、按钮文案变「生成流程」）。流程的 source 节点走 `graph-engine.js` 的 `promptSourceIds(prompt, options)`：描述点名 → 调用方勾选 → 分析页勾选 → 前几个真实通道；不要再写死「电压→ch1 / 电流→ch2」那种表，换 WED 20 通道规格后会挂到不存在的通道上。
- 「分析」页输入通道列表必须是竖排可滚动列表（`.analysis-list` / `.analysis-outputs` 走 `flex-direction: column` + `overflow: auto`），不要退回「一张卡片 + 横向 flex」；通道行右侧只在公式名与 id 不同时显示公式名小片。AI 生成脚本走 `XHGCS_ANALYSIS_UI.openScriptDialog()` 对话框（需求描述 + 输出标签 + 类型 + 输入通道勾选），不要再让生成流程依赖先在画布上拖一版节点。
- 内存历史统一用 `state.historyHours` + 派生的 `state.historyPoints`（`X.setHistoryHours/setIntervalMs` 负责重算并只裁不扩）；通道写入必须走 `X.pushSample(ch, value)`，不要再新增 `maxPoints` 用法或裸 `ch.data.push/shift`。
- 落盘只允许主进程 recorder 写文件，渲染层只缓冲、批量 append（约 500ms / 500 行），禁止在前端直接写文件。
- 波形图每帧只允许处理可见区间（`startIdx..endIdx`）：Y 轴范围按可见窗口计算，可见点数超过像素列 2 倍时走按像素列 min/max 抽取；不要恢复全数组扫描或逐点连线。画布 `source` 节点只取 `state.analysis.windowPoints`（默认 2000）内的数据。
- 界面风格由 `html[data-fx]` 决定（`codex` 扁平默认 / `glass` 液态玻璃，`state.fx` 随配置持久化）。新增界面只用 `var(--bg2)/var(--line)/var(--well)/var(--acc)` 这套变量，不要写死渐变、模糊或阴影；扁平覆盖集中在 `styles.css` 末尾的 `html[data-fx="codex"]` 块，浅色差异写在 `html[data-fx="codex"][data-theme="light"]` 里，否则会盖掉浅色主题变量。
- 画布与图表取色一律走 `X.canvasColors()`；新增/调整配色必须同时给出 codex 扁平与 glass 玻璃两套值，不要在绘图代码里写死颜色。
- 设置页表单按语义分组：`.field-group` + `.field-group-title`（自带延伸发丝线），不要再往 `.settings-section` 里堆一长串裸 `.field-grid`。`.settings-detail .field-grid` 已设 `align-items: start`，防止单个 input 被同行更高字段拉成空的大方框；新增设置字段沿用这套。
- 告警阈值输入框显示值必须走 `views-panels.js` 的 `thresholdText(value, span)` 收位数：状态里可能存着历史遗留的 `2.9999999999999996` 这类浮点尾数，直接写进 `value` 会被输入框裁成一长串数字。
- AI 输入框不给手动拖拽：`index.html` 里没有 `#aiInputGrip`，高度只由 `ai-ui.js` 的 `autoGrow()` 按内容自动长（`input` 事件 + 窗口 resize 时重算，上限 `min(48vh, 460px)`、地板 44px，超上限 textarea 自己滚），宽度恒占满整行；CSS 里 `.ai-input-row textarea` 的 `resize: none` 不能删（删了浏览器会自己加回原生斜杆）。`xhgcs.layout.v1` 里遗留的 `aiInputHeight` / `aiInputWidth` 只当历史脏数据忽略，不要再新增读写；面板级拖拽（`[data-resize="switch|channels|ai|serial"]`）是另一套，必须保留。
- 通道配置走 `#chlModal` 弹窗（`views-core.js` 的 `openChannelConfig` / `channelConfigHtml` / `bindChannelConfig` / `removeChannel`）：250px 宽的通道列里不要再内联展开字段（12 个字段会把卡片撑到 700px、把整列挤没），脚本通道只渲染「显示与映射」一组。
- 浮层 Esc 逐层关闭统一走 `XHGCS_APP.topOverlay()`（`OVERLAY_STACK` 按 `settingsModal → viewModal → chlModal → analysisModal` 排）；新增浮层要加进 `OVERLAY_STACK` 并在自己的 keydown 里用 `topOverlay()` 挡一层，避免一次关掉两层。
- 设置字段必须按「它描述的对象」就地放置并按模式显隐：只对某引擎 / 某播报模式生效的字段加 `.sovits-only`、`.alarm-only` 这类类名，在 `renderTtsStatus()` 里 `classList.toggle('hidden', ...)`（隐藏只改 CSS，取值逻辑不动）；字段的判定 / 结论文字挂在它那一组下面，不要再放到面板底部离字段半屏远。
- 空状态只允许说一遍：列表为空时不要再挂一行「共 0 条 · 运行 0 · 完成 0 · 失败 0」这类全零统计（整行收起来），没有可操作对象的按钮（清空记录 / 全部确认）要 `disabled`（`.mini-btn:disabled` 已有样式），别让用户点了没反应。
- 同一件事只说一遍：占位符、字段下的 meta 行、分组下面的结论行不要复述同一句（Voice 默认态原本是「占位符 + meta + 结论」三处同义）；结论行只在给出新信息时才出现（语音还没加载完、自定义名匹配到了哪个语音），否则收起。
- 状态类按钮不要做成假按钮：不能执行时直接 `disabled`（`.sbtn:disabled` 已有样式），把原因写进 `title`（「仿真开启中：先在「模拟」页关闭仿真」），不要让用户按下去只换回一句提示。
- 同一件事只有一个名字：没配后端时统一叫「未配置 API」（「内置模式」已经不存在）；导航或按钮上的数量为 0 时不出数字（`#aiTaskCount`、`#settingsTaskCount` 都靠 `.hidden` 收起）。
- 模拟器横幅的三项统计必须是三个互不相同的数：`采集帧 / 速率 Hz / 采集时长`（`app-core.js` 的 `updateSimStats`）。不要再放「数据点」（= 通道 0 数组长度）、「航迹点」（上限 700 的滚动缓冲）或「内存点位」——前两个在仿真下和采集帧是同一个数，第三个是通道数组长度，也是采集帧。`state.serial.frames === 0` 时整行 `.hidden` 收起，同时 `#btnResetData` 置 `disabled`，不要摆一排 0。
- 画布工具条的执行状态由 `graph-ui.js` 的 `syncToolbar()` 统一管：`运行 / 清空画布` 看画布是否为空，`撤销 / 重做` 看 `undoStack/redoStack`，`删除所选` 看有没有选中节点或连线，不能执行就 `disabled` 并把原因写进 `title`。工具栏按「主操作 / 缩放 / 工具与破坏性动作」分成三组（`.gt-group`、`.gt-zoom`、`.gt-right`），`运行` 是画布模式唯一的主色按钮——原来并排的「运行并附加」在实现里就是同一个 `attach:true`，只多一句 toast，两个同重量的按钮只会让人犹豫该点哪个；`GRAPH_UI.attachGraph()` 保留给快速公式模式页脚那条路径用。`syncToolbar()` 必须挂在 `renderInspector()` 的**第一行**——「没选中」和「选中连线」两个分支都会提前 `return`，挂在末尾等于白写；`markHistory()` 里也要调一次（撤销栈变了不一定有 render）。
- 画布上点空白 = 取消选中：除了清 `selectedNodeId/selectedEdgeId`，还要 `$$('.graph-node').forEach(... remove('selected'))` 并 `renderEdges()`，否则节点仍留着选中描边、连线仍留着中点 ×，而「删除所选」已经变灰。
- `.btn.danger` 一旦 `disabled` 就不再是红色（`styles.css` 基础块 + `html[data-fx="codex"]` 块各有一条 `:disabled`），红色只留给「现在真能点」的破坏性操作。
- 玻璃风格（`data-fx="glass"`）里那些**写死的深色内嵌块**必须在 `html[data-theme="light"]` 里给出浅色对应值，否则浅色主题下会变成「白底弹窗里嵌一条黑板」。codex 风格块各自覆盖过，所以这类问题只在玻璃 + 浅色这一组露出来。已修：`.settings-nav`、`.graph-inspector h3`、`.component-manager`（遮罩）、`.component-manager-foot`。新增深色内嵌块时同时给出浅色值，别只写 base。
- 两套风格（`codex` / `glass`）× 两种主题（`dark` / `light`）是四个正交组合，改配色必须四组都过一遍；只验一套会把「玻璃 + 浅色」这类组合漏掉。
- 统计条（`.stat-grid`）在没有可统计的对象时要整条 `.hidden` 收起，别摆一排 0：模拟页是 `state.serial.frames === 0`，告警页是 `state.alarms.length === 0`（`views-panels.js` 的 `renderAlarmPanel`）。判断条件写在渲染函数里，不要靠 CSS 猜。
- canvas 放进可伸缩容器时，容器必须 `position: relative` + canvas `position: absolute; inset: 0`，并且容器用 `flex: 1 1 0%` 而不是 `auto`：`ensureCanvas` 会把 canvas 的 `height` 属性写成 backing store，浏览器把这个内在高度当成内容高度回灌给容器，会变成「越画越高」的死循环（告警页阈值图踩过）。
- 常驻 0 的计数器不许单独占一张卡：串口页的通信统计已并进「连接配置」卡片底部的一行 `.comm-strip`（`#statFrames/#statRxBytes/#statTxBytes/#statErrors` 的 id 没变，`X.setCounter` 仍会给 0 打 `data-zero` 退成次要色）。不要再拆回 2×2 的大方框，也不要用 `RX/TX 字节` 这种和「接收帧」混着一半中文一半英文的标签。
- 数据引擎预设卡是三行说两句话的典型反例：规格（`engine-preset-meta`）跟在标题行右侧，正文只留一句话，两行的信息不许重叠；文案的唯一来源是 `protocol.js` 里每个 preset 的 `description` / `summary`，改一处必须回头看一眼另一处。
- 往 `#view-serial .section-grid` 里增删卡片时必须同步改列数规则：`.engine-panel` 是 `grid-column: 1 / -1`，只要它撑满整行，auto-fit 就不会折叠空列，第一行卡片数少一个就会在右边留一整格空白。当前第一行是两张卡，所以显式 `repeat(2, minmax(0, 1fr))`（<720px 退回单列）。
- 图表底栏（`.chart-foot`）只放两段：左边是该子视图的操作提示（`#axisInfo`，`views-core.js` 的 `updateHeadText()` 里的 `labels`），右边是该视图自己的规模（`#statusInfo`，带 `.foot-right` 靠右，由各视图渲染函数写）。不要再挂一个全局的「N 点」——它读的是 `state.channels[0].data.length`，五个子视图写的是同一个数，而仿真页已经用「采集帧」说过一遍。
- 卡片标题和里面的大按钮不要同词：`发送指令` 卡片里的按钮叫「发送」。`已保存引擎` 的下拉项只在名字不含协议代号时才补 `· 协议`（`engine-ui.js` 的 `renderList`），否则「JSON 数据引擎 · JSON」等于同一句说两遍。
- 页面导语和设置分组导语不是目录：不要把下面几张卡的标题再列一遍（模拟页「配置仿真数据源、采集参数与故障场景」、设置基本页「采集频率、窗口与 MCP 本地桥」都删过），导语只写那些标题看不出来的信息。
- 空状态不许撑出半屏空白：没有内容的卡片不该占满剩余高度。告警页无记录时统计条整行隐藏，列表卡再收成一行（`.alarm-list-panel:has(.alarm-empty) { flex: 0 0 auto }` + `.alarm-body:has(.alarm-empty) .alarm-mid { flex: 1 1 auto }`），把高度让给上面真正有内容的阈值可视化（画布跟着长高）。新增空状态照此办理：一行结论 + 一句对位说明，不要用虚线框在空白里居中。
- 界面文字只用 10 / 11 / 12 / 13 / 14 / 16 六档：10 极小说明、11 次要信息、12 正文、13 列表与小标题、14 卡片/分组标题、16 弹窗标题。两套显示字号例外：① 数字看板按长度收缩 —— `.stat-card b` 基础 20（codex 扁平 19），`data-len` 4→18、5→15、6→13、7~8→11；仿真页状态条 `.sim-source-stats .stat-card b` 17；`.chl-val` 20（codex 18）；`.gauge-ring .gv` 23。② 图标字形 —— `.tool .ico` 17。这两类以外不要再用 9 / 10.5 / 12.5 / 15 / 17 这类中间值。
- 空的状态不要只留一块纯色空板：串口日志区走 `.serial-body:empty::before` 的提示文案，其它空状态一行浅色文字即可（不要虚线框 + 居中）。
- 列表 / 卡片类元素（`.script-item`、`.analysis-check`、`.chl`）不要塞进 `styles.css` 那组深色玻璃按钮选择器（`.hbtn`/`.mini-btn`/`.btn:not(.primary)`/`.sbtn:not(.run)`/`.icon-btn`/`.collapse-btn`/`.graph-palette button`/`.analysis-tabs button`）：那一组写死 `rgba(19,27,36,.66)`，浅色 + 玻璃下会变成「白底里的黑板」（`.script-item`、`.analysis-check` 都踩过，只有可见元素才会被扫描到，隐藏面板里的同名元素要手动翻一眼）。列表项走它们自己的 `var(--glass-bg)` 卡片组。
- 告警页阈值表一行同时承担通道名、实时值、阈值输入和导航：点 `.threshold-row` 走 `focusAlarmChannel()`，`.threshold-row.active` 由 `syncThresholdFocus()` 唯一维护（不要再加第二套选中状态）。实时值只由 `views-panels.js` 的 `syncAlarmValues()` 就地改写 `.rt` 文本和行的 `warn/high` 类，禁止重建行 DOM（行里是 number 输入框，重建会顶掉输入光标）。不要再加第二排 `.alarm-chip` 把同一批通道名说两遍。`.alarm-mid` 第二列必须 ≥380px，四列（名/实时值/预警高/预警低）下缩到 310px 会把通道名压没。
- 带状态文案的按钮（`标桩：显示`、`网格：开`、`缩放：自适应`、`自动滚动：开`、`告警语音：开`、`隐藏日志面板`）文案只能由状态推导：`index.html` 里的初值必须等于该状态的默认值，切换处统一调一个 `sync*()` 把文案重算一遍（`app-core.js` 的 `syncSerialPanelButton()` 是模板）。写死一个和初始状态反过来的文案，等于按钮说的和做的不是一件事。
- 同一份状态不许有第二个「只写不读」的表单：`saveSettings()` 改的是全局状态，所有镜像控件都要在它收尾时刷一遍 —— 模拟器页的 `#simInterval/#simHistoryHours/#simWindowSec`（`V.renderSimControls()`）、AI 面板顶栏的 `#aiContextFrames/#aiBridgeToggle`（`XHGCS_AI_UI.syncControls()`）、串口页的波特率/网格/标桩（`APP.syncSerialSettings()` + 按钮文案）。漏刷就会出现「状态已经是 30、面板还写着 10」（采样率和上下文各踩过一次）。新增镜像控件时先在 `saveSettings()` 里找它的刷新点。
- AI 输入区是 Codex 式 composer：`.ai-composer` 卡片里放 textarea + `.ai-composer-bar`（`#btnAiPlus` 开技能菜单 / `#aiSkillTag` / `#btnAiModel` 模型胶囊 / `#btnAiSend` 一键两用，生成中原地变停止方块）。快捷指令与技能都收进 `#aiSuggest` 浮层，不要再在输入框上方平铺一排按钮（旧的 `.ai-suggest` 已删干净）。模型胶囊是设置页 `#setAiBackend` / `#setAiModel` 的镜像：改状态后要回写这两个控件并 `dispatchEvent(new Event('change'))`，让设置页的联动（禁用 Endpoint、探测 DSH）照常跑，收尾靠 `saveSettings()` 里的 `XHGCS_AI_UI.syncControls()` 刷回来。
- 浮层菜单里点击后会重渲染菜单，判定「点在面板内」必须用 `e.composedPath()`，不要写 `container.contains(e.target)` —— 那一刻 target 已经脱离 DOM，`contains` 返回 false 会把刚打开的菜单关掉（实测：切一次后端菜单立刻消失，再点模型就点不到了）。
- 「+」里的技能只往输入框插一句「按 xx 技能做」，不要把整篇 SKILL.md 拼进上下文：技能文档有几 KB，每轮都带上会把 token 吃光，细节交给系统提示与 MCP 工具。技能清单写在 `ai-ui.js` 的 `SKILLS`，和 `.codex/skills/` 下的目录一一对应。
- 表单类浮层（设置弹窗、组件库编辑器）与分析画布页的动作行 / 页脚必须钉在容器底部，中间表单区自己滚：`.component-manager-editor` 是 `flex column` + `.component-editor-body { flex: 1 1 auto; min-height: 0; overflow: auto; align-content: start }`，`.analysis-modal` 同理。让容器自己 `overflow: auto` 会把「保存组件 / 运行分析」推到折叠线以下（组件库实测动作行落在可视区外 100px，新建组件时看不到保存按钮）。`align-content: start` 不能省：表单区变成有确定高度的 flex 项后，grid 默认 stretch 会把多出来的高度摊到每个 textarea 上。
- 分析画布页（`#view-analysis > .analysis-modal`）卡片自己不滚：头 / 页签 / 脚本库 / 页脚都是 `flex: 0 0 auto`，只有中间 `#analysisGraphView` / `#analysisQuickView` 自己滚。给卡片写 `overflow: auto` 会把页脚的运行按钮推到折叠线以下（1280×700 实测要滚 217px 才够得着），画布工作区也必须用 `height: 100%; min-height: 0` 而不是固定高度，否则窗口一矮就重新顶出滚动条。`#view-analysis` 是唯一覆盖 `.modal` 方块尺寸的地方（`flex: 1 1 auto; width/height: auto; max-height: none; resize: none`），别把它挪回遮罩里。画布模式下页脚两个运行按钮和整条 `#analysisFoot` 一起收（`graph-ui.js` 的 `setModeUI()`），否则会留一条 24px 空框。
- 脚本库底排 `.analysis-scripts` 是 190px 的横向卡片（书架），但它同时被列在 `.analysis-list, .analysis-outputs, .analysis-scripts, .analysis-func-list` 那条 `display: grid` 分组里；同权重的 `.analysis-scripts { display: flex }` 会被它盖掉，必须写成 0-2-0 的 `.analysis-script-shelf .analysis-scripts`。踩过一次：卡片被拉成 1116px 一张，第二张直接落在 96px 可见区之外，用户只看得见一个脚本。
- 画布右侧「节点配置」栏没选中节点/连线时收成 30px 窄栏（`graph-ui.js` 的 `syncInspectorCollapse()`，配合 `.graph-inspector.collapsed` 与 `.analysis-graph-workspace.insp-collapsed`）；改栅格列宽和隐内容必须同时做，只隐藏内容的话那 308px 空白列还在。窄栏里的 `.insp-rail` 是唯一入口，别删。
- 模拟页「通道信号一览」是只读镜像：表格只读 `state.channels` 的仿真参数、点行只调 `updateSimChannel()` 载入表单，唯一编辑入口仍是上面那张表单（`applySignal()` 写完要顺手 `V.renderSimControls()` 刷表格）。新表别做成第二套输入框，也不要在这里存值。波形代号到中文名只认 `X.WAVE_LABELS`（`data.js`），不要再写第二份映射。
- 页面级栅格必须吃掉视图剩余高度：`#view-serial .section-grid` / `#view-sim .section-grid` 都带 `flex: 1 1 auto`，卡片自己长高去对齐底部日志栏（串口页曾经在栅格和日志栏之间挂 187px 纯空白）。`align-items: start` 只用来避免行内短卡片被拉出卡内空白，页面级的尾部空白要靠栅格生长解决，不要再靠加高卡片或留白填。
- 弹窗的硬地板不许把短面板撑成空框：`.settings-layout` 的 `min-height` 是短面板的下限，设 440px 时「AI 子任务」空态会变成一行字 + 348px 空白。短面板的高度应当由左侧导航列自然决定；新增设置面板先量一下「最后一段内容底边 − 容器底边」，超过约 120px 就说明地板定高了。
- 视图设计弹窗（`#viewModal`）和别的表单浮层同规矩：`.view-modal` 自己 `flex column + overflow: hidden`，头/尾 `flex: 0 0 auto`，`#viewCode` 用 `flex: 1 1 auto` + `grid-template-rows: auto minmax(0, 1fr)` 吃掉剩余高度。卡片一 `overflow: auto`，「预览运行 / 取消 / 保存并启用」在 1280×700 就被裁 56px（实测）。
- 内置组件（`state.components` 里 `builtin: true`）是只读模板，三条线必须一致：`X.updateComponent` 对内置直接返回 null、MCP `update_component` 抛错、组件库编辑器字段全 `readonly` 且动作行只有「取消 / 复制为新组件」。放行任何一条，用户编辑一次就把随软件发布的默认值永久改掉，而且没有恢复入口（删除按钮原来还是灰的，界面上没有一句解释）。
- 自定义视图行右侧的编辑/删除是一个 `.sw-actions` 动作组（`.sw-edit` 20px + `.sw-del` 20px，行内 `padding-right: 54px`）：编辑不能只留双击（行里看不出来，视图坏了只能删掉重建）。新增行内动作照此办理，别再加第二个绝对定位按钮去顶掉第一个。
- 往 `styles.css` 插注释时先确认只出现一个 `*/`：注释被提前闭合后，紧跟其后的那几条规则会被 Chrome 整条丢掉，控制台不报错、`sheet.cssRules` 里也查不到（本轮 `.component-editor-body[data-readonly="1"]` 就这样静默失效，靠「选择器 matches 为 true 但计算值没变」才发现）。加了 `!important` 或改权重都救不回来，只有注释本身能救。
- 被页面级栅格拉高的卡片，收尾必须钉在下沿，而且一张卡只钉一个页脚块：`#view-serial .section-grid > .panel` 是 `flex column`，统计条 / 脚注 / AI 行带 `margin-top: auto`，脚注那条用 `:not(:has(.comm-strip))` 排除掉已经有统计条当页脚的卡。钉两处（统计条 + 脚注都 `auto`）会把多余高度劈成两个洞，1100px 高的窗口实测两条 154px；不钉则整块秃在卡片底部（连接配置实测 55px）。数据引擎卡的页脚是 `.engine-ai-row`。
- AI 对话面板的空状态不能只写一行结论：下面补一行数据链计数（`ai-ui.js` 的 `chainFacts()`：通道 / 脚本通道 / 数据引擎 / 组件，计数为 0 的项整条略掉，和子任务角标一个口径），由 `updateStatus()` 的 2.5s 定时器顺带刷新。消息区有 400px+ 高，只放一句话就是一片空白；而这四个数在右栏通道列、工具栏里都看不到，不算说两遍。
- 数量角标只为 0 时整枚收起来，颜色不许借用预警色：「脚本数据」页签的数字由 `views-core.js` 的 `syncScriptCount()` 统一维护（0 加 `.hidden`），颜色是 `--text-dim`、页签选中时继承按钮色。原来写 `color: var(--warn)`，几个脚本通道在界面上看着像几条告警。
- 「脚本数据」页签为空时整列 570px 只有背景色：`renderChannelCards()` 在没有通道时插一行 `.chl-empty`（结论 + 一句对位说明，照日志区 `:empty` 提示的口径）。新增页签 / 列表时先问一句「它空的时候长什么样」。
- 配置的导入 / 导出 / 恢复默认是整份配置的动作，只放设置弹窗页脚左侧（`#settingsModal .modal-foot .foot-config`，`margin-right: auto` 和右侧的 取消 / 保存设置分开）。挂在「采集与串口」面板里时，切到外观主题 / AI / TTS 面板就找不到它们了。顶栏原来那个「导出」调的是同一个 `APP.exportConfig`，已收掉（快捷键 Ctrl + S 仍在）。
- 统计数字的 tooltip 只在真的压缩显示时才给：`compactCount()` 把 <10000 原样输出、≥10000 压成 `12.3K`，`setCounter()` 用「去掉分隔符后数字是否相同」判断，相同就 `removeAttribute('title')`。否则 `29` 上挂 `title="29"`、`4324` 上挂 `"4,324"`，都是同一句话说两遍。
- 画布「节点配置」的类型名只许出现一次：标题固定写「节点配置」，类型名交给摘要卡（`graph-ui.js` 的 `nodeSummaryCard()`）。节点默认名恰好等于类型名（输入通道 / 分析输出）时摘要行不再前缀类型，否则读成「输入通道 · 输入通道 · 0 入 / 1 出」。改名时用 `refreshInspectorSummary()` 就地换掉那张卡，不要整块 `renderInspector()`——它会重建名称输入框，光标会被顶掉。
- 时间戳行里不许出现假时长：`app-actions.js` 的 `taskTime()` 在 `finishedAt` 为 0 时只输出时刻，不再拿 `createdAt` 兜底算差值（那会永远得到 0.0s，而左边的状态徽标已经写着「运行中 / 等待」）。
- 画布左侧组件栏按「一屏」预算高度：默认 11 项（6 个基础节点 + 5 个内置组件）在 866px 高的画布弹窗里必须整屏放得下，`.graph-palette` 的 padding / gap、`h4` 的上下 margin、按钮的 padding 都是为这个让位的（原来多出 79px，最后两行组件被切成半截按钮）。分组标题的间距交给 flex `gap`，别再给 `h4` 加回 margin；窗口更矮时允许滚动，但要能一眼看出是可滚动的。
- 被栅格拉到等高的卡片，富余高度要摊到卡内各段之间（`#view-serial .section-grid > .panel` / `#view-sim .panel:not(.sim-source-panel)` 用 `justify-content: space-between`），不要再用 `margin-top: auto` 单钉页脚：那样所有余量会堆成一个洞（实测连接配置「按钮 → 统计条」66px、数据引擎「已保存引擎 → AI 行」60px、模拟页「固定窗口 → 应用参数」100px，按钮看着像被顶飞）。想钉尾块时也别回头加 `margin-top: auto` —— auto 外边距会先吃掉余量，`space-between` 直接失效。
- 告警列表卡按内容长、富余高度让给上面的阈值图：`.alarm-list-panel` 是 `flex: 0 1 auto` + `min-height: 120px`（那个地板只管「一条告警也别太扁」，调高只会在告警少时多一块空白）。配套的 `.alarm-body .alarm-mid` 必须是 `flex: 1 0 auto`，写成 `1 1 auto` 会允许阈值行被压扁，而里面的 `.alarm-canvas` 有 208px 下限缩不动 —— 20 条告警实测行高压到 131px、画布还是 289px，直接压在列表卡上。
- 左导航的告警角标挂在统计 tick（`app-core.js` 的 `if (ts - lastStatsAt > 300)` 块）里刷新：新告警是 `data.js` 的 `updateAlarms()` 直接改 `state.alarms`，以前角标只在启动 / ack / 清空时更新，在别的页面收到告警时左导航一直是灰的。`updateAlarmBadge()` 内部对文本做了「值没变不写 DOM」，所以每 300ms 调一次没有代价。

- 同一个名字在同一张卡片里说第三遍就收掉：数据引擎面板的「当前 · X」状态行（`engine-ui.js` 的 `updateStatus()`）在内置预设时整枚 `hidden`，因为下面高亮的预设卡和「已保存引擎」下拉已经各写了一遍引擎名（实测同一屏「JSON 数据引擎」出现 3 次 → 2 次）。只有 AI / 自定义引擎才显示规格行。新增任何「当前 XXX」行前先数一遍它在同屏出现几次。
- grid 容器（`.field.stacked`）里的按钮不许被 `stretch` 拉成满宽：`styles.css` 用 `.field.stacked > .btn { justify-self: start; }` 收成常规尺寸。全应用只有「发送指令」那枚是 767px 一条蓝杠，而紧邻的「连接配置」是常规尺寸，同一行两种按钮宽度看着像两套设计。
- 新增控件（`select` / `input`）必须带可见文字标签：选项文字（「自动」）是值不是标签，看不出这个控件管什么。`index.html:144` 的 `#newChlColor` 已从「自动」改成「自动配色」+ `title` + `aria-label`。改完用「整页控件有没有可见标签」的方法复核一遍（遍历 `select` / `input`，检查自身文本、`title`、`aria-label` 与前一个兄弟节点），别只看它长得对不对。
- 在 `loadState()` 里调用的辅助函数不许自己再去读模块级 `state`：`const state = loadState()` 执行的那一刻外层 `state` 还在 TDZ，函数里读它会抛 `ReferenceError`，被 `loadState` 的 `try/catch` 静默吞掉（只 `console.warn`），结果是**那一行之后的所有恢复逻辑全部被跳过**（TTS / MCP / 采样间隔 / 历史时长 / 串口 / 航点），而更早的赋值看起来又是好的——极难排查。要处理哪份数据就显式传参（`interruptStaleAiTasks(state.ai.tasks)`）。同理：`loadState` 的 catch 只写 `console.warn`，改完必须把 console 的 `warning` 一起看，只盯 `error` 会漏掉这种整段跳过。
- 从存储里恢复出来的「运行中」任务不可能还在跑（请求活不过一次重载）：`data.js` 的 `interruptStaleAiTasks()` 在启动与导入配置时把 `running` / `pending` 统一标成 `interrupted`（徽标「已中断」，中性灰 `#94a3b8`，不借用预警色），`finishedAt` 保持 0 —— 编一个「重载到下次启动」的时长就是假数据。徽标和正文不许同词：正文写「重载前的请求未完成」。子任务统计行里计数为 0 的档位整段略掉（`共 3 条 · 运行 1 · 完成 2` 而不是 `… · 失败 0`），和「脚本数据」页签角标一个口径。
- 凡是**持久化**的显示状态，它在界面上对应的那层皮必须在启动时由状态反向同步一次，别指望 HTML 里的默认值：`state.channelTab` 会存会读，但 `.active` 默认写在 `#btnRawTab` 上，重启后就成了「高亮在原始数据、内容却是脚本数据」（连 `.chl-addrow` 那行也会跑到脚本数据页上）；`showGrid` / `showStake` 同理，状态恢复成关、按钮却还写着「网格：开」。三处错位一起查：**选中态、随选中态显隐的行、按钮文字**。做法都是一个开来源函数（`views-core.js` 的 `syncChannelTabUI()`、`app-core.js` 的 `syncPlotToggleButtons()`），启动和点击都调它，别再各写一遍 `textContent`。
- 同一个开关出现在两处（工具栏 + 设置面板）时，两处都要 `X.persist()`：`showStake` / `showGrid` / `cruise` 都在 `persist()` 的字段表里、启动也会读回，但只有设置面板那条路径落盘，工具栏点了不存，重启就白点。地图页更明显：「点画布加航点」会落盘、「添加航点」按钮不会，同一份航点一半留一半丢。
- 子视图的「规模」只在底栏右槽（`#statusInfo`）说一次：另外四个子视图都写在那里，地图原来在画布左下角挂了个 `.map-legend` 浮层说「航迹 N 点 · 模式 · 航点 M」，而 `#statusInfo` 被显式清空 —— 同一个数换个地方说，切视图时底栏右半边还会突然空掉。已把浮层删掉（含元素、`ref`、6 处 CSS 引用），规模写进 `#statusInfo`。
- 同一份候选值出现在两个下拉里时只留一个数据来源：波特率原来在串口页和设置面板各写 5 项 `<option>`，既会各自漂移，又漏了 57600 / 230400 / 460800 —— 用这些速率的设备在界面上根本选不出来。现在 `<select id="baudSelect">` 和 `<select id="setBaud">` 在 HTML 里都是空的，由 `app-core.js` 的 `BAUD_RATES` + `fillBaudOptions()` 在启动时填（`syncBaudSelects()`）。配套一条：**恢复出来的值不在候选里必须把值补进选项**，否则 `select.value = '250000'` 会落空，界面上是一个空白下拉框、底层却还在用那个波特率连设备（`fillBaudOptions` 会按数值顺序插进去）。同类下拉（数据位 / 校验位 / 采样率）照此办理。
- 点击型开关补 `X.persist()` 时别只补显眼的那个：`serial.autoScroll` 也是「persist 字段表里有它、启动也读回」的字段，但「自动滚动」按钮点了不存，关掉重启又开着。查到一处就顺手把同一批（`showStake` / `showGrid` / `cruise` / `autoScroll` / `waypoints`）全过一遍。
- 跑「对比度 / 裁切」审计时，选择器必须排除 `offsetParent === null` 的元素，并且只扫当前激活的那一个面板：`#settingsModal .field-group-title` 这种写法会把 `display:none` 的其它面板一起算进来，量出来的前景和背景根本不同屏（第 119 轮浅色玻璃下报出 2.45:1，真实像素是 3.4:1）。同理，`.settings-detail` 这类自带 `overflow: auto` 的容器报「裁掉 73px」也不是丢失内容，是能滚到 —— 判定前先看可滚动祖先。
- 玻璃风格的对比度结论只能信真实像素：`backdrop-filter` 的合成底色 DOM 算不出来，同一个面板在 760×717 解成 `rgb(178,181,187)`、在整窗截图里又是 `rgb(245,247,248)`。做法是按 `getBoundingClientRect()` 的实测框去截图里采样（记得乘 `devicePixelRatio`，本机 1.5），别把「全图里接近前景色的像素都当成文字」——第 119 轮这样捞到 30705 个噪声像素、中位背景解成 `(169,174,185)`，整份结论作废。
- 浅色玻璃的次要文字 `--text-dim` 是 `#555f6b`（`styles.css` 的 `html[data-theme="light"]` 块，只作用于 glass；`html[data-fx="codex"][data-theme="light"]` 的 `#626b78` 配纯白底够用，没动）。玻璃面板底色随窗口尺寸在 `#d2d4d7`~`#f5f7f8` 之间浮动，旧的 `#64707e` 在最深那种底上只有 3.4:1；要再调浅请先按上一条拿真实像素量一遍。
- 工具条（`.ctrl-head` 这类 `flex-wrap: wrap` 的行）在常用窗口宽度下必须还是**一行**：装不下时 flexbox 会把最后一枚按钮单独甩到第二行、左对齐，看着像块没做完的补丁，还永久吃掉一行高度（1694 宽的窗口下 `.ctrl-head` 从 38px 涨到 71px，波形图少 33px）。多出按钮时先问「这件事别处是不是已经有一个入口」，而不是想办法塞进工具条。
- 「清空数据」只保留模拟页「运行数据源」卡里的 `#btnResetData` 一处（和采集帧 / 速率 / 时长三个数同屏，数据生命周期在那里说最合适）。图表工具条那枚 `#btnClearData` 调的是同一个 `X.resetData()`，已删；工具条右侧只留 PNG / CSV，收在 `.ctrl-actions`（`margin-left: auto`）里，换行时整组一起走、贴右边，不会再出现孤儿按钮。图表的 PNG/CSV 是导出、模拟页的按钮是清数据，两者不再混在一条工具条上。
- 桌面版没有系统标题栏：`electron/main.js` 用 `titleBarStyle: 'hidden'` + `titleBarOverlay`（高 46，和顶栏一样高），应用自己的顶栏就是标题栏。三条配套约束别拆开：① `styles.css` 的 `body.is-desktop .topbar` 是拖动区（`-webkit-app-region: drag`，双击最大化），里面的按钮、菜单、右上角那一组必须 `no-drag`，否则在拖动区里点不动；② 顶栏右侧要用 `padding-right: calc(100vw - env(titlebar-area-width, calc(100vw - 138px)) + 14px)` 空出系统那三个按钮 —— 全屏时 `env()` 等于整窗宽、这里自动归零，没有 `env()` 时退回 138px；③ 按钮条底色由 `data.js` 的 `titleBarColors()` 算好后经 `desktop:set-titlebar` 回填，换主题 / 换风格都要重算（挂在 `applyTheme()` 里）。
- 算标题栏按钮条底色时，必须把顶栏的每一层背景都叠一遍：顶栏在玻璃风格下是半透明的、还压了两条渐变，只取「第一个不透明色标」会得到一条跟顶栏对不上的杠（深色顶栏实测差 25 级，肉眼就是一条深色补丁）。做法是「页面底色 `--bg` → background-color → 各条渐变（CSS 里排在前的在上）」，每层用自己的平均颜色和平均透明度依次叠；解析色标时 `transparent` 也要算进去（滤掉它会让平均透明度虚高，深色又偏亮 10 级）。实测浅色差 2 级、深色差 3 级之后就不用再动了。


# 2026-10 交付硬化战役笔记（0.19 → 0.29）

> 2026-10-28 从这一轮长战役里抽出的结论：症状 → 原因 → 现在的规矩。当前事实以代码、`AGENTS.md` 与对应 spec 为准，这里只记「为什么」和「别再踩」；按关键词搜（`core.bundle`、`board-store`、`handleTrusted`、`XHGCS_ALLOWED_ORIGINS`、`verify-dist`）就能命中。

## 一、内核构建：产物就是线上形态

- `src/**/*.ts` 用 TypeScript 写，但产物**只能是单个 iife 普通脚本** `assets/js/core.bundle.js`：双击 `index.html` 走 `file://`，ESM 与运行时 import 都加载不了。
- 改 `src/` 后必须 `npm run check:core && npm run build:core`，并把 bundle 一起提交。只改 src 不重建时浏览器里跑的还是旧内核——**单元测试、冒烟可以全绿而功能没上**，排查顺序永远是「先 grep bundle 里有没有这段」。
- 清单 `xhgcs.extension.json` 先注册贡献，代码等激活事件（`onView/onPanel/onCommand/onProtocol/onOperator/onStartup`）命中才加载；卸载 = `registry.unregisterAll(owner)` + dispose 订阅；任何扩展抛异常都不许影响启动与其他扩展。
- 权限是**投影**不是判断：没声明的能力在 `ctx.api` 上根本不存在。回归断言「API 缺失」，不要断言「调用抛错」——后者换个实现就失效。
- 授权 = 声明 ∩ 用户勾选；指纹 = version + permissions + entry。改权限或入口必须重新授权（未授权停 `pending` 且不加载代码），状态只写 `xhgcs.ext.state.v1`；授权链回归必须覆盖「升级后重授」。
- 卸载要保存真实模块引用：`ExtensionRecord.module` 存 host 里的真模块（不是包装对象），`deactivate()` 才调得到；`reload()` 要删掉旧 `<script data-xhgcs-ext>` 与 `window.XHGCS_EXTENSIONS[id]` 才算真重载，否则同一个 id 第二次加载是空操作。

## 二、设计器与看板 v2

- 栅格定位只允许一份实现（`renderer.gridAreaOf()`）：曾经节点全堆到左上角，根因是 `grid-area` 在渲染、拖拽、插入三处各算一遍，改一处漏两处。
- 撤销走命令模式（可逆命令 + `markHistory()`），不要快照栈；`syncToolbar()` 必须挂在 `renderInspector()` 第一行——「没选中 / 选中连线」两个分支会提前 `return`，挂末尾等于白写。
- 输入框不许 autofocus：输入框抢走焦点后 `Esc` 落在 input 上而不是浮层栈，现象是「按两次 Esc 才关得掉」；`textEditing` 只对文本输入生效。设计器里的 Esc 统一交给 `overlay-stack.ts`，组件自己不许再关（叠层时一次退两层）。
- 看板库**只有一个写入口** `src/designer/board-store.ts`，别处禁写 localStorage；v1（`xhgcs.ui.doc.v1`）只读迁移并留 `xhgcs.ui.doc.v1.bak`；`xhgcs.ui.boards.v2` 解析失败时**先备份 `xhgcs.ui.boards.v2.bak` 再重建**——「重建」必须留证据，否则用户搭的看板会被静默清零。
- 补丁（`board_patch` add/remove/update/move/rename）先校验后原子应用，应用成功后派发 `xhgcs:board-changed`；写盘失败返回 `ok:false`，不能「应用成功但没存上」。撤销补丁靠 `xhgcs.ui.patch.backup.v1` 这一份备份，不另存快照。
- 关闭语义：关闭 = 保存。`close()` 默认 save，`pagehide` 再兜一次；**只有外部补丁触发的重开用 `close({save:false})`**，否则旧内容会把刚应用的补丁写回去。这条改变了「关闭 = 丢弃」的直觉，文案必须跟着说清楚。
- 看板控件只向 `series()` 要数据，key 必须带 `<nodeId>:` 前缀（`${nodeId}:b1`），不许直接读通道数组；未知控件保留节点显示占位，绝不丢用户搭的东西。

## 三、本地桥边界（0.28）

- CORS 是**精确 origin 白名单**：默认 `http://127.0.0.1:8123`、`http://localhost:8123`、`http://[::1]:8123`；`XHGCS_ALLOWED_ORIGINS` 覆盖（逗号分隔）；`*loopback*` 是**测试专用**洞，生产永不设置。健康端点只对白名单来源或无 Origin 的调用下发 token；`GET /api/state` 必须带 token。
- 精确白名单的副作用：任何「随机端口起页面」的测试（`tools/regress.js`、`tools/core-smoke.js`）都会被 CORS 挡红。两条合法路：① 测试进程注入 `XHGCS_ALLOWED_ORIGINS`（回归已这么干）；② 把「桥没起 / 被拒」当预期噪声过滤，但**必须同时限定 URL 与错误类型**。踩过：core-smoke 只认 `ERR_CONNECTION_REFUSED`，而开发机上残留的 8787 桥返回的是 `blocked by CORS policy`，93/93 直接变红；放宽成「URL = `/api/health` 且（refused | CORS | ERR_FAILED）」才稳。
- MCP 写路径三条硬规矩：ack 必须保存 `data`（否则调用方永远拿不到结果）；看板调用把 `id` 映射成 `boardId`、与队列 qid 分开；业务失败与 dry_run 预检失败都要原样返回 `ok:false`，dry_run 不许切换活动板。`npm run test:bridge`（`tools/bridge-contract-smoke.cjs`）就是钉这三条的，改桥必跑。
- 桥的 token 只从健康端点下发，且跨源页面读不到响应（ACAO 只对本机来源回）；token 不是认证体系的替代品，它只防「本机其它网页顺手调用」。

## 四、Electron 纵深（0.29）

- 所有 IPC 统一 `handleTrusted(channel, handler)`：校验 `event.senderFrame` 的 origin 是应用自身地址，远程/子框架一律拒绝；`will-navigate` / `will-redirect` 只放行自身 origin——插件或 AI 产物里写 `location.href` 带不走窗口。
- **批量替换的陷阱**：用正则把 `ipcMain.handle(` 改成 `handleTrusted(` 时，包装器内部那一行也被换掉 → 自递归 → 主进程在 `createWindow` 之前抛 `Maximum call stack size exceeded`，打包版双击无窗口、stderr 只有一行堆栈。替换脚本要么排除包装器函数体，要么人工过一遍；**打包后必须跑装机冒烟**——源码测试全绿时它依然是红的。
- CSP 先上 `Report-Only`：老界面还有内联脚本/样式，直接强制会打穿首屏；先观察报告，稳定后再收紧成强制。packaged 模式屏蔽 F12 / Ctrl+Shift+I 并关闭 DevTools（`app.isPackaged` 判断），开发期不挡。
- 静态服务对 `/ext` 目标路径**先 realpath 再校验**：junction/symlink 指向根目录外要 403。`allowReuse` 只在开发期开（`!app.isPackaged`），否则两个版本会互相复用旧服务，装出来的还是旧代码。
- `ELECTRON_RUN_AS_NODE=1` 会把打包 exe 变成 node：报 `bad option: --remote-debugging-port`、退出码 9。启动装机冒烟前清掉它（`Start-Process -Environment @{ ELECTRON_RUN_AS_NODE = $null }`），这不是产品缺陷。

## 五、持久化可见性（0.29）

- `persist()` 必须**同步可见**（调用后立刻 `getItem` 读得到）；优化只允许「内容与上次一致且没被外部改过」时跳过写盘，不能延后。
- 写盘失败必须**看得见**：`writeJSON` / `persist` / `saveDoc` 返回 boolean，失败派发 `xhgcs:persist-failed`（`detail = {key, error}`），设计器 toast。`try/catch` 里吞掉等于让用户以为存上了——这是最贵的一类 bug。
- 主快照超限（localStorage 5MB 级）：先压缩 AI 历史、子任务、阈值归档再重试；仍失败必须 warning + toast，不许静默丢数据。
- `desktop-config.json` 改 tmp + rename 原子写：断电只会在「旧文件或新文件」之间，不会留半截 JSON 让下次启动读崩。
- 别往主快照加插件字段：persist 是全量序列化，插件状态走 `xhgcs.ext.<id>.*` 私有键。

## 六、打包与门禁

- electron-builder **默认排除 `.d.ts`**：`types/` 只能走 `extraResources`，否则装机版缺插件作者类型包。
- `verify:dist` 走 asar 内**必备条目 + require/启动闭包**两段校验：只查「文件存在」会漏掉「引用了没打进去的模块」，装机版白屏时查不出原因。
- `npm run release` 不含 `npm run dist`（100MB 安装包不该进每次门禁）：对外发布 = `release` → `dist` → `verify:dist` → 装机冒烟，四步都过才算有产物。
- 冒烟判据是**装机产物** + `ERRORS []`：`dist/win-unpacked/XiHe GCS PRO.exe --remote-debugging-port=9222`，再 `node tools/desktop-smoke.js 9222`。它只证明「能启动、能渲染、桥能连、IPC 可用、控制台零报错」，**不覆盖**真串口、断线重连、插件安装授权全链路与长跑。
- audit 的 `CORE_VERSION == package.json.version` 是硬门禁：改版本必须同时改 `src/core/version.ts` 与 `package.json`，否则门禁先红。

## 七、UI 层级模型（0.22 → 0.27 的结论，细节见 `ui-elevation-spec.md`）

- 面板与卡片不许再用 1px `--line` 描边分块：层级只靠 `--surf-0..3` + `--edge-hair/soft/strong` + `--elev-1..3` + `--seam-x/y`；玻璃 = backdrop + 半透明，codex = 实色扁平，两套风格 × 明暗**四组合必须全验**（只验一套必漏「玻璃 + 浅色」）。
- 浅色玻璃的正文/次要文字对比度只能按真实像素量：`backdrop-filter` 的合成底色 DOM 算不出来，`getBoundingClientRect()` 框到截图里采样（记得乘 `devicePixelRatio`）。`--text-dim` 已定 `#555f6b`，再调浅前先重测。
- `.chl-tabs/.chl/.chl-val` 用 `!important` 隔离是**显式技术债**：新增主题覆盖优先降特异性，不要继续堆 `!important`，否则下一轮改主题会连坐。
- 「设置分区」走 `src/ui/settings-section.ts` 注入老设置弹窗，不改 `app-actions.js`；新增设置项先找注入点，不要另开弹窗。
- 字号只有 6 档（10/11/12/13/14/16），数字看板按长度收缩；新增中间值（9/10.5/12.5/15/17）一律不允许，字体层级一乱，整套 elevation 的观感就白做了。

## 八、回归与测试的真实边界

- 「测试数量」会漂：`AGENTS.md` 不写死条数，只写「以输出为准」；`tools/audit.cjs` 的过期结论表就是为这个存在的——文档里的旧结论比没有结论更危险。
- 只跑相关用例：`node tools/regress.js --filter=<关键字>`；全量 `npm test` 先 audit 再 Chromium 回归。
- 等待 UI 状态优先用 `page.waitForFunction` 等 DOM 真实状态，不要固定 sleep 猜渲染时间；断言按钮可点时先确认它没被 `.hidden` 或 `disabled` 掉（`.click()` 在不可见元素上会静默失败）。
- 设计器的 Esc 语义是「先清选中、再关面板」：冒烟用例必须按两次 Escape，只按一次会停在「选中已清、弹层还在」的中间态。
- **fixture 必须验证 `git ls-files` 能看到**：`.gitignore` 里全局的 `*.log` 会把真实抓包悄悄挡在仓库外——本机能过、别的机器 fixture 缺失必红，而 `git add` 还不报错。已给 `!tests/fixtures/*.log` 开例外并 `git add -f` 入库；新增任何 fixture 后跑 `git ls-files tests/fixtures` 确认，回归里遇到 fixture 缺失要显式报错，不许静默跳过。
- **瞬时红不等于回归：复跑一次再判红**。多代理并行改 UI/测试文件时，全量里 1 条红可能只是别人正在写的过渡态。判定流程：① `node tools/regress.js --filter=<用例名>` 单独连跑 3 次；② 全量复跑一次。3 次+全量都绿 → 判**脆断言**，必须加稳定性处理（暂停后台 tick、等 DOM 真实状态而不是固定 sleep），**不许 skip、不许删断言**；只要有一次红就按回归处理。今晚踩过三次：试运行 lastError 被 500ms tick 重写、带横杠 id 用例依赖环境里恰好有 WED 通道、UI 抽屉迁移过渡态。
- `tools/regress.js` 单写者交接一次踩过的坑：两个代理同时改同一个测试文件会互相覆盖，且「跑测试」不代表没在写；改成「谁持有谁改、写完明示释放并贴 mtime/`git diff --stat`、跑测试不算持有」。

## 九、AI 生成自证与 DSH 后端（0.29 夜间批次）

- 「产物建好了」不等于「产物算得出数」。生成入口（脚本 / 画布，含聊天动作路径）现在必须先落库 → `ensureOutputs` → 真跑一遍（`commitScriptArtifact`）才宣布成功，消息带真实输出值；失败回滚用**落库前快照还原**而不是 `filter(script.id)`——`saveScript` 哪天变成「有 id 则更新」，按 id 删就会误删用户既有脚本。环境缺失（桥没起 / 没装 Python）与脚本算错分开：前者保留产物 + `verified:false` + 可照做的提示，后者回滚 + `试运行失败：原因`。试运行前后必须快照/恢复 `state.analysis.lastError`，那是分析面板正在显示的共享错误。
- 公式里的通道引用要用**公式名**：模型照上下文写真实 id（`wed-fc-01`）会被当成减法，生成前 `normalizeFormulaIds` 做确定性 id→公式名替换；别在试运行闸门里把这种「id 写法正确」误判成算错。
- 错误诊断只有一份：`XHGCS_AI.diagnose(err)`（`kind/title/hint/status/retryable/detail`，14 类）。`chatOnce` / `requestJsonSpec` / `runAiTask` 抛出的错误统一带 `err.info`；`send()` 失败落 `meta.errorInfo` 与 `state.ai.lastErrorDetail`（含 at/endpoint/model/ms），`state.ai.lastError` 字符串保持兼容。`requestJson` 必须把 HTTP 状态和 body 一起带出来，否则上游 400 里的 `context_length_exceeded` 会被压成 upstream/unknown。
- DSH 子进程：headless 把失败真因写在 stderr（`dsh: <code>: <message>`），退出码只有 1 —— **stderr 必须有界消费**（最后 60 行 / 16KB，失败只回传 1200 字符尾部）并抽最后一条错误行当 error，`stderrTail` 只给定位用。取消要 `taskkill /PID /T /F`（POSIX 进程组 kill），并且不等 `close` 就把 `dshState.running` 复位（`finally` 幂等递减），否则「点停止后再问」会被「DSH 正在执行其它任务」挡到超时。
- DSH 进度走既有 SSE 风格（`/api/ai/dsh` 支持 `stream:true`，事件 `reason/final/error/[DONE]`），总转发 ≤32KB，超了发一次 truncated 事件；生成类任务仍用一次性 JSON。`XHGCS_DSH_BIN` 现在是**真入口**（先于默认路径），自动化打桩用 `tests/fixtures/fake-dsh.cjs`。
- **进度解析必须按上游真实格式写状态机**：headless 的 streamReasoning 只在首段写一次「dsh: reasoning:\n」头，之后全是裸文本增量（无前缀、通常无换行、含中文多字节与内部换行），末尾补一个 `\n`。按「整行 ^dsh:\s*reasoning: 前缀」识别会把正文全丢（实测 SSE 只剩一个换行）。解析器抽在 `mcp-server/dsh-stderr.js`（纯 ESM，可单测）：进进度态后任何字节都算进度，直到出现新的结构化行（换行 + `dsh:` 或行首 `dsh:`，后者兼容别的 DSH 版本每行都带前缀的写法）；跨 chunk 用 `StringDecoder` 防 UTF-8 多字节被拆坏，边界检测扣住尾部 4 字符。
- **打桩要用真实抓包，不许手写「我想象的上游格式」**：真实 stderr/stdout 抓包在 `tests/fixtures/dsh-headless-stderr-real.log` / `-stdout-real.log`（出处、命令、版本、脱敏说明见同目录 `dsh-headless-stderr.md`，.log 内不加头注释以免改变原始字节）。回归只读文件回放（单测按 7 字节非换行切片，端到端按 37 字节切片），上游格式变了改 fixture、不改解析器。这条教训来自「fixture 每段都重复前缀 → 回归绿但真实链路丢进度」的打桩盲区。
- **「进度可见」要写成可观测断言，不是形容词**：① 首段 reason 明显早于 final 到达（`finalAt - reasonTimes[0] ≥ 100ms`）；② 多段 reason 时间分布 ≥100ms（证明不是最后一次性倒出来）；③ final 正文不能混入 reasoning 文本。三条都在 `tools/regress.js` 的 DSH 真实抓包用例里。
- 踩坑：HTTP 服务端**不要用 `req.on('close')` 判断客户端断开**（请求体读完就可能触发，会误杀正常任务）；监听 `res.on('close')` 并检查 `res.writableEnded`，只在「响应没写完就关」时取消。打桩脚本按「任务里最后出现的 marker」选模式——agent 模式 task 带历史消息，旧轮次的 marker 会误触发。
- AI 运行态对外只有两个事件：`xhgcs:ai-busy`（`{busy, phase: chat|generate|tool, task}`，开始/结束/停止都发）与 `xhgcs:ai-error`（`{kind,title,hint,raw,model,at}`，复用 diagnose）。界面订阅这两个，不要再解析中文错误文案或读气泡 DOM。

- **MCP 写路径对称**：组件/视图早就有 update+delete，脚本/引擎之前只有 create —— agent 生成完改不了、清不掉，只能让用户手动善后。现在 `update_script/delete_script/update_engine/delete_engine` 补齐，写语义统一：id 或 name 精确定位；update 保留 id/builtin/origin/createdAt 后重走 normalize（缺 formula/inputs/协议就报错，不编造）；内置脚本拒绝改删；活动引擎 delete 拒绝（先 `set_active_engine`）；改名走 `new_name`，`name` 只做定位。
- **更新与轮询合并必须是两条路**：`mergeScript` 的语义是「存在即跳过」（浏览器每 1.5s 把已知脚本推回来一遍），更新必须另走 in-place 合并并保留不可变字段，否则轮询会把更新冲掉。删除要写墓碑 `deletedScripts`（≤200），并在 `canvasScriptId` 指向它时置空，否则下一轮同步会把删掉的脚本「复活」。
- `script_updated` 只重建输出通道、**不自动 run**：改完公式就自动跑一遍会把半成品结果写进脚本通道，还可能抢用户页签；运行时机交给用户/AI 显式触发。

- 应用内只读工具补全：`channel_history`（channel 支持 id 或名字，points≤500，返回真实 series 与 min/max/mean/rms/slope/delta）让模型能引用真实数值而不是猜；`snapshot` 的日志默认不再塞（`include_logs` 显式开），最常调用的工具不该把上下文吃光。
- 工具循环可观测与防挂死：每次 `execute` 统一走 `runWithTimeout`（默认 15s，挂死实现回灌「工具执行超时」而不是卡住整个循环），并返回 `{ms,bytes}`；每轮调用记进 `meta.tools` 与 `XHGCS_AI.toolTrace()`（空态返回 `[]`、绝不抛异常）。
- 工具结果裁剪改成「头 8000 + 标记 + 尾 2000」（原来只留头 12000）：尾部常是统计量/错误/收口字段，只留头会把模型最需要的那段裁掉；标记里必须写清「可用更小的 limit / points 重试」。

- 上下文要有预算，不是固定轮数：`state.ai.contextBudgetChars`（默认 24000，读取/导入 clamp 4000~120000）驱动 `chatMessages`——0.8 阈值触发后先精简 system 里的数据链快照（通道清单/趋势/日志），再按「轮」边界把历史裁到最近约 16%；当前问题永远完整、最近一轮 assistant 保留；system+当前问题仍超预算才抛 `context_length` 类错误。收到这类错误用 0.6x 预算重建 messages 自动重试一次。`XHGCS_AI.contextUsage()` 暴露 {chars,estTokens,turns,trimmed,budget}（空态零值）。
  - 细节与理由：clamp 位置只有两处（`loadState` 读存档、`importConfig` 导入），默认值在 `createState` 的 `state.ai`，持久化白名单与导出各带一份；触发阈值 0.8×预算、保留比例 16% 是经验值（太紧会丢上下文、太松等于没裁）。**必须按轮边界裁**：把一轮的 user 与 assistant 拆开，模型会看到「只有回答没有问题」，工具循环里还会把 tool_calls 与 role:tool 拆散导致上游 400。`context_length` 类错误只用 0.6x 预算自动重试**一次**（不是循环重试），仍失败就如实报给用户，避免无限重试烧额度。
- 桥代理路径（`useProxy=true`）的 4xx body 必须读出来：`mcpJson` 以前只抛「HTTP 400」，上游 body 里的 `context_length_exceeded/insufficient_quota` 全丢，P2 的 diagnose 只能归成 upstream；现在 Error 带 status + detail(≤600)，诊断与自动重试才走得到。
- 生成质量轻量统计：`XHGCS_AI.lastN(n)`（默认 20、上限 100）与 `qualityStats()`（成功率/失败 kind 分布/avgMs）；只存内存环形缓冲，不写 localStorage、不上报。它和 `toolTrace`（单轮工具轨迹）是两回事，别混。
- AI 抽屉（B1b-2）只搬了 DOM：`#aiPanel` 从 Dock 移进 `#aiPanelHost`，`XHGCS_AI_UI.renderMessages/updateStatus` 导出、`meta.errorInfo`、`xhgcs:ai-busy/ai-error` 事件、`toolTrace()/lastN()/qualityStats()/contextUsage()` 契约全部不变。验收用真浏览器探针（假 OpenAI 端点支持 SSE / 401 / 动作块）：抽屉打开后流式增量、失败气泡、动作确认卡片、可观测接口 17 项全过。以后再动 `#aiPanel` 内部结构（不只搬容器）要复跑这条探针，别只看全量回归绿。
