// ui5 样品：左栏四分区折叠 / 通道值+窗口统计 / 告警区
// 不改现有渲染逻辑；每 1s 复用 views-core 的 renderChannelVals 节拍补文本。
(function () {
  'use strict';
  var COLLAPSE_KEY = 'xhgcs.ui5.collapse.v1';
  var collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch (err) { collapsed = {}; }
  function saveCollapse() { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (err) {} }

  function initSections() {
    var secs = Array.prototype.slice.call(document.querySelectorAll('.widgetbox .wb-scroll > .wb-sec'));
    secs.forEach(function (sec, index) {
      if (sec.dataset.ui5Init === '1') return;
      var head = sec.querySelector('.sec-head');
      if (!head) return;
      var title = (head.querySelector('span') || {}).textContent || ('sec' + index);
      var key = String(title).trim() || ('sec' + index);
      sec.dataset.ui5Init = '1';
      sec.dataset.ui5Key = key;
      sec.classList.toggle('ui5-collapsed', Boolean(collapsed[key]));
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', String(!collapsed[key]));
      head.title = (collapsed[key] ? '展开' : '收起') + key;
      function toggle() {
        collapsed[key] = !collapsed[key];
        sec.classList.toggle('ui5-collapsed', collapsed[key]);
        head.setAttribute('aria-expanded', String(!collapsed[key]));
        head.title = (collapsed[key] ? '展开' : '收起') + key;
        saveCollapse();
      }
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
    });
  }

  function channelList() {
    return Array.prototype.slice.call(document.querySelectorAll('#lpChannelList .lp-channel'));
  }

  function latestText(ch) {
    var data = ch.data || [];
    for (var i = data.length - 1; i >= 0; i -= 1) {
      if (Number.isFinite(Number(data[i]))) return window.XHGCS.formatChannelValue(ch, data[i]);
    }
    return '—';
  }

  function refreshChannels() {
    var X = window.XHGCS;
    var all = X.allChannels ? X.allChannels() : (X.state.channels || []);
    var rows = channelList();
    rows.forEach(function (row, index) {
      var ch = all[index];
      if (!ch) return;
      var val = row.querySelector('.ui5-latest');
      if (!val) {
        val = document.createElement('span');
        val.className = 'ui5-latest';
        var unit = row.querySelector('.lp-unit');
        if (unit) row.insertBefore(val, unit); else row.appendChild(val);
      }
      val.textContent = latestText(ch);
      if (row.dataset.ui5Ch !== ch.id) row.dataset.ui5Ch = ch.id;
    });
    var count = document.getElementById('lpChannelCount');
    if (count) count.textContent = String(all.length);
  }

  var winBuilt = '';
  function refreshWindowStats() {
    var host = document.getElementById('ui5WinStats');
    if (!host) return;
    var X = window.XHGCS;
    var V = window.XHGCS_VIEWS;
    var all = X.allChannels ? X.allChannels() : (X.state.channels || []);
    var ids = all.map(function (ch) { return ch.id; }).join(',');
    if (ids !== winBuilt) {
      winBuilt = ids;
      var html = '<div class="ui5-winstat-head"><span>通道</span><span>最小</span><span>均值</span><span>最大</span></div>';
      all.forEach(function (ch) {
        html += '<div class="ui5-winstat-row" data-ui5-ch="' + X.esc(ch.id) + '"><span>' + X.esc(ch.name) + '</span><span>—</span><span>—</span><span>—</span></div>';
      });
      host.innerHTML = html;
    }
    all.forEach(function (ch) {
      var row = host.querySelector('[data-ui5-ch="' + (window.CSS && CSS.escape ? CSS.escape(ch.id) : ch.id) + '"]');
      if (!row) return;
      var range = V.dockWindow ? V.dockWindow(ch) : null;
      var cells = row.querySelectorAll('span');
      if (!cells.length) return;
      cells[0].textContent = ch.name;
      cells[1].textContent = range ? X.formatChannelValue(ch, range.min) : '—';
      cells[2].textContent = range ? X.formatChannelValue(ch, range.avg) : '—';
      cells[3].textContent = range ? X.formatChannelValue(ch, range.max) : '—';
    });
  }

  function timeText(ms) {
    var d = new Date(Number(ms) || Date.now());
    return d.toTimeString().slice(0, 8);
  }

  var alarmSig = '';
  function refreshAlarms() {
    var V = window.XHGCS_VIEWS;
    var list = document.getElementById('ui5AlarmList');
    var countEl = document.getElementById('ui5AlarmCount');
    if (!list || !V || typeof V.dockAlarmGroups !== 'function') return;
    var groups = V.dockAlarmGroups() || [];
    var unack = groups.filter(function (g) { return !g.ack; });
    if (countEl) countEl.textContent = String(unack.length);
    var rows = unack.slice(0, 8);
    if (!rows.length) {
      if (alarmSig !== 'empty') { alarmSig = 'empty'; list.innerHTML = '<div class="ui5-alarm-empty">无告警</div>'; }
      return;
    }
    var sig = rows.map(function (g) { return g.key + '|' + (g.level || 'warn'); }).join(',');
    if (sig !== alarmSig) {
      alarmSig = sig;
      var html = '';
      rows.forEach(function (g) {
        var level = g.level === 'high' ? 'danger' : 'warn';
        html += '<div class="ui5-alarm" data-ui5-key="' + window.XHGCS.esc(g.key) + '">'
          + '<i class="ui5-alarm-dot ' + level + '"></i>'
          + '<span class="ui5-alarm-name">' + window.XHGCS.esc(g.name || g.channelId || '告警') + '</span>'
          + '<span class="ui5-alarm-time">' + timeText(g.lastTime) + '</span></div>';
      });
      list.innerHTML = html;
    }
    rows.forEach(function (g) {
      var row = list.querySelector('[data-ui5-key="' + (window.CSS && CSS.escape ? CSS.escape(g.key) : g.key) + '"]');
      if (row) { var t = row.querySelector('.ui5-alarm-time'); if (t) t.textContent = timeText(g.lastTime); }
    });
  }

  function refresh() {
    refreshChannels();
    refreshWindowStats();
    refreshAlarms();
  }

  function init() {
    initSections();
    refresh();
    var V = window.XHGCS_VIEWS;
    if (V) {
      if (typeof V.renderChannelVals === 'function' && !V.__ui5Wrapped) {
        var origVals = V.renderChannelVals;
        V.renderChannelVals = function () {
          var result = origVals.apply(this, arguments);
          refresh();
          return result;
        };
        V.__ui5Wrapped = true;
      }
      if (typeof V.renderLeftPanel === 'function' && !V.__ui5LeftWrapped) {
        var origLeft = V.renderLeftPanel;
        V.renderLeftPanel = function () {
          var result = origLeft.apply(this, arguments);
          refreshChannels();
          return result;
        };
        V.__ui5LeftWrapped = true;
      }
    }
  }

  function ready() {
    if (window.XHGCS && window.XHGCS_VIEWS) { init(); return; }
    setTimeout(ready, 40);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
