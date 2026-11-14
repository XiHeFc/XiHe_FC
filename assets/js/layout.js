(function () {
  'use strict';

  const KEY = 'xhgcs.layout.v3';
  const LEGACY_KEY = 'xhgcs.layout.v2';
  const VERSION = '20261115A';
  window.XHGCS_LAYOUT_VERSION = VERSION;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  // 上次停留的一级页（选中页持久化）：只接受已知页面，默认空 = wave；必须在 load() 之前声明
  const KNOWN_VIEWS = ['wave', 'serial', 'engine', 'alarm', 'sim', 'analysis', 'input'];
  let state = load();
  let resizeFrame = 0;

  function readKey(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      return {};
    }
  }

  function clampWidth(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function sampleChartMin() { return window.innerWidth >= 1440 ? 800 : 560; }
  function samplePairMax() { return Math.max(0, window.innerWidth - 52 - sampleChartMin()); }
  function clampSampleWidths() {
    state.sampleLeftW = clampWidth(state.sampleLeftW, 272, 360, 300);
    state.sampleAiW = clampWidth(state.sampleAiW, 360, 480, window.innerWidth >= 1366 ? 380 : 360);
    const max = samplePairMax();
    if (state.aiDrawer) {
      if (state.sampleLeftW + state.sampleAiW > max) state.sampleAiW = Math.max(360, max - state.sampleLeftW);
      if (state.sampleLeftW + state.sampleAiW > max) state.sampleLeftW = Math.max(272, max - state.sampleAiW);
    }
  }
  function flashUi5Limit(target, handle) {
    const list = [target, handle].filter(Boolean);
    list.forEach((el) => el.classList.add('ui5-limit'));
    clearTimeout(flashUi5Limit._t);
    flashUi5Limit._t = setTimeout(() => list.forEach((el) => el.classList.remove('ui5-limit')), 650);
  }

  function load() {
    const current = readKey(KEY);
    const legacy = readKey(LEGACY_KEY);
    const legacyTab = legacy.panel === 'ai' ? 'ai' : 'data';
    return {
      // AI 页签已迁成抽屉：Dock 只保留 数据/告警 两页；旧 dockTab:'ai' 迁移为「抽屉打开」
      dockTab: current.dockTab === 'alarm' ? 'alarm' : 'data',
      // ui5 样品：首次无存档默认常驻 AI 列；之后沿用 layout.v3
      aiDrawer: typeof current.aiDrawer === 'boolean' ? current.aiDrawer : true,
      // 首次启动默认收起：首屏图面优先；用户手工展开/收起后以持久化值为准
      dockOpen: typeof current.dockOpen === 'boolean' ? current.dockOpen : false,
      dockWidth: clampWidth(current.dockWidth || legacy.channelsWidth || legacy.aiWidth, 220, 420, 352),
      viewsWidth: clampWidth(current.viewsWidth || legacy.switchWidth, 190, 320, 248),
      sampleLeftW: clampWidth(current.sampleLeftW, 272, 360, 300),
      sampleAiW: clampWidth(current.sampleAiW, 360, 480, window.innerWidth >= 1366 ? 380 : 360),
      serialOpen: typeof current.serialOpen === 'boolean' ? current.serialOpen : false,
      switchCollapsed: current.switchCollapsed === true,
      serialHeight: clampWidth(current.serialHeight || legacy.serialHeight, 90, 760, 150),
      view: KNOWN_VIEWS.indexOf(current.view) >= 0 ? current.view : ''
    };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.warn(err);
    }
  }

  function queueResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      window.dispatchEvent(new Event('resize'));
    });
  }

  function viewsPanel() { return $('.widgetbox') || $('.ctrl-switch'); }
  function dock() { return $('#workspaceDock'); }
  function serialPanel() { return $('#serialPanel'); }

  function syncSwitch() {
    const views = viewsPanel();
    if (!views) return;
    const collapsed = state.switchCollapsed === true;
    views.classList.toggle('collapsed', collapsed);
    const button = views.querySelector('#btnCollapseSwitch');
    if (button) {
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#' + (collapsed ? 'i-chevron-right' : 'i-chevron-left') + '"/></svg>';
      button.title = collapsed ? '展开控件箱' : '折叠控件箱';
      button.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  function setSwitchCollapsed(collapsed, options) {
    state.switchCollapsed = Boolean(collapsed);
    syncSwitch();
    if (!options || options.persist !== false) save();
    queueResize();
    return state.switchCollapsed;
  }

  function toggleSwitchCollapsed() {
    return setSwitchCollapsed(!state.switchCollapsed);
  }

  function applyColumnVars() {
    const ws = $('.workspace');
    if (!ws) return;
    const aiOpen = state.aiDrawer === true;
    clampSampleWidths();
    const app = document.querySelector('.app');
    if (app) app.classList.toggle('ai-open', aiOpen);
    ws.style.setProperty('--ai-w', (aiOpen ? state.sampleAiW : 0) + 'px');
    ws.style.setProperty('--left-w', state.sampleLeftW + 'px');
    // 样品 dock 由 CSS 隐藏，列宽归零；日志右缘不再让位给 dock
    ws.style.setProperty('--dock-w', '0px');
  }

  function applyWidths() {
    applyColumnVars();
    const views = viewsPanel();
    if (views) views.style.width = '';
    const serial = serialPanel();
    if (serial) {
      serial.style.height = state.serialHeight + 'px';
      serial.style.flexBasis = serial.style.height;
    }
  }

  function syncDock() {
    const side = dock();
    if (!side) return;
    const aiOpen = state.aiDrawer === true;
    side.dataset.tab = state.dockTab;
    side.classList.toggle('dock-collapsed', aiOpen ? true : !state.dockOpen);
    // 展开 352 / 收起 64：列宽走 CSS 变量，右缘永远贴窗口（窄屏收敛）
    applyColumnVars();
    const tabs = $$('[data-dock-tab]');
    tabs.forEach((tab) => {
      const active = tab.dataset.dockTab === state.dockTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.dtab-pane, .dock-page').forEach((page) => {
      const key = page.dataset.pane || page.dataset.dockPage;
      const active = key === state.dockTab;
      page.classList.toggle('dock-page-active', active);
      page.classList.toggle('active', active);
      page.hidden = !active;
    });
    const collapse = $('#btnCollapseDock');
    if (collapse) {
      collapse.textContent = state.dockOpen ? '»' : '«';
      if (aiOpen) {
        collapse.disabled = true;
        collapse.setAttribute('aria-disabled', 'true');
        collapse.title = 'AI 展开时 dock 固定为读数轨';
      } else {
        collapse.disabled = false;
        collapse.setAttribute('aria-disabled', 'false');
        collapse.title = state.dockOpen ? '收起数据面板' : '展开数据面板';
      }
      collapse.setAttribute('aria-expanded', state.dockOpen ? 'true' : 'false');
    }
    const handle = $('[data-resize="dock"]');
    if (handle) handle.style.display = state.dockOpen && !aiOpen ? 'block' : 'none';
    // AI 列打开：dock 读数轨整体锁定（可见但不可点）
    const railEl = $('#dockRail');
    const expandEl = $('#btnDockExpand');
    if (railEl) {
      railEl.setAttribute('aria-disabled', aiOpen ? 'true' : 'false');
      railEl.classList.toggle('ai-locked', aiOpen);
    }
    if (expandEl) {
      expandEl.setAttribute('aria-disabled', aiOpen ? 'true' : 'false');
      expandEl.disabled = aiOpen;
    }

    queueResize();
    window.dispatchEvent(new CustomEvent('xhgcs:layout-changed', { detail: { dockOpen: state.dockOpen, dockTab: state.dockTab } }));
  }

  // 抽屉状态存在 layout.v3（不动 data.js 的 state）
  function setAiDrawerOpen(open) {
    const next = Boolean(open);
    if (state.aiDrawer === next) return next;
    state.aiDrawer = next;
    save();
    syncDock();
    return next;
  }

  function isAiDrawerOpen() { return state.aiDrawer === true; }

  function requestAiDrawer(open) {
    state.aiDrawer = Boolean(open);
    save();
    syncDock();
    const ui = window.XHGCS_AI_UI;
    if (ui && typeof ui.openDrawer === 'function') {
      if (open) ui.openDrawer(); else ui.closeDrawer();
      return state.aiDrawer;
    }
    // AI 模块还没加载：发请求事件，ai-ui.js 加载后会接住
    window.dispatchEvent(new CustomEvent('xhgcs:ai-drawer-request', { detail: { open: Boolean(open) } }));
    return state.aiDrawer;
  }

  function setDockTab(tab) {
    if (tab === 'ai') { requestAiDrawer(true); return; }
    // AI 打开时 dock 是固定读数轨，页签不可见：切 tab 整体 no-op
    if (state.aiDrawer === true) return;
    state.dockTab = tab === 'alarm' ? 'alarm' : 'data';
    state.dockOpen = true;
    save();
    syncDock();
  }

  function setDockOpen(open, persist) {
    // AI 列打开时 dock 固定为 64 读数轨：任何“展开 dock”的入口都不得改持久化状态
    if (open === true && state.aiDrawer === true) return state.dockOpen;
    const changed = state.dockOpen !== Boolean(open);
    state.dockOpen = Boolean(open);
    if (persist !== false) save();
    const side = dock();
    if (changed && side) {
      // 只在开合这一下开宽度过渡；拖拽调宽时不加，避免跟手迟滞
      side.classList.add('dock-animating');
      clearTimeout(setDockOpen._timer);
      setDockOpen._timer = setTimeout(function () { side.classList.remove('dock-animating'); }, 200);
    }
    syncDock();
  }

  function toggleDock() {
    setDockOpen(!state.dockOpen);
  }

  function open(name) {
    if (name === 'ai') { requestAiDrawer(true); return true; }
    if (name === 'channels' || name === 'data') {
      setDockTab('data');
      return true;
    }
    if (name === 'alarm') {
      setDockTab('alarm');
      return true;
    }
    if (name === 'views') {
      viewsPanel() && viewsPanel().focus();
      return true;
    }
    return false;
  }

  function close() {
    setDockOpen(false);
  }

  function toggle(name) {
    if (name === 'ai') { requestAiDrawer(!state.aiDrawer); return state.aiDrawer; }
    // AI 打开时 data/alarm 入口 no-op（不先改 dockTab 再被 setDockOpen 拦一半）
    if (state.aiDrawer === true) return false;
    if (name === 'channels' || name === 'data' || name === 'alarm') {
      const tab = name === 'alarm' ? 'alarm' : 'data';
      if (state.dockOpen && state.dockTab === tab) setDockOpen(false);
      else {
        state.dockTab = tab;
        setDockOpen(true);
      }
      return state.dockOpen;
    }
    return false;
  }

  function activePanel() {
    if (state.aiDrawer) return 'ai';
    return state.dockOpen ? state.dockTab : '';
  }

  function toggleSerial() {
    return setSerialOpen(!state.serialOpen);
  }

  function syncSerialButton() {
    const panel = serialPanel();
    const visible = panel && !panel.classList.contains('hidden');
    const button = $('#btnOpenSerialPanel');
    if (button) button.textContent = visible ? '隐藏日志面板' : '显示日志面板';
    const chartLog = $('#btnChartLog');
    if (chartLog) {
      chartLog.textContent = visible ? '收起日志' : '日志';
      chartLog.title = visible ? '收起串口日志' : '展开串口日志';
    }
  }

  function serialHeight() { return state.serialHeight; }

  function setSerialHeight(px, persist) {
    const target = clampWidth(px, 90, 760, state.serialHeight);
    if (target === state.serialHeight) return target;
    state.serialHeight = target;
    if (persist !== false) save();
    applyWidths();
    queueResize();
    return target;
  }

  function setSerialOpen(open, persist) {
    const panel = serialPanel();
    if (!panel) return false;
    state.serialOpen = Boolean(open);
    panel.classList.toggle('hidden', !state.serialOpen);
    if (persist !== false) save();
    syncSerialButton();
    queueResize();
    return state.serialOpen;
  }

  function syncSerialForView(view) {
    const panel = serialPanel();
    if (!panel) return;
    const allowed = view === 'serial' || view === 'wave';
    const visible = allowed && (view === 'serial' || state.serialOpen);
    panel.classList.toggle('hidden', !visible);
    syncSerialButton();
    queueResize();
  }

  function focusChart() {
    setDockOpen(false, false);
    setSerialOpen(false, false);
    save();
    queueResize();
  }

  function bindResize(handle, mode) {
    if (!handle) return;
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (mode === 'dock' && state.aiDrawer) return;
      if (mode === 'ai5' && !state.aiDrawer) return;
      const target = mode === 'switch' ? viewsPanel() : (mode === 'ai5' ? $('#aiDrawer') : dock());
      if (!target || (mode === 'dock' && !state.dockOpen)) return;
      event.preventDefault();
      drag = { x: event.clientX, width: target.getBoundingClientRect().width, target: target };
      handle.classList.add('dragging');
      try { handle.setPointerCapture(event.pointerId); } catch (err) {}
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      if (mode === 'switch') {
        const raw = drag.width + dx;
        let next = clampWidth(raw, 272, 360, state.sampleLeftW);
        let limited = raw !== next;
        const ai = state.aiDrawer ? state.sampleAiW : 0;
        if (next + ai > samplePairMax()) { next = Math.max(272, samplePairMax() - ai); limited = true; }
        state.sampleLeftW = next;
        if (limited) flashUi5Limit(viewsPanel(), handle);
      } else if (mode === 'ai5') {
        const raw = drag.width - dx;
        let next = clampWidth(raw, 360, 480, state.sampleAiW);
        let limited = raw !== next;
        if (state.sampleLeftW + next > samplePairMax()) { next = Math.max(360, samplePairMax() - state.sampleLeftW); limited = true; }
        state.sampleAiW = next;
        if (limited) flashUi5Limit($('#aiDrawer'), handle);
      } else {
        const width = drag.width - dx;
        state.dockWidth = clampWidth(width, 220, 420, state.dockWidth);
      }
      applyWidths();
      queueResize();
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('dragging');
      save();
      queueResize();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('dblclick', () => {
      if (mode === 'switch') state.sampleLeftW = 300;
      else if (mode === 'ai5') state.sampleAiW = window.innerWidth >= 1366 ? 380 : 360;
      else state.dockWidth = 352;
      applyWidths();
      save();
      queueResize();
    });
  }

  function bind() {
    $$('[data-dock-tab]').forEach((tab) => {
      tab.addEventListener('click', () => setDockTab(tab.dataset.dockTab));
    });
    const collapse = $('#btnCollapseDock');
    if (collapse) collapse.addEventListener('click', toggleDock);
    // 控件箱折叠按钮：以前完全没接线，点了没反应，被当成界面坏了
    const collapseSwitch = $('#btnCollapseSwitch');
    if (collapseSwitch) collapseSwitch.addEventListener('click', () => toggleSwitchCollapsed());
    bindResize($('[data-resize="switch"]'), 'switch');
    bindResize($('[data-resize="dock"]'), 'dock');
    bindResize($('[data-resize="ai5"]'), 'ai5');
    window.addEventListener('resize', () => { clampSampleWidths(); applyWidths(); });

    // Esc 关 AI 抽屉：layout.js 永远已加载，所以兜底放这里；判定只看 DOM 真实状态，
    // 不依赖 ai-ui 的懒加载顺序与内部变量（spec §19.1 契约）。
    // 优先级：AI 面板菜单 > 其它可见浮层 > 抽屉本体。
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const drawer = document.getElementById('aiDrawer');
      if (!drawer || drawer.hidden) return;
      const menuOpen = ['aiSuggest', 'aiModelMenu'].some((id) => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 2;
      });
      if (menuOpen) return;
      const overlayOpen = Array.prototype.some.call(
        document.querySelectorAll('.modal-overlay, .xhgcs-mask, .component-manager'),
        (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2;
        }
      );
      if (overlayOpen) return;
      if (window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth && window.XHGCS_OVERLAY.depth() > 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (window.XHGCS_AI_UI && typeof window.XHGCS_AI_UI.closeDrawer === 'function') window.XHGCS_AI_UI.closeDrawer();
      else {
        drawer.hidden = true;
        state.aiDrawer = false;
        save();
        syncDock();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === '2') { event.preventDefault(); setDockTab('data'); }
      if (event.key === '3') { event.preventDefault(); setDockTab('ai'); }
      if (event.key === '4') { event.preventDefault(); toggleSerial(); }
      if (event.key === '0') { event.preventDefault(); focusChart(); }
      if (event.key === 'Escape' && state.dockOpen && !(window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth() > 0)) setDockOpen(false);
    });
  }

  function bindSerialResize() {
    const handle = $('[data-resize="serial"]');
    const target = serialPanel();
    if (!handle || !target) return;
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      drag = { y: event.clientY, height: target.getBoundingClientRect().height };
      handle.classList.add('dragging');
      try { handle.setPointerCapture(event.pointerId); } catch (err) {}
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const height = clampWidth(drag.height - (event.clientY - drag.y), 90, 360, state.serialHeight);
      state.serialHeight = Math.round(height);
      target.style.height = state.serialHeight + 'px';
      target.style.flexBasis = target.style.height;
      queueResize();
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('dragging');
      save();
      queueResize();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('dblclick', () => {
      state.serialHeight = 150;
      applyWidths();
      save();
      queueResize();
    });
  }

  /**
   * 把右侧 Dock 从「可视化视图内部」提到舞台级。
   *
   * 原来 #workspaceDock 是 #view-wave 的子元素，切到串口/告警页整列就消失，
   * 而左栏的「AI」只能先把你拽回可视化再展开（高亮还落在可视化上）。
   * 这里用一次性的 DOM 提升（portal）建立 stage-main 行容器：
   *   .stage > .stage-main > (.view-stack, .dock-resize, #workspaceDock)
   * 之后所有视图共享同一个 Dock，视觉与布局逻辑都不用改。
   */
  function ensureDockPortal() {
    // v4 整骨：dock 已是 .workspace 的平级列，不再从 view-wave 里提升节点
    return;
    // eslint-disable-next-line no-unreachable
    const dock = $('#workspaceDock');
    const stage = $('.stage');
    const stack = $('.view-stack');
    if (!dock || !stage || !stack) return;
    if (dock.parentElement && dock.parentElement.classList.contains('stage-main')) return;
    const row = document.createElement('div');
    row.className = 'stage-main';
    stage.insertBefore(row, stack);
    row.appendChild(stack);
    const handle = $('.resize-handle.dock-resize');
    if (handle) row.appendChild(handle);
    row.appendChild(dock);
  }

  // 选中页持久化：navigate() 每次切页写一次；恢复时必须走「点击对应 [data-nav] 按钮」，
  // 因为 analysis 这类页面要经过 boot.js 的按需加载拦截，直接 navigate() 会恢复成空页。
  function rememberView(view) {
    if (KNOWN_VIEWS.indexOf(view) < 0) return;
    if (state.view === view) return;
    state.view = view;
    save();
  }

  function restoreView() {
    if (KNOWN_VIEWS.indexOf(state.view) < 0) return;
    // 协议/串口一级页已并入「输入」：旧的持久值回落到输入页
    const mapped = state.view === 'engine' || state.view === 'serial' ? 'input' : state.view;
    const selector = mapped === 'wave' ? '[data-nav="visual"]' : '[data-nav="' + mapped + '"]';
    const button = document.querySelector('#sideNav ' + selector);
    if (button) button.click();
  }

  function init() {
    ensureDockPortal();
    applyWidths();
    syncSwitch();
    syncDock();
    syncSerialButton();
    bind();
    bindSerialResize();
    setSerialOpen(state.serialOpen, false);
    // 等 app-core 完成首次 navigate 之后再恢复，避免被启动默认值覆盖
    setTimeout(restoreView, 0);
  }

  window.XHGCS_LAYOUT = {
    open: open,
    close: close,
    toggle: toggle,
    toggleSerial: toggleSerial,
    setSerialOpen: setSerialOpen,
    serialHeight: serialHeight,
    setSerialHeight: setSerialHeight,
    focusChart: focusChart,
    syncSerialForView: syncSerialForView,
    setDockTab: setDockTab,
    setDockOpen: setDockOpen,
    toggleSwitchCollapsed: toggleSwitchCollapsed,
    setSwitchCollapsed: setSwitchCollapsed,
    rememberView: rememberView,
    restoreView: restoreView,
    activePanel: activePanel,
    isDockOpen: () => Boolean(state.dockOpen),
    setAiDrawerOpen: setAiDrawerOpen,
    isAiDrawerOpen: isAiDrawerOpen,
    serialOpen: () => Boolean(state.serialOpen && serialPanel() && !serialPanel().classList.contains('hidden'))
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
