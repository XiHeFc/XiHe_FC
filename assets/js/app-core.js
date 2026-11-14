(function () {
  'use strict';
  const X = window.XHGCS;
  const S = window.XHGCS_SERIAL || {};
  const V = window.XHGCS_VIEWS;
  const state = X.state;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const APP = window.XHGCS_APP = {};
  // 浮层从高到低排：Esc 只作用于最上面那一层，避免一次把两层都关掉
  const OVERLAY_STACK = ['settingsModal', 'viewModal', 'chlModal'];
  APP.topOverlay = function () {
    for (let i = 0; i < OVERLAY_STACK.length; i += 1) {
      const el = document.getElementById(OVERLAY_STACK[i]);
      if (el && !el.classList.contains('hidden')) return OVERLAY_STACK[i];
    }
    return '';
  };

  const refs = {};
  let lastLogCount = 0;
  let lastStatsAt = 0;
  let lastTableAt = 0;
  let lastRateAt = performance.now();
  let lastRateFrames = 0;
  let toastTimer = 0;
  let lastFrameTs = performance.now();
  let sampleAcc = 0;
  let lastChannelValsAt = 0;
  let lastChartAt = 0;
  let lastLogAt = 0;
  let lastBarAt = 0;
  let lastGaugeAt = 0;
  let lastMapAt = 0;

  function init() {
    Object.assign(refs, {
      sideNav: $('#sideNav'),
      serialPanel: $('#serialPanel'),
      serialBody: $('#serialBody'),
      btnCollapseLog: $('#btnCollapseLog'),
      sourceText: $('#sourceText'),
      clockText: $('#clockText'),
      btnSimToggle: $('#btnSimToggle'),
      btnSimHeaderToggle: $('#btnSimHeaderToggle'),
      btnSelectPort: $('#btnSelectPort'),
      btnApplySignal: $('#btnApplySignal'),
      btnFaultHigh: $('#btnFaultHigh'),
      btnFaultDrop: $('#btnFaultDrop'),
      btnFaultNoise: $('#btnFaultNoise'),
      btnEnableCruise: $('#btnEnableCruise'),
      alarmBadge: $('#alarmBadge'),
      toast: $('#toast'),
      btnStake: $('#btnStake'),
      btnGrid: $('#btnGrid'),
      btnChartScale: $('#btnChartScale'),
      btnZoom: $('#btnZoom'),
      btnRecenter: $('#btnRecenter'),
      btnResetView: $('#btnResetView'),
      btnPlay: $('#btnPlay'),
      btnMapPlay: $('#btnMapPlay'),
      btnSerial: $('#btnSerial'),
      btnAutoScroll: $('#btnAutoScroll'),
      btnClearLog: $('#btnClearLog'),
      btnConnect: $('#btnConnect'),
      btnCommClearStats: $('#btnCommClearStats'),
      btnSendCmd: $('#btnSendCmd'),
      cmdInput: $('#cmdInput'),
      cmdTypeSelect: $('#cmdTypeSelect'),
      portSelect: $('#portSelect'),
      baudSelect: $('#baudSelect'),
      dataBitsSelect: $('#dataBitsSelect'),
      paritySelect: $('#paritySelect'),
      btnOpenSerialPanel: $('#btnOpenSerialPanel'),
      statFrames: $('#statFrames'),
      statRxBytes: $('#statRxBytes'),
      statTxBytes: $('#statTxBytes'),
      statErrors: $('#statErrors'),
      statBreaks: $('#statBreaks'),
      simFrames: $('#simFrames'),
      simRate: $('#simRate'),
      simDuration: $('#simDuration'),
      simStats: $('#simStats'),
      btnResetData: $('#btnResetData'),
      serialStateText: $('#serialStateText'),
      serialDiagApp: $('#setSerialDiagApp'),
      serialDiagWin: $('#setSerialDiagWin'),
      serialDiagNote: $('#setSerialDiagNote'),
      btnSerialDiagScan: $('#btnSerialDiagScan'),
      btnChartLog: $('#btnChartLog'),
    });

    V.init();
    syncPlotToggleButtons();
    syncBaudSelects();
    syncSerialSettings();
    updatePlayButtons();
    updateAlarmBadge();
    updateHeader();
    updateCommStats();
    updateSimStats();
    // 一次性提示：这份存档带着旧版本自动生成的预警阈值（迁移已经清掉能识别的那些）。
    // 剩下的对不上公式、没法自动判定，把用户引到告警页那个一键重置上
    if (state.thresholdsNotice) {
      state.thresholdsNotice = false;
      X.persist();
      toast('已清掉旧版本自动生成的预警阈值；告警页的「全部清空」可一键重置剩下的');
    }
    updateSerialDiag();
    $('#btnOpenSerialPanel').addEventListener('click', toggleSerialPanel);
    // 面板自己的表头上也要能收起来：那个按钮原来只在「串口」页，而日志面板在「可视化」页
    // 同样常驻，想让它让出高度还得先切到串口页再点
    if (refs.btnCollapseLog) refs.btnCollapseLog.addEventListener('click', toggleSerialPanel);
    syncSerialPanelButton();
    window.addEventListener('xhgcs:serial-changed', () => {
      updatePortInfo();
      updateConnection();
      updateSerialButton();
      updateSerialState();
    });
    // 串口链路自己报出来的状态（BREAK、重连、收到数据）直接说给用户听：
    // 以前这些只进日志，界面上看到的还是那句「已连接」，等于把故障藏起来。
    window.addEventListener('xhgcs:serial-notice', (event) => {
      const detail = event.detail || {};
      if (detail.message) toast(detail.message);
      updateSerialState();
    });
    // v43：冻结视图状态变化（拖/缩到右端等路径自动解冻）时同步顶部暂停按钮
    window.addEventListener('xhgcs:chart-freeze-changed', updatePlayButtons);

    refs.sideNav.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { navigate(nav.dataset.nav); return; }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      handleAction(action.dataset.action);
    });
    // 串口页并入「输入」后不再有独立 rail 入口，指令台留在输入页头
    const serialConsoleBtn = $('#btnOpenSerialConsole');
    if (serialConsoleBtn) serialConsoleBtn.addEventListener('click', () => navigate('serial'));
    // .topmenu 已移进 #sideNav：sideNav 的委托已经处理 data-action，这里再绑一次会双重触发（设置弹层开两次）
    const topMenu = $('.topmenu');
    if (topMenu && !refs.sideNav.contains(topMenu)) {
      topMenu.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]');
        if (action) handleAction(action.dataset.action);
      });
    }
    if (refs.btnChartLog) refs.btnChartLog.addEventListener('click', toggleSerialPanel);

    refs.btnSerial.addEventListener('click', () => {
      // 能不能接收统一由 updateSerialButton() 说了算：不能接收时按钮是 disabled 的，
      // 不该再让用户按下去只换回一句「先去关仿真」——那种状态胶囊长得像操作按钮就是在骗点击
      if (refs.btnSerial.disabled) return;
      state.serial.running = !state.serial.running;
      updateSerialButton();
      toast(state.serial.running ? '已开启数据接收' : '已停止数据接收');
    });
    if (refs.serialBody) {
      // 单行省略时点一行展开全文（只切 class，不重建/不截断数据）
      refs.serialBody.addEventListener('click', (event) => {
        const line = event.target.closest('.line');
        if (line && refs.serialBody.contains(line)) line.classList.toggle('expanded');
      });
    }
    refs.btnAutoScroll.addEventListener('click', () => {
      state.serial.autoScroll = !state.serial.autoScroll;
      refs.btnAutoScroll.textContent = '自动滚动：' + (state.serial.autoScroll ? '开' : '关');
      // autoScroll 在 persist() 的字段表里、启动也会读回，只有这条点击路径忘了存
      X.persist();
    });
    refs.btnClearLog.addEventListener('click', () => {
      X.clearLogs();
      lastLogCount = 0;
      refs.serialBody.innerHTML = '';
    });
    refs.btnConnect.addEventListener('click', async () => {
      if (state.serial.connected) {
        await S.disconnect();
        updateConnection();
        updateSerialButton();
        toast('真实串口已断开');
        return;
      }
      try {
        await S.connect();
        updateSimulationUI();
        updateConnection();
        updateSerialButton();
        toast('串口已打开，等待数据…');
      } catch (err) {
        toast('串口连接失败：' + (err && err.message || '未知错误'));
      }
    });
    refs.btnSelectPort.addEventListener('click', async () => {
      try {
        await S.selectPort();
        updatePortInfo();
        toast('已选择串口设备：' + state.serial.port);
      } catch (err) {
        toast('选择串口失败：' + (err && err.message || '未知错误'));
      }
    });
    refs.btnSimToggle.addEventListener('click', toggleSimulation);
    refs.btnSimHeaderToggle.addEventListener('click', toggleSimulation);
    // 顶栏 KPI 点击 → 可视化并聚焦对应通道
    [['tvH', 'm'], ['tvV', 'V'], ['tvA', 'A']].forEach((pair) => {
      const el = document.getElementById(pair[0]);
      if (!el) return;
      el.closest('.tele-cell').addEventListener('click', () => {
        navigate('visual');
        const all = window.XHGCS.allChannels ? window.XHGCS.allChannels() : [];
        const list = all.filter((ch) => String(ch.unit || '') === pair[1]);
        const ch = pair[1] === 'm' ? (list.find((item) => /高度/.test(item.name || '')) || list[0]) : list[0];
        if (!ch) return;
        state.chartFocusId = ch.id;
        if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
        if (window.XHGCS_VIEWS) {
          window.XHGCS_VIEWS.syncChartFocusBadge && window.XHGCS_VIEWS.syncChartFocusBadge();
          window.XHGCS_VIEWS.renderChart && window.XHGCS_VIEWS.renderChart();
        }
      });
    });
    // 顶栏主题切换按钮（新骨架 #btnTheme）：在玻璃/墨 ink 两套之间切深浅
    const themeBtn = document.getElementById('btnTheme');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        if (window.XHGCS.setTheme) window.XHGCS.setTheme(next);
      });
    }
    // 新壳：顶栏 AI 入口与遥测格跳转（骨架阶段先接到现有页面，B1b-2 再加缓冲/录制的真实数据源）
    const btnAiDrawer = $('#btnAiDrawer');
    if (btnAiDrawer) btnAiDrawer.addEventListener('click', () => handleAction('ai'));
    const dockToggle = $('#statusbarDockToggle');
    if (dockToggle) {
      dockToggle.addEventListener('click', () => {
        if (window.XHGCS_LAYOUT) window.XHGCS_LAYOUT.toggle('data');
      });
      const syncDockToggle = () => {
        const open = window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.isDockOpen ? window.XHGCS_LAYOUT.isDockOpen() : false;
        const aiOpen = window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.isAiDrawerOpen ? window.XHGCS_LAYOUT.isAiDrawerOpen() : false;
        dockToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
        dockToggle.setAttribute('aria-disabled', aiOpen ? 'true' : 'false');
        dockToggle.disabled = aiOpen;
        dockToggle.title = aiOpen ? 'AI 展开时数据面板固定为读数轨' : (open ? '收起' : '展开') + '数据面板（Alt+2）';
      };
      window.addEventListener('xhgcs:layout-changed', syncDockToggle);
      syncDockToggle();
    }
    $$('[data-telemetry-cell]').forEach((cell) => {
      const key = cell.dataset.telemetryCell;
      if (key === 'frames' || key === 'errors') cell.addEventListener('click', () => navigate('serial'));
      else if (key === 'buffer') cell.addEventListener('click', openPipelinePanel);      else if (key === 'record') cell.addEventListener('click', () => {
        const app = window.XHGCS_APP;
        if (app && typeof app.openSettings === 'function') app.openSettings('record');
        else handleAction('settings');
      });
    });
    refs.btnCommClearStats.addEventListener('click', clearCommStats);
    if (refs.btnSerialDiagScan) refs.btnSerialDiagScan.addEventListener('click', updateSerialDiag);
    refs.btnSendCmd.addEventListener('click', sendCommand);
    refs.cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCommand(); });

    refs.portSelect.addEventListener('change', () => {
      state.serial.port = refs.portSelect.value;
      X.persist();
      updateHeader();
    });
    refs.baudSelect.addEventListener('change', () => {
      state.serial.baud = Number(refs.baudSelect.value);
      X.persist();
      updateHeader();
    });
    refs.dataBitsSelect.addEventListener('change', () => {
      state.serial.dataBits = Number(refs.dataBitsSelect.value);
      X.persist();
    });
    refs.paritySelect.addEventListener('change', () => {
      state.serial.parity = refs.paritySelect.value;
      X.persist();
    });

    refs.btnStake.addEventListener('click', () => {
      state.showStake = !state.showStake;
      syncPlotToggleButtons();
      // 设置面板里的同名开关会落盘、启动时也会读回，工具栏这条路径原来漏了 persist()
      X.persist();
      V.renderChart();
    });
    refs.btnGrid.addEventListener('click', () => {
      state.showGrid = !state.showGrid;
      syncPlotToggleButtons();
      X.persist();
      V.renderChart();
    });
    refs.btnChartScale.addEventListener('click', () => {
      const order = ['auto', 'normalize', 'overlay'];
      const index = order.indexOf(state.chartScaleMode);
      state.chartScaleMode = order[(index + 1) % order.length];
      syncPlotToggleButtons();
      X.persist();
      V.renderChart();
    });
    refs.btnZoom.addEventListener('click', () => {
      state.zoomMode = state.zoomMode === 'fit' ? 'fixed' : 'fit';
      syncPlotToggleButtons();
      if (V.resetChartView) V.resetChartView();
      V.renderChart();
    });
    refs.btnRecenter.addEventListener('click', () => {
      if (V.recenterChartView) V.recenterChartView();
    });
    refs.btnResetView.addEventListener('click', () => {
      if (V.resetChartView) V.resetChartView();
    });
    refs.btnPlay.addEventListener('click', togglePlay);
    refs.btnMapPlay.addEventListener('click', togglePlay);

    document.addEventListener('keydown', (e) => {
      // Esc 先判：焦点在输入框里也要能退出当前浮层（只有 Space 需要避开输入框）
      if (e.key === 'Escape' && !e.isComposing) {
        // 新式浮层（命令面板/扩展/设计器/看板…）在上层时让位：它们由统一浮层栈处理，
        // 老代码再关一次就会「一次 Esc 退两层」。
        if (window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth() > 0) return;
        if (APP.topOverlay() === 'settingsModal') APP.closeSettings();
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) return;
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePlay(); }
      // 视图直达：Alt+1/5/6/7/8（2/3 留给 Dock，4 留给日志）
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const map = { '1': 'visual', '5': 'input', '6': 'serial', '7': 'alarm', '8': 'sim' };
        const target = map[e.key];
        if (target) { e.preventDefault(); navigate(target); return; }
      }
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); APP.exportConfig(); }
    });

    // 空态三条出路
    Array.from(document.querySelectorAll('[data-empty-action]')).forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.emptyAction;
        if (action === 'sim') navigate('sim');
        else if (action === 'serial') navigate('serial');
        else if (action === 'protocol') navigate('input');
        else if (action === 'select-port' && refs.btnSelectPort) refs.btnSelectPort.click();
      });
    });

    requestAnimationFrame(loop);
  }

  function handleAction(name) {
    if (name === 'settings') APP.openSettings();
    if (name === 'export') APP.exportConfig();
    if (name === 'ai') {
      // AI 入口唯一到抽屉：顶栏按钮 / 左栏 AI / Ctrl+I 都是同一个开合（ai-ui.js 负责抽屉本体）
      const toggleDrawer = () => {
        if (window.XHGCS_AI_UI && typeof window.XHGCS_AI_UI.toggleDrawer === 'function') window.XHGCS_AI_UI.toggleDrawer();
        else if (window.XHGCS_LAYOUT) window.XHGCS_LAYOUT.open('ai');
      };
      if (!window.XHGCS_AI_UI && window.XHGCS_LOADER) window.XHGCS_LOADER.ensure('aiUi').then(toggleDrawer);
      else toggleDrawer();
    }
    if (name === 'help') {
      // 桌面版把原来的「帮助 → 关于」搬到这里；浏览器模式仍用提示条
      if (window.XHGCS_DESKTOP && typeof window.XHGCS_DESKTOP.about === 'function') window.XHGCS_DESKTOP.about();
      else toast('当前版本已支持 Web Serial 真实串口、仿真数据源开关、波形分析、AI、脚本与 MCP 桥。');
    }
  }

  // 所有图表视图（波形/柱状图/数据表/仪表/地图/自定义视图）都挂在 #view-wave 页上：
  // 左侧图标栏只保留「可视化」入口，具体子视图由可视化面板切换
  function isVisualView(id) {
    if (id === 'visual') return true;
    return Boolean(V.getView && V.getView(id));
  }

  function navigate(view) {
    // 一级页导航优先：正在显示的详情页先收起（标签保留在标签条里）
    if (window.XHGCS_DETAILS) window.XHGCS_DETAILS.dismiss();
    const visual = isVisualView(view);
    const targetView = visual ? 'wave' : view;
    state.view = targetView;
    document.body.dataset.view = targetView;
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.rememberView) window.XHGCS_LAYOUT.rememberView(targetView);
    $$('.view').forEach((el) => {
      const active = el.id === 'view-' + targetView;
      el.classList.toggle('active', active);
      el.classList.toggle('hidden', !active);
    });
    const railKey = visual ? 'visual' : view;
    refs.sideNav.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === railKey);
    });
    // 折叠成纯图标时 aria-current 是唯一能说明「当前在哪一页」的无障碍信号
    refs.sideNav.querySelectorAll('.rail-btn, .tool').forEach((el) => {
      if (el.classList.contains('active')) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    if (visual) {
      // 「可视化」入口保留上次的子视图，来回切页时不跳回波形
      const keepSub = state.subview;
      if (view === 'visual' && keepSub && V.getView && V.getView(keepSub)) V.switchSubView(keepSub);
      else V.switchSubView(view === 'visual' ? 'wave' : view);
    }
    if (view === 'serial') { syncSerialSettings(); updateCommStats(); }
    if (view === 'alarm') V.renderAlarmPanel();
    if (view === 'input' && window.XHGCS_ENGINE_UI) {
      window.XHGCS_ENGINE_UI.renderList();
      window.XHGCS_ENGINE_UI.renderPresets();
    }
    if (view === 'sim') { V.renderSimControls(); updateSimStats(); updateSimulationUI(); }
    // 分析画布是一级视图：切到它时渲染一遍（onShow 只渲染，不再自己切页，避免递归）
    if (view === 'analysis' && window.XHGCS_ANALYSIS_UI && window.XHGCS_ANALYSIS_UI.onShow) window.XHGCS_ANALYSIS_UI.onShow();
    // 串口页：日志是主区（≥60% 高度），进来就展开并拉够高度；其它页沿用原逻辑
    if (targetView === 'serial' && window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.setSerialOpen) {
      const wanted = Math.round((window.innerHeight - 44 - 24) * 0.66);
      if (!window.XHGCS_LAYOUT.serialOpen || window.XHGCS_LAYOUT.serialHeight() < wanted) {
        window.XHGCS_LAYOUT.setSerialOpen(true);
        window.XHGCS_LAYOUT.setSerialHeight(wanted);
      }
    }
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.syncSerialForView) {
      window.XHGCS_LAYOUT.syncSerialForView(view === 'visual' ? 'wave' : targetView);
    } else {
      const showSerial = targetView === 'wave' || view === 'serial';
      refs.serialPanel.classList.toggle('hidden', !showSerial);
    }
    syncSerialPanelButton();
    updatePlayButtons();
  }

  function togglePlay() {
    const V = window.XHGCS_VIEWS;
    if (!V || !V.freezeChart) {
      state.playing = !state.playing;
      updatePlayButtons();
      toast(state.playing ? '数据采集已恢复' : '数据采集已暂停');
      return;
    }
    // v43：暂停 = 冻结查看。数据来源不动（串口继续接收、仿真继续推进），停止接收由串口开关负责
    const frozen = V.isChartFrozen && V.isChartFrozen();
    V.freezeChart(!frozen);
    updatePlayButtons();
    toast(frozen ? '视图已回到现在 · 数据继续接收' : '已暂停视图 · 数据仍在接收');
  }

  function updatePlayButtons() {
    const frozen = window.XHGCS_VIEWS && window.XHGCS_VIEWS.isChartFrozen ? window.XHGCS_VIEWS.isChartFrozen() : !state.playing;
    if (refs.btnPlay) {
      refs.btnPlay.title = frozen ? '继续实时数据' : '暂停视图（数据继续接收）';
      refs.btnPlay.setAttribute('aria-label', frozen ? '播放' : '暂停');
      refs.btnPlay.setAttribute('aria-pressed', frozen ? 'true' : 'false');
      const use = refs.btnPlay.querySelector('use');
      if (use) use.setAttribute('href', frozen ? '#i-play' : '#i-pause');
    }
    const label = state.playing ? '▶ 暂停' : '▶ 播放';
    if (refs.btnMapPlay) refs.btnMapPlay.textContent = label;
  }

  function updateAlarmBadge() {
    const active = state.alarms.filter((a) => !a.ack).length;
    const text = active > 99 ? '99+' : String(active);
    // 统计 tick 每 300ms 也会调它一次，值没变就别写 DOM
    if (refs.alarmBadge.textContent !== text) refs.alarmBadge.textContent = text;
    refs.alarmBadge.classList.toggle('hidden', active === 0);
  }

  function updatePortInfo() {
    if (refs.portSelect) refs.portSelect.value = state.serial.port || '未选择';
  }

  function updateSimulationUI() {
    const enabled = Boolean(state.simulation && state.simulation.enabled);
    renderSourceChip();
    if (refs.btnSimToggle) {
      refs.btnSimToggle.textContent = enabled ? '关闭仿真' : '开启仿真';
      refs.btnSimToggle.classList.toggle('primary', enabled);
    }
    const disable = !enabled;
    [refs.btnApplySignal, refs.btnFaultHigh, refs.btnFaultDrop, refs.btnFaultNoise, refs.btnEnableCruise].forEach((btn) => {
      if (btn) btn.disabled = disable;
    });
  }

  async function toggleSimulation() {
    const enabled = !state.simulation.enabled;
    if (enabled && state.serial.connected && S && typeof S.disconnect === 'function') {
      try { await S.disconnect(); } catch (err) {}
    }
    const value = X.setSimulationEnabled(enabled);
    updateSimulationUI();
    updateConnection();
    updateSerialButton();
    toast(value ? '已开启仿真数据源' : '已关闭仿真数据源，请在串口页连接真实设备');
  }

  // 顶部数据源胶囊：把原来「仿真：开 + 桌面版 + 仿真数据 + 10 Hz」四枚压成一枚。
  // 仿真和它的采样率、串口和它的波特率本来就是同一件事的两半，分开写就是在同一行里说两遍；
  // 状态点也不再单独占一枚，直接坐在胶囊里。点击仍然切换仿真 / 真实串口。
  function renderSourceChip() {
    const chip = refs.btnSimHeaderToggle;
    if (!chip) return;
    const sim = Boolean(state.simulation && state.simulation.enabled);
    const connected = Boolean(state.serial.connected);
    const text = refs.sourceText || chip;
    const nominalHz = Math.round(1000 / Math.max(1, Number(state.intervalMs) || 100));
    chip.classList.toggle('on', sim || connected);
    chip.classList.toggle('off', !sim && !connected);
    if (sim) {
      text.textContent = '仿真数据 · ' + nominalHz + ' Hz';
      chip.title = '当前数据源：仿真（' + nominalHz + ' Hz）· 点击切到真实串口';
    } else if (connected) {
      // 端口打开 ≠ 有数据：BREAK 或线路低电平时端口是开的、帧数是 0，写成「接收中」就是在骗人
      const link = !state.serial.running ? ' · 已停止' : (state.serial.receiving ? ' · 接收中' : ' · 等数据');
      // 实测速率必须露出来：设备到底按几 Hz 送数只有这里能看出来。采样间隔是「界面里配的值」，
      // 和真实速率差一个数量级时（实测有过配 10Hz 实际 1Hz）用户完全无从察觉
      const actualHz = state.serial.receiving && Number(state.serial.rate) > 0 ? ' · ' + state.serial.rate + ' Hz' : '';
      text.textContent = state.serial.port + ' · ' + state.serial.baud + actualHz + link;
      chip.title = '当前数据源：真实串口 ' + state.serial.port
        + '（实测 ' + (Number(state.serial.rate) || 0) + ' Hz，采样间隔设置为 '
        + (Number(state.intervalMs) || 100) + 'ms ≈ ' + nominalHz + ' Hz）· 点击切回仿真';
    } else {
      text.textContent = '未连接数据源';
      chip.title = '点击开启仿真，或在「串口」页连接真实设备';
    }
  }

  function updateConnection() {
    const sim = Boolean(state.simulation && state.simulation.enabled);
    const active = sim || state.serial.connected;
    renderSourceChip();
    refs.btnConnect.textContent = state.serial.connected ? '断开串口' : (sim ? '连接真实串口' : '连接串口');
  }

  function updateSerialButton() {
    const ready = state.serial.connected && !state.simulation.enabled;
    refs.btnSerial.textContent = ready ? (state.serial.running ? '停止接收' : '开始接收') : '未连接';
    refs.btnSerial.classList.toggle('run', ready && state.serial.running);
    refs.btnSerial.disabled = !ready;
    refs.btnSerial.title = ready
      ? (state.serial.running ? '暂停接收串口数据' : '开始接收串口数据')
      : (state.simulation.enabled ? '仿真开启中：先在「模拟」页关闭仿真，再连接真实串口' : '先在「串口」页连接真实串口');
  }

  // 波特率只有一个来源：串口页和设置面板两个下拉都从这张表填，改一处就够（原来两处各写 5 项，
  // 还缺 57600 / 230400 / 460800 —— 用这些速率的设备在界面上根本选不出来）。
  const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  // 恢复出来的值不在表里（导入的配置、手改过的配置）就补进选项 —— 否则 select.value 落空，
  // 界面上是一个空白下拉框，底层却还在用那个波特率连设备。
  function fillBaudOptions(select) {
    if (!select) return;
    const value = String(state.serial.baud || '');
    const list = BAUD_RATES.slice();
    if (value && Number(value) > 0 && !list.some((rate) => String(rate) === value)) list.push(Number(value));
    list.sort((a, b) => a - b);
    select.innerHTML = list.map((rate) => '<option value="' + rate + '">' + rate + '</option>').join('');
  }
  function syncBaudSelects() {
    fillBaudOptions(refs.baudSelect);
    fillBaudOptions($('#setBaud'));
  }

  function syncSerialSettings() {
    updatePortInfo();
    refs.baudSelect.value = String(state.serial.baud);
    refs.dataBitsSelect.value = String(state.serial.dataBits);
    refs.paritySelect.value = String(state.serial.parity);
    updateConnection();
    updateSerialButton();
    updateSimulationUI();
    refs.btnAutoScroll.textContent = '自动滚动：' + (state.serial.autoScroll ? '开' : '关');
  }

  function clearCommStats() {
    state.serial.frames = 0;
    state.serial.rxBytes = 0;
    state.serial.txBytes = 0;
    state.serial.errors = 0;
    state.serial.breaks = 0;
    state.serial.lastError = '';
    lastRateFrames = 0;
    lastRateAt = performance.now();
    updateCommStats();
    toast('通信统计已清零');
  }

  async function sendCommand() {
    const raw = refs.cmdInput.value.trim();
    if (!raw) { toast('请输入指令内容'); return; }
    const type = refs.cmdTypeSelect.value;
    let cmd = raw;
    if (!cmd.toUpperCase().startsWith(type) && type !== 'AT') cmd = type + ':' + raw;
    let result = null;
    if (state.serial.connected && !state.simulation.enabled && S && typeof S.sendCommand === 'function') {
      try {
        result = await S.sendCommand(cmd);
        toast('指令已发送到真实串口');
      } catch (err) {
        toast('发送失败：' + (err && err.message || '未知错误'));
        return;
      }
    } else {
      result = X.handleCommand(cmd);
    }
    if (result.type === 'rtl') { state.cruise = false; state.homeMode = true; V.updateMapButtons(); updateAlarmBadge(); }
    if (result.type === 'waypoint') V.renderMap();
    lastLogCount = 0;
    syncLogs();
    updateCommStats();
    setTimeout(() => {
      lastLogCount = 0;
      syncLogs();
      updateCommStats();
    }, 90);
  }

  function syncLogs() {
    const logs = state.logs;
    if (logs.length < lastLogCount) {
      refs.serialBody.innerHTML = '';
      lastLogCount = 0;
    }
    const fresh = logs.slice(lastLogCount);
    fresh.forEach((entry) => {
      const line = document.createElement('div');
      const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
      const kind = String(entry.kind || 'rx').toLowerCase();
      // 字节数列只做展示：按当前文本 UTF-8 长度算，不动底层缓存与串口计数
      let bytes = String(entry.text || '').length;
      try { bytes = new TextEncoder().encode(String(entry.text || '')).length; } catch (err) { /* 老环境没有 TextEncoder 时退回字符数 */ }
      // 类名写死一张表：audit 静态扫描能看到，别用字符串拼
      const KIND_CLASS = { rx: 'line-rx', tx: 'line-tx', warn: 'line-warn', err: 'line-err', sys: 'line-sys' };
      line.className = 'line ' + (KIND_CLASS[kind] || 'line-sys');
      line.title = String(entry.text || '');
      line.innerHTML = '<span class="ts">[' + X.esc(time) + ']</span>'
        + '<span class="kind">' + X.esc(kind.toUpperCase()) + '</span>'
        + '<span class="bytes">' + bytes + ' B</span>'
        + '<span class="msg">' + X.esc(entry.text) + '</span>';
      refs.serialBody.appendChild(line);
      if (refs.serialBody.children.length > 300) refs.serialBody.removeChild(refs.serialBody.firstChild);
    });
    lastLogCount = logs.length;
    if (state.serial.autoScroll) refs.serialBody.scrollTop = refs.serialBody.scrollHeight;
  }

  function updateCommStats() {
    X.setCounter(refs.statFrames, state.serial.frames);
    X.setCounter(refs.statRxBytes, state.serial.rxBytes);
    X.setCounter(refs.statTxBytes, state.serial.txBytes);
    X.setCounter(refs.statErrors, state.serial.errors);
    X.setCounter(refs.statBreaks, state.serial.breaks);
    updateSerialState();
  }

  // 串口面板的状态行：把「端口开着」和「真的有数据」分开说，这轮故障里两者混为一谈正是
  // 用户看到「说连上了却没数据」的原因。
  function updateSerialState() {
    const el = refs.serialStateText;
    if (!el) return;
    let text = '未连接';
    let level = 'off';
    if (state.serial.connected) {
      if (!state.serial.running) { text = '已打开 · 接收已停止'; level = 'warn'; }
      else if (state.serial.receiving) { text = '接收中'; level = 'ok'; }
      else { text = '已打开 · 还没收到有效数据'; level = 'warn'; }
    }
    if (state.serial.breaks) text += ' · 线路中断 ' + state.serial.breaks + ' 次';
    el.textContent = text;
    el.classList.toggle('ok', level === 'ok');
    el.classList.toggle('warn', level === 'warn');
  }

  // 设置 → 采集与串口 的诊断卡片：把「应用枚举到几个」和「Windows 认到几个」摆在一起。
  // 两边都空 = 设备/驱动；Windows 有而应用空 = 应用枚举异常；只差个别 = 列出差集。
  async function updateSerialDiag() {
    const appEl = refs.serialDiagApp;
    const winEl = refs.serialDiagWin;
    const noteEl = refs.serialDiagNote;
    if (!appEl || !winEl || !noteEl) return;
    noteEl.textContent = '正在读取…';
    let appPorts = [];
    try {
      appPorts = navigator.serial && navigator.serial.getPorts ? await navigator.serial.getPorts() : [];
    } catch (err) { appPorts = []; }
    const appNames = appPorts.map((port, index) => {
      let info = {};
      try { info = port.getInfo ? port.getInfo() : {}; } catch (err) { info = {}; }
      const ids = info && (info.usbVendorId || info.usbProductId) ? '（VID:' + info.usbVendorId + ' PID:' + info.usbProductId + '）' : '';
      return '设备 ' + (index + 1) + ids;
    });
    appEl.value = appNames.length ? appNames.join('、') : '0 个';
    const api = window.XHGCS_DESKTOP;
    let winNames = null;
    if (api && api.isDesktop && api.serial && api.serial.winList) {
      try {
        const res = await api.serial.winList();
        winNames = res && res.ok ? (res.ports || []) : null;
      } catch (err) { winNames = null; }
    }
    if (winNames === null) { winEl.value = '—'; winEl.title = '仅桌面版可查'; }
    else { winEl.value = winNames.length ? winNames.join('、') : '0 个'; winEl.title = ''; }
    noteEl.textContent = serialDiagNote(appNames.length, winNames);
  }

  function serialDiagNote(appCount, winNames) {
    const tail = state.serial.breaks ? ' 累计线路中断 ' + state.serial.breaks + ' 次。' : '';
    if (winNames === null) {
      return appCount ? '应用枚举到 ' + appCount + ' 个设备。' + tail : '应用没有枚举到串口设备：检查 USB 连接、驱动与供电。';
    }
    const winCount = winNames.length;
    if (!appCount && !winCount) return '系统和应用都没有检测到串口：检查 USB 线、驱动（CH340 / FTDI）与设备供电。';
    if (!appCount && winCount) return 'Windows 检测到 ' + winCount + ' 个串口，但应用没有枚举到：点「重新扫描」，仍为空就重启应用。';
    if (appCount && !winCount) return '应用枚举到 ' + appCount + ' 个设备，但系统没有可用的 COM 口：多半是驱动没装好。';
    return '应用枚举到 ' + appCount + ' 个设备，系统报告 ' + winCount + ' 个 COM 口。' + tail;
  }

  function updateSimStats() {
    // 三项必须是互不相同、且都在动的数：采集帧 / 实际速率 / 时间轴长度。
    // 没开始采集时整行收起，不摆一排 0（对空状态来说 0 帧、0 Hz、0% 什么也没说）。
    const frames = state.serial.frames;
    const active = frames > 0;
    if (refs.simStats) refs.simStats.classList.toggle('hidden', !active);
    if (refs.btnResetData) {
      refs.btnResetData.disabled = !active;
      refs.btnResetData.title = active ? '清空通道数据、告警与统计' : '当前没有可清空的数据';
    }
    if (!active) return;
    X.setCounter(refs.simFrames, frames);
    X.setCounter(refs.simRate, state.serial.rate);
    // 时长用 state.t（和波形图 X 轴同一个数），别另算一个「内存点数」——那就是采集帧
    const el = refs.simDuration;
    if (el) {
      const total = Math.max(0, Math.round(state.t));
      const text = (total >= 3600 ? Math.floor(total / 3600) + ':' + String(Math.floor(total / 60) % 60).padStart(2, '0') : String(Math.floor(total / 60))) + ':' + String(total % 60).padStart(2, '0');
      if (el.textContent !== text) el.textContent = text;
      const len = String(text.length);
      if (el.dataset.len !== len) el.dataset.len = len;
    }
  }

  // 工具栏三个绘图开关的文字只有一个来源：HTML 里写死的是「网格：开 / 标桩：显示 / 缩放：自适应」，
  // 而状态是有持久化的，重启后就会出现「按钮写着开、实际是关」的错位（和通道页签高亮同一个坑）。
  function syncPlotToggleButtons() {
    if (refs.btnStake) refs.btnStake.textContent = '标桩：' + (state.showStake ? '显示' : '隐藏');
    if (refs.btnGrid) refs.btnGrid.textContent = '网格：' + (state.showGrid ? '开' : '关');
    if (refs.btnChartScale) {
      const scaleLabel = { auto: '自动', normalize: '归一化', overlay: '统一' };
      refs.btnChartScale.textContent = 'Y轴：' + (scaleLabel[state.chartScaleMode] || '自动');
      refs.btnChartScale.title = state.chartScaleMode === 'auto'
        ? '自动：量纲差超过 8 倍时按各通道自身量程归一化'
        : state.chartScaleMode === 'normalize'
          ? '归一化：每条曲线按自己的窗口量程铺满；右侧仍显示真实值'
          : '统一：所有通道共用一条绝对 Y 轴';
    }
    if (refs.btnZoom) refs.btnZoom.textContent = '缩放：' + (state.zoomMode === 'fit' ? '自适应' : '固定');
  }

  // 新壳遥测/状态栏的真实数字：帧、错误来自 state.serial，通道数来自当前数据页，
  // 采样率沿用数据源胶囊同一套口径；没有真实来源的格（缓冲/录制）留给 B1b-2 接内核指标，不写假数
  function syncShellStatus() {
    const frames = document.getElementById('teleFrames');
    if (frames) frames.textContent = state.serial.frames || 0;
    const errors = document.getElementById('teleErrors');
    if (errors) errors.textContent = state.serial.errors || 0;
    const chans = document.getElementById('statusbarChannels');
    if (chans) {
      const list = window.XHGCS && typeof window.XHGCS.activeChannels === 'function' ? window.XHGCS.activeChannels() : state.channels;
      chans.textContent = Array.isArray(list) ? list.length : 0;
    }
    const rate = document.getElementById('statusbarRate');
    if (rate) {
      if (state.simulation && state.simulation.enabled) rate.textContent = Math.round(1000 / Math.max(1, Number(state.intervalMs) || 100)) + ' Hz';
      else rate.textContent = Number(state.serial.rate) > 0 ? state.serial.rate + ' Hz' : '—';
    }
    // 缓冲：内核管线队列占用；录制：recorder 的真实会话状态。都没有真实来源就显示 —
    const buffer = document.getElementById('teleBuffer');
    if (buffer) buffer.textContent = pipelineQueueText();
    const record = document.getElementById('teleRecord');
    if (record) {
      const rec = window.XHGCS_RECORDER;
      const recording = Boolean(rec && rec.recording);
      if (recording) {
        if (!recordStartedAt) recordStartedAt = Date.now();
        const sec = Math.max(0, Math.floor((Date.now() - recordStartedAt) / 1000));
        const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
        const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        record.textContent = hh + ':' + mm + ':' + ss;
      } else {
        recordStartedAt = 0;
        record.textContent = '关';
      }
    }
    // 顶栏 KPI：高度 m / 电压 V / 电流 A（真实通道；无该单位通道则 —）
    const kpiCells = [['tvH', 'm'], ['tvV', 'V'], ['tvA', 'A']];
    const allCh = window.XHGCS && typeof window.XHGCS.allChannels === 'function' ? window.XHGCS.allChannels() : [];
    kpiCells.forEach((pair) => {
      const el = document.getElementById(pair[0]);
      if (!el) return;
      const list = Array.isArray(allCh) ? allCh.filter((ch) => String(ch.unit || '') === pair[1] && ch.visible !== false) : [];
      const ch = pair[1] === 'm' ? (list.find((item) => /高度/.test(item.name || '')) || list[0]) : list[0];
      const data = ch && Array.isArray(ch.data) && ch.data.length ? ch.data[ch.data.length - 1] : null;
      el.textContent = data == null ? '—' : (window.XHGCS.formatChannelValue ? window.XHGCS.formatChannelValue(ch, data) : String(Math.round(data * 10) / 10));
    });
  }

  // 管线队列占用：内核状态项「管线 N」的 tooltip 里有『队列 X/capacity』，这是内核公开给界面的指标
  let recordStartedAt = 0;

  function pipelineQueueText() {
    const items = document.querySelectorAll('.xhgcs-status-slot .xhgcs-sb');
    for (let i = 0; i < items.length; i++) {
      const match = String(items[i].title || '').match(/队列\s*(\d+)\s*\/\s*(\d+)/);
      if (!match) continue;
      const capacity = Number(match[2]) || 0;
      if (!capacity) return '—';
      return Math.min(100, Math.round(Number(match[1]) * 100 / capacity)) + '%';
    }
    return '—';
  }

  // 缓冲格点击：内核「管线」状态项本身是可点命令；内核没起来时退回 Ctrl+Shift+E / 协议页
  function openPipelinePanel() {
    const items = document.querySelectorAll('.xhgcs-status-slot .xhgcs-sb');
    for (let i = 0; i < items.length; i++) {
      if (/队列/.test(items[i].title || '')) { items[i].click(); return; }
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true }));
  }

  function updateHeader(now) {
    const curr = now || performance.now();
    if (curr - lastRateAt >= 1000) {
      const frames = state.serial.frames;
      state.serial.rate = Math.round((frames - lastRateFrames) * 1000 / (curr - lastRateAt));
      lastRateFrames = frames;
      lastRateAt = curr;
    }
    // 速率已经并进数据源胶囊（renderSourceChip 由下面的 updateConnection 调用）
    refs.clockText.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    updateConnection();
    syncShellStatus();
  }

  function toggleSerialPanel() {
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.toggleSerial) {
      const visible = window.XHGCS_LAYOUT.toggleSerial();
      syncSerialPanelButton();
      return !visible;
    }
    const hidden = refs.serialPanel.classList.toggle('hidden');
    syncSerialPanelButton();
    return hidden;
  }

  // 按钮文案必须跟着面板真实可见性走：日志面板默认是开着的，硬编码成「显示日志面板」时
  // 点一下只是把已经显示的日志藏起来，按钮说的和做的是两件事
  function syncSerialPanelButton() {
    if (!refs.serialPanel) return;
    const hidden = refs.serialPanel.classList.contains('hidden');
    if (refs.btnOpenSerialPanel) refs.btnOpenSerialPanel.textContent = hidden ? '显示日志面板' : '隐藏日志面板';
    if (refs.btnChartLog) {
      refs.btnChartLog.textContent = hidden ? '日志' : '收起日志';
      refs.btnChartLog.title = hidden ? '展开串口日志' : '收起串口日志';
    }
  }

  function loop(ts) {
    const dt = Math.min(1000, Math.max(0, ts - lastFrameTs));
    lastFrameTs = ts;
    if (state.playing && state.simulation.enabled) {
      sampleAcc += dt;
      while (sampleAcc >= state.intervalMs) {
        X.stepData();
        sampleAcc -= state.intervalMs;
      }
    }
    if (state.playing && window.XHGCS_ANALYSIS && typeof window.XHGCS_ANALYSIS.tick === 'function') window.XHGCS_ANALYSIS.tick();
    if (ts - lastChannelValsAt >= 50) { V.renderChannelVals(); lastChannelValsAt = ts; }
    if (ts - lastLogAt >= 100) { syncLogs(); lastLogAt = ts; }
    if (V.tickViews) V.tickViews(ts);
    if (V.tickChartWork) V.tickChartWork(ts);
    if (ts - lastStatsAt > 300) {
      updateHeader(ts);
      updateCommStats();
      updateSimStats();
      // 新告警是在数据 tick 里产生的（data.js 的 updateAlarms 只改 state.alarms），
      // 而角标原来只在启动、ack、清空时才刷新 —— 在别的页面收到告警时左导航一直是灰的。
      // 挂在统计 tick 上，仿真与真实串口两条数据源都覆盖
      updateAlarmBadge();
      V.updateHeadText();
      if (state.view === 'alarm') V.renderAlarmPanel();
      lastStatsAt = ts;
    }
    // 空态三条出路
    Array.from(document.querySelectorAll('[data-empty-action]')).forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.emptyAction;
        if (action === 'sim') navigate('sim');
        else if (action === 'serial') navigate('serial');
        else if (action === 'protocol') navigate('input');
        else if (action === 'select-port' && refs.btnSelectPort) refs.btnSelectPort.click();
      });
    });

    requestAnimationFrame(loop);
  }

  function toast(message) {
    refs.toast.textContent = message;
    refs.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 2600);
  }

  APP.navigate = navigate;
  APP.togglePlay = togglePlay;
  APP.toast = toast;
  APP.updateAlarmBadge = updateAlarmBadge;
  APP.toggleSerialPanel = toggleSerialPanel;
  APP.updatePlayButtons = updatePlayButtons;
  APP.updateSimulationUI = updateSimulationUI;
  APP.toggleSimulation = toggleSimulation;
  APP.updatePortInfo = updatePortInfo;
  APP.syncSerialSettings = syncSerialSettings;
  APP.syncLogs = syncLogs;
  APP.updateCommStats = updateCommStats;
  APP.updateSimStats = updateSimStats;
  APP.updateHeader = updateHeader;
  APP.init = init;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
