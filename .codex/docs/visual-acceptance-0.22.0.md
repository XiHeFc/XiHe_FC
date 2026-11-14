# XiHe GCS PRO 0.22.0 视觉验收标准

> **适用**：package.json `0.22.0`；样式锚点 `assets/css/styles.css`（2026-10-22 修订，5018 行）；结构锚点 `index.html`（1265 行）与 `src/**` 注入样式（构建进 `assets/js/core.bundle.js`）。
> **读者**：开发自检（提交前）、验收（发布前）、评审（新增界面/改样式时）。
> **总原则**：所有判据以**浏览器 computed 值**为准，不以源码字面为准。本仓库存在成组的"后定义覆盖前定义"（§1.10），只看源码会得出相反结论。

## 判定口径

| 档位 | 含义 |
|---|---|
| **PASS** | 全部条目满足 |
| **CONDITIONAL** | 只有 P2 级问题且已登记豁免（附录 B） |
| **BLOCK** | 出现任意一票否决项（§6），或 P1 ≥ 1 |

严重度：**P0** 不可读/不可操作/数据被遮挡；**P1** 违反基线且跨屏可见；**P2** 单点不一致。

证据标注：**【源码】** 读自文件；**【实测】** 从 `logs/shots/*.png` 像素测量或按 CSS 计算；**【推算】** 由令牌与对比度公式计算，需上机复核。

---

## 0. 结论摘要

### 0.1 现状：**BLOCK**（发布前必须处理）

| # | 问题 | 证据 | 级别 | 章节 |
|---|---|---|---|---|
| 1 | 浅色主题下命令面板文字对比度 **1.12:1**（深底 + 深字），面板整体不可读 | `.xhgcs-palette` 背景硬编码 `rgba(24,30,40,.99)`（src/ui/shell.ts:23），文字 `var(--heading)` 浅色下为 `#202733` | P0 | §3.6 |
| 2 | `src/**` 全部界面**没有任何 `data-theme` / `data-fx` 分支**（0 命中），浅色主题与 codex FX 下均沿用玻璃深色材质 | src 全目录检索 `data-theme|data-fx|prefers-color-scheme` = 0 | P0 | §2.5 |
| 3 | 4 个令牌名在 `styles.css` **从未定义**：`--ok` / `--accent` / `--fg` / `--fg-2`；其中 `--ok` 回退值 `#34d399` 在浅色底上对比度 **1.81:1** | styles.css 定义检索 = 0；src/ui/shell.ts:63、src/core/statusbar.ts:19-23 | P1 | §2.3 |
| 4 | codex FX 覆盖清单只列旧类名（22 个），7 组新界面全部漏覆盖 → 切 FX 后圆角/模糊/投影/渐变仍是玻璃值 | styles.css:3440、3653 的 `:is(...)` 列表 vs `.xhgcs-* / .xst-* / .vc-* / .pipe-* / .dsg-* / .board-*` | P1 | §2.4 |
| 5 | 左右两条标题分隔线错位 **1px**（实测左栏底线 y=82，右栏 Dock tab 底线 y=83） | `logs/shots/main.png` 列扫描 | P1 | §3.1/§3.3 |
| 6 | 状态覆盖缺口：全仓库 **0** 个 loading/skeleton/spinner 类，**0** 个 `aria-busy`/`aria-live`；空态有 **7 套互不相同的实现**（`.empty`/`.xhgcs-empty`/`.xst-empty`/`.vc-empty`/`.board-empty`/`.pipe-empty`/`.dsg-empty-note`），语义相同实现各异 | styles.css + src 检索 | P1 | §4 |

### 0.2 通过与不通过的边界（一句话版）

> 一屏之内：字号只从 10 档里取；同一水平基准的分割线偏差必须为 0px；文字对背景对比度 ≥ 4.5:1（大字号 ≥ 3:1）、非文字控件与聚焦环 ≥ 3:1；颜色一律 `var(--*)`；加载/空白/错误/禁用/聚焦环五态齐全；三种视口与三档缩放下不重叠、不裁切、不掉字。

---

## 1. 视觉基线

### 1.1 字号阶梯

**规范档位（仅此 10 档）**：`10 / 11 / 12 / 13 / 14 / 16 / 18 / 20 / 25 / 30`

| 档位 | 用途 | 允许范围 | 备注 |
|---|---|---|---|
| 10 | 胶囊/角标/canvas 刻度（≤4 字符）、canvas 桩标 | 仅限上述场景 | 项目已在 styles.css:3001 把 9px 抬到 11px，10px 是"可读下限的例外" |
| 11 | 辅助说明、时间戳、单位、表头 | 11（不得出现 10.5 / 11.5） | 正文最小可读字号 |
| 12 | 控件正文、列表次要文本、输入框 | 12 | |
| 13 | 主文本、按钮、列表主标题 | 12–13.5，规范 13 | |
| 14 | 面板标题 h3、搜索框 | 14 | |
| 16 | 页标题、品牌（codex 16；玻璃为 19px，需归并） | 15–16.5 | |
| 18 | h2、弹窗标题、通道值 | 18–19 | |
| 20 | 看板数值卡、数据大字 | 20 | |
| 25 | 结果主数值 | 25 | |
| 30 | 看板 KPI 大数字 | 30 | |

**判定方法**（任一不满足即不通过）：

```js
// DevTools 控制台：列出全页不在档位内的字号
const OK = new Set([10,11,12,13,14,16,18,20,25,30]);
[...document.querySelectorAll('*')].map(el => {
  const fs = parseFloat(getComputedStyle(el).fontSize);
  return (el.childElementCount === 0 && el.textContent.trim()) ? {el, fs} : null;
}).filter(x => x && !OK.has(x.fs))
 .forEach(x => console.log(x.fs + 'px', x.el.className || x.el.tagName));
```

**当前存量（P1，需归并）**
- CSS 侧非档位值：`8px×2、9px×13、15px×1、17px×4、19px×2、21px×1、23px×1`【源码】
- TS 侧另成一档：`10.5 / 11.5 / 12.5 / 13.5` 共 4 个半像素字号（src/ui/*、src/designer/*）【源码】——两套字阶并存本身就是不一致
- 归并规则：8→10，9→11，10.5→11，15→14，17→16 或 18，19→20，21→20，23→25，12.5→12 或 13，11.5→11 或 12

### 1.2 行高

| 场景 | 取值 | 允许范围 |
|---|---|---|
| 正文（11–14px） | 1.5 | 1.45–1.6 |
| 单行控件（按钮/输入/标签） | 1（配合 flex 居中或固定高） | 1 或 line-height = 控件高 |
| 代码/等宽块 | 1.55 | 1.5–1.6 |
| 大数字（20–30） | 1.1 | 1.05–1.2 |

**不通过**：正文 `line-height < 1.35` 或 `> 1.75`；同一列表内相邻项行高之差 > 2px。
**判定**：`getComputedStyle(el).lineHeight / parseFloat(getComputedStyle(el).fontSize)`。
**当前**：`1.5×9、1.6×8、1.45×6、1.55×6、1×5、1.4×2、1.7×2、1.05/1.15/1.35/1.65 各 1`【源码】——1.4 与 1.7 需要逐条确认是否落在正文。

### 1.3 间距节奏

以 **2px 网格**为基线，分三档：

| 档 | 取值 | 适用 |
|---|---|---|
| 结构档 | 4 / 8 / 12 / 16 / 20 / 24 | 分区内边距、卡片间距、表单栅格 |
| 紧凑档 | 2 / 6 / 10 / 14 / 18 | 工具条、行内元素、标签组 |
| 行内档 | 1 / 3 / 5 / 7 / 9 | 仅用于高度 ≤ 40px 的元素内边距 |

**判定**：
1. 任何 `padding/margin/gap` 若为奇数且 > 1，元素高度必须 ≤ 40px，否则不通过；
2. 同一容器内四边 padding 与 gap 必须同档（跨档需登记豁免）；
3. 相邻两级容器的间距差 < 2px 视为"没有层级"，不通过（视觉上会糊成一片）。

**当前**：`gap` 分布 `8×41、6×29、7×28、5×21、4×19、10×18、12×12、9×9、3×7、2×7、14×6、16×2`【源码】。7/9 出现在 `.chl`、`.sw-item`、`.ctrl-head`、`.dock-tabs` 等既有紧凑区，**列入附录 B 豁免**；新增代码不得再引入奇数结构间距。

### 1.4 圆角

**目标档位**：`4 / 6 / 8 / 14` + `999px`（胶囊）+ `50%`（圆形）。
**双 FX 映射表**（两套都必须成立）：

| 元素 | glass | codex | 判据 |
|---|---|---|---|
| 标签/胶囊 | 4 / 999 | 4 | 高度 ≤ 24px |
| 按钮、输入、tab | 5–6 | 4–6 | 高度 24–36px |
| 卡片（.chl / 通道卡 / 看板 widget） | 7 | 6 | |
| 面板 / 弹窗内区块 | 8–10 | 8 | |
| 弹窗外壳 | 14 | 8 | |
| 圆形按钮/圆点 | 50% | 50% | 宽高相等 |

**判定**：
1. 单屏圆角取值种数（不含胶囊/圆）≤ 4，且随面积单调递增；
2. 嵌套圆角满足 `子圆角 = 父圆角 − 父内边距`，偏差 > 2px 不通过（当前 `.chart-wrap` 14 − padding 8 = 6，但内部 `.chart-workbench` 用了独立值，需逐项核）；
3. 出现 `11px / 13px / 99px / 2px / 3px` 一律不通过（99 应为 999，2/3 在 100% 缩放下会被抗锯齿吃掉一半）。

**当前存量（P1）**：CSS 侧 13 种圆角值（`2,3,4,5,6,7,8,9,10,11,12,13,14` + `99,999,50%`）【源码】；`src` 另加 `16px`（设计器外壳）、`14px`（画布）、`12px`（cell）、`9px`（按钮/输入）【源码】。设计器单屏内同时出现 16/14/12/10/9/8/6/5 共 8 种 → 不通过。

### 1.5 描边

| 项 | 规定 |
|---|---|
| DOM 边框宽度 | 恒为 `1px`；**禁止** `2px`（选中态用 1px + `box-shadow: 0 0 0 1px` 叠环） |
| 常规分隔线 | `var(--line)`；发丝线 `var(--hairline)`（深色 `rgba(255,255,255,.075)`，浅色 `rgba(15,23,42,.09)`） |
| 强调边框 | `var(--acc-line)`；状态边框用 `--danger/--warn` 的 40% 透明度变体 |
| SVG 连线 | 1.6 常态 / 2.4 hover / 2.8 selected（codex 已定义，styles.css:3625、3660-3661） |
| 虚线 | 仅用于"可放置区域"（`.dsg-canvas` 1px dashed），颜色 ≤ 8% 白 |

**判定**：`getComputedStyle(el).borderWidth`；DPR 1.25/1.5 下 1px 边框必须仍是 1 物理像素（见 §5.4）。
**当前**：`.graph-node` 用 `box-shadow: 0 0 0 1px` 叠环 ✓；`.dsg-cell` 用 1px ✓；未见 2px DOM 边框 ✓。

### 1.6 阴影

**三档，不得自创**：

| 档 | 值 | 用途 |
|---|---|---|
| `--shadow-well` | inset 高光/凹槽（`inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 0 1px rgba(255,255,255,.05)`） | 图表凹槽、代码块、well |
| `--shadow-pop` | `0 8px 22px rgba(0,0,0,.38)` | 浮层、节点、tooltip |
| `--shadow-modal` | `0 18px 46px rgba(0,0,0,.5)` | 弹窗、抽屉 |

**判定**：
1. 同一视口内**外投影参数种类 ≤ 3**；超出即不通过；
2. 任何外投影的 `blur` 必须落在 22±2 或 46±4，`y` 落在 8±2 或 18±2；
3. codex FX 下面板/卡片一律 `box-shadow: none`（styles.css:3446 已规定）；
4. 玻璃 FX 允许叠加 inset 高光，但**不允许用 `filter: drop-shadow` 代替 box-shadow**。

**当前存量（P1）**：CSS 侧统计到 **15 种**不同的非 `none` 外投影（如 `0 8px 22px / 0 10px 28px / 0 14px 30px / 0 24px 70px / 0 32px 80px / 0 40px 110px`），`src` 侧另有 4 种弹窗投影（`0 24px 64px / 0 28px 70px / 0 32px 80px / 0 40px 110px`）【源码】→ 不通过。

### 1.7 动效

| 场景 | 时长 | 缓动 |
|---|---|---|
| hover / active / 焦点 | 120–160ms | `ease` 或 `cubic-bezier(.2,0,.2,1)` |
| 展开 / 弹窗 / 切换 | 180–240ms | `ease-out` |
| 数值/布局变化 | 150–200ms | `ease` |
| 持续动画 | 见白名单 | — |

**持续动画白名单（仅 3 个）**：
- `glass-drift` 18s（玻璃光斑漂移，`body::after`）
- `gn-dash` .7s（连线流动，SVG）
- `gn-port-pulse` 1.1s（端口脉冲）

**判定**：
1. 交互反馈 `transition-duration > 300ms` → 不通过；
2. `animation-iteration-count: infinite` 的动画不在白名单 → 不通过；
3. 白名单动画在 `prefers-reduced-motion: reduce` 下必须全部停止——**当前 reduce 块（styles.css:2735-2747）只关了 `body::after` 与 10 类控件的 transition，`gn-dash` / `gn-port-pulse` 以及 `.toast` 的 `fadeIn` 都未关 → 不通过**；
4. 缓动只允许 `ease / ease-out / cubic-bezier(...)`；`linear` 仅限动线类动画。

**当前**：`transition` 共 16 种组合（`.12s/.14s/.15s/.16s/.18s/.2s/.22s/.45s` + 2 条属性级），全部 `ease`，**`cubic-bezier` 使用 0 次**，无统一 duration 令牌【源码】。

### 1.8 层级（z-index）

**现状：两套互不相干的栈**【源码】

| 栈 | 值 |
|---|---|
| 老 CSS | 0/1/2/3/5/9/30/45/50/70/80（tooltip 70、modal-overlay 50、toast 80、plot-menu 45） |
| TS 注入 | 9620（视图容器）/9650（扩展配置）/9680（引擎）/9700（设计器）/9760（看板）/9800（拖拽幽灵）/9900（设计器 toast）/99999（内核 toast） |

**必须满足**：
1. 语义唯一：**同一语义只允许一个实现**。当前 toast 有 4 套（`.toast` z=80 bg `#1b3541` r9 / `runtime.ts` z=99999 r10 / `.dsg-toast` z=9900 r9 / 看板底部提示 z=2）→ 不通过；
2. 遮蔽关系必须可推导：`toast > modal(9760) > designer(9700) > pipeline(9680) > config(9650) > views(9620) > 应用主界面`。老 `.toast` 的 z=80 **低于所有新弹窗**，在看板/设计器打开时会被盖住 → 不通过；
3. 新增层级必须落在上表，禁止再引入 9700–9999 之间的新值。

**判定**：打开看板 → 在设计器内触发一次保存提示 → 提示必须可见；用 `document.elementFromPoint(提示中心)` 断言命中提示自身。

### 1.9 本屏基准几何（1600×900，100%，codex dark）

以下为**实测/推算的验收基准**，偏差 > 1px 即不通过：

| 区域 | 值 | 来源 |
|---|---|---|
| 顶栏高 | 46px（含 1px 底边） | 【实测】边框行 y=45 |
| 活动栏宽 | 48px | 【实测】边框列 x=47 |
| 活动栏工具 | 40×40，gap 3，padding 7px 0，圆角 6 | 【源码】styles.css:4505-4519 |
| 左栏（控件箱）宽 | 220px（可拖 190–320） | 【源码】4532 / layout.js:36 |
| 左栏标题条高 | 36px（实测底线 y=82） | 【源码】4576 |
| 图页 tab 条高 | ≥34px | 【源码】4583 |
| 图表卡片 | margin 10/12/0，padding 8/10/4，圆角 14 | 【源码】3051-3058 |
| 分隔拖拽柄 | 4px | 【源码】4566 |
| 右栏 Dock 宽 | 280px（可拖 220–420） | 【源码】4590 / layout.js:35 |
| Dock tab 条高 | 38px（实测底线 y=83） | 【源码】4600 |
| Dock tab 高 | 27px | 【源码】4609 |
| 串口面板高 | 90–360，默认 150 | layout.js:38 |

### 1.10 已知覆盖冲突（必须知情，否则会改错地方）

`styles.css` 中同一组件存在两套定义，**后者生效**：

| 组件 | 前定义 | 后定义（生效） |
|---|---|---|
| 活动栏 | 56px / 工具 44px / 圆角 9 / 显示文字（L141-184） | 48px / 40px / 圆角 6 / 隐藏文字（L4505-4519） |
| 标题条 | 统一 38px（L2979） | ctrl-head 36px（L4576），dock-tabs 仍 38px（L4600） |
| 图表卡片 | padding 12/14、无 margin（L~460） | margin 10/12/0 + padding 8/10/4 + 圆角 14（L3051） |
| 拖拽柄 | 5px / margin -2px（L~470） | 4px / margin 0（L4566） |
| 通道面板 | 250px（L~200） | 100%（`.workspace-dock .channels`） |
| 圆角 | 玻璃值（多处） | codex `:is(...)` 覆盖（L3653-3655） |

**判定**：任何"按源码值验收"的行为都不通过；必须以 computed 值为准，并在改动时确认改的是生效那一条。

---

## 2. 令牌纪律

### 2.1 必须走 `var(--*)` 的 6 类值

1. **所有颜色**（含透明度变体）→ `--bg/--bg2/--bg3/--line/--hairline/--well/--text/--text-dim/--acc/--acc-rgb/--acc-text/--heading/--on-acc/--danger/--warn/--c1..--c6/--k-*`
2. **语义强调色** → `--acc-solid / --acc-soft / --acc-line`（不要手写 `rgba(109,168,210,.14)`）
3. **阴影** → `--shadow-pop / --shadow-modal`（玻璃材质用 `--glass-highlight`）
4. **圆角** → 4/6/8/14 档位（建议补 `--radius-sm|md|lg|xl`）
5. **动效时长/缓动** → 建议补 `--dur-fast|base|slow`，`--ease-out`
6. **画布颜色**（插件/图表）→ `ctx.theme()` 或从 computed style 读令牌

### 2.2 硬编码的四级判定（全部 = 不通过）

| 级别 | 定义 | 例子 | 为什么必须拦 |
|---|---|---|---|
| **A 强调色** | 手写品牌色/强调色 | `border-color:#6da8d2`（styles.css:2061/2369/2410） | 浅色与 codex 下强调色不同，选中态颜色错 |
| **B 中性色** | 手写背景/分隔色 | `background:#0d1117`、`#27313c`、`#0b1118` | 等价令牌已存在，主题切换失效 |
| **C 状态色** | 手写语义色 | `#f87171`、`#34d399`、`#fca5a5` | 语义色令牌已存在（`--danger/--c2/--k-green-t`） |
| **D 一次性色** | 不在调色板里的自造色 | `#64748b`（AI 任务时间）、`#94a3b8`（pending 左边线） | 无令牌可依，深/浅底对比度失控（3.67:1 / 2.41:1） |

**唯一豁免**：令牌定义块内部（`:root`、`html[data-theme="light"]`、`html[data-fx="codex"]`、`html[data-fx="codex"][data-theme="light"]`）。

**"魔法数字"判定**：以下任一命中即不通过
- 间距/圆角/字号不在 §1 档位内且无令牌；
- 一次性 `z-index`（同屏出现 2 个以上非档位值）；
- `width/height` 写死且与响应式冲突（如弹窗写死 `820px` 而非 `min(820px,92vw)`）；
- `!important` 用于覆盖本可用选择器特异性解决的冲突（当前 `!important` 集中在宽屏降级，见 §5.3）。

### 2.3 令牌完整性：引用必须可解析

**规则**：任何 `var(--x)` 必须满足二者之一——(a) 在 `:root`、`html[data-fx="codex"]`、`html[data-theme="light"]` 中都有定义；(b) 带 fallback 且该 fallback 本身是令牌或调色板内色值。

**当前缺口**【源码】

| 令牌 | 定义位置 | glass 下状态 | 引用处 |
|---|---|---|---|
| `--field` `--hover` `--hover-line` `--acc-solid` `--acc-soft` `--acc-line` `--shadow-pop` `--shadow-modal` | **仅** codex 块 | 未定义 | 老 CSS 多数带 fallback；`styles.css:2303`（`.insp-code-head .dots i`）**无 fallback** → 玻璃下三个窗口圆点变透明 |
| `--ok` | **0 处定义** | 全主题未定义 | src/ui/shell.ts:63、extension-settings.ts:54、pipeline-panel.ts:22/33 |
| `--accent` `--fg` `--fg-2` | **0 处定义** | 全主题未定义 | src/core/statusbar.ts:19-23/34-41 |

**判定脚本**（放进 `tools/audit.cjs` 作为第 7 项）：

```js
// 抽出所有 var(--x) 引用与所有 --x: 定义，输出「未定义且无 fallback」
const defs = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const bad = [];
for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
  if (!defs.has(m[1]) && !m[2]) bad.push(m[1] + ' @ ' + css.slice(0, m.index).split('\n').length);
}
```

### 2.4 双 FX 等价覆盖

**规则**：任何新表面类（有 `background / backdrop-filter / box-shadow / border-radius / background-image / color` 的规则）必须同时出现在：
- (a) 玻璃默认规则；
- (b) codex 覆盖清单（styles.css:3440 的 `:is(...)` 或 3653 的圆角清单）。

**当前缺口（P1）**：codex 覆盖清单只含老类名（`.topbar/.panel/.modal/.chl/...` 共 22 个），**完全不含**以下新界面：

```
.xhgcs-mask / .xhgcs-palette / .xhgcs-panel / .xhgcs-ext / .xhgcs-chip / .xhgcs-consent
.xst-shell / .xst-nav / .xst-row / .xst-chip
.vc-shell / .vc-nav / .vc-stage
.pipe-shell / .pipe-card / .pipe-chip
.dsg-shell / .dsg-palette / .dsg-canvas / .dsg-cell / .dsg-props
.board-mask / .board-canvas / .board-head
.xhgcs-sb（状态栏）
```

后果（可复现）：切到 codex 后，这些界面仍是 `backdrop-filter: blur()` + 14/16px 圆角 + 大投影 + 白色渐变描边，与周围扁平界面割裂。

**判定**：脚本对上述前缀逐一断言——若类名出现在 `backdrop-filter|box-shadow|border-radius` 规则中，但不在 codex 覆盖清单 → 输出违规清单。

### 2.5 TS 注入样式（`src/**`）的额外约束

`src/**` 通过 `<style>` 注入（构建进 core.bundle.js），与 `styles.css` **共用同一个 DOM**，但：

1. **0 个主题分支**：`src` 全目录没有 `data-theme` / `data-fx` / `prefers-color-scheme`【源码】。所有硬编码深色材质在浅色主题下原样保留 → 必须补 `html[data-theme="light"] .xst-*` 一类覆盖，或改为只用令牌；
2. **回退值不是令牌**：`var(--text-dim,#7d8896)` 这类 fallback 直接把玻璃深色的颜色值固化了。规定：**fallback 只允许写调色板内令牌已定义的值，且必须与 `:root` 一致**；
3. **玻璃材质不许在 TS 里重造**：`background:linear-gradient(180deg,rgba(24,30,40,.99),rgba(15,20,27,.99))` 必须换成 `var(--bg2)` + `var(--glass-*)`；
4. **字号/圆角/阴影同样受 §1 约束**（当前 TS 侧引入 10.5/11.5/12.5/13.5px 与 16px 圆角，属新增不合规值）。

### 2.6 当前存量统计（基线数字，整改后必须下降）

| 指标 | 当前 | 目标 |
|---|---|---|
| 令牌块外硬编码 hex | **72 处**（含 1 处注释） | 0 |
| rgba 字面量行 | **155 行** | 玻璃材质收敛到 `--glass-*`/`--hairline`/`--well` 三令牌，其余 0 |
| 未定义令牌引用 | 4 个（`--ok/--accent/--fg/--fg-2`）+ 1 处无 fallback（`--hover-line`） | 0 |
| 未覆盖 codex 的界面组 | 7 组 | 0 |
| 非档位字号 | CSS 13 处 + TS 4 个半像素档 | 0 |
| 外投影参数种类 | 15 | ≤3/屏 |

---

## 3. 逐屏验收清单

> 每屏三问：**必须对齐**（同一基准线/同一列宽）、**必须不重叠**（间距 ≥ 阈值）、**必须可见**（对比度/裁切/遮挡）。
> 判定统一用 `getBoundingClientRect()` 或截图像素扫描，阈值写死，不接受"看起来还行"。

### 3.1 活动栏（顶部条 + 左侧栏）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 顶栏高 46px（含 1px 底边）；活动栏宽 48px；工具 40×40 水平居中偏差 ≤0.5px | 截图像素扫描 + `getBoundingClientRect` | ✅ 实测一致 |
| 对齐 | 活动项指示条：宽 2–3px，上下内缩 6–8px，左缘贴活动栏边缘 0–1px | 元素伪元素 computed | ✅ codex 2px/6px（L3487） |
| 对齐 | 工具图标 17px；AI 项 18px 为刻意强调（L4518），需在设计稿上确认为意图而非漂移 | 截图 | ⚠️ 待确认 |
| 不重叠 | 品牌区 / 菜单 / 右侧状态簇三段间距 ≥ 14px | `gap` computed（16/14） | ✅ |
| 不重叠 | 右侧状态簇在桌面版必须让出窗口控制区：`padding-right = calc(100vw - titlebar-area-width + 14px)`，无 `titlebar-area` 时回退 138px 安全区 | 桌面版 1600 宽下右侧 138px 内不得有可点元素 | ✅ 已有实现（L96-99），需实测确认 |
| 可见 | 角标 `.badge` 17px 高，露出面积 ≥ 直径的 80%，不被父元素裁切 | 与父元素 rect 求交 | ✅ |
| 可见 | 工具 hover 对比：`--text-dim` → `--text`，且背景差 ≥ ΔE 3 | 截图对比 | ✅ |
| 可见 | 活动栏按钮必须有 focus-visible 环（§4） | Tab 遍历 | ⚠️ 全局环 2.43:1（§4.3） |

### 3.2 波形区（中央图页 + 波形）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 左栏 220px；标题条 36px；图页 tab 条 ≥34px；三者左缘对齐偏差 0px | 截图列扫描 | ⚠️ 标题条 36 与 Dock 的 38 错位（见 3.3） |
| 对齐 | 图表卡片：左右 margin 12、上 10、圆角 14；四角圆角与父容器同心（差 ≤1px） | 截图 | ✅ |
| 对齐 | X 轴刻度文字与网格线中心偏差 ≤0.5px；Y 轴刻度右对齐，右缘距画布左边 ≥4px | 截图 | 需复核 |
| 不重叠 | 画布内数值桩标：两两间距 ≥2px；距画布右边界 ≥8px；不得压住最右数据点 | 像素扫描 | ❌ **视图容器内实测标签右缘 x≈1338，容器右边界 x=1339 → 安全边距 0–1px，存在截断**（`logs/shots/views.png`） |
| 不重叠 | 桩标与十字准线/tooltip 不得同时占用同一 8px 区域 | 交互态截图 | 需补测 |
| 不重叠 | tooltip：`min 150 / max 280` 宽，出屏时自动翻转，距鼠标 12±2px | 四角各悬停一次 | 需补测 |
| 可见 | 画布位图宽 = `round(CSS 宽 × DPR)`，1/1.25/1.5 下无模糊（1px 网格线过渡 ≤1 像素列） | 见 §5.4 | ✅ 走 `ensureCanvas`（views-util.js:16-29） |
| 可见 | 空数据时不得只留空白画布：需在画布内给出占位提示 | 清空全部通道 | ⚠️ `.chart-foot` 有"等待数据"，但画布内部无占位 |
| 可见 | 同一通道在波形/通道卡/看板/视图容器**四处颜色一致** | 取四处 computed 颜色比对 | 需复核（颜色取自 `--c1..--c6`，插件可能自造） |
| 可见 | 图表缩放控件（滚轮/拖拽/复位）提示常驻可见，11px | `.chart-foot` | ✅ |

### 3.3 右侧 Dock（Data / AI）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | Dock 宽 280px（220–420 可拖）；拖拽柄 4px，命中区 ≥4px（建议 ≥8px） | `getBoundingClientRect` | ⚠️ 4px 偏小，拖拽失败率高 |
| 对齐 | **Dock tab 条 38px 与左栏标题条 36px 必须在同一水平线** | 像素扫描两处底线 | ❌ **实测 y=83 vs y=82，错位 1px** |
| 对齐 | tab 高 27px，等宽按内容，间距 4px，文字 12px | computed | ✅ |
| 不重叠 | 通道卡内：数值右缘与卡右边距 ≥8px；右侧 3 个操作按钮热区 ≥24×24、间距 ≥2px，且不覆盖数值 | 逐个卡片 rect 求交 | 需复核（`.mini-btn padding 1px 6px`、`min-width 20px` → 热区可能仅 20×20） |
| 不重叠 | AI 输入区高度 ≥44px；发送按钮 ≥32×32；composer 与消息区间距 ≥6px | computed | 需复核 |
| 可见 | 滚动条 10px，出现/消失不得改变内容宽度（`scrollbar-gutter: stable`） | 切换滚动 | ✅ codex 已声明（L3678），玻璃需核 |
| 可见 | tab 激活态除颜色外必须有第二指示（底色或下划线），色差 ΔE ≥ 6 | 截图 | ✅ 底色变化 |
| 可见 | 数值使用 `tabular-nums`（防跳） | computed `font-variant-numeric` | ✅ `.chl-val` 已开（L806） |

### 3.4 可视化设计器（`.dsg-*`）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 外壳 `min(1520px,96vw) × min(940px,94vh)`，圆角 16；左 palette 208px、右属性 286px，两栏宽度固定 | computed | ✅ 但 16px 圆角不在档位（§1.4） |
| 对齐 | 12 列网格、行高 44（可调）、`gap 10px`；细胞左缘必须落在 12 列网格线上，偏差 0px | 拖拽后取 cell rect 与 grid 计算值 | 需复核 |
| 不重叠 | 细胞之间间距恒为 10px（拖动/缩放后不得出现 9 或 11px 的累积误差） | 批量取相邻 rect | 需复核（布局若是百分比换算会累积误差） |
| 不重叠 | 细胞上方工具条 22px 高，标题文字与右侧 3 个操作按钮间距 ≥6px，长标题省略号（不得盖住按钮） | 长名字测试 | 需复核 |
| 不重叠 | 缩放把手 18×18 位于右下角，不得覆盖内容文字（内容区需 8px 内边距或把手浮层） | 截图 | ⚠️ 把手 `opacity: 0` 悬停才显形（L158）→ 首次使用不可发现 |
| 可见 | 输入框/分组线在**浅色主题**下仍可见：边框对比 ≥3:1 | 切浅色主题截图 | ❌ 边框为 `rgba(255,255,255,.10)`，浅底上 ≈1.1:1 |
| 可见 | 选中细胞：1px `var(--acc)` + 1px 叠环（L146）| computed | ✅ |
| 可见 | 空画布提示"拖控件进来"常驻，13px，对比 ≥4.5:1 | 空看板 | 需复核（`.dsg-empty-note` 用 `--text-dim`） |

### 3.5 全屏看板（`.board-*`）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 头部条与画布同宽（`padding` 左右一致，偏差 0px）；按钮组右缘距视口右 ≥14px | 截图 | 需复核 |
| 对齐 | 栅格与设计器一致：12 列、行高 44、gap 10（设计器保存 → 看板必须原样呈现，列宽偏差 ≤1px） | 设计器与看板同屏截图对比 | 需复核 |
| 不重叠 | 顶部控制条（全屏/退出）不得覆盖任何卡片内容：卡片内容区顶部预留 ≥ 头部高 + 8px | 截图 | ✅ 头部为独立行 |
| 不重叠 | 底部提示 `.board-tip`（bottom 14、胶囊）不得覆盖最底部卡片；提示与卡片间距 ≥8px | 截图 | ✅ |
| 不重叠 | 数值大字与单位：`25.56`(30px) + `V`(12px) 基线差 ≤2px，单位不得与数字重叠或换行 | 截图 | ✅ |
| 可见 | 卡片边界在深色下仍可辨：卡片底色与背景差 ≥ΔE 2，或有 1px 边框 | 截图 | ⚠️ 玻璃下卡片 `rgba(255,255,255,.035)` 叠层，弱底上几乎不可见 |
| 可见 | 全屏态隐藏所有应用级 chrome（活动栏/Dock/顶栏），仅保留退出按钮与提示 | 截图 | ✅ `.board-mask` fixed + z 9760 |
| 可见 | Esc 退出提示常驻（11px），与 toast 的垂直间距 ≥16px，且都不遮挡最底部卡片 | 触发一次保存 toast | ⚠️ toast `bottom:64` 与提示 `bottom:14` 间距偏紧（实测约 38px），1280×720 下需复测 |

### 3.6 命令面板（`.xhgcs-palette`）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 宽 `min(660px,88vw)`，顶部内边距 12vh；搜索框高 50px；行高 ≥36px；footer 高 32px | computed | ✅ |
| 对齐 | 分类标签列宽一致（`min-width:40px`），命令 id 右对齐，右缘距面板右 ≥14px | 截图 | ✅ |
| 不重叠 | 选中行左侧 2px 指示条不得压住文字（文字左内边距 ≥12px） | 截图 | ✅ |
| 不重叠 | 长命令标题省略号，不得推挤右侧 id；两者最小间距 ≥12px | 超长标题测试 | 需复核 |
| 可见 | **浅色主题下面板可读**：文字对面板背景 ≥4.5:1 | 切浅色主题截图 | ❌ **推算 1.12:1**（背景硬编码 `rgba(24,30,40,.99)`，文字 `--heading` = `#202733`） |
| 可见 | 键盘提示（↑↓/⏎/Esc）始终可见，11px，`kbd` 框 1px 边框 | 截图 | ✅ |
| 可见 | 空结果显示空态文案，不是空白列表 | 输入 `zzzz` | ✅ `没有匹配的命令`（src/ui/shell.ts:146-149） |

### 3.7 扩展授权（`.xst-*` / `.xhgcs-consent` / `.xhgcs-chip`）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 外壳 `min(880px,92vw) × min(620px,84vh)`；左导航 220px；行高一致 | computed | ✅ |
| 对齐 | 状态 chip 与标题同一基线，chip 高度统一（22±1px） | 截图 | 需复核 |
| 不重叠 | 授权行：按钮组与说明文字间距 ≥8px；长扩展名换行不得压按钮 | 超长名测试 | 需复核（`.xhgcs-ext-id` 用 `word-break: break-all` ✓） |
| 不重叠 | 权限列表每行 ≥24px 高，checkbox 与文字间距 5–7px | computed | ✅ |
| 可见 | **7 个状态色必须各自可辨且 ≥4.5:1**：active/resolved/disabled/degraded/failed/pending/activating | 逐态截图 + 对比度计算 | ❌ `active` 用 `var(--ok,#34d399)`，浅色底 **1.81:1** |
| 可见 | 授权按钮（`.xhgcs-consent button`）警告色 `#ffe7b0` 为硬编码，浅色下对比不足 | 计算 | ❌（硬编码 D 类） |
| 可见 | 危险操作（停用/卸载）与普通操作视觉可区分（颜色或边框） | 截图 | 需复核 |

### 3.8 数据引擎监视（`.pipe-*`）

| 类型 | 判据 | 判定方法 | 现状 |
|---|---|---|---|
| 对齐 | 外壳 `min(820px,92vw)`；指标卡 4 列等宽（宽度偏差 ≤1px），两行等高 | 截图 | ✅ |
| 对齐 | 卡内：标签 11px / 数值 19px（→ 归并到 20）/ 单位 11px，三者左对齐，左内边距一致 | computed | ⚠️ 19px 不在档位 |
| 对齐 | 分组标题（数据源/处理阶段/端点）字号 11px、字距 .06em、上下留白一致（16/8） | computed | ✅ |
| 不重叠 | 8 张卡在 820px 宽下不得换行（4×~190px + gap 10） | 1600 与 1280 各测一次 | 需复核 |
| 不重叠 | 卡内数值超长（如 `0 / 4096`）不得撑破卡片：`overflow: hidden` + `text-overflow` | 造超长值 | 需复核 |
| 可见 | **无数据时不得只显示一个破折号**：指标卡无值当前渲染单个 `—`（src/ui/pipeline-panel.ts:143-146），须改为"暂无数据"可读文案 + 说明（`.pipe-empty` 已存在，但只覆盖列表区） | 打开面板即见 | ❌ 指标卡缺空态语义 |
| 可见 | 管道链路说明（Source → Operator → Sink）常驻页脚，11px | 截图 | ✅ |
| 可见 | 有数据卡（ok 色）与 warn/error 卡颜色差异 ≥ΔE 8 | 造 warn/error | 需复核（ok 走未定义令牌） |

---

## 4. 状态覆盖验收

**规则：每个交互组件必须具备五态，缺一即不通过。** 状态不是"有没有样式"，而是"能否被触发并被看见"。

### 4.1 五态定义与触发方式

| 态 | 定义 | 触发 | 必须可见的视觉信号 |
|---|---|---|---|
| **加载** | 异步数据未到 | 断网/慢接口/首次加载 | 骨架屏或 spinner + 文案；**禁止空白**；>300ms 才出现（防闪烁） |
| **空白** | 成功但无数据 | 清空通道、无扩展、无命令匹配 | 一句解释 + 一个下一步动作；**禁止只有图标或"——"** |
| **错误** | 失败且可恢复 | 串口断开、AI 超时、脚本报错 | 红色语义 + 原因 + 重试入口；不得只用颜色区分（需图标或文案） |
| **禁用** | 当前不可用 | 未连接串口、无选中项 | 对比度降至 3:1 左右但**仍可读**（禁止 `opacity < .4` 导致文字消失）+ `cursor: not-allowed` |
| **聚焦环** | 键盘可达 | Tab / 方向键 | 环宽 2px、环与相邻色对比 ≥3:1、`outline-offset ≥2px`；**不得 `outline: none` 后无替代** |

### 4.2 组件 × 状态矩阵（勾满才通过）

| 组件 | 加载 | 空白 | 错误 | 禁用 | 聚焦环 |
|---|---|---|---|---|---|
| 通道卡 `.chl` | — | ✅ 无通道 | ✅ 通道无值 | 需确认 | ❌ 无 `:focus-visible` 规则 |
| 波形画布 | ❌ | ⚠️ 有 footer 文案，画布内无占位 | — | — | — |
| Dock tab | — | — | — | — | ✅（全局） |
| AI 对话 `ai-msg` | ✅ `AI 正在思考…`/`生成中…` + `.ai-pending-btn`（ai-ui.js:39/179） | ✅ `.ai-empty-facts` | ✅ `.notice.error` | 需确认（发送中是否禁用） | 需确认 |
| 命令面板 | — | ✅ `没有匹配的命令` | — | — | ✅ |
| 扩展管理 `.xhgcs-ext` | ❌ | ✅ `.xhgcs-empty` | ✅ chip failed | ✅ chip disabled | 需确认 |
| 扩展配置 `.xst-*` | ❌ | ✅ `.xst-empty` | ✅ `.xst-ext-msg` | 需确认 | ✅ `input:focus` |
| 引擎面板 `.pipe-*` | ❌ | ⚠️ 指标卡单个 `—`，列表区 `.pipe-empty` | ⚠️ `.pipe-err` | — | ✅ |
| 设计器 `.dsg-*` | — | ✅ `.dsg-empty-note` | ⚠️ `.dsg-missing` | 需确认 | ✅ `.dsg-btn:focus-visible` |
| 看板 `.board-*` | — | ✅ `.board-empty` | ✅ `.dsg-missing` | — | ❌ 无 |
| 插件视图 `.vc-*` | ❌ | ✅ `.vc-empty` | ✅ `.vc-err` | — | 需确认 |

**当前结论**：加载态几乎全缺（6 个适用组件中仅 AI 对话具备）；空白态 8/10 完整 + 2 处残缺；错误态 6/8 完整 + 2 处残缺；禁用态 3/9 确认具备、5 处待复核；聚焦环 7/11 → **状态覆盖不通过**（逐格详见上表；`—` = 该组件不适用此态）。

### 4.3 聚焦环专项（当前不合格）

**全局规则**（styles.css:3088-3096）：

```css
button:focus-visible, [tabindex]:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(var(--k-blue), .45); }
```

- **环宽 2px，颜色 `rgba(109,168,210,.45)` 叠在 `#0d1117` 上 → 有效色约 `#38566B`，对比度 2.43:1**【推算】→ 低于非文字控件 3:1 要求，不通过；
- codex 下改为 `box-shadow: 0 0 0 1px var(--acc)`（L3583）→ 环宽 1px、对比 6.45:1 ✓，但**两套 FX 环宽不一致（2px vs 1px）**，切换时可见跳变 → P2；
- 焦点环使用 `--k-blue` 而非 `--acc`，codex 下环色仍是玻璃蓝 → P2；
- `.collapse-btn:focus { outline: none }` 但未给替代样式（L3089-3091）→ P1。

**判定**：
```js
// Tab 走一遍，断言每个可聚焦元素有可见环且环色对比 ≥3:1
document.querySelectorAll('button,input,select,textarea,[tabindex]').forEach(el => {
  el.focus();
  const s = getComputedStyle(el);
  if (s.outlineStyle === 'none' && s.boxShadow === 'none') console.warn('无焦点环', el);
});
```

---

## 5. 回归检查方式

### 5.1 基线生成（唯一前提：冻结一切不确定因素）

`body::after` 有 18s 无限漂移动画（`glass-drift`，`filter: blur(38px)` + `will-change: transform`），**不冻结则任意两次截图必然不同**，像素对比会 100% 假失败。

**冻结清单（缺一不可）**：

```js
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.addStyleTag({ content: `
  *,*::before,*::after{animation-play-state:paused!important;animation-delay:-1ms!important;
    transition:none!important;caret-color:transparent!important}
  body::after{display:none!important}
`});
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await page.waitForTimeout(200); // 等 canvas 至少绘制两帧
```

其余固定量：主题（dark/light）、FX（glass/codex）、窗口尺寸、图表数据（用固定 seed 的仿真源，禁用真实串口）、通道数（固定 5）、滚动位置（`scrollTop=0`）、鼠标位置（移出视口）。

**基线存放**：`logs/visual/goldens/<WxH>@<scale>/<screen>.<fx>.<theme>.png`，随版本提交。

### 5.2 截图对比阈值

| 区域 | 阈值 | 说明 |
|---|---|---|
| 结构区（边框、文字、图标） | **0 像素差** | 用掩码只比这些区域 |
| 图表数据区 | ≤0.1% 像素差，且单点 ΔE ≤3 | canvas 抗锯齿抖动 |
| 玻璃材质区（blur/渐变） | ≤0.25% 像素差，单点 ΔE ≤4 | 不同 GPU 的 blur 实现有差异 |
| 全图 | 差异像素占比 ≤0.1% | 超过即 BLOCK |

掩码：图表 canvas 与 `backdrop-filter` 容器自动生成掩码（按元素 rect），其余区域零容忍。

### 5.3 视口矩阵

| 视口 | 关键降级点（源码） | 必查 |
|---|---|---|
| 1280×720 | `max-width:1180/1100` 未触发（1280 > 1180），左栏 220 + Dock 280，中央仅 **724px** | 图表 X 轴刻度是否重叠；`ctrl-head` 的 `flex-wrap: nowrap` + `overflow: hidden` 是否把"复位视图/PNG/CSV/日志"按钮吃掉 |
| 1600×900 | 默认档 | 全量逐屏 |
| 2560×1440 | `min-width:1720` 生效（styles.css 有 1380/1720 两档） | 中央区被拉宽后：波形标签密度、`max-width` 缺失导致的大段留白、Dock 仍固定 280 是否过窄 |

每档 × {glass, codex} × {dark, light} = 12 组，每组至少覆盖 8 屏 → **96 张基线图**。

**判据**：任何一组出现①文字被截断、②两元素重叠 ≥1px、③出现水平滚动条（`document.scrollingElement.scrollWidth > clientWidth`）、④某区域宽高为 0 → 该组不通过。

### 5.4 缩放矩阵（100% / 125% / 150%）

用 `browser.newContext({ viewport, deviceScaleFactor })` 或 Electron `--force-device-scale-factor=1.25`。

| 检查项 | 判据 |
|---|---|
| 1px 边框 | 在 1.25/1.5 DPR 下渲染为 1 物理像素（截图取色：边框行/列的过渡像素 ≤1 列）；若出现 2 列灰色过渡 → 说明 CSS 用了小数尺寸，不通过 |
| 文本基线 | 相邻两级字号基线的垂直距离在缩放后仍为整数像素（避免半像素发虚） |
| canvas 清晰度 | `canvas.width === Math.round(rect.width * dpr)`；波形 1px 线在 150% 下灰度过渡 ≤1 像素 |
| 布局不破 | 区分两种缩放：①`deviceScaleFactor` 模拟只放大位图、CSS 视口不变 → 查清晰度；②真实系统缩放（Electron `--force-device-scale-factor=1.25`，窗口物理宽不变）→ CSS 视口变为 1280×720，**必须复用 §5.3 的 1280×720 判定** |
| 弹窗不越界 | `min(820px,92vw)` 类限制在 150% 下仍成立，不得超出视口 |

### 5.5 长时间运行（2 小时）

采样：每 15 分钟一次截图 + `Performance.getMetrics()` + 一帧 rAF 间隔采样（100 帧）。

| 指标 | 阈值 |
|---|---|
| rAF 帧间隔 P95 | ≤ 20ms（≈50fps） |
| rAF 帧间隔 P99 | ≤ 33ms |
| JS 堆增长 | 相对 t=10min 基线 ≤ 10% |
| DOM 节点数增长 | ≤ 5%（防止通道卡/消息无限追加） |
| 视觉漂移 | t=120min 与 t=10min 截图（冻结动画后）差异 ≤0.1%，且**结构区 0 像素差** |
| 波形绘制耗时 | 单帧重绘 ≤ 8ms（数据点满窗时） |
| 玻璃 FX 特有 | `backdrop-filter` 区域不得随时间扩大；GPU 进程内存增长 ≤15% |
| 数值字段宽度 | 数值跳动时列宽不变：`tabular-nums` 已覆盖 17 处主要数值元素（`.chl-val` L806、`.stat-card b` L1044、`.pipe-card b` 等）；**新增数值元素必须同样声明**，否则长跑时会看到横向抖动 |

**已知风险**：18s 无限漂移 + `blur(38px)` + `will-change: transform` 会让 GPU 每帧重绘全屏模糊。2 小时测试必须记录 GPU 进程内存；若 `--disable-gpu` 下掉帧 >5%，视为不可接受。

### 5.6 执行入口（建议）

```jsonc
// package.json scripts 追加
"test:visual": "node tools/visual-audit.cjs",
"test:visual:update": "node tools/visual-audit.cjs --update"
```

`tools/visual-audit.cjs` 复用现有基建（`electron/static-server.js` 起 8123 静态服务 + `tools/regress.js` 的 Chromium 解析逻辑 + playwright），职责：
1. 静态检查：§2.3/§2.4 的令牌与 FX 覆盖断言（可并入 `tools/audit.cjs`）；
2. 运行时检查：§1.1 字号档位、§1.6 阴影种类、§4.3 焦点环、§3 各屏 rect 断言；
3. 截图：§5.3 矩阵 + §5.2 对比；
4. 输出 `logs/visual/report.md`（每项 PASS/FAIL + 截图路径），FAIL 时 exit 1。

---

## 6. 一票否决清单

发布前出现任意一条即 **BLOCK**，不接受"下个版本修"：

1. **任意可见文字对比度 < 4.5:1**（≥20px 或 ≥16px 粗体可放宽到 3:1）；含浅色主题下的命令面板/状态栏/状态 chip。
2. **颜色/阴影/圆角出现硬编码**，且该值在任一主题或 FX 下与设计意图不符（§2.2 A/B/C/D 任一）。
3. **同一水平基准上的分割线偏差 > 0px**（标题条、表格列、栅格线、卡片上下沿）。
4. **文字或数值被裁切**：末位字符/数值距容器边界 < 8px（§3.2 判据）→ 否决；其余文本 < 4px 视为有裁切风险。
5. **元素重叠**：任何两个可读文本矩形相交 > 0px²；任何控件覆盖数据值。
6. **切 FX 后材质不变**：codex 下仍出现 `backdrop-filter`/大投影/大圆角/白色渐变描边（新界面组尤其注意）。
7. **切浅色主题后仍有深色硬编码面板**（`.xhgcs-palette` 当前即此情况）。
8. **缺失加载/空白/错误/禁用/聚焦环任一态**（§4.2 矩阵任一 ❌）。
9. **聚焦环不可见或对比 < 3:1**，或 `outline: none` 无替代。
10. **画布模糊**：`canvas.width ≠ round(CSS 宽 × DPR)`，或 125%/150% 下波形线出现双像素灰边。
11. **截图基线不可复现**：同一构建两次运行截图差异 >0.1%（说明存在未冻结的动画/随机数据/时间戳）。
12. **2 小时运行后出现视觉漂移或掉帧**（§5.5 任一指标越界）。
13. **新增 `z-index` 导致提示被弹窗遮挡**（§1.8 遮蔽关系被破坏）。
14. **同一语义元素多套实现**（toast 已有 4 套、弹窗圆角已有 5 套）。

---

## 附录 A：现有缺陷快照（可复现证据）

> 供开发逐条修；修复后请回填 §3 各表的"现状"列。

| # | 位置 | 现象 | 级别 | 建议 |
|---|---|---|---|---|
| A1 | src/ui/shell.ts:23 | 命令面板背景 `rgba(24,30,40,.99)` 硬编码，浅色主题下文字对比 1.12:1 | P0 | 改 `var(--bg2)` + 玻璃令牌 |
| A2 | src 全目录 | 0 个 `data-theme`/`data-fx` 分支 | P0 | 为 7 组界面补浅色与 codex 覆盖 |
| A3 | styles.css:2303 | `var(--hover-line)` 无 fallback，玻璃下圆点透明 | P2 | 补 `var(--line)` fallback 或定义该令牌 |
| A4 | src/ui/shell.ts:63 等 | `--ok` 未定义，回退 `#34d399`，浅底 1.81:1 | P1 | 定义 `--ok`（深/浅两套） |
| A5 | src/core/statusbar.ts:19-23 | `--accent/--fg/--fg-2` 未定义，回退 `#4c9aff/#9aa4b2/#f5a623` | P1 | 统一到 `--acc/--text/--text-dim/--warn` |
| A6 | styles.css:3440/3653 | codex 覆盖只含 22 个旧类 | P1 | 扩充为含新界面组的清单 |
| A7 | 实测 main.png | ctrl-head 底线 y=82，dock-tabs 底线 y=83 | P1 | 二者统一 38px（或都 36px） |
| A8 | 实测 main.png | 活动栏 48px 与源码 L142 的 56px 并存 | P2 | 删除失效定义 |
| A9 | logs/shots/views.png | 数值标签右缘 0–1px 贴边 | P1 | 画布绘制保留 8px 安全边距 |
| A10 | styles.css:3088-3096 | 焦点环 2.43:1、2px，codex 下 1px | P1 | 统一 2px + `var(--acc)` 实色 |
| A11 | styles.css:2735-2747 | `gn-dash`/`gn-port-pulse`/`.toast` fadeIn 不受 reduced-motion 约束 | P2 | 加入 reduce 块 |
| A12 | styles.css:2061/2369/2410 | 三处把 `#6da8d2` 写死为选中/焦点边框 | P1 | 改 `var(--acc)` |
| A13 | styles.css:1539 | `#64748b`（AI 任务时间）暗底 3.67:1 | P2 | 改 `var(--text-dim)` |
| A14 | src/designer/designer.ts:86-203 | 设计器单屏 8 种圆角、4 种投影 | P2 | 收敛到 4/6/8/14 + 3 档阴影 |
| A15 | src/ui/pipeline-panel.ts:143-146 | 指标卡无值渲染单个 `—` | P1 | 改"暂无数据"文案 |
| A16 | styles.css:1552 | `.toast` z=80，低于所有新弹窗（9620+） | P1 | 统一 toast 实现与层级 |
| A17 | logs/shots/*.png | 无生成脚本，与当前 CSS 不同源（截图 10-26 12:42） | P1 | 建基线脚本后重出 |

## 附录 B：豁免与冻结清单

**既有豁免（允许保留，但改动该处时须顺手归一）**

| 项 | 位置 | 理由 |
|---|---|---|
| 奇数间距 7/9/5 | `.chl`、`.sw-item`、`.ctrl-head`、`.dock-tabs`、`.plot-tabs` | 紧凑行内边距，元素高 ≤40px |
| 圆角 5/7/9 | 按钮、通道卡、图标块 | 玻璃材质观感的既有值；codex 已有 4/5/6 映射 |
| 玻璃材质 rgba 叠层 | `--glass-*`、`.chart-wrap` inset 高光 | 液态玻璃表现的必需部分 |
| 半像素字号 10.5 | canvas 绘制文本 | 画布局部视觉平衡，不改 DOM |

**冻结规则**：新增代码不得引入上表之外的例外；触及豁免项所在规则时，必须同步归一到 §1 档位。

## 附录 C：验收记录表（每次发布复制一份）

| 屏 | 对齐 | 不重叠 | 可见 | 状态五态 | 双 FX | 双主题 | 截图基线 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 活动栏 | | | | | | | | |
| 波形区 | | | | | | | | |
| Dock | | | | | | | | |
| 设计器 | | | | | | | | |
| 看板全屏 | | | | | | | | |
| 命令面板 | | | | | | | | |
| 扩展授权 | | | | | | | | |
| 引擎面板 | | | | | | | | |

**签字**：开发自检 ______ 验收 ______ 日期 ______
**构建指纹**：前端版本串（`bump-version.cjs --check` 输出）______
