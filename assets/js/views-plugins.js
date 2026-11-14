(function () {
  'use strict';

  const V = window.XHGCS_VIEWS = window.XHGCS_VIEWS || {};
  const X = window.XHGCS;

  const registry = [];
  const byId = Object.create(null);
  // 设计器底部那条提示：默认只列常用 API（一行能放下），完整签名放 title 里悬停看
  const CTX_API_HINT = 'ctx API：draw.scope/bars/donut 绘图原语 / pick() 选通道 / theme() 令牌 / formatValue()　·　悬停看全部';
  const CTX_API_FULL = 'ctx.host / ctx.draw.plot() 受控画布槽 / ctx.draw.scope|bars|donut(canvas,opts) 绘图原语 / ctx.pick(spec,limit) / ctx.series(spec,limit) / ctx.latest(ch) / ctx.theme() 主题令牌{font,bg,grid,frame,axisText,tagBg,strongText,dimText,acc} / ctx.cssVar(--acc) / ctx.channels() / ctx.rawChannels() / ctx.scriptChannels() / ctx.findChannel(id) / ctx.ensureCanvas(canvas) / ctx.axisText(v) / ctx.formatValue(ch,v) / ctx.esc(v) / ctx.on(el,type,fn) / ctx.interval(fn,ms) / ctx.frame(fn) / ctx.toast(msg)';
  let activeId = '';
  let activeRuntime = null;
  let lastTickAt = 0;

  // 画布/视图插件统一取色口：插件通过 ctx.theme() 拿界面令牌，深浅主题与玻璃/极简风格自动跟随，
  // 这样生成的视图不会再各写一套硬编码颜色（见 .codex/skills/xhgcs-view/SKILL.md）。
  let tokenCache = null;
  let tokenKey = '';
  function themeTokens() {
    const key = (X.themeName ? X.themeName() : 'dark') + '/' + ((X.state && X.state.fx) || 'glass');
    if (!tokenCache || tokenKey !== key) {
      tokenCache = X.canvasColors();
      tokenKey = key;
    }
    return tokenCache;
  }
  function cssVar(name, fallback) {
    const key = String(name || '');
    if (!key) return fallback === undefined ? '' : fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
    return value || (fallback === undefined ? '' : String(fallback));
  }
  // 令牌缓存按主题/风格失效：切昼夜或切玻璃/极简时立刻换一套颜色
  window.addEventListener('xhgcs:theme-changed', function () { tokenCache = null; });
  window.addEventListener('xhgcs:fx-changed', function () { tokenCache = null; });

  // DOM 版插件的画风工具类（样式在 styles.css 的 .vp-* 段）。跟 ctx.theme() 是同一个目的：
  // 让插件长成界面本来的样子，而不是自己发明一套配色。清单同时写进 xhgcs-view Skill。
  const VIEW_DOM_CLASSES = ['vp-wrap', 'vp-card', 'vp-title', 'vp-row', 'vp-name', 'vp-num', 'vp-empty', 'vp-bar', 'vp-plot'];

  function safeToast(message) {
    if (window.XHGCS_APP && window.XHGCS_APP.toast) window.XHGCS_APP.toast(message);
  }

  const escape = X.esc;

  function registerView(def) {
    if (!def || !def.id) throw new Error('视图插件缺少 id');
    const entry = Object.assign({ order: 100, builtin: false }, def, { id: String(def.id) });
    const index = registry.findIndex((item) => item.id === entry.id);
    if (index >= 0) registry.splice(index, 1, entry);
    else registry.push(entry);
    byId[entry.id] = entry;
    registry.sort((a, b) => (a.order || 100) - (b.order || 100) || String(a.name).localeCompare(String(b.name)));
    return entry;
  }

  function unregisterView(id) {
    const index = registry.findIndex((item) => item.id === id);
    if (index < 0) return false;
    registry.splice(index, 1);
    delete byId[id];
    return true;
  }

  function listViews() { return registry.slice(); }
  function getView(id) { return byId[id] || null; }
  function activeView() { return activeId ? byId[activeId] || null : null; }

  function compileSource(code) {
    const source = String(code || '').trim();
    if (!source) throw new Error('插件代码为空');
    const factory = new Function('"use strict";return (' + source + ');');
    const def = factory();
    if (!def || typeof def !== 'object') throw new Error('插件代码必须返回一个对象');
    if (!def.id) throw new Error('插件对象缺少 id');
    if (typeof def.mount !== 'function') throw new Error('插件对象缺少 mount(ctx) 方法');
    return def;
  }

  function createContext(def, host) {
    const cleanups = [];
    const ctx = {
      host: host,
      def: def,
      state: X.state,
      views: V,
      uid: (prefix) => X.uid(prefix || 'view'),
      rawChannels: () => X.state.channels,
      scriptChannels: () => X.state.scriptChannels,
      channels: () => X.allChannels(),
      findChannel: (id) => X.findChannel(id),
      esc: escape,
      theme: () => { ctx.__themeReads += 1; return themeTokens(); },
      cssVar: (name, fallback) => cssVar(name, fallback),
      __themeReads: 0,
      axisText: (value) => (V.axisText ? V.axisText(value) : String(value)),
      formatValue: (channel, value) => (X.formatChannelValue ? X.formatChannelValue(channel, value) : String(value)),
      ensureCanvas: (canvas) => V.ensureCanvas(canvas),
      // 绘图原语（view-kit）：AI/设计器只描述"画什么"，量程/图例宽度/刻度取整/裁切/抽稀由原语负责
      plot: (parent) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.plot(ctx, parent) : null),
      pick: (spec, limit) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.pick(ctx, spec, limit) : []),
      series: (spec, limit) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.series(ctx, spec, limit) : []),
      latest: (channel) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.latest(channel) : 0),
      draw: {
        plot: (parent) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.plot(ctx, parent) : null),
        scope: (canvas, opts) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.drawScope(ctx, canvas, opts) : null),
        bars: (canvas, opts) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.drawBars(ctx, canvas, opts) : null),
        donut: (canvas, opts) => (window.XHGCS_VIEW_KIT ? window.XHGCS_VIEW_KIT.drawDonut(ctx, canvas, opts) : null)
      },
      toast: safeToast,
      on: (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
      },
      interval: (handler, ms) => {
        const timer = setInterval(handler, ms);
        cleanups.push(() => clearInterval(timer));
        return timer;
      },
      frame: (handler) => {
        const raf = requestAnimationFrame(handler);
        cleanups.push(() => cancelAnimationFrame(raf));
        return raf;
      },
      dispose: () => {
        while (cleanups.length) {
          try { cleanups.pop()(); } catch (err) { /* ignore */ }
        }
      }
    };
    return ctx;
  }

  function unmountActive() {
    if (!activeRuntime) return;
    const runtime = activeRuntime;
    activeRuntime = null;
    try { if (runtime.def.unmount) runtime.def.unmount(runtime.ctx); } catch (err) { /* ignore */ }
    try { runtime.ctx.dispose(); } catch (err) { /* ignore */ }
    if (runtime.ownHost && runtime.host && runtime.host.parentNode) runtime.host.parentNode.removeChild(runtime.host);
  }

  function mountView(id) {
    const def = byId[id];
    if (!def) return null;
    unmountActive();
    let host = null;
    let ownHost = false;
    if (def.builtin) {
      host = document.querySelector(def.host || '#chart');
    } else {
      const wrap = document.querySelector('.chart-wrap');
      if (!wrap) return null;
      host = document.createElement('div');
      host.className = 'view-plugin-host';
      host.dataset.viewId = id;
      wrap.appendChild(host);
      ownHost = true;
    }
    const ctx = createContext(def, host);
    activeRuntime = { def: def, host: host, ctx: ctx, ownHost: ownHost };
    activeId = id;
    try {
      if (def.mount) def.mount(ctx);
    } catch (err) {
      ctx.mountError = err;
      console.error('[XHGCS_VIEWS] 视图挂载失败', def.id, err);
      safeToast('视图「' + def.name + '」挂载失败：' + (err && err.message ? err.message : err));
    }
    return activeRuntime;
  }

  // 图表小窗使用独立挂载，不能替换主工作区当前视图。
  // 只开放给自定义插件；内置视图由 views-workbench.js 直接绘制轻量预览。
  function mountDetachedView(id, host) {
    const def = byId[id];
    if (!def || def.builtin || !host) return null;
    const ctx = createContext(def, host);
    try {
      if (def.mount) def.mount(ctx);
    } catch (err) {
      try { ctx.dispose(); } catch (ignore) {}
      throw err;
    }
    return {
      def: def,
      ctx: ctx,
      host: host,
      update: function () {
        if (typeof def.update === 'function') def.update(ctx);
      },
      resize: function () {
        if (typeof def.resize === 'function') def.resize(ctx);
      },
      dispose: function () {
        try { if (typeof def.unmount === 'function') def.unmount(ctx); } catch (err) {}
        try { ctx.dispose(); } catch (err) {}
      }
    };
  }

  function defaultInterval(def) {
    if (def.interval) return Number(def.interval);
    if (def.id === 'wave') return Math.max(40, Math.min(100, Number(X.state.intervalMs) || 100));
    if (def.id === 'table') return 500;
    return 100;
  }

  function tickViews(ts) {
    if (!activeRuntime || !activeRuntime.def.update) return;
    const every = defaultInterval(activeRuntime.def);
    if (ts - lastTickAt < every) return;
    lastTickAt = ts;
    try {
      activeRuntime.def.update(activeRuntime.ctx);
      activeRuntime.failed = false;
    } catch (err) {
      if (!activeRuntime.failed) {
        activeRuntime.failed = true;
        console.error('[XHGCS_VIEWS] 视图刷新失败', activeRuntime.def.id, err);
        safeToast('视图「' + activeRuntime.def.name + '」刷新出错：' + (err && err.message ? err.message : err));
      }
    }
  }

  function resizeActive() {
    if (!activeRuntime || !activeRuntime.def.resize) return;
    try { activeRuntime.def.resize(activeRuntime.ctx); } catch (err) { /* ignore */ }
  }

  function activateView(id) {
    const def = byId[id];
    if (!def) return false;
    if (X.state) X.state.subview = id;
    mountView(id);
    renderSwitcher();
    if (V.updateHeadText) V.updateHeadText();
    return true;
  }

  // P2.1b：视图图标统一走 SVG sprite（内置按 id 映射；自定义/预览回退通用 i-views）
  const VIEW_ICONS = { wave: 'i-wave', bar: 'i-bars', table: 'i-table', gauge: 'i-gauge', map: 'i-map' };
  function viewIconSvg(id) {
    const symbol = VIEW_ICONS[id] || 'i-views';
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#' + symbol + '"/></svg>';
  }

  function renderSwitcher() {
    const list = document.querySelector('#swList');
    if (!list) return;
    const itemHtml = (def) => {
      const active = def.id === activeId ? ' active' : '';
      const actions = def.builtin ? '' : '<div class="sw-actions"><button class="sw-btn sw-edit" data-view-edit="' + escape(def.id) + '" title="编辑视图代码">✎</button><button class="sw-btn sw-del" data-view-delete="' + escape(def.id) + '" title="删除自定义视图">✕</button></div>';
      return '<div class="wtile sw-item' + active + '" data-subview="' + escape(def.id) + '" title="' + escape(def.name) + '">'
        + '<div class="sw-ico">' + viewIconSvg(def.id) + '</div>'
        + '<div class="sw-t">' + escape(def.name) + '</div>' + actions + '</div>';
    };
    const group = (label, items) => {
      if (!items.length) return '';
      return '<details class="sw-group" open><summary><span>' + escape(label) + '</span><b>' + items.length + '</b></summary>'
        + '<div class="sw-group-body">' + items.map(itemHtml).join('') + '</div></details>';
    };
    const builtin = registry.filter((def) => def.builtin);
    const custom = registry.filter((def) => !def.builtin && def.id !== '__preview__');
    const preview = registry.filter((def) => def.id === '__preview__');
    list.innerHTML = group('内置视图', builtin) + group('我的视图', custom) + group('预览', preview)
      + '<button class="wtile sw-add" id="btnAddView" type="button" title="打开构图板，几句话生成一个可视化视图">＋ 画一个新视图</button>';
    if (V.syncChartWorkPalette) V.syncChartWorkPalette();
    if (V.renderLeftPanel) V.renderLeftPanel();
  }
  function persistViews() {
    if (X.persist) X.persist();
  }

  function saveViewSpec(spec, options) {
    const source = String(spec.code || '').trim();
    compileSource(source);
    const record = {
      id: String(spec.id || X.uid('view')).replace(/[^a-zA-Z0-9_-]/g, ''),
      name: String(spec.name || '自定义视图').slice(0, 40),
      icon: String(spec.icon || '◈').slice(0, 2),
      desc: String(spec.desc || spec.description || '').slice(0, 80),
      code: source,
      origin: String(spec.origin || (options && options.origin) || 'manual'),
      createdAt: (options && options.createdAt) || Date.now()
    };
    if (!record.id) record.id = X.uid('view');
    const views = X.state.views || (X.state.views = []);
    const index = views.findIndex((item) => item.id === record.id);
    if (index >= 0) views.splice(index, 1, record);
    else views.push(record);
    persistViews();
    const def = installRecord(record);
    return def;
  }

  function installRecord(record) {
    const def = compileSource(record.code);
    def.id = record.id;
    def.name = record.name;
    def.icon = record.icon;
    def.desc = record.desc;
    def.builtin = false;
    def.origin = record.origin;
    return registerView(def);
  }

  function installAll() {
    (X.state.views || []).forEach((record) => {
      try {
        installRecord(record);
      } catch (err) {
        console.warn('[XHGCS_VIEWS] 自定义视图加载失败', record.id, err);
      }
    });
  }

  function removeView(id) {
    const def = byId[id];
    if (!def || def.builtin) return false;
    if (activeId === id) {
      unmountActive();
      activeId = '';
      if (byId['wave']) activateView('wave');
    }
    unregisterView(id);
    X.state.views = (X.state.views || []).filter((item) => item.id !== id);
    if (X.state.mcp && Array.isArray(X.state.mcp.deletedViews) && X.state.mcp.deletedViews.indexOf(id) < 0) X.state.mcp.deletedViews.push(id);
    persistViews();
    return true;
  }

  function viewSourceOf(id) {
    const record = (X.state.views || []).find((item) => item.id === id);
    return record ? record.code : '';
  }

  const VIEW_API_DOC = [
    '# XiHe_GCS 可视化视图插件规范（与 .codex/skills/xhgcs-view/SKILL.md 同一份标准）',
    '## 契约',
    '1. code 是一个 JS 表达式，求值返回 ({ id:"唯一id", mount(ctx){...}, update(ctx){...}, unmount?(ctx){...} })',
    '2. 只用 ctx 与浏览器原生 API：禁止 fetch/import/require/XMLHttpRequest/localStorage；禁止 setInterval/setTimeout（用 ctx.interval / ctx.frame，卸载自动清理）。',
    '3. mount 只建一次 DOM 并存进 ctx，update 只刷新数据（默认 100ms 一次），不要每帧重建 DOM。',
    '## 首选路径：调用绘图原语，不要自己算坐标（硬要求）',
    '量程、图例宽度、刻度取整、边界裁剪、超密数据抽稀、DPI 都由原语处理。自己手写坐标轴几乎一定画歪：图例被裁、曲线挤成一条、画布撑破宿主。',
    '- ctx.draw.plot() → {canvas, holder}：受控画布槽，尺寸自动填满宿主。必须先建它，再画。',
    '- ctx.draw.scope(canvas, opts)：折线/示波器。opts = { series, limit, value, time, perPoint, yRange:[min,max], normalize, legend, dot, emptyText }。normalize:true 让每条曲线按自身窗口量程铺满，量纲差异大时必须开；legend 默认 "right"（右侧列通道名 + 当前值 + 单位），**不要随手关掉**：只有用户明确说「不要图例 / 只要曲线」时才写 legend:"none"',
    '- ctx.draw.bars(canvas, opts)：横向条形。opts = { series, limit, rows, yRange, emptyText }',
    '- ctx.draw.donut(canvas, opts)：占比环。opts = { series, limit, abs, centerText, emptyText }',
    'series 有三种写法："温度"（按名字子串匹配，中英文/大小写不敏感） / ["wed-07","wed-02"]（按 id 列表） / "*"（全部可见通道）。limit 限制条数，多通道折线图必须写 limit（3~6 条）。',
    '## 首选路径示例（照抄这个结构，只改 id 与 opts）',
    '({ id:"scope3", mount(ctx){ ctx.plot = ctx.draw.plot(); }, update(ctx){ ctx.draw.scope(ctx.plot.canvas, { series:"温度", limit:4, value:true, time:true, normalize:true }); } })',
    '({ id:"rank", mount(ctx){ ctx.plot = ctx.draw.plot(); }, update(ctx){ ctx.draw.bars(ctx.plot.canvas, { series:"*", limit:10 }); } })',
    '({ id:"pm3", mount(ctx){ ctx.plot = ctx.draw.plot(); }, update(ctx){ ctx.draw.donut(ctx.plot.canvas, { series:["PM2.5","PM10","PM1.0"], centerText:"颗粒物" }); } })',
    '## 兜底路径（原语覆盖不到的形状才自绘）',
    '({ id:"free", mount(ctx){ ctx.plot = ctx.draw.plot(); }, update(ctx){ var i = ctx.ensureCanvas(ctx.plot.canvas); if(!i) return; var g=i.ctx, TH=ctx.theme(); g.clearRect(0,0,i.w,i.h); g.font=TH.font.body; g.textBaseline="middle"; g.fillStyle=TH.dimText; g.fillText("暂无数据", 10, 18); })',
    '自绘硬要求：先 ctx.ensureCanvas 并判空 return；所有坐标用 i.w / i.h 算，不许超出画布；文字一律 TH.font.*，颜色只取 TH 令牌或 ch.color；空数据必须给文字提示。',
    '## DOM 版（表格/清单）画风工具类',
    '.vp-wrap 内容根（flex column，自动滚动）/ .vp-card 玻璃卡片 / .vp-title 小标题 / .vp-row 一行 / .vp-name 左名（自动省略）/ .vp-num 右值（等宽）/ .vp-bar 迷你条（内层 <i> 用 currentColor 撑宽）/ .vp-empty 空态 / .vp-plot 给 canvas 用的受控槽',
    'DOM 版取数用 ctx.pick(spec, limit) 选通道、ctx.latest(ch) 取最新值、ctx.formatValue(ch, v) 带单位格式化。',
    '## ctx 其余 API',
    'ctx.host / ctx.theme() 令牌{font{body,strong,title,mono}, bg, grid, frame, track, trackLine, axisText, axisLabelBg, tagBg, strongText, dimText, acc, accRgb, glow} / ctx.cssVar("--acc",fb) / ctx.channels()（原始+脚本）/ ctx.rawChannels() / ctx.scriptChannels() / ctx.findChannel(id或名) / ctx.axisText(v) / ctx.esc(v) / ctx.on(el,type,fn) / ctx.interval(fn,ms) / ctx.frame(fn) / ctx.toast(msg) / ctx.state / ctx.uid(prefix)',
    '通道字段：id, name, unit, color, range([min,max]), visible, data(数字数组，末尾是最新值)。',
    '## 画风（硬要求）',
    '- 禁止硬编码色值（#0d1117 / #fff / rgb(...) 等）：颜色只能来自 TH 令牌或 ch.color；文字用 TH.strongText（主）/ TH.dimText（次）。',
    '- 字号 11-13px，数字用 TH.font.mono；不要在代码里判断深浅主题（令牌已分好）。',
    '- 不要自铺深底/纯白底：宿主已是 --bg2；内容外边距 8-14px、圆角 8-10px。',
    '- 子视图规模只在底栏 #statusInfo 说一次，插件内不要再挂「N 点」浮层。',
    '## 输出格式',
    '只输出一个 JSON 对象（不要解释、不要 markdown）：{"name":"名称","icon":"◈","desc":"一句话","code":"(...)"}',
    'code 是单行 JSON 字符串：换行写 \\n，单引号保留，双引号写 \\" 。',
    '保存前会跑 lintViewCode + 真挂载自检：禁用 API 判错误，硬编码颜色判警告，画布溢出宿主判警告。'
  ].join('\n');

  // 把「当前有哪些通道」压成一段短清单塞进提示词：模型不用猜字段名，直接用名字子串选中。
  // 只给 id/名称/单位/量程，不给数值——数值每帧都在变，塞进去只会烧 token 并诱导模型写死数据。
  function channelDigest(limit) {
    const all = (X.allChannels ? X.allChannels() : []).filter(function (ch) { return ch && ch.visible !== false; });
    if (!all.length) return '## 当前通道清单\n（数据源未连接，暂时没有通道）视图必须写空数据提示，不要写死通道名。';
    const max = Math.max(1, Number(limit) || 24);
    const lines = all.slice(0, max).map(function (ch) {
      const name = String(ch.name || ch.id || '');
      const short = name.length > 16 ? name.slice(0, 15) + '…' : name;
      const unit = ch.unit ? '(' + ch.unit + ')' : '';
      const range = Array.isArray(ch.range) && ch.range.length === 2 ? ' 量程' + ch.range[0] + '~' + ch.range[1] : '';
      return ch.id + ' ' + short + unit + range;
    });
    const more = all.length > max ? '\n…另有 ' + (all.length - max) + ' 个通道，也可以用 "*" 或名字子串选中' : '';
    return '## 当前通道清单（共 ' + all.length + ' 个，series 里直接写名字子串）\n' + lines.join('\n') + more;
  }
  V.channelDigest = channelDigest;

  // 规范检查：生成端（AI / MCP / 设计器）与自检端（view-verify）共用这一份规则，
  // 避免「生成的代码」和「检查的标准」两处漂移。规则与 .codex/skills/xhgcs-view/SKILL.md 对齐。
  const LINT_RULES = [
    [/\bsetInterval\s*\(/, 'error', '禁止 setInterval：用 ctx.interval(fn, ms)，卸载时会自动清理'],
    [/\bsetTimeout\s*\(/, 'error', '禁止 setTimeout：用 ctx.interval(fn, ms)'],
    [/\bfetch\s*\(/, 'error', '禁止网络请求 fetch()'],
    [/\bimport\s*\(/, 'error', '禁止动态 import()'],
    [/\brequire\s*\(/, 'error', '禁止 require()：插件只有 ctx 和浏览器原生 API'],
    [/\bXMLHttpRequest\b/, 'error', '禁止 XMLHttpRequest'],
    [/\blocalStorage\b|\bsessionStorage\b/, 'error', '禁止直接读写 localStorage：状态放 ctx.state 或插件内部变量'],
    [/\bdevicePixelRatio\b/, 'warn', '不要自己处理 DPR：用 ctx.ensureCanvas(canvas)'],
    [/\bdocument\.(querySelector|querySelectorAll|getElementById)\b/, 'warn', '不要在 document 上全局查询：从 ctx.host 里找自己的元素']
  ];
  const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

  function lintViewCode(code) {
    const text = String(code || '').trim();
    const out = { ok: false, errors: [], warnings: [], colors: [], usesTheme: false };
    if (!text) { out.errors.push('插件代码为空'); return out; }
    let def = null;
    try { def = compileSource(text); } catch (err) { out.errors.push(String((err && err.message) || err)); return out; }
    if (typeof def.mount !== 'function') out.errors.push('插件对象缺少 mount(ctx) 方法');
    LINT_RULES.forEach(function (rule) {
      if (!rule[0].test(text)) return;
      if (rule[1] === 'error') out.errors.push(rule[2]);
      else out.warnings.push(rule[2]);
    });
    out.colors = Array.from(new Set(text.match(HEX_COLOR_RE) || []));
    // 绘图原语（ctx.draw.plot/scope/bars/donut）内部就是走 ctx.theme() 取色，
    // 所以"代码文本里没有 ctx.theme()"不等于画风不合规——否则首选路径反而被判不合格。
    out.usesTheme = /ctx\.theme\s*\(|ctx\.cssVar\s*\(|ctx\.draw\.(plot|scope|bars|donut)\s*\(/.test(text);
    if (out.colors.length) out.warnings.push('硬编码颜色 ' + out.colors.slice(0, 6).join(' ') + '：改用 ctx.theme() 令牌，深浅主题才不会割裂');
    if (!out.usesTheme) out.warnings.push('没有用到 ctx.theme()/ctx.cssVar()：颜色不来自界面令牌，切主题会割裂');
    if (!/ctx\.ensureCanvas\s*\(/.test(text)
      && !/ctx\.draw\.(scope|bars|donut)\s*\(/.test(text)
      && /<canvas|createElement\(\s*['"]canvas/.test(text)) out.warnings.push('用了 canvas 但没走 ctx.ensureCanvas()：高 DPI 屏会糊');
    out.ok = out.errors.length === 0;
    return out;
  }

  function codeOf(def) {
    return '({id:' + JSON.stringify(def.id) + ',mount:' + String(def.mount) + ',update:' + String(def.update) + '})';
  }

  function barTemplate() {
    return {
      id: X.uid('view'),
      name: '通道条形图',
      icon: '▥',
      desc: '各通道当前值横向条形图',
      mount: function (ctx) {
        ctx.host.innerHTML = '<canvas></canvas>';
        ctx.canvas = ctx.host.querySelector('canvas');
      },
      update: function (ctx) {
        const info = ctx.ensureCanvas(ctx.canvas);
        if (!info) return;
        const g = info.ctx;
        const TH = ctx.theme();
        g.clearRect(0, 0, info.w, info.h);
        g.font = TH.font.body;
        g.textBaseline = 'middle';
        const chs = ctx.channels().filter(function (c) { return c.visible && c.data.length; });
        if (!chs.length) {
          g.fillStyle = TH.dimText;
          g.fillText('暂无数据：先连接数据源或打开仿真', 10, 20);
          return;
        }
        let max = 1;
        chs.forEach(function (c) { max = Math.max(max, Math.abs(c.data[c.data.length - 1])); });
        chs.forEach(function (c, i) {
          const y = 26 + i * 26;
          if (y > info.h - 10) return;
          const v = Number(c.data[c.data.length - 1]) || 0;
          const w = Math.max(2, (info.w - 170) * Math.abs(v) / max);
          g.fillStyle = c.color;
          g.fillRect(110, y - 8, w, 16);
          g.fillStyle = TH.dimText;
          g.fillText(c.name, 8, y);
          g.fillStyle = TH.strongText;
          g.fillText(ctx.formatValue(c, v), 118 + w, y);
        });
      }
    };
  }

  function pieTemplate() {
    return {
      id: X.uid('view'),
      name: '占比环形图',
      icon: '◕',
      desc: '各通道当前值占比',
      mount: function (ctx) {
        ctx.host.innerHTML = '<canvas></canvas>';
        ctx.canvas = ctx.host.querySelector('canvas');
      },
      update: function (ctx) {
        const info = ctx.ensureCanvas(ctx.canvas);
        if (!info) return;
        const g = info.ctx;
        const TH = ctx.theme();
        g.clearRect(0, 0, info.w, info.h);
        const chs = ctx.channels().filter(function (c) { return c.visible && c.data.length; });
        if (!chs.length) {
          g.fillStyle = TH.dimText;
          g.font = TH.font.body;
          g.textBaseline = 'middle';
          g.fillText('暂无数据：先连接数据源或打开仿真', 10, 20);
          return;
        }
        const values = chs.map(function (c) { return Math.max(0, Number(c.data[c.data.length - 1]) || 0); });
        const total = values.reduce(function (a, b) { return a + b; }, 0) || 1;
        const cx = info.w / 2, cy = info.h / 2;
        const radius = Math.max(24, Math.min(info.w, info.h) * 0.34);
        g.lineWidth = Math.max(10, radius * 0.42);
        g.lineCap = 'butt';
        let start = -Math.PI / 2;
        chs.forEach(function (c, i) {
          const angle = values[i] / total * Math.PI * 2;
          g.beginPath();
          g.arc(cx, cy, radius - g.lineWidth / 2, start, start + angle);
          g.strokeStyle = c.color;
          g.stroke();
          start += angle;
        });
        g.fillStyle = TH.strongText;
        g.font = TH.font.title;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(chs.length + ' 通道', cx, cy);
        g.textAlign = 'left';
      }
    };
  }

  function fallbackTemplate(prompt) {
    const text = String(prompt || '');
    const def = /饼|占比|比例|环形|pie/i.test(text) ? pieTemplate() : barTemplate();
    return { name: def.name, icon: def.icon, desc: def.desc, code: codeOf(def) };
  }

  let designerBound = false;
  let blueprintBlocks = [];
  let blueprintChannelIds = [];
  let blueprintDragIndex = -1;

  function designerEl(id) { return document.getElementById(id); }

  function blueprintApi() {
    return window.XHGCS_VIEW_BLUEPRINT || null;
  }

  function blueprintTypes() {
    const api = blueprintApi();
    return api && api.types ? api.types : {};
  }

  function renderBlueprintBoard() {
    const board = designerEl('viewBlueprintBoard');
    if (!board) return;
    const types = blueprintTypes();
    board.classList.toggle('vb-empty', !blueprintBlocks.length);
    if (!blueprintBlocks.length) {
      board.textContent = '点上方“趋势 / 对比 / 占比 / 指标”加入图形块；也可以只写一句需求直接生成。';
      return;
    }
    board.innerHTML = blueprintBlocks.map(function (block, index) {
      const def = types[block.type] || { name: block.type, icon: '▦', desc: '' };
      const series = block.series && block.series.length
        ? block.series.map(function (id) { const ch = X.findChannel(id); return ch ? ch.name : id; }).join('、')
        : '全部可见通道';
      return '<div class="vb-block" draggable="true" data-vb-index="' + index + '">'
        + '<span class="vb-glyph">' + escape(def.icon) + '</span>'
        + '<div class="vb-copy"><b>' + escape(def.name) + '</b><small>' + escape(series) + '</small></div>'
        + '<button type="button" class="vb-remove" data-vb-remove="' + index + '" title="移除这个图形块">✕</button>'
        + '</div>';
    }).join('');
  }

  function renderBlueprintChannels() {
    const host = designerEl('viewBlueprintChannels');
    if (!host) return;
    const channels = X.allChannels();
    host.innerHTML = channels.length ? channels.map(function (ch) {
      const on = blueprintChannelIds.indexOf(ch.id) >= 0;
      return '<button type="button" class="vb-channel" data-vb-channel="' + escape(ch.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<i style="background:' + escape(ch.color) + '"></i>' + escape(ch.name) + '</button>';
    }).join('') : '<span class="vp-empty">暂无通道：仍可先搭好构图，连接数据后自动补上。</span>';
  }

  function resetBlueprint() {
    blueprintBlocks = [];
    blueprintChannelIds = [];
    const layout = designerEl('viewBlueprintLayout');
    if (layout) layout.value = 'auto';
    renderBlueprintBoard();
    renderBlueprintChannels();
  }

  function readBlueprint() {
    const layout = designerEl('viewBlueprintLayout');
    return {
      layout: layout ? layout.value : 'auto',
      blocks: blueprintBlocks.map(function (block) {
        return { type: block.type, title: block.title, series: block.series.slice() };
      }),
      channels: blueprintChannelIds.slice()
    };
  }

  function bindBlueprint() {
    const palette = designerEl('viewBlockPalette');
    const board = designerEl('viewBlueprintBoard');
    const channels = designerEl('viewBlueprintChannels');
    if (palette) {
      palette.addEventListener('click', function (event) {
        const btn = event.target.closest('[data-view-block]');
        if (!btn) return;
        const type = btn.dataset.viewBlock;
        const types = blueprintTypes();
        if (!types[type] || blueprintBlocks.length >= 4) {
          if (blueprintBlocks.length >= 4) designerStatus('一块屏幕最多放 4 个图形块，先移除一个再加。', true);
          return;
        }
        blueprintBlocks.push({ type: type, title: types[type].name, series: blueprintChannelIds.slice() });
        renderBlueprintBoard();
        designerStatus('构图已加入「' + types[type].name + '」。补一句话再点“生成并启用”。', false);
      });
    }
    if (board) {
      board.addEventListener('click', function (event) {
        const remove = event.target.closest('[data-vb-remove]');
        if (!remove) return;
        const index = Number(remove.dataset.vbRemove);
        if (index >= 0) blueprintBlocks.splice(index, 1);
        renderBlueprintBoard();
      });
      board.addEventListener('dragstart', function (event) {
        const card = event.target.closest('[data-vb-index]');
        if (!card) return;
        blueprintDragIndex = Number(card.dataset.vbIndex);
        card.classList.add('dragging');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      board.addEventListener('dragover', function (event) {
        if (blueprintDragIndex >= 0) event.preventDefault();
      });
      board.addEventListener('drop', function (event) {
        const target = event.target.closest('[data-vb-index]');
        if (!target || blueprintDragIndex < 0) return;
        event.preventDefault();
        const to = Number(target.dataset.vbIndex);
        const moved = blueprintBlocks.splice(blueprintDragIndex, 1)[0];
        blueprintBlocks.splice(to, 0, moved);
        blueprintDragIndex = -1;
        renderBlueprintBoard();
      });
      board.addEventListener('dragend', function () {
        blueprintDragIndex = -1;
        Array.prototype.forEach.call(board.querySelectorAll('.dragging'), function (el) { el.classList.remove('dragging'); });
      });
    }
    if (channels) {
      channels.addEventListener('click', function (event) {
        const chip = event.target.closest('[data-vb-channel]');
        if (!chip) return;
        const id = chip.dataset.vbChannel;
        const index = blueprintChannelIds.indexOf(id);
        if (index >= 0) blueprintChannelIds.splice(index, 1);
        else blueprintChannelIds.push(id);
        blueprintBlocks.forEach(function (block) { block.series = blueprintChannelIds.slice(); });
        renderBlueprintChannels();
        renderBlueprintBoard();
      });
    }
    const all = designerEl('btnViewBlueprintAll');
    if (all) {
      all.addEventListener('click', function () {
        blueprintChannelIds = X.allChannels().filter(function (ch) { return ch.visible !== false; }).map(function (ch) { return ch.id; });
        blueprintBlocks.forEach(function (block) { block.series = blueprintChannelIds.slice(); });
        renderBlueprintChannels();
        renderBlueprintBoard();
      });
    }
  }

  function closeDesigner() {
    const modal = designerEl('viewModal');
    if (modal) modal.classList.add('hidden');
  }

  function bindDesigner() {
    if (designerBound) return;
    designerBound = true;
    const modal = designerEl('viewModal');
    if (!modal) return;
    designerEl('btnCloseViewModal').addEventListener('click', closeDesigner);
    designerEl('btnViewCancel').addEventListener('click', closeDesigner);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeDesigner(); });
    designerEl('btnViewSave').addEventListener('click', saveFromDesigner);
    designerEl('btnViewPreview').addEventListener('click', previewFromDesigner);
    designerEl('btnViewAiGenerate').addEventListener('click', generateFromDesigner);
    bindBlueprint();
    designerEl('viewPrompt').addEventListener('keydown', function (e) { if (e.key === 'Enter') generateFromDesigner(); });
    // Esc 关闭：焦点停在代码框里时也要能退出，不用绕回鼠标
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (modal.classList.contains('hidden')) return;
      const app = window.XHGCS_APP;
      if (app && app.topOverlay && app.topOverlay() !== 'viewModal') return;
      closeDesigner();
    });
  }

  function openViewDesigner(id) {
    bindDesigner();
    const modal = designerEl('viewModal');
    if (!modal) return;
    if (byId['__preview__']) {
      if (activeId === '__preview__' && byId['wave']) activateView('wave');
      unregisterView('__preview__');
      renderSwitcher();
    }
    const record = id ? (X.state.views || []).find(function (item) { return item.id === id; }) : null;
    designerEl('viewName').value = record ? record.name : '';
    designerEl('viewIcon').value = record ? record.icon : '';
    designerEl('viewDesc').value = record ? record.desc : '';
    designerEl('viewCode').value = record ? record.code : '';
    designerEl('viewPrompt').value = '';
    resetBlueprint();
    designerEl('viewModalStatus').classList.remove('err');
    designerEl('viewModalStatus').textContent = CTX_API_HINT;
    designerEl('viewModalStatus').title = CTX_API_FULL;
    modal.dataset.editId = record ? record.id : '';
    modal.classList.remove('hidden');
    // 延后 30ms 再聚焦：弹窗刚显示时立刻 focus 会被随后的布局打断。
    // 但别无条件抢 —— 这 30ms 里用户（或自动化操作）可能已经点进某个框了，
    // 硬把焦点挪走会让紧接着输入的内容落到别的输入框里。
    setTimeout(function () {
      if (modal.contains(document.activeElement)) return;
      designerEl(record ? 'viewCode' : 'viewPrompt').focus();
    }, 30);
  }

  // 生成完立刻真挂载跑几帧：AI 说「已生成」不算数，能画出东西才算数（设计器与对话共用）
  async function selfCheck(code) {
    const verify = window.XHGCS_VIEW_VERIFY;
    if (!verify || typeof verify.verify !== 'function') return null;
    try { return await verify.verify(code, { frames: 5 }); } catch (err) { return null; }
  }

  function activateSavedView(id) {
    if (V.switchSubView) V.switchSubView(id);
    else activateView(id);
  }

  function designerStatus(message, isError) {
    const el = designerEl('viewModalStatus');
    if (!el) return;
    el.textContent = message;
    // 只有显示 API 提示时才挂完整签名，避免状态消息上出现无关的 tooltip
    el.title = message === CTX_API_HINT ? CTX_API_FULL : '';
    el.classList.toggle('err', Boolean(isError));
  }

  function previewFromDesigner() {
    const code = designerEl('viewCode').value.trim();
    let compiled;
    try {
      compiled = compileSource(code);
    } catch (err) {
      designerStatus('代码有误：' + (err && err.message || err), true);
      return false;
    }
    const name = designerEl('viewName').value.trim() || compiled.name || '预览视图';
    registerView(Object.assign({}, compiled, {
      id: '__preview__',
      name: name,
      icon: designerEl('viewIcon').value.trim() || compiled.icon || '◈',
      desc: '预览（未保存）',
      order: 999,
      builtin: false
    }));
    activateView('__preview__');
    closeDesigner();
    safeToast('预览中：' + name + '（未保存，刷新后消失）');
    return true;
  }

  async function generateFromDesigner() {
    const prompt = designerEl('viewPrompt').value.trim();
    const blueprint = readBlueprint();
    if (!prompt && !blueprint.blocks.length) {
      designerStatus('先加一个图形块，或者写一句话描述你想要的视图。', true);
      return false;
    }
    const btn = designerEl('btnViewAiGenerate');
    const ai = window.XHGCS_AI;
    const api = blueprintApi();
    btn.disabled = true;
    designerStatus('正在生成、真挂载自检并准备启用…', false);
    try {
      if (!ai || typeof ai.generateView !== 'function') throw new Error('AI 模块未加载');
      const request = api && api.promptText
        ? api.promptText(blueprint, prompt || '按构图板生成一个清晰的数据视图')
        : prompt;
      const intent = ai.classifyViewPrompt ? ai.classifyViewPrompt(prompt) : { localFirst: true };
      const localFirst = blueprint.blocks.length > 0 || intent.localFirst;
      const result = await ai.generateView(request, VIEW_API_DOC, { blueprint: blueprint, localFirst: localFirst });
      const spec = result && result.spec;
      if (!spec || !spec.code) throw new Error('模型未返回可用代码');
      if (spec.name) designerEl('viewName').value = spec.name;
      if (spec.icon) designerEl('viewIcon').value = spec.icon;
      if (spec.desc) designerEl('viewDesc').value = spec.desc;
      designerEl('viewCode').value = String(spec.code).trim();
      const lint = result.lint || lintViewCode(spec.code);
      if (lint.errors.length) {
        designerStatus('代码不合规：' + lint.errors.join('；'), true);
        return false;
      }
      const report = result.verify || null;
      if (report && !report.ok) {
        designerStatus('自检未通过：' + window.XHGCS_VIEW_VERIFY.summarize(report) + '。可改代码或重试生成。', true);
        return false;
      }
      const def = saveViewSpec({
        name: designerEl('viewName').value.trim() || spec.name || 'AI 构图视图',
        icon: designerEl('viewIcon').value.trim() || spec.icon || '◈',
        desc: designerEl('viewDesc').value.trim() || spec.desc || '一句话与构图板生成的数据视图',
        code: spec.code,
        origin: result.source === 'local-blueprint' ? 'local-blueprint' : 'ai-blueprint'
      });
      activateSavedView(def.id);
      closeDesigner();
      safeToast('已生成并启用「' + def.name + '」' + (report ? ' · ' + window.XHGCS_VIEW_VERIFY.summarize(report) : ' · 未执行自检'));
      return true;
    } catch (err) {
      const fallback = api && api.compile
        ? api.compile(blueprint, prompt || '按构图板生成一个清晰的数据视图')
        : fallbackTemplate(prompt);
      if (!fallback || !fallback.code) {
        designerStatus('生成失败：' + (err && err.message || err), true);
        return false;
      }
      designerEl('viewCode').value = fallback.code;
      if (!designerEl('viewName').value) designerEl('viewName').value = fallback.name;
      if (!designerEl('viewIcon').value) designerEl('viewIcon').value = fallback.icon;
      if (!designerEl('viewDesc').value) designerEl('viewDesc').value = fallback.desc;
      const lint = lintViewCode(fallback.code);
      const report = lint.errors.length ? null : await selfCheck(fallback.code);
      if (lint.errors.length || (report && !report.ok)) {
        designerStatus('生成失败，本地构图也未能通过自检：'
          + (lint.errors.length ? lint.errors.join('；') : window.XHGCS_VIEW_VERIFY.summarize(report)), true);
        return false;
      }
      const def = saveViewSpec({
        name: designerEl('viewName').value.trim() || fallback.name,
        icon: designerEl('viewIcon').value.trim() || fallback.icon,
        desc: designerEl('viewDesc').value.trim() || fallback.desc,
        code: fallback.code,
        origin: 'local-blueprint'
      });
      activateSavedView(def.id);
      closeDesigner();
      safeToast('模型未完成，已用本地构图编译器生成并启用「' + def.name + '」');
      return true;
    } finally {
      btn.disabled = false;
    }
  }

  function saveFromDesigner() {
    const modal = designerEl('viewModal');
    const code = designerEl('viewCode').value.trim();
    let compiled;
    try {
      compiled = compileSource(code);
    } catch (err) {
      designerStatus('代码有误：' + (err && err.message || err), true);
      return;
    }
    const lint = lintViewCode(code);
    if (lint.errors.length) {
      designerStatus('代码不合规，先改这里：' + lint.errors.join('；'), true);
      return;
    }
    const editId = modal.dataset.editId || '';
    const def = saveViewSpec({
      id: editId || undefined,
      name: designerEl('viewName').value.trim() || compiled.name || '自定义视图',
      icon: designerEl('viewIcon').value.trim() || compiled.icon || '◈',
      desc: designerEl('viewDesc').value.trim() || compiled.desc || '',
      code: code,
      origin: 'manual'
    });
    activateSavedView(def.id);
    closeDesigner();
    safeToast('已保存并启用视图「' + def.name + '」' + (lint.warnings.length ? '（' + lint.warnings.length + ' 条画风提醒，见控制台）' : ''));
    if (lint.warnings.length) console.warn('[XHGCS_VIEWS] 视图画风提醒', def.id, lint.warnings);
  }

  V.registerView = registerView;
  V.unregisterView = unregisterView;
  V.listViews = listViews;
  V.getView = getView;
  V.activeView = activeView;
  V.activateView = activateView;
  V.mountDetachedView = mountDetachedView;
  V.tickViews = tickViews;
  V.resizeActiveView = resizeActive;
  V.renderSwitcher = renderSwitcher;
  V.compileViewSource = compileSource;
  V.lintViewCode = lintViewCode;
  V.viewTokens = themeTokens;
  V.viewDomClasses = VIEW_DOM_CLASSES;
  V.createViewContext = createContext;
  V.compileSource = compileSource;
  V.saveViewSpec = saveViewSpec;
  V.installViews = installAll;
  V.removeView = removeView;
  V.viewSourceOf = viewSourceOf;
  V.openViewDesigner = openViewDesigner;
  V.fallbackTemplate = fallbackTemplate;
  V.viewApiDoc = VIEW_API_DOC;
})();
