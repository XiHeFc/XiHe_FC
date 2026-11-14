(function () {
  'use strict';

  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;
  const state = X.state;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  let currentId = '';
  let customRuntime = null;
  let mapCanvas = null;
  let drag = null;
  let lastTickAt = 0;
  let resizeFrame = 0;
  const ref = {};

  function escape(value) {
    return X.esc ? X.esc(value) : String(value == null ? '' : value);
  }

  function definition(id) {
    return V.getView ? V.getView(id) : null;
  }

  function empty(title, note) {
    ref.body.innerHTML = '<div class="chart-work-empty"><b>' + escape(title)
      + '</b><span>' + escape(note) + '</span></div>';
  }

  function disposeCustom() {
    if (!customRuntime) return;
    try { customRuntime.dispose(); } catch (err) {}
    customRuntime = null;
  }

  function syncPalette() {
    const open = Boolean(currentId && ref.root && !ref.root.classList.contains('hidden'));
    $$('.sw-item').forEach(function (item) {
      item.classList.toggle('mini-active', open && item.dataset.subview === currentId);
    });
  }

  function clampPosition() {
    if (!ref.root || ref.root.classList.contains('hidden')) return;
    const wrap = $('.chart-wrap');
    if (!wrap || (!ref.root.style.left && !ref.root.style.top)) return;
    const maxLeft = Math.max(4, wrap.clientWidth - ref.root.offsetWidth - 4);
    const maxTop = Math.max(4, wrap.clientHeight - ref.root.offsetHeight - 4);
    if (ref.root.style.left) ref.root.style.left = Math.max(4, Math.min(maxLeft, parseFloat(ref.root.style.left) || 0)) + 'px';
    if (ref.root.style.top) ref.root.style.top = Math.max(4, Math.min(maxTop, parseFloat(ref.root.style.top) || 0)) + 'px';
  }

  function prepareBody(id) {
    disposeCustom();
    mapCanvas = null;
    ref.body.innerHTML = '';
    if (id === 'map') {
      mapCanvas = document.createElement('canvas');
      mapCanvas.className = 'cwb-map-canvas';
      ref.body.appendChild(mapCanvas);
      return;
    }
    if (['bar', 'table', 'gauge'].indexOf(id) >= 0) return;
    const def = definition(id);
    if (!def || def.builtin) return;
    const host = document.createElement('div');
    host.className = 'view-plugin-host cwb-custom-host';
    ref.body.appendChild(host);
    try {
      customRuntime = V.mountDetachedView ? V.mountDetachedView(id, host) : null;
    } catch (err) {
      customRuntime = null;
      empty('预览失败', err && err.message ? err.message : String(err));
    }
  }

  function open(id) {
    const def = definition(id);
    if (!def || !ref.root) return false;
    if (id === 'wave') {
      close();
      return true;
    }
    const alreadyOpen = currentId === id && !ref.root.classList.contains('hidden');
    if (alreadyOpen) {
      close();
      return false;
    }
    currentId = id;
    ref.root.dataset.kind = id;
    ref.title.textContent = def.name || '小工作区';
    ref.desc.textContent = def.desc || '叠加在折线图上查看';
    ref.icon.textContent = def.icon || '▦';
    ref.root.classList.remove('hidden');
    prepareBody(id);
    renderWork(true);
    syncPalette();
    requestAnimationFrame(clampPosition);
    return true;
  }

  function close() {
    currentId = '';
    disposeCustom();
    mapCanvas = null;
    if (ref.root) {
      ref.root.classList.add('hidden');
      ref.root.dataset.kind = '';
    }
    if (ref.body) ref.body.innerHTML = '';
    syncPalette();
  }

  function expand() {
    const id = currentId;
    if (!id) return;
    close();
    if (V.switchSubView) V.switchSubView(id);
  }

  function renderBars() {
    const channels = X.plotChannels().slice(0, 10);
    if (!channels.length) {
      empty('没有可预览的通道', '在右侧数据栏恢复曲线，或在图上右键勾选数据。');
      return;
    }
    ref.body.innerHTML = '<div class="cwb-bar-list">' + channels.map(function (ch) {
      const value = ch.data.length ? ch.data[ch.data.length - 1] : 0;
      const ratio = X.clamp((value - ch.range[0]) / Math.max(1e-9, ch.range[1] - ch.range[0]), 0, 1);
      return '<div class="cwb-bar-row">'
        + '<div class="cwb-bar-name"><i style="background:' + escape(X.viewColor(ch.color)) + '"></i><span>' + escape(ch.name) + '</span></div>'
        + '<div class="cwb-bar-track"><div class="cwb-bar-fill" style="width:' + (ratio * 100).toFixed(1)
        + '%;background:' + escape(X.viewColor(ch.color)) + '"></div></div>'
        + '<span class="cwb-bar-value">' + escape(X.formatChannelValue(ch, value)) + (ch.unit ? ' ' + escape(ch.unit) : '') + '</span>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderTable() {
    const channels = X.plotChannels();
    const dataLen = Math.max.apply(null, channels.map(function (ch) { return ch.data.length; }).concat([0]));
    if (!channels.length || !dataLen) {
      empty('暂无数据表', '开启仿真或连接串口后，这里会跟随主图显示最近几行。');
      return;
    }
    const rows = Math.min(10, dataLen);
    const start = dataLen - rows;
    let html = '<div class="cwb-table-scroll"><table><thead><tr><th>#</th>';
    html += channels.map(function (ch) {
      return '<th>' + escape(ch.name) + '</th>';
    }).join('');
    html += '</tr></thead><tbody>';
    for (let row = start; row < dataLen; row += 1) {
      html += '<tr><td>' + (row + 1) + '</td>';
      channels.forEach(function (ch) {
        const value = ch.data[row] == null ? '--' : X.formatChannelValue(ch, ch.data[row]);
        html += '<td>' + escape(value) + '</td>';
      });
      html += '</tr>';
    }
    ref.body.innerHTML = html + '</tbody></table></div>';
  }

  function renderGauges() {
    const channels = X.plotChannels().slice(0, 8);
    if (!channels.length) {
      empty('没有可预览的仪表', '先选择至少一个通道。');
      return;
    }
    const TH = X.canvasColors ? X.canvasColors() : {};
    ref.body.innerHTML = '<div class="cwb-gauge-grid">' + channels.map(function (ch) {
      const value = ch.data.length ? ch.data[ch.data.length - 1] : ch.base;
      const ratio = X.clamp((value - ch.range[0]) / Math.max(1e-9, ch.range[1] - ch.range[0]), 0, 1);
      const degrees = (ratio * 360).toFixed(1);
      return '<div class="cwb-gauge-card">'
        + '<div class="cwb-gauge-ring" style="background:conic-gradient(' + escape(X.viewColor(ch.color)) + ' 0deg '
        + degrees + 'deg,' + escape(TH.trackRing || 'rgba(127,127,127,.18)') + ' ' + degrees + 'deg 360deg)">'
        + '<span>' + Math.round(ratio * 100) + '%</span></div>'
        + '<div class="cwb-gauge-copy"><b>' + escape(ch.name) + '</b><small>'
        + escape(X.formatChannelValue(ch, value)) + (ch.unit ? ' ' + escape(ch.unit) : '') + '</small></div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderMap() {
    if (!mapCanvas) return;
    const info = V.ensureCanvas ? V.ensureCanvas(mapCanvas) : null;
    if (!info) return;
    const ctx = info.ctx;
    const W = info.w;
    const H = info.h;
    const TH = X.canvasColors ? X.canvasColors() : {};
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = TH.bg || 'transparent';
    ctx.fillRect(0, 0, W, H);
    const track = (state.track || []).slice(-500);
    const waypoints = state.waypoints || [];
    if (!track.length && !waypoints.length) {
      ctx.fillStyle = TH.dimText || '#7d8896';
      ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待航迹数据', W / 2, H / 2);
      return;
    }
    const points = track.concat(waypoints.map(function (point) { return { x: point.x, y: point.y }; }));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach(function (point) {
      minX = Math.min(minX, Number(point.x) || 0);
      maxX = Math.max(maxX, Number(point.x) || 0);
      minY = Math.min(minY, Number(point.y) || 0);
      maxY = Math.max(maxY, Number(point.y) || 0);
    });
    const pad = 18;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
    const offsetX = (W - spanX * scale) / 2;
    const offsetY = (H - spanY * scale) / 2;
    const project = function (point) {
      return {
        x: offsetX + ((Number(point.x) || 0) - minX) * scale,
        y: H - offsetY - ((Number(point.y) || 0) - minY) * scale
      };
    };
    ctx.strokeStyle = TH.grid || 'rgba(127,127,127,.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      ctx.beginPath(); ctx.moveTo(0, H * i / 4); ctx.lineTo(W, H * i / 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W * i / 4, 0); ctx.lineTo(W * i / 4, H); ctx.stroke();
    }
    if (track.length > 1) {
      ctx.beginPath();
      track.forEach(function (point, index) {
        const p = project(point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = TH.acc || '#38bdf8';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    waypoints.forEach(function (point) {
      const p = project(point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = TH.acc || '#38bdf8';
      ctx.fill();
    });
    if (track.length) {
      const p = project(track[track.length - 1]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = TH.strongText || '#fff';
      ctx.fill();
    }
  }

  function renderWork(force) {
    if (!currentId || !ref.root || ref.root.classList.contains('hidden')) return;
    const now = performance.now();
    if (!force && now - lastTickAt < 100) return;
    lastTickAt = now;
    const id = currentId;
    if (id === 'bar') renderBars();
    else if (id === 'table') renderTable();
    else if (id === 'gauge') renderGauges();
    else if (id === 'map') renderMap();
    else if (customRuntime) {
      try { customRuntime.update(); } catch (err) {
        empty('自定义视图预览失败', err && err.message ? err.message : String(err));
      }
    }
  }

  function tick(ts) {
    if (!currentId || !ref.root || ref.root.classList.contains('hidden')) return;
    if (ts - lastTickAt < 120) return;
    renderWork(true);
  }

  function bindDrag() {
    ref.head.addEventListener('pointerdown', function (event) {
      if (event.target.closest('button')) return;
      const wrap = $('.chart-wrap');
      if (!wrap) return;
      const wrapRect = wrap.getBoundingClientRect();
      const rect = ref.root.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left - wrapRect.left,
        top: rect.top - wrapRect.top,
        width: rect.width,
        height: rect.height
      };
      ref.root.style.left = drag.left + 'px';
      ref.root.style.top = drag.top + 'px';
      ref.root.style.right = 'auto';
      ref.root.style.bottom = 'auto';
      try { ref.head.setPointerCapture(event.pointerId); } catch (err) {}
      event.preventDefault();
    });
    ref.head.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wrap = $('.chart-wrap');
      if (!wrap) return;
      const maxLeft = Math.max(4, wrap.clientWidth - drag.width - 4);
      const maxTop = Math.max(4, wrap.clientHeight - drag.height - 4);
      const left = Math.max(4, Math.min(maxLeft, drag.left + event.clientX - drag.startX));
      const top = Math.max(4, Math.min(maxTop, drag.top + event.clientY - drag.startY));
      ref.root.style.left = Math.round(left) + 'px';
      ref.root.style.top = Math.round(top) + 'px';
    });
    const finish = function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      try { ref.head.releasePointerCapture(event.pointerId); } catch (err) {}
    };
    ref.head.addEventListener('pointerup', finish);
    ref.head.addEventListener('pointercancel', finish);
  }

  function init() {
    ref.root = $('#chartWorkbench');
    ref.head = $('#chartWorkHead');
    ref.body = $('#chartWorkBody');
    ref.title = $('#chartWorkTitle');
    ref.desc = $('#chartWorkDesc');
    ref.icon = $('#chartWorkIcon');
    if (!ref.root || !ref.head || !ref.body) return;
    $('#btnChartWorkClose').addEventListener('click', close);
    $('#btnChartWorkExpand').addEventListener('click', expand);
    $('#btnChartWorkRefresh').addEventListener('click', function () { renderWork(true); });
    bindDrag();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(function () {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(function () {
          resizeFrame = 0;
          if (customRuntime && customRuntime.resize) {
            try { customRuntime.resize(); } catch (err) {}
          }
          clampPosition();
          renderWork(true);
        });
      });
      observer.observe(ref.root);
    }
    window.addEventListener('xhgcs:theme-changed', function () { renderWork(true); });
    window.addEventListener('xhgcs:fx-changed', function () { renderWork(true); });
    window.addEventListener('resize', clampPosition);
  }

  V.openChartWork = open;
  V.closeChartWork = close;
  V.expandChartWork = expand;
  V.renderChartWork = renderWork;
  V.tickChartWork = tick;
  V.syncChartWorkPalette = syncPalette;
  V.chartWorkId = function () { return currentId; };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
