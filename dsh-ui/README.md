# dsh-ui — 内置 DSH Web 界面的可改副本

`dsh web` 发给浏览器的全部内容都在这里：页面 shell 和 55 个界面插件的客户端 bundle。
改这里的文件，应用启动「对话」页时会先覆盖到随包 DSH 的对应位置，再启动 `dsh web`。

- 来源：`vendor/dsh.zip` 里的 `@deepseek-ai/dsh@0.1.5-rc.2`
- 清单：`VERSION.json`（每个文件的 sha256；界面概览见下表）
- 重新提取：`node dsh-ui/sync-dsh-ui.cjs`（会覆盖本目录，先提交/备份你的修改）

## 目录

```
dsh-ui/
  frontend/                 ← dsh-web-frontend/dist 原样拷贝
    index.html              ← 页面骨架（可加 <link>/<script>，注释也行）
    assets/index-*.css      ← shell 级样式
    assets/index-*.js       ← shell 入口（React 外壳，压缩过）
    assets/vendor-*.css/js  ← 第三方样式/库
    assets/fonts|langs/     ← 字体、语言包
  plugins/<包名>/client.js  ← 每个界面插件的完整客户端代码（组件 + CSS 字符串）
```

## 主要插件对应关系

| 包 | 管什么 |
| --- | --- |
| `dsh-client-ui-theme` | **颜色/明暗 token（`--dsw-*` 变量都在这里定义）**、「外观」设置行 |
| `dsh-client-ui-brand-official` | 品牌字样/标识 |
| `dsh-client-ui-layout` | 整体框架（左中右三栏） |
| `dsh-client-ui-sidebar` / `sidebar-right` / `sidebar-files` / `sidebar-documentpreview` | 左/右侧栏、文件与预览 |
| `dsh-client-ui-chat` / `conversation` / `input-trigger` / `commands` | 对话流、消息气泡、输入框、斜杠命令 |
| `dsh-client-ui-tool` / `approval` / `user-questions` / `plan` | 工具调用卡片、审批、提问、计划 |
| `dsh-client-ui-model-selection` / `agent-preset` / `permission-presets` | 模型、Agent、权限选择 |
| `dsh-client-ui-settings*` | 设置页各分栏 |
| `dsh-client-ui-workspace` / `workspace-*` | 工作区选择与文件面板 |
| `dsh-client-ui-attachment` / `directory-picker-*` | 附件、目录选择 |
| `dsh-client-ui-jobs` / `schedule` / `goal` / `skill` / `subagent` / `workflow-run` | 任务、定时、目标、技能、子代理、工作流 |
| `api-*` / `client-connection` / `client-modules` | 通信与模块加载（一般不需要动） |

每个 `client.js` 的结构：`window.__ModuleLoader__.load({ id, factory })`，里面是打包过的 React 组件和
以字符串形式注入的 CSS（`<style data-plugin=...>`）。要改外观，优先在 CSS 字符串里找类名，
或者改 `dsh-client-ui-theme` 里的 token——token 改了所有插件一起生效。

## 生效方式

`electron/ai/dsh-web.js` 在启动 DSH 前调用 `electron/ai/dsh-ui-overlay.js`：

1. `dsh-ui/frontend/**` → 随包 DSH 的 `dsh-web-frontend/dist/**`
2. `dsh-ui/plugins/<包>/client.js` → 随包 DSH 的 `<包>/lib/client.js`
3. 用目录内容的签名做戳记（`<DSH 包目录>/.xuanji-ui-overlay.json`），没改动就跳过

所以：**改完文件，重开应用（或重启 DSH 面板）才生效**，DSH 只在启动时读取这些文件。
开发环境如果设了 `XHGCS_DSH_BIN` 指向 `vendor/dsh`，覆盖会直接写进 vendor 树；
`sync-dsh-ui.cjs` 始终从 `vendor/dsh.zip` 重新提取，不受影响。

打包后 `dsh-ui/` 通过 `extraResources` 放到 `resources/dsh-ui`，主进程优先读那里。

## 注意

- `sync-dsh-ui.cjs` 会先删掉 `frontend/`、`plugins/` 再重写，**会覆盖你的改动**。同步前先备份或提交。
- `assets/` 里的文件名带构建 hash；改文件名的话，`index.html` 里的引用要一起改。
  更省事的做法是新增自己的 `assets/xuanji.css`，在 `index.html` 里追加一行 `<link rel="stylesheet" href="./assets/xuanji.css">`——
  DSH 的静态服务会按扩展名给 MIME，无需改索引。
- `client.js` 是压缩过的构建产物，改 CSS 字符串或小段逻辑可行；大改结构建议包一层自己的样式
  （新增 CSS + 少量 DOM 选择器），比直接改压缩代码好维护。
