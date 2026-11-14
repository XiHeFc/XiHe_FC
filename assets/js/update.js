(function () {
  'use strict';
  const api = window.XHGCS_DESKTOP;
  const button = document.getElementById('updateBtn');
  if (!button) return;
  function label(text) {
    button.querySelector('.lbl').textContent = text;
    button.title = text === '更新' ? '检查软件更新' : text;
  }
  if (api && api.updates) api.updates.onStatus(label);
  async function check() {
    if (api && api.updates) {
      try { await api.updates.check(); } catch (_) { label('更新失败'); }
    } else window.open('https://github.com/XiHeFc/XiHe_FC/releases/latest', '_blank', 'noopener');
  }
  button.addEventListener('click', check);
  document.querySelectorAll('.set-btn').forEach(function (el) {
    if (el.textContent.trim() === '检查更新') el.addEventListener('click', check);
  });
})();
