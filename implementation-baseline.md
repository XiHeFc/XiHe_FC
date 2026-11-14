# Xuanji AI / MCP 实施基线（P0）

日期：2026-11-04 · 对应施工图：`Xuanji_AI_MCP_施工图.md` v1.0

本文件记录 P0 的核实结果：源码归属、运行基线、已选定的 DSH 版本与实施差距。后续阶段按施工图 P1→P4 推进，完成情况以代码与验证记录为准。

## 1. 源码归属

- 选定源码：`E:\AI编程工具\工作环境\项目\XiHe_GCS_PRO`
- 分支 / 提交：`feat/ui10-shell115`，P0 起点 `dc6ac60`（feat(ui): 设置页与主题族×模式装为前端（样稿 v131））
- `package.json`：`xhgcs-pro` 0.31.0，`productName: Xuanji`，`main: electron/main.js`
- 前端版本串：`20261104A`（index.html 4 处外链 + boot.js / layout.js / tools/start.ps1）
- 安装版核对（`Xuanji\resources\app.asar`）：
  - package：`xhgcs-pro 0.31.0 / Xuanji`
  - index.html：前端版本串 `20261104A`；包含本次移植的 `setFamilyBtn` 与 `.ptab::before` 悬停底片
  - 结论：安装版由该源码构建，源码与用户当前前端一致
- 另一目录 `XiHe_GCS_PRO_frontend_edit_20261101` 根目录无 package.json，不作为构建入口，未使用。

## 2. 当前运行基线（0.31.0）

- 启动器：`Xuanji.exe`（Electron 44.3.0 / Chromium 152 / Node 24.20.0），单实例锁；静态服务 `127.0.0.1:8123`。
- 主进程 `electron/main.js`：窗口、受限 IPC（`isTrustedSender`）、串口选择、录制、用户扩展目录、userData 迁移（`XiHe_Vofa` / `XiHe GCS PRO` → `Xuanji`）。
- `electron/services.js`：用 Electron-as-Node 启动 `mcp-server/bridge.mjs`，注入 `XHGCS_BRIDGE_PORT` / `XHGCS_BRIDGE_TOKEN` / 来源白名单；看门狗每 3s 探测并在连续失败后自愈；旧代桥（sha 不一致）会被替换。
- `mcp-server/bridge.mjs`：一个进程同时提供 HTTP（`/api/health`、`/api/state`、`/api/ack`、`/api/mcp`、`/api/ai/chat`、`/api/ai/dsh` 等）与 MCP stdio；`--mcp-stdio` 为代理模式（不绑 HTTP）。
- 工具面：`snapshot`、`channel_history`、脚本/引擎/组件/视图/画布/看板等；写工具走「排队 → 浏览器执行 → `/api/ack` 回执」，返回体 `applied` 才代表应用成功，看板补丁默认 `dry_run`。
- 前端：index.html 是 UI10 壳（v131 样稿装为前端），只加载 `data.js / protocol.js / serial.js / v43-bridge.js`；`assets/js/ai*.js`、`bridge.js`、`desktop.js` 存在但**未加载**，右坞 AI 仍是静态演示。
- 实测基线：应用可启动、42 个真实通道、串口记忆 COM3、桥自动启动在 8787；`/api/health` 返回 `ok/name/sha/pid/revision/token`。

## 3. DSH 版本与运行方式

- 本机现有：
  - 全局 npm：`@deepseek-ai/dsh@0.1.5-rc.2`（MIT，267 MB 含依赖），`dsh --version` 正常。
  - DeepSeek Harness 桌面应用自带 0.2.1-rc.5（约 270 MB 运行时目录，依赖其 Electron asar，不宜直接拆用）。
  - npm registry 最新：`0.2.1-rc.5`（2026-11-03），另有 `0.2.2-alpha.3`。
- 已验证：`ELECTRON_RUN_AS_NODE=1 electron.exe <dsh>/lib/bin.js --version` 输出 `0.1.5-rc.2`，即**可以用 Electron 自带 Node 24.20.0 运行 DSH**，无需另带 Node 运行时。
- 选定版本：**0.1.5-rc.2**。理由：
  1. 现有 `dsh-stderr.js` 解析器与 `tests/fixtures` 按该版本真实输出建立；
  2. 其 ACP profile（`dsh --profile acp`）已提供标准 ACP v1：`initialize` / `session/new` / `session/list` / `session/resume` / `session/close` / `session/set_config_option` / `session/prompt` / `session/cancel` / `session/update` / `session/request_permission`，满足会话、取消、工具生命周期与模型选择需求；
  3. 0.2.x 未在本机完成兼容验证，按施工图要求不盲目替换已验证运行时。
- 捆绑方式（P2 执行）：将 npm 树的 `@deepseek-ai/dsh` 生产依赖复制为构建期 extraResources（不提交仓库），运行时用 `Xuanji.exe` + `ELECTRON_RUN_AS_NODE=1` 启动；profile/会话/缓存写入 `%APPDATA%\Xuanji\ai\dsh`，安装目录只读。许可证 MIT，随包附 LICENSE。
- 已知限制：ACP profile 只提供标准语义更新（消息、工具生命周期、配置、上下文用量），不提供 DSH 私有展示数据；不实现内部推理链展示。

## 4. 差距清单（按施工图阶段）

### P1 · MCP 与连接管理
- 缺稳定启动入口：外部客户端现在只能拿到 `bridge.mjs` 路径，依赖 `node`，且 README 中 `--stdio` 与代码 `--mcp-stdio` 不一致。
- 缺实例记录：没有 `instanceId / workspaceId / pid / 协议版本` 的可校验记录；launcher 无法确认「连的是当前这个实例」。
- 缺端口冲突处理：桥固定 8787，被非 Xuanji 服务占用时启动失败。
- 安全缺口：`/api/health` 对无 Origin 的请求直接返回写令牌；需要改为只返回状态，令牌走实例凭据文件与受限 IPC。
- 设置页「MCP 桥」只有静态占位，没有真实状态、客户端配置、诊断。

### P2 · 默认 DSH 完整集成
- 未捆绑 DSH；`/api/ai/dsh` 是「一条消息一次 CLI」，没有会话、增量消息语义与标准取消回执；应改用 ACP。
- 前端未接入：新的右坞对话是静态演示，没有消息、任务、工具事件、取消。
- 主进程没有 Agent Adapter / Task Service；渲染层不能直接起进程。

### P3 · 外部 Agent 与切换
- 无客户端配置适配器与合并写入（Codex `/ .codex/config.toml`、Claude Code `~/.claude.json`）。
- 无 Agent 选择器与会话隔离；无支持等级标注。

### P4 · 恢复与打包
- 无安装包内的 DSH 资源、无干净环境验证；`npm test` 的 audit 仍有历史失败项（死函数/CSS/DOM 引用，UI10 壳已知），P4 前需按新壳重写对应断言。

## 5. 实施策略

1. **保留现有前端结构与风格**：右坞 AI、设置页「MCP 桥 / AI 助手」只在现有 DOM 上增量接线，不重写样稿。
2. **DSH 与外部 Agent 同级**：都通过 MCP 使用同一套业务工具；DSH 额外有软件内对话适配器（ACP）。
3. **前端按钮与 AI 同一命令层**：沿用桥的排队/回执语义，accepted/applied 严格区分。
4. **主进程负责进程与凭据**：renderer 不接触 `child_process`、模型密钥、客户端配置文件。
5. 每阶段完成后更新本文件与 `README`/使用说明，并以 git 提交记录。

## 6. 验证入口（现状）

- `npm run test:samples`：采样可信度（已通过）。
- `npm run test:bridge`：桥契约冒烟（P1 起扩展 launcher/实例校验）。
- `npm test`：audit + regress；audit 在 UI10 壳下仍有历史失败项，如实记录，不删除断言。
- 装机验证：`Xuanji.exe --remote-debugging-port=9401` + Playwright CDP（P1 起加入 AI 连接页检查）。

## 7. P1 完成记录（2026-11-04）

### 已实现

- 稳定启动入口 `mcp-server/launcher.mjs`：
  - `--version` / `--doctor` / `--stdio`（默认 stdio）；stdout 只走协议，日志走 stderr。
  - 从实例记录读取端口与凭据，校验 pid、`instanceId`、桥代码 sha，失败时给出可读原因（应用未开、进程已退出、桥无响应、身份不符）。
  - `tools/list` 通过新增的 `GET /api/mcp/tools` 取当前权限下的工具；`tools/call` 走 `/api/mcp`。
  - 装箱入口 `build/xuanji-mcp.cmd`（`cmd.exe /c xuanji-mcp.cmd`），由 electron-builder `extraFiles` 放到安装目录。
- 实例记录：主进程写 `%APPDATA%\Xuanji\ai\instance.json`（instanceId、workspaceId、pid、webPort、bridgePort、bridgeToken、bridgeSha、appVersion、startedAt）；退出时删除，重启服务时重写。
- 端口冲突：桥端口被非璇玑服务占用时自动顺延（最多 40 个），实例记录随真实端口更新。
- 令牌收敛：`/api/health` 默认不返回令牌；仅开发模式且来源在白名单时才回（浏览器直连用）。装机版渲染层通过 `XHGCS_DESKTOP.ai.token()` 的受限 IPC 取令牌；`data.js` 已改为优先 IPC。
- 写工具默认关闭：`XHGCS_MCP_WRITE=0` 时 `tools/list` 不发布写工具、`/api/mcp` 与 stdio 直接拒绝；设置页「允许写操作」通过 IPC 重启桥生效。读工具 13 个，写工具 18 个（合计 31）。
- 设置页「MCP 桥」接入真实状态（`assets/js/ai-connection.js`）：本地服务/实例/身份校验/工具数、启用桥、端口、令牌重置、写操作开关、复制 Codex / Claude Code / 通用 MCP 配置、复制诊断、重启本地服务。
- UI10 数据桥（`assets/js/shell-bridge.js`）：每 1.5s 推送数据链快照与序列到桥、取回排队项并回执；未知操作立即回 `ok:false`，不再让调用方等超时。
- 壳内页面接口（`window.XHGCS_SHELL`）：`summary / handleQueue / createPage / deletePage`；`createPage` 走 `addPageWith` + 工作台 `__xhWB.addChannels`，每 3 路一个折线控件，窗口秒数同步到工作台。
- 新 MCP 工具（实际图表系统 = UI10 图页）：`list_pages`、`get_page`（只读）、`create_page`、`delete_page`（写）。全部走「排队 → 浏览器执行 → ack」，返回 `applied` 才代表落库。
- 冒烟脚本 `tools/ai-connection-smoke.cjs`：版本 / doctor / stdio initialize / tools/list / snapshot。

### 验证记录（开发模式，Electron 44 / Node 24.20.0）

- `node tools/ai-connection-smoke.cjs` → PASS：`xuanji-mcp 0.31.0`，doctor ok，stdio 13 个只读工具，snapshot 42 通道。
- 身份与凭据：health 无 Origin 请求返回 `token:""`；doctor 校验 instanceFile/process/bridge/identity/token 全部通过。
- 写权限：关闭时 13 工具，`create_script` 返回「写操作未开启」；开启后 31 工具，关闭后恢复 13。
- 端到端：`create_page {channels:["CH3","CH4"],windowSec:20}` → `applied:true`，页签出现、折线控件渲染；`get_page` 返回通道与 20s 窗口；`delete_page` → `applied:true`，页签消失。
- 设置页截图：`.xh-port/p1-settings-mcp.png`（开发模式），状态与开关与真实桥一致。

### 已知限制 / 下一步

- 旧壳的看板 / 脚本 / 引擎 / 视图队列项在 UI10 壳里没有执行器：会立即回 `ok:false`（不再假装成功）。这些能力在 P2 决定是否迁回或改为图页工具。
- 外部真实客户端（Codex / Claude Code）的自动注册与「已配置 / 已连接」区分属于 P3；当前提供可信的配置复制。
- P2 默认 DSH 尚未捆绑；`/api/ai/dsh` 仍是一次性 CLI，计划改用 ACP 适配器接入软件内对话。

## 8. P2 完成记录（2026-11-04）

### 已实现（默认 DSH / ACP 接入软件内对话）

- ACP 客户端 `electron/ai/acp-client.js`：JSON-RPC over stdio（initialize / session/new / session/prompt / $/cancel_request / session/close）；权限请求只放行 `mcp__xhgcs` 工具，shell/文件类一律拒绝；退出时拒绝所有挂起请求。
- 会话服务 `electron/ai/task-service.js`：
  - 专用 DSH_HOME `%APPDATA%\Xuanji\ai\dsh` 与工作区 `%APPDATA%\Xuanji\ai\workspace`；首次运行把用户已有的 `~/.dsh/.credentials.yaml` 复制到专用目录（不修改全局配置）。
  - 会话内注入 MCP：`bridge.mjs --mcp-stdio`，env 带 `XHGCS_BRIDGE_PORT` / `XHGCS_INSTANCE_FILE` / `XHGCS_MCP_WRITE`（与设置同步，代理进程自己也按此过滤工具）。
  - 事件映射：`agent_message_chunk` → 流式文本；`tool_call` / `tool_call_update` → 工具轨迹（随消息持久化）；`usage_update` → 用量；完成/取消/失败分别发事件。
  - 取消：ACP 0.1.5-rc.2 不支持 `session/cancel` 请求方法，改用标准通知 `$/cancel_request {requestId}`；会话启动阶段取消由任务服务在发 prompt 前退出。
  - 桥权限/端口变化时关闭旧会话（`resetSession`），下一条消息按新权限重新协商工具。
  - 消息持久化 `%APPDATA%\Xuanji\ai\chat.json`（最多 200 条，含工具轨迹）。
- 主进程与 IPC：`ai:status` / `ai:send` / `ai:cancel` / `ai:clear`，事件 `ai:event` 推给渲染层；preload 暴露 `XHGCS_DESKTOP.aiChat`，渲染层不接触进程与凭据。
- 右坞对话 `assets/js/ai-dock.js`：真实消息、流式回答、工具轨迹行、任务计数、模型芯片、运行中发送键变停止键；无桌面桥时保留样稿。
- DSH 捆绑：`tools/prepare-dsh.cjs` 把已验证的 `@deepseek-ai/dsh@0.1.5-rc.2`（MIT）复制到 `vendor/dsh`（不进 git），electron-builder `extraResources` 打包到 `resources/dsh`；`npm run prepare:dsh` 可重复生成；打包版由 `resolveDshEntry` 从 resources 解析。

### 验证记录（开发模式，Electron 44 / Node 24.20.0，真实模型）

- 直接 ACP 探针：initialize → session/new → prompt「只回答两个字：你好」→ 1.4s 返回 `agent_message_chunk:"你好"`、`stopReason:end_turn`。
- 经软件内对话：`list_channels` 工具被真实调用，助手回答「42」；工具轨迹 `mcp__xhgcs__list_channels:completed` 随消息持久化。
- 端到端建图：开启写操作后，DSH 调用 `create_page {CH1,CH2,30s,"AI 验证"}` 返回 `applied:true`，页签出现、折线控件渲染、工具轨迹 `create_page:completed`；删除该页恢复。
- 取消：启动阶段取消（`sent:false`）与生成中取消（`$/cancel_request`，`sent:true`）都能在数秒内把 `running` 置回 false；半截回答留档。
- 写权限：DSH 侧工具数随 `XHGCS_MCP_WRITE` 变化（只读 13 / 可写 35），切换后旧会话被重建。
- 截图：`.xh-port/p2-chat-read.png`、`p2-chat-create-page2.png`、`p2-cancel2.png`。

### 已知限制（P2 未闭环）

- 首次模型配置还没有软件内入口：目前复用本机已有的 DSH 凭据；干净机器需要先有 DSH 登录或手工配置（P3/P4 补一个受保护的配置入口）。
- DSH 版本固定 0.1.5-rc.2；0.2.x 未验证，不自动升级。许可证 MIT，`vendor/dsh/VERSION.json` 记录来源与 package.json 摘要。
- 打包后的 resources/dsh 启动验证与「干净机器无 Node」属于 P4，尚未执行。
- 工具轨迹在历史里只保留标题/状态，不保留完整工具输出。

## 9. P3 完成记录（外部 Agent，2026-11-04）

### 已实现

- 只读接入检测 `electron/integrations/clients.js`：读取 `~/.claude.json`（JSON）与 `~/.codex/config.toml`（按节），报告是否已有 `xhgcs` 条目、入口是否与当前版本一致；生成 Claude 命令 / Claude JSON / Codex TOML 三种可复制配置。
- IPC `ai:clients` + preload `XHGCS_DESKTOP.aiClients`；设置 → AI 助手 顶部显示 Agent 支持矩阵：内置 DSH（完整集成）/ Claude Code（工具接入）/ Codex（工具接入），以及复制配置按钮。
- 当前检测结果：Claude Code 未配置；Codex 已有 `[mcp_servers.xhgcs]` 但入口仍指向 `bridge.mjs`，界面标注「入口需更新，可复制新配置」。

### 未完成 / 阻塞

- **一键写入客户端配置**（自动合并 + 备份 + 原子写入）没有落地：写入用户主目录下的客户端配置被当前权限策略拦截（未经明确授权的持久化修改）。界面因此只提供「复制配置」，不提供自动写入，也不把「已配置」标成「已连接」。
- 没有可用的外部客户端 CLI（`codex` / `claude` 不在 PATH）可做真实客户端发现与调用验证；工具的协议级验证由 `tools/ai-connection-smoke.cjs`（launcher stdio）覆盖，但没有冒充「已在某客户端里跑通」。
- Agent 选择器目前只有内置 DSH 一个可对话适配器；外部客户端按其真实能力标为「工具接入」，并明确在其自己的界面聊天。

## 10. P4 打包与装机验证（2026-11-04）

### 打包

- electron-builder 会过滤 `extraResources` 里的 `node_modules`（实测只拷出 VERSION.json），因此改为随包放 `vendor/dsh.zip`（67 MB，bsdtar 打包），由主进程首次使用时解压到 `%APPDATA%\Xuanji\ai\dsh-runtime`（约 267 MB）。`tools/prepare-dsh.cjs` 同时生成目录与 zip；`vendor/` 不进 git。
- `build/xuanji-mcp.cmd` 通过 `extraFiles` 放到安装目录根；安装版客户端入口为 `cmd.exe /c "<安装目录>\xuanji-mcp.cmd"`。
- 构建：`npm run dist` 未挂代理成功；产物 `dist\Xuanji-0.31.0-x64.exe` 与 portable，约 153 MB。
- 安装前备份：`%APPDATA%\Xuanji` → `Xuanji.backup-20261104-p4`（robocopy，排除可重建的 `ai\dsh` 缓存；PowerShell Copy-Item 在长路径上失败）。

### 装机验证（真实安装版）

- 安装：`/S /D=E:\AI编程工具\工作环境\项目\Xuanji`，退出码 0；`resources\dsh.zip` 与 `xuanji-mcp.cmd` 就位。
- 启动器：`xuanji-mcp.cmd --doctor` → `ok:true`，instanceId/pid/桥 sha/令牌检查全部通过；`/api/health` 不再返回令牌。
- 内置 DSH：首条消息触发 zip 解压（日志 `ai: extracted bundled DSH`），39 秒内完成解压并回答；`list_channels` 工具真实调用，回答「42」。
- 建图：开启写操作后 `create_page {CH1,CH2,30s,"装机验证"}` 返回 `applied:true`，页签与折线控件出现；删除后恢复。
- 取消：生成中 `$/cancel_request` 生效，`running` 在数秒内复位。
- 清理：测试页删除、写权限关闭（工具 13）、对话清空；应用以正常方式重新启动。

### 已知限制（P4 未闭环）

- 干净机器（无 Node、无全局 DSH、无 DSH 模型凭据）安装后能解压并启动 DSH 进程，但没有软件内的模型配置入口，无法完成首次模型配置；需要用户先在本机配置 DSH 或提供受保护的配置入口。
- 外部客户端一键写入配置被权限策略拦截，只能复制配置；没有真实客户端 CLI 可做「已连接」验收。
- `npm run test:bridge` 26 项通过；`tools/sample-integrity.cjs` 的前两项数据断言通过，UI 断流断言因 UI10 壳的画布/图例结构不适用而失败（历史遗留，未删断言）；`npm run audit` 仍有 UI10 壳的 CSS/DOM 历史失败项。
