# ADR 0003 · 看板库 v2（多文档 + 迁移）

- 状态：已接受并实现（0.16.0）
- 关联：`src/designer/board-store.ts`

## 背景

0.15 的看板只有一份活动文档，存在 `xhgcs.ui.doc.v1`。要支持「搭多块看板」「AI 按 id 改板」
「MCP 列板/开板」，必须先有稳定的多文档存储与唯一写入口。

## 决定

1. **存储形态**：单 key `xhgcs.ui.boards.v2`
   ```json
   { "version": 2, "activeId": "ui...", "boards": [{ "id": "...", "name": "...", "updatedAt": 0, "doc": {} }] }
   ```
   上限 50 块（超过提示用户删除），doc 仍是 `xhgcs.ui` v2 文档，导出格式不变。
2. **唯一写入口**：`board-store.saveDoc / replaceActive / createBoard / switchTo / renameBoard /
   duplicateBoard / deleteBoard / importDoc`。设计器、AI 生成、看板运行、MCP 全部走这里；
   除 `board-store.ts` 外不允许出现对这两个 key 的写操作（audit 可查）。
3. **迁移**：首次加载时若没有 v2 且存在 v1：
   - 解析 v1 → 生成一块板；**v1 原样保留**，并另存 `xhgcs.ui.doc.v1.bak`；
   - 迁移幂等：v2 一旦存在就不再读 v1；
   - 首次无存档时生成一块带样板的「主看板」，避免空白画布。
4. **删除保护**：至少保留一块板；删掉活动板时自动切到第一块。
5. **导入语义**：导入 JSON = 新增一块板并切过去，**不覆盖**当前正在编辑的板。
6. **AI 生成语义**：`applyBoard` 覆盖**当前活动板**（用户说「做个看板」是替换，不是堆积）。

## 后果

- 旧版存档零丢失；用户升级后第一次打开设计器看到的是自己原来的看板。
- 后续 M2 的增量 patch、MCP `list_boards/get_board/open_board` 都有了稳定 id 锚点。
- 50 块上限目前是产品限制而非技术限制；需要更多时再拆成「索引 + 每板一个 key」。
