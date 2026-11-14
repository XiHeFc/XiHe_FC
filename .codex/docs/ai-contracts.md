# AI 链路硬契约（0.29 夜间批次）

> 本文件是 `AGENTS.md`「AI 硬契约」一节的展开版。**AGENTS.md 只留指针，细节在这里**——
> 约束是可判定的，理由与踩坑过程在 `.codex/docs/engineering-history.md` 第九节。
> 改 AI 链路（`assets/js/ai*.js`、`mcp-server/`、`data.js` 的 `state.ai`）前先读这一页。

## 1. 产物自证

- 脚本/画布生成必须真跑一遍（`commitScriptArtifact`）才允许报成功，消息带真实输出值。
- 失败回滚用**落库前快照还原**，禁止按 id 删除（`saveScript` 哪天变成「有 id 则更新」会误删用户既有产物）。
- Python 分两类：环境缺失（桥没起 / 没装 Python）→ 保留产物 + `verified:false` + 提示手动跑；计算错误 → 回滚 + `试运行失败：原因`。
- 试运行前后必须快照/恢复 `state.analysis.lastError`（那是分析面板正在显示的共享错误）。
- 公式里的通道引用用**公式名**：生成前 `normalizeFormulaIds` 做确定性 id→公式名替换（`wed-fc-01` → `c01`）。

## 2. 错误模型（唯一来源）

- `diagnoseError()` → `{kind,title,hint,retryable,status,detail}`，14 类 kind。
- `err.info`（抛出侧）、消息 `meta.errorInfo`、`state.ai.lastErrorDetail` 三处同源；`state.ai.lastError` 字符串保持兼容。
- 界面/任务面板只读 kind，**禁止另写 HTTP 状态码正则**。
- `requestJson` / `mcpJson` 非 2xx 必须带上 HTTP 状态 + 响应体 detail（否则上游 400 的 `context_length_exceeded` 会被压成 upstream）。

## 3. DSH 后端协议

- headless stderr 格式：**首段只写一次 `dsh: reasoning:` 头，之后是裸文本增量**（无前缀、通常无换行、含中文多字节）。
- 解析只准走 `mcp-server/dsh-stderr.js`（纯函数 + `StringDecoder` 状态机）；失败真因取最后一条 `dsh: <code>: <message>`。
- stderr 有界消费：60 行 / 16KB / tail ≤1200 字符；进度转发总 ≤32KB，超了发一次 truncated。
- `XHGCS_DSH_BIN` 是打桩与逃生口（先于默认路径）。
- 取消必须杀**进程树**（Windows `taskkill /PID /T /F`）并立即复位 `dshState.running`，不等 close。
- `/api/ai/dsh` 的 `stream:true` 复用既有 SSE 风格（`reason/final/error/[DONE]`），生成类任务仍一次性 JSON。

## 4. 上下文预算

- `state.ai.contextBudgetChars`：默认 24000，clamp 4000–120000（`loadState` 读存档、`importConfig` 导入两处 clamp，改配置行为跟着变）。
- 0.8×预算触发裁剪：先精简 system 的数据链快照，再按**轮边界**把历史裁到最近约 16%；当前问题永远完整、最近一轮 assistant 保留。
- system+当前问题仍超预算才抛 `context_length` 类错误；收到该 kind 时用 0.6x 预算自动重试**一次**，仍失败如实报。
- `XHGCS_AI.contextUsage()` → `{chars,estTokens,turns,trimmed,budget}`（空态零值、绝不抛）。

## 5. 应用内工具面

- 只读工具含 `channel_history`（points 默认 100、上限 500；返回真实序列 + min/max/mean/rms/slope/delta）。
- `snapshot` 日志默认不带，需要时显式 `include_logs:true`。
- 工具结果裁剪「头 8000 + 标记 + 尾 2000」，标记里写清可用更小 limit/points 重试。
- 单工具 15s 超时（`runWithTimeout`）回灌明确错误，不挂死工具循环。
- 每轮工具调用记 `meta.tools=[{name,ok,ms,bytes}]`，`XHGCS_AI.toolTrace()` 可读（空态 `[]`、绝不抛）。
- `lastN(n)`（默认 20、上限 100，内存环）与 `qualityStats()` 是本地生成质量观测：不写 localStorage、不上报。

## 6. 运行态契约

- `xhgcs:ai-busy`：`{busy, phase: chat|generate|tool, task}`，开始/结束/停止都发。
- `xhgcs:ai-error`：`{kind,title,hint,raw,model,at}`，复用 diagnose。
- AI 抽屉只搬 DOM（`#aiPanel` → `#aiPanelHost`）：`XHGCS_AI_UI.renderMessages/updateStatus`、`meta.errorInfo`、上述事件与可观测接口都是契约；再动 `#aiPanel` 内部结构要复跑抽屉探针。

## 7. MCP 写工具面

- 脚本/引擎四件套：`update_script` / `delete_script` / `update_engine` / `delete_engine`（支持 id 或 name 定位）。
- update 保留 `id/builtin/origin/createdAt` 并重走 normalize 校验；内置脚本/组件只读；活动引擎 delete 一律拒绝（先 `set_active_engine`）。
- 删除写墓碑（≤200）且浏览器按 **in-place 合并**，不允许让轮询把更新冲掉；`applied:true` 才算成功。

## 8. 测试纪律（AI 相关）

- fixture 必须真实抓包且 `git ls-files` 可见（`.gitignore` 已给 `!tests/fixtures/*.log` 例外）；打桩必须照上游真实输出，上游格式变了改 fixture 不改解析器。
- 瞬时红先复跑再判：单条红 `--filter` 连跑 3 次 + 全量复跑；全绿判脆断言并加稳定性处理（暂停后台 tick / 等 DOM 真实状态），不许 skip 或删断言。
- `tools/regress.js` 单写者交接：写完必须明示「已释放」并贴 mtime / `git diff --stat`；跑测试不算持有。
- wire 层契约测试在 `tools/bridge-contract-smoke.cjs`（`npm run test:bridge`）；产物注册表契约在 `tools/regress.js`。
