// ui8 桥：桌面窗口按钮 + 品牌版本 + 主题按钮图标（显示“点击后将切换到的风格”）
(function () {
  'use strict';
  var D = window.XHGCS_DESKTOP;
  var wc = D && D.windowControls;
  var btns = Array.prototype.slice.call(document.querySelectorAll('.wincontrols .win-btn'));
  if (wc && btns.length === 3) {
    btns[0].addEventListener('click', function () { wc.minimize(); });
    btns[1].addEventListener('click', function () { wc.toggleMaximize(); });
    btns[2].addEventListener('click', function () { wc.close(); });
  }
  var sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = '地面控制站 · v0.30.1';

  /* 主题按钮：深色时显示太阳（点击→浅色），浅色时显示月亮（点击→深色） */
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    var MOON = '<svg viewBox="0 0 16 16"><path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8 5.6 5.6 0 1 0 13.2 9.4Z"></path></svg>';
    var SUN = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1"></circle><path d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5 11 5M5 11l-1.5 1.5"></path></svg>';
    var syncThemeIcon = function () {
      var pol = document.documentElement.getAttribute('data-theme-pol') ||
        ((document.documentElement.getAttribute('data-theme') || 'dark') === 'light' ? 'light' : 'dark');
      var dark = pol === 'dark';
      themeBtn.innerHTML = dark ? SUN : MOON;
      themeBtn.title = dark ? '切换到浅色模式' : '切换到深色模式';
      themeBtn.setAttribute('aria-label', themeBtn.title);
    };
    syncThemeIcon();
    new MutationObserver(syncThemeIcon).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-pol']
    });
  }

  /* 串口选口面板：Electron 主进程枚举到端口后（serial:choose）由这里负责显示与回传。
     旧壳用 serial-picker.js 做这件事，样稿前端没有加载它 —— 表现为「点了选口没反应、扫不到 COM 口」。
     window.__XHGCS_PICK_NAME__ 有值时（用户在端口下拉里点了某个 COM 名）自动回传匹配端口，不再二次询问。 */
  var portPicker = null;
  if (D && D.serial && D.serial.onChoose) {
    var pickerMask = null;
    var escHtml = function (value) {
      return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    };
    var pickerAnswer = function (requestId, portId) {
      try { window.__XHGCS_PICK_NAME__ = ''; } catch (e) {}
      try { D.serial.chooseResult({ requestId: requestId, portId: portId || '' }); } catch (e) {}
    };
    var pickerClose = function () {
      if (pickerMask && pickerMask.parentNode) pickerMask.parentNode.removeChild(pickerMask);
      pickerMask = null;
    };
    var pickerStyle = document.createElement('style');
    pickerStyle.id = 'xh-serial-picker-css';
    pickerStyle.textContent = [
      '.xhsp-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center}',
      '.xhsp{width:min(420px,86vw);max-height:70vh;display:flex;flex-direction:column;border:1px solid var(--hb);border-radius:12px;background:var(--panel);box-shadow:0 2px 0 rgba(0,0,0,.4);color:var(--ink);font-size:12px}',
      '.xhsp-head{display:flex;align-items:baseline;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--ha)}',
      '.xhsp-head b{font-size:14px;font-weight:600}',
      '.xhsp-head span{font-size:10.5px;color:var(--ink-3)}',
      '.xhsp-list{padding:8px;display:flex;flex-direction:column;gap:4px;overflow:auto}',
      '.xhsp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid transparent;border-radius:7px;background:var(--well);color:var(--ink);font:inherit;text-align:left;cursor:pointer}',
      '.xhsp-row:hover,.xhsp-row:focus-visible{border-color:var(--amber-line,var(--hb));outline:none}',
      '.xhsp-name{font-weight:600}',
      '.xhsp-tag{font-style:normal;font-size:9.5px;color:var(--amber-2,var(--ink-2));border:1px solid var(--amber-line,var(--hb));border-radius:4px;padding:0 4px;margin-left:6px}',
      '.xhsp-extra{font-family:var(--font-num,monospace);font-size:10px;color:var(--ink-3)}',
      '.xhsp-empty{padding:18px 16px;color:var(--ink-2);line-height:1.7}',
      '.xhsp-foot{display:flex;align-items:center;gap:10px;padding:10px 16px 14px;border-top:1px solid var(--ha)}',
      '.xhsp-hint{flex:1;font-size:10px;color:var(--ink-3);line-height:1.5}',
      '.xhsp-cancel{height:26px;padding:0 12px;border:1px solid var(--hb);border-radius:6px;background:transparent;color:var(--ink-2);font:inherit;cursor:pointer}',
      '.xhsp-cancel:hover{color:var(--ink);border-color:var(--hc)}'
    ].join('\n');
    document.head.appendChild(pickerStyle);

    var pickerShow = function (payload) {
      pickerClose();
      var ports = Array.isArray(payload.ports) ? payload.ports : [];
      pickerMask = document.createElement('div');
      pickerMask.className = 'xhsp-mask';
      var rows = ports.map(function (p, i) {
        var name = p.portName || p.displayName || ('端口 ' + (i + 1));
        var extra = [];
        if (p.vendorId) extra.push('VID:' + p.vendorId);
        if (p.productId) extra.push('PID:' + p.productId);
        var lastTag = payload.preset && payload.preset === p.portName ? '<i class="xhsp-tag">上次</i>' : '';
        return '<button type="button" class="xhsp-row" data-port-id="' + escHtml(p.portId) + '">'
          + '<span class="xhsp-name">' + escHtml(name) + lastTag + '</span>'
          + (extra.length ? '<span class="xhsp-extra">' + escHtml(extra.join(' ')) + '</span>' : '')
          + '</button>';
      }).join('');
      pickerMask.innerHTML = '<div class="xhsp" role="dialog" aria-modal="true" aria-label="选择串口">'
        + '<div class="xhsp-head"><b>选择串口</b><span>' + (ports.length ? '检测到 ' + ports.length + ' 个端口' : '没有检测到任何串口') + '</span></div>'
        + (ports.length ? '<div class="xhsp-list">' + rows + '</div>' : '<div class="xhsp-empty">系统没有枚举到串口设备。请检查 USB 连接、驱动与供电，然后重新打开端口下拉重试。</div>')
        + '<div class="xhsp-foot"><span class="xhsp-hint">选择后立即连接；Esc 取消</span><button type="button" class="xhsp-cancel">取消</button></div>'
        + '</div>';
      document.body.appendChild(pickerMask);
      pickerMask.addEventListener('click', function (e) {
        if (e.target === pickerMask) { pickerAnswer(payload.requestId, ''); pickerClose(); }
      });
      var cancel = pickerMask.querySelector('.xhsp-cancel');
      if (cancel) cancel.addEventListener('click', function () { pickerAnswer(payload.requestId, ''); pickerClose(); });
      Array.prototype.forEach.call(pickerMask.querySelectorAll('.xhsp-row'), function (row) {
        row.addEventListener('click', function () {
          pickerAnswer(payload.requestId, row.getAttribute('data-port-id'));
          pickerClose();
        });
      });
      var onKey = function (e) {
        if (e.key !== 'Escape') return;
        document.removeEventListener('keydown', onKey);
        pickerAnswer(payload.requestId, '');
        pickerClose();
      };
      document.addEventListener('keydown', onKey);
      var first = pickerMask.querySelector('.xhsp-row');
      if (first) first.focus();
    };

    D.serial.onChoose(function (payload) {
      var ports = Array.isArray(payload.ports) ? payload.ports : [];
      var wanted = '';
      try { wanted = String(window.__XHGCS_PICK_NAME__ || '').trim(); } catch (e) {}
      if (wanted) {
        for (var i = 0; i < ports.length; i++) {
          var p = ports[i];
          var n = String(p.portName || '');
          var dn = String(p.displayName || '');
          if (n === wanted || dn.indexOf(wanted) >= 0) {
            pickerAnswer(payload.requestId, p.portId);
            return;
          }
        }
      }
      pickerShow(payload);
    });
    portPicker = { show: pickerShow };
  }
  window.XHGCS_PORT_PICKER = portPicker;
})();
