(function () {
  'use strict';
  // AI / MCP 连接页：把设置里「MCP 桥」一栏接上真实状态。
  // 只通过受限 IPC 与主进程对话；不直接读实例文件、不接触令牌存储。
  var api = window.XHGCS_DESKTOP;
  if (!api || !api.ai) return;

  var state = null;
  var busy = false;
  var timer = null;

  function $(s) { return document.querySelector(s); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pane() { return document.querySelector('.set-pane[data-set-pane="mcp"]'); }
  function visible() {
    var p = pane();
    return !!(p && p.classList.contains('on'));
  }

  function ensureUi() {
    var p = pane();
    if (!p || document.getElementById('aiConn')) return;
    var head = p.querySelector('.set-pane-head');
    var box = document.createElement('div');
    box.id = 'aiConn';
    box.innerHTML =
      '<div class="set-kv"><span>本地服务</span><b id="aiConnBridge">检查中…</b></div>' +
      '<div class="set-kv"><span>实例</span><span class="mono" id="aiConnInstance">—</span></div>' +
      '<div class="set-kv"><span>身份校验</span><b id="aiConnIdentity">—</b></div>' +
      '<div class="set-kv"><span>工具</span><b id="aiConnTools">—</b></div>' +
      '<div class="set-actions" id="aiConnActions">' +
      '<button class="set-btn" type="button" data-ai-act="copy-codex">复制 Codex 配置</button>' +
      '<button class="set-btn" type="button" data-ai-act="copy-claude">复制 Claude Code 命令</button>' +
      '<button class="set-btn" type="button" data-ai-act="copy-json">复制通用 MCP 配置</button>' +
      '<button class="set-btn" type="button" data-ai-act="doctor">复制诊断</button>' +
      '<button class="set-btn" type="button" data-ai-act="restart">重启本地服务</button>' +
      '</div>' +
      '<p class="set-note" id="aiConnNote">连接状态每次打开本页时刷新；外部客户端通过安装目录里的 xuanji-mcp 入口连接当前实例。</p>';
    if (head && head.nextSibling) p.insertBefore(box, head.nextSibling);
    else p.insertBefore(box, p.firstChild);

    box.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('[data-ai-act]') : null;
      if (btn) onAction(btn.getAttribute('data-ai-act'));
    });
    bindExistingControls();
  }

  function note(text) {
    var el = $('#aiConnNote');
    if (el) el.textContent = text;
  }

  function bindExistingControls() {
    var p = pane();
    if (!p) return;
    var tokenBtn = p.querySelector('#setMcpToken');
    if (tokenBtn && !tokenBtn.dataset.aiBound) {
      tokenBtn.dataset.aiBound = '1';
      tokenBtn.addEventListener('click', function () {
        configure({ rotateToken: true }, '已重置连接令牌，外部客户端需要重新读取配置');
      });
    }
    var port = p.querySelector('[data-set-input="mcpPort"]');
    if (port && !port.dataset.aiBound) {
      port.dataset.aiBound = '1';
      port.addEventListener('change', function () {
        var value = parseInt(String(port.value || '').trim(), 10);
        if (!isFinite(value) || value < 1024 || value > 65535) {
          note('端口必须在 1024–65535 之间');
          port.value = state && state.instance ? state.instance.bridgePort : '';
          return;
        }
        configure({ port: value }, '端口已切换，桥正在重启');
      });
    }
    var on = p.querySelector('[data-set-toggle="mcpOn"]');
    if (on && !on.dataset.aiBound) {
      on.dataset.aiBound = '1';
      on.addEventListener('change', function () {
        configure({ enabled: !!on.checked }, on.checked ? '正在启动本地服务' : '本地服务已停止，外部客户端将无法连接');
      });
    }
    var write = p.querySelector('[data-set-toggle="mcpWrite"]');
    if (write && !write.dataset.aiBound) {
      write.dataset.aiBound = '1';
      write.addEventListener('change', function () {
        configure({ write: !!write.checked }, write.checked ? '已允许写操作（工具列表以写入权限重新发布）' : '写操作已关闭');
      });
    }
  }

  async function configure(patch, message) {
    if (busy) return;
    busy = true;
    if (message) note(message);
    try {
      var result = await api.ai.configure(patch);
      if (!result || result.ok === false) note('操作失败：' + ((result && result.error) || '未知错误'));
      else if (patch.enabled === false) note('本地服务已停止');
      else note(message || '已应用');
    } catch (err) {
      note('操作失败：' + (err && err.message ? err.message : err));
    } finally {
      busy = false;
      await refresh();
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function render() {
    ensureUi();
    if (!state) return;
    var checks = state.checks || {};
    var bridge = state.bridge || {};
    var inst = state.instance || {};
    var ok = checks.bridge && checks.identity && checks.token;
    setText('aiConnBridge', ok
      ? '运行中 · 端口 ' + (inst.bridgePort || bridge.port || '—') + (bridge.write ? ' · 可写' : ' · 只读')
      : (checks.bridge ? '桥已启动但身份不匹配' : '未运行'));
    setText('aiConnInstance', inst.instanceId
      ? String(inst.instanceId).slice(0, 8) + '… · 工作区 ' + (inst.workspaceId || '—')
      : '—');
    setText('aiConnIdentity', checks.identity ? '通过' : (checks.bridge ? '失败（请重启应用）' : '—'));
    setText('aiConnTools', state.tools ? String(state.tools) + ' 个' : '—');
    var bridgeEl = document.getElementById('aiConnBridge');
    if (bridgeEl) bridgeEl.style.color = ok ? 'var(--ok)' : 'var(--warn)';

    var p = pane();
    if (p) {
      var on = p.querySelector('[data-set-toggle="mcpOn"]');
      if (on && document.activeElement !== on) on.checked = !!checks.bridge;
      var write = p.querySelector('[data-set-toggle="mcpWrite"]');
      if (write && document.activeElement !== write) write.checked = !!state.write;
      var port = p.querySelector('[data-set-input="mcpPort"]');
      if (port && document.activeElement !== port) port.value = inst.bridgePort ? String(inst.bridgePort) : '';
      var chip = p.querySelector('.set-chip .mono');
      if (chip && checks.token) chip.textContent = '已生成 · 仅在实例记录中使用';
    }
  }

  async function refresh() {
    try {
      state = await api.ai.bridge();
      render();
    } catch (err) {
      note('读取连接状态失败：' + (err && err.message ? err.message : err));
    }
  }

  function launcherConfig() {
    var l = state && state.launcher;
    if (!l) return null;
    return l;
  }

  function codexConfig() {
    var l = launcherConfig();
    if (!l) return '';
    var args = l.args.map(function (a) { return JSON.stringify(a); }).join(', ');
    return '[mcp_servers.xhgcs]\ncommand = ' + JSON.stringify(l.command) + '\nargs = [' + args + ']\nstartup_timeout_sec = 30\n';
  }

  function claudeCommand() {
    var l = launcherConfig();
    if (!l) return '';
    var tail = [l.command].concat(l.args).map(function (part) {
      return /\s/.test(part) ? '"' + part + '"' : part;
    }).join(' ');
    return 'claude mcp add xhgcs -- ' + tail;
  }

  function genericConfig() {
    var l = launcherConfig();
    if (!l) return '';
    return JSON.stringify({ mcpServers: { xhgcs: { command: l.command, args: l.args } } }, null, 2);
  }

  function doctorText() {
    if (!state) return '';
    var report = {
      app: {
        version: state.instance && state.instance.appVersion,
        instanceId: state.instance && state.instance.instanceId,
        workspaceId: state.instance && state.instance.workspaceId,
        bridgePort: state.instance && state.instance.bridgePort
      },
      checks: state.checks,
      bridge: state.bridge ? {
        sha: state.bridge.sha,
        revision: state.bridge.revision,
        tools: state.bridge.tools,
        write: state.bridge.write
      } : null,
      tools: state.tools,
      launcher: state.launcher
    };
    return JSON.stringify(report, null, 2);
  }

  function copy(text, okText) {
    if (!text) { note('当前不可用：请先启动桌面版'); return; }
    var done = function () { note(okText + '（已复制到剪贴板）'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { note('复制失败，请手动选择配置文本'); }
      document.body.removeChild(ta);
    }
  }

  async function onAction(action) {
    if (action === 'copy-codex') return copy(codexConfig(), 'Codex 配置');
    if (action === 'copy-claude') return copy(claudeCommand(), 'Claude Code 命令');
    if (action === 'copy-json') return copy(genericConfig(), '通用 MCP 配置');
    if (action === 'doctor') return copy(doctorText(), '诊断信息');
    if (action === 'restart') {
      if (busy) return;
      busy = true;
      note('正在重启本地服务…');
      try {
        await api.restartServices();
        note('本地服务已重启');
      } catch (err) {
        note('重启失败：' + (err && err.message ? err.message : err));
      } finally {
        busy = false;
        await refresh();
      }
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(function () { if (visible()) refresh(); }, 4000);
  }

  function boot() {
    ensureUi();
    refresh();
    startPolling();
    document.addEventListener('click', function (event) {
      var t = event.target && event.target.closest ? event.target : null;
      if (t && (t.closest('[data-set-group="mcp"]') || t.closest('#settingsBtn'))) setTimeout(refresh, 200);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.XHGCS_AI_CONN = { refresh: refresh, get state() { return state; } };
})();
