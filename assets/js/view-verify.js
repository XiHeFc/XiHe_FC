(function () {
  'use strict';

  // 视图自检器：把生成的插件代码真实挂载到一个离屏宿主上跑若干帧，
  // 采集「语法/规范/挂载/刷新/渲染/画风/DPR/资源回收」八个检查点。
  // 用途：内置 AI 生成后自检、MCP verify_view 让 Agent 验证效果、tools/view-check.js 命令行验收。
  const R = window.XHGCS_VIEW_VERIFY = window.XHGCS_VIEW_VERIFY || {};
  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;

  const DEFAULT_W = 460;
  const DEFAULT_H = 280;

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function drawMetrics(canvas, dpr) {
    const rect = canvas.getBoundingClientRect();
    const out = {
      css: Math.round(rect.width) + 'x' + Math.round(rect.height),
      backing: canvas.width + 'x' + canvas.height,
      dpr: dpr,
      dprOk: false, painted: 0, ink: 0, samples: 0
    };
    if (rect.width < 2 || rect.height < 2) return out;
    out.dprOk = Math.abs(canvas.width - Math.round(rect.width * dpr)) <= 2;
    try {
      const g = canvas.getContext('2d');
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
      const w = canvas.width;
      const h = canvas.height;
      const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
      const counts = new Map();
      let samples = 0;
      let painted = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          samples++;
          if (data[i + 3] <= 8) continue;
          painted++;
          const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      let top = 0;
      counts.forEach(function (n) { if (n > top) top = n; });
      out.samples = samples;
      out.painted = samples ? painted / samples : 0;
      // ink = 画布上「不是同一片纯色」的像素占比：整块单色底 = 0，真正画出东西 > 0
      out.ink = painted ? Math.max(0, (painted - top) / painted) : 0;
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    return out;
  }

  function hostBox() {
    const wrap = document.querySelector('.chart-wrap');
    if (wrap && wrap.clientWidth > 40 && wrap.clientHeight > 40) {
      const rect = wrap.getBoundingClientRect();
      return { w: Math.max(120, Math.round(rect.width) - 24), h: Math.max(80, Math.round(rect.height) - 18), from: 'chart-wrap' };
    }
    return { w: DEFAULT_W, h: DEFAULT_H, from: 'offscreen' };
  }

  function score(report) {
    let value = 100;
    value -= report.errors.length * 35;
    value -= report.warnings.length * 5;
    report.checks.forEach(function (check) {
      if (!check.ok) value -= check.hard ? 30 : 12;
    });
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  // 轻量运行统计：Agent/诊断用（谁跑了自检、最后一次为什么没通过）
  R.stats = { runs: 0, passed: 0, failed: 0, lastAt: 0, lastError: '', lastFrames: 0 };

  R.verify = async function verify(code, options) {
    const opts = options || {};
    const frames = Math.max(1, Math.min(40, Number(opts.frames) || 6));
    const startedAt = Date.now();
    R.stats.runs += 1;
    R.stats.lastAt = startedAt;
    R.stats.lastFrames = frames;
    const report = {
      ok: false,
      score: 0,
      verifiedAt: Date.now(),
      theme: (X && X.themeName ? X.themeName() : 'dark'),
      fx: (X && X.state && X.state.fx) || 'glass',
      lint: null,
      checks: [],
      errors: [],
      warnings: [],
      metrics: { frames: 0, ms: 0, themeReads: 0, domChildren: 0, domText: 0, domStyled: false, canvases: [], inkRatio: 0, box: null }
    };
    function check(id, label, ok, detail, hard) {
      report.checks.push({ id: id, label: label, ok: Boolean(ok), detail: detail || '', hard: hard !== false });
      return Boolean(ok);
    }

    if (!V || !V.compileViewSource) {
      report.errors.push('视图插件模块未加载');
      return report;
    }
    report.lint = V.lintViewCode(code);
    report.errors = report.lint.errors.slice();
    report.warnings = report.lint.warnings.slice();
    check('contract', '契约（单表达式 + id + mount）', report.lint.errors.length === 0, report.lint.errors[0] || 'OK');

    let def = null;
    try {
      def = V.compileViewSource(code);
    } catch (err) {
      report.errors.push(String((err && err.message) || err));
      report.score = score(report);
      return report;
    }

    const box = hostBox();
    report.metrics.box = box;
    const host = document.createElement('div');
    host.className = 'view-plugin-host view-verify-host';
    host.setAttribute('aria-hidden', 'true');
    // 固定定位 + 离屏：既要真实布局尺寸（保证 ensureCanvas 拿到宽高），又不能出现在用户眼前
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + box.w + 'px;height:' + box.h + 'px;display:block;pointer-events:none;';
    document.body.appendChild(host);

    const ctx = V.createViewContext(def, host);
    let mountError = null;
    try {
      if (def.mount) def.mount(ctx);
    } catch (err) {
      mountError = err;
    }
    check('mount', 'mount(ctx) 无异常', !mountError, mountError ? String((mountError && mountError.message) || mountError) : 'OK');

    const updateErrors = [];
    for (let i = 0; i < frames; i++) {
      await sleep(24);
      if (!def.update) break;
      try {
        def.update(ctx);
        report.metrics.frames += 1;
      } catch (err) {
        updateErrors.push(String((err && err.message) || err));
        if (updateErrors.length >= 3) break;
      }
    }
    report.errors = report.errors.concat(updateErrors.slice(0, 3));
    check('update', 'update(ctx) 连续 ' + report.metrics.frames + ' 帧无异常', updateErrors.length === 0, updateErrors[0] || 'OK');

    report.metrics.themeReads = ctx.__themeReads || 0;
    report.metrics.domChildren = host.children.length;
    report.metrics.domText = (host.textContent || '').trim().length;
    const canvases = Array.prototype.slice.call(host.querySelectorAll('canvas'));
    const dpr = window.devicePixelRatio || 1;
    canvases.forEach(function (canvas) { report.metrics.canvases.push(drawMetrics(canvas, dpr)); });
    report.metrics.inkRatio = report.metrics.canvases.reduce(function (acc, m) { return Math.max(acc, m.ink || 0); }, 0);

    // DOM 版插件必须复用界面工具类，否则就是"自己发明一套配色"，跟画风规范冲突
    report.metrics.domStyled = Boolean(host.querySelector('.vp-wrap, .vp-card, .vp-title, .vp-row, .panel, .pane-title, .stat-grid, .chl, .sw-actions'));

    const hasOutput = report.metrics.domChildren > 0 || report.metrics.domText > 0 || canvases.length > 0;
    const drewSomething = report.metrics.inkRatio >= 0.01 || report.metrics.domText > 0;
    check('render', '宿主里画出了东西', hasOutput && drewSomething, '子节点 ' + report.metrics.domChildren + ' · 文本 ' + report.metrics.domText + ' 字 · 墨水率 ' + (report.metrics.inkRatio * 100).toFixed(1) + '%');

    const themeClean = report.lint.usesTheme && !report.lint.colors.length;
    if (!themeClean) report.warnings.push('画风与界面不一致：' + (report.lint.usesTheme ? '' : '没有用 ctx.theme() ') + (report.lint.colors.length ? '硬编码颜色 ' + report.lint.colors.slice(0, 4).join(' ') : '') + '');
    check('style', '画风走界面令牌（ctx.theme()，无硬编码颜色）', themeClean, 'theme() 调用 ' + report.metrics.themeReads + ' 次' + (report.lint.colors.length ? ' · 硬编码 ' + report.lint.colors.slice(0, 4).join(' ') : ''), false);

    const domOnly = canvases.length === 0 && report.metrics.domChildren > 0;
    if (domOnly && !report.metrics.domStyled) report.warnings.push('DOM 版视图没用到界面工具类（.vp-wrap/.vp-card 等）：自己写配色会跟界面割裂');
    check('dom', 'DOM 版视图复用界面工具类', !domOnly || report.metrics.domStyled, domOnly ? (report.metrics.domStyled ? '命中 .vp-*/面板类' : '没找到 .vp-* / .panel') : '纯画布视图，跳过', false);

    const dprOk = canvases.length ? report.metrics.canvases.every(function (m) { return m.dprOk; }) : true;
    check('dpr', '画布按 DPR 适配（ctx.ensureCanvas）', dprOk, canvases.length ? report.metrics.canvases.map(function (m) { return m.css + '→' + m.backing; }).join(' / ') : '无画布', false);

    // 画布溢出宿主：以前漏检，于是「画布 557x623 > 宿主 631x583」这种必然被裁掉的排版被判为通过。
    const hostRect = host.getBoundingClientRect();
    const overflow = [];
    canvases.forEach(function (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > hostRect.width + 2 || rect.height > hostRect.height + 2) {
        overflow.push(Math.round(rect.width) + 'x' + Math.round(rect.height));
      }
    });
    const hostSize = Math.round(hostRect.width) + 'x' + Math.round(hostRect.height);
    check('fit', '画布不溢出宿主', overflow.length === 0, canvases.length ? (overflow.length ? overflow.join(' / ') + ' 超出宿主 ' + hostSize : '宿主 ' + hostSize + ' · OK') : '无画布', false);

    let disposeError = null;
    try {
      if (def.unmount) def.unmount(ctx);
      ctx.dispose();
    } catch (err) {
      disposeError = err;
    }
    if (host.parentNode) host.parentNode.removeChild(host);
    check('teardown', '卸载/清理无异常', !disposeError, disposeError ? String((disposeError && disposeError.message) || disposeError) : 'OK');

    if (opts.shot && canvases.length) {
      try { report.shot = canvases[0].toDataURL('image/png'); } catch (err) { /* 跨域或尺寸 0 时忽略 */ }
    }

    report.metrics.ms = Date.now() - startedAt;
    report.score = score(report);
    report.ok = report.errors.length === 0 && mountError === null && hasOutput && drewSomething;
    if (report.ok) R.stats.passed += 1;
    else R.stats.failed += 1;
    R.stats.lastError = report.ok ? '' : (report.errors[0] || (report.checks.find(function (c) { return !c.ok; }) || {}).detail || '未通过');
    return report;
  };

  // 给对话/日志用的一句话结论，避免把整份报告塞进 token
  R.summarize = function summarize(report) {
    if (!report) return '未自检';
    if (!report.ok) {
      const first = (report.errors[0] || (report.checks.find(function (c) { return !c.ok; }) || {}).detail || '未知问题');
      return '自检未通过：' + first;
    }
    const failed = report.checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.label; });
    return '自检通过（评分 ' + report.score + '，墨水率 ' + (report.metrics.inkRatio * 100).toFixed(1) + '%' + (failed.length ? '，提醒：' + failed.join('、') : '') + '）';
  };

  R.format = function format(report) {
    if (!report) return '（无自检结果）';
    const lines = ['视图自检 ' + (report.ok ? '通过' : '未通过') + ' · 评分 ' + report.score + ' · 主题 ' + report.theme + '/' + report.fx];
    report.checks.forEach(function (c) { lines.push((c.ok ? '  [ok] ' : '  [!!] ') + c.label + (c.detail ? ' —— ' + c.detail : '')); });
    if (report.errors.length) lines.push('  错误：' + report.errors.join('；'));
    if (report.warnings.length) lines.push('  提醒：' + report.warnings.join('；'));
    lines.push('  指标：' + report.metrics.frames + ' 帧 / ' + report.metrics.ms + 'ms / 墨水率 ' + (report.metrics.inkRatio * 100).toFixed(1) + '%');
    return lines.join('\n');
  };
})();
