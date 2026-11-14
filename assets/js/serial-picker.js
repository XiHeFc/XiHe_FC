(function () {
  'use strict';

  const X = window.XHGCS || {};
  const api = window.XHGCS_DESKTOP;
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => (typeof X.esc === 'function' ? X.esc(value) : String(value === null || value === undefined ? '' : value));

  let pending = null;

  // 桌面版多串口时，主进程把 select-serial-port 拿到的列表发过来，由这个面板显示。
  // 列表里带的是 COM 口号（portName），渲染层的 SerialPort 只有 VID/PID，
  // 所以「选哪一个」这件事只能在这儿说清楚。
  function portRow(port, index, preset) {
    const name = port.portName || port.displayName || '串口 ' + (index + 1);
    const detail = [];
    if (port.displayName && port.displayName !== name) detail.push(port.displayName);
    if (port.vendorId || port.productId) detail.push('VID:' + (port.vendorId || '?') + ' PID:' + (port.productId || '?'));
    const selected = preset ? port.portName === preset : index === 0;
    return '<label class="serial-pick-row">' +
      '<input type="radio" name="serialPick" value="' + esc(port.portId) + '"' + (selected ? ' checked' : '') + ' />' +
      '<span class="serial-pick-name">' + esc(name) + '</span>' +
      (detail.length ? '<span class="serial-pick-sub">' + esc(detail.join(' · ')) + '</span>' : '') +
      '</label>';
  }

  function render(payload) {
    const host = $('#serialPicker');
    const list = $('#serialPickList');
    const note = $('#serialPickNote');
    const confirmBtn = $('#btnSerialPickConfirm');
    if (!host || !list) return;
    const ports = Array.isArray(payload.ports) ? payload.ports : [];
    const preset = String(payload.preset || '');
    list.innerHTML = ports.length
      ? ports.map((port, index) => portRow(port, index, preset)).join('')
      : '<div class="serial-pick-empty">没有枚举到任何串口设备。<br />检查 USB 连接、驱动（CH340 / FTDI）与设备供电，插好后重新点一次「选择串口」。</div>';
    if (note) {
      note.textContent = ports.length
        ? ports.length + ' 个串口 · 选择会被记住，下次自动使用'
        : '0 个串口 · 应用没有枚举到设备';
    }
    if (confirmBtn) confirmBtn.disabled = ports.length === 0;
    host.classList.remove('hidden');
  }

  function settle(portId) {
    const current = pending;
    pending = null;
    const host = $('#serialPicker');
    if (host) host.classList.add('hidden');
    if (current) current.resolve(portId || null);
  }

  function open(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    return new Promise((resolve) => {
      pending = { requestId: String(data.requestId || ''), resolve: resolve };
      render(data);
    });
  }

  // 回传必须走主进程：它才是那个等着 callback(portId) 的人，portId 为空表示取消
  function answer(portId) {
    const current = pending;
    if (current && api && api.serial && api.serial.chooseResult) {
      api.serial.chooseResult({ requestId: current.requestId, portId: portId || '' });
    }
    settle(portId);
  }

  function confirm() {
    const checked = document.querySelector('input[name="serialPick"]:checked');
    answer(checked ? checked.value : '');
  }

  function cancel() {
    answer('');
  }

  function init() {
    const host = $('#serialPicker');
    if (!host) return;
    const confirmBtn = $('#btnSerialPickConfirm');
    const cancelBtn = $('#btnSerialPickCancel');
    const closeBtn = $('#btnSerialPickClose');
    if (confirmBtn) confirmBtn.addEventListener('click', confirm);
    if (cancelBtn) cancelBtn.addEventListener('click', cancel);
    if (closeBtn) closeBtn.addEventListener('click', cancel);
    host.addEventListener('click', (event) => { if (event.target === host) cancel(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && pending && !(window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth() > 0)) { event.stopPropagation(); cancel(); }
    });
    if (api && api.isDesktop && api.serial && api.serial.onChoose) {
      api.serial.onChoose((payload) => { open(payload); });
    }
  }

  window.XHGCS_SERIAL_PICKER = {
    open: open,
    confirm: confirm,
    cancel: cancel,
    isOpen: function () { return Boolean(pending); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
