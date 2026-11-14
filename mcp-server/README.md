# XiHe_GCS 本地 MCP/HTTP 桥

同时提供：
- HTTP 桥：`http://127.0.0.1:8787`
  - `POST /api/state`：浏览器上送数据链快照。
  - `GET /api/state`：Agent 或外部程序读取当前快照和 MCP 队列。
  - `GET /api/ai/discover`：扫描本机常见模型端点，返回 OpenAI 兼容模型列表。
  - `POST /api/ai/chat`：转发 OpenAI 兼容 `chat/completions` 请求，支持流式 SSE 与普通 JSON；请求体需包含 `endpoint`、`model`、`messages`、`stream`。
  - `POST /api/mcp`：HTTP 方式调用同套 MCP 工具（调试/脚本集成用）。
  - `POST /api/analyze`：Python `analyze(ctx)` 执行入口。
  - `POST /api/ack`：浏览器确认已处理的 MCP 队列。
- MCP stdio：供 Codex/Claude 等 MCP 客户端调用。

## 运行
```bash
node mcp-server/bridge.mjs
# 或
npm run bridge
```

## 浏览器启用
打开 `index.html` → AI 对话面板勾选 **MCP 桥**，或在设置中填写桥地址并启用。浏览器每 1.5 秒推送快照，并把 Agent 创建的脚本/组件/引擎合并回界面；脚本自动挂载到“脚本数据”并运行。

## MCP 工具
- `snapshot`：当前数据链摘要，默认仅最新值；含 `ai.tasks`（AI 子任务状态）与 `ai.tts`（TTS 配置）。
- `channel_history`：通道最近序列。
- `list_scripts` / `create_script`：查看或创建数据脚本。
- `list_components` / `create_component` / `update_component` / `delete_component`：查看或管理公式/Python 可复用组件；组件节点通过 `create_graph` 的 `type:"component"` 与 `config.componentId` 引用。
- `get_canvas` / `create_graph`：读取或创建节点式分析画布；`get_canvas` 默认返回摘要，`full:true` 返回完整图，`create_graph` 的 `load:true` 会把画布同步到浏览器。
- `list_protocols`：列出 JSON / ASCII / HEX / WED 四种协议预设，包含默认帧头/帧尾/校验/字节序/示例。
- `list_engines` / `create_engine` / `set_active_engine`：管理串口数据引擎；推荐 `create_engine({name, preset:'wed'})` 直接创建，也可传 `header`、`tail`、`terminator`、`checksum`、`byteOrder`、`hexScale` 覆盖；激活 WED 后浏览器自动应用 20 个协议通道。
- `run_analysis`：运行函数脚本；Python/节点画布脚本排队到浏览器执行。
- `list_boards` / `get_board`：查看本机看板列表与某块看板的控件结构（id/类型/栅格/绑定）。**改看板前先调 `get_board` 拿准 id。**
- `create_board` / `open_board`：新建一块空看板 / 切到前台并全屏运行。
- `update_board`：增量补丁，`ops` 只允许 `add/remove/update/move/rename`，一次最多 50 个。
  **默认 `dry_run: true` 只校验不落库**，确认后传 `dry_run: false` 才真正应用；应用前整份文档会备份。
- `undo_board`：回退最近一次补丁（改坏时的安全绳）。
- 看板工具走「排队 → 浏览器执行 → ack 带 `data` 回传」这条链路，所以应用没打开时会返回 `ok:false`，不要当成功。

## Codex 配置
项目 `.codex/config.toml` 已包含：
```toml
[mcp_servers.xhgcs]
command = "E:/Nodejs/node.exe"
args = ["E:/AI编程工具/工作环境/项目/XiHe_GCS_PRO/mcp-server/bridge.mjs"]
startup_timeout_sec = 30
```
也可以执行：
```powershell
codex mcp add xhgcs -- E:/Nodejs/node.exe E:/AI编程工具/工作环境/项目/XiHe_GCS_PRO/mcp-server/bridge.mjs
```

## 协议示例
```json
{"name":"WED 遥测","preset":"wed"}
{"name":"CRC16 ASCII","preset":"ascii","checksum":"CRC16"}
{"name":"自定义 16 通道 WED","preset":"wed","channelCount":16,"payloadBytes":32}
```
