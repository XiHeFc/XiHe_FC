(function () {
  'use strict';
  // 设置 → AI 助手：Agent 支持矩阵。内置 DSH 在软件内对话；外部客户端为“工具接入”，
  // 在它们自己的界面聊天。这里只展示真实检测结果与可复制配置，不改用户配置。
  var api = window.XHGCS_DESKTOP;
  if (!api || !api.aiClients) return;
  var state = null;
  var chat = null;

  function $(s) { return document.querySelector(s); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pane() { return document.querySelector('.set-pane[data-set-pane="ai"]'); }

  function ensureUi() {
    var p = pane();
    if (!p || document.getElementById('aiAgents')) return;
    var head = p.querySelector('.set-pane-head');
    var box = document.createElement('div');
    box.id = 'aiAgents';
    box.innerHTML =
      '<div class="set-kv"><span>当前 Agent</span><b id="aiAgentCurrent">内置 DSH（完整集成）</b></div>' +
      '<div class="set-kv"><span>模型</span><b id="aiAgentModel">—</b></div>' +
      '<div class="set-kv"><span>Claude Code</span><b id="aiAgentClaude">检测中…</b></div>' +
      '<div class="set-kv"><span>Codex</span><b id="aiAgentCodex">检测中…</b></div>' +
      '<div class="set-actions">' +
      '<button class="set-btn" type="button" data-agent-copy="claudeCommand">复制 Claude Code 命令</button>' +
      '<button class="set-btn" type="button" data-agent-copy="claudeJson">复制 Claude JSON</button>' +
      '<button class="set-btn" type="button" data-agent-copy="codex">复制 Codex 配置</button>' +
      '</div>' +
      '<p class="set-note" id="aiAgentNote">内置 DSH 在软件内对话；Claude Code / Codex 通过同一套 xhgcs 工具在各自界面使用。配置只在你点击复制后由你粘贴，软件不主动改写客户端配置。</p>';
    if (head && head.nextSibling) p.insertBefore(box, head.nextSibling);
    else p.insertBefore(box, p.firstChild);
    box.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('[data-agent-copy]') : null;
      if (btn) copy(keyOf(btn.getAttribute('data-agent-copy')), btn.getAttribute('data-agent-copy'));
    });
  }

  function keyOf(name) {
    if (!state) return '';
    var configs = state.configs || {};
    if (name === 'claudeJson') return configs.claudeJson || '';
    if (name === 'claudeCommand') return configs.claudeCommand || '';
    if (name === 'codex') return configs.codex || '';
    return '';
  }

  function note(text) {
    var el = $('#aiAgentNote');
    if (el) el.textContent = text;
  }

  function copy(text, label) {
    if (!text) { note('配置不可用：请确认软件在桌面版中运行'); return; }
    var done = function () { note(label + ' 已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { note('复制失败，请手动选择'); }
      document.body.removeChild(ta);
    }
  }

  function render() {
    if (!state) return;
    var clients = state.clients || {};
    var claude = clients.claude || {};
    var codex = clients.codex || {};
    setText('aiAgentClaude', claude.installed
      ? '工具接入 · 已配置' + (claude.matches ? '' : '（入口需更新）')
      : '工具接入 · 未配置（复制命令后粘贴）');
    setText('aiAgentCodex', codex.installed
      ? '工具接入 · 已配置' + (codex.matches ? '' : '（入口需更新，可复制新配置）')
      : '工具接入 · 未配置（复制配置后粘贴）');
    if (chat) {
      setText('aiAgentModel', chat.modelLabel || chat.model || (chat.available ? '内置 DSH' : '不可用'));
      if (!chat.available) setText('aiAgentCurrent', '内置 DSH（不可用）');
    }
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  async function refresh() {
    try {
      state = await api.aiClients.status();
      if (api.aiChat) {
        try { chat = await api.aiChat.status(); } catch (err) { chat = null; }
      }
      render();
    } catch (err) {
      note('读取 Agent 状态失败：' + (err && err.message ? err.message : err));
    }
  }

  function boot() {
    ensureUi();
    refresh();
    var timer = setInterval(function () {
      var p = pane();
      if (p && p.classList.contains('on')) refresh();
    }, 5000);
    document.addEventListener('click', function (event) {
      var t = event.target && event.target.closest ? event.target : null;
      if (t && t.closest('[data-set-group="ai"]')) setTimeout(refresh, 200);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.XHGCS_AI_AGENTS = { refresh: refresh };
})();
