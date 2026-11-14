# DSH headless 真实 stderr / stdout 抓包（0.1.5-rc.2）

这两个 `.log` 是**上游真实字节**，回归只读不改；格式若有变化改 fixture，不改解析器。

- 抓取命令：
  ```
  node <APPDATA>/npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "用三句话解释为什么天空是蓝色，并给出一个公式"
  ```
- DSH 版本：0.1.5-rc.2（`@deepseek-ai/dsh`）
- 抓取日期：2026-10-28
- exit code：0，耗时约 7.4s
- 文件：`dsh-headless-stderr-real.log`（1355 字节，21 个换行）、`dsh-headless-stdout-real.log`（最终正文）

## 关键事实（解析器必须按这个来）

- 首 16 字节 = `dsh: reasoning:\n`（`64 73 68 3a 20 72 65 61 73 6f 6e 69 6e 67 3a 0a`）：**只有首段带 `dsh: reasoning:` 前缀**；
- 之后**全是裸文本增量**：无 `dsh:` 前缀、通常无换行、含中文多字节字符与内部换行；
- 末尾补一个 `\n`；
- 因此解析必须是「进度态状态机」：进进度态后任何字节都算进度，直到出现新的 `dsh:` 结构化行（换行 + `dsh:` 或行首 `dsh:`）。

## 回放位置

- 单测（跨 chunk 切片、六种边界）：`tools/bridge-contract-smoke.cjs`（`npm run test:bridge`）里的 dsh-stderr 用例，按 7 字节切片回放本文件。
- 端到端（页面 + 桥）：`tools/regress.js` 的「DSH 后端：真实 headless 裸文本进度…」用例，`tests/fixtures/fake-dsh.cjs` 的 `stream-real` 模式分片回放本文件 + 对应 stdout。

## 脱敏

- 已脱敏扫描：`C:\\Users\\`、`APPDATA`、`sk-`、`token`、`Bearer ` 均无命中（内容是常识问答）。
- 长期规矩：fixture 入库前必须扫上述几类串，命中就替换成占位符并在本文件记录。