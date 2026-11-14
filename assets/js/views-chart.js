(function () {
  'use strict';
  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;
  const state = X.state;
  const ref = V.ref;

  let chartView = { xStart: null, xEnd: null, yMin: null, yMax: null, manual: false };
  let chartMetrics = null;
  let chartDrag = null;
  let chartBound = false;
  let lastStateT = null;
  let frozenChartX = null;
  // P1.3 交互层状态（悬停/框选/操作条；不持久化）

  // 小数位跟着刻度间隔走：同一条轴上不会出现 0.500s 和 1.00s 混排
  function stepDigits(step) {
    const s = Math.abs(Number(step) || 0);
    if (!Number.isFinite(s) || s <= 0) return 2;
    if (s >= 1) return Number.isInteger(s) ? 0 : 1;
    if (s >= .1) return 1;
    if (s >= .01) return 2;
    if (s >= .001) return 3;
    return 4;
  }

  function axisText(value, step) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    if (step) return n.toFixed(stepDigits(step));
    const abs = Math.abs(n);
    if (abs < 1e-12) return '0';
    if (abs >= 100000) return n.toExponential(1);
    if (abs >= 1000) return n.toFixed(0);
    if (abs >= 100) return n.toFixed(1);
    if (abs >= 1) return n.toFixed(2);
    if (abs >= .01) return n.toFixed(3);
    if (abs >= .0001) return n.toFixed(4);
    return n.toExponential(2);
  }

  function tickStep(span, target) {
    const rough = span / Math.max(1, target);
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-12))));
    const fraction = rough / power;
    let factor = 10;
    if (fraction < 1.5) factor = 1;
    else if (fraction < 3) factor = 2;
    else if (fraction < 7) factor = 5;
    return factor * power;
  }

  function niceTicks(min, max, target) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min, max];
    const step = tickStep(max - min, target);
    const start = Math.ceil(min / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0; i <= target * 3; i++) {
      const value = start + i * step;
      if (value > max + step * 1e-6) break;
      if (value >= min - step * 1e-6) ticks.push(Number(value.toPrecision(12)));
    }
    if (ticks.length < 2) return [min, max];
    return ticks;
  }

  function resetChartView(render) {
    const wasFrozen = !!chartView.frozen;
    chartView = { xStart: null, xEnd: null, yMin: null, yMax: null, manual: false, follow: false, yScale: 1, yPan: 0 };
    chartMetrics = null;
    frozenChartX = null;
    if (wasFrozen) notifyFreeze(false);
    if (render !== false && typeof V.renderChart === 'function') V.renderChart();
  }

  function notifyFreeze(frozen) {
    window.dispatchEvent(new CustomEvent('xhgcs:chart-freeze-changed', { detail: { frozen: !!frozen } }));
  }

  // v43：暂停 = 冻结查看。只钉住当前窗口，不碰数据来源（串口继续接收、仿真继续推进）；
  // 恢复时回到「现在」（recenterChartView）。
  function freezeChart(frozen) {
    if (frozen) {
      if (chartView.frozen) return;
      const win = chartMetrics && chartMetrics.xEnd > chartMetrics.xStart ? chartMetrics : null;
      const xEnd = win ? win.xEnd : Math.max(0.001, Number(state.t) || 0);
      const xStart = win ? win.xStart : Math.max(0, xEnd - Math.max(0.001, Number(state.windowSec) || 30));
      chartView = Object.assign({}, chartView, {
        xStart: xStart,
        xEnd: xEnd,
        manual: true,
        follow: false,
        full: false,
        frozen: true
      });
      notifyFreeze(true);
      if (typeof V.renderChart === 'function') V.renderChart();
      return;
    }
    if (!chartView.frozen) return;
    chartView.frozen = false;
    notifyFreeze(false);
    recenterChartView();
  }

  // X 轴范围统一钳制到 0 ~ 当前时间：缩放到超过总时长时直接显示 0 ~ 最大时间
  function clampChartX(xStart, xEnd) {
    const total = Number(state.t) || 0;
    const span = Math.max(1e-6, xEnd - xStart);
    // 冻结查看：窗口原样钉住，右端不吸附「现在」（解除冻结走按钮/回中/切页，不靠贴边判定，
    // 否则冻结瞬间「恰好贴边」会被下一帧误判为回到现在）
    if (chartView.frozen) {
      const start = Math.max(0, Math.min(xStart, Math.max(0, total - span)));
      return { xStart: start, xEnd: start + span, follow: false, full: false };
    }
    // total 还没起步（刚清过数据 / 仿真关着还没收到帧）时原来原样返回、完全不夹取，
    // 而拖动平移正是走这里 —— 于是随便一拖就能把视野滑到任意负时间，
    // 用户卡在一个「-3865s」的空画面上出不来（截图里就是这个）。左边界一律钉在 0。
    if (!(total > 0)) return { xStart: 0, xEnd: span, follow: true, full: false };
    if (span >= total) return { xStart: 0, xEnd: total, follow: true, full: true };
    const maxStart = Math.max(0, total - span);
    const start = Math.min(Math.max(0, xStart), maxStart);
    return { xStart: start, xEnd: start + span, follow: start >= maxStart - 1e-9, full: false };
  }

  function recenterChartView(render) {
    const wasFrozen = !!chartView.frozen;
    let maxLen = 0;
    X.allChannels().forEach((ch) => { maxLen = Math.max(maxLen, ch.data.length); });
    const dt = Math.max(1e-6, Number(state.intervalMs) / 1000);
    const fullSpan = Math.max(0, (Math.max(maxLen, 2) - 1) * dt);
    // 「自适应」要看全量数据，「固定」才用 windowSec。原来写成 Math.min(windowSec, fullSpan)，
    // 于是自适应永远不会超过 windowSec（下拉最多 30 秒）：跑过 30 秒之后两种模式渲染完全相同，
    // 用户点「自适应」想看全貌、波形纹丝不动，内存里留的几小时数据在界面上根本看不到。
    const autoSpan = state.zoomMode === 'fixed' ? state.windowSec : (fullSpan || state.windowSec);
    let span = Math.max(0.001, autoSpan);
    if (chartView.manual && Number.isFinite(chartView.xStart) && Number.isFinite(chartView.xEnd) && chartView.xEnd > chartView.xStart) {
      span = Math.max(0.001, chartView.xEnd - chartView.xStart);
    }
    const dataStart = Math.max(0, state.t - fullSpan);
    const recenterX = Math.max(dataStart, Math.max(0, state.t - span));
    chartView = {
      xStart: recenterX,
      xEnd: state.t,
      yMin: chartView.manual && Number.isFinite(chartView.yMin) ? chartView.yMin : null,
      yMax: chartView.manual && Number.isFinite(chartView.yMax) ? chartView.yMax : null,
      manual: true,
      follow: true,
      full: false,
      frozen: false,
      yScale: chartView.yScale || 1,
      yPan: Number.isFinite(chartView.yPan) ? chartView.yPan : 0
    };
    if (wasFrozen) notifyFreeze(false);
    frozenChartX = { xStart: chartView.xStart, xEnd: chartView.xEnd };
    if (render !== false && typeof V.renderChart === 'function') V.renderChart();
  }

  function chartPoint(event) {
    const rect = ref.chart.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function insidePlot(m, x, y) {
    return x >= m.padL && x <= m.padL + m.plotW && y >= m.padT && y <= m.padT + m.plotH;
  }

  // ---- P1.3 交互层状态（不持久化） ----
  let chartHover = null;      // 悬停快照 { idx, lane, rel, y, x }
  let chartSel = null;        // 选区 { a, b } 样本索引（a 不一定小于 b）
  let chartSelDrag = null;    // 框选拖拽 { pointerId, startIdx }
  let chartRenderRaf = 0;

  function fmtRelSec(rel) {
    const n = Number(rel) || 0;
    if (Math.abs(n) < 0.05) return '0.0 s';
    return (n < 0 ? '−' : '+') + Math.abs(n).toFixed(1) + ' s';
  }

  // TH.* 都是 hex / rgb 字符串，叠加层需要 alpha 版本；统一在这里转换
  function chartAlpha(color, a) {
    const c = String(color == null ? '' : color).trim();
    if (!c) return 'rgba(255,255,255,' + a + ')';
    if (c.charAt(0) === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      if (h.length !== 6) return c;
      const n = parseInt(h, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(',').map(Number);
      return 'rgba(' + (p[0] || 0) + ',' + (p[1] || 0) + ',' + (p[2] || 0) + ',' + a + ')';
    }
    return c;
  }

  function scheduleChartRender() {
    if (chartRenderRaf) return;
    chartRenderRaf = requestAnimationFrame(function () {
      chartRenderRaf = 0;
      V.renderChart();
    });
  }

  function clearChartHover() {
    chartHover = null;
    const el = ref.chartTooltip;
    if (el) el.classList.remove('show');
    if (ref.chartCrosshair) ref.chartCrosshair.classList.add('hidden');
  }

  function hideChartTooltip() {
    clearChartHover();
    scheduleChartRender();
  }

  function chartSelRange() {
    if (!chartSel) return null;
    const a = Math.min(chartSel.a, chartSel.b);
    const b = Math.max(chartSel.a, chartSel.b);
    if (!(b > a)) return null;
    return { a: a, b: b };
  }

  function updateSelBar() {
    const bar = document.getElementById('chartSelBar');
    if (!bar) return;
    const range = chartSelRange();
    if (!range) { bar.classList.add('hidden'); return; }
    const m = chartMetrics;
    const dt = m && m.dt ? m.dt : 0.1;
    const sec = (range.b - range.a) * dt;
    const deltaEl = document.getElementById('chartSelDelta');
    const freqEl = document.getElementById('chartSelFreq');
    if (deltaEl) deltaEl.textContent = 'Δ ' + sec.toFixed(1) + ' s';
    if (freqEl) freqEl.textContent = '1/Δt ' + (sec > 0 ? (1 / sec).toFixed(3) : '0.000') + ' Hz';
    bar.classList.remove('hidden');
  }

  function clearChartSelection(render) {
    chartSel = null;
    chartSelDrag = null;
    updateSelBar();
    if (render !== false) scheduleChartRender();
  }

  function zoomToChartSelection() {
    const range = chartSelRange();
    const m = chartMetrics;
    if (!range || !m) return;
    if (range.b - range.a < 1) return;
    const xStart = m.firstT + range.a * m.dt;
    const xEnd = m.firstT + range.b * m.dt;
    const clamped = clampChartX(xStart, xEnd);
    chartView = {
      xStart: clamped.xStart,
      xEnd: clamped.xEnd,
      yMin: null,
      yMax: null,
      manual: true,
      follow: clamped.follow,
      full: clamped.full,
      frozen: !!chartView.frozen,
      yScale: Number.isFinite(chartView.yScale) ? chartView.yScale : 1,
      yPan: Number.isFinite(chartView.yPan) ? chartView.yPan : 0
    };
    clearChartSelection(false);
    V.renderChart();
  }

  function bindChartSelectionBar() {
    const zoomBtn = document.getElementById('btnChartSelZoom');
    if (zoomBtn && !zoomBtn.__bound) { zoomBtn.__bound = true; zoomBtn.addEventListener('click', zoomToChartSelection); }
    const clearBtn = document.getElementById('btnChartSelClear');
    if (clearBtn && !clearBtn.__bound) { clearBtn.__bound = true; clearBtn.addEventListener('click', function () { clearChartSelection(); }); }
    if (!bindChartSelectionBar.__esc) {
      bindChartSelectionBar.__esc = true;
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        if (window.XHGCS_OVERLAY && typeof window.XHGCS_OVERLAY.depth === 'function' && window.XHGCS_OVERLAY.depth() > 0) return;
        if (!chartSel) return;
        event.preventDefault();
        event.stopPropagation();
        clearChartSelection();
      });
    }
  }

  function idxAtClientX(clientX) {
    const m = chartMetrics;
    if (!m) return 0;
    const rect = ref.chart.getBoundingClientRect();
    const x = clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (x - m.padL) / m.plotW));
    const timeAt = m.xStart + frac * (m.xEnd - m.xStart);
    return Math.max(0, Math.min(m.maxLen - 1, Math.round((timeAt - m.firstT) / m.dt)));
  }

  function hoverLaneAt(m, y) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < m.lanes.length; i++) {
      const lane = m.lanes[i];
      if (y >= lane.top && y <= lane.bot) return i;
      const dist = y < lane.top ? lane.top - y : y - lane.bot;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  // 读数卡固定在绘图区右上角（右边界 = x1-12，不压右缘标签槽）；只列悬停 lane 内可见通道，
  // 悬停 lane 只有 1 条时补最近轨 1 条（既有回归要求悬停至少显示 2 行多通道值），最多 8 行
  function updateChartTooltip(event) {
    const el = ref.chartTooltip;
    const m = chartMetrics;
    if (!el || !m || state.subview !== 'wave' || chartSelDrag) { clearChartHover(); return; }
    const p = chartPoint(event);
    if (!insidePlot(m, p.x, p.y)) { clearChartHover(); return; }
    const visible = X.plotChannels().filter((ch) => ch.data.length > 1);
    if (!visible.length) { clearChartHover(); return; }
    const laneIndex = hoverLaneAt(m, p.y);
    if (laneIndex < 0) { clearChartHover(); return; }
    const timeAt = m.xStart + ((p.x - m.padL) / m.plotW) * (m.xEnd - m.xStart);
    const nearIndex = Math.max(0, Math.min(m.maxLen - 1, Math.round((timeAt - m.firstT) / m.dt)));
    const t = m.firstT + nearIndex * m.dt;
    const rel = t - state.t;
    chartHover = { idx: nearIndex, lane: laneIndex, rel: rel, y: p.y, x: p.x };
    // A 稿读数语言：列出全部可见通道（按 lane 顺序），悬停 lane 的通道排最前；上限 8 行
    const lane = m.lanes[laneIndex];
    const laneIds = lane ? lane.channels : [];
    const ordered = [];
    visible.filter((ch) => laneIds.indexOf(ch.id) >= 0).forEach((ch) => { if (ordered.indexOf(ch) < 0) ordered.push(ch); });
    visible.forEach((ch) => { if (ordered.indexOf(ch) < 0) ordered.push(ch); });
    const rowsCh = ordered.slice(0, 8);
    const moreRows = ordered.length > 8 ? '<div class="chart-tip-more">另有 ' + (ordered.length - 8) + ' 个通道</div>' : '';
    const rows = rowsCh.map((ch) => {
      const index = Math.min(nearIndex, ch.data.length - 1);
      const unit = ch.unit ? ' ' + X.esc(ch.unit) : '';
      return '<div class="chart-tip-row"><i style="background:' + X.viewColor(ch.color) + '"></i>'
        + '<span class="chart-tip-label">' + X.esc(ch.name || ('通道' + ch.id)) + '</span>'
        + '<b>' + X.esc(X.formatChannelValue(ch, ch.data[index])) + unit + '</b></div>';
    }).join('');
    el.innerHTML = '<div class="chart-tip-time">t = ' + t.toFixed(3) + ' s · ' + fmtRelSec(rel) + '</div>' + rows + moreRows;
    if (el.parentNode !== document.body) document.body.appendChild(el);
    el.classList.add('show');
    const chartRect = ref.chart.getBoundingClientRect();
    const width = el.offsetWidth || 200;
    const height = el.offsetHeight || 120;
    const plotLeft = chartRect.left + m.padL;
    const plotTop = chartRect.top + m.padT;
    const plotRight = chartRect.left + m.padL + m.plotW;
    const plotBottom = chartRect.top + m.padT + m.plotH;
    const slotLimit = plotRight - 12; // 右边界：不越过末端标签槽
    const gap = 14;
    // 跟随光标：右侧放不下就翻到左边，下侧放不下就翻到上方（A 稿同款贴边翻转）
    let left = event.clientX + gap;
    if (left + width > slotLimit) left = event.clientX - width - gap;
    left = Math.max(plotLeft + 8, Math.min(left, slotLimit - width));
    let top = event.clientY + gap;
    if (top + height > plotBottom - 8) top = event.clientY - height - gap;
    top = Math.max(plotTop + 8, Math.min(top, plotBottom - height - 8));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    const wrap = ref.chart.closest('.chart-wrap');
    const cross = ref.chartCrosshair;
    if (cross && wrap) {
      const wrapRect = wrap.getBoundingClientRect();
      const snapX = chartXOf(m, nearIndex);
      cross.style.left = Math.round(chartRect.left - wrapRect.left + snapX) + 'px';
      cross.style.top = Math.round(chartRect.top - wrapRect.top + m.padT) + 'px';
      cross.style.height = Math.round(m.plotH) + 'px';
      cross.classList.remove('hidden');
      if (ref.chartCrosshairTime) ref.chartCrosshairTime.textContent = fmtRelSec(rel);
    }
    scheduleChartRender();
  }


  function bindChartEvents() {
    if (chartBound || !ref.chart) return;
    chartBound = true;
    const canvas = ref.chart;
    canvas.addEventListener('wheel', onChartWheel, { passive: false });
    canvas.addEventListener('pointerdown', onChartPointerDown);
    canvas.addEventListener('pointermove', onChartPointerMove);
    canvas.addEventListener('pointerleave', onChartPointerLeave);
    canvas.addEventListener('pointerup', onChartPointerUp);
    canvas.addEventListener('pointercancel', onChartPointerUp);
    canvas.addEventListener('dblclick', function () {
      clearChartSelection(false);
      resetChartView();
    });
    bindChartSelectionBar();
  }

  function onChartPointerLeave() {
    if (chartDrag || chartSelDrag) return;
    hideChartTooltip();
  }

  function onChartWheel(event) {
    const m = chartMetrics;
    if (!m) return;
    const p = chartPoint(event);
    if (!insidePlot(m, p.x, p.y)) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 0.85 : 1.18;
    const fx = (p.x - m.padL) / m.plotW;
    const fy = 1 - (p.y - m.padT) / m.plotH;
    const spanX = m.xEnd - m.xStart;
    const spanY = m.yMax - m.yMin;
    if (!(spanX > 0) || !(spanY > 0)) return;
    const onlyX = event.shiftKey && !event.altKey;
    const onlyY = event.altKey && !event.shiftKey;
    const multiLane = Number(m.laneCount) > 1;
    let xStart = m.xStart, xEnd = m.xEnd;
    let yMin = m.yMin, yMax = m.yMax;
    let yScale = Number.isFinite(chartView.yScale) && chartView.yScale > 0 ? chartView.yScale : 1;
    let yPan = Number.isFinite(chartView.yPan) ? chartView.yPan : 0;
    let followX = chartView.manual ? Boolean(chartView.follow) : true;
    let fullX = chartView.manual ? Boolean(chartView.full) : false;
    if (!onlyY) {
      const timeAt = m.xStart + fx * spanX;
      const total = Math.max(m.dt * 2, Number(state.t) || 0);
      const newSpan = Math.min(Math.max(spanX * factor, Math.max(m.dt * 2, 0.001)), total);
      const range = clampChartX(timeAt - fx * newSpan, timeAt - fx * newSpan + newSpan);
      xStart = range.xStart;
      xEnd = range.xEnd;
      followX = range.follow;
      fullX = range.full;
    }
    if (!onlyX) {
      if (multiLane) {
        // 多轨：统一 Y 缩放系数（锚点近似取指针所在轨中心），每轨仍按自己的量纲域渲染
        yScale = Math.min(4, Math.max(0.4, yScale / factor));
        // yPan 保持不变：缩放围绕每轨中心，轴心平移由拖动负责
      } else {
        const valueAt = m.yMin + fy * spanY;
        const autoSpanY = Math.max(1e-6, (m.autoYMax - m.autoYMin) || spanY);
        const newSpan = Math.min(Math.max(spanY * factor, 1e-9), autoSpanY * 6);
        yMin = valueAt - fy * newSpan;
        yMax = yMin + newSpan;
      }
    }
    chartView = { xStart: xStart, xEnd: xEnd, yMin: multiLane ? null : yMin, yMax: multiLane ? null : yMax, manual: true, follow: followX, full: fullX, frozen: !!chartView.frozen, yScale: yScale, yPan: yPan };
    clearChartHover();
    V.renderChart();
  }

  // 左键拖拽 = 框选；Shift + 拖动（或中键拖动）= 平移；滚轮缩放不变
  function onChartPointerDown(event) {
    if (!chartMetrics) return;
    if (event.button !== 0 && event.button !== 1) return;
    const p = chartPoint(event);
    if (!insidePlot(chartMetrics, p.x, p.y)) return;
    event.preventDefault();
    const isPan = event.button === 1 || (event.button === 0 && event.shiftKey);
    try { ref.chart.setPointerCapture(event.pointerId); } catch (err) {}
    if (isPan) {
      chartDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        xStart: chartMetrics.xStart,
        xEnd: chartMetrics.xEnd,
        yMin: chartMetrics.yMin,
        yMax: chartMetrics.yMax,
        yPan: Number.isFinite(chartMetrics.yPan) ? chartMetrics.yPan : 0
      };
      ref.chart.classList.add('panning');
      clearChartHover();
      return;
    }
    const idx = idxAtClientX(event.clientX);
    chartSelDrag = { pointerId: event.pointerId, startIdx: idx };
    chartSel = { a: idx, b: idx };
    updateSelBar();
    clearChartHover();
  }

  function onChartPointerMove(event) {
    if (chartSelDrag && event.pointerId === chartSelDrag.pointerId && chartMetrics) {
      chartSel = { a: chartSelDrag.startIdx, b: idxAtClientX(event.clientX) };
      updateSelBar();
      scheduleChartRender();
      return;
    }
    if (chartDrag && event.pointerId === chartDrag.pointerId && chartMetrics) {
      const dx = event.clientX - chartDrag.startX;
      const dy = event.clientY - chartDrag.startY;
      const spanX = chartDrag.xEnd - chartDrag.xStart;
      const spanY = chartDrag.yMax - chartDrag.yMin;
      const shiftX = spanX > 0 ? dx / chartMetrics.plotW * spanX : 0;
      const shiftY = spanY > 0 ? dy / chartMetrics.plotH * spanY : 0;
      const range = clampChartX(chartDrag.xStart - shiftX, chartDrag.xEnd - shiftX);
      const multiLane = Number(chartMetrics.laneCount) > 1;
      const nextPan = multiLane
        ? Math.max(-2, Math.min(2, (chartDrag.yPan || 0) + dy / Math.max(1, chartMetrics.plotH)))
        : chartDrag.yPan;
      chartView = {
        xStart: range.xStart,
        xEnd: range.xEnd,
        yMin: multiLane ? null : chartDrag.yMin + shiftY,
        yMax: multiLane ? null : chartDrag.yMax + shiftY,
        manual: true,
        follow: range.follow,
        full: range.full,
        frozen: !!chartView.frozen,
        yScale: Number.isFinite(chartView.yScale) ? chartView.yScale : 1,
        yPan: multiLane ? nextPan : 0
      };
      V.renderChart();
      return;
    }
    updateChartTooltip(event);
  }

  function onChartPointerUp(event) {
    if (chartSelDrag && event.pointerId === chartSelDrag.pointerId) {
      chartSelDrag = null;
      try { ref.chart.releasePointerCapture(event.pointerId); } catch (err) {}
      const range = chartSelRange();
      if (!range || range.b - range.a < 4) clearChartSelection();
      else updateSelBar();
      scheduleChartRender();
      return;
    }
    if (!chartDrag || event.pointerId !== chartDrag.pointerId) return;
    chartDrag = null;
    ref.chart.classList.remove('panning');
    try { ref.chart.releasePointerCapture(event.pointerId); } catch (err) {}
  }


  // ---- P1.2 标注层：右缘末端标签槽 + 阈值（数据源 X.alarmThresholds） ----
  // canvasColors() 目前没有语义色，危险色在运行时从主题令牌读一次（不写死颜色、不改 data.js）
  let dangerCache = { key: '', color: '' };
  function dangerColor(TH) {
    const root = document.documentElement;
    const key = (root.dataset.theme || 'dark') + '|' + (root.dataset.fx || 'glass');
    if (dangerCache.key !== key || !dangerCache.color) {
      const value = getComputedStyle(root).getPropertyValue('--danger').trim();
      dangerCache = { key: key, color: value || TH.acc };
    }
    return dangerCache.color;
  }

  // 通道阈值：唯一数据源 X.alarmThresholds(ch)（= ch.warnHigh / ch.warnLow），不做任何猜测
  function channelThresholdsOf(ch) {
    const t = typeof X.alarmThresholds === 'function' ? X.alarmThresholds(ch) : null;
    const high = t && t.warnHigh != null ? Number(t.warnHigh) : (ch.warnHigh != null ? Number(ch.warnHigh) : null);
    const low = t && t.warnLow != null ? Number(t.warnLow) : (ch.warnLow != null ? Number(ch.warnLow) : null);
    return {
      warnHigh: Number.isFinite(high) ? high : null,
      warnLow: Number.isFinite(low) ? low : null
    };
  }

  // ---- P3.2 lane kit：图表/告警页共用的 lane 域/刻度/映射（单一实现，禁止另画一套） ----
  function laneDomain(channels, opts) {
    opts = opts || {};
    const target = Math.max(2, Math.min(8, Number(opts.targetTicks) || 4));
    let min = Infinity, max = -Infinity;
    (channels || []).forEach((ch) => {
      const data = ch && ch.data ? ch.data : [];
      for (let i = 0; i < data.length; i += 1) {
        const v = Number(data[i]);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    (opts.thresholds || []).forEach((raw) => {
      if (raw == null || raw === '') return;
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max - min < 1e-6) { min -= 1; max += 1; }
    const pad = (max - min) * 0.12;
    const paddedMin = min - pad;
    const paddedMax = max + pad;
    const step = tickStep(paddedMax - paddedMin, target);
    if (!(step > 0)) return { yMin: paddedMin, yMax: paddedMax, ticks: [paddedMin, paddedMax], step: paddedMax - paddedMin };
    // 域向步长外扩（floor/ceil），保证覆盖 padded 区间：曲线永不裁切/贴边
    const yMin = Math.floor((paddedMin + 1e-9) / step) * step;
    const yMax = Math.ceil((paddedMax - 1e-9) / step) * step;
    const count = Math.max(1, Math.round((yMax - yMin) / step));
    const ticks = Array.from({ length: count + 1 }, (_, i) => Number((yMin + i * step).toPrecision(12)));
    return { yMin: yMin, yMax: yMax, ticks: ticks, step: step };
  }

  function laneYOf(value, geo) {
    return geo.top + geo.h - ((Number(value) - geo.yMin) / (geo.yMax - geo.yMin)) * geo.h;
  }

  function laneGapFor(laneCount, plotH) {
    if (!(laneCount > 1)) return 0;
    const raw = Math.round((plotH * 0.068) / (laneCount + 0.068 * (laneCount - 1)));
    return Math.max(6, Math.min(18, raw));
  }

  function shortChannelName(name) {
    const chars = Array.from(String(name == null ? '' : name).trim());
    if (chars.length <= 6) return chars.join('');
    return chars.slice(0, 6).join('') + '…';
  }

  function thresholdText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(1) : '--';
  }

  // 右缘固定标签槽（A 稿）：引线（末点 → +6 → +11 折线）+ 4px 色点 + 短名 + 值（右对齐）+ 单位
  // 按 lane 调用：19px 碰撞回退 + 整块 clamp 在本 lane (top+8, bot-8)，绝不跨 lane / 压 X 轴。
  function drawLaneLabels(ctx, lane, items, plotW, padL, W) {
    if (!items || !items.length) return;
    const TH = X.canvasColors();
    const x1 = padL + plotW;
    const top = lane.top, bot = lane.bot;
    const gap = 19;
    const minY = top + 8, maxY = bot - 8;
    const list = items.map((item) => ({
      color: item.color,
      name: item.name,
      text: item.text,
      unit: item.unit || '',
      anchor: Math.max(top + 2, Math.min(bot - 2, item.y)),
      y: Math.max(top + 2, Math.min(bot - 2, item.y))
    })).sort((a, b) => a.y - b.y);
    let cursor = minY;
    list.forEach((item) => {
      item.y = Math.max(item.y, cursor);
      cursor = item.y + gap;
    });
    const overflow = list[list.length - 1].y - maxY;
    if (overflow > 0) {
      list.forEach((item) => { item.y -= overflow; });
      let back = minY;
      list.forEach((item) => {
        item.y = Math.max(item.y, back);
        back = item.y + gap;
      });
    }
    ctx.save();
    ctx.textBaseline = 'middle';
    list.forEach((item) => {
      const y = Math.round(item.y);
      const anchor = item.anchor;
      const color = X.viewColor(item.color);
      // 引线：数据末点 → +6 → +11 折线
      ctx.strokeStyle = color;
      ctx.globalAlpha = .62;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, anchor);
      ctx.lineTo(x1 + 6, y);
      ctx.lineTo(x1 + 11, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 4px 色点
      ctx.beginPath();
      ctx.arc(x1 + 15, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      // 短名 10px dim（最长 6 字，超出截断）
      ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = TH.dimText;
      ctx.fillText(shortChannelName(item.name), x1 + 21, y);
      // 单位最右 W-8；值右对齐到单位左侧（12px num / heading 色）
      const unit = item.unit || '';
      const unitW = unit ? ctx.measureText(unit).width : 0;
      if (unit) ctx.fillText(unit, W - 8 - unitW, y);
      ctx.font = '12px "Bahnschrift","DIN Alternate","Segoe UI",sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = TH.strongText;
      ctx.fillText(item.text, W - 8 - unitW - (unit ? 4 : 0), y);
    });
    lane.labelPositions = list.map((item) => ({ name: item.name, y: Math.round(item.y), anchor: Math.round(item.anchor) }));
    lane.endLabelBoxes = list.map((item) => ({ name: item.name, x: x1 + 11, y: Math.round(item.y) - 7, w: Math.max(24, W - (x1 + 11) - 4), h: 14 }));
    ctx.restore();
  }

  // 阈值线 + 左端 10px 文本（高 26.0 V / 低 22.0 V）；跨 lane 名称时把文字让到线下方
  function drawThresholdMarkers(ctx, lane, padL, plotW, TH) {
    const list = lane.thresholds || [];
    if (!list.length) return;
    const danger = dangerColor(TH);
    const x0 = padL + 1;
    const x1 = padL + plotW - 1;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    list.forEach((entry) => {
      [['warnHigh', '高'], ['warnLow', '低']].forEach((pair) => {
        const value = entry[pair[0]];
        if (value == null) return;
        const y = lane.yOf(value, entry.ch);
        if (y < lane.top - 1 || y > lane.bot + 1) return;
        ctx.strokeStyle = danger;
        ctx.globalAlpha = .62;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const text = pair[1] + ' ' + thresholdText(value) + (entry.ch.unit ? ' ' + entry.ch.unit : '');
        ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillStyle = danger;
        let labelY = y - 7;
        // 不压 lane 名称标签（名称在 lane 左上角 top+10 附近）
        if (Math.abs(y - (lane.top + 10)) < 14) labelY = y + 9;
        ctx.fillText(text, padL + 6, labelY);
        if (!lane.markerPositions) lane.markerPositions = [];
        lane.markerPositions.push({ id: entry.ch.id, kind: pair[0], value: value, y: Math.round(y) });
      });
    });
    ctx.restore();
  }


  function chartXOf(m, index) {
    return m.padL + m.plotW * ((m.firstT + index * m.dt - m.xStart) / (m.xEnd - m.xStart));
  }

  function chartYOf(m, value, ch) {
    if (m.scaleMode === 'normalize' && ch) {
      const range = m.channelRanges && m.channelRanges[ch.id];
      if (range) {
        const pad = Math.max(1e-9, (range[1] - range[0]) * .08);
        const min = range[0] - pad;
        const max = range[1] + pad;
        return m.padT + m.plotH - ((value - min) / (max - min)) * m.plotH;
      }
    }
    return m.padT + m.plotH - ((value - m.yMin) / (m.yMax - m.yMin)) * m.plotH;
  }

  function renderChart() {
    bindChartEvents();
    const info = V.ensureCanvas(ref.chart);
    if (!info) return;
    const ctx = info.ctx, W = info.w, H = info.h;
    const padL = 62, padT = 16, padB = 36;
    // 右缘固定标签槽（A 稿）：106~150px，随画布宽收放；x1 = W - padR
    const padR = Math.max(106, Math.min(150, Math.round(W * .15)));
    const plotW = W - padL - padR, plotH = H - padT - padB;
    // 「勾选了通道」和「通道里有数据」是两件事：冷启动（仿真关、串口未连）时通道是勾选的，
    // 只是还没有点，原来一律显示「无可见通道」，等于把「没勾选」和「还没数据」说成同一句
    const allMarked = X.plotChannels();
    const focus = state.chartFocusId ? allMarked.filter((ch) => ch.id === state.chartFocusId)[0] : null;
    if (state.chartFocusId && !focus) state.chartFocusId = '';
    const marked = focus ? [focus] : allMarked;
    const visible = marked.filter((c) => c.data.length > 1);
    const dt = Math.max(1e-6, Number(state.intervalMs) / 1000);
    const TH = X.canvasColors();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, W, H);

    let maxLen = 0, channelSpan = 1;
    visible.forEach((ch) => {
      maxLen = Math.max(maxLen, ch.data.length);
      channelSpan = Math.max(channelSpan, Math.abs(ch.range[1] - ch.range[0]) || 1);
    });
    maxLen = Math.max(maxLen, 2);
    const fullSpan = Math.max(0, (maxLen - 1) * dt);
    // 同上：自适应用全量跨度，固定才用 windowSec
    const windowSeconds = state.zoomMode === 'fixed' ? state.windowSec : (fullSpan || state.windowSec);
    let xStart, xEnd;
    if (lastStateT != null && state.t < lastStateT - Math.max(0.1, dt * 2)) {
      const wasFrozen = !!chartView.frozen;
      chartView = { xStart: null, xEnd: null, yMin: null, yMax: null, manual: false, follow: false, full: false, yScale: 1, yPan: 0 };
      frozenChartX = null;
      if (wasFrozen) notifyFreeze(false);
    }
    lastStateT = state.t;
    const noVisible = visible.length === 0;
    if (noVisible) {
      // 全部通道取消后，采样仍在继续，但空图的时间轴不能继续漂移。
      if (!frozenChartX) {
        if (chartView.manual && Number.isFinite(chartView.xStart) && Number.isFinite(chartView.xEnd)
          && chartView.xEnd > chartView.xStart) {
          frozenChartX = { xStart: chartView.xStart, xEnd: chartView.xEnd };
        } else {
          const span = Math.max(0.001, windowSeconds);
          frozenChartX = {
            xStart: Math.max(0, state.t - span),
            xEnd: Math.max(span, state.t)
          };
        }
      }
      xStart = frozenChartX.xStart;
      xEnd = frozenChartX.xEnd;
    } else {
      frozenChartX = null;
      if (chartView.manual && Number.isFinite(chartView.xStart) && Number.isFinite(chartView.xEnd) && chartView.xEnd > chartView.xStart) {
        if (chartView.full && !chartView.frozen) {
          xStart = 0;
          xEnd = Math.max(1e-6, state.t);
          chartView.xStart = xStart;
          chartView.xEnd = xEnd;
        } else {
          const manualSpan = chartView.xEnd - chartView.xStart;
          if (chartView.follow) chartView.xStart = Math.max(0, state.t - manualSpan);
          const range = clampChartX(chartView.xStart, chartView.follow ? state.t : chartView.xEnd);
          chartView.xStart = range.xStart;
          chartView.xEnd = range.xEnd;
          chartView.follow = range.follow;
          chartView.full = range.full;
          // 拖/缩到右端（回到现在）即视为解除冻结，按钮同步
          if (range.follow && chartView.frozen) {
            chartView.frozen = false;
            notifyFreeze(false);
          }
          xStart = range.xStart;
          xEnd = range.xEnd;
        }
      } else {
        xEnd = state.t;
        const dataStart = Math.max(0, state.t - fullSpan);
        const start = Math.max(dataStart, xEnd - Math.max(0.001, windowSeconds));
        xStart = xEnd > start ? start : xEnd - Math.max(0.001, windowSeconds);
      }
      frozenChartX = { xStart: xStart, xEnd: xEnd };
    }

    const firstT = state.t - (maxLen - 1) * dt;
    const startIdx = Math.max(0, Math.min(maxLen - 1, Math.floor((xStart - firstT) / dt)));
    const endIdx = Math.max(0, Math.min(maxLen - 1, Math.ceil((xEnd - firstT) / dt)));
    const timeOf = (i) => firstT + i * dt;
    const xOf = (i) => padL + plotW * ((timeOf(i) - xStart) / (xEnd - xStart));

    // Y 轴范围只扫描当前可见区间：长历史（小时级）不会把波形压成直线，
    // 也不再每帧遍历整段历史数组
    const visibleCount = Math.max(1, endIdx - startIdx + 1);
    const scanStep = Math.max(1, Math.floor(visibleCount / 20000));

    // ---- lane 派生（P1.1）：同量纲（unit）叠加，异量纲分轨 ----
    // 不新增持久化 state：每帧从当前可见通道派生，顺序按通道出现顺序。
    const laneMap = new Map();
    visible.forEach((ch) => {
      const unit = String(ch.unit == null ? '' : ch.unit);
      let lane = laneMap.get(unit);
      if (!lane) { lane = { unit: unit, channels: [] }; laneMap.set(unit, lane); }
      lane.channels.push(ch);
    });
    const lanes = Array.from(laneMap.values());
    const laneCount = lanes.length;
    // 轨间距按 mockup 比例自适应：gap/轨高 ≈ 0.068；最小 6px、最大 18px，单轨 0。
    const laneGap = laneGapFor(laneCount, plotH);
    const laneH = laneCount ? (plotH - laneGap * (laneCount - 1)) / laneCount : plotH;
    lanes.forEach((lane, i) => {
      lane.top = padT + i * (laneH + laneGap);
      lane.h = laneH;
      lane.bot = lane.top + laneH;
      lane.gap = laneGap;
      lane.tickLabelBoxes = [];
    });

    const manualY = chartView.manual && Number.isFinite(chartView.yMin) && Number.isFinite(chartView.yMax) && chartView.yMax > chartView.yMin;
    const yScale = Number.isFinite(chartView.yScale) && chartView.yScale > 0 ? chartView.yScale : 1;
    const yPan = Number.isFinite(chartView.yPan) ? chartView.yPan : 0;
    const manualLaneY = laneCount > 1 && (Math.abs(yScale - 1) > 1e-6 || Math.abs(yPan) > 1e-6);
    const channelRanges = {};
    lanes.forEach((lane) => {
      let lmin = Infinity, lmax = -Infinity;
      lane.thresholds = [];
      lane.channels.forEach((ch) => {
        // 阈值先收进来：即使这个通道当前窗口没数据，阈值线也要能撑开域
        const thr = channelThresholdsOf(ch);
        if (thr.warnHigh != null || thr.warnLow != null) {
          lane.thresholds.push({ ch: ch, warnHigh: thr.warnHigh, warnLow: thr.warnLow });
          if (thr.warnHigh != null && thr.warnHigh > lmax) lmax = thr.warnHigh;
          if (thr.warnLow != null && thr.warnLow < lmin) lmin = thr.warnLow;
        }
        const last = ch.data.length - 1;
        const from = Math.max(0, Math.min(last, startIdx));
        const to = Math.max(0, Math.min(last, endIdx));
        if (to < from) return;
        let localMin = Infinity, localMax = -Infinity;
        for (let i = from; i <= to; i += scanStep) {
          const value = ch.data[i];
          if (value < localMin) localMin = value;
          if (value > localMax) localMax = value;
        }
        const tail = ch.data[to];
        if (tail < localMin) localMin = tail;
        if (tail > localMax) localMax = tail;
        if (!Number.isFinite(localMin) || !Number.isFinite(localMax)) return;
        channelRanges[ch.id] = [localMin, localMax];
        if (localMin < lmin) lmin = localMin;
        if (localMax > lmax) lmax = localMax;
      });
      lane.scanMin = lmin;
      lane.scanMax = lmax;
    });

    // 单轨沿用旧逻辑（normalize / 手动 Y / 整幅 min-max 都保持原样）；
    // 多轨每轨独立域：窗口内 min/max + 12% padding + 1/2/5 整齐刻度，一条 lane 一条轴。
    let normalized = false;
    let vmin = 0, vmax = 100, yStep = 0;
    let autoYMinOut = 0, autoYMaxOut = 100;
    const singleLane = laneCount === 1 ? lanes[0] : null;
    if (singleLane) {
      let smin = singleLane.scanMin, smax = singleLane.scanMax;
      if (!Number.isFinite(smin) || !Number.isFinite(smax)) { smin = 0; smax = 100; }
      const tinySpan = Math.max(1e-9, Math.abs(smax) * 1e-3, channelSpan * 2e-3);
      if ((smax - smin) <= tinySpan) {
        const center = (smin + smax) / 2;
        const span = Math.max(1, channelSpan * .1, Math.abs(center) * .02);
        smin = center - span;
        smax = center + span;
      }
      const padY = (smax - smin) * .12 || 1;
      const autoYMin = Math.floor(smin - padY);
      const autoYMax = Math.ceil(smax + padY);
      const spans = visible.map((ch) => {
        const range = channelRanges[ch.id];
        return range ? Math.abs(range[1] - range[0]) : 0;
      }).filter((span) => span > 1e-9);
      const spanRatio = spans.length > 1 ? Math.max.apply(null, spans) / Math.max(1e-12, Math.min.apply(null, spans)) : 1;
      normalized = state.chartScaleMode === 'normalize'
        || (state.chartScaleMode === 'auto' && visible.length > 1 && spanRatio > 8);
      vmin = manualY && !normalized ? chartView.yMin : autoYMin;
      vmax = manualY && !normalized ? chartView.yMax : autoYMax;
      singleLane.normalized = normalized;
      singleLane.yMin = normalized ? 0 : vmin;
      singleLane.yMax = normalized ? 1 : vmax;
      autoYMinOut = autoYMin;
      autoYMaxOut = autoYMax;
      singleLane.ticks = normalized ? [0, .25, .5, .75, 1] : niceTicks(vmin, vmax, 4);
      if (singleLane.ticks.length < 2) singleLane.ticks = [vmin, vmax];
      singleLane.yStep = normalized ? .25 : (singleLane.ticks.length > 1 ? Math.abs(singleLane.ticks[1] - singleLane.ticks[0]) : (vmax - vmin));
      yStep = singleLane.yStep;
      singleLane.yOf = normalized
        ? (value, ch) => (ch
          ? chartYOf({ scaleMode: 'normalize', padT: padT, plotH: plotH, channelRanges: channelRanges }, value, ch)
          : padT + plotH - value * plotH)
        : (value) => padT + plotH - ((value - vmin) / (vmax - vmin)) * plotH;
    } else if (laneCount > 1) {
      lanes.forEach((lane) => {
        let lmin = lane.scanMin, lmax = lane.scanMax;
        if (!Number.isFinite(lmin) || !Number.isFinite(lmax)) { lmin = 0; lmax = 100; }
        if (lmax - lmin <= Math.max(1e-9, Math.abs(lmax) * 1e-3)) {
          const center = (lmin + lmax) / 2;
          const span = Math.max(1, Math.abs(center) * .02);
          lmin = center - span;
          lmax = center + span;
        }
        const span = Math.max(1e-9, lmax - lmin);
        const padding = span * .12;
        const paddedMin = lmin - padding;
        const paddedMax = lmax + padding;
        // 刻度密度：约每 40–48px 一格，最多 5 个；域向步长外扩到整数刻度，绝不裁曲线
        // tick 数按轨高自适应：薄轨 maxTicks=clamp(2,3,floor(laneH/26))（41px→2、61px→2）；
        // 常轨沿用原 density（约每 44px 一格、最多 5），不改变 5 轨观感。
        let target = Math.round(lane.h / 44);
        target = Math.max(2, Math.min(5, target));
        if (lane.h < 70) target = Math.max(2, Math.min(3, Math.floor(lane.h / 26)));
        let step = tickStep(span, target);
        let domainMin = paddedMin;
        let domainMax = paddedMax;
        let ticks = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          domainMin = Math.floor(paddedMin / step + 1e-9) * step;
          domainMax = Math.ceil(paddedMax / step - 1e-9) * step;
          if (!(domainMax > domainMin)) { domainMin = paddedMin; domainMax = paddedMax; break; }
          ticks = [];
          for (let v = domainMin; v <= domainMax + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(12)));
          if (ticks.length <= 5 || target <= 2) break;
          target -= 1;
          step = tickStep(span, target);
        }
        if (lane.h < 70 && ticks.length > target && target >= 2) {
          const picked = [];
          const n = ticks.length;
          for (let k = 0; k < target; k += 1) {
            const idx = Math.round(k * (n - 1) / (target - 1));
            if (picked.indexOf(ticks[idx]) < 0) picked.push(ticks[idx]);
          }
          ticks = picked;
        }
        lane.ticks = ticks.length >= 2 ? ticks : [domainMin, domainMax];
        lane.yMin = domainMin;
        lane.yMax = domainMax;
        lane.yStep = lane.ticks.length > 1 ? Math.abs(lane.ticks[1] - lane.ticks[0]) : (lane.yMax - lane.yMin);
        lane.yOf = (value) => {
          const base = lane.bot - ((value - lane.yMin) / (lane.yMax - lane.yMin)) * lane.h;
          if (!manualLaneY) return base;
          const center = lane.top + lane.h / 2;
          return center + (base - center) / yScale + yPan * lane.h;
        };
      });
      vmin = Math.min.apply(null, lanes.map((lane) => lane.yMin));
      vmax = Math.max.apply(null, lanes.map((lane) => lane.yMax));
      autoYMinOut = vmin;
      autoYMaxOut = vmax;
    }
    if (!(vmax > vmin)) { vmin = 0; vmax = 100; }

    ctx.save();
    ctx.textBaseline = 'middle';
    // 每轨独立刻度：标签 10px 等宽数字、右对齐在 padL-8；不做双 Y 轴
    ctx.font = '10px Consolas,"Cascadia Mono",monospace';
    ctx.textAlign = 'right';
    const drawTickLabel = (lane, value, y) => {
      const label = normalized ? Math.round(value * 100) + '%' : axisText(value, lane.yStep);
      const labelW = ctx.measureText(label).width;
      ctx.fillStyle = TH.axisLabelBg;
      ctx.fillRect(padL - labelW - 14, y - 6, labelW + 8, 12);
      ctx.fillStyle = TH.axisText;
      ctx.fillText(label, padL - 8, y);
      if (lane.tickLabelBoxes) lane.tickLabelBoxes.push({ text: label, x: padL - labelW - 14, y: y - 6, w: labelW + 8, h: 12 });
    };
    lanes.forEach((lane) => {
      // 1) 网格线：所有 tick 都画
      lane.ticks.forEach((value) => {
        const y = lane.yOf(value);
        if (y < lane.top - 1 || y > lane.bot + 1) return;
        if (state.showGrid) {
          ctx.strokeStyle = TH.grid;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(W - padR, y);
          ctx.stroke();
        }
      });
      // 2) 标签：薄轨( h<70 )不再用域极值（会被 8px 边缘过滤吞掉），
      //    改为在轨内 28%/72% 高度处找最近 tick 并把 y clamp 到 [top+7,bot-7]，保证 1~2 个数字真画出来。
      if (lane.h < 70) {
        const maxLabels = lane.h >= 52 ? 2 : 1;
        const desired = maxLabels === 2
          ? [lane.top + lane.h * 0.28, lane.top + lane.h * 0.72]
          : [lane.top + lane.h * 0.5];
        const cand = lane.ticks.map((value) => ({ value: value, y: lane.yOf(value) }));
        const chosen = [];
        desired.forEach((dy) => {
          let best = null;
          cand.forEach((c) => {
            if (chosen.indexOf(c) >= 0) return;
            const d = Math.abs(c.y - dy);
            if (!best || d < best.d) best = { value: c.value, y: c.y, d: d };
          });
          if (best) chosen.push(best);
        });
        chosen.forEach((c) => {
          const y = Math.max(lane.top + 7, Math.min(lane.bot - 7, c.y));
          drawTickLabel(lane, c.value, y);
        });
      } else {
        const maxLabels = lane.h < 110 ? 4 : 5;
        const labelStride = Math.max(1, Math.ceil(lane.ticks.length / maxLabels));
        lane.ticks.forEach((value, tickIdx) => {
          const y = lane.yOf(value);
          if (y < lane.top - 1 || y > lane.bot + 1) return;
          if (y < lane.top + 8 || y > lane.bot - 8) return;
          if (tickIdx % labelStride !== 0 && tickIdx !== lane.ticks.length - 1) return;
          drawTickLabel(lane, value, y);
        });
      }
      lane.drawnTickLabels = lane.tickLabelBoxes ? lane.tickLabelBoxes.length : 0;
    });
    // X 时间网格：竖线贯穿全部 lane，刻度标签只在底部画一次
    ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
    const xTicks = niceTicks(xStart, xEnd, 6);
    const xStep = xTicks.length > 1 ? Math.abs(xTicks[1] - xTicks[0]) : (xEnd - xStart);
    ctx.textAlign = 'center';
    xTicks.forEach((value) => {
      const x = padL + plotW * ((value - xStart) / (xEnd - xStart));
      if (x < padL - 1 || x > padL + plotW + 1) return;
      if (state.showGrid) {
        ctx.strokeStyle = TH.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
      }
      const label = axisText(value, xStep) + 's';
      const labelW = ctx.measureText(label).width;
      ctx.fillStyle = TH.axisLabelBg;
      ctx.fillRect(x - labelW / 2 - 3, H - padB + 7, labelW + 6, 14);
      ctx.fillStyle = TH.axisText;
      ctx.fillText(label, x, H - padB + 14);
    });
    ctx.restore();

    // 事件竖线（P1.3·D，有余量才做）：窗口内告警事件 → X 轴顶部 6px 危险色短刻度
    const alarmList = Array.isArray(state.alarms) ? state.alarms : [];
    if (alarmList.length) {
      const danger = dangerColor(TH);
      const nowMs = Date.now();
      ctx.save();
      ctx.fillStyle = danger;
      ctx.globalAlpha = .85;
      alarmList.slice(0, 60).forEach((alarm) => {
        const at = state.t - (nowMs - Number(alarm.time || nowMs)) / 1000;
        if (!(at >= xStart && at <= xEnd)) return;
        const x = padL + plotW * ((at - xStart) / (xEnd - xStart));
        ctx.fillRect(Math.round(x), padT, 1, 6);
      });
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
    lanes.forEach((lane) => {
      lane.tags = [];
      lane.channels.forEach((ch) => {
        const from = Math.min(startIdx, ch.data.length - 1);
        const to = Math.min(endIdx, ch.data.length - 1);
        if (ch.data.length < 2 || from > to) return;
        // 可见点远多于像素列时按像素列做 min/max 包络抽取，长历史缩放也不会拖慢渲染
        const columns = Math.max(2, Math.floor(plotW));
        const spanPoints = to - from + 1;
        const dense = spanPoints > columns * 2;
        const step = dense ? Math.max(1, Math.floor(spanPoints / (columns * 4))) : 1;
        let colMin = null, colMax = null;
        if (dense) {
          colMin = new Float64Array(columns).fill(Infinity);
          colMax = new Float64Array(columns).fill(-Infinity);
          const scale = columns / Math.max(1e-9, xEnd - xStart);
          for (let i = from; i <= to; i += step) {
            const value = ch.data[i];
            let c = Math.floor(((firstT + i * dt) - xStart) * scale);
            if (c < 0) c = 0; else if (c >= columns) c = columns - 1;
            if (value < colMin[c]) colMin[c] = value;
            if (value > colMax[c]) colMax[c] = value;
          }
        }
        ctx.save();
        ctx.strokeStyle = X.viewColor(ch.color);
        ctx.lineWidth = focus ? 2.8 : (visible.length > 8 ? 1.8 : 2.15);
        ctx.globalAlpha = focus ? 1 : (visible.length > 8 ? .84 : .95);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const path = new Path2D();
        if (dense) {
          let started = false;
          for (let c = 0; c < columns; c++) {
            if (colMin[c] === Infinity) continue;
            const x = padL + c + .5;
            const yTop = lane.yOf(colMax[c], ch);
            const yBot = lane.yOf(colMin[c], ch);
            if (!started) { path.moveTo(x, yTop); started = true; } else path.lineTo(x, yTop);
            path.lineTo(x, yBot);
          }
        } else {
          for (let i = from; i <= to; i++) {
            if (i === from) path.moveTo(xOf(i), lane.yOf(ch.data[i], ch));
            else path.lineTo(xOf(i), lane.yOf(ch.data[i], ch));
          }
        }
        ctx.stroke(path);
        // 越限段按阈值剪裁重绘（不是盖蒙版）：clip 到阈值上方/下方，把该段重描成告警色
        if (lane.thresholds && lane.thresholds.length) {
          const danger = dangerColor(TH);
          const thr = lane.thresholds.filter((entry) => entry.ch === ch)[0];
          if (thr && thr.warnHigh != null) {
            const yLine = lane.yOf(thr.warnHigh, ch);
            if (yLine > lane.top + 1) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(padL, lane.top, plotW, yLine - lane.top);
              ctx.clip();
              ctx.strokeStyle = danger;
              ctx.lineWidth = 2.6;
              ctx.globalAlpha = 1;
              ctx.stroke(path);
              ctx.restore();
            }
          }
          if (thr && thr.warnLow != null) {
            const yLine = lane.yOf(thr.warnLow, ch);
            if (yLine < lane.bot - 1) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(padL, yLine, plotW, lane.bot - yLine);
              ctx.clip();
              ctx.strokeStyle = danger;
              ctx.lineWidth = 2.6;
              ctx.globalAlpha = 1;
              ctx.stroke(path);
              ctx.restore();
            }
          }
        }
        ctx.restore();
        if (state.showStake) {
          lane.tags.push({
            y: lane.yOf(ch.data[to], ch),
            color: X.viewColor(ch.color),
            name: ch.name || ch.id,
            text: X.formatChannelValue(ch, ch.data[to]),
            unit: ch.unit || ''
          });
        }
      });
    });
    // ---- P1.3 交互层：选区压暗 + 悬停准星/交点（画在曲线之上、标注之下）----
    if (chartSel) {
      const selA = Math.min(chartSel.a, chartSel.b);
      const selB = Math.max(chartSel.a, chartSel.b);
      const xa = xOf(selA);
      const xb = xOf(selB);
      const left = Math.max(padL, Math.min(xa, xb));
      const right = Math.min(padL + plotW, Math.max(xa, xb));
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();
      ctx.fillStyle = chartAlpha(TH.bg, .45);
      ctx.fillRect(padL, padT, Math.max(0, left - padL), plotH);
      ctx.fillRect(right, padT, Math.max(0, padL + plotW - right), plotH);
      ctx.fillStyle = chartAlpha(TH.acc, .16);
      ctx.fillRect(left, padT, Math.max(0, right - left), plotH);
      ctx.strokeStyle = chartAlpha(TH.acc, .8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(left) + .5, padT);
      ctx.lineTo(Math.round(left) + .5, padT + plotH);
      ctx.moveTo(Math.round(right) + .5, padT);
      ctx.lineTo(Math.round(right) + .5, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }
    if (chartHover) {
      const snapX = xOf(chartHover.idx);
      const hoverLane = lanes[chartHover.lane];
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();
      // 全轨竖准星
      ctx.strokeStyle = chartAlpha(TH.acc, .65);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(snapX) + .5, padT);
      ctx.lineTo(Math.round(snapX) + .5, padT + plotH);
      ctx.stroke();
      // 悬停 lane 内的横向虚线
      if (hoverLane) {
        const hy = Math.max(hoverLane.top + 1, Math.min(hoverLane.bot - 1, chartHover.y));
        ctx.strokeStyle = chartAlpha(TH.acc, .28);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(hy) + .5);
        ctx.lineTo(padL + plotW, Math.round(hy) + .5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 每个可见通道在本 lane 的交点：4px 实心圆，外描 TH.bg 2px 保证可辨
      const hoverIndex = chartHover.idx;
      lanes.forEach((lane) => {
        lane.channels.forEach((ch) => {
          const value = ch.data[Math.min(hoverIndex, ch.data.length - 1)];
          if (value == null || !Number.isFinite(Number(value))) return;
          const y = lane.yOf(Number(value), ch);
          if (y < lane.top - 2 || y > lane.bot + 2) return;
          ctx.beginPath();
          ctx.arc(snapX, y, 2, 0, Math.PI * 2);
          ctx.fillStyle = X.viewColor(ch.color);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = TH.bg;
          ctx.stroke();
        });
      });
      ctx.restore();
    }
    ctx.restore();

    // 以下三块要画在 plot 裁剪之外：右缘标签槽在 plotW 之外，被裁会整块消失
    // 阈值虚线 + 左端文字（曲线之上、末端标签之前）
    lanes.forEach((lane) => { drawThresholdMarkers(ctx, lane, padL, plotW, TH); });
    // 每轨「名称 + 单位」：阈值线与曲线之上补一块底色，保证不被压住（10px dim）
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lanes.forEach((lane) => {
      if (!lane.channels.length) return;
      const names = [];
      lane.channels.forEach((ch) => {
        const name = ch.name || ch.id;
        if (names.indexOf(name) < 0) names.push(name);
      });
      if (lane.h < 32) return;
      const text = names.join(' / ') + (lane.unit ? ' ' + lane.unit : '');
      ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
      const width = ctx.measureText(text).width + 6;
      ctx.fillStyle = TH.bg;
      ctx.fillRect(padL + 3, lane.top + 4, width, 13);
      lane.nameLabelBox = { text: text, x: padL + 3, y: lane.top + 4, w: width, h: 13 };
      ctx.fillStyle = TH.dimText;
      ctx.fillText(text, padL + 6, lane.top + 10);
    });
    // 右缘末端标签槽：按 lane 分别避让，19px 碰撞回退，clamp 在本 lane (top+8, bot-8)
    lanes.forEach((lane) => {
      if (lane.tags && lane.tags.length) drawLaneLabels(ctx, lane, lane.tags.slice(0, 6), plotW, padL, W);
    });

    ctx.strokeStyle = TH.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);
    if (!visible.length) {
      // 空网格配一句空白等于看起来像坏了：这里补一句说明，和柱状图空态同一套写法
      ctx.fillStyle = TH.dimText;
      ctx.font = '12px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(marked.length ? '暂无数据 · 开启仿真或连接串口' : '无可见通道', padL + plotW / 2, padT + plotH / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    chartMetrics = {
      W: W, H: H, padL: padL, padR: padR, padT: padT, padB: padB,
      plotW: plotW, plotH: plotH, xStart: xStart, xEnd: xEnd,
      yMin: vmin, yMax: vmax, autoYMin: autoYMinOut, autoYMax: autoYMaxOut, dt: dt, fullSpan: fullSpan,
      maxLen: maxLen, firstT: firstT, scaleMode: normalized ? 'normalize' : (laneCount > 1 ? 'lanes' : 'overlay'),
      channelRanges: channelRanges,
      laneCount: laneCount,
      lanes: lanes.map((lane) => ({
        unit: lane.unit,
        top: lane.top,
        h: lane.h,
        bot: lane.bot,
        yMin: lane.yMin,
        yMax: lane.yMax,
        ticks: lane.ticks,
        channels: lane.channels.map((ch) => ch.id),
        thresholds: (lane.thresholds || []).map((entry) => ({ id: entry.ch.id, warnHigh: entry.warnHigh, warnLow: entry.warnLow })),
        gap: lane.gap || 0,
        labels: lane.labelPositions || [],
        endLabelBoxes: lane.endLabelBoxes || [],
        nameLabelBox: lane.nameLabelBox || null,
        tickLabelBoxes: lane.tickLabelBoxes || [],
        drawnTickLabels: lane.drawnTickLabels || 0,
        markers: lane.markerPositions || []
      })),
      yScale: yScale,
      yPan: yPan,
      hover: chartHover ? { idx: chartHover.idx, lane: chartHover.lane, rel: chartHover.rel } : null,
      selection: chartSelRange()
    };
    // 调试/后续 P1.2 共用：最近一帧的 lane 几何与域（只读快照，不参与渲染）
    V.chartMetrics = chartMetrics;
    // 空态：没有可见通道 / 有通道但没收到数据，是两种完全不同的处境，文案与出路也不同
    const emptyBox = document.getElementById('chartEmpty');
    if (emptyBox) {
      const hasData = visible.some((ch) => ch.data && ch.data.length);
      const noData = !visible.length || !hasData;
      emptyBox.classList.toggle('hidden', !noData);
      if (noData) {
        const titleEl = document.getElementById('chartEmptyTitle');
        const textEl = document.getElementById('chartEmptyText');
        const signature = (visible.length ? 'ch:' + visible.length : 'none');
        if (emptyBox.dataset.signature !== signature) {
          emptyBox.dataset.signature = signature;
          if (!visible.length) {
            if (titleEl) titleEl.textContent = '没有可见通道';
            if (textEl) textEl.textContent = '在右侧「数据」里勾选通道，或者用 AI 面板直接说一句要看的曲线。';
          } else {
            if (titleEl) titleEl.textContent = '通道已就绪，还没有数据';
            if (textEl) textEl.textContent = '已选 ' + visible.length + ' 个通道但还没收到帧：打开仿真数据，或到串口页连接设备。';
          }
        }
      }
    }

    const hoverSuffix = chartHover ? ' · 光标 ' + fmtRelSec(chartHover.rel) : '';
    ref.statusInfo.textContent = (visible.length
      ? visible.length + ' 通道 · ' + (laneCount > 1 ? laneCount + ' 轨 · ' : '') + '窗口 ' + (xEnd - xStart).toFixed(1) + 's · '
        + (normalized ? 'Y 每通道归一化' : laneCount > 1 ? 'Y 每轨独立' : 'Y ' + axisText(vmin, yStep) + '~' + axisText(vmax, yStep))
        + (focus ? ' · 聚焦 ' + focus.name : '') + (chartView.manual ? ' · 手动缩放' : '') + (chartView.frozen ? ' · 视图已暂停' : '')
      : (marked.length ? marked.length + ' 通道 · 等待数据 · 时间轴已暂停' : '无可见通道 · 时间轴已暂停')) + hoverSuffix;
    // 右栏「窗口统计」的窗口必须和图表同帧同窗口（同一对 xStart/xEnd）
    const dockWinEl = document.getElementById('dockStatWin');
    if (dockWinEl) dockWinEl.textContent = (xEnd - xStart).toFixed(1) + ' s';
  }

  function renderBar() {
    const info = V.ensureCanvas(ref.barChart);
    if (!info) return;
    const ctx = info.ctx, W = info.w, H = info.h;
    const TH = X.canvasColors();
    const visible = X.plotChannels();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, W, H);
    if (!visible.length) {
      ctx.fillStyle = TH.dimText;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无可见通道', W / 2, H / 2);
      return;
    }
    const padL = 112, padR = 32, top = 16, bottom = 24;
    const rowH = (H - top - bottom) / visible.length;
    const barH = Math.min(26, rowH * .56);
    ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
    visible.forEach((ch, i) => {
      const y = top + i * rowH + (rowH - barH) / 2;
      const value = ch.data.length ? ch.data[ch.data.length - 1] : 0;
      const ratio = X.clamp((value - ch.range[0]) / (ch.range[1] - ch.range[0]), 0, 1);
      const barW = (W - padL - padR) * ratio;
      ctx.fillStyle = TH.dimText;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(ch.name.slice(0, 10), padL - 10, y + barH / 2);
      ctx.fillStyle = TH.track;
      ctx.fillRect(padL, y, W - padL - padR, barH);
      ctx.fillStyle = X.viewColor(ch.color);
      ctx.fillRect(padL, y, barW, barH);
      ctx.fillStyle = TH.strongText;
      ctx.textAlign = 'left';
      ctx.fillText(X.formatChannelValue(ch, value) + (ch.unit ? ' ' + ch.unit : ''), padL + barW + 8, y + barH / 2);
      ctx.strokeStyle = TH.trackLine;
      ctx.strokeRect(padL, y, W - padL - padR, barH);
    });
    // 空态：没有可见通道 / 有通道但没收到数据，是两种完全不同的处境，文案与出路也不同
    const emptyBox = document.getElementById('chartEmpty');
    if (emptyBox) {
      const hasData = visible.some((ch) => ch.data && ch.data.length);
      const noData = !visible.length || !hasData;
      emptyBox.classList.toggle('hidden', !noData);
      if (noData) {
        const titleEl = document.getElementById('chartEmptyTitle');
        const textEl = document.getElementById('chartEmptyText');
        const signature = (visible.length ? 'ch:' + visible.length : 'none');
        if (emptyBox.dataset.signature !== signature) {
          emptyBox.dataset.signature = signature;
          if (!visible.length) {
            if (titleEl) titleEl.textContent = '没有可见通道';
            if (textEl) textEl.textContent = '在右侧「数据」里勾选通道，或者用 AI 面板直接说一句要看的曲线。';
          } else {
            if (titleEl) titleEl.textContent = '通道已就绪，还没有数据';
            if (textEl) textEl.textContent = '已选 ' + visible.length + ' 个通道但还没收到帧：打开仿真数据，或到串口页连接设备。';
          }
        }
      }
    }

    ref.statusInfo.textContent = visible.length + ' 通道';
  }

  function renderTable() {
    const channels = X.plotChannels();
    const dataLen = Math.max.apply(null, channels.map((ch) => ch.data.length).concat([0]));
    if (!channels.length || !dataLen) {
      ref.tableHead.innerHTML = '<tr><th>序号</th><th>时间</th></tr>';
      ref.tableBody.innerHTML = '<tr><td colspan="2" class="table-empty">暂无数据</td></tr>';
      ref.tableStats.textContent = '等待数据采集';
      ref.statusInfo.textContent = '无数据';
      return;
    }
    const rows = Math.min(60, dataLen);
    const start = dataLen - rows;
    const heads = ['序号', '时间'].concat(channels.map((ch) => ch.name + '(' + ch.unit + ')'));
    ref.tableHead.innerHTML = '<tr>' + heads.map((h) => '<th>' + X.esc(h) + '</th>').join('') + '</tr>';
    let html = '';
    for (let r = start; r < dataLen; r++) {
      const ms = Date.now() - (dataLen - 1 - r) * state.intervalMs;
      const time = new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
      html += '<tr><td>' + (r + 1) + '</td><td>' + X.esc(time) + '</td>';
      channels.forEach((ch) => {
        const v = ch.data[r] == null ? '--' : X.esc(X.formatChannelValue(ch, ch.data[r], 2));
        html += '<td>' + v + '</td>';
      });
      html += '</tr>';
    }
    ref.tableBody.innerHTML = html;
    const latest = channels.map((ch) => {
      const vals = ch.data.slice(-30);
      if (!vals.length) return ch.name + ':--';
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return ch.name + ' 均 ' + avg.toFixed(1) + ' / 峰 ' + Math.max.apply(null, vals).toFixed(1);
    }).join(' · ');
    // 行数已经在页脚状态里了，这里只留各通道的均值/峰值，避免同一屏出现两次「N 行」
    ref.tableStats.textContent = latest;
    ref.statusInfo.textContent = rows + ' 行';
  }

  function renderGaugeCards() {
    ref.gaugeGrid.innerHTML = '';
    X.plotChannels().forEach((ch) => {
      const card = document.createElement('div');
      card.className = 'gauge-card';
      card.dataset.gaugeId = ch.id;
      card.innerHTML = [
        '<div class="gauge-ring" data-ring><div class="gv" data-gv>0.0</div><div class="gu">' + X.esc(ch.unit) + '</div></div>',
        '<div class="gauge-name">' + X.esc(ch.name) + '</div>',
        '<div class="gauge-range">' + ch.range[0] + ' — ' + ch.range[1] + '</div>',
        '<div class="gauge-status ok" data-status>正常</div>'
      ].join('');
      ref.gaugeGrid.appendChild(card);
    });
    updateGaugeValues();
  }

  function updateGaugeValues() {
    const TH = X.canvasColors();
    X.plotChannels().forEach((ch) => {
      const card = ref.gaugeGrid.querySelector('[data-gauge-id="' + ch.id + '"]');
      if (!card) return;
      const value = ch.data.length ? ch.data[ch.data.length - 1] : ch.base;
      const ratio = X.clamp((value - ch.range[0]) / (ch.range[1] - ch.range[0]), 0, 1);
      const deg = ratio * 360;
      const ring = card.querySelector('[data-ring]');
      const gv = card.querySelector('[data-gv]');
      const status = card.querySelector('[data-status]');
      ring.style.background = 'conic-gradient(' + X.viewColor(ch.color) + ' 0deg ' + deg + 'deg, ' + TH.trackRing + ' ' + deg + 'deg 360deg)';
      gv.textContent = Number(value).toFixed(1);
      const alert = X.getAlarm(ch);
      if (alert.level === 'high') { status.textContent = '严重'; status.className = 'gauge-status danger'; }
      else if (alert.level === 'warn') { status.textContent = '预警'; status.className = 'gauge-status warn'; }
      else { status.textContent = '正常'; status.className = 'gauge-status ok'; }
    });
  }

  function renderGauges() {
    if (ref.gaugeGrid.children.length !== X.plotChannels().length) renderGaugeCards();
    updateGaugeValues();
    ref.statusInfo.textContent = X.plotChannels().length + ' 个仪表通道';
  }

  V.renderChart = renderChart;
  V.resetChartView = resetChartView;
  V.recenterChartView = recenterChartView;
  V.getChartSelection = function () { return chartSelRange(); };
  V.clearChartSelection = function () { clearChartSelection(); };
  V.zoomChartSelection = zoomToChartSelection;
  V.hideChartTooltip = hideChartTooltip;
  V.getChartView = function () {
    const view = Object.assign({}, chartView);
    if (chartMetrics) {
      view.xStart = chartMetrics.xStart;
      view.xEnd = chartMetrics.xEnd;
    }
    return view;
  };
  V.getChartMetrics = function () { return chartMetrics ? Object.assign({}, chartMetrics) : null; };
  V.freezeChart = freezeChart;
  V.isChartFrozen = function () { return !!(chartView && chartView.frozen); };
  // 时间轴边界是回归用例直接钉的对象（拖到负时间就再也回不来了），单独暴露出来
  V.clampChartX = clampChartX;
  V.axisText = axisText;
  V.chartLaneKit = {
    laneDomain: laneDomain,
    laneYOf: laneYOf,
    laneGapFor: laneGapFor,
    niceTicks: niceTicks,
    tickStep: tickStep,
    axisText: axisText,
    thresholdsOf: channelThresholdsOf,
    dangerColor: dangerColor
  };
  V.renderBar = renderBar;
  V.renderTable = renderTable;
  V.renderGaugeCards = renderGaugeCards;
  V.updateGaugeValues = updateGaugeValues;
  V.renderGauges = renderGauges;
})();
