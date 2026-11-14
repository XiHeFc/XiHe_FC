# XiHe_GCS PRO

将原单文件 `XiHe_GCS.html` 完善并重构为可维护的文件夹项目。可直接双击 `index.html` 使用，无需安装依赖；AI 高级功能与 MCP 桥需要本地 Node.js，可选 Python。

## 功能总览

- 多通道实时波形：自定义通道、单位、量程、倍率、波形、颜色与显隐。
- 折线图工作小窗：控件箱里的柱状图、数据表、仪表和地图默认叠加在折线图上，可拖动、缩放，不打断主曲线；双击才进入完整图页。悬停可一次查看同一时刻的全部通道值，全部通道取消后时间轴停止移动。
- 通道调色板：手工添加、串口映射、脚本输出缺省颜色时会自动轮换 16 色，避免新增通道与旧通道撞色。
- 真实串口采集：通过浏览器 Web Serial 连接设备，按 JSON / ASCII / HEX / WED 数据引擎解析帧并写入通道；JSON 支持对象字段与顶层数组（自动映射 `CH1/CH2/...`）。
- 通信协议模块：内置 JSON / ASCII / HEX / WED 四种标准协议预设；WED 支持 `55 AA + 长度 + 40B 负载 + SUM8`（20 路 uint16 大端）、十六进制收发、分包/粘包、坏校验丢弃、协议通道一键应用。
- 仿真可开关：仿真数据、故障注入和信号参数可随时关闭，切换后由真实串口驱动。
- 数据可视化：波形图、柱状图、数据表、仪表盘、二维航迹地图。
- 可视化视图插件：左侧仪表视图栏本身即插件系统，内置视图也可替换；点「＋ 自定义视图」用一句话让内置 AI 生成插件代码（预览→保存→持久化到 `state.views`），或直接粘贴代码；删除只移除插件；自定义视图行右侧的 ✎ / ✕ 分别进入编辑器与删除（双击行同样可以编辑）。
- **插件内核（v0.10 新增，v0.11 补齐视图/引擎/设置）**：一切皆插件。命令、菜单、快捷键、状态栏、配置、协议、算子、视图、管线阶段、设计器控件、AI 工具都是贡献点，内置能力与第三方扩展共用同一份清单（`plugins/<id>/xhgcs.extension.json`）。代码按激活事件懒加载，权限默认最小（没声明的能力在 `ctx.api` 上根本不存在），停用即回收全部贡献，任何插件抛错都不影响启动。
  - `Ctrl+Shift+P` 命令面板 · `Ctrl+Shift+X` 扩展管理 · `Ctrl+Shift+V` 插件视图 · `Ctrl+Shift+D` 可视化设计器 · `Ctrl+Shift+,` 扩展配置。
  - 写插件：`npm run new:plugin -- --id=my.scope --name="我的示波器"` 一条命令生成清单 + 可运行代码并登记索引；类型补全见 `types/xhgcs.d.ts`。
- **常驻数据引擎（v0.11 新增）**：`xhgcs:sample` → 有界队列 → 按 8ms 帧预算分流 → 处理阶段 → 端点；每帧带 `t/wall/filled` 时间戳，队列满了丢最旧帧，单个阶段抛错只计数不中断。插件可注册自己的处理阶段与端点，命令面板（或 `Ctrl+Shift+E`）打开「数据管线监视」看积压/丢弃/错误并可一键启停阶段。
- **交互基线（v0.23 新增）**：Esc 走统一浮层栈（层叠时只关最上层）；右侧 Dock 提升到舞台级，切页不消失；左栏「引擎」更名「协议」，常驻面板改名「数据管线」；图表空态给三条出路；焦点环 2px、命令面板浅色可读（15:1）、强调色全部走主题令牌。
- **插件视图容器（v0.11 新增）**：清单声明 `views`、插件注册实现，容器负责激活、挂载、喂数据、自适应与销毁；视图只拿到 `ctx`（画布、通道快照、主题令牌），碰不到内部状态。
- **设置页集成（v0.11 新增）**：老设置弹窗里多一个「扩展与插件」分区，扩展启停、重载与 schema 生成的配置表单都在里面。
- **可视化设计器（v0.10 新增）**：12 列栅格自由拖拽与缩放，7 个内置控件 + 插件贡献控件；属性面板由控件 schema 自动生成，每次改动都能逐条撤销重做；文档是纯 JSON，可保存/导出/导入，遇到不认识的控件保留占位而不是丢掉用户搭的东西。
- **数据绑定 + 看板运行态（v0.12 新增）**：控件不再直接抓通道，绑定表负责「画谁、取多少点、归一化还是缩放」；同一份文档按 `Ctrl+Shift+B` 进入全屏看板（自动隐藏顶部条、`F` 全屏、`Esc` 退出），编辑态与运行态共用一套渲染器，所见即所得。
- **看板库（v0.16 新增）**：设计器头部可切换 / 新建 / 复制 / 删除看板，一块板一个 id；旧版单文档存档自动迁移并保留备份；导入 JSON 会新增一块板而不是覆盖当前内容；AI 生成看板覆盖当前板。
- **算子参数（v0.20 新增）**：数据引擎的缩放/低通/滑动均值/阈值标记都带参数，在「数据引擎监视」里按 schema 直接调，改完立即生效并记住；参数存 `xhgcs.pipeline.params.v1`。
- **用户插件目录（v0.18 新增）**：装机版可把插件文件夹放进 `%APPDATA%\XiHe GCS PRO\extensions\<id>\`，启动时自动发现；设置页「扩展与插件」里有「打开用户插件目录」。入口被限制在插件目录内，`..` 与符号链接逃逸会被拒绝。插件代码以应用权限运行（不是沙箱），只安装可信插件。
- **AI 生成看板（v0.13 新增）**：对 AI 说“做个姿态看板”，模型只输出窄规格（控件类型 + 通道），内核负责栅格排布与数据绑定，确认卡片点「应用」即落库并全屏运行。
- **数据源与回放（v0.13 新增）**：常驻引擎支持可注册数据源；引擎面板里可开启「内存录制」，再按 4× 倍速回放录制帧（保留原始采样时间戳），用于复现现场问题。
- **新旧视图统一（v0.12 新增）**：`Ctrl+Shift+V` 的视图容器里，插件视图与老的表达式视图（`state.views`）并列出现，AI 以前生成的视图不用重写就能看。
- 视图绘图原语：`ctx.draw.plot()` 建受控画布槽，`ctx.draw.scope/bars/donut` 直接出折线/条形/环形，量程、图例宽度、刻度取整、边界裁切、超密数据抽稀都在原语里；AI 生成的视图只描述「画什么」，不再逐行手算坐标（这正是以前图例被裁、曲线挤成一条、画布撑破宿主的原因）。
- 地图与任务：自动巡航、返航、航点、清空航迹、点击地图新增航点。
- 告警中心：原始通道与脚本通道自动越限告警，支持确认、批量处理。
- 多通道数据 Tab：**原始数据 / 脚本数据** 一键切换，脚本输出独立存储。
- 节点式数据分析画布：输入通道 → 函数计算 / 滤波 / FFT / Python / 可复用组件 → 输出通道；支持宽命中连线选择、中点删除、右键删除、Delete 删除、缩放平移、循环检测、撤销重做与自动运行。
- 可复用组件库：公式 / Python 组件可独立新建、编辑、复制、导入导出，保存到 `state.components`（内置组件是只读模板，点「复制为新组件」后再改）；拖入画布自动生成输入/输出端口，运行优先使用组件库当前定义、快照仅作缺失兜底，保存/MCP 画布时自动嵌入组件快照，AI 与 MCP 都可直接生成。
- 快速公式模式：编辑即试算，数值、统计、迷你曲线与输出映射同屏；可发布为持续更新的实时图表。
- 脚本库/自定义模块：绑定通道后随采样自动运行；支持 AI 生成、载入、运行、删除。
- AI 对话面板：位于工作区右侧固定 Dock 的 AI 页签，可调整宽度；**后端可选**——本地 OpenAI 兼容 Endpoint，或 **DSH Agent**（DeepSeek 官方 CLI）。未配置后端时会明确提示配置，不再用本地关键词伪造产物。
- AI 可查看完整数据链：原始/脚本通道、串口帧、告警、脚本库、引擎与分析状态。
- AI 可生成脚本、节点画布、数据引擎与可视化视图；简单视图可用构图板与一句话直达“生成→自检→保存→启用”，Python 分析通过本地桥执行。
- AI 子任务调试：脚本、画布、引擎、分析和语音播报统一记录在设置页，可查看状态、试听、复制或删除。
- 本地语音 TTS：默认使用 Edge 浏览器本地语音，可切换 GPT-SoVITS 本地 `/v1/audio/speech` 接口；独立后台队列串行播报 AI 回复与未确认告警，支持 `跟随 AI` / `后台告警` / `两种模式`，并保留语音子任务。
- 数据引擎配置：默认显示 JSON / ASCII / HEX / WED / WED 飞控协议卡片，特殊协议用 AI 或“高级配置”生成；MCP Agent 可用 `list_protocols` / `create_engine(preset=...)` 直接创建。
- MCP 桥：浏览器向 `127.0.0.1:8787` 同步快照；Codex Agent 可观察数据、管理组件、创建/读取画布、创建脚本、创建/切换数据引擎、创建可视化视图、运行分析。
- 工作区布局：VOFA+ 式固定活动栏 + 左侧控件箱 + 中央图页 + 右侧 Data/AI Dock；Data/AI 切页不改变图表宽度，控件箱与右栏都可拖拽，日志开关收在绘图工具条，状态保存在 `xhgcs.layout.v3`。

## 文件结构

```text
XiHe_GCS_PRO/
├─ 启动 XiHe GCS PRO.bat   桌面版启动入口（优先已安装/已打包，回退网页版）
├─ index.html
├─ AGENTS.md
├─ README.md
├─ assets/
│  ├─ css/styles.css
│  └─ js/
│     ├─ data.js          数据源、通道、脚本、引擎、串口与配置
│     ├─ protocol.js      JSON/ASCII/HEX/WED 协议预设、编解码、校验与通道定义
│     ├─ serial.js        Web Serial 真实串口、帧缓冲与协议解析
│     ├─ analysis.js      函数嵌套、Python 桥、脚本执行
│     ├─ graph-engine.js  节点图模型、拓扑计算、滤波/FFT/Python/组件节点与组件快照
│     ├─ ai.js            本地 AI / 远端 AI、子任务与语音播报
│     ├─ tts.js           Edge 本地语音 / GPT-SoVITS 播放
│     ├─ tts-worker.js    后台语音播报队列与告警轮询
│     ├─ tts-audio-worker.js  GPT-SoVITS 音频合成 Worker
│     ├─ layout.js        VOFA+ 左右栏、Data/AI Dock 与日志开合布局
│     ├─ analysis-ui.js   分析画布 UI
│     ├─ graph-ui.js      节点画布拖拽、连线、缩放与检查器
│     ├─ engine-ui.js     数据引擎配置 UI
│     ├─ ai-ui.js         AI 对话 UI
│     ├─ desktop.js       桌面版状态面板与 MCP 自动启用
│     ├─ bridge.js        浏览器 ↔ 本地桥同步
│     ├─ views-plugins.js 可视化视图插件注册表、AI 生成视图与设计器
│     ├─ views-workbench.js 折线图上的可拖动小窗、图表悬停与模块预览
│     ├─ view-kit.js       绘图原语（scope/bars/donut：量程、图例宽度、刻度、裁切、抽稀）
│     ├─ view-verify.js    视图自检器（离屏真挂载 9 项检查，供 AI / MCP / CLI 共用）
│     └─ views-*.js / app-*.js
├─ mcp-server/
│  ├─ bridge.mjs          HTTP + MCP stdio 双协议桥
│  ├─ package.json
│  └─ README.md
├─ tools/
│  ├─ start-all.bat       一键启动（优先桌面版，回退网页版）
│  ├─ start.ps1           网页版启动（静态页 + MCP + 本地 TTS）
│  ├─ start-sovits.ps1    本地 GPT-SoVITS 服务
│  ├─ view-check.js       视图插件验收器（node tools/view-check.js --builtin=bar）
│  └─ desktop-smoke.js    桌面版冒烟测试（CDP + Playwright）
├─ electron/               桌面版主进程与本地服务托管
│  ├─ main.js              窗口、权限、串口选择、IPC、菜单与生命周期
│  ├─ preload.js           window.XHGCS_DESKTOP 桥（contextIsolation）
│  ├─ static-server.js     内置静态服务（与 tools/serve.py 相同缓存策略）
│  ├─ services.js          MCP 桥 / 本地 TTS 子进程托管与健康检查
│  └─ store.js             窗口状态与桌面偏好 JSON 存储
├─ build/                  图标与打包资源
└─ .codex/
   ├─ config.toml         MCP 服务器本地配置
   ├─ docs/engineering-history.md  历史 UI / 排障复盘（按需检索）
   ├─ skills/xhgcs/SKILL.md        数据链 / 脚本 / MCP / AI 任务路由
   └─ skills/xhgcs-view/SKILL.md   可视化视图的接口 + 画风 + 自检规范
```

## 桌面版（Electron）

- 开发运行：`npm install` → `npm start`；`npm run dev` 会额外打开开发者工具。
- 打包：`npm run dist` → `dist\XiHe GCS PRO-<版本>-x64.exe`（NSIS 安装包，可自选目录、建桌面快捷方式）与 `dist\XiHe GCS PRO-<版本>-portable.exe`（免安装单文件）。
- 启动后主进程自动：拉起 `127.0.0.1:8123` 内置静态服务（端口被占自动顺延，若已是本应用则直接复用）、托管 `8787` MCP 桥、按需启动本地 GPT-SoVITS；窗口大小/位置、记住的串口与桌面偏好保存在 `%APPDATA%\XiHe GCS PRO\desktop-config.json`。
- “设置 → 桌面版”可查看界面/MCP/TTS 状态、重启本地服务、打开日志与数据目录、开关 TTS 自动启动、清除记住的串口。
- 串口选择由主进程接管（Chromium 无内置选择框）：只有一个设备时自动使用，多个设备弹窗选择并记住。
- 日志：`%APPDATA%\XiHe GCS PRO\logs\desktop.log`、`bridge.*.log`、`sovits.*.log`。
- 验证：以 `--remote-debugging-port=9222` 启动后运行 `node tools\desktop-smoke.js 9222 --settings`。
- 桌面版与网页版共用同一份 `assets/` 与 `localStorage` 数据（同源 `http://127.0.0.1:8123`），网页入口保持可用，核心数据链路未改写。

## 快速开始

0. 桌面版（推荐）：双击根目录 `启动 XiHe GCS PRO.bat`，或直接运行安装后的 `XiHe GCS PRO` 快捷方式；开发时用 `npm start`。网页版一键启动：双击 `tools\start-all.bat`（未构建桌面版时自动回退到网页版），或运行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools\start.ps1`；脚本会拉起 `8123` 静态页、`8787` MCP 桥、`8770/9880` 本地 GPT-SoVITS，静态页就绪后立即打开无地址栏的 Edge App 窗口，TTS 在后台并行加载。需要普通浏览器时追加 `-UseBrowser`。
1. 若想单独打开 `index.html`，可直接使用波形、数据、串口、告警和模拟器。
   - 若 Web Serial 提示缺少安全上下文，请用 `python -m http.server` 或 Node 静态服务通过 `http://localhost` 打开。
2. 点左侧竖列的 **分析** 入口打开分析画布，使用节点调色板添加输入、计算、滤波、FFT、Python、可复用组件与输出节点；工具栏“组件库”可新建/编辑/复制/导入导出组件，拖拽端口连线后可点击宽命中区、中点 ×、右键或 Delete 删除连线。
3. 在“设置 → AI 对话”选后端：
   - **本地模型**：点 **发现模型** 选 Endpoint 与模型并 **测试连接**；模型请求默认走本地 MCP 桥代理，也可关闭代理直接连接。DeepSeek 等思考型模型默认关闭思考，避免推理耗尽 Token 后没有最终 JSON 动作。
   - **DSH Agent**：点 **检测 DSH**，显示可用后所有生成都走 `dsh --profile headless`；这条路径不需要 Endpoint / Model，由 DSH 自己的配置决定模型（`~/.dsh/settings.yaml`）。DSH 没装时状态栏直接给出 `npm i -g @deepseek-ai/dsh` 的提示。
4. 在 AI 对话输入示例：
   - `生成一个计算电压均值的脚本`
   - `生成一个双通道均值组件`
   - `生成一个计算均值并显示频谱的节点画布`
   - `生成一个带 CRC16 的 ASCII 数据引擎`
   - `生成一个 WED 遥测数据引擎`（自动建立 20 个协议通道）
   - `生成一个显示各通道占比的环形视图`（生成后自动自检：真挂载跑几帧，报评分/墨水率/画风提醒）
   - `当前数据状态`
5. 在“模拟”页可随时关闭仿真；在“串口”页选择真实设备、点选协议卡片应用，特殊协议可交给 AI 或展开“高级配置”。
6. 勾选 AI 面板 **MCP 桥**，让 Codex Agent 能读取数据并新增脚本/引擎。
7. 在“设置 → 语音播报 TTS”选择 Edge 或 GPT-SoVITS 引擎；GPT-SoVITS 默认地址为 `http://127.0.0.1:8770`，API Key 存于 `D:\GPT-SoVITS-src\.api-key`。
   - 一键启动本地 GPT-SoVITS：`powershell -ExecutionPolicy Bypass -File tools\start-sovits.ps1`
   - 本地适配已完成端到端验证：`default` 优先选择带 `weights.json` 的音色；启动器自动补 FFmpeg `PATH` 与整合包 `runtime\nltk_data`（兼容 NLTK 3.10 的 `averaged_perceptron_tagger_eng`），日志在 `D:\GPT-SoVITS-src\logs`。
8. 在“设置 → AI 子任务”查看 AI 任务执行记录与语音文本；AI 面板的“任务”按钮可快速进入。

## MCP 与 Agent

桌面版启动时会自动拉起本地桥（默认 `127.0.0.1:8787`），并把实例记录写到 `%APPDATA%\Xuanji\ai\instance.json`（端口、令牌、instanceId、工作区）。外部 Agent 不需要手写端口或令牌，统一走稳定启动器：

- 安装版：`cmd.exe /c "<安装目录>\xuanji-mcp.cmd"`（无参数进入 stdio；`--doctor` 输出诊断，`--version` 输出版本）
- 源码运行：`node mcp-server/launcher.mjs --stdio`

```powershell
# 先确认实例与桥可用
node mcp-server\launcher.mjs --doctor

# Codex 项目配置示例（.codex/config.toml）
# [mcp_servers.xhgcs]
# command = "cmd.exe"
# args = ["/c", "E:\\...\\Xuanji\\xuanji-mcp.cmd"]
```

设置 → MCP 桥 会显示真实状态（本地服务 / 实例 / 身份校验 / 工具数），并提供「复制 Codex 配置」「复制 Claude Code 命令」「复制通用 MCP 配置」「复制诊断」。写工具默认关闭，打开「允许写操作」后重启桥生效；写入仍然走「排队 → 浏览器执行 → ack」，返回体 `applied:true` 才代表真的应用。

Agent 可用工具（UI10 壳）：`snapshot`、`list_channels`、`channel_history`、`list_pages`、`get_page`、`list_scripts`、`list_protocols`、`list_engines`、`list_components`、`list_views`、`get_canvas`、`list_boards`、`get_board`（只读）；`create_page`、`delete_page`、`create_script`、`create_engine`、`set_active_engine`、`run_analysis`、`create_board`、`update_board`、`open_board`、`undo_board`、`create_view`、`update_view`、`delete_view`、`verify_view` 等（写，需开启）。图页操作直接使用界面真实的图页系统：`create_page {name, channels:["CH1","CH2"], windowSec:30}` 会新建页签并在工作台画出折线控件。

### 软件内 AI 对话（默认 DSH）

右坞「对话」默认使用随安装包提供的内置 DSH（0.1.5-rc.2，MIT）。首次发送消息时会把 `resources/dsh.zip` 解压到 `%APPDATA%\Xuanji\ai\dsh-runtime`（约 260 MB），之后的会话与缓存写在 `%APPDATA%\Xuanji\ai`。对话支持流式回答、工具轨迹、停止生成；写操作仍受 设置 → MCP 桥 的「允许写操作」控制。

首次使用会尝试复用本机已有的 DSH 模型凭据（`~/.dsh/.credentials.yaml` 复制到应用专用目录）。**干净机器上还没有软件内的模型配置入口**，需要先在本机配置过 DSH 模型；这是当前已知限制。外部 Agent（Claude Code / Codex）通过 设置 → AI 助手 复制配置，在它们自己的界面使用同一套 xhgcs 工具。

## Token 优化

- 安装包内置 `AGENTS.md`、`.codex/skills/` 与 `.codex/docs/`；默认上下文只读精简的 `AGENTS.md`，任务时再加载 skill，历史复盘按需检索。应用内 AI 生成视图时只注入 `XHGCS_VIEWS.viewApiDoc` 这一份规范文本。
- 协议信息集中在 `list_protocols` 与 Skill 的 Protocol Presets 表，Agent 用 `preset` 名创建引擎，避免重复读取详细配置。
- MCP `snapshot` 默认只返回最新值；`get_canvas` 默认只返回节点/连线摘要，`full:true` 才返回完整图；`channel_history` 默认最多 100 点；AI 串口上下文支持设置为 0–100 帧。
- 本地模型地址可在设置页一键发现；上下文帧数、系统提示、温度、最大 Token 与流式开关均可在设置页调整，降低后续 Agent 记忆与 token 消耗。

## 桌面化状态

- 已完成 Windows x64 桌面版：Electron 外壳 + 内置静态服务 + MCP 桥/TTS 托管，核心 `state.components`、脚本库、画布与串口引擎未改写。
- 安装包与免安装版位于 `dist\`；网页版入口与 `tools\start-all.bat` 回退路径继续保留。
- 后续可选方向：开机自启、托盘常驻、自动更新（`electron-updater`）。

## 工程约定

- **版本控制**：仓库已用 git 管理（`git log --oneline` 看历史，每次发版打 tag，如 `v0.7.5`）。`node_modules/`、`dist/`、`logs/` 不入库；`dist/` 里的安装包请当交付物单独拷贝/备份。
- **前端版本号**：日期串由 `npm run bump -- <YYYYMMDDX> [--pkg=<版本>]` 统一升级；资源 Worker 复用 `XHGCS_ASSET_VERSION`。只校验不改：`node tools/bump-version.cjs --check`。
- **静态体检**：`npm run audit` 检查死函数、孤儿 CSS、DOM id、版本串、CSS 括号和记忆文件卫生；有问题 exit 1，所以 `npm test` 会先体检再跑回归。
- **共用实现只留一份**：桥接地址拼接、Python 降级解析、HTML 转义挂在 `window.XHGCS`（`mcpUrl` / `pythonOneLine` / `esc`），新模块直接调，别再抄第二份；抄了 `audit` 也未必报，但下次改协议要改四处。
- **回归测试**：`npm test` 用真实 Chromium 跑核心数据链、AI、视图、布局、串口解析与桥接链路；用例数量以实际输出为准。不接真串口、不开 Electron。
- **装机版冒烟**：`XiHe GCS PRO.exe --remote-debugging-port=9400` 启动后跑 `npm run smoke --silent -- 9400`，期望 `ERRORS []`。
- **打包**：`npm run dist`（Windows x64，约 30–60 秒），产物 `dist\XiHe GCS PRO-<版本>-x64.exe`（安装版）与 `-portable.exe`（免安装）。旧产物及时删掉，别让 `dist/` 无限长大。
## 保留原文件

原始文件 `E:\AI编程工具\工作环境\项目\XiHe_GCS\XiHe_GCS.html` 未修改。

