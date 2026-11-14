(function () {
  'use strict';

  // 视图绘图原语（view kit）：把「坐标轴 / 图例 / 量程 / 裁切 / DPR / 配色」这些最容易画歪的东西
  // 收进受控实现，插件（尤其是 AI 生成的插件）只描述"画什么"，不描述"每个像素放哪"。
  // 规范见 .codex/skills/xhgcs-view/SKILL.md；接口对外的入口是 ctx.draw / ctx.pick / ctx.series / ctx.latest。
  const K = window.XHGCS_VIEW_KIT = window.XHGCS_VIEW_KIT || {};
  const X = window.XHGCS;

  const PAD = { l: 46, r: 14, t: 12, b: 24 };
  // 图例一行里"色块起点偏移(16) + 色块(8) + 名字与数值间距(8) + 右边距(8)"
  const LEGEND_RESERVE = 40;
  const DEFAULT_WINDOW = 600;

  function num(v) { return Number(v) || 0; }
  function last(ch) { return ch && ch.data && ch.data.length ? num(ch.data[ch.data.length - 1]) : 0; }
  K.latest = last;

  function textOf(ch) { return String((ch && (ch.name || ch.id)) || ''); }

  // 通道匹配：不区分子串/大小写，中英文都能命中（'温度' 能同时抓到 AHT20 温度 / JX90614 温度 1）
  function matches(ch, spec) {
    if (spec === undefined || spec === null || spec === '' || spec === '*') return Boolean(ch && ch.visible !== false);
    if (spec instanceof RegExp) return spec.test(ch.id || '') || spec.test(ch.name || '');
    const needle = String(spec).trim().toLowerCase();
    if (!needle) return true;
    const id = String(ch.id || '').toLowerCase();
    const name = String(ch.name || '').toLowerCase();
    return id === needle || name === needle || id.indexOf(needle) >= 0 || name.indexOf(needle) >= 0;
  }

  function pick(ctx, spec, limit) {
    const all = ctx.channels();
    const list = Array.isArray(spec) ? all.filter(function (ch) { return spec.some(function (s) { return matches(ch, s); }); }) : all.filter(function (ch) { return matches(ch, spec); });
    return limit ? list.slice(0, limit) : list;
  }
  K.pick = pick;

  // 统一成绘制用的 series 结构：{ch,name,unit,color,data,value}
  function series(ctx, spec, limit) {
    const channels = Array.isArray(spec) && spec.length && spec[0] && spec[0].data ? spec : pick(ctx, spec, limit);
    return channels.filter(function (ch) { return ch && Array.isArray(ch.data); }).map(function (ch) {
      return { ch: ch, id: ch.id, name: textOf(ch), unit: ch.unit || '', color: X.viewColor(ch.color) || X.canvasColors().acc, data: ch.data, value: last(ch) };
    });
  }
  K.series = series;

  function windowOf(ctx, count, wanted) {
    const fallback = (X.state && X.state.analysis && Number(X.state.analysis.windowPoints)) || DEFAULT_WINDOW;
    const n = Math.max(2, Math.min(count, Number(wanted) || fallback));
    return count > n ? count - n : 0;
  }

  function ellipsis(g, text, maxWidth) {
    let s = String(text == null ? '' : text);
    if (g.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && g.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }
  K.ellipsis = ellipsis;

  // 1/2/5 步长的"整"刻度，避免出现 3.3333 这种轴标
  function ticks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min, min + 1];
    const rough = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const start = Math.floor(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 0.5 && out.length < 12; v += step) {
      if (v >= min - step * 0.5) out.push(Number(v.toFixed(10)));
    }
    return out.length >= 2 ? out : [min, max];
  }
  K.ticks = ticks;

  function dataRange(list, index) {
    let min = Infinity, max = -Infinity;
    list.forEach(function (item) {
      const data = item.data;
      for (let i = index; i < data.length; i++) {
        const v = num(data[i]);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    if (min === Infinity) return [0, 1];
    if (min === max) { const d = Math.abs(min) * 0.1 || 1; return [min - d, max + d]; }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }

  // 画布可能被包在 .vp-plot 里（受控槽），也可能直接是 <canvas>
  function resolveCanvas(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    if (el.tagName === 'CANVAS') return el;
    if (el.canvas && el.canvas.tagName === 'CANVAS') return el.canvas;
    return el.querySelector ? el.querySelector('canvas') : null;
  }
  K.resolveCanvas = resolveCanvas;

  // 受控画布槽：插件只说"这里放一块图"，尺寸由 flex + .vp-plot 规则决定。
  // 这样画布的 CSS 尺寸不会反过来由 canvas.width/height 属性推导（那会造成每帧放大 + 溢出宿主）。
  K.plot = function plot(ctx, parent) {
    const holder = document.createElement('div');
    holder.className = 'vp-plot';
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    const host = parent || ctx.host.querySelector('.vp-wrap') || ctx.host;
    host.appendChild(holder);
    return { holder: holder, canvas: canvas, el: holder };
  };

  function frame(ctx, canvas) {
    const info = ctx.ensureCanvas(resolveCanvas(canvas));
    if (!info || info.w < 40 || info.h < 40) return null;
    const TH = ctx.theme();
    info.TH = TH;
    return info;
  }

  function emptyText(g, TH, w, h, message) {
    g.fillStyle = TH.dimText;
    g.font = TH.font.body;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(message || '暂无数据：先连接数据源或打开仿真', w / 2, h / 2);
    g.textAlign = 'left';
  }

  function drawLegend(g, TH, list, box) {
    // 右侧图例：宽度先量出来再定绘图区，保证名字和数值都不会被裁
    g.font = TH.font.body;
    let nameW = 0, valW = 0;
    list.forEach(function (item) {
      nameW = Math.max(nameW, g.measureText(item.name).width);
      valW = Math.max(valW, g.measureText(item.valueText).width);
    });
    const width = Math.min(Math.max(70, nameW + valW + LEGEND_RESERVE + 4), Math.max(90, box.w * 0.42));
    const maxItems = Math.max(1, Math.floor((box.h - 8) / 18));
    const items = list.slice(0, maxItems);
    const extra = list.length - items.length;
    let y = box.y + Math.max(12, (box.h - items.length * 18) / 2 + 9);
    g.textBaseline = 'middle';
    items.forEach(function (item) {
      g.fillStyle = item.color;
      g.fillRect(box.right - width + 2, y - 3, 8, 6);
      g.fillStyle = TH.dimText;
      g.fillText(ellipsis(g, item.name, width - LEGEND_RESERVE - valW), box.right - width + 16, y);
      g.fillStyle = TH.strongText;
      g.font = TH.font.mono;
      g.fillText(item.valueText, box.right - valW, y);
      g.font = TH.font.body;
      y += 18;
    });
    if (extra > 0) {
      g.fillStyle = TH.dimText;
      g.fillText('+' + extra, box.right - width + 16, y);
    }
    return width;
  }

  // ---- 折线/示波器：自动量程、自动图例宽度、刻度不越界，超密数据按像素列取包络 ----
  K.drawScope = function drawScope(ctx, canvas, opts) {
    const options = opts || {};
    const info = frame(ctx, canvas);
    if (!info) return { empty: true, reason: '宿主尺寸不足' };
    const g = info.ctx, TH = info.TH, w = info.w, h = info.h;
    g.clearRect(0, 0, w, h);
    g.font = TH.font.body;
    g.textBaseline = 'middle';

    const list = series(ctx, options.series === undefined ? '*' : options.series, options.limit);
    if (!list.length) { emptyText(g, TH, w, h, options.emptyText); return { empty: true, series: [] }; }
    const index = windowOf(ctx, Math.max.apply(null, list.map(function (s) { return s.data.length; })), options.window);
    const drawn = list.filter(function (s) { return s.data.length > index; });
    if (!drawn.length) { emptyText(g, TH, w, h, options.emptyText); return { empty: true, series: [] }; }

    const showLegend = options.legend !== 'none';
    const showValues = options.value !== false;
    drawn.forEach(function (s) { s.valueText = showValues ? ctx.formatValue(s.ch, s.value) : ''; });
    const legendSample = drawn.map(function (s) { return { name: s.name, color: s.color, valueText: showValues ? s.valueText : '      ' }; });

    const box = { x: 0, y: 0, w: w, h: h, right: w };
    let legendW = 0;
    if (showLegend) legendW = drawLegend(g, TH, legendSample, box);

    const plot = { x: PAD.l, y: PAD.t, w: Math.max(20, w - PAD.l - legendW - PAD.r), h: Math.max(20, h - PAD.t - PAD.b) };
    const manualRange = Array.isArray(options.yRange) && options.yRange.length === 2;
    const normalize = options.normalize === true && !manualRange;
    const channelRanges = {};
    if (normalize) {
      drawn.forEach(function (s) {
        let min = Infinity, max = -Infinity;
        for (let i = index; i < s.data.length; i++) {
          const value = num(s.data[i]);
          if (value < min) min = value;
          if (value > max) max = value;
        }
        if (min === Infinity) { min = 0; max = 1; }
        if (min === max) {
          const pad = Math.abs(min) * .08 || 1;
          min -= pad;
          max += pad;
        }
        channelRanges[s.ch.id] = [min, max];
      });
    }
    const yRange = manualRange ? options.yRange : normalize ? [0, 1] : dataRange(drawn, index);
    const yOf = function (series, value) {
      if (normalize) {
        const range = channelRanges[series.ch.id] || [0, 1];
        const span = range[1] - range[0] || 1;
        return plot.y + plot.h - ((num(value) - range[0]) / span) * plot.h;
      }
      return plot.y + plot.h - ((num(value) - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plot.h;
    };

    g.strokeStyle = TH.grid;
    g.lineWidth = 1;
    ticks(yRange[0], yRange[1], 4).forEach(function (v) {
      const y = Math.round(plot.y + plot.h - ((v - yRange[0]) / (yRange[1] - yRange[0])) * plot.h) + 0.5;
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) return;
      g.beginPath(); g.moveTo(plot.x, y); g.lineTo(plot.x + plot.w, y); g.stroke();
      g.fillStyle = TH.axisText;
      g.textAlign = 'right';
      g.fillText(ellipsis(g, normalize ? Math.round(v * 100) + '%' : ctx.axisText(v), PAD.l - 8), plot.x - 6, y);
    });
    g.textAlign = 'left';

    g.strokeStyle = TH.frame;
    g.beginPath();
    g.moveTo(plot.x + 0.5, plot.y);
    g.lineTo(plot.x + 0.5, plot.y + plot.h);
    g.lineTo(plot.x + plot.w, plot.y + plot.h);
    g.stroke();

    // 时间轴：标签永远落在绘图区内，不会被裁
    let maxLen = 0;
    drawn.forEach(function (s) { maxLen = Math.max(maxLen, s.data.length); });
    const perPoint = options.perPoint || 0;
    if (options.time !== false) {
      g.fillStyle = TH.axisText;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (let i = 0; i <= 4; i++) {
        const x = plot.x + (plot.w / 4) * i;
        const pointIndex = index + Math.round(((maxLen - 1 - index) / 4) * i);
        const label = perPoint ? ctx.axisText(pointIndex * perPoint) : String(pointIndex);
        g.fillText(ellipsis(g, label, plot.w / 4 - 6), Math.max(plot.x + 12, Math.min(plot.x + plot.w - 12, x)), plot.y + plot.h + 6);
      }
      g.textAlign = 'left';
      g.textBaseline = 'middle';
    }

    drawn.forEach(function (s) {
      const data = s.data;
      const count = maxLen - index;
      const columns = Math.max(2, Math.round(plot.w));
      const stride = Math.max(1, Math.ceil(count / (columns * 2)));
      g.strokeStyle = s.color;
      g.lineWidth = drawn.length > 4 ? 1.45 : 1.8;
      g.beginPath();
      let started = false;
      for (let i = index; i < maxLen; i += stride) {
        const x = plot.x + ((i - index) / Math.max(1, count - 1)) * plot.w;
        const y = yOf(s, data[i]);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      if (started && options.dot !== false) {
        const lx = plot.x + plot.w;
        const ly = yOf(s, s.value);
        g.fillStyle = s.color;
        g.beginPath();
        g.arc(lx, Math.max(plot.y + 2, Math.min(plot.y + plot.h - 2, ly)), 2.4, 0, Math.PI * 2);
        g.fill();
      }
    });

    if (options.title) {
      g.fillStyle = TH.dimText;
      g.textBaseline = 'top';
      g.fillText(ellipsis(g, options.title, plot.w), plot.x, 2);
      g.textBaseline = 'middle';
    }
    return {
      empty: false, plot: plot, series: drawn, yRange: yRange, legendWidth: legendW,
      normalize: normalize, channelRanges: channelRanges
    };
  };

  function shortLabel(ctx, item, max) {
    return item.unit ? item.name + ' (' + item.unit + ')' : item.name;
  }
  K.shortLabel = shortLabel;

  // ---- 横向条形：名字列先量宽再定条起点，数值贴右但不越界 ----
  K.drawBars = function drawBars(ctx, canvas, opts) {
    const options = opts || {};
    const info = frame(ctx, canvas);
    if (!info) return { empty: true };
    const g = info.ctx, TH = info.TH, w = info.w, h = info.h;
    g.clearRect(0, 0, w, h);
    g.font = TH.font.body;
    g.textBaseline = 'middle';
    const list = series(ctx, options.series === undefined ? '*' : options.series, options.limit || 12);
    if (!list.length) { emptyText(g, TH, w, h, options.emptyText); return { empty: true, items: [] }; }

    const rowH = Math.max(20, Math.min(30, Math.floor((h - 12) / Math.max(1, Math.min(list.length, options.rows || 12)))));
    let nameW = 0;
    list.forEach(function (s) { nameW = Math.max(nameW, g.measureText(shortLabel(ctx, s, 14)).width); });
    nameW = Math.min(nameW, w * 0.36);
    const valueW = 74;
    const barX = 10 + nameW + 10;
    const barW = Math.max(24, w - barX - valueW);
    let max = 0;
    list.forEach(function (s) { max = Math.max(max, Math.abs(s.value)); });
    if (!(max > 0)) max = 1;
    const span = Array.isArray(options.yRange) && options.yRange.length === 2 ? options.yRange : null;
    const items = [];
    list.forEach(function (s, i) {
      const y = 12 + i * rowH + rowH / 2;
      if (y > h - 6) return;
      const ratio = span ? Math.max(0, Math.min(1, (Math.abs(s.value) - span[0]) / ((span[1] - span[0]) || 1))) : Math.abs(s.value) / max;
      const width = Math.max(2, barW * ratio);
      g.fillStyle = TH.track;
      g.fillRect(barX, y - 7, barW, 14);
      g.fillStyle = s.color;
      g.fillRect(barX, y - 7, width, 14);
      g.fillStyle = TH.dimText;
      g.fillText(ellipsis(g, shortLabel(ctx, s), nameW), 10, y);
      g.fillStyle = TH.strongText;
      g.font = TH.font.mono;
      g.fillText(ellipsis(g, ctx.formatValue(s.ch, s.value), valueW - 6), barX + barW + 6, y);
      g.font = TH.font.body;
      items.push(s);
    });
    return { empty: false, items: items, rowHeight: rowH };
  };

  // ---- 占比环：环 + 中心合计 + 右侧占比列表，全部按可用宽度排版 ----
  K.drawDonut = function drawDonut(ctx, canvas, opts) {
    const options = opts || {};
    const info = frame(ctx, canvas);
    if (!info) return { empty: true };
    const g = info.ctx, TH = info.TH, w = info.w, h = info.h;
    g.clearRect(0, 0, w, h);
    g.font = TH.font.body;
    g.textBaseline = 'middle';
    const list = series(ctx, options.series === undefined ? '*' : options.series, options.limit || 8)
      .map(function (s) { return Object.assign({}, s, { weight: Math.max(0, options.abs ? Math.abs(s.value) : s.value) }); })
      .filter(function (s) { return s.weight > 0; });
    const total = list.reduce(function (a, s) { return a + s.weight; }, 0);
    if (!list.length || !(total > 0)) { emptyText(g, TH, w, h, options.emptyText || '暂无可占比数据'); return { empty: true, items: [] }; }

    let nameW = 0, valW = 0;
    list.forEach(function (s) {
      nameW = Math.max(nameW, g.measureText(s.name).width);
      valW = Math.max(valW, g.measureText(Math.round((s.weight / total) * 100) + '%').width);
    });
    const legendW = Math.min(Math.max(84, nameW + valW + LEGEND_RESERVE + 4), w * 0.5);
    const areaW = w - legendW;
    const cx = areaW / 2, cy = h / 2;
    const radius = Math.max(20, Math.min(areaW, h) / 2 - 12);
    const thick = Math.max(8, radius * 0.34);
    let start = -Math.PI / 2;
    list.forEach(function (s) {
      const angle = (s.weight / total) * Math.PI * 2;
      g.beginPath();
      g.arc(cx, cy, radius - thick / 2, start, start + angle);
      g.strokeStyle = s.color;
      g.lineWidth = thick;
      g.lineCap = 'butt';
      g.stroke();
      start += angle;
    });
    g.fillStyle = TH.strongText;
    g.font = TH.font.title;
    g.textAlign = 'center';
    g.fillText(ellipsis(g, options.centerText || String(list.length) + ' 项', radius * 1.7), cx, cy - 6);
    g.fillStyle = TH.dimText;
    g.font = TH.font.body;
    g.fillText('占比', cx, cy + 12);
    g.textAlign = 'left';

    const maxItems = Math.max(1, Math.floor((h - 10) / 18));
    const shown = list.slice(0, maxItems);
    let y = Math.max(12, (h - shown.length * 18) / 2 + 9);
    shown.forEach(function (s) {
      g.fillStyle = s.color;
      g.fillRect(areaW + 2, y - 3, 8, 6);
      g.fillStyle = TH.dimText;
      g.fillText(ellipsis(g, s.name, legendW - LEGEND_RESERVE - valW), areaW + 16, y);
      g.fillStyle = TH.strongText;
      g.font = TH.font.mono;
      g.fillText(Math.round((s.weight / total) * 100) + '%', w - valW - 2, y);
      g.font = TH.font.body;
      y += 18;
    });
    if (list.length > shown.length) {
      g.fillStyle = TH.dimText;
      g.fillText('+' + (list.length - shown.length), areaW + 16, y);
    }
    return { empty: false, items: list, total: total };
  };
})();
