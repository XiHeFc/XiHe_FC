---
name: xhgcs-view
description: 生成、修改或修复 XiHe_GCS 可视化视图插件（自定义视图 / 左侧仪表视图栏 / 数据可视化界面）时使用。规范插件接口、画风令牌与交付前自检，保证生成的图面与软件本体的液态玻璃配色、字体、间距完全一致。
---

# XiHe_GCS 可视化视图插件规范

用途：让「AI 生成的可视化视图」接口统一、画风跟软件本体一致、并且交付前能自己验证效果。
适用范围：`state.views` 里的自定义视图插件（左侧竖列仪表视图栏、`＋ 自定义视图`、MCP `create_view`）。
不在范围：可复用计算组件（`state.components`，见 xhgcs Skill 的 `create_component`）、分析画布节点、内置视图（wave/bar/table/gauge/map）。

## 1. 硬契约（违反即被 lint 判错）

1. `code` 是**一个 JS 表达式**，求值必须返回对象：
   `({ id:"唯一id", mount(ctx){...}, update(ctx){...}, resize(ctx){...}, unmount(ctx){...} })`
   只有 `id` 和 `mount(ctx)` 是必需的；`build/install` 不是接口的一部分，别写。
2. 只用 `ctx` + 浏览器原生 API。**禁止** `fetch` / `import()` / `require` / `XMLHttpRequest` / `localStorage`。
3. **禁止** `setInterval` / `setTimeout`：用 `ctx.interval(fn, ms)` / `ctx.frame(fn)`，卸载时会自动清理。
4. 不在 `document` 上全局查询元素，只在自己 `ctx.host` 里找；不自己处理 `devicePixelRatio`，走 `ctx.ensureCanvas`。
5. `mount` 里建 DOM 并存到 `ctx`，`update` 只刷新（框架按 `def.interval` 节流，默认 100ms）。**不要每帧重建 DOM**（输入框会掉光标、列表会闪）。
6. `ctx.ensureCanvas(canvas)` 宿主太小时返回 `null`，必须 `if (!info) return;`，否则切换视图/折叠面板时抛异常。

## 2. ctx API 全表

| API | 说明 |
| --- | --- |
| `ctx.host` | 视图容器（`div.view-plugin-host`），尺寸用 `clientWidth/clientHeight` |
| `ctx.theme()` | 画风令牌对象，见第 3 节。**所有颜色和字体都从这里取** |
| `ctx.cssVar(name, fallback)` | 读界面 CSS 变量，如 `ctx.cssVar('--acc')` |
| `ctx.channels()` | 原始 + 脚本通道 |
| `ctx.rawChannels()` / `ctx.scriptChannels()` | 只看原始 / 只看脚本输出 |
| `ctx.findChannel(id或名称)` | 单个通道 |
| `ctx.ensureCanvas(canvas)` | 按 DPR 适配，返回 `{ctx,w,h}` 或 `null` |
| `ctx.draw.plot()` | **受控画布槽**：返回 `{canvas, holder}`，尺寸自动填满宿主，先建它再画 |
| `ctx.draw.scope(canvas, opts)` | 折线/示波器原语（自动量程 + 图例 + 刻度 + 抽稀 + 裁切） |
| `ctx.draw.bars(canvas, opts)` | 横向条形原语（名字列先量宽再定条起点，数值不越界） |
| `ctx.draw.donut(canvas, opts)` | 占比环原语（环 + 中心合计 + 右侧占比列表） |
| `ctx.pick(spec, limit)` | 按名字子串 / id 数组 / `"*"` 选通道 |
| `ctx.series(spec, limit)` | 选通道并整理成 `{ch,name,unit,color,data,value}` |
| `ctx.latest(ch)` | 通道最后一个采样值（数字） |
| `ctx.axisText(v)` | 坐标轴数字格式化（跟着界面规则走） |
| `ctx.formatValue(ch, v)` | 带单位的值文本 |
| `ctx.esc(v)` | HTML 转义（拼 innerHTML 时用） |
| `ctx.on(el, type, fn)` | 事件绑定，卸载自动解绑 |
| `ctx.interval(fn, ms)` / `ctx.frame(fn)` | 定时/动画，卸载自动清理 |
| `ctx.toast(msg)` | 应用内提示 |
| `ctx.state` | 全局状态（`state.channels` / `state.alarms` / `state.serial` …） |
| `ctx.uid(prefix)` | 生成唯一 id |
| `ctx.views` | `XHGCS_VIEWS` 命名空间（`listViews/activateView/viewApiDoc/viewDomClasses`） |

通道对象字段：`id, name, unit, color, range([min,max]), visible, data(数字数组，最新值在末尾)`。

### 2.1 首选路径：绘图原语（生成视图默认走这条）

**为什么有这个**：让模型逐行手写「坐标轴画在哪、图例多宽、量程取多少、文字会不会被裁」，得到的必然是图例被裁掉、曲线挤成一条线、画布撑破宿主。这些排版算术已经收进 `XHGCS_VIEW_KIT`（`assets/js/view-kit.js`），插件只描述**画什么**，不描述**每个像素放哪**。

```js
// 三轴自由视图：多通道折线
({ id: "scope3", mount(ctx){ ctx.plot = ctx.draw.plot(); },
  update(ctx){ ctx.draw.scope(ctx.plot.canvas, { series: "温度", limit: 4, value: true, time: true }); } })

// 通道排行：横向条形
({ id: "rank", mount(ctx){ ctx.plot = ctx.draw.plot(); },
  update(ctx){ ctx.draw.bars(ctx.plot.canvas, { series: "*", limit: 10 }); } })

// 颗粒物占比：环形
({ id: "pm3", mount(ctx){ ctx.plot = ctx.draw.plot(); },
  update(ctx){ ctx.draw.donut(ctx.plot.canvas, { series: ["PM2.5","PM10","PM1.0"], centerText: "颗粒物" }); } })
```

参数速查（全部可选，除 `series` 外都有合理默认）：

| 选项 | 适用 | 说明 |
| --- | --- | --- |
| `series` | 三者 | `"温度"`（名字子串，中英文/大小写不敏感）/ `["wed-07","wed-02"]`（id 列表）/ `"*"`（全部可见通道） |
| `limit` | 三者 | 最多画几条。**多通道折线必须写**（3~6 条），否则 20 个通道全挤进来 |
| `yRange` | scope / bars | 手动量程 `[min,max]`，不写就按当前可见窗口自动量程 |
| `normalize` | scope | `true` 时每条曲线按自身窗口量程铺满绘图区；不同量纲（电压 / 角度 / 距离）混画时必须开 |
| `value` / `time` / `dot` | scope | 是否显示右侧数值图例（默认 true）/ 是否画时间轴（默认 true）/ 是否画末端点 |
| `legend` | scope | 默认 `"right"`：右侧列通道名 + 当前值 + 单位。**不要随手关**——用户要「显示当前值」时关掉图例就等于没做；只有明确要求「只要曲线」才写 `"none"` |
| `perPoint` | scope | 每个采样点代表多少秒（传了时间轴就显示秒而不是点序号） |
| `rows` | bars | 最多显示几行 |
| `abs` / `centerText` | donut | 用绝对值算占比 / 圆心文案 |
| `emptyText` | 三者 | 空数据时的那句话，默认「暂无数据：先连接数据源或打开仿真」 |

原语自己负责：自动量程、图例宽度先量后排版、1/2/5 整齐刻度、轴标与时间标签夹在绘图区内、超密数据按像素列抽稀、DPR 适配、末值标记；`normalize:true` 时按各通道自身量程归一化。**返回值**形如 `{empty, plot, series, yRange, legendWidth, normalize, channelRanges}`，可用于自己的附加绘制。

## 3. 画风规范

### 3.1 颜色/字体令牌 = `ctx.theme()`

| 令牌 | 画什么 | 对应界面 |
| --- | --- | --- |
| `font` | `{body,strong,title,mono}` 四个字体串，**不要再手写 font 字符串** | 与界面同一套字栈（12px/600 12px/600 13px/mono 11px） |
| `bg` | 需要自铺底时用 | `--bg` / `--well` |
| `frame` | 描边、分隔线 | `--line` |
| `grid` | 网格线 | 画布网格 |
| `track` / `trackLine` / `trackRing` | 轨道底、轨道线、刻度圈 | 进度/环形底 |
| `axisText` | 坐标轴文字 | `--text-dim` |
| `axisLabelBg` / `tagBg` | 轴标签底 / 浮标底 | `--bg3` |
| `strongText` | 主要文字 | `--text` / `--heading` |
| `dimText` | 次要文字、空态、图例 | `--text-dim` |
| `acc` / `accRgb` | 强调色（选中、游标、高亮） | `--acc` / `--acc-rgb` |
| `glow` | 布尔，玻璃风格 true（带光晕）、极简风格 false | `state.fx` |

**必须**：画数据用通道自带的 `ch.color`（就是左侧通道列表那个色点），不要自己编配色。
**禁止**：任何硬编码色值（`#0d1117` / `#fff` / `rgba(255,255,255,.1)` …）。令牌已经按昼夜主题和玻璃/极简风格分好，**不要**在代码里判断主题。
**禁止**：自铺深色或纯白底（宿主已经是 `--bg2`），需要底时用 `TH.bg`。

### 3.2 尺寸与留白

- 字体 11–13px；正文 `TH.font.body`，标题 `TH.font.title`，数字 `TH.font.mono` 或 `font-variant-numeric: tabular-nums`。
- 圆角 8–10px；卡片内边距 10–12px；行间距 6–10px；内容外边距 10–14px。
- 不要给宿主再加边框/圆角（`.view-plugin-host` 已经有），也不要自己画深色背景块。

### 3.3 DOM 版插件的工具类（`styles.css` 里已有，直接用）

`.vp-wrap`（内容根：flex column + gap 10px + 自身滚动）、`.vp-card`（玻璃卡片）、`.vp-title`（小标题）、`.vp-row`（一行）、
`.vp-name`（左名，自动省略号）、`.vp-num`（右值，等宽数字）、`.vp-bar`（迷你条，内层 `<i>` 用 currentColor 撑宽）、`.vp-empty`（空态文案）、`.vp-plot`（给 canvas 用的受控槽，尺寸由 CSS 吃掉，**不要**给嵌套 canvas 手写宽高）。
清单的唯一来源是 `XHGCS_VIEWS.viewDomClasses`。DOM 版视图**不要**自己发明卡片样式；`.panel` / `.pane-title` 这些全局卡片类也可复用。

### 3.4 空态与异常

没有数据、通道被隐藏、串口没连上，都要给一句人话（`TH.dimText` + `TH.font.body`），例如「暂无数据：先连接数据源或打开仿真」。**不要**画一片空白，也不要弹 alert。
规模（N 点 / N 通道）由底栏 `#statusInfo` 统一说一次，插件里别再挂浮层重复。

## 4. 合规骨架（画布版 · 兜底路径）

只有原语覆盖不到的形状（雷达图、瀑布图、自定义坐标系…）才走这里自绘；能量化的图一律用第 2.1 节的原语。

```js
({ id: "bars", mount(ctx){ ctx.host.innerHTML = "<canvas></canvas>"; ctx.canvas = ctx.host.querySelector("canvas"); },
  update(ctx){
    var i = ctx.ensureCanvas(ctx.canvas); if (!i) return;
    var g = i.ctx, TH = ctx.theme();
    g.clearRect(0,0,i.w,i.h);
    g.font = TH.font.body; g.textBaseline = "middle";
    var cs = ctx.channels().filter(function(c){ return c.visible && c.data.length; });
    if (!cs.length) { g.fillStyle = TH.dimText; g.fillText("暂无数据：先连接数据源或打开仿真", 10, 20); return; }
    var m = 1; cs.forEach(function(c){ m = Math.max(m, Math.abs(c.data[c.data.length-1])); });
    cs.forEach(function(c,k){
      var y = 26 + k*26; if (y > i.h - 8) return;
      var v = Number(c.data[c.data.length-1]) || 0;
      var w = Math.max(2, (i.w-170) * Math.abs(v) / m);
      g.fillStyle = c.color;      g.fillRect(110, y-8, w, 16);
      g.fillStyle = TH.dimText;   g.fillText(c.name, 8, y);
      g.fillStyle = TH.strongText; g.fillText(ctx.formatValue(c, v), 118+w, y);
    });
  } })
```

## 5. 仪表盘型示例（DOM 版，零硬编码色）

```js
({ id: "kpi", mount(ctx){
    ctx.host.innerHTML = '<div class="vp-wrap"><div class="vp-card"><div class="vp-title">实时通道</div><div class="vp-rows"></div></div></div>';
    ctx.rows = ctx.host.querySelector(".vp-rows");
  },
  update(ctx){
    var cs = ctx.channels().filter(function(c){ return c.visible; });
    if (!cs.length) { ctx.rows.innerHTML = '<div class="vp-empty">暂无数据：先连接数据源或打开仿真</div>'; return; }
    ctx.rows.innerHTML = cs.map(function(c){
      var v = Number(c.data[c.data.length-1]) || 0;
      var span = Math.max(1e-9, (c.range && (c.range[1]-c.range[0])) || 1);
      var pct = Math.max(0, Math.min(100, ((v - ((c.range && c.range[0]) || 0)) / span) * 100));
      return '<div class="vp-row"><i style="width:8px;height:8px;border-radius:50%;background:' + ctx.esc(c.color) + '"></i>' +
        '<span class="vp-name">' + ctx.esc(c.name) + '</span>' +
        '<span class="vp-bar" style="color:' + ctx.esc(c.color) + '"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
        '<span class="vp-num">' + ctx.esc(ctx.formatValue(c, v)) + '</span></div>';
    }).join("");
  } })
```

## 6. 反例（生成时最常见的翻车点）

- `g.fillStyle = "#0d1117"` —— 浅色主题下就是一块黑砖；改用 `TH.bg` 或直接不铺底。
- 每帧 `ctx.host.innerHTML = ...` 重建整个面板 —— 文本选中丢失、点击穿透、CPU 飙升；只改变化的那个节点文本。
- `setInterval(function(){ ... }, 100)` —— 卸载后还在跑，切视图会内存泄漏；用 `ctx.interval`。
- `document.querySelector("#chart")` —— 可能选到内置视图的节点；在 `ctx.host` 里找。
- 手写 `canvas.width = clientWidth * devicePixelRatio` —— DPR 变了不会重算，直接用 `ctx.ensureCanvas`。
- 不判空 `ensureCanvas` 返回值 —— 宿主被折叠时每秒抛一次异常。
- 只处理 `state.channels` —— 分析脚本输出的脚本通道看不到，用户会以为视图坏了；用 `ctx.channels()`。
- 手写坐标轴 / 图例位置 / 量程（`g.fillText(name, i.w - 60, y)`、`yRange = [0, max]`）—— 这是"图面画歪"的头号原因：图例被右边裁掉、曲线挤在图上方一条线、画布比宿主还高。用 `ctx.draw.plot()` + `ctx.draw.scope/bars/donut`。
- 给嵌套在 `.vp-card` / `.vp-wrap` 里的 canvas 写 `style="height:100%"` —— 父级高度不确定时百分比高度退化成 auto，浏览器改用 `canvas.height` 属性当 CSS 像素，画布会被逐帧放大直到撑破宿主。用 `.vp-plot`（`ctx.draw.plot()` 自带）。

## 7. 交付前必须自检

生成的代码**不要**直接断言"已完成"。三条路任选，至少走一条并用结果说话（说实话：没过就说没过，不许编）。

1. **应用内自动**：设计器（`＋ 自定义视图`）生成后会自动跑 `XHGCS_VIEW_VERIFY.verify(code)`，状态条会写「已生成 · 自检通过（评分 N，墨水率 x%）」或「自检未通过：…」。对话里让 AI 生成视图时（`{"action":"view"}`）同样会带上自检结论。
   生成流程已经是「生成 → 真挂载自检 → 不合格就带错误清单让模型改一次 → 还不合格退本地模板」，所以看到「已自动修正 1 次」或「已回退本地模板」说明首版确实没通过，**不要**再当成成功复述给用户。
2. **Agent / MCP**：调 `verify_view`（先 `create_view` 或直接验代码）：
   `{"code":"({id:'x',mount(ctx){...},update(ctx){...}})","frames":6}`
   - 返回 `{ok:true, report:{ok,score,checks[9],errors,warnings,metrics:{frames,inkRatio,canvases,domStyled,themeReads,box}}}`；`inkRatio` 是画布上"非纯色"像素占比，0 就是画了一片空白。
   - `ok:false` 时看 `report.errors[0]`（真异常）和 `report.checks` 里 `ok:false` 的项（契约/渲染/DPR/工具类）。改完再验，别只验一次就交付。
   - 9 项检查：`contract`（单表达式 + id + mount）、`mount`、`update`、`render`、`style`（走令牌、无硬编码色）、`dom`（DOM 版用工具类）、`dpr`、`fit`（画布不溢出宿主）、`teardown`。
   - `fit` 为 false 说明画布比宿主还大，一定会被裁：多半是给 canvas 手写了宽高、或者没走 `ctx.draw.plot()`。
   - **通过标准**：`ok === true`；`style` 为 false 时必须改掉硬编码颜色再交付（这是画风要求，不是建议）。
3. **命令行**（开发机）：`node tools/view-check.js --code-file=tmp-view.js --shot=tmp-view.png`，或 `--builtin=bar|pie` 验内置模板，退出码非 0 即失败。

## 8. Token 原则（少读文件、少塞上下文）

- 接口规范只读本文档；**不要**为了生成视图去读 `assets/js/views-plugins.js`（200+ 行）或 `styles.css`（3400+ 行）。
- 运行时的规范文本就一份：`XHGCS_VIEWS.viewApiDoc`（应用内 AI 生成视图时只发这一份，普通对话不带）。本文档与它内容对齐，改一处记得同步另一处。
- 查已有视图用 MCP `list_views`（不带 `include_code`）；只有真要改某个视图时才 `include_code:true`。
- 自检结果只看 `report.ok / report.score / report.errors / checks[].ok`，别把整份 report 抄进回答。

## 9. 与其它 Skill 的分工

- `xhgcs`：数据链、脚本、组件、画布、引擎、TTS、串口、MCP 总览。
- **`xhgcs-view`（本文档）**：可视化视图插件的接口 + 画风 + 自检。
- 要"算一个新通道"→ 用 `xhgcs` 的 `create_script` / `create_component`；要"把数据画成人看的图"→ 用本文档 + `create_view` / `verify_view`。
