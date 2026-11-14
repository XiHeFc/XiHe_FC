# XiHe GCS PRO 0.22.0 · 组件与状态规格

- 交付对象：前端（`assets/css/styles.css` + `src/ui/*` + 注入式样式模块）
- 依据代码：`index.html`、`assets/css/styles.css`（5018 行）、`src/ui/{shell,view-container,pipeline-panel,extension-settings}.ts`、`src/designer/{designer,renderer,board}.ts`、`assets/js/{views-core,ai-ui,layout}.js`
- 设计基础：中文界面 / 深色液态玻璃 / 双 FX（`html[data-fx="glass"]` 默认、`html[data-fx="codex"]`）+ 双主题（`html[data-theme="light"]`）
- 目标：组件在 8 种状态下都有明确外观、全部色值来自令牌、WCAG AA 达标、键盘可用、动效可降级

---

## 0. 三条硬规矩

| 编号 | 规矩 | 判定方法 |
|---|---|---|
| **R1** | 组件样式里**只允许**出现 `var(--token)` 或 `rgba(var(--xxx-rgb), α)`；不允许出现 `#hex`、`rgb()` 字面量、命名色 | 对新增/改动行 `grep -E '#[0-9a-fA-F]{3,6}\|rgba?\([0-9]'`，命中即不通过 |
| **R2** | **视觉长相由类名决定，状态由属性决定**：`data-state`、`aria-selected`、`aria-pressed`、`:disabled`、`:focus-visible`、`.is-selected`。禁止再用 `.active` 兼表"选中"和"启用"两种语义 | 同一个类名不得同时承载"当前页签"和"开关已开" |
| **R3** | 尺寸只用 4px 基数的 `--r-* / --h-* / --ico-* / --gutter` 标度；动效只用 `--motion-*` + `--ease`。新增数值先落令牌，再引用 | 组件里出现 `transition: .13s`、`border-radius: 7px` 这类数字即需改令牌 |

> **R2 的现实依据**：现在 `.active` 同时被 `.tool`（当前视图）、`.sw-item`（当前图种）、`.plot-tab`（当前图页）、`.engine-preset`（当前协议）、`.theme-opt`（当前主题）、`.chl-tabs button`（当前页签）使用，语义各不相同；`.pipe-chip[data-on]`、`.sw-item.mini-active`、`.ai-round[aria-expanded]` 又各搞一套。本规格统一收口到第 3.0 节的状态语义层。

---

## 1. 令牌基线

### 1.1 已存在的令牌（真值）

来源：`assets/css/styles.css:1-39`（glass 深色）、`:2969-2972`（统一层）、`:3099-3126`（浅色）、`:3371-3427`（codex 深色/浅色）。

| 令牌 | glass 深色 | 浅色 | codex 深色 | 用途 |
|---|---|---|---|---|
| `--bg` | `#0d1117` | `#e8edf4` | `#0d1117` | 页面底 |
| `--bg2` | `#161b22` | `#f6f8fc` | `#151a21` | 面板/卡片底 |
| `--bg3` | `#1f2731` | `#dfe7f0` | `#1d232b` | 控件底/抬升面 |
| `--line` | `#2d333b` | `#c2cdda` | `#272e37` | 描边 |
| `--hairline` | `rgba(255,255,255,.075)` | `rgba(15,23,42,.09)` | `rgba(255,255,255,.07)` | 分区细线 |
| `--well` | `rgba(7,11,17,.42)` | `rgba(255,255,255,.52)` | `#090d13` | 凹槽（画布底） |
| `--text` | `#c9d4e0` | `#1d2733` | `#ccd4de` | 正文 |
| `--text-dim` | `#7d8896` | `#555f6b` | `#7b8794` | 次要文字 |
| `--acc` | `#6da8d2` | `#2c78b0` | `#4a9aec` | 强调（文字/描边） |
| `--acc-rgb` | `56,189,248` | `44,120,176` | `74,154,236` | 强调的**透明底**分量 |
| `--acc-text` | `#bfe7ff` | `#1c5b8c` | `#7cc0ff` | 选中态文字 |
| `--acc2` | `#63a98a` | `#2b8a64` | `#35a173` | 次要强调/在线态 |
| `--warn` | `#fbbf24`（`--k-amber-t`） | `#a26708` | `#fbbf24` | 预警 |
| `--danger` | `#f87171` | `#cc4747` | `#f87171` | 错误/危险 |
| `--heading` | `#e6f2ff` | `#1d2733` | `#e8edf3` | 标题/数值 |
| `--on-acc` | `#06222f` | **继承 `#06222f`（缺陷，见 C6）** | `#ffffff` | 强调底上的文字 |
| `--glass-bg / --glass-line / --glass-highlight` | `.68` 底 / `rgba(255,255,255,.12)` / `.16` | `.68` 白 / `rgba(15,23,42,.12)` | 纯色/`--line`/透明 | 玻璃材质 |
| `--k-green / -amber / -pink / -violet / -blue` | RGB 分量 | 同 | 同 | 语义色透明底 |
| `--k-green-t / -amber-t / -pink-t / -violet-t / -blue-t` | 文字色 | 加深版 | 同深色 | 语义色文字 |

**只有 codex FX 才有的令牌**（glass 下未定义，靠 `var(--x, 回退)` 兜底）：`--acc-solid`、`--acc-soft`、`--acc-line`、`--field`、`--hover`、`--hover-line`、`--shadow-modal`、`--shadow-pop`。

### 1.2 本次登记（0 个新色值）

下表每一行都指向**已有令牌**或**已有颜色的分量**，与仓库既有的 `--acc-rgb` / `--k-*` 同一口径。把这些写进 `:root` 后，注入式样式模块（`shell.ts` / `designer.ts` / `pipeline-panel.ts` / `extension-settings.ts`）里的 `var(--ok,#34d399)`、`var(--hover,rgba(255,255,255,.07))` 这类**双保险硬编码**才能删掉。

```css
/* ===== 语义别名：值全部派生自既有令牌 ===== */
:root {
  /* ① 补齐：--ok 目前全仓库未定义，导致 src/ui/*.ts 里的 var(--ok,#34d399) 永远走硬编码，
        浅色主题下 #34d399 落在 #f6f8fc 上仅 1.81:1 —— 这是真实缺陷，不是理论问题 */
  --ok: var(--k-green-t);
  --ok-soft: rgba(var(--k-green), .13);
  --warn-soft: rgba(var(--k-amber), .13);
  --danger-rgb: 248, 113, 113;          /* --danger #f87171 的分量登记 */
  --danger-soft: rgba(var(--danger-rgb), .12);

  /* ② 把 codex 独有的交互令牌提升为全局（glass 值 = 现有 var(x, fallback) 的 fallback） */
  --acc-soft: rgba(var(--acc-rgb), .14);
  --acc-line: rgba(var(--acc-rgb), .42);
  --acc-solid: var(--acc);
  --hover: var(--bg3);
  --hover-line: rgba(var(--acc-rgb), .45);
  --field: var(--bg3);

  /* ③ 圆角标度（现存值：3/5/6/7/9/12/14/16 → 收成 6 档） */
  --r-xs: 3px; --r-sm: 5px; --r-md: 9px; --r-lg: 12px; --r-xl: 14px; --r-pill: 999px;

  /* ④ 控件高度（现存 22/26/27/30/36/42） */
  --h-ctl-xs: 22px; --h-ctl-sm: 26px; --h-ctl-md: 30px; --h-ctl-lg: 36px; --h-row: 42px;

  /* ⑤ 图标尺寸（现存 14/16/17/18/20/22/24/28/30） */
  --ico-xs: 14px; --ico-sm: 16px; --ico-md: 20px; --ico-lg: 24px; --ico-xl: 28px;

  /* ⑥ 间距标度（4px 基数） */
  --gutter: 8px; --gutter-lg: 12px; --pad-card: 12px;

  /* ⑦ 动效（现存 .12s/.13s/.14s/.15s/.16s/.18s/.22s 全部收敛） */
  --motion-fast: 120ms;
  --motion: 160ms;
  --motion-slow: 220ms;
  --ease: cubic-bezier(.2, .7, .2, 1);
}
```

> 若目标 Chromium < 111，需要"令牌 + 任意透明度"时用 `rgba(var(--x-rgb), α)`；≥ 111 可改用 `color-mix(in srgb, var(--x) 14%, transparent)`，避免为每个颜色再登记一份 RGB 分量。

### 1.3 一条必须知道的既有不一致

`--acc: #6da8d2`（钢蓝）与 `--acc-rgb: 56,189,248`（天青 `#38bdf8`）在 **glass 深色下不是同一个颜色**（浅色 `44,120,176` 与 codex `74,154,236` 则各自与 `--acc` 一致）。因此：

- 实心强调色（`.btn.primary` 底、`.tool::before` 竖条、文字）= 钢蓝 `#6da8d2`
- 半透明强调底（`.tool.active`、`.sw-item.active`、`.dock-tab.active`、`.ai-pending`）= 天青淡罩

**规则**：底色一律用 `rgba(var(--acc-rgb), α)`，文字/描边一律用 `var(--acc)`；**不要**写 `rgba(var(--acc-rgb), 1)` 当实心强调色（会变成另一种蓝）。这条不改值，只约束用法——改值会波及全站 60+ 处透明底。

---

## 2. 关键组件清单

命名约定：`组-序号`。前缀 A=框架导航，B=设计器，C=AI，D=扩展，E=数据引擎，F=反馈。

### 2.1 框架导航组

| ID | 组件 | 根类名 | 用途 | 变体 | 所在界面 | 代码锚点 |
|---|---|---|---|---|---|---|
| A-01 | 活动栏项 | `.tool` | 一级视图切换（可视化/AI/后处理/引擎/串口/告警/模拟/设置） | 默认 / 当前视图 / 有角标 / 置底 | 最左 48px `side-toolbar` | `index.html:27-53`、`styles.css:152-200`、`:4505-4519` |
| A-02 | 图页标签 | `.plot-tab` | 一个窗口多张图，每页独立图种+通道清单 | 默认 / 当前页 / 可关闭 / 超过一页 | 中央图页 `plot-tabs` | `styles.css:310-366`、`views-core.js:501-517` |
| A-03 | 控件箱行 | `.sw-item` | 左栏"控件箱/视图"里的图种与自定义视图 | 默认 / 当前 / 次要激活(`mini-active`) / 带动作组 / 分组折叠 | 左栏 220px `ctrl-switch` | `index.html:65-81`、`styles.css:242-274`、`:4552-4562`、`:2867-2906`、`:3769-3809` |
| A-04 | 通道列表卡 | `.chl` | 右侧"多通道数据"的单通道读数与行内操作 | 默认 / 悬停 / 曲线已隐藏(`hidden-ch`) / 脚本通道 / Dock 紧凑 | 右侧 Dock → 数据页签 | `styles.css:786-807`、`:4698-4726`、`views-core.js:222-275` |
| A-05 | 波形工具条 | `.ctrl-head` + `.hbtn` | 绘图控制（标桩/网格/Y轴/缩放/回中/复位/暂停）+ 导出动作 | 普通 / 强调(`.acc`) / 危险(`.danger`) / 聚焦芯片 | 中央图页顶部 | `index.html:86-112`、`styles.css:284-308`、`:296-308`、`:4575-4581`、`:3751-3767` |
| A-06 | Dock 标签 | `.dock-tab` | 右侧工作区切页（数据 / AI）+ 收起 | 默认 / 当前 / 收起态竖排 | 右侧 Dock 顶部 38px | `index.html:161-169`、`styles.css:4599-4696`、`layout.js:80-105` |
| A-07 | 命令面板项 | `.xhgcs-palette-item` | 命令/扩展入口的可搜索列表行 | 默认 / 键盘光标(`data-active=1`) / 悬停 | `Ctrl+Shift+P` 浮层 | `src/ui/shell.ts:115-213`、`:34-43` |

### 2.2 设计器组

| ID | 组件 | 根类名 | 用途 | 变体 | 所在界面 | 代码锚点 |
|---|---|---|---|---|---|---|
| B-01 | 栅格单元 | `.dsg-cell` | 12 列栅格里的一块控件容器 | 默认 / 悬停 / 选中(`.is-selected`) / 预览只读(`data-interactive=0`) / 缺控件(`.dsg-missing`) / 看板态 | 可视化设计器、全屏看板 | `designer.ts:141-161`、`board.ts:35-48`、`renderer.ts:105-162` |
| B-02 | 控件头 | `.dsg-cell-head` | 拖动把手 + 控件名 + 删除 | 隐藏 / 悬停显现 / 选中着色 / 拖动中 | 同上 | `designer.ts:147-155` |
| B-03 | 属性行 | `.dsg-field` / `.dsg-grid-fields` / `.dsg-chrow` | 属性面板单行字段（文本/数字/下拉/勾选/通道勾选） | 单列 / 双列栅格 / 勾选行 / 只读 | 设计器右栏 286px | `designer.ts:164-186` |
| B-04 | 设计器按钮 | `.dsg-btn` | 保存/撤销/重做/预览/全屏 | 普通 / `data-primary=1` / `data-on=1` / 图标 / 禁用 | 设计器顶栏 | `designer.ts:105-115` |

### 2.3 AI 与扩展

| ID | 组件 | 根类名 | 用途 | 变体 | 所在界面 | 代码锚点 |
|---|---|---|---|---|---|---|
| C-01 | AI 确认卡片 | `.ai-pending` | 模型要落库的动作先摊开校验结果，等用户"应用" | 待确认 / 已应用 / 失败 / 已丢弃 / 校验未过 | AI 面板消息流内 | `ai-ui.js:282-327`、`styles.css:1750-1764` |
| D-01 | 扩展行 | `.xhgcs-ext` / `.xst-ext` | 扩展管理/扩展配置里的一条扩展 | 启用 / 已解析 / 已停用 / 降级 / 失败 / 待授权 | 扩展管理浮层、设置→扩展 | `shell.ts:244-327`、`:56-80`、`extension-settings.ts:47-62` |
| D-02 | 授权块 | `.xhgcs-consent` | 待授权扩展的权限逐条勾选 | 待授权 / 勾选 / 已授权（块消失） | 扩展管理浮层 | `shell.ts:270-298`、`:69-75` |

### 2.4 数据引擎与反馈

| ID | 组件 | 根类名 | 用途 | 变体 | 所在界面 | 代码锚点 |
|---|---|---|---|---|---|---|
| E-01 | 引擎阶段芯片 | `.pipe-chip` | 数据源/处理阶段/端点的启停开关 | 开(`data-on=1`) / 关(`data-on=0`) / 只读展示 | 数据引擎监视面板 | `pipeline-panel.ts:36-40`、`:165-224` |
| E-02 | 引擎参数行 | `.pipe-param-row` | 声明了 `params` 的阶段参数即时编辑 | 单字段 / 多字段换行 / 布尔 | 同上 | `pipeline-panel.ts:48-57`、`:262-304` |
| F-01 | Toast | `.toast` | 全局轻提示（当前仅一种样式、2.6s 自动消失） | **需补**：info / ok / warn / error / 带动作 | 全局右下 | `index.html:1241`、`styles.css:1548-1566`、`app-core.js:682-687` |
| F-02 | 空态 | `.chl-empty` / `.xhgcs-empty` / `.xst-empty` / `.pipe-empty` / `.ai-empty` / `.table-empty` / `.pm-empty` / `.dsg-empty-note` / `.serial-pick-empty` / `.board-empty` | 无数据占位 | 首次 / 无数据 / 被过滤光 / 出错 | 全站 | 见 4.2 逐条 |

### 2.5 按钮家族（横切，先收口再谈组件）

现状有 6 套按钮各自为政：`.hbtn`（工具条）、`.btn`（面板）、`.mini-btn`（行内）、`.sbtn`（分析页）、`.icon-btn`（弹窗关闭）、`.dsg-btn`（设计器）。差异只在尺寸与圆角，交互态本应一致。

| 家族 | 高度 | 内边距 | 字号 | 圆角 | 已有禁用态 |
|---|---|---|---|---|---|
| `.btn` | 30 | `7px 14px` | 12 | `--r-sm` 5 | ✅ `opacity:.45` |
| `.hbtn` | 26 | `4px 10px` | 12 | `--r-sm` 5 | ❌ **缺** |
| `.mini-btn` | 22 | `2px 8px` | 11 | `--r-sm` 5 | ✅ `opacity:.45` |
| `.icon-btn` | 30×30 | 0 | 14 | 5 | ❌ **缺** |
| `.dsg-btn` | 30 | `0 12px` | 12 | `--r-md` 9 | ✅ `opacity:.38` |

**决策**：保留 6 个类名（改动面太大），但**统一到一张状态表**（见 3.1），`--h-ctl-*` 与 `--r-sm` 作为共同来源。`.dsg-btn` 的圆角 `9` 是设计器玻璃外壳的透视延续，保留为特例并注明。

---

## 3. 状态矩阵

### 3.0 八态语义层（所有组件共用）

| 状态 | 触发（CSS / ARIA） | 通用视觉契约 | 备注 |
|---|---|---|---|
| 默认 | `data-state` 缺省 | 底 `--bg3`（可点）或透明（行内）；文字 `--text`；描边 `--line` | — |
| 悬停 | `:hover`（包在 `@media (hover:hover)`）+ `data-state="hover"` | 底 → `--hover`；描边 → `var(--acc-line)`；文字 → `--text` | 触屏不触发 |
| 聚焦 | `:focus-visible` | 双环：`0 0 0 2px var(--bg2), 0 0 0 4px var(--acc)` | 见 6.1，**不可**用半透明环 |
| 按下 | `:active` | `transform: translateY(1px)`；底色再深一档（`--field`）；**无**缩放 | 位移 ≤1px，禁止 `scale` |
| 选中 | `aria-selected="true"` / `aria-pressed="true"` / `.is-selected` | 底 `var(--acc-soft)`；描边 `var(--acc-line)`；文字 `var(--acc-text)`；左侧 2–3px 实心竖条（仅列表项） | 选中 ≠ 启用 |
| 禁用 | `:disabled` / `aria-disabled="true"` | `opacity:.45`；`cursor:not-allowed`；**不响应** hover 变色 | 非按钮元素去掉 tabindex |
| 加载 | `data-state="loading"` + `aria-busy="true"` | 内容降透明度 `.55`；末尾骨架条 or 3 点脉冲；`cursor:progress`；禁止重复提交 | 见 4.1 |
| 错误 | `data-state="error"` + `aria-invalid="true"` / `role="alert"` | 描边 `--danger`；底色 `var(--danger-soft)`；行首 2px `--danger` 竖条；错误文案 `--danger` 11px | 见 4.3 |

### 3.1 按钮家族共用状态表

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 底 `--bg3`；描边 `--line`；文字 `--text`；`transition: background-color/border-color/color var(--motion-fast) var(--ease)` | ✅ 6 套都有（材质不同） |
| 悬停 | 描边 `var(--acc)`；文字 `var(--acc)`；`.danger` 换成 `--danger` | ✅ |
| 聚焦 | 双环（见 6.1）。**文案类按钮不能只靠变色** | ⚠️ 只有全局 `box-shadow:0 0 0 2px rgba(var(--k-blue),.45)`，对比 2.39:1，不达标 |
| 按下 | `translateY(1px)`；底色 `--field` | ⚠️ 只有 `.dsg-btn` 有 |
| 选中/开 | `.btn.primary` / `.hbtn.acc` = 实心 `var(--acc)` + 文字 `var(--on-acc)`；`.dsg-btn[data-on=1]` = `--acc-soft` 底 + `--acc` 字 | ✅ |
| 禁用 | `opacity:.45` + `not-allowed`；`.acc/.primary` 禁用时退成普通按钮（`bg3` + `text-dim`），**不要**保留实心蓝 | ⚠️ `.btn/.mini-btn` 有，`.hbtn/.icon-btn` **缺** |
| 加载 | 原地把图标换成 16px 环形进度；文案保持；按钮宽度**不跳**（预留 `min-width`） | ❌ 全站无 |
| 错误 | 按钮本身不做错误态；错误由所在行/卡片承担（`aria-describedby` 指向错误文案） | ✅ 约定成文即可 |

```css
/* 立刻可抄：补齐 hbtn / icon-btn 的禁用与按下 */
:is(.hbtn, .icon-btn):disabled { opacity: .45; cursor: not-allowed; }
:is(.hbtn, .icon-btn):disabled:hover { border-color: var(--line); color: var(--text-dim); }
.hbtn.acc:disabled { background: var(--bg3); color: var(--text-dim); border-color: var(--line); }
:is(.hbtn, .btn, .mini-btn, .icon-btn, .dsg-btn):active:not(:disabled) { transform: translateY(1px); }
```

### 3.2 A-01 活动栏项 `.tool`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 40×40，圆角 `--r-sm`，透明底，图标 17px `--text-dim`，标签隐藏（宽度 <1100 时整栏 44px） | ✅ |
| 悬停 | 底 `--bg3`，图标 `--text` | ✅ |
| 聚焦 | 双环（内环用 `--bg2`，因栏底就是 `--bg2`） | ⚠️ 全局环 |
| 按下 | `translateY(1px)` | ❌ |
| 选中（当前视图） | 底 `var(--acc-soft)`；图标 `var(--acc)`；描边 `rgba(var(--acc-rgb),.35)`；左侧 3px 实心 `--acc` 竖条（`top/bottom:8px`，codex 2px/6px）；`aria-current="page"` | ⚠️ 视觉有，`aria-current` **缺** |
| 禁用 | `opacity:.45`（视图不可达时，例如浏览器版串口页） | ❌ 现在靠 JS 不渲染 |
| 加载 | 不适用（导航项不做加载） | — |
| 错误 | 角标态：`.badge` `--danger` 底 + 白字，`min-width:17px`、`top:1px right:1px`；数量 0 时隐藏 | ✅ |

### 3.3 A-02 图页标签 `.plot-tab`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 高 22，`padding:3px 6px 3px 9px`，圆角 `--r-sm`，描边 `--line`，文字 `--text-dim` 12px，通道数徽标 `.pt-count` 10px 底 `--bg3` | ✅ |
| 悬停 | 文字 `--text`；`.pt-close` 显现为 `--danger` 底 `--bg3` | ✅ |
| 聚焦 | 双环；单页时不显示关闭按钮，聚焦顺序为 `页签 → ＋` | ⚠️ 全局环；页签不可用方向键 |
| 按下 | `translateY(1px)` | ❌ |
| 选中（当前页） | 底 `var(--well)`；描边 `var(--acc)`；文字 `--text`；`.pt-count` 文字 `--acc`；`role="tab" aria-selected="true"` | ⚠️ 视觉有，语义**缺** |
| 禁用 | 仅剩一页时隐藏关闭按钮（`plots.length>1` 才渲染 `.pt-close`），而非禁用 | ✅ 逻辑正确，勿改成禁用样式 |
| 加载 | 页面数据尚未收到帧 → 标签内 `.pt-count` 显示 `–`（占位）而非 `0` | ❌ 现固定显示 0 |
| 错误 | 该页无可见通道且全站无数据时，标签右上角 4px `--warn` 点 + `title` 说明 | ❌ |

### 3.4 A-03 控件箱行 `.sw-item`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 最小高 42（`--h-row`），`padding:5px 7px`，圆角 `--r-sm`，透明底；`.sw-ico` 28×28 圆角 6，底 `--bg3`、图标 `--acc`；`.sw-t` 13px；`.sw-d` 11px `--text-dim` | ✅ |
| 悬停 | 底 `--bg3`；`.sw-actions`（编辑/删除，各 20×20）`opacity:.75` | ✅ |
| 聚焦 | 双环；行内动作组跟随显现（`:focus-within` 也要显现） | ❌ 缺 `:focus-within` |
| 按下 | `translateY(1px)`；拖动源时 `cursor:grabbing` | ⚠️ 只有 designer 的 `pal-item` 有 |
| 选中 | `.active`：底 `var(--acc-soft)`、描边 `var(--acc-line)`、`.sw-ico` 实心 `--acc` + `--on-acc`；`.mini-active`：底 `.07`、描边 `.42`、`.sw-ico` 内描边 | ✅（两个选中层级需在文档里写清：`.active`=当前图种，`.mini-active`=次要激活） |
| 禁用 | `opacity:.45`（例如依赖插件而插件已停用的视图） | ❌ |
| 加载 | 分组标题右侧计数徽标换成骨架条 | ❌ |
| 错误 | 视图插件编译失败：`.sw-d` 换成 `--danger` 文案「视图加载失败」，行首 `--danger` 竖条 2px | ❌ 现只有 tooltip |

### 3.5 A-04 通道列表卡 `.chl`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | Dock 紧凑态：圆角 `--r-sm`、`padding:5px 6px`、`margin-bottom:4px`、底 `var(--well)`；`.nm` 11px；`.dot` 8×8；`.chl-val` 12px 粗体 tabular-nums；`.mini-btn` 19×19 | ✅ |
| 悬停 | 底抬到 `--bg3`；`.mini-btn` 描边 `--line` → 显现 | ❌ **无 :hover**，卡片看起来不可交互 |
| 聚焦 | 卡片本身可聚焦（`tabindex="0"` + `role="button"`，双击=聚焦、Enter=打开配置），双环 | ❌ 无 `tabindex`，只能双击 |
| 按下 | `translateY(1px)`（仅当整卡可点时） | ❌ |
| 选中 | 单通道聚焦中：描边 `var(--acc)` + 左侧 2px 竖条；同时波形工具条出现 `.chart-focus-chip` | ⚠️ 有芯片，卡片无高亮 |
| 禁用（曲线隐藏） | `opacity:.48`；`.dot` 灰度；`.mini-btn.vis` 转成强调色（表示"可恢复"） | ✅ |
| 加载 | 数值位显示骨架条（宽 48×12），保留单位与量程 | ❌ 现在直接显示 0 |
| 错误 | 脚本通道执行失败：`.chl-val` 换成 `--danger` 的「—」，卡下 11px `--danger` 一行原因 | ❌ |

### 3.6 A-05 波形工具条 `.ctrl-head` + `.hbtn`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 条高 36（`--h-ctl-lg`），`padding:5px 10px`，底透明 + 底部 `--hairline`；`.head-label` 11px `--text-dim` 分隔组；按钮高 26 | ✅ |
| 悬停 | 按钮描边 `--acc`、文字 `--acc` | ✅ |
| 聚焦 | 双环；同组内 `Tab` 顺序 = DOM 顺序 | ⚠️ 全局环 |
| 按下 | `translateY(1px)` | ❌ |
| 选中/开关态 | 三态按钮（`btnStake` / `btnGrid` / `btnMapCruise`）用 `aria-pressed` + `--acc-soft` 底；播放键 `.hbtn.acc` 实心 | ⚠️ 现在靠改文案「网格：开/关」，**语义和视觉都缺** |
| 禁用 | 导出类在同视图无画布时禁用（表/仪表/地图视图下 PNG 不可用） | ❌ `.hbtn` 无禁用样式 |
| 加载 | 导出进行中：按钮文字换「导出中…」，按钮进入 loading 态，防重复点击 | ❌ |
| 错误 | 导出失败走 toast（错误变体），按钮回默认；**不在工具条内塞红框** | ❌ |

### 3.7 A-06 Dock 标签 `.dock-tab`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 高 27（`--h-ctl-sm`），`padding:0 9px`，圆角 `--r-sm`，透明底 + 透明描边，文字 11px `--text-dim`，前导图标 13px | ✅ |
| 悬停 | 底 `--bg2`；文字 `--text` | ✅ |
| 聚焦 | 双环（`role="tablist"` 内用 roving tabindex：只有选中项 `tabindex="0"`，方向键切换） | ⚠️ 全局环；方向键**缺** |
| 按下 | `translateY(1px)` | ❌ |
| 选中 | 底 `rgba(var(--acc-rgb),.1)`；描边 `rgba(var(--acc-rgb),.35)`；文字 `--acc`；`aria-selected="true"` | ✅ 三项齐全 |
| 禁用 | 收起状态下整条竖排（宽 38，标签宽 30、字号 0、只留图标），不可单独禁用 | ✅ |
| 加载 | AI 页签在生成中显示 6px `--acc` 呼吸点（对应 `.ai-status.streaming`） | ❌ |
| 错误 | AI 页签在出错时显示 6px `--danger` 点（对应 `.ai-status.error`） | ❌ |

### 3.8 A-07 命令面板项 `.xhgcs-palette-item`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | `padding:9px 11px`，圆角 `--r-md`，文字 13px `--text`；三段结构：分类胶囊（10.5px，`min-width:40px`，`--r-pill`）→ 名称（600）→ 命令 id（11px 等宽，右对齐，`--text-dim`） | ✅ |
| 悬停 | 等价于键盘光标态（`data-active=1`），不另设 hover 色 | ⚠️ 无 `:hover`，鼠标移入靠 JS `mouseenter` 改光标 |
| 聚焦 | 列表**不接收行级焦点**：焦点恒在搜索框，行态由 `aria-activedescendant` 表达 | ❌ 无 `aria-activedescendant`，读屏读不到当前行 |
| 按下 | `translateY(1px)` | ❌ |
| 选中（光标行） | 底 `rgba(var(--acc-rgb),.16)`（现硬编码 `109,168,210`）；描边 `rgba(var(--acc-rgb),.35)`；文字 `--heading`；左侧 2px `--acc` 竖条（`left:3px, top/bottom:9px`） | ✅ 视觉；❌ 色值未走令牌（codex FX 下蓝不跟随） |
| 禁用 | 命令 `when` 条件不满足时：`opacity:.45`，`aria-disabled="true"`，仍可读不可执行 | ❌ |
| 加载 | 命令执行中：行尾 id 换成 12px 环形进度，面板不关闭 | ❌ 现在点完立即关闭 |
| 错误 | 执行抛错：该行描边 `--danger` + 行下一行 11px `--danger` 文案（8 秒），面板保持打开 | ❌ 现 `executeCommand().catch(()=>undefined)` **静默吞错** |

### 3.9 B-01 栅格单元 `.dsg-cell` + B-02 控件头 `.dsg-cell-head`

| 状态 | `.dsg-cell` 规格 | `.dsg-cell-head` 规格 | 现状 |
|---|---|---|---|
| 默认 | 圆角 `--r-lg`，描边 `rgba(255,255,255,.075)`→ 走 `var(--hairline)`；竖向 flex | 高 22，`padding:0 8px`，10.5px，底 `rgba(255,255,255,.06)`，`opacity:0` | ✅ |
| 悬停 | 描边 `rgba(var(--acc-rgb),.42)`；`box-shadow:0 6px 22px rgba(0,0,0,.28)`；右下角 resize 手柄 `opacity:.9` | `opacity:1` | ✅ |
| 聚焦 | 单元可聚焦（`tabindex="0"`），双环；Tab 在格间移动，方向键在格间移动（栅格语义） | — | ❌ 全无 |
| 按下 | 拖拽中：单元 `opacity:.6`，光标 `grabbing`；`.dsg-ghost` 跟随指针（`rgba(var(--acc-rgb),.24)` 底 + `--acc` 描边） | `cursor:grabbing` | ⚠️ 有 ghost，单元无拖拽态样式 |
| 选中 | 描边 `var(--acc)` + `inset 0 0 0 1px var(--acc)` + `0 8px 28px rgba(0,0,0,.34)`；`aria-selected="true"` | 底 `rgba(var(--acc-rgb),.20)`，文字 `--acc` | ✅ |
| 禁用（预览态） | `data-interactive="0"`：`.dsg-cell-content{pointer-events:none}`，控件内容不可点但可见 | 头保持可见（用于拖动） | ✅ 机制在，缺 `cursor` 提示 |
| 加载 | 控件尚未拿到首帧：`.dsg-cell-content::after` 骨架块（`--r-sm`，高度 60%，居中 60% 宽） | — | ❌ |
| 错误 | 缺控件类型：`.dsg-missing`（`--warn` 12px 居中，`padding:12px`）；补齐方案：文字「未知控件 · {type}」+ `.dsg-cell` 描边 `--warn-soft` | — | ⚠️ 只有一段 warn 文字，无按钮、无 `role="alert"` |

> 看板态（`.board-canvas .dsg-cell`）差异：描边降到 `.055`、隐藏控件头与 resize 手柄、统计数值 `clamp(24px,7vh,58px)`。看板是只读展示，**不参与**交互状态矩阵。

### 3.10 B-03 属性行 `.dsg-field`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | `margin:0 0 12px`；标签 11px `--text-dim`、`margin-bottom:5px`；控件高 30（`--h-ctl-md`）、圆角 8、底 `rgba(255,255,255,.04)`、描边 `rgba(255,255,255,.10)`、12px | ✅ |
| 悬停 | 描边 `rgba(255,255,255,.18)` | ❌ |
| 聚焦 | 描边 `var(--acc)`、底 `rgba(var(--acc-rgb),.08)`、外环 `0 0 0 3px rgba(var(--acc-rgb),.14)`；标签同步变 `--text` | ✅ 输入框有；❌ 标签不变 |
| 按下 | — | — |
| 选中（勾选类） | `.dsg-chrow` 悬停底 `rgba(255,255,255,.05)`；勾选后行不额外着色（靠 checkbox 自带 `accent-color:var(--acc)`） | ✅ |
| 禁用/只读 | `opacity:.55`；`cursor:not-allowed`；只读通道勾选（脚本通道不可绑）行加 10.5px 说明 | ❌ |
| 加载 | 下拉数据未到时：`<select>` 显示「加载中…」并 `aria-busy` | ❌ |
| 错误 | 数值越界 / 命名重复：描边 `--danger`、外环 `var(--danger-soft)`、下方 10.5px `--danger` 一句话 + `aria-invalid` + `aria-describedby` | ❌ **完全没有校验反馈** |

### 3.11 C-01 AI 确认卡片 `.ai-pending`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认（待确认） | 外框：`margin-top:7px`、`padding:7px 8px`、圆角 `--r-sm`、描边 `rgba(var(--acc-rgb),.3)`、底 `rgba(var(--acc-rgb),.06)`；行标题 12px `--text`，明细 11px `--text-dim`；底部动作条 `gap:6px` | ✅ |
| 悬停 | 卡片整体不悬停变色（它是容器）；**按钮**悬停时描边 `rgba(var(--acc-rgb),.5)` | ✅ 按钮有 |
| 聚焦 | 三个按钮普通 Tab 序：应用 → 丢弃 → 本会话总是允许；双环 | ⚠️ 全局环，`ghost` 按钮的环被 `border:transparent` 吃掉一半 |
| 按下 | 按钮 `translateY(1px)` | ❌ |
| 选中（已应用） | 行 `border-left:2px solid var(--acc)` + `padding-left:6px`；结果行 11px `--text-dim`「已应用：…」 | ✅ |
| 禁用 | 提交中：三按钮 `opacity:.5`，`cursor:default`，`aria-busy` | ✅ `.ai-pending-btn:disabled` 有 |
| 加载 | 点「应用」后：动作条整条换成「正在应用 1/2…」+ 进度点，卡片不消失 | ❌ |
| 错误 | 行级 `.failed`（校验未过）+ `border-left:2px solid var(--danger)` + 明细转 `--danger`；已执行失败：`status="failed"` 行 + 「未执行：原因」 | ✅ 视觉齐全；❌ 缺 `role="alert"`，且失败行文字 `--danger` 落在 `rgba(acc,.06)` 底上对比未验（见 6.2） |

```html
<!-- 目标结构（供实现对照） -->
<div class="ai-pending" role="group" aria-label="待确认的 2 个动作">
  <div class="ai-pending-row failed" role="alert">
    <div class="ai-pending-title">新建脚本 · 均方根</div>
    <div class="ai-pending-detail" aria-describedby="…">inputs 为空，无法求 rms</div>
  </div>
  <div class="ai-pending-row applied"> … </div>
  <div class="ai-pending-bar">
    <button data-state="loading" aria-busy="true">应用</button>
    <button>丢弃</button>
    <button class="ghost">本次会话总是允许</button>
  </div>
</div>
```

### 3.12 D-01 扩展行 `.xhgcs-ext` / `.xst-ext` + D-02 授权块 `.xhgcs-consent`

**扩展行**

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | `padding:12px 4px`、`gap:12px`、底边 `rgba(255,255,255,.06)`（末行去掉）；标题 13.5px/600 + 状态胶囊；副行 id · v11.5px `--text-dim`；右侧动作组 `gap:6px`，按钮 11.5px/`4px 10px`/圆角 7 | ✅ |
| 悬停 | 整行底 `--hover`（12% 浅罩）；动作组按钮描边 `--acc` | ⚠️ 只有按钮有 |
| 聚焦 | 行内 Tab 序：动作按钮；双环 | ⚠️ 全局环 |
| 按下 | 按钮 `translateY(1px)` | ❌ |
| 选中（状态胶囊） | `data-s` 六态：`active` `--ok` / `resolved` `--acc` / `disabled` `--text-dim` / `degraded` `--warn` / `failed` `--danger` / `pending` `--warn`；胶囊 10.5px、`--r-pill`、`border:1px solid currentColor` | ✅（但 `--ok` 未定义 → 见 1.2 ①） |
| 禁用 | 停用行整体 `opacity:.7`；「停用」按钮改为「启用」 | ⚠️ 靠换按钮，行不发灰 |
| 加载 | 重载/授权过程中：动作组换成「重载中…」+ `aria-busy`，按钮禁用 | ❌ |
| 错误 | 失败行：失败原因 `.xhgcs-ext-msg`（11.5px `--warn`，等宽，`white-space:pre-wrap`）；**注意现状失败原因用 `--warn`**，`failed` 应改 `--danger`（现状靠胶囊颜色区分） | ⚠️ 缺 `role="alert"` |

**授权块（`.xhgcs-consent`）**

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | `margin-top:8px`、`padding:8px 10px`、圆角 `--r-md`、**虚线**描边 `rgba(251,191,36,.45)` → 用 `rgba(var(--k-amber),.45)`、底 `rgba(var(--k-amber),.07)`；每行 `11.5px` 等宽 + checkbox | ⚠️ 色值硬编码 `251,191,36` |
| 悬停 | 权限行文字 `--text`（默认已是 `--text`，靠 checkbox 反馈） | ⚠️ 无独立反馈 |
| 聚焦 | checkbox `:focus-visible` 需显式环（`accent-color` 不带焦点环） | ❌ |
| 按下 | 授权按钮底加深到 `rgba(var(--k-amber),.26)` | ✅ 有 hover |
| 选中（已勾选） | 走原生 checkbox + `accent-color`（`--acc`）；**高风险权限默认不勾**（`RISKY_PERMISSIONS`） | ✅ 逻辑正确 |
| 禁用 | 已被拒绝的权限：checkbox 禁用 + 行 `opacity:.45` + 10.5px 说明「需重装扩展后重试」 | ❌ |
| 加载 | 点「授权并启用」后按钮 → loading，checkbox 全禁用 | ❌ |
| 错误 | 授权失败：块底转 `var(--danger-soft)`、描边实线 `--danger`、末尾一行 `--danger` 原因 | ❌ |

### 3.13 E-01 引擎阶段芯片 `.pipe-chip`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认（`data-on=1` 开） | `padding:5px 11px`、`--r-pill`、描边 `--line`、底 `--bg3`、12px `--text`；前导 7px 圆点 `--acc` | ✅ |
| 悬停 | 描边 `var(--acc)`；文字 `--heading` | ❌ **无 :hover**（它是最像按钮的芯片却没有悬停反馈） |
| 聚焦 | 双环 | ❌ 全局环但对 pill 形状偏小 |
| 按下 | `translateY(1px)` | ❌ |
| 关闭（`data-on=0`） | `opacity:.5`；圆点 `--text-dim`；**再叠加** 11px 「已停用」文字可省（靠圆点+透明度即可） | ✅ |
| 禁用 | 阶段在运行但依赖未就绪：`opacity:.45`、`aria-disabled="true"`、`title` 说明原因 | ❌ |
| 加载 | 切换中：圆点换成 8px 旋转环，芯片保持宽度 | ❌ |
| 错误 | 该阶段最近报错：右侧追加 `--danger` 12px「!」+ `title` 原因 | ❌ 错误只在下方 `.pipe-err` 汇总 |

### 3.14 E-02 引擎参数行 `.pipe-param-row`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | `padding:9px 11px`、圆角 `--r-md`、描边 `rgba(255,255,255,.08)`、底 `rgba(255,255,255,.02)`；阶段名 11.5px `--acc`（`min-width:74px`）；字段 11px `--text-dim`；输入框 92×26、圆角 7、11.5px | ✅ |
| 悬停 | 描边 `rgba(255,255,255,.14)` | ❌ |
| 聚焦 | 输入框：描边 `--acc` + 外环 `0 0 0 2px rgba(var(--acc-rgb),.18)`；行不整体高亮 | ✅ |
| 按下 | — | — |
| 选中（布尔） | 原生 checkbox + `accent-color:var(--acc)` | ✅ |
| 禁用 | 阶段已停用：整行 `opacity:.55`，输入框 `disabled`，只读展示当前值 | ❌（现在停用阶段仍可改参数，改完才发现无效） |
| 加载 | 参数从 `state` 拉取中：输入框骨架 | ❌ |
| 错误 | `min/max` 越界：描边 `--danger`、`aria-invalid`、行尾 11px `--danger`「范围 0–20」 | ❌ **无校验**（`input.min/max` 只约束 spinner，手输不拦） |

### 3.15 F-01 Toast `.toast`

| 状态 | 规格 | 现状 |
|---|---|---|
| 默认 | 右下 18px，`max-width:340px`、`padding:10px 14px`、圆角 `--r-md`、12px、`box-shadow:0 10px 30px rgba(0,0,0,.35)` | ✅ 结构在 |
| 悬停 | 保持（`pointer-events:none`，刻意不响应） | ✅ |
| 聚焦 | 不适用（不可聚焦）；但必须 `role="status" aria-live="polite"` | ❌ **无 aria-live** |
| 按下 | — | — |
| 变体 | **需补 4 类**：`info`（默认，`--acc`）/ `ok`（`--ok`）/ `warn`（`--warn`）/ `error`（`--danger`）；描边与左侧 2px 竖条走对应语义令牌 | ❌ 只有一种 |
| 禁用 | — | — |
| 加载 | 不适用 | — |
| 错误 | `error` 变体：`role="alert" aria-live="assertive"`，停留 4000ms（默认 2600ms），可带「重试」按钮 | ❌ |
| 队列 | 同一时刻只显示一条；新消息**覆盖**旧消息并重置计时器（现状已如此） | ✅ |

```css
/* 立刻可抄：把写死的 #1b3541 / #d9f4ff 换成令牌派生 + 四变体 */
.toast {
  right: 18px; bottom: 18px; z-index: 80;
  max-width: 340px; padding: 10px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--acc-line);
  border-left: 2px solid var(--acc);
  background: var(--bg2);            /* 替代 #1b3541 */
  color: var(--text);                /* 替代 #d9f4ff */
  box-shadow: 0 10px 30px rgba(0,0,0,.35);
  font-size: 12px;
  opacity: 0; transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease), transform var(--motion-slow) var(--ease);
  pointer-events: none;
}
.toast.show { opacity: 1; transform: none; }
.toast[data-tone="ok"]    { border-color: var(--ok);     border-left-color: var(--ok);     background: var(--ok-soft); }
.toast[data-tone="warn"]  { border-color: var(--warn);   border-left-color: var(--warn);   background: var(--warn-soft); }
.toast[data-tone="error"] { border-color: var(--danger); border-left-color: var(--danger); background: var(--danger-soft); }
/* 浅色主题下 --bg2 是白，--text 已够对比；不要再给 toast 单独设色 */
/* 带动作按钮时（重试/撤销）必须把按钮的命中区放出来，否则整条 pointer-events:none 点不到 */
.toast > button { pointer-events: auto; }
```

> `app-core.js:682-687` 的 `toast()` 需扩成 `toast(message, { tone, action, duration })`；`XHGCS.toast` 对外保持单参数兼容。

---

## 4. 三态设计（加载 / 空白 / 错误）

### 4.1 加载态统一做法

全站目前**没有骨架屏、没有进度条**，只有"文字 + 圆点"（`.ai-status.streaming`、`AI 正在思考…`、`pipe-dot`）。按数据规模分三档：

| 档位 | 场景 | 做法 | 令牌 |
|---|---|---|---|
| **L1 就地骨架** | 已知条目数、单块内容（通道数值、属性行、参数输入、控件格） | 灰色块替换文字，保留原盒尺寸与行高；`--r-sm` 圆角 | 底 `color-mix(in srgb, var(--text-dim) 16%, transparent)` 或 `rgba(var(--acc-rgb),.10)` |
| **L2 列表骨架** | 条目数未知（通道列表首屏、命令面板搜索中、扩展列表） | 3 条占位行，宽度 100/72/86%，高 22/19/19 | 同上 |
| **L3 进度/文案** | 耗时不可预估（AI 生成、插件编译、导出、串口连接） | 单行文案 + 脉冲点 + 「取消」按钮；**不占位** | 文字 `--text-dim`；点 `--acc` |

```css
/* 骨架基类：L1/L2 共用，动效可降级（见 6.4） */
.sk {
  display: inline-block;
  border-radius: var(--r-sm);
  background: rgba(var(--acc-rgb), .10);
  background-size: 200% 100%;
  animation: sk-sweep 1.1s var(--ease) infinite;
}
.sk-line { height: 10px; }
.sk-num  { width: 48px; height: 12px; }
.sk-row  { width: 100%; height: 22px; }
@keyframes sk-sweep {
  from { background-position: 140% 0; }
  to   { background-position: -40% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; background: rgba(var(--acc-rgb), .10); }
}
```

**禁止**：加载中用"全屏遮罩 + 转圈"。这是地面站，波形和图页必须始终可见；加载只允许发生在**局部容器**内。

### 4.2 空白态（三分法，文案必须区分）

三种空白在语义上完全不同，**文案和按钮都必须不一样**：

| 类型 | 判定 | 结构 | 文案模板 | 按钮 |
|---|---|---|---|---|
| **首次空白（first-run）** | 从未有过数据/配置过 | 标题 + 一句对位说明 + **主操作** | 「还没有…」 | 主操作（实心 `--acc`） |
| **无数据（no data yet）** | 已配置，但源没在跑 | 标题 + 一句原因 + **去开源的按钮** | 「等待数据…」 | 主操作（去开启仿真/连接串口） |
| **被过滤光（filtered out）** | 有数据，但当前筛选/勾选看不到 | 标题 + 恢复提示 + **清空筛选** | 「当前视图没有可显示的…」 | 次要（描边按钮） |

现有实现对照：

| 位置 | 类名 | 现文案 | 现按钮 | 判定 |
|---|---|---|---|---|
| 通道列表（原始） | `.chl-empty` | 「**暂无通道** 用下方输入框新建一个通道。」 | 无（下方就是输入框） | ✅ 首次+无数据混写，可保留 |
| 通道列表（脚本） | `.chl-empty` | 「**脚本数据为空** 在画布工具条点「运行并附加」，或让 AI 生成脚本…」 | 无 | ✅ 首次 |
| 图页右键菜单 | `.pm-empty` | 「还没有任何通道」 | 无（有 tooltip） | ⚠️ 缺按钮 |
| 数据表 | `.table-empty` | 「暂无数据」 | 无 | ⚠️ 太干，需补一句原因 |
| 波形画布 | canvas 内绘字 | 「暂无数据 · 开启仿真或连接串口」/「无可见通道」 | 无（画布不可点） | ✅ **这就是三分法范例**，保持 |
| AI 消息流 | `.ai-empty` | 「已连接本地数据链，可以直接提问。」+ 数据链计数 + 「✎ 画一个视图」 | ✅ 有 | ✅ 全站最好的空态，作模板 |
| AI 任务列表 | `.ai-task-empty` | 一行说明 | 无 | ⚠️ |
| 命令面板 | `.xhgcs-empty` | 「没有匹配的命令」 | 无 | ⚠️ 属"被过滤光"，需「清空搜索」 |
| 扩展管理 | `.xhgcs-empty` | 「还没有发现任何扩展。把插件放进 plugins/ 目录后刷新即可。」 | 无 | ✅ 首次 |
| 扩展配置 | `.xst-empty` | 「没有扩展声明配置」 | 无 | ⚠️ 无数据，需补按钮 |
| 数据引擎监视 | `.pipe-empty` | 「没有注册任何数据源/阶段/端点」 | 无 | ⚠️ 开发者向文案，需改人话 |
| 设计器画布 | `.dsg-canvas[data-empty=1]::after` | 「从左侧拖入控件，或点一下直接添加」 | 无 | ✅ 首次 |
| 设计器属性面板 | `.dsg-empty-note` | 说明块 | 无 | ✅ |
| 全屏看板 | `.board-empty` | 居中一行 | 无 | ⚠️ |
| 串口选口面板 | `.serial-pick-empty` | 虚线框一行说明 | 无 | ✅ |
| 告警列表 | 内联 | 「暂无告警」/「还没有通道设阈值」 | 有（去阈值区） | ✅ **也是三分法范例**（区分了无数据 vs 未配置） |

**统一空态结构（新增 `.empty` 基类，逐个替换现有类名，保留旧类作为 modifier）**：

```html
<div class="empty" data-empty="first|nodata|filtered">
  <div class="empty-title">暂无通道</div>
  <p class="empty-desc">用下方输入框新建一个通道，或连接串口后应用一个数据引擎。</p>
  <button class="btn primary">新建通道</button>   <!-- filtered 时用 <button class="btn">清空筛选</button> -->
</div>
```

```css
.empty { padding: 18px 12px; text-align: center; color: var(--text-dim); font-size: 11px; line-height: 1.65; }
.empty-title { display: block; margin-bottom: 4px; color: var(--text); font-size: 12px; font-weight: 600; }
.empty-desc { margin: 0 0 10px; }
.empty .btn { font-size: 11px; }
.empty[data-empty="filtered"] { padding: 14px 12px; }
```

### 4.3 错误态（可重试 / 不可重试）

| 判定 | 视觉 | 文案模板 | 按钮 |
|---|---|---|---|
| **可重试**（网络、脚本执行、插件重载、导出、模型调用） | 描边 `--danger`、底 `var(--danger-soft)`、行首 2px `--danger`；`role="alert"` | 「{动作}失败：{原因}」+ 第二行 `11px` 建议 | 主：**重试**（描边）；次：**查看详情**（ghost，展开原始错误） |
| **不可重试**（权限缺失、协议不匹配、配置非法、依赖未安装） | 同上，但**无重试按钮**，改用图标 `⛔` + 原因 + 出口 | 「{对象}不可用：{原因}」 | 主：**去修复**（跳到相关设置）；次：关闭 |
| **降级**（`degraded`，能跑但不完整） | `--warn` 描边 + `var(--warn-soft)` 底；不加 `role="alert"` | 「{功能}已降级：{缺什么}」 | 无（或「了解详情」） |

**现状已有的错误呈现**（复用，不新造）：`.ai-msg.notice.error`（左竖条 `--danger` + `ai-notice-detail` + `ai-notice-retry` 文字链接）、`.serial-state.warn`、`.hint[data-match="none"]`、`.ai-task-item.error`。这四处的"原因 + 重试"是现成范式，错误态应统一到它们，而不是各写一套红框。

**三条禁用**：
1. 不用 `window.alert/confirm/prompt` 报错（现仓库仍有 `window.confirm` 在告警清空、图页重命名 `window.prompt`）→ 统一走命令面板式的应用内浮层。
2. 错误必须是**可复制文本**（`user-select:text`），地面站现场排障要能复制给同事。
3. 同一错误连续出现只提示一次，后续折算成计数「同一错误又发生 3 次」。

### 4.4 六个区域的三态落位

| 区域 | 加载 | 空白 | 错误 |
|---|---|---|---|
| 左栏控件箱 | 分组计数骨架 | 「还没有自定义视图」+「＋新建视图」 | 视图插件编译失败：行内红竖条 +「视图加载失败」+「重试」 |
| 中央图页（波形/表格/仪表/地图/插件） | 画布中央一行「正在等待首帧…」+ 3 点脉冲（不遮画布） | 画布内绘字（沿用现状）+ 工具条「回中」禁用 | 「图表绘制出错：{e.message}」+「复位视图」 |
| 右侧通道列表 | 3 条 L2 骨架行 | `.chl-empty` 三分法 | 脚本通道失败：卡片内一行红字 +「重跑」 |
| AI 面板 | 「AI 正在思考…」（现状）+ 停止按钮（现状 `ai-send.stopping`） | `.ai-empty`（现状，作模板） | `.ai-msg.notice.error` +「重试」（现状） |
| 设计器 | 单元骨架 / 保存中按钮 loading | 画布 `::after` 提示（现状） | 属性行校验、缺控件 `.dsg-missing` +「删除该控件」 |
| 数据引擎监视 | 采集卡数值骨架 | `.pipe-empty` 改人话 + 按钮 | `.pipe-err` 汇总（现状）+ 芯片「!」标记 |

---

## 5. 尺寸与间距

### 5.1 标度

| 类别 | 取值 | 令牌 |
|---|---|---|
| 字号 | 10 / 10.5 / 11 / 12 / 13 / 14 / 18 / 20 / 28 | 见 5.2（沿用现有，不再新增档位） |
| 行高 | 正文 1.55；紧凑行 1.35；标题 1.2 | — |
| 圆角 | 3 / 5 / 6 / 7 / 9 / 12 / 14 / 16 / 999 | `--r-xs … --r-pill` |
| 控件高 | 22 / 26 / 30 / 36 / 42 | `--h-ctl-xs … --h-row` |
| 图标 | 14 / 16 / 17 / 18 / 20 / 22 / 24 / 28 | `--ico-xs … --ico-xl` |
| 间距 | 2 / 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22 | `--gutter`(=8) 为基准 |

> **字号约束**：全站最小可读字号 = 11px（正文/说明）。10px 与 10.5px **只允许**出现在胶囊徽标（`.badge`、`.tag`、`.ai-task-type`）与图表刻度里。这是仓库里已经形成的规则（`styles.css:3001-3031` 专门抬过一遍字号），新组件必须遵守。

### 5.2 组件尺寸表

| 组件 | 高/行高 | 内边距 | 圆角 | 字号 | 图标 | 关键间距 |
|---|---|---|---|---|---|---|
| `.tool` | 40×40 | 0 | `--r-sm` | 10（隐藏） | 17 | 栏宽 48；栏内 `gap:3`、`padding:7px 0` |
| `.plot-tab` | 22 | `3px 6px 3px 9px` | `--r-sm` | 12（徽标 10） | — | 标签间 `gap:4`；条高 34 |
| `.plot-tab .pt-close` | 14×14 | 0 | `--r-xs` | 11 | — | — |
| `.plot-add` | 22×22 | 0 | 5 | 13 | — | — |
| `.sw-item` | 42（`--h-row`） | `5px 7px` | `--r-sm` | 13 / 副行 10（codex 11） | 28×28 | 行间 3 |
| `.chl`（Dock） | 内容 ~47 | `5px 6px` | `--r-sm` | 名 11 / 值 12 / 单位 9 | 点 8 | 卡间 4；列表 `padding:6` |
| `.chl .mini-btn` | 19×19 | 0 | `--r-sm` | 10 | — | 头部 `gap:5` |
| `.hbtn` | 26 | `4px 10px` | `--r-sm` | 12 | 14 | 按钮间 `gap:8`；条高 36 |
| `.dock-tab` | 27 | `0 9px` | `--r-sm` | 11 | 13 | 标签间 `gap:4`；条高 38 |
| `.dock-collapse` | 27×27 | 0 | `--r-sm` | 13 | — | — |
| `.xhgcs-palette-item` | 36 | `9px 11px` | `--r-md` | 13 / 分类 10.5 / id 11 | — | 行间 0；列表 `padding:8` |
| `.xhgcs-palette` 面板 | 宽 ≤660 | 搜索框 `0 16px` | `--r-xl` | 14 / 列表 13 | — | 搜索框高 50；列表 `max-height:52vh`、`padding:8` |
| `.dsg-cell-head` | 22 | `0 8px` | 上 12 | 10.5 | 11 | 手柄 18×18 |
| `.dsg-field` | 控件 30 | `0 9px` | 8 | 12 / 标签 11 | — | 行距 12；双列 `gap:8` |
| `.ai-pending` | — | `7px 8px` | `--r-sm` | 标题 12 / 明细 11 | — | 行间 6；动作 `gap:6` |
| `.xhgcs-ext` | — | `12px 4px` | — | 13.5 / 副 11.5 / 消息 11.5 | — | `gap:12`；动作 `gap:6` |
| `.xhgcs-chip` | — | `1px 7px` | `--r-pill` | 10.5 | — | — |
| `.xhgcs-consent` | — | `8px 10px` | `--r-md` | 11.5 | — | 行 `gap:6px 14px` |
| `.pipe-chip` | 27 | `5px 11px` | `--r-pill` | 12 | 点 7 | 芯片间 `gap:8` |
| `.pipe-param-row` | — | `9px 11px` | `--r-md` | 名 11.5 / 字段 11 / 输入 11.5 | — | `gap:8px 12px`；输入 92×26 |
| `.toast` | — | `10px 14px` | `--r-md` | 12 | — | 右下 18；`max-width:340` |
| 空态 `.empty` | — | `18px 12px` | — | 11 / 标题 12 | — | 标题→说明 4；说明→按钮 10 |

### 5.3 图标与命中区

- **视觉图标尺寸**：14（行内文字旁）/ 16（按钮内）/ 17（活动栏）/ 20（列表行前导）/ 24（面板标题）/ 28（控件箱图标块）。
- **命中区最小 28×28**；活动栏 `.tool` 已 40×40 达标。行内 19×19 的 `.mini-btn`（通道卡里的 ≋ ⚙ ✕）**视觉 19、命中 28**：

```css
.chl-head .mini-btn { position: relative; }
.chl-head .mini-btn::after { content: ""; position: absolute; inset: -5px; } /* 19 + 10 = 29 */
```

- **触屏/窄屏（<1180px）**：`.tool` 保持 40；`.mini-btn` 提升到 26×26（`--h-ctl-sm`）；`.hbtn` 保持 26（不要压到 24 以下）。
- 图标一律走 `currentColor`，**不用**彩色 SVG；颜色由父级 `color` 决定。

---

## 6. 可访问性

### 6.1 键盘焦点

**现状（`styles.css:3088-3096`）**

```css
button:focus, button:focus-visible, .collapse-btn:focus { outline: none; }
button:focus-visible, [tabindex]:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(var(--k-blue), .45); }
```

`rgba(109,168,210,.45)` 合成到 `--bg2 #161b22` 上是 `#3D5A71`，对背景对比 **2.39:1** —— 低于 WCAG 2.2 SC 1.4.11 / 2.4.13 要求的 3:1。codex FX 下又是另一套（`0 0 0 1px var(--acc)`），1px 对 2px 不一致。

**目标**：统一为**双环**，内环用所在面底色做"隔离带"，外环用实心 `--acc`（对 `--bg2` 对比 6.74:1，达标）：

```css
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-bg, var(--bg2)), 0 0 0 4px var(--acc);
}
/* 落在 --bg3 面上的控件（行内按钮、属性输入）把隔离带换成 --bg3 */
:is(.chl, .panel, .dsg-props, .pipe-param-row) :focus-visible { --focus-bg: var(--bg3); }
/* 输入框已自带 3px 光晕时，只保留外环，避免双圈 */
input:focus-visible, select:focus-visible, textarea:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--acc-rgb), .16);
  border-color: var(--acc);
}
/* 深色玻璃上不允许出现半透明焦点环 —— 一律实心 */
@media (prefers-contrast: more) {
  :focus-visible { box-shadow: 0 0 0 2px var(--bg2), 0 0 0 4px var(--heading) !important; }
}
```

**焦点顺序与陷阱**

| 场景 | 要求 | 现状 |
|---|---|---|
| 浮层（命令面板/扩展/设计器/看板/监视） | 打开时焦点进第一个可操作元素；关闭时**还给触发元素**；浮层内 `Tab` 循环 | ❌ 命令面板只 `input.focus()`，关闭后焦点丢到 body |
| 右侧 Dock `role="tablist"` | roving tabindex：仅当前页签 `tabindex=0`，`←/→` 切页签，`Home/End` 首末 | ❌ 三个都可 Tab |
| 图页标签 | 同上，另加 `Delete` 关闭当前页 | ❌ |
| 栅格设计器 | 单元 `tabindex=0`，`←/→/↑/↓` 移动选中，`Delete` 删控件 | ❌ 只能鼠标 |
| 拖拽（控件库→画布、看板） | 必须同时提供**非拖拽路径**：点击控件库项=追加到第一个空位（现状 `designer.ts` 已支持"点一下直接添加"✅） | ✅ |
| `Esc` | 逐层关闭浮层（现状 `app-core.js:246` 只关设置） | ⚠️ 只覆盖 settings |
| 全局单键（空格暂停） | 输入框内必须失效（现状已判断 `input/select/textarea` ✅） | ✅ |

### 6.2 对比度（实测）

正常文字要求 4.5:1，大字号（≥18.66px 粗体 / 24px）3:1，非文字（描边、图标、焦点环）3:1。

**深色 glass（达标的）**

| 前景 / 背景 | 比值 | 结论 |
|---|---|---|
| `--text` / `--bg` | 12.60 | ✅ |
| `--text` / `--bg2` | 11.51 | ✅ |
| `--text` / `--bg3` | 10.04 | ✅ |
| `--heading` / `--bg2` | 15.25 | ✅ |
| `--acc` / `--bg2` | 6.74 | ✅ |
| `--acc` / `--bg3` | 5.87 | ✅ |
| `--acc-text` / `--bg3` | 11.55 | ✅ |
| `--warn` / `--bg2` | 10.36 | ✅ |
| `--danger` / `--bg2` | 6.25 | ✅ |
| `--k-green-t` / `--bg2` | 9.00 | ✅ |
| `--on-acc` / `--acc`（实心主按钮） | 6.40 | ✅ |
| `--acc2` / `--bg2` | 6.24 | ✅ |
| `--acc` / `dock-tab.active` 合成底 `#223645` | 4.87 | ✅ 勉强 |
| `--acc` / `chl-tabs.active` 合成底 `#223A4B` | 4.61 | ✅ 勉强 |

**必须修的 6 处**

| # | 位置 | 现状 | 实测 | 修法 |
|---|---|---|---|---|
| **C1** | `--text-dim` 落在 `--bg3` 上（`.sw-d`、`.stat-card span`、`thead th` 旁、`.chl` 内次要字） | `#7d8896` / `#1f2731` | **4.19** ❌ | 令牌改 `--text-dim: #8b96a4`（→ 5.02）；浅色已是 5.20 ✅；codex 改 `#8b97a4`（→ 5.32，现 4.32 ❌） |
| **C2** | 选中/着罩底上的次要文字：`.sw-item.active .sw-d`、`.ai-pending-detail` | `#7d8896` / `#192B37`、`#20303D` | **4.05 / 3.76** ❌ | 规则：**着罩底内不使用 `--text-dim`**，改用 `var(--text)`（9.69 / 9.01 ✅）或新增 `--text-dim-strong: #939eac`（5.36 / 4.98 ✅） |
| **C3** | codex 主按钮：`.btn.primary` / `.hbtn.acc` 用 `--on-acc:#fff` 落在 `--acc:#4a9aec` | `#fff` / `#4a9aec` | **2.95** ❌❌ | codex 的实心底改用 `--acc-solid: #1f6feb`（白字 **4.63** ✅）；`--acc` 只用于文字与描边（在 `--bg2` 上 5.93 ✅） |
| **C4** | 浅色主题的语义文字色整体偏亮 | `--acc #2c78b0` / `--bg3` = 3.81；`--warn #a26708` = 4.41；`--danger #cc4747` = 4.33；`--k-green-t #14875c` = 4.25 | 全部 ❌（对 `--bg2`） | `--acc:#24699e`(5.50/4.69)、`--warn:#8f5a05`(5.44/4.63)、`--danger:#b93f3f`(5.14/4.38)、`--k-green-t:#0c6d49`(5.99/5.10)。**这是一次全局加深，需单独回归截图** |
| **C5** | 输入框占位符 `#5c6875` / 输入底 `#0F151C` | 硬编码 | **3.23** ❌ | 占位符改 `var(--text-dim)`（改后 5.02 ✅）。占位符也是文字，同样受 4.5:1 约束 |
| **C6** | 实心按钮文字：浅色 `.btn.primary`（`--on-acc` 未随主题改）、浅色 `.sbtn.run`、codex `.sbtn.run` | `#06222f`/`#2c78b0` = 3.46；`#06251a`/`#2b8a64` = 3.82；`#fff`/`#35a173` = 3.23 | 全部 ❌ | ① 浅色 `--on-acc: #ffffff`（4.75 ✅）、`--on-acc2: #ffffff` 且 `--acc2: #1f7a53`（5.29 ✅）；② **实心底一律用 `-solid` 令牌**（codex 已内置 `--acc-solid:#1f6feb` 白字 4.63 ✅、`--acc2-solid:#1f7a53` 白字 5.29 ✅），`--acc`/`--acc2` 只用于文字与描边 |

**另外两处连带缺陷**（由 C1/C3 派生）：

- `--ok` 未定义 → `src/ui/shell.ts` 的 `.xhgcs-chip[data-s="active"]`、`pipeline-panel.ts` 的 `.pipe-card[data-tone="ok"]`、`designer.ts` 的 `.dsg-stat-value[data-tone="ok"]` 在浅色主题下用的是 `#34d399`，对 `#f6f8fc` 只有 **1.81:1**（几乎不可读）。登记 `--ok: var(--k-green-t)` 后自动变成 `#0c6d49`（5.99 ✅）。
- 同类：`#fbbf24` 对白底 1.57、`#f87171` 白底 2.60、`#94a3b8` 白底 2.41 —— 这三处出现在 `styles.css:1506-1539` 的 AI 子任务样式里（`.ai-task-item.error`、`.ai-task-state`、`.ai-task-time`），必须换成 `var(--warn)` / `var(--danger)` / `var(--text-dim)`。

### 6.3 键盘契约

| 键 | 作用域 | 行为 |
|---|---|---|
| `Tab` / `Shift+Tab` | 全局 | 按 DOM 序；浮层内循环 |
| `←` `→` | `tablist`（Dock 标签、图页标签、设置导航、分析页签） | 切换页签，焦点跟随，`aria-selected` 同步 |
| `↑` `↓` | 命令面板、AI 菜单、图页右键菜单 | 移动光标项，`aria-activedescendant` 同步 |
| `Enter` | 任一 | 激活 / 执行 / 提交 |
| `Space` | 非输入框 | 暂停/继续采集（现状已实现 `app-core.js:252`） |
| `Esc` | 逐层 | 关闭最上层浮层；无浮层时清除聚焦通道 |
| `Delete` | 图页标签 / 设计器单元 | 关闭页 / 删除控件（需二次确认） |
| `Ctrl+S` | 全局 | 导出配置（现状） |
| `Ctrl+Shift+P` | 全局 | 命令面板 |
| `Ctrl+Shift+X` | 全局 | 扩展管理 |
| `Ctrl+Shift+D` | 全局 | 可视化设计器 |
| `Ctrl+Shift+B` | 全局 | 全屏看板 |
| `Ctrl+Shift+V` | 全局 | 视图插件 |
| `Ctrl+Shift+,` | 全局 | 扩展配置 |

> 快捷键注册表已存在（`src/core/index.ts:133-139` 的 `keybindings`），**新组件不要自己 `addEventListener('keydown')`**，走注册表；`shell.ts` / `board.ts` / `designer.ts` 里的 `Escape` 监听应改用统一的 `mountMask` 层级管理。

### 6.4 动效降级

现状只有一条 `@media (prefers-reduced-motion: reduce)`（`styles.css:2735-2747`），只覆盖了 `body::after` 背景漂移和 10 类按钮/条目的过渡。**遗漏的动效**：

| 动效 | 位置 | 降级做法 |
|---|---|---|
| `glass-drift 18s` 背景漂移 | `styles.css:70` | 已覆盖 ✅（`animation:none`） |
| `xhgcs-pop .14s` 命令面板弹入 | `shell.ts:26` | 改 `animation:none`，直接出现 |
| `dsg-fade .16s` 设计器淡入 | `designer.ts:87` | 同上 |
| `fadeIn .18s` 设置分区切换 | `styles.css:1421` | 同上 |
| `gn-dash .7s` 连线流动 | `styles.css:2836` | **未覆盖** → `stroke-dasharray:none` 或 `animation:none` |
| `gn-port-pulse 1.1s` 端口脉冲 | `styles.css:2859` | `animation:none`，保留静态高亮 |
| 按钮 `.45s` 背景扫光 | `styles.css:2705` | 已覆盖 ✅ |
| `.engine-preset:hover{translateY(-1px)}`、`.dsg-cell` 位移 | `styles.css:2577`、`designer.ts:144` | 位移改 `0`，只留颜色 |
| 骨架 `sk-sweep` | 本规格新增 | `animation:none`（静态灰块） |
| Toast 位移 | `styles.css:1563` | 只留 `opacity` |
| 波形/FX 动画 | canvas 侧 | 由 `state.reduceMotion` 传给绘制层，关闭插值与拖尾 |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
    scroll-behavior: auto !important;
  }
  /* 保留"状态改变"的即时反馈，只去掉过程动画 */
  .dsg-btn:active, .engine-preset:hover, .hbtn:active { transform: none !important; }
}
html[data-motion="off"] *, html[data-motion="off"] *::before { animation: none !important; transition: none !important; }
```

**再加一个运行时总闸**：`html[data-motion="off"]`，由设置页「减少动效」开关写入（比只依赖系统偏好更适合地面站投屏场景）。

### 6.5 ARIA 契约（逐组件）

| 组件 | 必需属性 | 现状 |
|---|---|---|
| A-01 活动栏项 | `role="tab"` 或 `<nav>` + `aria-current="page"`；角标 `aria-label="3 条未确认告警"` | ❌ |
| A-02 图页标签 | 容器 `role="tablist"`；页签 `role="tab" aria-selected`；面板 `role="tabpanel" aria-labelledby`；关闭钮 `aria-label="关闭「飞行姿态」页"` | ❌ |
| A-03 控件箱行 | 容器 `role="listbox"`、行 `role="option" aria-selected`；动作组 `aria-label`（现状有） | ⚠️ 半 |
| A-04 通道卡 | `role="group" aria-label="通道 电压"`；隐藏开关 `aria-pressed`；数值 `aria-live="off"`（高频刷新**不能**用 live） | ⚠️ 行内按钮有 label，其余缺 |
| A-05 波形工具条 | 开关类按钮 `aria-pressed`；分组 `role="group" aria-label="绘图控制"` | ❌ |
| A-06 Dock 标签 | `role="tablist"` + `role="tab" aria-selected` + `aria-controls`；收起钮 `aria-expanded`（现状 ✅） | ⚠️ 只缺 `aria-controls` 与 roving |
| A-07 命令面板项 | 列表 `role="listbox"`；行 `role="option" aria-selected`；输入框 `role="combobox" aria-expanded aria-activedescendant` | ❌ |
| B-01/02 设计器 | 画布 `role="grid"`、单元 `role="gridcell" aria-selected`、控件头 `aria-label="拖动「折线图」"`、删除钮 `aria-label`（有 `title`） | ❌ |
| B-03 属性行 | `<label for>` 或包裹（现状包裹 ✅）；错误 `aria-invalid` + `aria-describedby` | ❌ |
| C-01 AI 卡片 | 容器 `role="group"`；失败行 `role="alert"`；应用按钮 loading 时 `aria-busy` | ⚠️ 有 `disabled`，无 `alert` |
| D-01 扩展行 | 状态胶囊 `role="status"` 或纯文本；失败消息 `role="alert"` | ❌ |
| D-02 授权块 | `<fieldset><legend>需要以下权限</legend>`；高风险项说明 `aria-describedby` | ❌ |
| E-01 阶段芯片 | `aria-pressed` 取值 `true` / `false`（现状靠 `data-on`，读屏完全读不出开关） | ❌ |
| E-02 参数行 | 每个输入 `<label>` 关联（现状包裹 ✅）；越界 `aria-invalid` | ⚠️ |
| F-01 Toast | 容器 `role="status" aria-live="polite"`；错误用 `role="alert"` | ❌ |
| F-02 空态 | 纯文本即可；若因操作触发需 `aria-live="polite"` | ⚠️ |
| 全局 | 图表 canvas 需 `role="img" aria-label="波形图，5 条曲线"` + 数据表的 `<caption>` 作为等价文本 | ❌ |

---

## 7. 落地清单

### 7.1 改动顺序（按依赖，不可跳步）

| 步 | 内容 | 文件 | 验收 |
|---|---|---|---|
| 1 | 登记 1.2 令牌（语义别名 + 尺寸/动效） | `assets/css/styles.css` `:root` | 无视觉变化；`grep -- '--ok'` 有命中 |
| 2 | 修 6.2 的 C1/C2/C5（`--text-dim`、着罩底规则、占位符） | 同上 | 对比脚本全绿 |
| 3 | 统一焦点环（6.1），删除 `:3088-3096` 旧规则 | 同上 | Tab 走查 3 个视图 |
| 4 | 按钮家族补齐禁用/按下/加载（3.1） | 同上 | `.hbtn` 禁用可见 |
| 5 | `.toast` 换令牌 + 四变体；`toast()` 扩参 | `styles.css`、`assets/js/app-core.js` | 6 类场景各触发一次 |
| 6 | 空态 `.empty` 基类 + 逐处替换（4.2） | `styles.css` + 引用处 | 三分法文案不混用 |
| 7 | 注入式模块去硬编码：`shell.ts` / `designer.ts` / `pipeline-panel.ts` / `extension-settings.ts` | 各 `style.textContent` | codex FX 下强调色跟随 `--acc` |
| 8 | ARIA 补齐（6.5） | 同上 + `index.html` + `views-core.js` | axe 扫描 0 critical |
| 9 | 动效降级（6.4） | `styles.css` | 系统「减少动效」下无位移动画 |
| 10 | 浅色主题语义色加深（C4） | `styles.css:3099-3126` | 单独回归 4 张截图 |

### 7.2 硬编码色清理表（按文件）

| 位置 | 现值 | 改为 |
|---|---|---|
| `styles.css:1556,1558` `.toast` | `#1b3541` / `#d9f4ff` | `var(--bg2)` / `var(--text)` + 变体 |
| `styles.css:820,849` `.mini-btn` / `input` 底 | `#0d1117` | `var(--field)` |
| `styles.css:867` 占位符 | `#5c6875` | `var(--text-dim)` |
| `styles.css:890` `option` 底 | `#0d1117` | `var(--bg2)` |
| `styles.css:1506-1539` AI 任务色 | `#f87171` / `#94a3b8` / `#64748b` | `var(--danger)` / `var(--text-dim)` |
| `styles.css:2836,2859` 节点动画色 | 硬编码 stroke | `var(--acc)` |
| `styles.css:468` `.chart-tooltip` | `rgba(13,17,23,.94)` | `var(--bg2)` + `--glass-line` 描边 |
| `shell.ts:20,23,36,304-305` | `rgba(6,10,16,.52)`、`rgba(109,168,210,.16)`、`rgba(24,30,40,.99)` | `var(--bg)` 系 / `var(--acc-soft)` |
| `shell.ts:69-75` 授权块 | `rgba(251,191,36,…)`、`#ffe7b0` | `rgba(var(--k-amber),…)`、`var(--warn)` |
| `designer.ts:112-114` 主按钮 | `#7bb6de→#5b98c4`、`#04141f` | `var(--acc)` / `var(--on-acc)`（或 codex 用 `--acc-solid`） |
| `designer.ts:146,151,155,160` | `rgba(109,168,210,…)` | `var(--acc-soft)` / `var(--acc-line)` |
| `designer.ts:203` `.dsg-toast` | `rgba(20,26,34,.95)` / `#e8eef7` | `var(--bg2)` / `var(--text)` |
| `board.ts:28,49` | `rgba(20,26,34,.82)` | `var(--bg2)` |
| `pipeline-panel.ts:56` | `rgba(109,168,210,.18)` | `rgba(var(--acc-rgb),.18)` |
| `extension-settings.ts:25,38-40` | `rgba(109,168,210,…)` | `var(--acc-soft)` / `var(--acc-line)` |
| `ai-ui.js` 内联样式 | 颜色 | 移交 class，不在 JS 写色 |

> 上述 16 条清完后，`html[data-fx="codex"]` 下命令面板/设计器/引擎监视/扩展配置四块才能真正跟随强调色——**现在它们切到 codex 仍是玻璃蓝**，这是本规格发现的最大一致性缺口。

### 7.3 QA 检查表（每项必须截图留证）

1. [ ] 8 个视图 × 3 个组件（活动栏/图页标签/Dock 标签），Tab 走查无焦点丢失，焦点环在 `--bg` / `--bg2` / `--bg3` / `--acc` 实底上都可见
2. [ ] 命令面板：`Ctrl+Shift+P` 打开 → 输入过滤 → ↑↓ 移动（读屏能读出当前行）→ Enter 执行 → Esc 关闭且焦点回到触发元素
3. [ ] 命令面板空结果：「没有匹配的命令」+「清空搜索」按钮可点
4. [ ] 通道列表：0 通道（首次）、通道隐藏、脚本通道失败三种状态截图
5. [ ] 设计器：拖入 → 选中 → 属性改值 → 撤销 → 删除；全程键盘可完成一次
6. [ ] 属性行输入非法值（重名通道、越界倍率）出现红色描边 + 原因 + `aria-invalid`
7. [ ] AI 确认卡片：一条校验未过 + 一条可应用，同时存在时点击「应用」的 loading 与结果
8. [ ] 扩展面板：待授权（高风险默认不勾）→ 授权 → 状态胶囊变 active；停用 → 行发灰
9. [ ] 引擎监视：阶段芯片开/关可读屏，停用阶段参数行禁用
10. [ ] 系统开启「减少动效」+ `html[data-motion="off"]` 各走一遍，除颜色外无动画
11. [ ] 浅色主题 + codex FX 组合下，6 张关键界面截图对比度全绿
12. [ ] 200% 浏览器缩放：无横向滚动条、无文字截断（除已声明 ellipsis 的单行）

---

## 附录 A · 状态语义层速查

| `data-state` | 等价伪类/属性 | 底 | 描边 | 文字 | 其他 |
|---|---|---|---|---|---|
| （无） | — | `--bg3` / transparent | `--line` | `--text` | — |
| `hover` | `:hover` | `--hover` | `--acc-line` | `--text` | 仅 `@media (hover:hover)` |
| `focus` | `:focus-visible` | — | — | — | 双环 2px+2px |
| `active` | `:active` | `--field` | `--acc-line` | `--text` | `translateY(1px)` |
| `selected` | `aria-selected` / `aria-pressed` / `.is-selected` | `--acc-soft` | `--acc-line` | `--acc-text` | 左 2–3px `--acc` 竖条 |
| `disabled` | `:disabled` / `aria-disabled` | 不变 | `--line` | `--text-dim` | `opacity:.45` |
| `loading` | `aria-busy="true"` | 降低饱和 | `--line` | `--text-dim` | 骨架/进度 · `cursor:progress` |
| `error` | `aria-invalid` / `role="alert"` | `--danger-soft` | `--danger` | `--danger` | 左 2px `--danger` 竖条 |
| `warn` | 降级态 | `--warn-soft` | `--warn` | `--warn` | 不加 `role=alert` |
| `success` | 完成态（短时） | `--ok-soft` | `--ok` | `--ok` | 2s 后回默认 |

## 附录 B · 组件 × 界面索引

| 组件 | 可视化 | 串口 | 数据引擎 | 告警 | 模拟 | 后处理 | 设计器 | 看板 | 命令面板 | 扩展管理 | 扩展配置 | AI 面板 | 引擎监视 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-01 活动栏 | ● | ● | ● | ● | ● | ● | | | | | | | |
| A-02 图页标签 | ● | | | | | | | | | | | | |
| A-03 控件箱 | ● | | | | | | | | | | | | |
| A-04 通道卡 | ● | | | | | | | | | | | | |
| A-05 波形工具条 | ● | | | | | | | | | | | | |
| A-06 Dock 标签 | ● | | | | | | | | | | | | |
| A-07 面板项 | | | | | | | | | ● | | | | |
| B-01/02 栅格 | | | | | | | ● | ● | | | | | |
| B-03 属性行 | | | | | | | ● | | | | | | |
| C-01 AI 卡片 | | | | | | | | | | | | ● | |
| D-01 扩展行 | | | | | | | | | | ● | ● | | |
| D-02 授权块 | | | | | | | | | | ● | | | |
| E-01 阶段芯片 | | | | | | | | | | | | | ● |
| E-02 参数行 | | | | | | | | | | | | | ● |
| F-01 Toast | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| F-02 空态 | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |

---

**UI 设计师交付 · 组件与状态规格 v1.0**
依据代码版本：XiHe GCS PRO 0.22.0（`assets/css/styles.css?v=20261026M`）
实施状态：可交付开发；第 7.1 节 10 步按序执行
QA 协议：第 7.3 节 12 项，每项截图留证
