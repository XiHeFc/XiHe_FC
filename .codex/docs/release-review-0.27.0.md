# 交付前评审 · XiHe GCS PRO 0.27.0

- 评审对象：`feat/plugin-kernel` @ `29d09ca`（0.27.0，前端串 20261027B）
- 评审角色：软件架构师（架构/扩展性）、应用安全工程师（权限/安全）、验收测试工程师（验收边界）
- 主理人独立核对：本地桥 origin 白名单、`/api/ack` 丢 `data`、`/api/health` 回 token、`designer.ts:794` 的 `innerHTML`、`host.ts` 的 `snapshotExports`、`static-server.js` 只做字符串前缀校验
- 仓库状态：评审期间未被任何成员修改（`git status` 干净）

## 结论

**不建议以「可发布装机版」口径放行 0.27.0。**
以「源码 / 内部测试包」放行可行，但需先闭合 4 项 P0（合计约 1 天、<200 行改动）：

1. 本地桥对任意 localhost 来源下发写令牌，可换任意 Python 执行（已复现）；
2. 装机版复用外部 8123 服务（已复现机理），可被本机进程冒充 UI 并拿到 IPC / 串口；
3. MCP 六个看板工具在 wire 层破损且**谎报成功**（已端到端复现）；
4. 插件 `deactivate()` 永不执行、「重载」不重新加载代码（已动态复现）；
5. 发布链不产出安装包、`verify-dist` 缺 require 闭包、bundle 新鲜度无机械校验（已核对产物）。

现有绿色门禁（73 / 89 / 8 / verify:dist）真实有效，但它们覆盖的是**源码层与 unpacked 包层**，恰好漏掉 wire 层和装机层 —— 上述缺陷全部落在缝里。

## 一、已复现（可复跑）

| 编号 | 严重度 | 问题 | 证据 | 最小修复 | 回归 |
|---|---|---|---|---|---|
| S1 | Critical | 本地桥把写令牌交给任意 localhost 端口：`allowedOrigin` 正则放行 `localhost:*`，`GET /api/health` 无鉴权返回 token，`POST /api/analyze` 用 `py -c` 执行任意代码 | 安全角色用独立 bridge 黑盒复现：`Origin: http://localhost:5173` 可读 token，并成功执行 Python 取回 `whoami` | `XHGCS_ALLOWED_ORIGIN` 精确到 `127.0.0.1:<webPort>`；`/api/analyze` 需同源+token（或桌面版默认关闭）；`/api/state`、`/api/ai/dsh` 同样收紧 | 扩展现有 CORS 用例：非白名单 Origin 无 ACAO；无 token 403 |
| S2 | High | 8123 端口复用只认「前 4KB 含 XiHe_GCS」，可被本机进程冒充；复用分支还没有 `/ext` 挂载 | 安全角色探针：假 marker 服务器被 adopt；`probeApp` 命中即 `reused:true` | packaged 模式禁止复用（仅 dev 允许）；复用前校验随机 nonce/版本身份 | node 级：假 marker 占位 → packaged 必须自起服务 |
| T1 | High | MCP 看板六工具：`/api/ack` 丢 `data`、入队 id 被 qid 覆盖、`boardCall` 无条件 `ok:true`、`dry_run` 前先切活动板 | 架构 + 验收双方复现：`list_boards` 无数据、非法补丁与空回退均 `applied:true`、dry_run 改活动板并落盘 | ① ack 存 `data`；② 入队用 `boardId` 与 qid 分离；③ `data.result.ok===false`/dry-run 错误 → `ok:false`；④ 浏览器侧 `switchTo` 移到 dryRun 判断之后（约 15 行） | 真桥 + 真渲染层：6 工具断言 data、错误语义、dry_run 不改 `activeId` |
| T2 | High | 插件生命周期契约失效：`snapshotExports` 剔掉 `activate/deactivate`，`deactivate` 读 `record.exports` 永远 undefined；`loadClassicScript` 同 URL 短路，reload 复用旧模块 | 架构/验收各自动态复现：deactivate 计数 0；改入口后 reload 仍跑 v1 | 保存原始 module 引用；reload 前删 `script[data-xhgcs-ext]` 与 `window.XHGCS_EXTENSIONS[id]`，加 cache-bust | smoke 两条：deactivate 计数；文件变更后 reload 执行新代码 |
| R1 | High | 发布产物链不闭环：`release` 只 `pack --dir`，dist 无 0.27.0 安装包；冒烟在 `build:core` 之前；`verify-dist` 只查文件存在，不查 require 闭包 | 验收角色核对 dist 与 `%APPDATA%` 日志：0.27.0 打包后无桌面启动记录 | release 改为 `build → test → pack → dist → verify:dist`；verify-dist 走 require/script 闭包；audit 校验 `package.json.version == CORE_VERSION` | 删任一闭包文件 → verify-dist 必红；release manifest 记录 asar/exe/安装包 sha |

## 二、代码路径已确认（未端到端）

| 编号 | 严重度 | 问题 | 位置 | 最小修复 |
|---|---|---|---|---|
| S3 | High | Electron 缺防御纵深：无 CSP、无 `will-navigate`、权限处理不校验来源、IPC 无 sender 校验、生产可开 DevTools | `electron/main.js`、`static-server.js` | 导航白名单 + IPC `assertTrustedSender` + 权限来源校验 + CSP Report-Only |
| S4 | Med-High | 导入看板 → 设计器标题 `innerHTML` 拼接 `node.id` → 存储型 XSS → 可接 S1 到 RCE | `src/designer/designer.ts:794`（主理人已核对） | 改 `createElement + textContent`；`normalizeNode` 给 id/type 加字符白名单 |
| S5 | Medium | `/ext` 只做字符串 canonical 检查，junction/symlink 可逃逸读任意文件 | `electron/static-server.js:83`（主理人已核对） | `realpath` 后与 `realpath(base)` 比较；入口文件同样 realpath |
| S6 | Medium | 信任模型表述缺口：插件 0 权限也以应用源执行；`host.grantAccess` 页面内可调；consent 指纹不含文件内容；`fs:own/datasources:own/ui:menu` 未投影 | `src/core/{host,api,consent,manifest}.ts` | 指纹纳入入口 sha256；README/授权页明示「插件=本机程序级」；剪掉或补齐未实现权限 |
| Q1 | Med-High | 持久化失败静默：`writeJSON` 只 warn、`persist` 先写缓存；v2 看板库损坏无备份直接覆盖；desktop-config 非原子写 | `board-store.ts`、`data.js`、`electron/store.js` | 统一 safeWrite：失败事件 + 可见提示、损坏先 `.bak`、文件 tmp+rename |
| Q2 | P2 | 设计器未保存改动：关闭/外部 patch 重开/刷新均无提示；`dry_run` 与 revert 误伤边界 | `designer.ts:485-505`、`board-store.ts:319-338` | dirty 标记 + 关闭确认（或关闭即保存）；revert 校验 base 与 boardId |
| Q3 | P3 | 同毫秒建板 id 碰撞；窗口坐标无 clamp；`/api/health` pid 可诱导 kill；录音 append 无上限；`!important` 103 处债务；文档 88/89、v1/v2、onView 漂移 | 见各成员报告 | 随机后缀、加 clamp、token 校验后再 kill、append 限额、audit 看守 |

## 三、放行条件（按交付形态）

| 形态 | 必须闭合 | 可带风险发布 |
|---|---|---|
| 正式对外装机版 | S1、S2、S3（导航/IPC）、S4、T1、T2、R1 + 装机 smoke | S5（同用户纵深）、S6（文档）、Q1（至少看板库） |
| 内部单机自用包 | S1、S2、S4、T1、T2 | S3 其余、S5、S6、Q1/Q2/Q3 |
| 纯源码 / dev | T1、T2 修后即可；S1/S2 需在发布说明写明 | 其余 |

**硬性附带**：发布说明必须写明「未签名 + SmartScreen 提示」「插件与 AI 生成代码=本机程序级权限」「`npm run audit` 不是漏洞扫描，依赖漏洞门禁当前不可用」。

## 四、框架优化三项（不重写，均可逆）

1. **wire 层契约测试**：新增 `tools/bridge-contract-smoke.cjs`，真 bridge 子进程 + 真 Chromium，表驱动覆盖 6 个看板工具的正常/非法/超时/假成功/dry_run 场景；把「函数级绿、边界红」这类缺陷变成 CI 可捕获。
2. **发布产物完整性链**：`release` 产出安装包与机器可读 manifest（版本、前端串、asar sha、exe 版本、安装包 sha、desktop-smoke 结果）；`verify-dist` 走 require/script 闭包；版本单一来源。
3. **持久化安全层**：boards/config/consent/desktop-config 统一 safeWrite/safeRead（配额预检、失败事件、损坏 `.bak`、原子 rename），并配故障注入单测。

## 五、需要拍板

1. **交付形态**：正式安装包 / 内部自用包 / 仅源码（直接决定 S3、Q1 是否阻断）。
2. **MCP 看板工具是否对外承诺**：是→T1 必修；否→从 TOOLS 与文档移除并标实验。
3. **插件热重载语义**：修成真热更新（推荐）还是改文档「改代码需重启」。
4. **DSH 默认模式**：是否保留 `agent + danger-full-access`（建议默认 answer，逐次确认）。
5. **密钥存储**：AI/TTS key 与 bridgeToken 是否迁 `safeStorage`（桌面）/ web 降级策略。

## 六、验证边界

- **已执行**：各成员的静态阅读与独立探针（bridge 黑盒、真 Chromium 生命周期、file:// 双击、内核回滚点、verify-dist 复跑、core-smoke 89 复跑）；主理人对 6 条关键结论的源码核对。
- **未执行**：真机安装/卸载、真串口、20ch@100Hz 长跑、升级/降级矩阵、干净 Windows 首启、桌面端到端 smoke；`npm audit` 在本环境不可用（registry 404）。
- **材料缺口**：0.27.0 安装包与 sha、装机 smoke 记录、长跑报告、上一版本基线与回滚说明、威胁模型/安全等级定义。

## 七、修复状态（0.28.0）

已修并纳入门禁：

- **S1 桥来源白名单**：`allowedOrigin` 改为精确来源（默认 8123），`XHGCS_ALLOWED_ORIGINS` 可配；health 只对白名单来源或非浏览器调用下发 token；`GET /api/state` 需 token；Electron 启动时把实际 webPort 传给桥。测试用 `*loopback*` 显式开洞。
- **S2 装机版禁复用**：`allowReuse: !app.isPackaged`；复用仍只用于开发。
- **T1 MCP 看板 wire**：ack 保存 `data`；看板 id 走 `boardId` 与 qid 分离；业务失败 / dry_run 预检失败返回 `ok:false`；dry_run 不再切换活动板。新增 `npm run test:bridge`（10 项）。
- **T2 插件生命周期**：保存真实模块引用，`deactivate()` 会执行；reload 删除旧 script 与全局注册，真正重新加载代码。smoke 增 2 项。
- **S4 存储型 XSS**：设计器属性标题改 textContent 组装；smoke 增「导入看板不执行节点 id」用例。
- **S5 /ext realpath**：目标路径 realpath 后再校验，junction/symlink 逃逸返回 403。
- **R1 发布链**：release 顺序改为 build → unit → bridge → smoke → regress → pack → verify；verify-dist 增加 require/入口闭包校验（16 项必备）；audit 增加 `CORE_VERSION == package.json.version`。

仍未修（下一批）：S3 Electron 导航/CSP/IPC sender 校验；Q1 持久化失败可见化与损坏备份；Q2 设计器 dirty；安装包（`npm run dist`）与装机 smoke；S6 信任模型文案。


## 八、修复状态（0.29.0）

在 0.28.0 基础上继续闭合：

- **S3 Electron 纵深**：所有 IPC 统一 `handleTrusted`（校验主框架 origin）；`will-navigate` / `will-redirect` 只允许应用自身 origin；权限/设备处理器绑定来源；注入 CSP `Report-Only`（老界面仍有内联脚本，直接强制会打穿首屏）；packaged 模式屏蔽 F12 / Ctrl+Shift+I 并关闭 DevTools。
- **Q1 持久化安全**：`writeJSON`/`persist`/`saveDoc` 返回结果，失败派发 `xhgcs:persist-failed` 并在设计器 toast；v2 看板库解析失败先写 `.bak` 再重建；补丁写盘失败返回 `ok:false`；`desktop-config.json` 改 tmp + rename 原子写；主状态配额压缩后仍失败会 toast。
- **Q2 设计器未保存**：关闭语义改为「关闭即保存」（与切换看板一致），`pagehide` 再兜一次；外部补丁重开走 `save:false`，避免把旧内容写回覆盖补丁。
- **S6 信任文案**：README 与授权块明示「插件代码以应用权限运行（不是沙箱），只安装/授权可信插件」。
- **交付产物**：`npm run dist` 产出 0.29.0 安装包与 portable，并首次跑通装机版桌面冒烟。

### 0.29.0 产物记录

| 文件 | 大小 | SHA256 |
|---|---|---|
| `dist/XiHe GCS PRO-0.29.0-x64.exe` | 103,282,998 B | `5DB46A67752DD155772BF7242C6B67DC029E47EB06A564AF4EED7D4339B147EC` |
| `dist/XiHe GCS PRO-0.29.0-portable.exe` | 103,026,936 B | `16CB31B9B37905837A1777535CDCAC71238DC63552A39DC01015DFB637ED2634` |

### 装机版桌面冒烟（首次）

用 `dist/win-unpacked/XiHe GCS PRO.exe --remote-debugging-port=9222` 启动打包产物，`node tools/desktop-smoke.js 9222` 实测：

```json
{ "desktopBridge": true, "desktopUi": true, "isDesktopClass": true,
  "mcpEnabled": true, "bridgeConnected": true, "serialSupported": true,
  "channelCount": 5, "scripts": 2, "engines": 5, "components": 5,
  "versions": { "electron": "44.3.0", "chrome": "152.0.7977.78", "node": "24.20.0" } }
ERRORS []
```

已知限制：该冒烟只证明「装出来的应用能启动、渲染层、桥连接、IPC 可用、控制台零报错」，**没有**覆盖真串口、断线重连、插件安装授权全链路与长跑。

### 仍需下一批

- `npm run dist` 已可用，但 `release` 尚未包含 dist（避免每次门禁都打安装包）；建议发布时手动 `npm run dist && node tools/verify-dist.cjs && npm run smoke`。
- 装机版真机手工 runbook（干净 Windows、真串口、插件安装/授权/停用、断线重连、长跑 20ch@100Hz）。
- `npm audit` 在本机 registry 不可用；发布链仍缺 SCA/SAST。
- `!important` 级联隔离仍是显式技术债（下次主题覆盖时优先降特异性，不要重写）。

