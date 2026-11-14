# Claude Code Adapter

先读 `AGENTS.md`。它是本仓库默认的工程事实源；本文件不复制架构或规则。

- GCS 数据链、MCP、AI、脚本与画布任务：按需读 `.codex/skills/xhgcs/SKILL.md`。
- 可视化视图插件、画风与自检：按需读 `.codex/skills/xhgcs-view/SKILL.md`。
- 历史 UI 回归、旧尺寸和排障过程：只在需要时搜索 `.codex/docs/engineering-history.md`，不要整篇读取。
- 交付前运行 `npm test`；涉及视图时再运行 `npm run check:view -- --all --json`。
- 修改 `assets/` 后按 `AGENTS.md` 的发布步骤升版本、打包并做桌面冒烟。

代码、测试输出和运行时行为高于任何记忆文件；若文档冲突，以代码和测试为准。
