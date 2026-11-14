(function () {
  'use strict';
  // UI10 壳与本地 MCP 桥之间的数据通道。
  // 旧壳由 assets/js/bridge.js 做这件事；新壳没有加载旧子系统，这里只做两件真实的事：
  //   1. 把数据链快照/序列推给桥（snapshot、channel_history 才有真实数据）
  //   2. 取回排队项并回执。界面尚未接入的操作如实回 ok:false，调用方不会把入队当成功。
  var X = window.XHGCS;
  if (!X || !X.state || !X.mcpFetch) return;

  var INTERVAL = 1500;
  var timer = 0;
  var busy = false;
  var pending = new Map();

  function payload() {
    var snap = {};
    try { snap = X.getDataSnapshot(10) || {}; } catch (err) { snap = {}; }
    var series = {};
    try {
      X.allChannels().forEach(function (ch) {
        var values = (Array.isArray(ch.data) ? ch.data : []).slice(-100).map(function (v) { return Number(v); });
        series[ch.id] = values;
        if (ch.name) series[ch.name] = values;
      });
    } catch (err) { /* 序列不可用时只推快照 */ }
    return Object.assign({}, snap, {
      series: series,
      simulation: X.state.simulation,
      shell: window.XHGCS_SHELL && window.XHGCS_SHELL.summary ? window.XHGCS_SHELL.summary() : null,
      sentAt: Date.now()
    });
  }

  function headers() {
    return { 'Content-Type': 'application/json' };
  }

  async function execute(item) {
    var shell = window.XHGCS_SHELL;
    if (shell && typeof shell.handleQueue === 'function') {
      return await shell.handleQueue(item);
    }
    // 没有接入执行器时，明确失败。旧壳的看板/脚本/引擎子系统在新壳里尚未恢复，
    // 让调用方立刻拿到可读原因，而不是等 8 秒超时。
    return { ok: false, error: '当前界面还没有接入「' + String(item.type || '未知操作') + '」；请先在 设置 → MCP 桥 查看支持范围' };
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      var posted = await X.mcpFetch('/api/state', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload())
      });
      if (!posted.ok) throw new Error('state ' + posted.status);
      var data = await posted.json();
      var queue = (data && data.remote && data.remote.queue) || [];
      for (var i = 0; i < queue.length; i++) {
        var item = queue[i];
        if (!item || !item.qid || pending.has(item.qid)) continue;
        var ok = false;
        var error = '';
        var out = null;
        try {
          out = await execute(item);
          ok = !(out && out.ok === false);
          error = ok ? '' : String((out && out.error) || '');
        } catch (err) {
          error = String((err && err.message) || err);
        }
        pending.set(item.qid, { id: item.qid, ok: ok, error: error, data: out || null });
      }
      if (pending.size) {
        var ids = Array.from(pending.keys());
        var ack = await X.mcpFetch('/api/ack', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ ids: ids, results: Array.from(pending.values()) })
        });
        if (ack.ok && (await ack.json()).ok === true) ids.forEach(function(id){ pending.delete(id); });
      }
    } catch (err) {
      // 桥未启动/重启中：下一轮再试，不打扰界面
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, INTERVAL);
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.XHGCS_SHELL_BRIDGE = { tick: tick, payload: payload };
})();
