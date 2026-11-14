(function () {
  'use strict';

  // 新壳的装饰层：只做「搬家」和「换图标」，不碰核心逻辑，也不改 src/core。
  // 1) 内核注入的 rail 菜单（设计器/视图/看板）把 unicode 图标换成同一套 SVG sprite；
  // 2) 内核状态栏条目由 core 生成在顶栏 .top-right 里，这里把节点整体移动到 底部 [data-statusbar-host]。
  // 任何一步失败都静默降级：壳能少一块装饰，不能因为装饰脚本报错起不来。

  var MENU_ICONS = { designer: 'i-designer', views: 'i-views', board: 'i-board' };

  function iconSvg(id) {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>';
  }

  function decorateRail() {
    var nav = document.getElementById('sideNav');
    if (!nav) return false;
    // 折叠态只有图标：每个按钮都要有可访问名（title 是鼠标提示，aria-label 是读屏名）
    var buttons = nav.querySelectorAll('button');
    for (var b = 0; b < buttons.length; b++) {
      var btn = buttons[b];
      if (!btn.getAttribute('aria-label')) {
        var text = (btn.textContent || '').replace(/\s+/g, '');
        var tip = btn.getAttribute('title') || text;
        if (tip) btn.setAttribute('aria-label', tip);
      }
    }
    var items = nav.querySelectorAll('.tool[data-xhgcs-menu]');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = String(item.getAttribute('data-xhgcs-menu') || '').split('.').pop().toLowerCase();
      var iconId = MENU_ICONS[key];
      if (!iconId) continue;
      var box = item.querySelector('.ico');
      if (!box || box.getAttribute('data-svg-icon') === iconId) continue;
      box.setAttribute('data-svg-icon', iconId);
      box.innerHTML = iconSvg(iconId);
    }
    return true;
  }

  function moveCoreStatus() {
    var host = document.querySelector('[data-statusbar-host]');
    var slot = document.querySelector('.top-right .xhgcs-status-slot');
    if (!host || !slot) return false;
    if (host.contains(slot)) return true;
    // core 给宿主写了 46vw 的内联上限，底部状态栏要铺满
    slot.style.maxWidth = '';
    slot.style.flex = '';
    host.appendChild(slot);
    return true;
  }

  // 版本 chip 以内核版本为唯一来源（bump 工具只改 package.json / core version，不该再手改 HTML）
  function decorateVersion() {
    var chip = document.querySelector('.brand-ver');
    var footVer = document.querySelector('.sb-ver');
    var core = window.XHGCS_CORE;
    if (!chip || !core || !core.version) return false;
    chip.textContent = 'v' + String(core.version);
    if (footVer) footVer.textContent = 'v' + String(core.version);
    return true;
  }

  // AI 面板整体搬进抽屉宿主：只动节点位置，id / 内部 DOM / ai-ui.js 的引用全部保留。
  // 顺带摘掉它在 Dock 里的 dock-page 身份，否则 layout.syncDock 会继续按页签隐藏它。
  function moveAiPanel() {
    var host = document.getElementById('aiPanelHost');
    var panel = document.getElementById('aiPanel');
    if (!host || !panel) return false;
    if (host.contains(panel)) return true;
    panel.classList.remove('dock-page');
    panel.removeAttribute('data-dock-page');
    panel.removeAttribute('hidden');
    panel.classList.remove('hidden');
    host.appendChild(panel);
    return true;
  }

  function escapeRail(text) {
    var X = window.XHGCS;
    if (X && typeof X.esc === 'function') return X.esc(text == null ? '' : String(text));
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function railValue(ch) {
    var data = ch && Array.isArray(ch.data) ? ch.data : [];
    var last = data.length ? data[data.length - 1] : null;
    if (last == null || !isFinite(last)) return '—';
    var X = window.XHGCS;
    if (X && typeof X.formatChannelValue === 'function') {
      try { return X.formatChannelValue(ch, last); } catch (err) { /* 数字格式化失败就用原值 */ }
    }
    return String(Math.round(last * 10) / 10);
  }

  // 折叠态迷你仪表轨：最多前 3 个通道（顺序稳定），1s 刷新一次；数据源仍是 state.channels
  function renderDockRail() {
    var list = document.getElementById('dockRailList');
    if (!list) return;
    var X = window.XHGCS;
    var channels = X && X.state && Array.isArray(X.state.channels) ? X.state.channels : [];
    var picked = channels.slice(0, 3);
    if (!picked.length) {
      if (list.getAttribute('data-empty') !== '1') {
        list.setAttribute('data-empty', '1');
        list.innerHTML = '<div class="dock-rail-empty">无数据</div>';
      }
      return;
    }
    list.removeAttribute('data-empty');
    var html = '';
    for (var i = 0; i < picked.length; i++) {
      var ch = picked[i];
      var color = ch.color || '#6da8d2';
      if (X && typeof X.viewColor === 'function') color = X.viewColor(color) || color;
      html += '<div class="dock-rail-row">'
        + '<i class="dock-rail-dot" style="background:' + escapeRail(color) + '"></i>'
        + '<span class="dock-rail-name" title="' + escapeRail(ch.name) + '">' + escapeRail(ch.name) + '</span>'
        + '<span class="dock-rail-val">' + escapeRail(railValue(ch)) + '</span>'
        + '<span class="dock-rail-unit">' + escapeRail(ch.unit || '') + '</span>'
        + '</div>';
    }
    list.innerHTML = html;
  }

  function bindDockRail() {
    var rail = document.getElementById('dockRail');
    if (!rail || rail.getAttribute('data-bound') === '1') return;
    rail.setAttribute('data-bound', '1');
    rail.addEventListener('click', function () {
      if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.setDockOpen) window.XHGCS_LAYOUT.setDockOpen(true);
    });
    rail.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.setDockOpen) window.XHGCS_LAYOUT.setDockOpen(true);
    });
  }

  // 自绘窗口按钮：系统不再画 ─ ☐ ✕（titleBarOverlay 会压在页面之上，浮层盖不住），
  // 由这里接线主进程。浏览器里没有 XHGCS_DESKTOP.windowControls，整块按钮由 CSS 隐藏。
  var WIN_ICON_MAX = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>';
  var WIN_ICON_RESTORE = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="3.5" width="6.5" height="6.5" rx="1"/><path d="M4 3.5V2.5a1 1 0 0 1 1-1h5.5a1 1 0 0 1 1 1V8"/></svg>';

  function bindWindowControls() {
    var box = document.querySelector('[data-win-controls]');
    var desk = window.XHGCS_DESKTOP;
    if (!box || !desk || !desk.windowControls) return false;
    if (box.getAttribute('data-bound') === '1') return true;
    box.setAttribute('data-bound', '1');
    var api = desk.windowControls;
    function syncMax(maximized) {
      var btn = box.querySelector('[data-win="max"]');
      if (!btn) return;
      var label = maximized ? '向下还原' : '最大化';
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
      btn.innerHTML = maximized ? WIN_ICON_RESTORE : WIN_ICON_MAX;
    }
    box.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('[data-win]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-win');
      try {
        if (action === 'min') api.minimize();
        else if (action === 'close') api.close();
        else if (action === 'max') {
          var result = api.toggleMaximize();
          if (result && typeof result.then === 'function') result.then(function (r) { if (r) syncMax(Boolean(r.maximized)); });
        }
      } catch (err) { /* 窗口控制失败不影响页面 */ }
    });
    try {
      var state = api.state();
      if (state && typeof state.then === 'function') state.then(function (r) { if (r) syncMax(Boolean(r.maximized)); });
      if (typeof api.onMaximizedChange === 'function') api.onMaximizedChange(syncMax);
    } catch (err) { /* 同上 */ }
    return true;
  }
  function decorate() {
    decorateRail();
    moveCoreStatus();
    decorateVersion();
    moveAiPanel();
    bindWindowControls();
    bindDockRail();
    renderDockRail();
  }

  function watch(target, options) {
    if (!target || typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function () { decorate(); });
    observer.observe(target, options);
  }

  function bindTopbar() {
    var paletteBtn = document.getElementById('btnCommandPalette');
    if (!paletteBtn) return;
    paletteBtn.addEventListener('click', function () {
      // 命令面板的打开逻辑在 core.bundle 的全局快捷键里，这里按同一组键派发，不另写一套
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
      }));
    });
  }

  function boot() {
    decorate();
    bindTopbar();
    watch(document.getElementById('sideNav'), { childList: true });
    var topRight = document.querySelector('.top-right');
    if (topRight) watch(topRight, { childList: true });
    // 迷你仪表轨每秒刷新一次（只在折叠态有显示意义，展开时 DOM 还在但不显示）
    setInterval(renderDockRail, 1000);
    // 展开/收起后立刻重画一次，避免等下一个 1s 节拍
    window.addEventListener('xhgcs:layout-changed', renderDockRail);
    // core 的注入是异步的（manifest 激活 + 事件循环），首帧后再补一次
    setTimeout(decorate, 120);
    setTimeout(function () { decorate(); moveCoreStatus(); }, 600);
    if (window.XHGCS_CORE && window.XHGCS_CORE.events && typeof window.XHGCS_CORE.events.on === 'function') {
      try { window.XHGCS_CORE.events.on('xhgcs:ready', decorate); } catch (err) { /* 老内核没有这个事件，忽略 */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
