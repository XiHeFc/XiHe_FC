# XiHe GCS PRO 0.25.0 · 界面层级规范（Surface Elevation & Information Hierarchy）

> 目标：解决「板块之间区分太尖锐 / 配色都在同一平面 / 抓不住信息」。
> 范围：只改视觉层级（底色、描边、阴影、圆角、留白、字号字重颜色）。**不改信息架构、不改交互、不改 DOM 结构、不改面板宽度。**
> 适用：`dark/light` × `glass/codex` 四种组合。
> 基线：`package.json` 0.25.0 · commit `e0a2e7e`

---

## 0. 一页纸结论

### 0.1 三个根因（都有实测数字）

| # | 根因 | 证据（`logs/shots/ui-main.png` 取色 + CSS 定位） | 后果 |
|---|---|---|---|
| **A** | **相邻面板之间没有任何底色差** | 顶栏 / 活动栏 / 左控件箱 / 中央 / 右 Dock / 通道卡 **全部是 `#151a21`（同一像素值）**；ΔL\* = **0.00** | 底色不承担任何信息，只能靠 1px 线分区；线必须画得足够清楚才看得见 → 越画越硬 |
| **B** | **1px 线成了唯一分隔手段，且全高全宽、无圆角收口** | `.topbar`/`.ctrl-switch`/`.channels`/`.dock-tabs`/`.ctrl-head`/`.pane-title`/`.chl` 共 **7 类边界**全是 `border: 1px solid var(--line)`；`--line #272e37` 对 `#151a21` = **1.28:1**，光看对比度不算硬，硬的是「0px 过渡 + 贯穿整条边」 | 观感像用刻刀把界面切成格子；这正是"尖锐"的来源，不是对比度高 |
| **C** | **codex FX 把阴影全部关掉**，glass FX 又给每块面板都挂 32px 大模糊外阴影 | `styles.css:3449-3456` 一条规则把 **22 个选择器**（含 `.topbar/.ctrl-switch/.ctrl-view/.channels/.chl`）的 `box-shadow` 设为 `none`；`styles.css:2659-2662` 每块 glass 面板 `0 12px 32px rgba(0,0,0,.22)` | codex 没落地感 → 只能靠线；glass 缝隙被邻块阴影填满 → 变成一层均匀的雾，反而抹平层差 |

补充两条同源问题：

- **D 数值没有焦点**：通道卡里标题 `13px/600 --text`、数值 `20px/700 --text`，两者**同一个颜色**；一屏有 5 个 `--acc` 描边的"激活态"（活动栏工具、控件项、图页标签、Dock 页签、主按钮）在抢注意力 → 等于没有焦点。
- **E 凹槽反了**：浅色 `codex` 里图表凹槽是 `--well #f6f7f9`，**比面板 `#ffffff` 还亮**（`styles.css:3598`）；深色里凹槽用白色 1px 内环描边（`styles.css:3066`），白环是全屏最锋利的一根线。

### 0.2 三条主线改法

1. **先给层差**：建立 L0/L1/L2/L3 + 凹槽 4+1 层模型，把 `--surf-*` 补齐到每一块面板/卡片/浮层。相邻层 ΔL\* 4.0–4.6。
2. **再把线降级**：面板边界从 `1px --line` 换成 **「seam（1px 白 5.5% 发丝 + 6px 内阴影柔化）」**，能用留白的地方一律不留线（见 §2.3 裁决表）。
3. **最后把焦点收回家**：数值升到 `--heading` + `650` 字重 + tabular-nums；分区标题降成 11px/600/`--text-dim`；一屏只允许 1 个 `--acc` 实心元素。

### 0.3 落地约束（先看，否则会白改）

- 样式主文件只有一个：`assets/css/styles.css`（5092 行）。设计器 / 看板 / 命令面板的 CSS 是 **TS 内联字符串**，改完必须 `npm run build:core` 重建 `assets/js/core.bundle.js`。
- `index.html` 的 `?v=20261026P` 缓存串必须升级：`node tools/bump-version.cjs 20261027A`（会同步 16 处 + `boot.js`/`layout.js`/`start.ps1`）。Electron 有 immutable 缓存，不升看不到效果。
- `tools/audit.cjs` 有一条 **「CSS 未引用类」** 检查：`styles.css` 里新增的类名如果只被 `.ts` 使用会被判为未引用（它只扫 `.html/.js/.mjs/.cjs`）。**本规范因此不新增任何类名**，全部通过改现有选择器 + 新增 CSS 变量实现。
- 改完跑 `npm test`（audit + regress），四种组合各截一张图，按 §6 判据量。

---

## 1. Surface 层级模型：L0–L3 + 凹槽

### 1.1 模型定义（语义，不随主题变）

| 层 | 名称 | 谁在用 | 物理隐喻 |
|---|---|---|---|
| **L0** | 窗底 | 只出现在**缝隙**里（面板之间 6–8px 的沟、圆角切角）。**没有任何面板直接使用 L0 作为自己的底色。** | 桌面 / 桌布 |
| **L1** | 面板 | 顶栏、活动栏（48）、左控件箱（220）、中央图页区、右 Dock（280）、状态栏、设计器外壳、看板标题条 | 拼在一起的仪表台面（**一个整平面**，不互相分层） |
| **L2** | 浮起卡片 | 通道卡、激活的图页标签、控件箱里的激活项与图标底盘、看板/设计器单元格、按钮被按下/悬停的底盘 | 台面上的仪表面板 / 卡片 |
| **L3** | 浮层 | 命令面板、模态（含通道配置、视图弹窗）、扩展管理/配置面板、右键菜单、图表 tooltip、Toast、图表空态卡 | 悬在台面之上的亚克力板 |
| **凹槽** | 凹槽（屏幕面） | 图表画布区、分析画布视口、串口日志体、输入框内底、图表空态后面的底 | 台面上挖下去的一块显示屏（**比 L0 更低**） |

**关键认知（也是本次整改的核心）**：
顶栏/活动栏/控件箱/中央/Dock **本来就应该是同一层 L1** —— 用户说"都在同一个平面"是对的，**错误不在于它们同层，而在于层内没有任何东西浮起来，且层间靠硬线切分**。所以不要试图给中央面板换个底色去"分层"，而是：**壳做平，内容浮起**（L1 一体 + L2 卡片 + 凹槽屏幕 + 缝隙露出 L0）。

### 1.2 深色（dark）—— glass / codex 共用层值，材质不同

| 层 | 底色令牌 → 渲染值 | 描边（宽 + 透明度） | 阴影（x y blur spread 颜色） | 圆角 | 模糊 |
|---|---|---|---|---|---|
| L0 | `--surf-0` → `#0d1117`（L\*=4.95） | — | — | — | — |
| L1 | `--surf-1`：glass `rgba(24,30,37,.72)` / codex `#151a21` → 两者**同为 `#151a21`**（L\*=9.06） | 只在与 L0/L2 相接处：`1px rgba(255,255,255,.055)`；其余方向 **0** | `0 1px 2px rgba(0,0,0,.26)`（glass）/ `0 1px 2px rgba(0,0,0,.32)`（codex） | 贴边面板 **0**；浮起的整块 **12**（glass）/ **8**（codex） | **否**（背后只有 L0，blur 不可见，白烧 GPU） |
| L2 | `--surf-2`：glass `rgba(30,37,45,.86)` / codex `#1d232b` → 同为 `#1d232b`（L\*=13.46） | `1px rgba(255,255,255,.055)` + 顶部高光 `inset 0 1px 0 rgba(255,255,255,.06)` | glass：`0 1px 1px rgba(0,0,0,.20), 0 10px 22px -10px rgba(0,0,0,.50)`<br>codex：`0 1px 2px rgba(0,0,0,.28), 0 4px 10px -4px rgba(0,0,0,.40)` | **10**（glass）/ **6**（codex） | 否 |
| L3 | `--surf-3`：glass `rgba(37,45,55,.92)` / codex `#242c36` → 同为 `#242c36`（L\*=17.66） | `1px rgba(255,255,255,.10)` | glass：`0 2px 8px rgba(0,0,0,.32), 0 30px 72px -16px rgba(0,0,0,.62)`<br>codex：`0 2px 6px rgba(0,0,0,.34), 0 18px 48px -12px rgba(0,0,0,.55)` | **16**（glass）/ **12**（codex） | **是**：`blur(24px) saturate(150%)`（glass）；codex 否 |
| 凹槽 | `--surf-inset`：glass `rgba(2,5,9,.55)` / codex `#0a0e13` → ≈`#0b0e14`（L\*=3.94） | **0**（用内阴影代替描边） | `inset 0 1px 3px rgba(0,0,0,.55), inset 0 0 0 1px rgba(0,0,0,.35)` | **12**（glass）/ **6**（codex） | 否 |

层差实测：`凹槽→L0 = +2.05` / `L0→L1 = +4.11` / `L1→L2 = +4.40` / `L2→L3 = +4.20` L\*。
表中阴影均写作 `x y blur spread color`，未写 spread 即 `0`；`--elev-*` 是全站唯三的阴影来源，组件不得自写 `box-shadow`（focus ring 除外）。
glass 的 alpha 是**按"合成后正好落在同一像素值"反解**的（`rgba(24,30,37,.72)` 叠在 `#0d1117` 上 = `#151a21`），所以两种 FX 的层值可以共用同一张验收表。

> **玻璃高光的新规矩**：`--surf-sheen` 只允许出现在面板顶部 28–55% 高度内（`linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.012) 28%, transparent 55%)`），**中心区域（QA 取点位置）额外抬升 ≤ +1.5 L\***。旧的 `rgba(255,255,255,.11)→.055` 全高渐变平均会把面板抬 +6.3 L\*，直接把层差吃掉。

### 1.3 浅色（light）—— glass / codex 共用层值

| 层 | 底色令牌 → 渲染值 | 描边 | 阴影 | 圆角 | 模糊 |
|---|---|---|---|---|---|
| L0 | `--surf-0` → `#e3e8f0`（L\*=91.84） | — | — | — | — |
| L1 | `--surf-1`：glass `rgba(252,253,255,.74)` / codex `#f5f8fc` → ≈`#f5f8fc`（L\*=97.46） | `1px rgba(15,23,42,.065)` | glass：`0 1px 2px rgba(15,23,42,.05)`<br>codex：`0 1px 2px rgba(15,23,42,.05)` | 0 / 12 / 8 | 否 |
| L2 | `--surf-2`：glass `rgba(255,255,255,.90)` / codex `#ffffff` → ≈`#ffffff`（L\*=100） | `1px rgba(15,23,42,.065)` | glass：`0 1px 2px rgba(15,23,42,.05), 0 10px 24px -10px rgba(15,23,42,.14)`<br>codex：`0 1px 2px rgba(15,23,42,.05), 0 4px 10px -4px rgba(15,23,42,.10)` | 10 / 6 | 否 |
| L3 | `--surf-3` → `#ffffff`（同 L2，浅色天花板） | `1px rgba(15,23,42,.11)` | `0 2px 6px rgba(15,23,42,.06), 0 30px 70px -16px rgba(15,23,42,.22)` | 16 / 12 | glass 是 `blur(24px) saturate(140%)` |
| 凹槽 | `--surf-inset`：glass `rgba(15,23,42,.04)` / codex `#edf2f9` → ≈`#edf1f6`（L\*=95.31） | 0 | `inset 0 1px 2px rgba(15,23,42,.07), inset 0 0 0 1px rgba(15,23,42,.04)` | 12 / 6 | 否 |

层差实测：`L0→L1 = +5.63` / `L1→L2 = +2.54` / `L1→凹槽 = −2.15` L\*。
浅色 L2→L3 **没有底色差**（都是 #fff），这是浅色的物理上限，所以 **L3 必须同时给"描边更重 + 阴影更长 + 背后有遮罩"三件套**，缺一不可。

### 1.4 令牌落地（可直接粘贴）

插入 `assets/css/styles.css:45`（`:root` 收尾处，紧跟 `--k-blue-t` 之后）：

```css
  /* ===== 表面层级 elevation 0–3（唯一来源：底色/描边/阴影/圆角/模糊）=====
     L0 窗底 → L1 面板 → L2 卡片 → L3 浮层；--surf-inset 是比 L0 更低的凹槽。
     组件只准引用 --surf-* / --edge-* / --elev-* / --r-*，不准再写具体色值。 */
  --surf-0: #0d1117;                         /* 合成目标，QA 取点值 */
  --surf-1: rgba(24, 30, 37, .72);           /* 合成 #151a21 */
  --surf-2: rgba(30, 37, 45, .86);           /* 合成 #1d232b */
  --surf-3: rgba(37, 45, 55, .92);           /* 合成 #242c36 */
  --surf-inset: rgba(2, 5, 9, .55);          /* 合成 #0b0e14 */
  --surf-hover: rgba(255, 255, 255, .045);   /* 悬停叠加层，不改底色本身 */
  --surf-sheen: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.012) 28%, transparent 55%);
  --surf-blur: none;                          /* L1 面板：背后只有 L0，不模糊 */
  --surf-blur-top: blur(24px) saturate(150%); /* L3 浮层：叠在锐利内容上，必须模糊 */

  --edge-hair: rgba(255, 255, 255, .055);    /* 面板/卡片边。今天 --line 是 1.28:1，这个是 1.16:1 */
  --edge-soft: rgba(255, 255, 255, .035);    /* 分组分隔（能省则省） */
  --edge-strong: rgba(255, 255, 255, .10);   /* 浮层边 */

  --seam-x: inset -6px 0 8px -6px rgba(0, 0, 0, .45), inset -1px 0 0 var(--edge-hair);
  --seam-x-r: inset 6px 0 8px -6px rgba(0, 0, 0, .45), inset 1px 0 0 var(--edge-hair);
  --seam-y: inset 0 -6px 8px -6px rgba(0, 0, 0, .40), inset 0 -1px 0 var(--edge-hair);

  --elev-1: 0 1px 2px rgba(0, 0, 0, .26);
  --elev-2: 0 1px 1px rgba(0, 0, 0, .20), 0 10px 22px -10px rgba(0, 0, 0, .50);
  --elev-3: 0 2px 8px rgba(0, 0, 0, .32), 0 30px 72px -16px rgba(0, 0, 0, .62);
  --elev-inset: inset 0 1px 3px rgba(0, 0, 0, .55), inset 0 0 0 1px rgba(0, 0, 0, .35);

  --r-panel: 12px;
  --r-card: 10px;
  --r-overlay: 16px;
```

插入 `styles.css:3135`（`html[data-theme="light"]` 收尾，`--k-blue-t` 之后）：

```css
  --surf-0: #e3e8f0;
  --surf-1: rgba(252, 253, 255, .74);        /* 合成 #f5f8fc */
  --surf-2: rgba(255, 255, 255, .90);        /* 合成 #fefeff */
  --surf-3: #ffffff;
  --surf-inset: rgba(15, 23, 42, .04);       /* 合成 #edf1f6 */
  --surf-hover: rgba(15, 23, 42, .04);
  --surf-sheen: linear-gradient(180deg, rgba(255,255,255,.92), rgba(255,255,255,.5) 30%, transparent 55%);
  --surf-blur-top: blur(24px) saturate(140%);

  --edge-hair: rgba(15, 23, 42, .065);       /* 今天 --line 是 1.37–1.51:1，这个是 1.14:1 */
  --edge-soft: rgba(15, 23, 42, .045);
  --edge-strong: rgba(15, 23, 42, .11);

  --seam-x: inset -6px 0 8px -6px rgba(15, 23, 42, .10), inset -1px 0 0 var(--edge-hair);
  --seam-x-r: inset 6px 0 8px -6px rgba(15, 23, 42, .10), inset 1px 0 0 var(--edge-hair);
  --seam-y: inset 0 -6px 8px -6px rgba(15, 23, 42, .08), inset 0 -1px 0 var(--edge-hair);

  --elev-1: 0 1px 2px rgba(15, 23, 42, .05);
  --elev-2: 0 1px 2px rgba(15, 23, 42, .05), 0 10px 24px -10px rgba(15, 23, 42, .14);
  --elev-3: 0 2px 6px rgba(15, 23, 42, .06), 0 30px 70px -16px rgba(15, 23, 42, .22);
  --elev-inset: inset 0 1px 2px rgba(15, 23, 42, .07), inset 0 0 0 1px rgba(15, 23, 42, .04);

  --r-panel: 12px; --r-card: 10px; --r-overlay: 16px;
```

插入 `styles.css:3408`（`html[data-fx="codex"]` 收尾）：

```css
  --surf-0: #0d1117; --surf-1: #151a21; --surf-2: #1d232b; --surf-3: #242c36; --surf-inset: #0a0e13;
  --surf-sheen: none; --surf-blur: none; --surf-blur-top: none;
  --elev-1: 0 1px 2px rgba(0, 0, 0, .32);
  --elev-2: 0 1px 2px rgba(0, 0, 0, .28), 0 4px 10px -4px rgba(0, 0, 0, .40);
  --elev-3: 0 2px 6px rgba(0, 0, 0, .34), 0 18px 48px -12px rgba(0, 0, 0, .55);
  --r-panel: 8px; --r-card: 6px; --r-overlay: 12px;
```

插入 `styles.css:3436`（`html[data-fx="codex"][data-theme="light"]` 收尾）：

```css
  --surf-0: #e3e8f0; --surf-1: #f5f8fc; --surf-2: #ffffff; --surf-3: #ffffff; --surf-inset: #edf2f9;
  --surf-sheen: none; --surf-blur-top: none;
  --elev-2: 0 1px 2px rgba(15, 23, 42, .05), 0 4px 10px -4px rgba(15, 23, 42, .10);
  --elev-3: 0 2px 6px rgba(15, 23, 42, .07), 0 18px 44px -10px rgba(15, 23, 42, .18);
  --r-panel: 8px; --r-card: 6px; --r-overlay: 12px;
```

顺手把两个老令牌改成别名（`styles.css:3-5` / `3381-3383` / `3110-3112` / `3410-3412`），让存量 400+ 处引用自动跟随新层级：

```css
  --bg: var(--surf-0);
  --bg2: var(--surf-1);
  --bg3: var(--surf-2);
  --well: var(--surf-inset);
```

> 注意顺序：`:root`(1) → `html[data-theme="light"]`(3108) → `html[data-fx="codex"]`(3380) → `html[data-fx="codex"][data-theme="light"]`(3409)。codex 的暗色块如果放到 light 前会盖掉浅色值，**不要调换**。

---

## 2. 信息层级（Typography & Ink）

### 2.1 角色表（深色；浅色只换颜色令牌，字号字重完全相同）

| 角色 | 令牌名 | 字号 | 字重 | 行高 | 字距 | 颜色 | 典型位置 | 与上一级的区分手段 |
|---|---|---|---|---|---|---|---|---|
| **V1 数值大字** | `--t-num-xl` | 26px | 650 | 1.05 | −0.02em | `--heading` | 看板 stat、设计器 stat 控件 | 字号 ×1.73 + 最亮色 |
| **V2 数值中字** | `--t-num-lg` | 20px | 650 | 1.15 | −0.01em | `--heading` | Dock 通道卡 `.chl-val` | 字号 ×1.6 + 最亮色 |
| **V3 数值小字** | `--t-num-md` | 15px | 600 | 1.2 | 0 | `--text` | 表格/列表里的数字 | 字重 +100 |
| **H0 窗口/页面标题** | `--t-h0` | 15px | 600 | 1.3 | +0.01em | `--heading` | `.brand`、`.page-head h2`、`.dsg-title`、`.board-head b` | 颜色（`--heading`）+ 字距 |
| **H1 分区标题** | `--t-h1` | 11px | 600 | 1.2 | **+0.10em** | `--text-dim` | `.pane-title`（控件箱/WIDGETS）、`.dock-tabs`、`.dsg-props-title` | **比正文更小更淡 + 拉开字距**（靠"安静"分层） |
| **H2 组标题** | `--t-h2` | 10.5px | 600 | 1.2 | +0.12em | `--text-dim` | `.dsg-group-head`、属性分组、`内置视图` | 字距 + 10.5px |
| **B 正文** | `--t-body` | 12.5px | 400 | 1.55 | 0 | `--text` | 列表项、表单、说明段 | 基准 |
| **B2 密排正文** | `--t-body-sm` | 12px | 400 | 1.45 | 0 | `--text` | 表格单元格、串口日志 | 行高更紧 |
| **C 次要说明** | `--t-cap` | 11px | 400 | 1.5 | 0 | `--text-dim` | 描述、提示、`.sw-d`、`.chl-empty` | 颜色降一档 |
| **U 单位** | `--t-unit` | 11px | 500 | 1 | +0.01em | `--text-dim` | `22.2` 后面的 `V` / `m/s` | **不同字号 + 不同色 + 400ms 基线对齐** |
| **N 标签/胶囊** | `--t-tag` | 10.5px | 600 | 1 | +0.04em | 语义色 | `.tag`、`.badge`、`.sev` | 语义色 |

### 2.2 硬规矩（可当 code review checklist）

1. **单屏字号档位 ≤ 4 档**（`ui-main` 现在同时可见 **10 / 11 / 12 / 13 / 19 / 20px 共 6 档**；收敛后全站只用 10.5 / 11 / 12 / 12.5 / 13 / 15 / 20 / 26 共 8 档，单屏 ≤ 4 档）。
2. **数值永远是它所在卡片里最大、最亮、唯一加粗的东西**。标题字号不得 ≥ 数值字号；单位不得与数值同字号同色。
3. **正文色阶只有 3 档**：`--heading`（标题/数值） > `--text`（正文） > `--text-dim`（说明）。同一块内最多用 2 档。
4. **等宽数字**：所有数值必须 `font-variant-numeric: tabular-nums`（已有 `.chl-val`/`.stat-card b` 满足，`.dsg-stat-value` 也满足；`.chl-head .nm` 里的计数不需要）。
5. **深色 `--text-dim` 必须提亮**：`#7b8794` 在新 L2 只有 **4.32:1**、L3 只有 **3.85:1**（AA 不达标）。改成 `#8b97a5`（L1 5.88 / L2 5.32 / L3 4.75）。改 `styles.css:3397`（codex）与 `:root --text-dim`。浅色 `#555f6b` 已达标（L0 5.12 / L2 6.49），不动。

### 2.3 分隔：哪些改用留白（**这是"太尖锐"的第二根钉子**）

| 位置 | 现在 | 改成 | 理由 |
|---|---|---|---|
| 分区标题条下（`.pane-title` / `.dock-tabs` / `.ctrl-head`） | `1px solid var(--line)` 全宽 38px 处 | **0 线**，改 `margin-bottom: 10px`（标题条 38→34px） | 全宽横线是硬切主犯；标题靠"更小更淡 + 字距"就已经分层 |
| 工具条 ↔ 图页标签 ↔ 凹槽 | 两条横线 + 凹槽外框（共 3 条硬边） | **0 线**，`8px` 留白 + 凹槽靠自身内阴影 | 三者同属 chrome 带，不该互相切 |
| 图页凹槽四周（`.chart-wrap`） | codex `1px --line`；glass 白 6% 内环 ×2 | **0 描边**，只留 `--surf-inset` 差值 + `--elev-inset` | 凹槽的定义是"低于周围"，不是"框起来" |
| 左控件箱右沿 / Dock 左沿 | `1px solid var(--line)` 全高 | **seam**（`--seam-x` / `--seam-x-r`），0 实线 | 全高直线是竖切主犯；seam 有 6px 渐变过渡，不再"锋利" |
| 通道卡之间 | `margin-bottom: 8px` + `1px --line` 边 | `8px` gap，**无边**，靠 L2 填充 + `--elev-2` | 卡片靠"浮起"分开，不靠线 |
| 通道卡内：标题 ↔ 数值 ↔ 单位 | 无分隔，靠字号 | 保持（`6px / 2px` 留白） | 卡片内不需要线 |
| Dock 页签条下 | `1px solid var(--line)` | **0 线** + `12px` 留白 | 页签条与内容同层（L1） |
| 设置项 / 表单行之间 | `1px --line` | `14px` 留白 | 表单分组靠留白与组标题 |
| 列表组（脚本、组件、扩展行） | `1px rgba(255,255,255,.06)` | 组间 `8px` 留白 + H2 组标题；组内**保留** `1px --edge-soft` | 长列表需要行分隔，但要淡 |
| 表格行（`tbody td`） | `1px rgba(15,23,42,.08)` | **保留**，改 `--edge-soft`（深 `.035` / 浅 `.045`）；hover 行 `--edge-hair` | 数据密度必须靠线，否则错行 |
| 顶栏下沿（`.topbar`） | `1px --line` | **保留 1px**，实现为 `--seam-y` 里的 `inset 0 -1px 0 var(--edge-hair)`（不再额外加 `border-bottom`） | 它是"窗口"与"内容"的分界，允许略硬，但只此一处 |
| 状态栏上沿 | `1px --line` | `1px --edge-soft` | 弱于顶栏 |

---

## 3. 边界处理原则（解决"太尖锐"）

### 3.1 优先级（从强到弱，**前 3 项是必须项**）

| 优先级 | 手段 | 具体数值 | 何时用 |
|---|---|---|---|
| **P1** | **底色差** | dark ΔL\* **4.0–4.6**；light ΔL\* **2.5–5.6**（L1→L2 只有 2.54 是浅色天花板，用 P2/P4 补） | **所有**相邻面板。缺这一项就是"同一个平面" |
| **P2** | **留白 / 缝隙** | 紧凑 `6px`、标准 `8px`、分区 `12px`、页面级 `24px`；缝隙露出 **L0** | 有空间就用它替代线（§2.3 表） |
| **P3** | **圆角** | 卡片 `--r-card`、浮层 `--r-overlay`、浮起整块 `--r-panel` | 相邻同级块；圆角让边界"断开"，视觉上不再是一条贯通直线 |
| P4 | **seam 内阴影** | `inset ±6px 8px -6px rgba(0,0,0,.45)` + `inset ±1px 0 var(--edge-hair)` | 边对边、不能加缝隙的竖直接缝（控件箱、Dock） |
| P5 | **发丝线** | `1px rgba(255,255,255,.055)`（dark）/ `rgba(15,23,42,.065)`（light）→ 1.16:1 / 1.14:1 | 必须贴边且需要"结束感"时；**不得全高、必须配圆角或 seam** |
| P6 | **外阴影** | `--elev-1/2/3`，只用于 L2 / L3，**按层递增，同层必须同参数** | 浮起物落地感 |
| **P7（禁止）** | **强调色边框当层级** | — | `--acc` 只允许出现在 focus / selected / 主操作，不得用于"这块和那块不一样" |

### 3.2 glass 与 codex 各自的表达边界

| | glass（液态玻璃） | codex（扁平简洁） |
|---|---|---|
| 层差的表达 | 半透明叠加（alpha 反解）+ 顶部 sheen（≤55% 高） | **纯色填充**，一层一个 hex，无渐变 |
| 描边 | 白 5.5%（L1/L2）→ 10%（L3）；**不再用 white .12** | `--line` 保留给**控件**（输入/按钮/表格）；面板边一律 `--edge-hair` 白 5.5% |
| 阴影 | 更长更软（L3 blur 72px） | 更紧更硬（L2 blur 10px、L3 blur 48px） |
| 模糊 | 只有 **L3 浮层**用 `blur(24px)`；L1 面板取消（背后只有 L0，无意义） | **全部取消** |
| 圆角 | 12 / 10 / 16 | 8 / 6 / 12 |
| 保留身份的关键 | sheen + 半透明 + 长阴影 | **紧阴影 + 1px 实线（控件层面）+ 小圆角**；绝不保留"面板无阴影" |

> codex 的"扁平"不等于"没有深度"：`styles.css:3449-3456` 把 **22 个选择器**的 `box-shadow` 全设为 `none`，这是 codex 层级塌陷的直接原因。扁平的表达是**短而硬的阴影**（`0 1px 2px`），不是零。

### 3.3 seam 配方（三种方向，直接可用）

```css
/* 竖向：左侧面板的右沿（控件箱、设计器控件库） */
.ctrl-switch { border-right: 0; box-shadow: var(--seam-x); }
/* 竖向：右侧面板的左沿（Dock、设计器属性） */
.workspace-dock { border-left: 0; box-shadow: var(--seam-x-r); }
/* 横向：顶栏下沿（唯一允许的横向硬边，用 seam-y 柔化。注意 1px 线已含在 seam-y 里，不要再加 border） */
.topbar { border-bottom: 0; box-shadow: var(--seam-y); }
```

原理：`inset -6px 0 8px -6px` 造一条 **6px 的暗角渐变**，视觉上读作"两块之间有一条沟"，比 0px 过渡的 1px 线柔和一档；1px 发丝线只有在沟底、且带 55% 白时才存在，于是它不再是"切"，而是"拼接缝"。

### 3.4 绝对禁止（会立刻回到"尖锐"）

- 任何 `border: 1px solid var(--line)` 出现在**面板级**容器上（`--line` 只给控件）。
- 1px 线贯穿某块面板的**整个高度/宽度**且两端无圆角、无渐变过渡。
- 凹槽用白色内环描边（`inset 0 0 0 1px rgba(255,255,255,.05)`）。
- 相邻两块面板的 `box-shadow` blur ≥ 24px（会在缝隙里叠成一层雾）。
- 同一块区域同时出现"填充色 + 边框色 + 阴影"三种不同强度的强调。

---

## 4. 逐界面落地（6 处）

> 每条格式：**现在的问题（含实测）→ 改成什么值 → 改哪个文件 / 选择器 / 行号**

### 4.1 左控件箱（220px）

| 元素 | 现在 | 改成 |
|---|---|---|
| 面板填充 `.ctrl-switch` | `--bg2 #151a21`（= 中央盘面同色，ΔL\* **0**） | `background: var(--surf-1)`（L1），**确保与中央同为 L1**——同层是对的，靠 seam 分区 |
| 右沿 | `border-right: 1px solid var(--line)`（1.28:1 全高直线） | `border-right: 0; box-shadow: var(--seam-x)` |
| `.pane-title`（控件箱 / WIDGETS） | 38px 高、12px/600 `--text`、`border-bottom: 1px --line` | `min-height: 34px; font-size: 11px; font-weight: 600; letter-spacing: .10em; color: var(--text-dim); border-bottom: 0; padding: 0 12px 0 14px;` + 容器 `margin-bottom: 10px` |
| `.pane-title .tag`（WIDGETS 小标签） | 10px `--acc` + `rgba(acc,.12)` 蓝底 | 无色底，`11px; color: var(--text-dim); opacity: .8;`（codex 已在 `3002-3008` 这么做过，glass 也照做） |
| `.sw-item`（内置视图 5 行） | 12→13px `--text`，`.sw-d` 11px `--text-dim`，行高 42px | 标题 `12.5px/400 --text`，`.sw-d` `11px/400 --text-dim`，`min-height: 40px`，`border-radius: 8px` |
| `.sw-item.active` | `background: rgba(acc,.10)` + `border-color: rgba(acc,.30)`（**底色+边框+左侧 3px 条 = 3 个强调**） | `background: var(--surf-2); border-color: transparent;`（浮起一层 L2）+ 保留左侧 2px `--acc` 条；文字 `--heading`。**删掉 acc 底色与 acc 边框** |
| `.sw-item:hover` | `var(--bg3)` | `background: var(--surf-hover)`（叠 4.5% 白，不改层） |
| `.sw-item .sw-ico` | `--bg3` 底 | `--surf-2`（未激活）/ `rgba(acc,.14)` + `--acc` 字（激活） |
| `.sw-list` padding | `6px` | `8px` |

文件：`assets/css/styles.css` — `147-157`（基础）、`222-284`（基础）、`2983-2995`（统一层）、`4537-4560`（固定工作区）、`3474-3475`（**codex 把发丝线改回 `--line`，删掉这两行里的 `.side-toolbar/.ctrl-switch`**）。

### 4.2 图页标签 + 工具条 + 凹槽

| 元素 | 现在 | 改成 |
|---|---|---|
| `.ctrl-head`（绘图控制条） | 38px 高 + `border-bottom: 1px --line`（codex `3474` 又改回 `--line`），底 `--bg2` | `background: transparent; border-bottom: 0; min-height: 36px; padding: 0 12px;` 与图页标签合并成一条 chrome 带 |
| 工具条按钮 | glass：每个都有 `--bg3` 实心底 + `--line` 边（一行 11 个方块，最吵） | 默认 `background: transparent; border-color: transparent; color: var(--text); padding: 4px 9px;`；hover `background: var(--surf-hover)`；把 codex **已有**的无边框工具条规则（`3543-3557`）提升为两种 FX 共用 |
| `.plot-tabs` | `padding: 6px 14px 0` | `padding: 4px 10px 6px; gap: 6px; min-height: 34px;` 无边框 |
| `.plot-tab`（未激活） | `border: 1px solid var(--line)`，`--text-dim` | `border: 1px solid transparent; background: transparent; color: var(--text-dim); height: 26px; border-radius: 7px;` |
| `.plot-tab.active` | `background: var(--well)`（**凹槽色**！+ `border-color: var(--acc)`） | `background: var(--surf-2); color: var(--text); border-color: var(--edge-hair); box-shadow: var(--elev-1);` **去掉 acc 边框**（acc 只留在 `.pt-count` 数字上） |
| `.chart-wrap`（凹槽） | glass：`--well` + 白色渐变 + `inset 0 0 0 1px rgba(255,255,255,.05)` + `inset 0 1px 0 rgba(255,255,255,.06)`；codex：`1px --line` + `--well #f6f7f9`（**浅色下比面板还亮，方向反了**） | `margin: 0 10px 8px; border-radius: var(--r-panel); border: 0; background: var(--surf-inset); background-image: none; box-shadow: var(--elev-inset);` 浅色同样走 `--surf-inset`（`#edf1f6`，比 L1 低 2.15 L\*） |
| 图表页脚 `.chart-foot` | `border-top: 1px --hairline` + 11px `--text-dim` | `border-top: 0; padding: 8px 14px 10px;` 靠 `10px` 留白 |

文件：`assets/css/styles.css` — `293-301`、`320-375`、`450-456`、`3043-3067`、`3594-3601`（codex chart-wrap）、`4591-4594`。

### 4.3 Dock（280）与通道卡

| 元素 | 现在 | 改成 |
|---|---|---|
| `.workspace-dock` | `--bg2` + `border-left: 1px --line` | `background: var(--surf-1); border-left: 0; box-shadow: var(--seam-x-r);` |
| `.dock-tabs`（数据 / AI） | `--bg3` 底 + `border-bottom: 1px --line`（一条独立色带 = 第 3 个平面） | `background: transparent; border-bottom: 0; height: 36px;` + `margin-bottom: 12px` |
| `.dock-tab.active` | `rgba(acc,.10)` 底 + `rgba(acc,.35)` 边 + `--acc` 字（3 个强调） | `background: var(--surf-2); border-color: var(--edge-hair); color: var(--heading); box-shadow: var(--elev-1);` 图标 `span` 用 `--acc`；**删 acc 底与 acc 边** |
| `.chl-tabs`（原始数据 / 脚本数据） | 玻璃渐变 + 白 11% 边 + blur（Dock 里最"滑"的一块） | 做成 `--surf-inset` 底的段控件：容器 `background: var(--surf-inset); border: 0; padding: 3px; gap: 3px;`；激活项 `background: var(--surf-2); box-shadow: var(--elev-1);`；取消 filter/blur |
| `.chl`（通道卡） | `background: rgba(19,27,36,.5)` **合成正好等于面板色 `#151a21`（ΔL\* 0.00，实测 ratio 1.00）** + `1px --line` | `background: var(--surf-2); border: 1px solid var(--edge-hair); border-radius: var(--r-card); box-shadow: var(--elev-2); padding: 10px 12px; margin-bottom: 8px;` → ΔL\* **+4.40** |
| `.chl` hover | 无 | `background: var(--surf-2); box-shadow: var(--elev-2);` + `filter: brightness(1.06)`；**不要改边框色**（改边框会跳） |
| `.chl.hidden-ch` | `opacity: .48` | `opacity: .4` + `filter: saturate(.35)`（隐藏态更明确，同时不破坏层差） |
| `.chl-head .nm` | `13px/600 --text` | `12.5px/600 --text`（H0 比卡片标题重，卡片标题不该跟数值抢） |
| `.chl-val`（数值） | `20px/700`，颜色继承 `--text`（**和标题同色**） | `20px/650; color: var(--heading); font-variant-numeric: tabular-nums; letter-spacing: -.01em; margin-top: 6px;` |
| `.chl-val small`（单位） | `11px --text-dim` | `11px/500 --text-dim; margin-left: 4px;`（保持；补 `vertical-align: baseline`） |
| `.chl-addrow` | `border-top: 1px --line` | `border-top: 0; padding: 10px 10px 12px;` |
| `.chl-list` | `padding: 8px` | `padding: 8px 10px 12px` |

文件：`assets/css/styles.css` — `782-816`、`1899-1914`、`3072-3095`、`3703-3707`、`4596-4684`。

### 4.4 设计器（弹层三栏：控件库 208 / 栅格 / 属性 286）

> CSS 在 TS 里：`src/designer/designer.ts:85-205`。**改完必须 `npm run build:core`**（产物 `assets/js/core.bundle.js`）。

| 元素 | 现在 | 改成 |
|---|---|---|
| `.dsg-shell` | `linear-gradient(bg2→bg)` + `1px --line` + `r16` + `0 40px 110px rgba(0,0,0,.66)` | `background: var(--surf-1); border: 1px solid var(--edge-strong); border-radius: var(--r-overlay); box-shadow: var(--elev-3);`（它是 L3 浮层，不是 L1） |
| `.dsg-head`（标题条） | 渐变高光 + `border-bottom: 1px --hairline` | `background: transparent; border-bottom: 0;` + `margin-bottom: 12px` |
| `.dsg-palette`（左控件库） | `rgba(255,255,255,.012)` 罩在 shell 渐变上（≈与 shell 同色）+ `border-right: 1px --hairline` | `background: var(--surf-1); border-right: 0; box-shadow: var(--seam-x); padding: 8px 10px 24px;` |
| `.dsg-canvas-wrap`（中栅格） | `--bg #0d1117`（**比两侧都暗 → 中间是个洞**）+ 顶部渐变 + 点阵 | `background: var(--surf-inset); background-image: radial-gradient(circle at 1px 1px, var(--edge-hair) 1px, transparent 0) 0 0/24px 24px; padding: 16px;` → 中间是"挖下去的桌面"，正确 |
| `.dsg-canvas`（画板 sheet） | `border: 1px dashed rgba(255,255,255,.07)` + `r14`（画布中间一条虚线硬框） | **画板浮起**：`background: var(--surf-1); border: 0; border-radius: var(--r-card); box-shadow: var(--elev-2); padding: 12px;` 去掉虚线 |
| `.dsg-cell`（控件格） | `--bg2` + `1px rgba(255,255,255,.075)` + `0 8px 26px rgba(0,0,0,.22)` | `background: var(--surf-2); border: 1px solid var(--edge-hair); border-radius: var(--r-card); box-shadow: var(--elev-1);` hover：`border-color: var(--edge-hair)` 不变、`box-shadow: var(--elev-2)` |
| `.dsg-cell.is-selected` | `border-color: --acc` + `inset 0 0 0 1px --acc` + 阴影 | `box-shadow: 0 0 0 1.5px var(--acc), var(--elev-2);`（acc 只出现在选中，符合 P7） |
| `.dsg-props`（右属性） | `rgba(255,255,255,.012)` + `border-left: 1px rgba(255,255,255,.07)` | `background: var(--surf-1); border-left: 0; box-shadow: var(--seam-x-r);` |
| `.dsg-props-title` / `.dsg-group-head` | sticky 底写死 `--bg2` | sticky 底 `var(--surf-1)`；标题 `11px/600/.10em --text-dim`，组标题 `10.5px/600/.12em --text-dim` |
| `.dsg-field label` | `11px --text-dim` | 保持，补 `letter-spacing: .02em` |
| `.dsg-stat-value` | `28px/600 --text` | `26px/650 --heading; letter-spacing: -.02em;`（与 §2.1 V1 对齐） |
| `.dsg-stat-unit` | `12px --text-dim` | `11px/500 --text-dim` |
| `.dsg-empty-note` | `1px dashed --line` + `--bg3` | `border: 1px solid var(--edge-hair); background: var(--surf-2); border-radius: var(--r-card);` 去掉 dashed |

### 4.5 看板（全屏卡片栅格）

> CSS 在 `src/designer/board.ts:21-55`。同样需要 `npm run build:core`。

| 元素 | 现在 | 改成 |
|---|---|---|
| `.board-mask` / `.board-stage` | `--bg` + `radial-gradient(1400px 700px at 50% -12%, rgba(56,120,180,.10), transparent 62%)` —— 蓝色光把**背景抬高**，直接吃掉与卡片的层差 | `.board-mask { background: var(--surf-0) }`；`.board-stage { background: radial-gradient(1200px 600px at 50% -10%, rgba(var(--acc-rgb), .05), transparent 60%), var(--surf-0); padding: 56px 24px 24px }` |
| `.board-canvas` gap | `12px` | `14px` |
| `.board-canvas .dsg-cell`（看板卡） | `1px rgba(255,255,255,.055)` + `linear-gradient(白 .035/.012)` + `0 8px 26px rgba(0,0,0,.22)` + `r12` | `background: var(--surf-2); border: 1px solid var(--edge-hair); border-radius: var(--r-card); box-shadow: var(--elev-2);` 去掉渐变（渐变把卡片中心压回 L1：实测卡片 `#181d23` vs 页面 `#141920`，ΔL\* 只有 **2.0** → 改后 **+8.5**，因为看板是"整屏墙面"，页面用 L0、卡片直接跳 L2，中间不留 L1，见 §6.1 M1 附注） |
| `.board-canvas .dsg-stat-title` | `clamp(11px,1.5vh,15px)` + `.04em`，色 `--text-dim` | `clamp(11px,1.4vh,13px)/600; letter-spacing: .06em; color: var(--text-dim)` |
| `.board-canvas .dsg-stat-value` | `clamp(24px,7vh,58px)`，色继承 `--text` | `clamp(26px,7vh,58px)/650; color: var(--heading); letter-spacing: -.02em;` |
| `.board-canvas .dsg-stat-unit` | `clamp(12px,1.8vh,18px)` | `clamp(11px,1.6vh,15px)/500 --text-dim` |
| `.board-head`（顶部条，idle 显示） | `linear-gradient(rgba(6,10,16,.86) → transparent)` 渐隐条 + 文案 13.5px | 换成实心 L1 条：`background: var(--surf-1); border-bottom: 1px solid var(--edge-soft);` 保留 `opacity` 过渡（不要渐变，渐变叠在卡片上会砍出一条硬边） |
| `.board-head button` | `--bg2` 底 + `--line` 边 | `background: transparent; border: 1px solid var(--edge-hair);` hover `background: var(--surf-hover)` |
| `.board-tip`（底部提示胶囊） | `--bg2` + `1px --line` + `r999` | `background: var(--surf-3); border: 1px solid var(--edge-strong); box-shadow: var(--elev-2);`（它是浮层，跟页面要分开） |
| `.board-empty` | 13px `--text-dim` | 保持，补 `line-height: 1.7`；建议挂一个 L2 空态卡（与 `.chart-empty-card` 同材质） |

### 4.6 命令面板（+ 扩展管理 / 配置面板同一个壳）

> CSS 在 `src/ui/shell.ts:20-83`。**改完必须 `npm run build:core`**。

| 元素 | 现在 | 改成 |
|---|---|---|
| `.xhgcs-mask`（遮罩） | `rgba(3,7,13,.55)` + `blur(2px)` | `background: rgba(3, 7, 13, .62); backdrop-filter: blur(3px);`（浅色 `.30`）。**L3 必须带遮罩**，这是浅色 L2/L3 同底色的唯一解法 |
| `.xhgcs-palette` | `linear-gradient(bg2 → bg)`（**从 L1 渐变到 L0，比它盖住的面板还暗 = 读成"洞"而不是"最上层"**）+ `1px --line` + `r14` + `0 32px 80px rgba(0,0,0,.5)` | `background: var(--surf-3); border: 1px solid var(--edge-strong); border-radius: var(--r-overlay); box-shadow: var(--elev-3); backdrop-filter: var(--surf-blur-top);`（glass 额外 `inset 0 1px 0 var(--glass-highlight)`） |
| `.xhgcs-palette-search` | `background: var(--bg3)` + `border-bottom: 1px --hairline`（浮层里又嵌了一个平面） | `background: transparent; border-bottom: 1px solid var(--edge-soft);` |
| `.xhgcs-palette input` | `50px` 高、14px、`--heading` | 保持字号；`height: 52px;`（唯一可点区域足够大，符合 44px 触控底线） |
| `.xhgcs-palette-item` | `r9`，正文 13px `--text` | `border-radius: 8px; font-size: 12.5px; padding: 9px 12px;` |
| `.xhgcs-palette-item[data-active="1"]` | `rgba(acc,.16)` 底 + `rgba(acc,.35)` 边 + 左侧 2px acc 条（**3 个强调同时出现**） | `background: var(--surf-hover); border-color: transparent; color: var(--heading);` + 保留左侧 2px `--acc` 条。**删 acc 底与 acc 边** |
| `.xhgcs-palette-cat`（分类胶囊） | `--acc` 字 + `rgba(acc,.10)` 底 + `rgba(acc,.32)` 边（每行一个蓝色药丸） | `color: var(--text-dim); background: transparent; border-color: var(--edge-hair);` 只在 active 行变 `--text` |
| `.xhgcs-palette-item small`（命令 id） | `--text-dim` 11px mono | 保持，`opacity: .7` |
| `.xhgcs-palette-foot` | `background: var(--bg3)` + `border-top: 1px --hairline`（第 3 个平面） | `background: transparent; border-top: 1px solid var(--edge-soft);` |
| `.xhgcs-palette-foot kbd` | `rgba(255,255,255,.06)` 底 + `rgba(255,255,255,.14)` 边 | `background: var(--surf-2); border: 1px solid var(--edge-hair);` |
| `.xhgcs-panel`（扩展管理/配置） | `--bg2` + `--line` + `r14` + `0 24px 64px rgba(0,0,0,.55)` | 同 `.xhgcs-palette`：`var(--surf-3)` / `var(--edge-strong)` / `var(--r-overlay)` / `var(--elev-3)` |
| `.xhgcs-ext`（扩展行） | `border-bottom: 1px rgba(255,255,255,.06)` | `border-bottom: 1px solid var(--edge-soft);` + `padding: 12px 4px` |
| `.xhgcs-empty` | 12.5px `--text-dim` | 保持 |

### 4.7 其余三处（一句话版）

- **Toast**（`styles.css:1557-1575`）：`#1b3541` 硬编码底 + `rgba(acc,.45)` 边 → `background: var(--surf-3); border: 1px solid var(--edge-strong); box-shadow: var(--elev-2); border-radius: var(--r-card);` 文字 `--heading`；`.err/.ok` 只改**左边 2px 语义条**，不改整圈边。
- **空态卡 `.chart-empty-card`**（`styles.css:5072-5092`）：已经是 L3 材质（`--glass-bg` + `--shadow-pop`），只补 `background: var(--surf-3); border: 1px solid var(--edge-strong); box-shadow: var(--elev-3);`，标题 14→`15px/600 --heading`。
- **顶栏 / 状态栏**：`background: var(--surf-1); border-bottom: 0; box-shadow: var(--seam-y);`（`styles.css:88-97`、`3043`；1px 线已含在 `--seam-y` 内，不要再写 `border-bottom`）；状态栏底 `--surf-1`、上沿 `1px --edge-soft`。顶栏里 `.source-toggle` 胶囊降为 `--surf-2` 底 + `--edge-hair` 边，`--acc` 只留在 LED 与文字。

---

## 5. 双主题 × 双 FX 映射表

### 5.1 层级映射（一张表看全）

| 层 | dark · glass | dark · codex | light · glass | light · codex |
|---|---|---|---|---|
| **L0** 窗底 | `#0d1117`（`--bg`） | `#0d1117` | `#e3e8f0` | `#e3e8f0` |
| **L1** 面板 | `rgba(24,30,37,.72)` → **#151a21** ｜ sheen 顶 55% ｜ blur 无 | `#151a21` ｜ 纯色 ｜ blur 无 | `rgba(252,253,255,.74)` → **#f5f8fc** ｜ sheen | `#f5f8fc` ｜ 纯色 |
| **L2** 卡片 | `rgba(30,37,45,.86)` → **#1d232b** ｜ `--elev-2`（blur 22） | `#1d232b` ｜ `--elev-2`（blur 10） | `rgba(255,255,255,.90)` → **#fefeff** ｜ `--elev-2`（blur 24） | `#ffffff` ｜ `--elev-2`（blur 10） |
| **L3** 浮层 | `rgba(37,45,55,.92)` → **#242c36** ｜ `--elev-3`（blur 72）｜ **blur(24px)** | `#242c36` ｜ `--elev-3`（blur 48）｜ blur 无 | `#ffffff` ｜ `--elev-3`（blur 70）｜ **blur(24px)** + 遮罩 `.30` | `#ffffff` ｜ `--elev-3`（blur 44）｜ blur 无 + 遮罩 `.30` |
| **凹槽** 屏幕面 | `rgba(2,5,9,.55)` → **#0b0e14** ｜ `--elev-inset` | `#0a0e13` ｜ `--elev-inset` | `rgba(15,23,42,.04)` → **#edf1f6** ｜ `--elev-inset` | `#edf2f9` ｜ `--elev-inset` |
| **描边** L1 / L2 / L3 | 白 .055 / .055 / .10 | 白 .055 / .055 / .10 | 墨 .065 / .065 / .11 | 墨 .065 / .065 / .11 |
| **圆角** L1 / L2 / L3 | 12 / 10 / 16 | 8 / 6 / 12 | 12 / 10 / 16 | 8 / 6 / 12 |
| **层差** | +4.11 / +4.40 / +4.20（L\*） | 同左 | +5.63 / +2.54 / 0 | 同左 |

### 5.2 材质差异清单（两种 FX 各自**必须保留**的身份）

| 维度 | glass 保留 | codex 保留 |
|---|---|---|
| 半透明 | ✅ 面板/卡片半透明（alpha 已按合成反解） | ❌ 纯色 hex |
| 顶部高光 sheen | ✅ 但只到 55% 高（旧版全高平均抬 +6.3 L\*，吃掉层差） | ❌ 无 |
| 模糊 | 仅 L3（`blur(24px) saturate(150%)`）+ body 极光 | ❌ 全无 |
| 阴影长度 | 长而软：L2 blur 22、L3 blur 72 | 短而硬：L2 blur 10、L3 blur 48（**但绝不删**） |
| 描边 | 白 5.5%（L1/L2）→ 10%（L3） | 面板边白 5.5%；**控件的 `--line` 实线保留**（输入/按钮/表格） |
| 圆角 | 12 / 10 / 16 | 8 / 6 / 12 |
| 背景氛围 | body 极光（`.55` 不透明），浅色下 `opacity: .8 → .35` | 无（`body::before/after` 已 `display:none`） |
| 交互过渡 | 保留颜色 + 背景 + 阴影过渡（180ms） | 只保留颜色/背景过渡（150ms，现状）`styles.css:3444-3446` |

### 5.3 语义/强调色在两套 FX 里的对应关系

| 令牌 | glass dark | codex dark | 用途 | 是否参与层级 |
|---|---|---|---|---|
| `--acc` | `#6da8d2` | `#4a9aec` | focus / selected / 主操作 / 左侧 2px 条 | ❌ 禁止 |
| `--acc-rgb` | `56,189,248` | `74,154,236` | 所有带透明的强调 | ❌ |
| `--acc-text` | `#bfe7ff` | `#7cc0ff` | 激活态文字 | ❌ |
| `--heading` | `#e6f2ff` | `#e8edf3` | H0 / 数值 | ✅（信息层） |
| `--text` | `#c9d4e0` | `#ccd4de` | 正文 | ✅ |
| `--text-dim` | `#8b97a5`（**从 `#7b8794` 提亮，AA 需要**） | `#8b97a5`（同上） | 说明 / H1 / 单位 | ✅ |
| `--line` | `#2d333b` → **只给控件** | `#272e37` → **只给控件** | 输入框/按钮/表格 | ❌ |
| `--edge-hair` | `rgba(255,255,255,.055)` | 同 | 面板/卡片边 | ✅ |

---

## 6. 验收判据

### 6.1 可测量项（逐条可自动/半自动核查）

取点方法：`npm run web` → 截图 1600×950（`deviceScaleFactor:1`），**关闭 body 极光**取一次（用于量底色），再开启取一次（用于看整体）。取样点避开文字与曲线，取元素**垂直中心、水平中心**（避开顶部 sheen）。L\* = CIE Lab 明度，换算用 `sRGB → linear → Y → L*=116·Y^(1/3)−16`。

| # | 指标 | 阈值 | 怎么量 |
|---|---|---|---|
| **M1** | 相邻层亮度差 ΔL\* | dark：L0→L1、L1→L2、L2→L3 均 ∈ **[4.0, 6.0]**；light：L0→L1 ∈ **[4.5, 6.0]**、L1→L2 ∈ **[2.2, 3.2]** | 取 L0 缝隙 / L1 面板 / L2 卡片 / L3 浮层各一点算 L\* |
| **M1′** | 跳层（中间层缺席时） | 允许直接 L0→L2（看板这类整屏墙面），总落差 ≤ **9.0** L\*（dark）/ ≤ **8.5**（light）；但**同一屏内不得出现 4 层** | 看板 / 全屏视图 |
| **M2** | 凹槽方向与深度 | 凹槽 **必须比其父层低**：dark ΔL\* ∈ **[−5.5, −3.0]**；light ∈ **[−2.8, −1.5]** | 图表区中心 vs 其所在面板 |
| **M3** | 面板/卡片描边强度 | dark 白 α ≤ **.055**（浮层 ≤ .10）；light 墨 α ≤ **.065**（浮层 ≤ .11）。对底色的对比 ≤ **1.20:1** | 读 CSS 声明即可（不依赖取色） |
| **M4** | 阴影按层分级 | L1 blur ≤ **4px**；L2 blur ∈ **[10, 24]**；L3 blur ≥ **40px**。同层所有元素参数**完全一致**（±0） | 读 CSS；`--elev-*` 只有 3 个引用点 |
| **M5** | 留白节奏 | 同一容器内间距取自 `{4, 6, 8, 12, 16, 24}`；**跨组间距 ≥ 1.5 × 组内间距** | 量 DOM（`getBoundingClientRect`）或读 CSS |
| **M6** | 同屏层数上限 | 可见"填充层" ≤ **3**（L1+L2+凹槽 或 L0+L1+L2）；L0 只允许以缝隙形式出现；L3 出现时**必须带遮罩 α ≥ .50** | 人工 + 截图 |
| **M7** | 焦点数量 | 一屏内 `--acc` **实心/描边**元素 ≤ **1**（不含 focus-visible 与状态点）；每张卡片 ≥ 18px 的文字 ≤ **2** 个 | 数 `--acc` 使用点 |
| **M8** | 文字对比度 | 正文/说明 ≥ **4.5:1**（在它所处的**最亮**层上测），大字号/图标 ≥ **3:1**；`--text-dim` 在 L3 上 ≥ **4.5:1**（现 `#7b8794` 只有 3.85 → 必须提亮到 `#8b97a5`） | 算对比度 |
| **M9** | 玻璃高光不侵蚀层差 | 面板**中心**比其底色令牌亮 ≤ **+1.5 L\***；sheen 只存在于顶部 ≤ 55% 高度 | 取面板上/中/下三点 |
| **M10** | 全高硬线清零 | `styles.css` 中面板级容器（`.topbar`/`.ctrl-switch`/`.channels`/`.workspace-dock`/`.ctrl-head`/`.pane-title`/`.dock-tabs`/`.chl`/`.chart-wrap`/`.dsg-*`/`.board-*`）**不得**出现 `border-{top,right,bottom,left}: 1px solid var(--line)`；只允许 `var(--edge-*)` | `grep` |

### 6.2 一票否决（命中任意一条 = 返工）

1. **两个相邻面板底色完全相同（ΔL\* < 2.0，肉眼几乎不可分）**，只靠 1px 线或不同颜色的边框区分（本规范目标值是 4.0–4.6）。
2. **面板级容器上出现 `1px solid var(--line)`**，或出现贯穿整条边、无圆角无渐变过渡的实线。
3. **同屏出现 4 个及以上填充层**，或 L3 浮层背后没有遮罩（α < .50）。
4. **L1 面板挂 blur ≥ 24px 的外阴影**（缝隙会被阴影填满 → 又变成一层雾）。
5. **同一处同时用"填充 + 边框 + 阴影"三种强调**（例如 `rgba(acc,.16)` 底 + `rgba(acc,.35)` 边 + 左侧 acc 条）。
6. **凹槽比父层更亮**（浅色 codex 现在就是这个 bug：`--well #f6f7f9` 比面板 `#ffffff` 亮）或凹槽带白色内环描边。
7. **数值与标题同色同重**，或单位与数值同字号。
8. **`--text-dim` 在它所处的层上 < 4.5:1**（AA 硬线）。
9. **`--acc` 被当作层级手段**（"这块用蓝边表示更重要"）。
10. **新增类名只被 `.ts` 引用**（`tools/audit.cjs` 会判"CSS 未引用类"，`npm test` 直接红）。

### 6.3 自查流程

```bash
# 1) 静态检查（不启动浏览器）
npm run audit

# 2) 改完 TS 里的内联 CSS 必须重建
npm run build:core

# 3) 缓存串（Electron immutable cache）
node tools/bump-version.cjs 20261027A

# 4) 四种组合各截一张：dark/light × glass/codex
#    + 设计器 / 看板 / 命令面板 各一张
npm run web     # http://127.0.0.1:8123

# 5) 回归
npm test
```

对照检查清单（人工 30 秒）：把截图缩小到 25%，**眯眼**看——应该能看到「一个安静的壳 + 几个浮起的卡片 + 一块更深的屏幕」，而不是「一堆同样亮度的方框 + 满屏细线」。

---

## 7. 落地顺序与工作量

| 批次 | 内容 | 文件 | 风险 | 建议 |
|---|---|---|---|---|
| **P0**（半天） | 4 组层级令牌 + `--bg/--bg2/--bg3/--well` 别名 + `--text-dim` 提亮 | `styles.css:3-5/45/3110-3135/3380-3436` | 低（只加变量） | 先做，后面全部依赖它 |
| **P1**（1 天） | 删 codex 的"全关阴影"和"分隔线回 --line"两段；`.topbar/.ctrl-switch/.channels/.workspace-dock/.pane-title/.ctrl-head/.dock-tabs` 换成 L1 + seam | `styles.css:3448-3456、3473-3475、2983-3095` | 中（面广但都是单行） | 肉眼立刻改观的一批 |
| **P2**（1 天） | 通道卡 / 图页标签 / 凹槽 / 命令面板 → L2、L3、inset | `styles.css:782-816、320-375、450-456、3060-3067、3594-3601`；`src/ui/shell.ts:20-83` | 中 | 需要 `build:core` |
| **P3**（1 天） | 设计器三栏 + 看板卡片 | `src/designer/designer.ts:85-205`、`src/designer/board.ts:21-55` | 中 | 需要 `build:core` |
| **P4**（半天） | 字号字重收敛 + 分隔改留白 + 焦点收口（acc 从 5 处降到 ≤1） | 分散 | 低 | 最后做，用 §2 的 checklist 逐条勾 |

**不建议**同时改的（避免和层级混在一起看不清回归）：面板宽度、图标、动效曲线、任何交互语义。

---

## 附录 A · 迁移对照表（旧令牌 → 新令牌）

| 旧 | 新 | 备注 |
|---|---|---|
| `--bg` | `--surf-0` | 只在缝隙/凹槽边缘可见 |
| `--bg2` | `--surf-1` | 面板（顶栏/活动栏/控件箱/中央/Dock/状态栏/设计器） |
| `--bg3` | `--surf-2` | 卡片、激活项底盘、图标底盘 |
| （无） | `--surf-3` | **新增**：浮层 |
| `--well` | `--surf-inset` | 凹槽；浅色必须比面板暗（现 codex 浅色是反的） |
| `--line` | `--edge-hair`（面板/卡片）／保留 `--line`（控件） | 关键拆分 |
| `--hairline` | `--edge-hair` | 值从白 .075（glass）/ .07（codex）/ 浅色墨 .09 降到统一的白 .055 / 墨 .065 |
| `--glass-line` | `--edge-hair` / `--edge-strong` | 不再用白 .12 |
| `--shadow-pop` / `--shadow-modal` | `--elev-2` / `--elev-3` | codex 里 `--shadow-pop` 目前只给了画布节点/tooltip/Toast/空态卡 4 处（`3606/3629/3652/5080`），要扩到**所有** L2 |
| 硬编码 `0 12px 32px rgba(0,0,0,.22)`（`2659-2662` 每块面板都有） | `--elev-1` | 面板不该有 32px 大阴影 |

## 附录 B · 本次未改动但建议下一轮处理

1. `.dsg-cell-head` 悬停才显形的操作条（`designer.ts:148-152`）在 L2 上叠 `rgba(255,255,255,.06)`，建议改成叠在卡片外沿的浮层条，避免卡片内部出现第二层。
2. 图表 tooltip（`styles.css:469-487`）硬编码 `rgba(13,17,23,.94)` + `rgba(acc,.35)` 边 → 应改成 L3 全套（本次已列入 §4.7 的一句话，未给逐行）。
3. 右键菜单 `.plot-menu`（`379-390`）：`--bg2` + `--line` + `0 10px 28px` → 建议直接升 L3（它是浮层）。
4. 串口日志区 `.serial-body` 的语义色（蓝/绿/黄）在浅色下对比度偏紧，属下一轮无障碍专项。
