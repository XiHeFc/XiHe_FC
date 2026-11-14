// 输入页控制器（v43 移植）：链路卡（UART 参数 + 开关）、侧栏输入视图、已保存列表（后续任务接）
(function () {
  'use strict';

  const FIELD_LABEL = { baud: '波特率', dataBits: '数据位', parity: '校验', stopBits: '停止位' };
  const SELECT_SOURCE = { baud: '#baudSelect', dataBits: '#dataBitsSelect', parity: '#paritySelect' };

  let openMenu = null;
  let pollTimer = null;
  let started = false;

  function serial() { return window.XHGCS.state.serial; }
  function esc(v) { return window.XHGCS.esc ? window.XHGCS.esc(String(v)) : String(v); }

  // 选项复用串口页既有的下拉（波特率由 fillBaudOptions 填充），停止位是新字段
  function optionsFor(key) {
    if (key === 'stopBits') return [['1', '1'], ['2', '2']];
    const sel = document.querySelector(SELECT_SOURCE[key]);
    if (!sel) return [];
    return Array.from(sel.options).map((o) => [o.value, o.textContent.trim()]);
  }

  function displayValue(key) {
    const value = String(serial()[key]);
    if (key === 'parity') {
      const opt = optionsFor('parity').find((pair) => pair[0] === value);
      return opt ? opt[1] : value;
    }
    return value;
  }

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onOutside(event) {
    if (!openMenu) return;
    if (openMenu.contains(event.target)) return;
    if (event.target.closest && event.target.closest('.uart-dd')) return;
    closeMenu();
  }

  function onEsc(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeMenu();
  }

  function applyValue(key, value) {
    const s = serial();
    if (key === 'parity') s.parity = value;
    else s[key] = Number(value);
    window.XHGCS.persist();
    syncLink();
  }

  function openUartMenu(btn) {
    if (openMenu && openMenu.__btn === btn) { closeMenu(); return; }
    closeMenu();
    const key = btn.dataset.key;
    const current = String(serial()[key]);
    const menu = document.createElement('div');
    menu.className = 'uart-menu';
    menu.setAttribute('role', 'listbox');
    menu.__btn = btn;
    optionsFor(key).forEach((pair) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'uart-menu-item' + (pair[0] === current ? ' on' : '');
      item.dataset.value = pair[0];
      item.setAttribute('role', 'option');
      item.innerHTML = '<span class="uart-menu-check">' + (pair[0] === current ? '✓' : '') + '</span><span>' + esc(pair[1]) + '</span>';
      item.addEventListener('click', () => { applyValue(key, pair[0]); closeMenu(); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.minWidth = Math.max(120, Math.round(rect.width)) + 'px';
    const mrect = menu.getBoundingClientRect();
    if (mrect.right > window.innerWidth - 8) menu.style.left = Math.max(8, window.innerWidth - mrect.width - 8) + 'px';
    if (mrect.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, rect.top - mrect.height - 4) + 'px';
    openMenu = menu;
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
  }

  function syncLink() {
    if (!window.XHGCS || !window.XHGCS.state) return;
    const s = serial();
    const receiving = !!s.receiving && !!s.connected;
    const text = !s.connected ? '未连接' : (receiving ? '接收中' : '等待数据');
    ['sideLinkDot', 'inputHeadDot'].forEach((id) => {
      const dot = document.getElementById(id);
      if (dot) dot.classList.toggle('ok', receiving);
    });
    const sideText = document.getElementById('sideLinkText');
    if (sideText) sideText.textContent = text;
    const headState = document.getElementById('inputHeadState');
    if (headState) headState.textContent = text;
    const cardState = document.getElementById('inputLinkState');
    if (cardState) cardState.textContent = text;
    const portText = document.getElementById('uartPortText');
    if (portText) portText.textContent = s.port || '未选择';
    const sw = document.getElementById('uartOpenSwitch');
    if (sw) sw.checked = !!s.connected;
    ['baud', 'dataBits', 'parity', 'stopBits'].forEach((key) => {
      const btn = document.querySelector('.uart-dd[data-key="' + key + '"]');
      if (btn) btn.textContent = FIELD_LABEL[key] + ' ' + displayValue(key);
    });
  }

  function renderLinkCard() {
    const body = document.getElementById('inputLinkBody');
    if (!body || body.dataset.ready === '1') return;
    body.dataset.ready = '1';
    body.innerHTML =
      '<div class="uart-row">'
      + '<span class="uart-label">端口</span>'
      + '<span class="uart-port" id="uartPortText">未选择</span>'
      + '<button class="hbtn" id="uartPickPort" type="button">选择端口</button>'
      + '<span class="uart-gap"></span>'
      + '<label class="uart-switch" title="开启或停止接收串口数据">'
      + '<input type="checkbox" id="uartOpenSwitch" aria-label="开启串口">'
      + '<span class="uart-switch-track" aria-hidden="true"></span>'
      + '<span class="uart-switch-text">开启串口</span>'
      + '</label>'
      + '</div>'
      + '<div class="uart-row uart-params">'
      + '<span class="uart-label">参数</span>'
      + '<button class="uart-dd" id="uartBaudBtn" type="button" data-key="baud" aria-haspopup="listbox">波特率 —</button>'
      + '<button class="uart-dd" id="uartDataBitsBtn" type="button" data-key="dataBits" aria-haspopup="listbox">数据位 —</button>'
      + '<button class="uart-dd" id="uartParityBtn" type="button" data-key="parity" aria-haspopup="listbox">校验 —</button>'
      + '<button class="uart-dd" id="uartStopBitsBtn" type="button" data-key="stopBits" aria-haspopup="listbox">停止位 —</button>'
      + '</div>';
    body.querySelectorAll('.uart-dd').forEach((btn) => {
      btn.addEventListener('click', () => openUartMenu(btn));
    });
    document.getElementById('uartPickPort').addEventListener('click', () => {
      const S = window.XHGCS_SERIAL;
      if (!S || !S.selectPort) return;
      Promise.resolve(S.selectPort()).then(syncLink).catch((err) => {
        window.XHGCS.pushLog('err', '选择串口失败：' + ((err && err.message) || '未知错误'), 0);
      });
    });
    const sw = document.getElementById('uartOpenSwitch');
    sw.addEventListener('change', () => {
      const S = window.XHGCS_SERIAL;
      if (!S) return;
      const task = sw.checked ? S.connect() : S.disconnect();
      Promise.resolve(task).then(syncLink).catch((err) => {
        sw.checked = !!serial().connected;
        window.XHGCS.pushLog('err', '串口连接失败：' + ((err && err.message) || '未知错误'), 0);
        syncLink();
      });
    });
    syncLink();
  }

  function bindSide() {
    const row = document.getElementById('sideLinkRow');
    if (!row) return;
    row.addEventListener('click', () => {
      const nav = document.querySelector('#sideNav [data-nav="input"]');
      if (nav) nav.click();
    });
  }

  // ---- 保存快照（v43）：保存行 + 侧栏已保存列表 + 保存详情标签 ----
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function toast(text) {
    if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.callApp) window.XHGCS_VIEWS.callApp('toast', text);
  }

  function renderSaved() {
    const list = document.getElementById('sideSavedList');
    if (!list) return;
    const saves = Array.isArray(window.XHGCS.state.inputSaves) ? window.XHGCS.state.inputSaves : [];
    const count = document.getElementById('sideSavedCount');
    if (count) count.textContent = String(saves.length);
    const empty = document.getElementById('sideSavedEmpty');
    if (empty) empty.style.display = saves.length ? 'none' : '';
    list.innerHTML = saves.map((save) => {
      const dot = (save.channels && save.channels[0] && save.channels[0].color) || 'var(--text-dim)';
      return '<button class="side-saved-row" type="button" data-save="' + esc(save.id) + '" title="' + esc(save.name) + '">'
        + '<span class="side-saved-dot" style="background:' + esc(dot) + '"></span>'
        + '<span class="side-saved-name">' + esc(save.name) + '</span>'
        + '<span class="side-saved-time">' + esc(fmtTime(save.savedAt)) + '</span>'
        + '</button>';
    }).join('');
    list.querySelectorAll('.side-saved-row').forEach((row) => {
      row.addEventListener('click', () => openSavedDetail(row.dataset.save));
    });
  }

  function openSavedDetail(id) {
    const save = (window.XHGCS.state.inputSaves || []).find((item) => item.id === id);
    const D = window.XHGCS_DETAILS;
    if (!save || !D) return;
    D.open({
      id: 'saved:' + id,
      name: save.name,
      render(host) {
        const fields = save.fields || {};
        const spec = [
          ['协议', String(fields.protocol || '') + (fields.protocolId ? ' · ' + fields.protocolId : '')],
          ['帧头', fields.header || '—'],
          ['帧尾', fields.tail || '—'],
          ['结束符', fields.terminator ? JSON.stringify(fields.terminator) : '—'],
          ['校验', fields.checksum || 'NONE'],
          ['字节序', fields.byteOrder === 'big' ? '大端' : '小端'],
          ['通道数', String(fields.channelCount || (save.channels || []).length || 0)]
        ];
        const specHtml = spec.map((pair) => (
          '<div class="saved-spec-row"><span>' + esc(pair[0]) + '</span><span>' + esc(pair[1]) + '</span></div>'
        )).join('');
        const rows = (save.channels || []).map((ch) => (
          '<div class="saved-chrow">'
          + '<span class="saved-chdot" style="background:' + esc(ch.color || 'var(--text-dim)') + '"></span>'
          + '<span class="saved-chname">' + esc(ch.name || '') + '</span>'
          + '<span class="saved-chunit">' + esc(ch.unit || '') + '</span>'
          + '<span class="saved-chid">' + esc(ch.id || '') + '</span>'
          + '</div>'
        )).join('');
        host.innerHTML =
          '<div class="saved-detail">'
          + '<div class="saved-head"><span class="saved-name">' + esc(save.name) + '</span>'
          + '<span class="saved-meta">' + esc(fmtTime(save.savedAt)) + ' · ' + (save.channels || []).length + ' 通道</span></div>'
          + '<section class="saved-block"><div class="saved-block-head">协议规则</div><div class="saved-spec">' + specHtml + '</div></section>'
          + '<section class="saved-block"><div class="saved-block-head">通道</div><div class="saved-chtable">' + rows + '</div></section>'
          + '<div class="saved-actions">'
          + '<button class="btn primary saved-load-btn" type="button">加载此保存</button>'
          + '<button class="btn danger saved-delete-btn" type="button">删除</button>'
          + '</div>'
          + '</div>';
        const load = host.querySelector('.saved-load-btn');
        if (load) {
          load.addEventListener('click', () => {
            window.XHGCS.applyInputSave(save.id);
            D.close('saved:' + save.id);
            renderSaved();
            toast('已加载保存：' + save.name);
          });
        }
        const del = host.querySelector('.saved-delete-btn');
        if (del) {
          del.addEventListener('click', () => {
            window.XHGCS.removeInputSave(save.id);
            D.close('saved:' + save.id);
            renderSaved();
          });
        }
      }
    });
  }

  function bindSave() {
    const btn = document.getElementById('btnInputSave');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const X = window.XHGCS;
      const engine = X.getActiveEngine();
      if (!engine) return;
      const nameInput = document.getElementById('inputSaveName');
      const name = (nameInput && nameInput.value.trim()) || engine.name || '未命名保存';
      X.addInputSave({
        name,
        fields: {
          name: engine.name,
          protocol: engine.protocol,
          protocolId: engine.protocolId || '',
          header: engine.header || '',
          tail: engine.tail || '',
          terminator: engine.terminator || '',
          checksum: engine.checksum || 'NONE',
          byteOrder: engine.byteOrder || 'little',
          hexScale: Number(engine.hexScale) || 10,
          payloadBytes: Number(engine.payloadBytes) || 0,
          channelCount: Number(engine.channelCount) || 0,
          description: engine.description || ''
        },
        channels: (X.state.channels || []).map((ch) => ({ id: ch.id, name: ch.name, unit: ch.unit, color: ch.color }))
      });
      if (nameInput) nameInput.value = '';
      toast('已保存：' + name);
    });
  }

  function start() {
    if (started) return;
    started = true;
    renderLinkCard();
    bindSide();
    bindSave();
    renderSaved();
    syncLink();
    window.addEventListener('xhgcs:serial-changed', syncLink);
    window.addEventListener('xhgcs:input-saves-changed', renderSaved);
    if (!pollTimer) pollTimer = setInterval(syncLink, 1000);
  }

  function ready() {
    if (window.XHGCS && window.XHGCS.state && window.XHGCS.persist && document.getElementById('inputLinkBody')) {
      start();
      return;
    }
    setTimeout(ready, 80);
  }

  window.XHGCS_INPUT_UI = {
    renderLinkCard: renderLinkCard,
    renderSaved: renderSaved,
    syncLink: syncLink
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
