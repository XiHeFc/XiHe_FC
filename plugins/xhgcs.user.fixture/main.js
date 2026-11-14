/**
 * 用户目录插件样例。
 *
 * 它不是内置插件（不在 plugins/index.json 里），只用于：
 *   1. 手工把整个文件夹复制到 %APPDATA%\XiHe GCS PRO\extensions 下验证装机形态；
 *   2. core-smoke 里用假的 XHGCS_DESKTOP.extensions.list 验证「用户目录发现 → 激活」链路。
 */
(function () {
  'use strict';

  window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};

  window.XHGCS_EXTENSIONS['xhgcs.user.fixture'] = {
    activate: function (ctx) {
      ctx.api.commands.register('userfixture.ping', function () {
        return 'pong';
      });
      if (ctx.api.toast) ctx.api.toast('用户目录插件已激活');
    },
    deactivate: function () {}
  };
})();
