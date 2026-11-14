(function () {
  'use strict';
  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;
  const state = X.state;
  const ref = V.ref;
  const $ = V.$;
  const $$ = V.$$;

  function init() {
    Object.assign(ref, {
      chlList: $('#chlList'),
      dockLinkStrip: $('#dockLinkStrip'),
      dockChannelCount: $('#dockChannelCount'),
      dockLinkLed: $('#dockLinkLed'),
      dockLinkSource: $('#dockLinkSource'),
      dockLinkRate: $('#dockLinkRate'),
      dockLinkState: $('#dockLinkState'),
      dockStatWin: $('#dockStatWin'),
      dockStatsBody: $('#dockStatsBody'),
      dockAlarmBadge: $('#dockAlarmBadge'),
      dockAlarmTotal: $('#dockAlarmTotal'),
      dockAlarmTriggered: $('#dockAlarmTriggered'),
      dockAlarmCards: $('#dockAlarmCards'),
      dockAlarmRecords: $('#dockAlarmRecords'),
      btnDockGoAlarm: $('#btnDockGoAlarm'),
      chart: $('#chart'),
      chartTooltip: $('#chartTooltip'),
      chartCrosshair: $('#chartCrosshair'),
      chartCrosshairTime: $('#chartCrosshairTime'),
      barChart: $('#barChart'),
      mapCanvas: $('#mapCanvas'),
      tableWrap: $('#tableWrap'),
      tableHead: $('#tableHead'),
      tableBody: $('#tableBody'),
      tableStats: $('#tableStats'),
      gaugeWrap: $('#gaugeWrap'),
      gaugeGrid: $('#gaugeGrid'),
      miniMapWrap: $('#miniMapWrap'),
      swList: $('#swList'),
      lpPageList: $('#lpPageList'),
      lpPageCount: $('#lpPageCount'),
      lpChannelList: $('#lpChannelList'),
      lpChannelCount: $('#lpChannelCount'),
      lpWidgetCount: $('#lpWidgetCount'),
      plotTabs: $('#plotTabs'),
      plotControls: $('#plotControls'),
      chartFocusBadge: $('#chartFocusBadge'),
      btnAiViewStudio: $('#btnAiViewStudio'),
      mapControls: $('#mapControls'),
      statusInfo: $('#statusInfo'),
      alarmList: $('#alarmList'),
      alarmChart: $('#alarmChart'),
      alarmActive: $('#alarmActive'),
      alarmWarn: $('#alarmWarn'),
      alarmHigh: $('#alarmHigh'),
      alarmTotal: $('#alarmTotal'),
      alarmStats: $('#alarmStats'),
      thresholdList: $('#thresholdList'),
      alarmAckAll: $('#btnAckAll'),
      alarmClear: $('#btnClearAlarms'),
      simChannelSelect: $('#simChannelSelect'),
      simWaveSelect: $('#simWaveSelect'),
      simBase: $('#simBase'),
      simAmp: $('#simAmp'),
      simFreq: $('#simFreq'),
      simNoise: $('#simNoise'),
      scriptChannelCount: $('#scriptChannelCount'),
      btnRawTab: $('#btnRawTab'),
      btnScriptTab: $('#btnScriptTab'),
      chlAddrow: $('.chl-addrow'),
      btnMapCruise: $('#btnMapCruise'),
      btnMapHome: $('#btnMapHome'),
      btnMapWaypoint: $('#btnMapWaypoint'),
      btnMapClear: $('#btnMapClear'),
      btnMapPlay: $('#btnMapPlay'),
      btnPlay: $('#btnPlay')
    });

    // 页签高亮和「新通道」输入行必须按恢复出来的 state.channelTab 初始化：HTML 里 .active 默认写在
    // 「原始数据」上，而所有内容渲染都读 state.channelTab，重启后就会出现「高亮在原始数据、内容却是
    // 脚本数据」的错位（连「新通道」行也会跑到脚本数据页上）。三处一起同步，只切 class 会漏。
    syncChannelTabUI();
    renderChannelCards();
    // 主题/风格切换后卡片里的内联色点是旧主题色，重渲染才和画布曲线同源（X.viewColor 查表）
    window.addEventListener('xhgcs:theme-changed', renderChannelCards);
    window.addEventListener('xhgcs:fx-changed', renderChannelCards);
    // 鼠标点击后主动失焦：避免按钮保留焦点环，看起来像一圈白边
    ref.btnRawTab.addEventListener('click', (event) => {
      switchChannelTab('raw');
      if (event.detail > 0) ref.btnRawTab.blur();
    });
    ref.btnScriptTab.addEventListener('click', (event) => {
      switchChannelTab('script');
      if (event.detail > 0) ref.btnScriptTab.blur();
    });
    syncScriptCount();
    V.renderSimControls();
    V.renderGaugeCards();
    V.renderThresholdRows();

    ref.swList.addEventListener('click', (e) => {
      const edit = e.target.closest('.sw-edit');
      if (edit) {
        e.stopPropagation();
        const id = edit.dataset.viewEdit;
        if (id && V.openViewDesigner) V.openViewDesigner(id);
        return;
      }
      const del = e.target.closest('.sw-del');
      if (del) {
        e.stopPropagation();
        const id = del.dataset.viewDelete;
        if (id && window.confirm('删除自定义视图「' + id + '」？') && V.removeView(id)) {
          switchSubView('wave');
          V.callApp('toast', '已删除自定义视图');
        }
        return;
      }
      if (e.target.closest('#btnAddView')) {
        if (V.openViewDesigner) V.openViewDesigner();
        return;
      }
      const item = e.target.closest('.sw-item');
      if (!item) return;
      const id = item.dataset.subview;
      // 单击 = 切换整页（所有视图语义一致）；想叠加小窗用 Alt+单击或工具条「▣ 小窗」。
      // 原来内置视图单击开小窗、自定义视图双击弹编辑器，同一列三种语义，用户没法预期。
      if (e.altKey && V.openChartWork) {
        V.openChartWork(id);
        return;
      }
      if (V.closeChartWork) V.closeChartWork();
      switchSubView(id);
    });


    ref.swList.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.sw-item');
      if (!item || item.dataset.subview === '__preview__') return;
      const def = V.getView(item.dataset.subview);
      if (def && def.builtin) switchSubView(def.id);
      else if (def && V.openViewDesigner) V.openViewDesigner(def.id);
    });

    $('#btnAddChl').addEventListener('click', () => {
      const input = $('#newChlName');
      const name = input.value.trim() || ('新通道' + (state.channels.length + 1));
      const ch = X.makeChannel({
        id: X.uid('ch'),
        name: name,
        unit: '',
        color: $('#newChlColor').value || 'auto',
        range: [0, 100],
        base: 50,
        amp: 26,
        freq: 0.8,
        noise: 1,
        waveform: 'sine',
        visible: true
      });
      state.channels.push(ch);
      state.selectedChannel = ch.id;
      input.value = '';
      $('#newChlColor').value = 'auto';
      renderChannelCards();
      V.renderThresholdRows();
      V.renderSimControls();
      V.renderGaugeCards();
      X.persist();
      V.callApp('toast', '已添加通道 ' + ch.name);
    });
    if (ref.btnAiViewStudio) {
      ref.btnAiViewStudio.addEventListener('click', function () {
        if (V.openViewDesigner) V.openViewDesigner();
      });
    }
    if (ref.chartFocusBadge) {
      ref.chartFocusBadge.addEventListener('click', function () {
        state.chartFocusId = '';
        syncChartFocusBadge();
        V.renderChart();
      });
    }

    if (typeof V.bindMap === 'function') V.bindMap();

    window.addEventListener('resize', () => {
      V.resizeAll();
      V.resizeActiveView();
    });
    // 抽屉开合不一定会改变 window 尺寸，但一定会改变画布可用宽度。
    // 用 ResizeObserver + 单帧合并，避免拖动时连续重建 canvas backing store。
    if (window.ResizeObserver) {
      const chartWrap = $('.plotwrap, .chart-wrap');
      let pending = 0;
      const observer = new ResizeObserver(function () {
        if (pending) return;
        pending = requestAnimationFrame(function () {
          pending = 0;
          V.resizeAll();
          V.resizeActiveView();
        });
      });
      if (chartWrap) observer.observe(chartWrap);
    }

    bindChannelConfigModal();
    if (ref.btnDockGoAlarm) {
      ref.btnDockGoAlarm.addEventListener('click', () => {
        const nav = document.querySelector('#sideNav [data-nav="alarm"]');
        if (nav) nav.click();
      });
    }
    window.addEventListener('xhgcs:layout-changed', () => {
      updateDockBadge();
      updateDockLink();
      if (dockTabName() === 'alarm') renderDockAlarmPage(true);
      else renderDockStats();
    });
    updateDockBadge();
    updateDockLink();
    renderDockAlarmPage(true);
    registerBuiltins();
    if (V.installViews) V.installViews();
    bindWorkbenchPicker();
    bindPlotTabs();
    renderPlotTabs();
    // #plotMore 溢出菜单：窄屏收起项仍可点
    const moreBtn = $('#plotMore');
    const moreMenu = $('#plotMoreMenu');
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = moreMenu.classList.toggle('open');
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (!moreMenu.classList.contains('open')) return;
        if (e.target.closest('#plotMoreMenu') || e.target.closest('#plotMore')) return;
        moreMenu.classList.remove('open');
        moreBtn.setAttribute('aria-expanded', 'false');
      });
    }
    // 时间窗 chips：接通现有 zoomMode/windowSec（fixed 窗口），不改图表语义
    document.querySelectorAll('.seg button[data-w]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg button[data-w]').forEach((b) => b.classList.toggle('active', b === btn));
        const sec = Number(btn.dataset.w) || 60;
        state.zoomMode = 'fixed';
        state.windowSec = sec;
        try { X.persist(); } catch (err) { /* 持久化失败不影响本次渲染 */ }
        if (V.renderChart) V.renderChart();
        const zoomBtn = document.getElementById('btnZoom');
        if (zoomBtn) zoomBtn.textContent = '缩放：固定';
      });
    });
    // 首屏按当前状态同步一次选中态
    (function syncWindowChips() {
      const sec = state.zoomMode === 'fixed' ? Number(state.windowSec) || 60 : 60;
      document.querySelectorAll('.seg button[data-w]').forEach((b) => b.classList.toggle('active', Number(b.dataset.w) === sec));
    })();
    // 左栏三段：图页行点击复用 setActivePlot；新建走 X.addPlot 同一逻辑
    const lpPages = $('#lpPageList');
    if (lpPages) {
      lpPages.addEventListener('click', (e) => {
        const row = e.target.closest('[data-lp-plot]');
        if (row) setActivePlot(row.dataset.lpPlot);
      });
    }
    const addPlotSide = $('#btnAddPlotSide');
    if (addPlotSide) {
      addPlotSide.addEventListener('click', () => {
        setActivePlot(X.addPlot(state.subview).id);
        V.callApp('toast', '已新建图页；在图上右键勾选它要显示的通道');
      });
    }
    renderLeftPanel();
    // 开局按「当前图页」的图种进入，而不是写死波形图
    const bootPlot = X.activePlot();
    switchSubView(bootPlot ? bootPlot.view : 'wave');
  }

  // 页签三件套（两个按钮高亮 + 「新通道」输入行）只有一个开关来源：启动和点击都走这里
  function syncChannelTabUI() {
    const tab = state.channelTab === 'script' ? 'script' : 'raw';
    ref.btnRawTab.classList.toggle('active', tab === 'raw');
    ref.btnScriptTab.classList.toggle('active', tab === 'script');
    if (ref.chlAddrow) ref.chlAddrow.classList.toggle('hidden', tab === 'script');
  }

  function switchChannelTab(tab) {
    state.channelTab = tab;
    syncChannelTabUI();
    renderChannelCards();
    V.renderThresholdRows();
    V.renderGaugeCards();
    X.persist();
  }

  let channelConfigId = '';

  // 脚本数据数量角标：为 0 时整枚数字收起来（和 AI 子任务角标一个口径），只留页签名
  function syncScriptCount() {
    const n = state.scriptChannels.length;
    ref.scriptChannelCount.textContent = n;
    ref.scriptChannelCount.classList.toggle('hidden', !n);
  }

  // ===================== P2.2 右栏 xg/xa 数据面板 =====================
  const DOCK_THROTTLE_MS = 1000;
  let dockValsAt = 0;
  let dockStatsSig = '';
  let dockAlarmSig = '';
  let dockLinkSig = '';

  // Dock 页签在 layout 的独立 state 里；views-core 读 dataset.tab（layout syncDock 同步写入）
  function dockTabName() {
    const el = document.getElementById('workspaceDock');
    return el && el.dataset.tab === 'alarm' ? 'alarm' : 'data';
  }

  function dockMetrics() {
    return (V.chartMetrics && V.chartMetrics.dt) ? V.chartMetrics : null;
  }

  // 当前窗口内的 min/max/首值/末值/峰值（与图表同一 X 窗口；有界扫描）
  function dockWindow(ch) {
    const data = ch.data || [];
    if (!data.length) return null;
    const m = dockMetrics();
    let i0 = 0, i1 = data.length - 1;
    if (m && Number.isFinite(m.firstT) && Number.isFinite(m.xStart) && Number.isFinite(m.xEnd)) {
      i0 = Math.max(0, Math.min(data.length - 1, Math.floor((m.xStart - m.firstT) / m.dt)));
      i1 = Math.max(i0, Math.min(data.length - 1, Math.ceil((m.xEnd - m.firstT) / m.dt)));
    } else {
      i0 = Math.max(0, data.length - 60);
    }
    const count = Math.max(1, i1 - i0 + 1);
    const step = Math.max(1, Math.floor(count / 4000));
    let min = Infinity, max = -Infinity, sum = 0, n = 0, peak = -Infinity;
    for (let i = i0; i <= i1; i += step) {
      const v = Number(data[i]);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n += 1;
    }
    if (!n) return null;
    return { min: min, max: max, avg: sum / n, first: Number(data[i0]), last: Number(data[i1]), peak: max };
  }

  // 窗口内是否越过阈值（用于 warn「曾越限」）
  function dockCrossed(ch, range) {
    if (!range) return false;
    const t = X.alarmThresholds(ch);
    if (t.warnHigh != null && range.max >= t.warnHigh) return true;
    if (t.warnLow != null && range.min <= t.warnLow) return true;
    return false;
  }

  function dockState(ch, range) {
    const alarm = X.getAlarm(ch);
    if (alarm && alarm.level && alarm.level !== 'ok') return 'alarm';
    if (dockCrossed(ch, range)) return 'warn';
    return 'ok';
  }

  function dockPct(ch, value) {
    const span = ch.range[1] - ch.range[0];
    if (!(span > 0)) return 0;
    return Math.max(0, Math.min(100, (value - ch.range[0]) / span * 100));
  }

  function dockCardHtml(ch) {
    const color = X.viewColor(ch.color);
    const eyeIcon = ch.visible ? 'i-eye' : 'i-eye-off';
    // v4 数据卡：44–48px，左侧 3px 通道色条 + 名称 12 + 眼睛；第二行 值 16 + 单位 10 + Δ 10。
    // 无 sparkline / 无轨道 / 无滑块 / 无斜纹 / 无阈值刻线 / 无量程文本（量程轨道只属告警页）。
    return '<div class="chcard chl' + (ch.visible ? '' : ' off is-off') + '" data-channel-id="' + ch.id + '" data-state="ok" style="--xg-c:' + color + '">'
      + '<div class="xg-r1"><span class="chl-name xg-name">' + X.esc(ch.name) + '</span>'
      + '<button class="chl-eye xg-eye" type="button" aria-pressed="' + (ch.visible ? 'true' : 'false') + '" title="显示 / 隐藏曲线">'
      + '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#' + eyeIcon + '"/></svg></button></div>'
      + '<div class="xg-r2"><span class="chl-val xg-val value"></span><span class="chl-unit xg-unit"></span>'
      + '<span class="xg-tail"><span class="chl-delta xg-delta"></span></span></div>'
      + '</div>';
  }

  // 只更新文本/属性/路径，不重建 DOM
  function dockUpdateCard(card, ch, range) {
    if (!card || !range) return;
    const state = dockState(ch, range);
    card.dataset.state = state;
    card.classList.toggle('is-off', !ch.visible);
    const eye = card.querySelector('.chl-eye');
    if (eye) {
      const pressed = ch.visible ? 'true' : 'false';
      if (eye.getAttribute('aria-pressed') !== pressed) {
        eye.setAttribute('aria-pressed', pressed);
        const use = eye.querySelector('use');
        if (use) use.setAttribute('href', ch.visible ? '#i-eye' : '#i-eye-off');
      }
    }
    const name = card.querySelector('.chl-name');
    if (name && name.textContent !== ch.name) name.textContent = ch.name;
    const val = card.querySelector('.chl-val');
    if (val) val.textContent = X.formatChannelValue(ch, range.last);
    const unit = card.querySelector('.chl-unit');
    if (unit) unit.textContent = ch.unit || '';
    const delta = card.querySelector('.chl-delta');
    if (delta) {
      const diff = range.last - range.first;
      const arrow = Math.abs(diff) < 1e-9 ? '' : (diff > 0 ? '↑' : '↓');
      delta.textContent = arrow + X.formatChannelValue(ch, Math.abs(diff));
      delta.classList.toggle('up', diff > 0);
      delta.classList.toggle('down', diff < 0);
    }
  }

  function updateDockLink() {
    if (!ref.dockLinkSource) return;
    const sim = Boolean(state.simulation && state.simulation.enabled);
    const src = sim ? '仿真数据' : (state.serial && state.serial.connected ? ('串口 ' + (state.serial.port || '')) : '未连接');
    const rate = (1000 / Math.max(1, Number(state.intervalMs) || 100) | 0) + ' Hz';
    const online = sim || Boolean(state.serial && state.serial.connected);
    const onlineText = online ? '在线' : '离线';
    const sig = src + '|' + rate + '|' + onlineText;
    if (sig === dockLinkSig) return;
    dockLinkSig = sig;
    ref.dockLinkSource.textContent = src;
    if (ref.dockLinkRate) ref.dockLinkRate.textContent = rate;
    if (ref.dockLinkState) ref.dockLinkState.textContent = onlineText;
    if (ref.dockLinkLed) ref.dockLinkLed.classList.toggle('ok', online);
    if (ref.dockLinkStrip) ref.dockLinkStrip.classList.toggle('is-offline', !online);
  }

  function updateDockBadge() {
    if (!ref.dockAlarmBadge) return;
    const unack = dockAlarmGroups().filter((g) => !g.ack).length;
    ref.dockAlarmBadge.textContent = String(unack);
    ref.dockAlarmBadge.classList.toggle('hidden', !unack);
  }

  function renderDockStats(force) {
    if (!ref.dockStatsBody) return;
    const rows = [];
    const windowSec = dockMetrics() ? (dockMetrics().xEnd - dockMetrics().xStart) : 0;
    if (ref.dockStatWin) ref.dockStatWin.textContent = windowSec > 0 ? windowSec.toFixed(1) + ' s' : '—';
    // 行 = 当前可见通道（与图表一致），最多 12 行
    const channels = (X.plotChannels ? X.plotChannels() : X.activeChannels()).slice(0, 12);
    const sig = channels.map((ch) => ch.id).join(',');
    if (force || sig !== dockStatsSig) {
      dockStatsSig = sig;
      ref.dockStatsBody.innerHTML = channels.map((ch) =>
        '<tr data-channel-id="' + ch.id + '"><td>' + X.esc(ch.name) + '</td><td></td><td></td><td></td></tr>'
      ).join('');
    }
    channels.forEach((ch) => {
      const range = dockWindow(ch);
      const tr = ref.dockStatsBody.querySelector('tr[data-channel-id="' + ch.id + '"]');
      if (!tr || !range) return;
      const cells = tr.querySelectorAll('td');
      if (cells.length < 4) return;
      cells[0].textContent = ch.name;
      cells[1].textContent = X.formatChannelValue(ch, range.min);
      cells[2].textContent = X.formatChannelValue(ch, range.avg);
      cells[3].textContent = X.formatChannelValue(ch, range.max);
    });
  }

  function dockThresholdText(ch) {
    const t = X.alarmThresholds(ch);
    const unit = ch.unit ? ' ' + ch.unit : '';
    if (t.warnLow != null && t.warnHigh != null) return '<' + t.warnLow.toFixed(2) + unit + ' / >' + t.warnHigh.toFixed(2) + unit;
    if (t.warnLow != null) return '<' + t.warnLow.toFixed(2) + unit;
    if (t.warnHigh != null) return '>' + t.warnHigh.toFixed(2) + unit;
    return '—';
  }

  function dockAlarmTime(ms) {
    const d = new Date(Number(ms) || Date.now());
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // 同通道 + 1s 内合并成一条（真实记录仍保存在 state.alarms，只影响展示）
  function dockAlarmGroups() {
    const raw = (state.alarms || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    const groups = [];
    raw.forEach((a) => {
      const last = groups[groups.length - 1];
      if (last && last.channelId === a.channelId && Math.abs((last.lastTime || 0) - (a.time || 0)) <= 1000) {
        last.count += 1;
        last.lastTime = Math.min(last.lastTime, a.time || 0);
        last.firstTime = Math.min(last.firstTime, a.time || 0);
        last.peak = Math.max(last.peak, Number(a.value) || 0);
        last.ack = last.ack && Boolean(a.ack);
        last.level = (last.level === 'high' || a.level === 'high') ? 'high' : 'warn';
        return;
      }
      groups.push({
        key: String(a.channelId || '') + ':' + String(a.id || ''),
        channelId: a.channelId || '',
        name: a.name || '',
        firstTime: Number(a.time) || Date.now(),
        lastTime: Number(a.time) || Date.now(),
        count: 1,
        peak: Number(a.value) || 0,
        ack: Boolean(a.ack),
        level: a.level === 'high' ? 'high' : 'warn'
      });
    });
    return groups;
  }

  function dockAlarmDuration(group) {
    if (!group.ack) return '进行中';
    const span = Math.max(0, group.firstTime - group.lastTime);
    if (span >= 100) return (span / 1000).toFixed(1) + ' s';
    return '已结束';
  }

  function dockPushTab(tab) {
    if (window.XHGCS_LAYOUT && XHGCS_LAYOUT.setDockTab) XHGCS_LAYOUT.setDockTab(tab);
  }

  function dockCardSetHtml(list) {
    return list.map((ch) => {
      const color = X.viewColor(ch.color);
      // v4 告警卡：名称 12 + 圆点 chip（越限红底 / 曾越限红描边 / 正常灰）/ 值 16 + 单位 + 阈值 / 量程轨道。
      // mockup 的告警卡没有 sparkline，这里也不画。
      return '<div class="xa-card" data-channel-id="' + ch.id + '" data-state="ok" style="--xa-c:' + color + '">'
        + '<div class="xa-r1"><span class="xa-name">' + X.esc(ch.name) + '</span><span class="xa-chip">正常</span></div>'
        + '<div class="xa-r2"><span class="xa-val"></span><span class="xa-unit">' + X.esc(ch.unit || '') + '</span>'
        + '<span class="xa-limit"></span></div>'
        + '<div class="xa-track" role="img" aria-label="量程轨道">'
        + '<span class="xa-base"></span><span class="xa-zone-low"></span><span class="xa-zone-high"></span>'
        + '<span class="xa-win"></span><span class="xa-hot"></span><span class="xa-thr-hi"></span><span class="xa-thr-lo"></span>'
        + '<span class="xa-peak"></span><span class="xa-knob"></span></div>'
        + '</div>';
    }).join('');
  }

  function renderDockAlarmPage(force) {
    if (!ref.dockAlarmCards) return;
    const channels = (X.plotChannels ? X.plotChannels() : X.activeChannels());
    const entries = channels.map((ch) => {
      const range = dockWindow(ch);
      return { ch: ch, range: range, state: dockState(ch, range) };
    });
    const order = { alarm: 0, warn: 1, ok: 2 };
    entries.sort((a, b) => (order[a.state] - order[b.state]) || (a.ch.name > b.ch.name ? 1 : -1));
    const sig = entries.map((e) => e.ch.id + ':' + e.state).join(',');
    if (force || sig !== dockAlarmSig) {
      dockAlarmSig = sig;
      ref.dockAlarmCards.innerHTML = entries.length ? dockCardSetHtml(entries.map((e) => e.ch)) : '<div class="xa-empty">—</div>';
    }
    entries.forEach((entry) => {
      const card = ref.dockAlarmCards.querySelector('[data-channel-id="' + entry.ch.id + '"]');
      if (!card || !entry.range) return;
      const stateText = { alarm: '越限', warn: '曾越限', ok: '正常' }[entry.state];
      card.dataset.state = entry.state;
      const name = card.querySelector('.xa-name');
      if (name) name.textContent = entry.ch.name;
      const chip = card.querySelector('.xa-chip');
      if (chip) chip.textContent = stateText;
      const val = card.querySelector('.xa-val');
      if (val) val.textContent = X.formatChannelValue(entry.ch, entry.range.last);
      const unit = card.querySelector('.xa-unit');
      if (unit) unit.textContent = entry.ch.unit || '';
      const limit = card.querySelector('.xa-limit');
      if (limit) limit.textContent = dockThresholdText(entry.ch);
      dockUpdateTrack(card, 'xa', entry.ch, entry.range, entry.state);
    });
    const groups = dockAlarmGroups();
    const unack = groups.filter((g) => !g.ack).length;
    if (ref.dockAlarmTotal) ref.dockAlarmTotal.textContent = String(groups.length);
    if (ref.dockAlarmTriggered) {
      ref.dockAlarmTriggered.textContent = '触发 ' + unack;
      ref.dockAlarmTriggered.classList.toggle('is-on', unack > 0);
    }
    const recSig = groups.slice(0, 8).map((g) => g.key + g.lastTime + g.ack).join(',');
    if (force || recSig !== renderDockAlarmPage._sig) {
      renderDockAlarmPage._sig = recSig;
      if (ref.dockAlarmRecords) {
        ref.dockAlarmRecords.innerHTML = groups.slice(0, 8).map((g) => {
          const ch = (X.allChannels ? X.allChannels() : []).find((item) => item.id === g.channelId);
          const limitText = ch ? dockThresholdText(ch) : '—';
          const peakText = X.formatChannelValue(ch || { decimals: 1 }, g.peak);
          return '<div class="xa-alarm' + (g.ack ? '' : ' is-active') + '">'
            + '<svg class="xa-alarm-ico" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-bell"/></svg>'
            + '<div class="xa-alarm-main">'
            + '<div class="xa-alarm-l1"><span class="xa-alarm-name">' + X.esc(g.name || '') + '</span>'
            + '<span class="xa-alarm-time">' + dockAlarmTime(g.lastTime) + '</span>'
            + '<span class="xa-alarm-ack">' + (g.ack ? '已确认' : '触发') + '</span></div>'
            + '<div class="xa-alarm-l2"><span class="xa-alarm-rule">' + X.esc(limitText) + '</span>'
            + '<span class="xa-alarm-peak">峰值 ' + X.esc(peakText) + '</span>'
            + '<span class="xa-alarm-dur">' + dockAlarmDuration(g) + '</span></div></div></div>';
        }).join('');
      }
    }
    if (ref.dockAlarmBadge) { updateDockBadge(); }
  }

  // xa 轨道几何（与 xg 同一套百分比语义，前缀不同）
  function dockUpdateTrack(card, prefix, ch, range, state) {
    const t = X.alarmThresholds(ch);
    const pct = (v) => dockPct(ch, v);
    card.style.setProperty('--' + prefix + '-cur', pct(range.last).toFixed(2) + '%');
    card.style.setProperty('--' + prefix + '-win-l', pct(range.min).toFixed(2) + '%');
    card.style.setProperty('--' + prefix + '-win-w', Math.max(0, pct(range.max) - pct(range.min)).toFixed(2) + '%');
    card.style.setProperty('--' + prefix + '-peak', pct(range.peak).toFixed(2) + '%');
    if (t.warnHigh != null) {
      card.style.setProperty('--' + prefix + '-thr-hi', pct(t.warnHigh).toFixed(2) + '%');
      card.style.setProperty('--' + prefix + '-zone-high-l', pct(t.warnHigh).toFixed(2) + '%');
      card.style.setProperty('--' + prefix + '-zone-high-w', Math.max(0, 100 - pct(t.warnHigh)).toFixed(2) + '%');
      card.classList.add('has-hi');
      const over = range.last > t.warnHigh;
      card.classList.toggle('hot-high', over);
      if (over) {
        card.style.setProperty('--' + prefix + '-hot-l', pct(t.warnHigh).toFixed(2) + '%');
        card.style.setProperty('--' + prefix + '-hot-w', Math.max(0, pct(range.last) - pct(t.warnHigh)).toFixed(2) + '%');
      }
    } else card.classList.remove('has-hi');
    if (t.warnLow != null) {
      card.style.setProperty('--' + prefix + '-thr-lo', pct(t.warnLow).toFixed(2) + '%');
      card.style.setProperty('--' + prefix + '-zone-low-w', pct(t.warnLow).toFixed(2) + '%');
      card.classList.add('has-lo');
      const under = range.last < t.warnLow;
      card.classList.toggle('hot-low', under);
      if (under) {
        card.style.setProperty('--' + prefix + '-hot-l', pct(range.last).toFixed(2) + '%');
        card.style.setProperty('--' + prefix + '-hot-w', Math.max(0, pct(t.warnLow) - pct(range.last)).toFixed(2) + '%');
      }
    } else card.classList.remove('has-lo');
    card.classList.toggle('is-alarm', state === 'alarm');
  }


  function renderChannelCards() {
    if (!ref.chlList) return;
    ref.chlList.innerHTML = '';
    const channels = X.activeChannels();
    if (!channels.length) {
      const empty = document.createElement('div');
      empty.className = 'chl-empty';
      empty.innerHTML = state.channelTab === 'script'
        ? '<b>脚本数据为空</b>在画布工具条点「运行并附加」，或让 AI 生成脚本，结果会出现在这里。'
        : '<b>暂无通道</b>用下方输入框新建一个通道。';
      ref.chlList.appendChild(empty);
      return;
    }
    channels.forEach((ch) => {
      const holder = document.createElement('div');
      holder.innerHTML = dockCardHtml(ch);
      const card = holder.firstElementChild;
      // 眼睛：显示/隐藏曲线（只改 class 与图标，不重建卡）
      const eye = card.querySelector('.chl-eye');
      if (eye) {
        eye.addEventListener('click', () => {
          ch.visible = !ch.visible;
          card.classList.toggle('is-off', !ch.visible);
          card.classList.toggle('hidden-ch', !ch.visible);
          eye.setAttribute('aria-pressed', ch.visible ? 'true' : 'false');
          const use = eye.querySelector('use');
          if (use) use.setAttribute('href', ch.visible ? '#i-eye' : '#i-eye-off');
          if (state.subview === 'wave') V.renderChart();
          if (state.subview === 'bar') V.renderBar();
          if (V.renderChartWork) V.renderChartWork(true);
          X.persist();
        });
      }
      card.addEventListener('dblclick', (event) => {
        if (event.target.closest('button')) return;
        state.chartFocusId = ch.id;
        if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
        syncChartFocusBadge();
        V.renderChart();
      });
      ref.chlList.appendChild(card);
    });
    syncScriptCount();
    if (ref.dockChannelCount) ref.dockChannelCount.textContent = String(channels.length);
    renderDockStats(true);
    updateDockLink();
    updateDockBadge();
    renderChannelVals(true);
    if (dockTabName() === 'alarm') renderDockAlarmPage(true);
  }
  // 移除通道：脚本通道走脚本接口，原始通道至少留一个
  function removeChannel(ch) {
    if (ch.isScript) {
      X.removeScriptChannel(ch.id);
      state.selectedChannel = state.channels[0] ? state.channels[0].id : '';
    } else if (state.channels.length <= 1) {
      V.callApp('toast', '至少保留一个通道');
      return;
    } else {
      state.channels = state.channels.filter((item) => item.id !== ch.id);
      state.selectedChannel = state.channels[0].id;
    }
    if (channelConfigId === ch.id) closeChannelConfig();
    if (state.chartFocusId === ch.id) state.chartFocusId = '';
    renderChannelCards();
    V.renderThresholdRows();
    V.renderSimControls();
    V.renderGaugeCards();
    X.persist();
  }

  // 通道配置走弹窗：12 个字段塞进 250px 宽的列会把卡片撑到 700px 高，整个通道列表被挤没
  function channelCard(ch) {
    return ref.chlList.querySelector('.chl[data-channel-id="' + ch.id + '"]');
  }

  function channelConfigHtml(ch) {
    const rows = [
      '<div class="field-group-title">显示与映射</div>',
      '<div class="cfg-grid">',
      '<label class="cfg-label">名称 <input class="c-name" value="' + X.esc(ch.name) + '" /></label>',
      '<label class="cfg-label">单位 <input class="c-unit" value="' + X.esc(ch.unit) + '" /></label>',
      '<label class="cfg-label">倍率 <input class="c-scale" type="number" step="0.1" value="' + ch.scale + '" /></label>',
      '<label class="cfg-label">偏移 <input class="c-offset" type="number" step="0.1" value="' + ch.offset + '" /></label>',
      '<label class="cfg-label">量程最小 <input class="c-min" type="number" value="' + ch.range[0] + '" /></label>',
      '<label class="cfg-label">量程最大 <input class="c-max" type="number" value="' + ch.range[1] + '" /></label>',
      '<label class="cfg-label">颜色 <input class="c-color" type="color" value="' + ch.color + '" /></label>',
      '</div>'
    ];
    if (!ch.isScript) {
      rows.push(
        '<div class="field-group-title">仿真参数</div>',
        '<div class="cfg-grid">',
        '<label class="cfg-label">波形 <select class="c-wave">' +
          Object.keys(X.WAVE_LABELS).map(function (key) {
            return '<option value="' + key + '"' + (ch.waveform === key ? ' selected' : '') + '>' + X.WAVE_LABELS[key] + '</option>';
          }).join('') +
          '</select></label>',
        '<label class="cfg-label">基准 <input class="c-base" type="number" step="0.1" value="' + ch.base + '" /></label>',
        '<label class="cfg-label">幅值 <input class="c-amp" type="number" step="0.1" value="' + ch.amp + '" /></label>',
        '<label class="cfg-label">频率 <input class="c-freq" type="number" step="0.01" value="' + ch.freq + '" /></label>',
        '<label class="cfg-label">噪声 <input class="c-noise" type="number" step="0.1" value="' + ch.noise + '" /></label>',
        '</div>'
      );
    }
    return rows.join('');
  }

  function bindChannelConfig(ch, root) {
    const card = channelCard(ch);
    const setCardText = (sel, text) => { const node = card ? card.querySelector(sel) : null; if (node) node.textContent = text; };
    const setTitle = () => { const t = document.getElementById('chlModalTitle'); if (t) t.textContent = '通道配置 · ' + ch.name; };
    root.querySelector('.c-name').addEventListener('change', (e) => {
      ch.name = e.target.value.trim() || ch.name;
      setCardText('.chl-name', ch.name);
      setTitle();
      V.renderThresholdRows();
      X.persist();
    });
    root.querySelector('.c-unit').addEventListener('change', (e) => {
      ch.unit = e.target.value;
      setCardText('.chl-range', ch.range[0] + '–' + ch.range[1] + (ch.unit ? ' ' + ch.unit : ''));
      V.renderGaugeCards();
      X.persist();
    });
    root.querySelector('.c-scale').addEventListener('change', (e) => { ch.scale = Number(e.target.value) || 1; X.persist(); });
    root.querySelector('.c-offset').addEventListener('change', (e) => { ch.offset = Number(e.target.value) || 0; X.persist(); });
    root.querySelector('.c-color').addEventListener('input', (e) => {
      ch.color = e.target.value;
      if (card) card.style.setProperty('--xg-c', X.viewColor(ch.color));
      X.persist();
    });
    const minInput = root.querySelector('.c-min');
    const maxInput = root.querySelector('.c-max');
    [minInput, maxInput].forEach((input) => input.addEventListener('change', () => {
      const min = Number(minInput.value);
      const max = Number(maxInput.value);
      if (max <= min) {
        V.callApp('toast', '量程最大值必须大于最小值');
        return;
      }
      ch.range = [min, max];
      // 改量程不再顺手重置预警阈值：那是用户自己填的，被静默改写等于白填一次。
      // （原来这里按新量程的 ±20% 覆盖，改一次量程就得回去重设一遍阈值）
      setCardText('.chl-range', min + '–' + max + (ch.unit ? ' ' + ch.unit : ''));
      V.renderThresholdRows();
      V.renderGaugeCards();
      X.persist();
    }));
    const wave = root.querySelector('.c-wave');
    if (!wave) return;
    wave.addEventListener('change', (e) => { ch.waveform = e.target.value; V.renderSimControls(); X.persist(); });
    root.querySelector('.c-base').addEventListener('change', (e) => { ch.base = Number(e.target.value) || 0; X.persist(); });
    root.querySelector('.c-amp').addEventListener('change', (e) => { ch.amp = Number(e.target.value) || 0; X.persist(); });
    root.querySelector('.c-freq').addEventListener('change', (e) => { ch.freq = Number(e.target.value) || 0; X.persist(); });
    root.querySelector('.c-noise').addEventListener('change', (e) => { ch.noise = Math.max(0, Number(e.target.value) || 0); X.persist(); });
  }

  function openChannelConfig(ch) {
    const modal = document.getElementById('chlModal');
    if (!modal) return;
    channelConfigId = ch.id;
    const title = document.getElementById('chlModalTitle');
    if (title) title.textContent = '通道配置 · ' + ch.name;
    const body = document.getElementById('chlModalBody');
    body.innerHTML = channelConfigHtml(ch);
    bindChannelConfig(ch, body);
    modal.classList.remove('hidden');
  }

  function closeChannelConfig() {
    const modal = document.getElementById('chlModal');
    if (modal) modal.classList.add('hidden');
    channelConfigId = '';
    renderChannelCards();
  }

  function bindChannelConfigModal() {
    const modal = document.getElementById('chlModal');
    if (!modal) return;
    const done = document.getElementById('btnChlDone');
    const close = document.getElementById('btnCloseChlModal');
    const del = document.getElementById('btnChlDelete');
    if (done) done.addEventListener('click', closeChannelConfig);
    if (close) close.addEventListener('click', closeChannelConfig);
    if (del) del.addEventListener('click', () => {
      const ch = X.activeChannels().find((item) => item.id === channelConfigId);
      if (ch) removeChannel(ch);
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) closeChannelConfig(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (modal.classList.contains('hidden')) return;
      const app = window.XHGCS_APP;
      if (app && app.topOverlay && app.topOverlay() !== 'chlModal') return;
      closeChannelConfig();
    });
  }

  function renderChannelVals(force) {
    const now = Date.now();
    // 通道卡 / sparkline / 轨道 / 统计按 1s 节拍更新：只改文本/属性/路径，不重建 DOM
    if (!force && now - dockValsAt < DOCK_THROTTLE_MS) return;
    dockValsAt = now;
    X.activeChannels().forEach((ch) => {
      const card = ref.chlList.querySelector('[data-channel-id="' + ch.id + '"]');
      if (!card) return;
      const range = dockWindow(ch);
      if (!range) return;
      dockUpdateCard(card, ch, range);
    });
    if (typeof V.updateGaugeValues === 'function') V.updateGaugeValues();
    updateDockLink();
    renderDockStats();
    updateDockBadge();
    if (dockTabName() === 'alarm') renderDockAlarmPage(false);
  }
  // 小窗选择器：选项必须等内置视图注册完再填，否则只剩一个占位项
  function bindWorkbenchPicker() {
    const wbSelect = $('#wbSelect');
    if (!wbSelect || wbSelect.dataset.bound === '1') return;
    wbSelect.dataset.bound = '1';
    const fillWb = () => {
      const current = wbSelect.value;
      const defs = (V.listViews ? V.listViews() : []).filter((def) => def && def.id && def.id !== 'wave' && def.id !== '__preview__');
      wbSelect.replaceChildren(new Option('▣ 小窗', ''));
      defs.forEach((def) => wbSelect.appendChild(new Option(def.name || def.id, def.id)));
      wbSelect.value = current && defs.some((def) => def.id === current) ? current : '';
    };
    fillWb();
    wbSelect.addEventListener('pointerdown', fillWb);
    wbSelect.addEventListener('change', () => {
      const target = wbSelect.value;
      wbSelect.value = '';
      if (target && V.openChartWork) V.openChartWork(target);
    });
  }
  function switchSubView(view) {
    // 图种必须真的存在：存档里可能留着已被删掉的自定义视图 id，
    // 落回波形图，免得所有面板都藏起来、画布全空
    const usable = (V.getView && V.getView(view)) ? view : 'wave';
    if (V.closeChartWork) V.closeChartWork();
    state.subview = usable;
    // 左列选图种 = 改「当前图页」的图种（图页与选择器一一对应），顺手刷新标签栏
    const plot = X.activePlot();
    if (plot && plot.view !== usable) {
      const autoNames = { '波形图': 1, '柱状图': 1, '数据表': 1, '仪表': 1, '地图': 1 };
      X.updatePlot(plot.id, { view: usable, name: autoNames[plot.name] ? '' : plot.name });
      renderPlotTabs();
    }
    // 状态栏由各视图在渲染时写入，切视图先清空，免得残留上一个视图的文案
    if (ref.statusInfo) ref.statusInfo.textContent = '';
    if (V.activateView && V.getView && V.getView(usable)) V.activateView(usable);
    else { showPanel(usable); if (V.renderSwitcher) V.renderSwitcher(); }
    const activeDef = V.getView ? V.getView(usable) : null;
    if (activeDef && !activeDef.builtin) {
      ref.plotControls.classList.add('hidden');
      ref.mapControls.classList.add('hidden');
      const png = $('#btnExportPng');
      if (png) png.classList.add('hidden');
      if (ref.chartFocusBadge) ref.chartFocusBadge.classList.add('hidden');
    }
    syncChartFocusBadge();
    updateHeadText();
    renderLeftPanel();
  }

  // 柱状/数据表/仪表视图不画曲线：标桩、网格、缩放、回中、复位视图在那边点了不会有任何变化，直接隐藏
  const NO_CHART_CONTROLS = { bar: 1, table: 1, gauge: 1 };
  // 数据表和仪表视图里没有画布，PNG 只会提示「当前视图没有可导出的画布」
  const NO_CANVAS_VIEW = { table: 1, gauge: 1 };

  function showPanel(view) {
    ref.plotControls.classList.toggle('hidden', view === 'map');
    const hideChartControls = !!NO_CHART_CONTROLS[view];
    ref.plotControls.querySelectorAll('[data-chart-only]').forEach((el) => el.classList.toggle('hidden', hideChartControls));
    const pngBtn = $('#btnExportPng');
    if (pngBtn) pngBtn.classList.toggle('hidden', !!NO_CANVAS_VIEW[view]);
    ref.mapControls.classList.toggle('hidden', view !== 'map');
    ref.chart.classList.toggle('hidden', view !== 'wave');
    ref.barChart.classList.toggle('hidden', view !== 'bar');
    ref.tableWrap.classList.toggle('hidden', view !== 'table');
    ref.gaugeWrap.classList.toggle('hidden', view !== 'gauge');
    ref.miniMapWrap.classList.toggle('hidden', view !== 'map');
    if (ref.chartFocusBadge) ref.chartFocusBadge.classList.toggle('hidden', view !== 'wave' || !state.chartFocusId);
    if (V.hideChartTooltip) V.hideChartTooltip();
  }

  function syncChartFocusBadge() {
    const el = ref.chartFocusBadge;
    if (!el) return;
    const ch = state.chartFocusId && X.findChannel ? X.findChannel(state.chartFocusId) : null;
    if (!ch) state.chartFocusId = '';
    el.classList.toggle('hidden', !ch || state.subview !== 'wave');
    el.textContent = ch ? '聚焦：' + ch.name + ' ×' : '';
    el.title = ch ? '当前只画 ' + ch.name + '；点这里恢复全部曲线' : '';
  }

  // ---- 图页：一个窗口开多张图，每张图自己勾通道 ----
  // 照搬 vofa 的做法：每页记自己的图种与通道清单，左列的选择器改的是「当前页」的图种，
  // 右键图表本体弹出勾选菜单。渠道通道清单为 null 时跟随全局显隐，所以只用一个图页的
  // 老用户观感完全不变。
  // ---- P2.1 左栏三段：图页 / 控件 / 通道源（只读映射现有 state，不新增状态） ----
  function renderLeftPanel() {
    const pageHost = ref.lpPageList;
    if (pageHost) {
      const plots = state.plots || [];
      pageHost.innerHTML = plots.map((plot) => {
        const active = plot.id === state.activePlot;
        const def = V.getView ? V.getView(plot.view) : null;
        const label = String(plot.name || '').trim() || (def && def.name) || X.plotLabel(plot);
        // 通道清单为 null = 跟随全局显隐；这时写「全局」比写一个会变的数字更准确
        const meta = plot.channels ? String(X.plotChannels(plot).length) : '全局';
        return '<button class="pagerow lp-page' + (active ? ' active' : '') + '" type="button" data-lp-plot="' + X.esc(plot.id) + '" title="' + X.esc(label) + '">'
          + '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-page"/></svg>'
          + '<span class="lp-name">' + X.esc(label) + '</span>'
          + '<b class="lp-meta">' + X.esc(meta) + '</b></button>';
      }).join('');
      if (ref.lpPageCount) ref.lpPageCount.textContent = String(plots.length);
    }
    const channelHost = ref.lpChannelList;
    const all = X.allChannels();
    if (channelHost) {
      channelHost.innerHTML = all.map((ch) => '<div class="src-row lp-channel" title="' + X.esc(ch.name) + '">'
        + '<i class="lp-dot" style="background:' + X.viewColor(ch.color) + '"></i>'
        + '<span class="lp-name">' + X.esc(ch.name) + '</span>'
        + '<em class="lp-unit">' + X.esc(ch.unit || '') + '</em></div>').join('');
      if (ref.lpChannelCount) ref.lpChannelCount.textContent = String(all.length);
    }
    const widgetCount = document.querySelectorAll('#swList .sw-item').length;
    if (ref.lpWidgetCount) ref.lpWidgetCount.textContent = String(widgetCount);
  }

  function renderPlotTabs() {
    const host = ref.plotTabs;
    if (!host) return;
    const plots = state.plots || [];
    host.innerHTML = plots.map((plot) => {
      const active = plot.id === state.activePlot;
      const def = V.getView ? V.getView(plot.view) : null;
      const label = String(plot.name || '').trim() || (def && def.name) || X.plotLabel(plot);
      const count = X.plotChannels(plot).length;
      return '<button class="plot-tab ptab' + (active ? ' active' : '') + '" data-plot="' + X.esc(plot.id) + '"'
        + ' title="' + X.esc(label + '：显示 ' + count + ' 个通道（双击重命名）') + '">'
        + '<span class="pt-name">' + X.esc(label) + '</span>'
        + '<span class="pt-count">' + count + '</span>'
        + (plots.length > 1 ? '<span class="pt-close" data-plot-close="' + X.esc(plot.id) + '" title="关闭这个图页">×</span>' : '')
        + '</button>';
    }).join('');
    // v43：标签条是一个横向滚动容器，切换/新建后把激活标签滚进视野
    const scroller = document.getElementById('tabsScroll');
    const activeTab = host.querySelector('.ptab.active');
    if (scroller && activeTab) {
      const sr = scroller.getBoundingClientRect();
      const ar = activeTab.getBoundingClientRect();
      if (ar.left < sr.left) scroller.scrollLeft -= (sr.left - ar.left) + 8;
      else if (ar.right > sr.right) scroller.scrollLeft += (ar.right - sr.right) + 8;
    }
    renderLeftPanel();
  }

  function setActivePlot(id) {
    const plot = X.plotById(id);
    if (!plot) return;
    // 切回图页时收起正在显示的详情页（详情标签本身保留）
    if (window.XHGCS_DETAILS) window.XHGCS_DETAILS.dismiss();
    state.activePlot = id;
    X.persist();
    closePlotMenu();
    // 切页从默认视口开始，别把上一页手动平移/缩放过的视野带过来
    if (V.resetChartView) V.resetChartView();
    switchSubView(plot.view);
    renderPlotTabs();
    // 标签条是舞台级的：在输入/告警等一级页点图页标签，要真的切回可视化
    if (document.body.dataset.view !== 'wave') {
      const nav = document.querySelector('#sideNav [data-nav="visual"]');
      if (nav) nav.click();
    }
  }

  function closePlotTab(id) {
    if (!X.removePlot(id)) {
      V.callApp('toast', '至少要留一个图页');
      return;
    }
    const plot = X.activePlot();
    if (plot) switchSubView(plot.view);
    renderPlotTabs();
  }

  function renamePlotTab(id) {
    const plot = X.plotById(id);
    if (!plot) return;
    const next = window.prompt('给这个图页起个名字（留空则按图种自动命名）', plot.name || '');
    if (next === null) return;
    X.updatePlot(id, { name: String(next).trim().slice(0, 20) });
    renderPlotTabs();
  }

  // 勾完通道让当前图立刻重画：各视图的渲染入口不同，统一走插件自己的 update
  function refreshPlotViews() {
    const active = V.activeView ? V.activeView() : null;
    if (active && typeof active.update === 'function') active.update();
    else if (V.renderChart) V.renderChart();
    if (V.renderChartWork) V.renderChartWork(true);
  }

  // 菜单挂在 body 下：玻璃面板带 backdrop-filter，会成为 fixed 定位元素的包含块，
  // 留在面板里会相对面板偏移（图表提示框踩过同一个坑）
  let plotMenu = null;

  function closePlotMenu() {
    if (plotMenu && plotMenu.parentNode) plotMenu.parentNode.removeChild(plotMenu);
    plotMenu = null;
  }

  function openPlotMenu(clientX, clientY) {
    closePlotMenu();
    const plot = X.activePlot();
    if (!plot) return;
    const all = X.allChannels();
    const chosen = X.plotChannels(plot).map((ch) => ch.id);
    const menu = document.createElement('div');
    menu.className = 'plot-menu';

    const head = document.createElement('div');
    head.className = 'pm-head';
    head.textContent = X.plotLabel(plot) + ' · 显示哪些通道';
    menu.appendChild(head);

    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'pm-empty';
      empty.textContent = '还没有任何通道';
      empty.title = '先在右侧「多通道数据」新建通道，或连接串口后应用一个数据引擎';
      menu.appendChild(empty);
    }

    all.forEach((ch) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pm-row' + (chosen.indexOf(ch.id) >= 0 ? ' on' : '');
      const dot = document.createElement('span');
      dot.className = 'pm-dot';
      dot.style.background = X.viewColor(ch.color);
      const name = document.createElement('span');
      name.className = 'pm-name';
      name.textContent = ch.name;
      const unit = document.createElement('span');
      unit.className = 'pm-unit';
      unit.textContent = ch.unit || '';
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(unit);
      row.addEventListener('click', (event) => {
        // 必须挡住冒泡：文档上的「点外面就关」会看到已经被移除的旧菜单，把刚重开的这层关掉
        event.stopPropagation();
        X.togglePlotChannel(plot.id, ch.id);
        refreshPlotViews();
        renderPlotTabs();
        openPlotMenu(clientX, clientY); // 原地重画，勾选状态即时可见
      });
      menu.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'pm-foot';
    const addAct = (text, title, run) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pm-act';
      btn.textContent = text;
      if (title) btn.title = title;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
        closePlotMenu();
        refreshPlotViews();
        renderPlotTabs();
      });
      foot.appendChild(btn);
    };
    addAct('全选', '', () => X.setPlotChannels(plot.id, all.map((ch) => ch.id)));
    addAct('全不选', '', () => X.setPlotChannels(plot.id, []));
    addAct('跟随全局', '不再为这一页单独记通道，回到右侧通道面板的显隐开关', () => X.setPlotChannels(plot.id, null, { follow: true }));
    menu.appendChild(foot);

    document.body.appendChild(menu);
    // 贴边时翻到另一侧，别让菜单跑出窗口
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - rect.height - 6)) + 'px';
    plotMenu = menu;
  }

  function bindPlotTabs() {
    const addBtn = document.getElementById('btnAddPlot');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        setActivePlot(X.addPlot(state.subview).id);
        V.callApp('toast', '已新建图页；在图上右键勾选它要显示的通道');
      });
    }
    if (ref.plotTabs) {
      ref.plotTabs.addEventListener('click', (e) => {
        const close = e.target.closest('[data-plot-close]');
        if (close) {
          e.stopPropagation();
          closePlotTab(close.dataset.plotClose);
          return;
        }
        const tab = e.target.closest('[data-plot]');
        if (tab) setActivePlot(tab.dataset.plot);
      });
      ref.plotTabs.addEventListener('dblclick', (e) => {
        const tab = e.target.closest('[data-plot]');
        if (tab) renamePlotTab(tab.dataset.plot);
      });
    }
    // 右键图表本体也能勾通道 —— 这才是「快速地选定要显示的数据」
    const area = $('.plotwrap, .chart-wrap');
    if (area) {
      area.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPlotMenu(e.clientX, e.clientY);
      });
    }
    // 右键通道卡片也要能弹菜单
    if (ref.chlList) {
      ref.chlList.addEventListener('contextmenu', (e) => {
        const card = e.target.closest && e.target.closest('.chl[data-channel-id]');
        if (!card) return;
        e.preventDefault();
        const ch = X.findChannel(card.dataset.channelId);
        if (ch) openChannelMenu(e.clientX, e.clientY, ch);
      });
    }
    document.addEventListener('click', (e) => {
      if (!plotMenu && !chlMenu) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const inside = (m) => m && (path.indexOf(m) >= 0 || m.contains(e.target));
      if (!inside(plotMenu)) closePlotMenu();
      if (!inside(chlMenu)) closeChannelMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closePlotMenu();
      closeChannelMenu();
    });
    window.addEventListener('resize', () => {
      closePlotMenu();
      closeChannelMenu();
    });
  }

  // ---- 通道卡片右键菜单 ----
  // 脚本通道是「算出来的」，用户在卡片上最想知道的是「它是怎么来的、去画布上看一眼」。
  // 承载沿用 .plot-menu 那一套（挂 body、fixed、贴边翻转、三重关闭）——
  // 卡片自带 backdrop-filter，菜单留在卡片里会相对卡片偏移。
  let chlMenu = null;

  function closeChannelMenu() {
    if (chlMenu && chlMenu.parentNode) chlMenu.parentNode.removeChild(chlMenu);
    chlMenu = null;
  }

  function openChannelMenu(clientX, clientY, ch) {
    closeChannelMenu();
    const A = window.XHGCS_ANALYSIS;
    const GU = window.XHGCS_GRAPH_UI;
    const script = A && A.findScript ? A.findScript(ch.scriptId) : null;
    const isGraph = Boolean(script && script.type === 'graph' && script.graph);
    const liveCanvas = ch.scriptId === 'graph-live';

    const menu = document.createElement('div');
    menu.className = 'plot-menu chl-menu';
    const head = document.createElement('div');
    head.className = 'pm-head';
    head.textContent = ch.name + (script ? ' · 来自「' + script.name + '」' : (liveCanvas ? ' · 来自画布上那次「运行」' : ''));
    menu.appendChild(head);

    const addItem = (label, opts) => {
      const cfg = opts || {};
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pm-row' + (cfg.danger ? ' danger' : '');
      row.textContent = label;
      // 不能执行的直接禁用并把原因写进 title，别让用户按下去只换回一句提示
      if (cfg.disabled) row.disabled = true;
      if (cfg.title) row.title = cfg.title;
      row.addEventListener('click', (event) => {
        // 必须挡住冒泡：文档上「点外面就关」的判定会看到刚被移除的旧菜单，把新弹的这层关掉
        event.stopPropagation();
        closeChannelMenu();
        if (!cfg.disabled && cfg.run) cfg.run();
      });
      menu.appendChild(row);
    };

    addItem('在分析画布中打开', {
      disabled: !isGraph,
      title: isGraph ? '把产出这条通道的节点流程载入画布'
        : (liveCanvas ? '这条通道来自画布上那次「运行」，用下面那项打开画布即可'
          : '产出它的不是节点流程（函数 / Python 脚本），只能在快速公式里查看'),
      run: () => {
        // 顺序有讲究：先把流程载进画布再切页。GRAPH_UI.open() 会按当时的 autoRun
        // 回写「自动运行」勾选框，反过来的话那个勾选框会停在旧值上
        if (GU && GU.loadScript) GU.loadScript(script);
        if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('analysis');
      }
    });

    addItem('打开数据分析画布', {
      title: '不载入具体流程，只切到分析页',
      run: () => {
        if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('analysis');
      }
    });

    if (script) {
      addItem('立即重算一次', {
        title: '用同一个模块重新算一遍这条通道',
        run: () => {
          if (isGraph && GU && GU.runSavedGraph) GU.runSavedGraph(script);
          else if (A && A.runAndAttach) A.runAndAttach(script, script.inputs);
        }
      });
    }

    addItem('定位到告警阈值', {
      disabled: ch.visible === false,
      title: ch.visible === false ? '曲线已隐藏：先用 ≋ 恢复显示' : '在「告警」页找到这条通道的阈值行',
      run: () => {
        if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('alarm');
        if (V.focusAlarmChannel) V.focusAlarmChannel(ch.id);
      }
    });

    addItem(state.chartFocusId === ch.id ? '取消单通道聚焦' : '单独聚焦此曲线', {
      disabled: ch.visible === false,
      title: ch.visible === false ? '先恢复曲线显示再聚焦' : '只画这一条曲线并收起侧栏，看细节更清楚',
      run: () => {
        state.chartFocusId = state.chartFocusId === ch.id ? '' : ch.id;
        if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
        syncChartFocusBadge();
        V.renderChart();
      }
    });

    addItem(ch.visible === false ? '恢复曲线显示' : '隐藏曲线', {
      title: ch.visible === false ? '重新画到波形/柱状图上' : '从波形/柱状图隐藏，通道与数据都保留',
      run: () => {
        ch.visible = !ch.visible;
        if (state.subview === 'wave') V.renderChart();
        if (state.subview === 'bar') V.renderBar();
        X.persist();
        renderChannelCards();
      }
    });

    addItem('通道配置', {
      title: '名称 / 单位 / 倍率 / 量程',
      run: () => openChannelConfig(ch)
    });

    addItem('移除这条通道', {
      danger: true,
      title: '从通道列表移除（不影响已落盘的历史记录）',
      run: () => removeChannel(ch)
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - rect.height - 6)) + 'px';
    chlMenu = menu;
  }

  function registerBuiltins() {
    [
      {
        id: 'wave', name: '波形图', icon: '≋', desc: '多通道实时曲线', order: 10, host: '#chart',
        mount: function () { showPanel('wave'); V.renderChart(); },
        update: function () { V.renderChart(); },
        resize: function () { V.resizeCanvas(ref.chart); V.renderChart(); }
      },
      {
        id: 'bar', name: '柱状图', icon: '▉', desc: '通道幅值对比', order: 20, host: '#barChart',
        mount: function () { showPanel('bar'); V.renderBar(); },
        update: function () { V.renderBar(); },
        resize: function () { V.resizeCanvas(ref.barChart); V.renderBar(); }
      },
      {
        id: 'table', name: '数据表', icon: '▦', desc: '数值列表', order: 30, host: '#tableWrap',
        mount: function () { showPanel('table'); V.renderTable(); },
        update: function () { V.renderTable(); }
      },
      {
        id: 'gauge', name: '仪表', icon: '◔', desc: '量程表盘', order: 40, host: '#gaugeWrap',
        mount: function () { showPanel('gauge'); V.renderGaugeCards(); V.renderGauges(); },
        update: function () { V.renderGauges(); },
        resize: function () { V.renderGauges(); }
      },
      {
        id: 'map', name: '地图', icon: '◈', desc: '航迹与航点', order: 50, host: '#miniMapWrap',
        mount: function () { showPanel('map'); if (V.updateMapButtons) V.updateMapButtons(); V.renderMap(); },
        update: function () { V.renderMap(); },
        resize: function () { V.resizeCanvas(ref.mapCanvas); V.renderMap(); }
      }
    ].forEach(function (def) {
      def.builtin = true;
      V.registerView(def);
    });
  }

  function updateHeadText() {
    // 用户要求去掉解释性小字：底栏只保留 #statusInfo 的规模读数（回归钉住），不再写提示行。
  }

  function refreshAll() {
    renderChannelCards();
    V.renderThresholdRows();
    V.renderSimControls();
    V.renderGaugeCards();
    V.renderAlarmPanel();
    updateHeadText();
  }

  // ===== 工作区详情标签（v43 底座）：图页之外的单例/详情页面开在这个舞台里 =====
  const detailEntries = [];
  let detailActiveId = null;

  function detailScrollIntoView(el) {
    const scroller = document.getElementById('tabsScroll');
    if (!scroller || !el) return;
    const sr = scroller.getBoundingClientRect();
    const ar = el.getBoundingClientRect();
    if (ar.left < sr.left) scroller.scrollLeft -= (sr.left - ar.left) + 8;
    else if (ar.right > sr.right) scroller.scrollLeft += (ar.right - sr.right) + 8;
  }

  function detailRenderTabs() {
    const host = document.getElementById('detailTabs');
    if (!host) return;
    if (!detailEntries.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = detailEntries.map((entry) => (
      '<button type="button" class="dtab' + (entry.id === detailActiveId ? ' active' : '') + '" data-detail="' + X.esc(entry.id) + '" title="' + X.esc(entry.name) + '">'
      + '<span class="dt-name">' + X.esc(entry.name) + '</span>'
      + '<span class="dt-close" data-detail-close="' + X.esc(entry.id) + '" title="关闭">×</span>'
      + '</button>'
    )).join('');
    detailScrollIntoView(host.querySelector('.dtab.active'));
  }

  function detailActivate(id) {
    const entry = detailEntries.find((e) => e.id === id);
    if (!entry) return;
    detailActiveId = id;
    document.body.dataset.detail = id;
    const stage = document.getElementById('detailStage');
    if (stage) {
      stage.hidden = false;
      stage.innerHTML = '';
      entry.render(stage);
    }
    detailRenderTabs();
  }

  function detailDismiss() {
    if (detailActiveId === null) return;
    detailActiveId = null;
    delete document.body.dataset.detail;
    const stage = document.getElementById('detailStage');
    if (stage) {
      stage.hidden = true;
      stage.innerHTML = '';
    }
    detailRenderTabs();
    // 舞台隐藏期间画布尺寸会失效，回到图页后按窗口重算
    window.requestAnimationFrame(() => {
      if (V.resizeAll) V.resizeAll();
    });
  }

  const DETAILS = {
    open(opts) {
      const id = opts && opts.id;
      if (!id) return;
      const existing = detailEntries.find((e) => e.id === id);
      if (existing) {
        if (opts.name) existing.name = opts.name;
        if (opts.render) existing.render = opts.render;
        if (opts.onClose) existing.onClose = opts.onClose;
        detailActivate(id);
        return;
      }
      detailEntries.push({
        id,
        name: opts.name || id,
        render: opts.render || function () {},
        onClose: opts.onClose
      });
      detailActivate(id);
    },
    activate(id) { detailActivate(id); },
    dismiss: detailDismiss,
    close(id) {
      const idx = detailEntries.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const entry = detailEntries[idx];
      detailEntries.splice(idx, 1);
      if (entry.onClose) entry.onClose();
      if (detailActiveId === id) detailDismiss();
      else detailRenderTabs();
    },
    activeId() { return detailActiveId; }
  };
  window.XHGCS_DETAILS = DETAILS;

  function bindDetailTabs() {
    const host = document.getElementById('detailTabs');
    if (!host) return;
    host.addEventListener('click', (e) => {
      const close = e.target.closest('[data-detail-close]');
      if (close) {
        e.stopPropagation();
        DETAILS.close(close.dataset.detailClose);
        return;
      }
      const tab = e.target.closest('[data-detail]');
      if (tab) detailActivate(tab.dataset.detail);
    });
  }
  bindDetailTabs();
  detailRenderTabs();

  V.init = init;
  V.switchChannelTab = switchChannelTab;
  V.switchSubView = switchSubView;
  V.renderChannelVals = renderChannelVals;
  V.dockWindow = dockWindow;
  V.dockAlarmGroups = dockAlarmGroups;
  V.dockAlarmTime = dockAlarmTime;
  V.renderDockAlarmPage = renderDockAlarmPage;
  V.updateDockLink = updateDockLink;
  V.updateDockBadge = updateDockBadge;
  V.renderChannelCards = renderChannelCards;
  V.renderLeftPanel = renderLeftPanel;
  V.refreshAll = refreshAll;
  V.updateHeadText = updateHeadText;
  V.syncChartFocusBadge = syncChartFocusBadge;
  V.resizeAll = function () {
    V.resizeCanvas(ref.chart);
    V.resizeCanvas(ref.barChart);
    V.resizeCanvas(ref.mapCanvas);
    V.resizeCanvas(ref.alarmChart);
    if (V.renderAlarmChart) V.renderAlarmChart();
    if (V.renderChartWork) V.renderChartWork(true);
  };
})();
