// 璇玑适配脚本：
// 1) 被软件设置页嵌入（window.name === 'xhgcs-settings'）时，给页面加标记类，配合样式把设置铺满。
// 2) DSH 侧栏已被改成底部操作条，展开态不再适用；检测到展开就点回收起。
(function () {
  'use strict';
  if (window.name === 'xhgcs-settings') {
    document.documentElement.classList.add('xj-settings-embed');
    window.addEventListener('xuanji:settings-mounted', function () {
      var targetOrigin;
      try { targetOrigin = new URL(document.referrer || location.ancestorOrigins[0]).origin; } catch (err) { return; }
      window.parent.postMessage({ type: 'xuanji:settings-ready' }, targetOrigin);
    });
  }
  function hook(toggle) {
    function collapse() {
      var label = toggle.getAttribute('aria-label') || '';
      if (label.indexOf('收起') >= 0) toggle.click();
    }
    try {
      new MutationObserver(collapse).observe(toggle, { attributes: true, attributeFilter: ['aria-label'] });
    } catch (err) { /* ignore */ }
    collapse();
  }
  var timer = setInterval(function () {
    var toggle = document.querySelector('.hHd-Xa_toggle');
    if (toggle) { clearInterval(timer); hook(toggle); }
  }, 400);

  // 3) 输入框左下角注入「新会话」小按钮：真正的新会话按钮在已移出视口的侧栏里，
  //    这里转发点击，样式与 DSH 自己的输入框图标按钮一致；React 重渲染后自动补回。
  setInterval(function () {
    var tools = document.querySelector('.uV2eYG_tools');
    if (!tools || tools.querySelector('.xj-composer-new')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xj-composer-new';
    btn.title = '新会话';
    btn.setAttribute('aria-label', '新会话');
    btn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M13.4 8.6a2.2 2.2 0 0 1-2.2 2.2H5.3L2.9 13.1V4.6a2.2 2.2 0 0 1 2.2-2.2h3.4"/><path d="M12.6 2.2v4.2M10.5 4.3h4.2"/></svg>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var orig = document.querySelector('.hHd-Xa_newSession');
      if (orig) orig.click();
    });
    tools.insertBefore(btn, tools.firstChild);
  }, 600);
})();
