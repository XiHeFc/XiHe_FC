(function () {
  'use strict';
  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;
  const state = X.state;
  const ref = V.ref;

  document.addEventListener('click', (e) => {
    const ack = e.target.closest('[data-ack]');
    if (ack) {
      X.ackAlarm(ack.dataset.ack);
      V.renderAlarmPanel();
      V.callApp('updateAlarmBadge');
      return;
    }
    if (e.target.closest('#btnClearThresholds')) clearAllThresholds();
  });

  // 量程漂移过的那批旧阈值对不上任何公式，迁移清不掉（旧公式是按创建时的量程算的，
  // 量程后来被输入数据撑大/收窄过就再也对不上了）。留一个一键回到「都没设」的出口，
  // 免得用户对着 21 个通道一个个手删。
  function clearAllThresholds() {
    const withT = X.allChannels().filter((ch) => ch.warnHigh != null || ch.warnLow != null);
    if (!withT.length) return;
    if (!window.confirm('把 ' + withT.length + ' 个通道的预警阈值全部清空？清空后这些通道不再告警。')) return;
    withT.forEach((ch) => { ch.warnHigh = null; ch.warnLow = null; });
    X.persist();
    renderThresholdRows();
    renderAlarmChart();
    renderAlarmPanel();
  }

  document.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-channel][data-key]');
    if (!input) return;
    const ch = X.findChannel(input.dataset.channel);
    if (!ch) return;
    // 清空 = 关掉这一侧的报警（不是回退成某个默认值）
    const raw = String(input.value == null ? '' : input.value).trim();
    const value = raw === '' ? null : Number(raw);
    if (value != null && !Number.isFinite(value)) return;
    if (input.dataset.key === 'warnHigh') ch.warnHigh = value;
    if (input.dataset.key === 'warnLow') ch.warnLow = value;
    X.persist();
    // 只重画阈值曲线，不重建行 DOM —— 行里是 number 输入框，重建会把光标顶掉
    if (V.renderAlarmChart) V.renderAlarmChart();
  });

  // 阈值可能是历史遗留的浮点尾数（2.9999999999999996），直接塞进输入框会撑成
  // 一长串数字被裁掉。按量程决定保留几位，只抹掉噪声，不改动真实存储值。
  // 没设阈值（null）时返回空串，输入框显示占位符。
  function thresholdText(value, span) {
    if (value == null || !Number.isFinite(Number(value))) return '';
    const digits = span >= 200 ? 1 : span >= 20 ? 2 : span >= 2 ? 3 : 4;
    return String(Number(Number(value).toFixed(digits)));
  }

  function renderThresholdRows() {
    ref.thresholdList.innerHTML = '';
    X.allChannels().forEach((ch) => {
      const span = ch.range[1] - ch.range[0];
      const row = document.createElement('div');
      row.className = 'threshold-row';
      row.dataset.channelId = ch.id;
      // 没设阈值就是空框，占位符说清「留空 = 不报警」。
      // 绝不在这里补一个默认值 —— 从量程猜出来的线正是「一开机满屏告警」的来源。
      // 通道名 / 实时值 / 两条阈值同一行：实时值原来单摆在上方那排 chip 里，同一批通道名等于说了两遍
      row.innerHTML = '<span class="nm" title="点击查看「' + X.esc(ch.name) + '」的阈值曲线">' +
          '<i style="background:' + X.esc(X.viewColor(ch.color)) + '"></i>' + X.esc(ch.name) + '</span>' +
        '<span class="rt">—</span>' +
        '<input type="number" data-channel="' + ch.id + '" data-key="warnHigh" value="' + thresholdText(ch.warnHigh, span) + '" placeholder="未设" title="预警高值；留空 = 这一侧不报警" />' +
        '<input type="number" data-channel="' + ch.id + '" data-key="warnLow" value="' + thresholdText(ch.warnLow, span) + '" placeholder="未设" title="预警低值；留空 = 这一侧不报警" />';
      ref.thresholdList.appendChild(row);
    });
    alarmValueSig = '';
    syncThresholdFocus();
    syncAlarmValues();
    // 「全部清空」没东西可清时直接禁用，不做按下去没反应的假按钮
    const clearBtn = document.getElementById('btnClearThresholds');
    if (clearBtn) {
      const any = X.allChannels().some((ch) => ch.warnHigh != null || ch.warnLow != null);
      clearBtn.disabled = !any;
      clearBtn.title = any ? '把所有通道的预警高/低清空，回到「都没设」' : '当前没有通道设了阈值';
    }
  }

  function renderAlarmPanel() {
    const items = state.alarms;
    const active = items.filter((a) => !a.ack);
    const warn = active.filter((a) => a.level === 'warn').length;
    const high = active.filter((a) => a.level === 'high').length;
    // 数字条常显：4 格是页面骨架（待处理/预警/严重/累计），空态交给记录列表说明。
    X.setCounter(ref.alarmActive, active.length);
    X.setCounter(ref.alarmWarn, warn);
    X.setCounter(ref.alarmHigh, high);
    X.setCounter(ref.alarmTotal, items.length);
    // 没有待确认 / 没有记录时这两个按钮点了什么都不会发生：禁用比让它装作可用更诚实
    if (ref.alarmAckAll) ref.alarmAckAll.disabled = active.length === 0;
    if (ref.alarmClear) ref.alarmClear.disabled = items.length === 0;
    syncAlarmValues();
    renderAlarmChart();
    if (!items.length) {
      // 空状态只占一行：一句结论 + 一句对位说明，不留半屏空白。
      // 「所有通道都在阈值内」在一条阈值都没设的时候是句假话 —— 那时根本没在监视
      const watched = X.allChannels().filter((ch) => {
        const t = X.alarmThresholds(ch);
        return t.warnHigh != null || t.warnLow != null;
      }).length;
      ref.alarmList.innerHTML = '<div class="alarm-empty">' +
        '<span class="ae-ico">' + (watched ? '✓' : '—') + '</span>' +
        '<b>' + (watched ? '暂无告警' : '未设置阈值') + '</b>' +
        (watched ? '<small>' + watched + ' 条通道在监视中</small>' : '') +
        '</div>';
      return;
    }
    ref.alarmList.innerHTML = items.map((a) => {
      const time = new Date(a.time).toLocaleTimeString('zh-CN', { hour12: false });
      return '<div class="alarm-item ' + X.esc(a.level) + (a.ack ? ' ack' : '') + '"' +
        ' data-alarm-focus="' + X.esc(a.channelId || '') + '" title="点击查看该通道阈值曲线">' +
        '<span class="sev ' + X.esc(a.level) + '">' + (a.level === 'high' ? '严重' : '预警') + '</span>' +
        '<span class="txt"><b>' + X.esc(a.name) + '</b><span>' + X.esc(a.label) + ' · ' + X.esc(time) + (a.ack ? ' · 已确认' : '') + '</span></span>' +
        '<span class="val">' + Number(a.value).toFixed(1) + ' ' + X.esc(a.unit) + '</span>' +
        (a.ack ? '' : '<button class="btn" data-ack="' + X.esc(a.id) + '">确认</button>') +
        '</div>';
    }).join('');
  }

  // ===== 告警阈值可视化：曲线 + 预警/严重阈值线，点击通道或曲线切换聚焦 =====
  let alarmFocusId = '';
  let alarmValueSig = '';
  let alarmGeo = null;

  function alarmThresholdColors() {
    return X.themeName && X.themeName() === 'light'
      ? { warn: '#a26708', high: '#cc4747' }
      : { warn: '#fbbf24', high: '#f87171' };
  }

  function alarmChannels() {
    return X.allChannels().filter((ch) => ch.visible !== false);
  }

  function alarmFocusChannel() {
    const list = alarmChannels();
    if (!list.length) return null;
    let ch = alarmFocusId ? list.find((c) => c.id === alarmFocusId) : null;
    if (!ch) ch = list.find((c) => c.alertState && c.alertState !== 'ok') || list[0];
    alarmFocusId = ch.id;
    return ch;
  }

  function focusAlarmChannel(id) {
    if (!id) return;
    if (!alarmChannels().some((c) => c.id === id)) return;
    if (alarmFocusId === id) return;
    alarmFocusId = id;
    state.selectedChannel = id;
    alarmValueSig = '';
    syncAlarmValues();
    renderAlarmChart();
    syncThresholdFocus();
  }

  // 阈值表里的通道名和上方 chip 是同一批通道，点名字就跳到那条曲线：
  // 让重复出现的名字变成导航，而不是同一条信息说两遍
  function syncThresholdFocus() {
    if (!ref.thresholdList) return;
    ref.thresholdList.querySelectorAll('.threshold-row[data-channel-id]').forEach((row) => {
      row.classList.toggle('active', row.dataset.channelId === alarmFocusId);
    });
  }

  // 实时值 + 告警等级直接写进阈值表的行里（原来单摆一排 chip，等于同一批通道名说两遍）。
  // 只改 .rt 文本和行的 warn/high 类，不重建行 DOM —— 行里有两个 number 输入框，
  // 每帧重建会把用户正在输入的光标顶掉。
  function syncAlarmValues() {
    if (!ref.thresholdList) return;
    const list = X.allChannels();
    const focus = alarmFocusChannel();
    const sig = list.map((ch) => {
      const last = ch.data.length ? ch.data[ch.data.length - 1] : null;
      return ch.id + ':' + X.getAlarm(ch).level + ':' + (last == null ? '' : last.toFixed(2));
    }).join('|') + '#' + (focus ? focus.id : '');
    if (sig === alarmValueSig) return;
    alarmValueSig = sig;
    ref.thresholdList.querySelectorAll('.threshold-row[data-channel-id]').forEach((row) => {
      const ch = X.findChannel(row.dataset.channelId);
      if (!ch) return;
      const level = X.getAlarm(ch).level;
      row.classList.toggle('warn', level === 'warn');
      row.classList.toggle('high', level === 'high');
      const last = ch.data.length ? ch.data[ch.data.length - 1] : null;
      const cell = row.querySelector('.rt');
      if (cell) cell.textContent = last == null ? '—' : X.formatChannelValue(ch, last) + (ch.unit ? ' ' + ch.unit : '');
    });
  }

  function renderAlarmChart() {
    const canvas = ref.alarmChart;
    if (!canvas) return;
    const info = V.ensureCanvas(canvas);
    if (!info) return;
    const ctx = info.ctx, W = info.w, H = info.h;
    const TH = X.canvasColors();
    const COL = alarmThresholdColors();
    const padL = 46, padR = 78, padT = 12, padB = 20;
    const plotW = Math.max(10, W - padL - padR);
    const plotH = Math.max(10, H - padT - padB);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'middle';

    const focus = alarmFocusChannel();
    if (!focus || focus.data.length < 2) {
      ctx.fillStyle = TH.dimText;
      ctx.font = '12px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待通道数据…', W / 2, H / 2);
      alarmGeo = null;
      return;
    }

    const dt = Math.max(1e-6, Number(state.intervalMs) / 1000);
    const wantSec = Math.max(5, Number(state.windowSec) || 20);
    const points = Math.max(30, Math.min(1200, Math.round(wantSec / dt)));
    const t = X.alarmThresholds(focus);
    const slice = focus.data.slice(-points);
    const n = slice.length;
    const xSpanSec = Math.max(dt, (n - 1) * dt);
    const xAxisLabel = '最近 ' + xSpanSec.toFixed(1) + 's · ' + focus.name;

    // 单通道聚焦：告警图只画聚焦通道；域/刻度复用 P1 lane kit（阈值已设才入域）
    const kit = V.chartLaneKit;
    const dom = kit && kit.laneDomain
      ? kit.laneDomain([{ data: slice }], { thresholds: [t.dangerHigh, t.dangerLow, t.warnHigh, t.warnLow], targetTicks: 4 })
      : null;
    if (!dom) return;
    const vmin = dom.yMin, vmax = dom.yMax;
    const xOf = (k) => padL + plotW * (k / Math.max(1, n - 1));
    const yOf = (v) => padT + plotH - (v - vmin) / (vmax - vmin) * plotH;
    const axisText = (v) => (V.axisText ? V.axisText(v, dom.step) : String(Number(v).toFixed(2)));
    const levelOf = (v) => {
      if ((t.warnHigh != null && v >= t.warnHigh) || (t.warnLow != null && v <= t.warnLow)) return 'warn';
      return 'ok';
    };
    const rankOf = (lv) => (lv === 'high' ? 2 : lv === 'warn' ? 1 : 0);

    // 聚焦通道连续折线：按越限等级分段着色（每段连续 path，不按点画竖线）
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    let start = 0;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    while (start < n - 1) {
      const rank = rankOf(levelOf(slice[start]));
      let end = start;
      while (end < n - 1 && rankOf(levelOf(slice[end + 1])) === rank) end++;
      ctx.strokeStyle = rank === 2 ? COL.high : rank === 1 ? COL.warn : focus.color;
      ctx.lineWidth = rank ? 2.6 : 2;
      ctx.beginPath();
      for (let k = start; k <= end + 1 && k < n; k++) {
        const x = xOf(k), y = yOf(slice[k]);
        if (k === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      start = end + 1;
    }
    const lastRank = rankOf(levelOf(slice[n - 1]));
    ctx.fillStyle = lastRank === 2 ? COL.high : lastRank === 1 ? COL.warn : focus.color;
    ctx.beginPath();
    ctx.arc(xOf(n - 1), yOf(slice[n - 1]), 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 网格与 Y 轴刻度（与 kit 同一套 1/2/5 刻度；记录像素位置供交叉验证）
    const tickLabels = [];
    dom.ticks.forEach((value) => {
      const y = yOf(value);
      ctx.strokeStyle = TH.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = TH.axisText;
      ctx.textAlign = 'right';
      const text = axisText(value);
      ctx.fillText(text, padL - 8, y);
      tickLabels.push({ value: value, pixelY: Math.round((y + Number.EPSILON) * 100) / 100, text: text });
    });

    // 阈值线：与告警引擎共用 alarmThresholds；标签密集时上下避让而不丢弃
    const lines = [
      { v: t.warnHigh, text: '预警高', color: COL.warn },
      { v: t.warnLow, text: '预警低', color: COL.warn }
    ].filter((line) => Number.isFinite(line.v))
      .map((line) => ({ line: line, y: yOf(line.v) }))
      .filter((it) => it.y >= padT - 1 && it.y <= padT + plotH + 1)
      .sort((a, b) => a.y - b.y);
    const labelGap = 15;
    const labelTop = padT + 6;
    const labelBottom = padT + plotH - 6;
    for (let i = 0; i < lines.length; i++) {
      const min = i === 0 ? labelTop : lines[i - 1].ly + labelGap;
      lines[i].ly = Math.max(lines[i].y, min);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const max = i === lines.length - 1 ? labelBottom : lines[i + 1].ly - labelGap;
      lines[i].ly = Math.min(lines[i].ly, max);
    }
    for (let i = 0; i < lines.length; i++) {
      const min = i === 0 ? labelTop : lines[i - 1].ly + labelGap;
      lines[i].ly = Math.max(lines[i].ly, min);
    }
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    lines.forEach((it) => {
      ctx.strokeStyle = X.viewColor(it.line.color);
      ctx.beginPath();
      ctx.moveTo(padL, it.y);
      ctx.lineTo(padL + plotW, it.y);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    lines.forEach((it) => {
      const label = it.line.text + ' ' + axisText(it.line.v);
      ctx.fillStyle = TH.axisLabelBg;
      ctx.fillRect(padL + plotW + 3, it.ly - 6, padR - 10, 12);
      if (Math.abs(it.ly - it.y) > .6) {
        ctx.strokeStyle = TH.frame;
        ctx.beginPath();
        ctx.moveTo(padL + plotW, it.y);
        ctx.lineTo(padL + plotW + 3, it.ly);
        ctx.stroke();
      }
      ctx.fillStyle = X.viewColor(it.line.color);
      ctx.fillText(label, padL + plotW + 7, it.ly);
    });
    ctx.restore();

    ctx.strokeStyle = TH.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);

    ctx.fillStyle = TH.axisText;
    ctx.textAlign = 'left';
    ctx.fillText(xAxisLabel, padL, H - padB / 2 - 1);
    ctx.textAlign = 'right';
    ctx.fillText('现在', padL + plotW, H - padB / 2 - 1);

    // 采峰数（供验收数波峰）：相邻局部极大，去抖 0.5s
    let peakCount = 0;
    const minPeakGap = Math.max(1, Math.round(1 / dt));
    let lastPeak = -minPeakGap;
    const peakFloor = vmin + (vmax - vmin) * 0.55;
    for (let k = 1; k < n - 1; k++) {
      if (slice[k] <= peakFloor) continue;
      if (!(slice[k] > slice[k - 1] && slice[k] >= slice[k + 1])) continue;
      if (k - lastPeak < minPeakGap) { if (slice[k] > slice[lastPeak]) lastPeak = k; continue; }
      peakCount++;
      lastPeak = k;
    }
    const thresholdPixels = lines.map((it) => ({ kind: it.line.text, value: it.line.v, pixelY: Math.round((it.y + Number.EPSILON) * 100) / 100 }));
    alarmGeo = {
      padL: padL, padT: padT, plotW: plotW, plotH: plotH,
      vmin: vmin, vmax: vmax, points: n, n: n, spanSec: xSpanSec,
      xSpanSec: xSpanSec, xAxisLabel: xAxisLabel,
      yMin: vmin, yMax: vmax, yStep: dom.step, ticks: dom.ticks.slice(),
      tickLabels: tickLabels, thresholds: t, thresholdPixels: thresholdPixels,
      contextChannelsDrawn: 0, peakCount: peakCount
    };
  }  // 点击曲线附近即聚焦该通道
  function alarmPickChannel(clientX, clientY) {
    const canvas = ref.alarmChart;
    const geo = alarmGeo;
    if (!canvas || !geo) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < geo.padL - 6 || x > geo.padL + geo.plotW + 6) return null;
    const offset = Math.round((1 - (x - geo.padL) / geo.plotW) * (geo.points - 1));
    let best = null;
    alarmChannels().forEach((ch) => {
      const total = ch.data.length;
      if (total < 2) return;
      const idx = total - 1 - Math.max(0, Math.min(total - 1, offset));
      const value = ch.data[idx];
      if (!Number.isFinite(value)) return;
      const py = geo.padT + geo.plotH - (value - geo.vmin) / (geo.vmax - geo.vmin) * geo.plotH;
      const d = Math.abs(py - y);
      if (!best || d < best.d) best = { id: ch.id, d: d };
    });
    return best ? best.id : null;
  }

  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    if (target.closest('[data-ack]')) return;
    const chip = target.closest('[data-alarm-focus]');
    if (chip && chip.dataset.alarmFocus) {
      focusAlarmChannel(chip.dataset.alarmFocus);
      return;
    }
    const row = target.closest('.threshold-row[data-channel-id]');
    if (row && !target.closest('input')) {
      focusAlarmChannel(row.dataset.channelId);
      return;
    }
    if (target.closest('#alarmChart')) {
      const id = alarmPickChannel(e.clientX, e.clientY);
      if (id) focusAlarmChannel(id);
    }
  });

  function renderSimControls() {    const selected = state.channels.find((c) => c.id === state.selectedChannel) || state.channels[0];
    if (!selected) return;
    if (ref.simChannelSelect.options.length !== state.channels.length) {
      ref.simChannelSelect.innerHTML = state.channels.map((c) => {
        return '<option value="' + c.id + '">' + X.esc(c.name) + '</option>';
      }).join('');
    }
    ref.simChannelSelect.value = selected.id;
    ref.simWaveSelect.value = selected.waveform || 'sine';
    // 采集参数下拉必须反映当前状态，否则“应用采集参数”会静默改掉内存历史/采样率
    const intervalSel = document.querySelector('#simInterval');
    if (intervalSel) intervalSel.value = String(state.intervalMs);
    const historySel = document.querySelector('#simHistoryHours');
    if (historySel) historySel.value = String(state.historyHours);
    const windowSel = document.querySelector('#simWindowSec');
    if (windowSel) windowSel.value = String(state.windowSec);
    ref.simBase.value = selected.base;
    ref.simAmp.value = selected.amp;
    ref.simFreq.value = selected.freq;
    ref.simNoise.value = selected.noise;
    renderSimChannelList();
  }

  // 上面那张「信号源」表单一次只反映一个通道，改别的通道得来回切下拉。
  // 这张只读总览把五个通道的仿真参数排在一屏里，点一行就载入表单 —— 表格是概览，表单是唯一编辑入口，
  // 两处都不重复存值，改完仍然只走 applySignal()
  function renderSimChannelList() {
    const host = document.querySelector('#simChannelList');
    if (!host) return;
    const labels = X.WAVE_LABELS || {};
    const num = (value) => String(Number((Number(value) || 0).toFixed(2)));
    host.innerHTML = state.channels.map((ch) => {
      const active = ch.id === state.selectedChannel;
      return '<button type="button" class="sim-chan-row' + (active ? ' active' : '') + '" data-sim-channel="' + X.esc(ch.id) + '"' +
        ' title="把「' + X.esc(ch.name) + '」载入上面的信号源表单">' +
        '<span class="nm"><i style="background:' + X.esc(X.viewColor(ch.color)) + '"></i>' + X.esc(ch.name) + '</span>' +
        '<span>' + X.esc(labels[ch.waveform] || ch.waveform || '正弦') + '</span>' +
        '<span>' + num(ch.base) + '</span>' +
        '<span>' + num(ch.amp) + '</span>' +
        '<span>' + num(ch.freq) + '</span>' +
        '<span>' + num(ch.noise) + '</span>' +
        '</button>';
    }).join('');
  }

  document.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[data-sim-channel]') : null;
    if (!row) return;
    updateSimChannel(row.dataset.simChannel);
  });

  function updateSimChannel(id) {
    state.selectedChannel = id;
    renderSimControls();
  }

  V.renderThresholdRows = renderThresholdRows;
  V.renderAlarmPanel = renderAlarmPanel;
  V.renderAlarmChart = renderAlarmChart;
  V.getAlarmChartMetrics = function () { return alarmGeo ? Object.assign({}, alarmGeo) : null; };
  V.syncAlarmValues = syncAlarmValues;
  V.renderSimControls = renderSimControls;
  V.updateSimChannel = updateSimChannel;
  // 通道卡片右键菜单要「定位到告警阈值」；这个函数原来只在面板内部用，
  // 外部只能靠模拟点击阈值行，绕。直接导出。
  V.focusAlarmChannel = focusAlarmChannel;
})();
