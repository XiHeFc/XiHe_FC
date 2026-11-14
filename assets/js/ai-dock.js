(function () {
  'use strict';
  // 右坞 AI 对话：接主进程的 DSH / ACP 会话。没有桌面桥时明确提示，不回落演示回复。
  var desktop = window.XHGCS_DESKTOP;
  var chatApi = desktop && desktop.aiChat;
  var webApi = desktop && desktop.aiWeb;

  var state = {
    messages: [],
    running: false,
    sending: false,
    streaming: null,
    tools: [],
    model: '',
    modelLabel: '',
    version: '',
    status: 'idle',
    available: null,
    error: ''
  };
  var els = {};

  function $(s) { return document.querySelector(s); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clock(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function boot() {
    els.chat = $('#chat');
    els.input = $('#composerInput');
    els.send = $('#sendBtn');
    els.model = $('.cm-model');
    els.modelText = $('.cm-model span');
    els.taskCount = document.querySelector('.dock-tab[data-pane="task"] .n');
    if (!els.chat || !els.input || !els.send) return;
    if (webApi){ watchPalette(); embedDshWeb(); return; }
    if (!chatApi){
      desktopOnly();
      if (!desktopOnly.bound){
        desktopOnly.bound = true;
        els.send.addEventListener('click', desktopOnly);
        els.input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); desktopOnly(); }
        });
      }
      return;
    }
    bootNative();
  }

  // 采集主界面当前配色令牌，交给 DSH 生成同色系主题
  function readPalette() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var get = function (name) { return cs.getPropertyValue(name).trim(); };
      return {
        bg: get('--bg'), panel: get('--panel'), panel2: get('--panel-2'), panel3: get('--panel-3'),
        ink: get('--ink'), ink2: get('--ink-2'), ink3: get('--ink-3'),
        ha: get('--ha'), hb: get('--hb'),
        amber: get('--amber'), amber2: get('--amber-2'), onAmber: get('--on-amber'),
        ok: get('--ok'), warn: get('--warn'), danger: get('--danger')
      };
    } catch (err) { return null; }
  }

  // 主题变化时把新配色实时推给已打开的 DSH 视图（聊天与设置页）
  var lastPaletteSig = '';
  var paletteRevision = 0;
  var paletteBusy = false;
  var paletteTimer = 0;
  var paletteRetries = 0;
  function watchPalette() {
    function schedule(force) {
      if (force) { paletteRevision++; paletteRetries = 0; }
      clearTimeout(paletteTimer);
      paletteTimer = setTimeout(sync, 0);
    }
    async function sync() {
      if (paletteBusy) return;
      var p = readPalette();
      if (!p) return;
      var scheme = getComputedStyle(document.documentElement).colorScheme || '';
      var theme = scheme.indexOf('light') >= 0 ? 'light' : 'dark';
      var sig = theme + '|' + JSON.stringify(p) + '|' + paletteRevision;
      if (sig === lastPaletteSig) return;
      paletteBusy = true;
      try {
        var result = await webApi.applyPalette(theme, p);
        if (result && result.ok && result.applied > 0) {
          lastPaletteSig = sig; paletteRetries = 0;
        } else if (paletteRetries++ < 8) paletteTimer = setTimeout(sync, 250);
      } catch (err) {
        if (paletteRetries++ < 8) paletteTimer = setTimeout(sync, 250);
      } finally {
        paletteBusy = false;
        if (sig !== theme + '|' + JSON.stringify(readPalette()) + '|' + paletteRevision) schedule(false);
      }
    }
    window.addEventListener('xhgcs:theme-changed', function () { schedule(true); });
    window.addEventListener('xhgcs:ai-frame-ready', function () { schedule(true); });
    new MutationObserver(function () { schedule(true); }).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme', 'data-theme-pol', 'style']
    });
    schedule(true);
  }

  // 随包 DSH 的 Web UI：在「对话」页嵌入它自己的界面；失败时回退到原生对话。
  var webStarting = false;
  async function embedDshWeb() {
    if (webStarting || document.getElementById('dshWebFrame')) return;
    webStarting = true;
    els.chat.textContent = '';
    els.chat.setAttribute('aria-busy', 'true');
    els.input.disabled = true;
    els.send.disabled = true;
    els.input.placeholder = 'AI 正在启动，完成后即可输入';
    var notice = document.createElement('div');
    notice.className = 'ai-note';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'margin:16px;color:var(--ink-2);font-size:12px;line-height:1.8';
    notice.textContent = '正在启动内置 AI…';
    els.chat.appendChild(notice);
    var startedAt = Date.now();
    var progress = setInterval(function () {
      var seconds = Math.floor((Date.now() - startedAt) / 1000);
      notice.textContent = '正在启动内置 AI… ' + seconds + ' 秒。你可以继续使用其他功能。';
    }, 1000);
    var res = null;
    try {
      // 以当前 computed color-scheme 为准（主题家族 ≠ 明暗极性）；默认按深色
      var scheme = getComputedStyle(document.documentElement).colorScheme || '';
      var theme = scheme.indexOf('light') >= 0 ? 'light' : 'dark';
      res = await webApi.start(theme, readPalette());
    } catch (err) { res = { ok: false, error: err && err.message ? err.message : String(err) }; }
    clearInterval(progress);
    webStarting = false;
    els.chat.removeAttribute('aria-busy');
    if (!res || res.ok === false || !res.url){
      notice.textContent = 'AI 启动失败：' + ((res && res.error) || '未知原因');
      var retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'set-btn'; retry.textContent = '重试';
      retry.addEventListener('click', embedDshWeb);
      notice.appendChild(document.createElement('br')); notice.appendChild(retry);
      els.input.placeholder = 'AI 尚未启动，请重试';
      return;
    }
    var pane = document.querySelector('.dock-pane[data-pane="chat"]');
    if (!pane) return;
    var host = document.createElement('div');
    host.id = 'dshWebHost';
    host.style.cssText = 'flex:1;min-height:0;display:flex;background:var(--panel)';
    var frame = document.createElement('iframe');
    frame.id = 'dshWebFrame';
    frame.title = 'DSH';
    frame.addEventListener('load', function () { window.dispatchEvent(new Event('xhgcs:ai-frame-ready')); });
    frame.src = res.url;
    frame.style.cssText = 'flex:1;width:100%;height:100%;border:0;background:var(--bg)';
    host.appendChild(frame);
    if (els.chat && els.chat.parentNode === pane) els.chat.remove();
    var composer = pane.querySelector('.composer');
    if (composer) composer.remove();
    pane.appendChild(host);
    // 后台启动完成时保留用户当前坞宽，避免主工作区突然跳动。
  }

  function bootNative() {
    els.chat.innerHTML = '';
    els.send.addEventListener('click', onSend);
    els.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        onSend();
      }
    });
    chatApi.onEvent(onEvent);
    chatApi.status().then(function (status) {
      if (!status) return;
      state.messages = status.messages || [];
      state.model = status.modelLabel || status.model || '';
      state.version = status.version || '';
      state.running = Boolean(status.running);
      state.status = status.status || 'idle';
      state.available = status.available !== false;
      renderAll();
      updateChrome();
      if (!state.available) renderNotice('内置 DSH 不可用：安装包缺少随包运行时。请重新安装或修复安装后再试。');
      else if (status.error) renderNotice('内置 DSH 连接失败：' + status.error);
    }).catch(function (err) {
      renderNotice('读取 AI 状态失败：' + (err && err.message ? err.message : err));
    });
  }

  function renderAll() {
    if (!els.chat) return;
    els.chat.innerHTML = '';
    if (!state.messages.length) {
      renderNotice('内置 DSH 已就绪。描述你要的图表或分析，例如「把 CH1 和 CH2 放到同一页，窗口 30 秒」。');
    }
    state.messages.forEach(function (message) {
      appendMessage(message.role === 'user' ? 'user' : 'assistant', message.text, message.at, message.tools);
    });
    scrollBottom();
  }

  function removeNotices() {
    if (!els.chat) return;
    Array.prototype.forEach.call(els.chat.querySelectorAll('.ai-note'), function (node) { node.remove(); });
  }

  function renderNotice(text) {
    if (!els.chat) return;
    var div = document.createElement('div');
    div.className = 'ai-note';
    div.style.cssText = 'margin:10px 12px;padding:9px 10px;border:1px solid var(--ha);border-radius:8px;color:var(--ink-3);font-size:10.5px;line-height:1.6';
    div.textContent = text;
    els.chat.appendChild(div);
  }

  function desktopOnly() {
    if (!els.chat) return;
    els.chat.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'ai-note';
    div.style.cssText = 'margin:10px 12px;padding:9px 10px;border:1px solid var(--ha);border-radius:8px;color:var(--ink-3);font-size:10.5px;line-height:1.6';
    div.textContent = '请在璇玑桌面版使用内置助手。网页预览运行在浏览器里，不会启动随包 DSH。';
    els.chat.appendChild(div);
  }

  function messageHead(role) {
    if (role === 'user') {
      return '<div class="msg-head"><span class="msg-role">你</span><span class="msg-time">' + clock() + '</span></div>';
    }
    return '<div class="msg-head"><span class="msg-mark"><svg viewBox="0 0 16 16"><path d="M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6Z"/><circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none"/></svg></span><span class="msg-role">' + (state.version ? 'DSH · ' + esc(state.version) : 'XiHe AI') + '</span><span class="msg-time">' + clock() + '</span></div>';
  }

  function appendMessage(role, text, at, tools) {
    removeNotices();
    var msg = document.createElement('div');
    msg.className = 'msg' + (role === 'user' ? ' user' : '');
    msg.innerHTML = messageHead(role) + '<div class="msg-body"></div>';
    msg.querySelector('.msg-time').textContent = clock(at);
    msg.querySelector('.msg-body').textContent = String(text || '');
    if (role !== 'user' && Array.isArray(tools) && tools.length) {
      tools.forEach(function (tool) {
        var line = document.createElement('div');
        line.className = 'tool-line';
        var label = String(tool.title || '').replace(/^mcp__xhgcs__/, '') || '工具调用';
        var ok = tool.status === 'completed';
        line.innerHTML = '<i class="dot ' + (ok ? 'ok' : 'off') + '"></i><span></span>';
        line.querySelector('span').textContent = label + ' · ' + (tool.status === 'completed' ? '完成' : tool.status === 'failed' ? '失败' : '进行中');
        msg.appendChild(line);
      });
    }
    els.chat.appendChild(msg);
    return msg;
  }

  function startStreaming() {
    var msg = appendMessage('assistant', '', null);
    state.streaming = { el: msg, body: msg.querySelector('.msg-body'), text: '', tools: [] };
    scrollBottom();
    return state.streaming;
  }

  function currentStreaming() {
    if (!state.streaming) startStreaming();
    return state.streaming;
  }

  function addToolEvent(event) {
    var stream = currentStreaming();
    var line = null;
    if (event.phase === 'started') {
      line = document.createElement('div');
      line.className = 'tool-line';
      line.dataset.toolCallId = event.toolCallId || '';
      line.innerHTML = '<i class="dot off"></i><span></span>';
      stream.el.appendChild(line);
      stream.tools.push(event);
    } else {
      var nodes = stream.el.querySelectorAll('.tool-line');
      for (var i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].dataset.toolCallId === event.toolCallId) { line = nodes[i]; break; }
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'tool-line';
        line.dataset.toolCallId = event.toolCallId || '';
        line.innerHTML = '<i class="dot off"></i><span></span>';
        stream.el.appendChild(line);
      }
    }
    var ok = event.status === 'completed';
    var dot = line.querySelector('.dot');
    if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'off');
    var label = String(event.title || '').replace(/^mcp__xhgcs__/, '');
    if (!label) label = '工具调用';
    var statusText = event.status === 'failed' ? '失败' : event.status === 'completed' ? '完成' : '进行中';
    var span = line.querySelector('span');
    if (span) span.textContent = label + ' · ' + statusText + (event.text ? ' · ' + event.text.replace(/\s+/g, ' ').slice(0, 90) : '');
    updateTaskCount();
    scrollBottom();
  }

  function updateTaskCount() {
    if (!els.taskCount) return;
    var count = 0;
    if (state.streaming) count = state.streaming.tools.length;
    els.taskCount.textContent = String(count);
    els.taskCount.style.display = count ? '' : 'none';
  }

  function syncSettings() {
    var text = document.getElementById('setDshText');
    var dot = document.getElementById('setDshDot');
    var ver = document.getElementById('setDshVersion');
    var model = document.getElementById('setDshModel');
    if (!text && !dot && !ver && !model) return;
    var failed = state.status === 'error' || state.available === false;
    var label = state.available === false ? '未安装运行时'
      : failed ? '连接失败'
      : state.status === 'starting' ? '启动中…'
      : state.running ? '回答中'
      : state.version ? '已连接' : '待命';
    if (text) text.textContent = label;
    if (dot) dot.className = 'dot ' + (failed ? 'off' : (state.running || state.version ? 'ok' : ''));
    if (ver) ver.textContent = state.version || '—';
    if (model) model.textContent = state.modelLabel || state.model || '—';
  }

  function updateChrome() {
    if (els.model) {
      var active = state.status !== 'error' && state.available !== false;
      var dot = els.model.querySelector('i.dot');
      if (dot) dot.className = 'dot' + (active ? ' ok' : ' off');
      if (els.modelText) {
        var model = state.modelLabel || state.model || '';
        var label = '内置 DSH';
        if (state.available === false) label += ' · 不可用';
        else if (state.status === 'starting') label += ' · 启动中…';
        else if (state.status === 'error') label += ' · 连接失败';
        else if (model) label += ' · ' + model;
        els.modelText.textContent = label;
      }
    }
    syncSettings();
    if (els.send) {
      if (state.running) {
        els.send.title = '停止生成';
        els.send.setAttribute('aria-label', '停止生成');
        els.send.innerHTML = '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"></rect></svg>';
      } else {
        els.send.title = '发送';
        els.send.setAttribute('aria-label', '发送');
        els.send.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 8h9M8.6 4.2 12.6 8l-4 3.8"/></svg>';
      }
    }
  }

  function scrollBottom() {
    if (els.chat) els.chat.scrollTop = els.chat.scrollHeight;
  }

  async function onSend() {
    if (state.running) {
      var cancelled = await chatApi.cancel();
      if (!cancelled || cancelled.ok === false) renderNotice('停止失败：' + ((cancelled && cancelled.error) || '未知原因'));
      return;
    }
    if (state.sending) return;
    var text = String(els.input.value || '').trim();
    if (!text) return;
    state.sending = true;
    els.input.value = '';
    try {
      var result = await chatApi.send(text);
      if (!result || result.ok === false) {
        renderNotice('发送失败：' + ((result && result.error) || '未知原因'));
        els.input.value = text;
      }
    } catch (err) {
      renderNotice('发送失败：' + (err && err.message ? err.message : err));
      els.input.value = text;
    } finally {
      state.sending = false;
    }
  }

  function onEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'message.added') {
      // 用户消息由任务开始时的本地渲染立即出现；assistant 完成消息在 task.completed 里处理。
      if (event.message && event.message.role === 'user') {
        if (!state.messages.some(function (m) { return m.id === event.message.id; })) {
          state.messages.push(event.message);
          appendMessage('user', event.message.text, event.message.at);
          scrollBottom();
        }
      }
      return;
    }
    if (event.type === 'assistant.open') {
      state.running = true;
      state.tools = [];
      startStreaming();
      updateChrome();
      return;
    }
    if (event.type === 'message.delta') {
      var stream = currentStreaming();
      stream.text += String(event.text || '');
      stream.body.textContent = stream.text;
      scrollBottom();
      return;
    }
    if (event.type === 'tool') {
      addToolEvent(event);
      return;
    }
    if (event.type === 'status') {
      state.status = event.status || state.status;
      if (event.model) state.model = event.model;
      if (event.version) state.version = event.version;
      updateChrome();
      return;
    }
    if (event.type === 'task.completed' || event.type === 'task.cancelled') {
      state.running = false;
      state.status = 'idle';
      if (event.message && event.message.role === 'assistant') {
        state.messages.push(event.message);
        if (state.streaming && state.streaming.el && state.streaming.el.parentNode) {
          state.streaming.el.parentNode.removeChild(state.streaming.el);
        }
        appendMessage('assistant', event.message.text, event.message.at, event.message.tools);
      } else if (state.streaming && state.streaming.el && !state.streaming.text) {
        // 启动阶段就被取消：没有半截回答，撤掉空气泡
        if (state.streaming.el.parentNode) state.streaming.el.parentNode.removeChild(state.streaming.el);
      }
      state.streaming = null;
      updateChrome();
      updateTaskCount();
      scrollBottom();
      return;
    }
    if (event.type === 'task.failed') {
      state.running = false;
      state.status = 'error';
      var failed = currentStreaming();
      var line = document.createElement('div');
      line.className = 'tool-line';
      line.innerHTML = '<i class="dot off"></i><span></span>';
      line.querySelector('span').textContent = '失败：' + String(event.error || '未知错误');
      failed.el.appendChild(line);
      updateChrome();
      return;
    }
    if (event.type === 'messages.cleared') {
      state.messages = [];
      renderAll();
      return;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.XHGCS_AI_DOCK = { refresh: function () { return chatApi.status().then(function (s) { if (s) { state.messages = s.messages || []; state.model = s.modelLabel || s.model; renderAll(); updateChrome(); } }); } };
})();
