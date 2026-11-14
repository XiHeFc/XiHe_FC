(function () {
  'use strict';

  const api = window.XHGCS_DESKTOP;
  const X = window.XHGCS;
  if (!api || !api.isDesktop) return;

  const MCP_AUTO_FLAG = 'xhgcs.desktop.mcpAutoEnabled';
  let status = null;
  let timer = null;
  let busy = false;

  document.body.classList.add('is-desktop');

  function $(selector) {
    return document.querySelector(selector);
  }

  const escapeHtml = X.esc;

  function serviceRow(name, detail, running) {
    const stateClass = running ? 'ok' : 'off';
    const stateText = running ? '运行中' : '未运行';
    return (
      '<div class="desktop-service">' +
      '<span class="desktop-dot ' + stateClass + '"></span>' +
      '<div class="desktop-service-main"><b>' + escapeHtml(name) + '</b><small>' + escapeHtml(detail) + '</small></div>' +
      '<span class="desktop-tag ' + stateClass + '">' + stateText + '</span>' +
      '</div>'
    );
  }

  function render() {
    const host = $('#desktopPanel');
    if (!host || !status) return;

    const bridge = status.bridge || {};
    const tts = status.tts || {};
    const ttsDetail = tts.available === false
      ? '未检测到 D:\\GPT-SoVITS-src'
      : 'http://127.0.0.1:' + (tts.port || 8770) + (tts.enabled === false ? ' · 已关闭自动启动' : '');

    host.innerHTML =
      '<div class="desktop-meta">' +
      '<div><span>版本</span><b>' + escapeHtml(status.appVersion) + '</b></div>' +
      '<div><span>Electron</span><b>' + escapeHtml(status.electron) + '</b></div>' +
      '<div><span>Chromium</span><b>' + escapeHtml(status.chrome) + '</b></div>' +
      '<div><span>模式</span><b>' + (status.packaged ? '安装版' : '开发模式') + '</b></div>' +
      '</div>' +
      '<div class="desktop-services">' +
      serviceRow('界面服务', 'http://127.0.0.1:' + status.webPort, true) +
      serviceRow('MCP 桥', 'http://127.0.0.1:' + (bridge.port || 8787) + (bridge.managed ? ' · 由桌面版托管' : ''), !!bridge.running) +
      serviceRow('本地 TTS', ttsDetail, !!tts.running) +
      '</div>' +
      '<div class="desktop-actions">' +
      '<button class="btn" id="desktopRestart">重启本地服务</button>' +
      '<button class="btn" id="desktopOpenLogs">打开日志目录</button>' +
      '<button class="btn" id="desktopOpenData">打开数据目录</button>' +
      '<button class="btn" id="desktopForgetPort"' + (status.lastSerialPort ? '' : ' disabled') + '>清除记住的串口' + (status.lastSerialPort ? '（' + escapeHtml(status.lastSerialPort) + '）' : '') + '</button>' +
      '<button class="btn" id="desktopAbout">关于</button>' +
      '</div>' +
      '<div class="desktop-group">' +
      '<div class="desktop-group-title">窗口命令</div>' +
      '<div class="desktop-actions">' +
      '<button class="btn" id="desktopReload">重新载入界面</button>' +
      '<button class="btn" id="desktopZoomOut">缩小</button>' +
      '<button class="btn" id="desktopZoomReset">实际大小</button>' +
      '<button class="btn" id="desktopZoomIn">放大</button>' +
      '<button class="btn" id="desktopFullscreen">全屏切换</button>' +
      '<button class="btn" id="desktopDevTools">开发者工具</button>' +
      '</div>' +
      '</div>' +
      '<label class="chk desktop-auto-tts"><input type="checkbox" id="desktopAutoTts"' + (status.autoTts ? ' checked' : '') + ' /> 启动软件时自动启动本地 TTS（GPT-SoVITS）</label>' +
      '<div class="hint desktop-hint">数据目录 ' + escapeHtml(status.userDataDir) + '<br />日志目录 ' + escapeHtml(status.logsDir) + '</div>';

    const restart = $('#desktopRestart');
    if (restart) restart.addEventListener('click', onRestart);
    const openLogs = $('#desktopOpenLogs');
    if (openLogs) openLogs.addEventListener('click', () => api.openLogs());
    const openData = $('#desktopOpenData');
    if (openData) openData.addEventListener('click', () => api.openUserData());
    const forget = $('#desktopForgetPort');
    if (forget) forget.addEventListener('click', onForgetPort);
    const autoTts = $('#desktopAutoTts');
    if (autoTts) autoTts.addEventListener('change', onAutoTts);

    const bind = (id, handler) => {
      const el = $('#' + id);
      if (el) el.addEventListener('click', handler);
    };
    bind('desktopReload', () => api.reload());
    bind('desktopZoomOut', () => api.zoom('out'));
    bind('desktopZoomReset', () => api.zoom('reset'));
    bind('desktopZoomIn', () => api.zoom('in'));
    bind('desktopFullscreen', () => api.toggleFullScreen());
    bind('desktopDevTools', () => api.toggleDevTools());
    bind('desktopAbout', () => api.about());

  }

  function toast(message) {
    if (window.XHGCS_APP && window.XHGCS_APP.toast) window.XHGCS_APP.toast(message);
  }

  async function refresh() {
    try {
      status = await api.getStatus();
      render();
    } catch (error) {
      api.log('desktop status failed: ' + error.message);
    }
  }

  async function onRestart() {
    if (busy) return;
    busy = true;
    const button = $('#desktopRestart');
    if (button) {
      button.disabled = true;
      button.textContent = '正在重启…';
    }
    try {
      status = await api.restartServices();
      render();
      toast('本地服务已重启');
    } catch (error) {
      toast('重启失败：' + error.message);
    } finally {
      busy = false;
    }
  }

  async function onForgetPort() {
    status = await api.forgetSerialPort();
    render();
    toast('已清除记住的串口');
  }

  async function onAutoTts(event) {
    const enabled = !!(event.target && event.target.checked);
    status = await api.setAutoTts(enabled);
    render();
    toast(enabled ? '已开启本地 TTS 自动启动' : '已关闭本地 TTS 自动启动');
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(() => {
      const panel = $('.settings-section[data-settings-panel="desktop"]');
      if (!panel || !panel.classList.contains('active')) return;
      refresh();
    }, 4000);
  }

  function autoEnableMcp() {
    const state = window.XHGCS && window.XHGCS.state;
    if (!state || !state.mcp) return;
    if (state.mcp.enabled) return;
    let done = false;
    try {
      done = window.localStorage.getItem(MCP_AUTO_FLAG) === '1';
    } catch (error) {
      done = true;
    }
    if (done) return;
    state.mcp.enabled = true;
    if (window.XHGCS.persist) window.XHGCS.persist();
    try {
      window.localStorage.setItem(MCP_AUTO_FLAG, '1');
    } catch (error) {
      /* ignore */
    }
    setTimeout(() => toast('桌面版已自动启用 MCP 桥（可在设置中关闭）'), 1200);
  }

  function boot() {
    autoEnableMcp();
    refresh();
    startPolling();
    const navButton = document.querySelector('.settings-nav-btn[data-settings-nav="desktop"]');
    if (navButton) navButton.addEventListener('click', refresh);
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target : null;
      if (target && target.closest('[data-action="settings"]')) setTimeout(refresh, 60);
    }, true);
  }

  window.XHGCS_DESKTOP_UI = { refresh: refresh, render: render, get status() { return status; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
