/**
 * 示例插件：最小可用的扩展。
 *
 * 它刻意只做四件事，用来验证内核的承诺：
 *   1. 清单先行 —— 命令/视图/状态栏/配置在加载代码之前就已经被界面看见；
 *   2. 按需激活 —— 只有点了状态栏、执行了命令或打开了视图，本文件才会被执行；
 *   3. 权限投影 —— 没声明 ui:view 的话，ctx.api.views 直接不存在；
 *   4. 失败隔离 —— 本文件抛错只影响自己，扩展面板里会留一条可读原因。
 */
(function () {
  'use strict';

  window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};

  window.XHGCS_EXTENSIONS['xihe.demo.hello'] = {
    activate: function (ctx) {
      var api = ctx.api;
      var limit = Number(api.config.get('warnChannels')) || 8;
      var spark = Number(api.config.get('sparkPoints')) || 90;

      api.commands.register('demo.linkReport', function () {
        var channels = api.data ? api.data.channels() : [];
        var scripts = api.data ? api.data.scriptChannels() : [];
        var tone = channels.length >= limit ? '通道偏多：' : '通道正常：';
        api.toast(
          tone +
            channels.length +
            ' 个原始通道 / ' +
            scripts.length +
            ' 个脚本通道（阈值 ' +
            limit +
            '）'
        );
        if (api.statusBar) {
          api.statusBar.update('demo.channels', {
            text: '链路 ' + channels.length + '/' + limit,
            tone: channels.length >= limit ? 'warn' : 'ok'
          });
        }
      });

      if (api.statusBar) {
        api.statusBar.update('demo.channels', { text: '链路 ✓', tone: 'ok' });
      }

      // ---- 插件视图：用 ctx 提供的画布与通道快照自己画 ----
      if (api.views) {
        var palette = ['#6da8d2', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c'];
        api.views.register('demo.health', {
          mount: function (view) {
            ctx.log('视图挂载 ' + view.width + '×' + view.height);
          },
          update: function (view) {
            var frame = view.canvas();
            if (!frame) return;
            var g = frame.ctx;
            var w = frame.width;
            var h = frame.height;
            var theme = view.theme();
            var list = view.channels().slice(0, 6);
            g.clearRect(0, 0, w, h);

            g.font = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
            g.textAlign = 'left';
            g.textBaseline = 'top';
            g.fillStyle = theme.dim;
            g.fillText('通道 ' + list.length + ' · 阈值 ' + limit + ' · 点数 ' + spark, 4, 4);

            if (!list.length) {
              g.fillStyle = theme.dim;
              g.textAlign = 'center';
              g.fillText('还没有通道数据', w / 2, h / 2);
              return;
            }

            var top = 26;
            var rowHeight = Math.max(26, Math.min(48, (h - top - 8) / list.length));
            var left = 96;
            var right = w - 12;
            for (var i = 0; i < list.length; i++) {
              var channel = list[i];
              var color = channel.color || palette[i % palette.length];
              var y = top + i * rowHeight;
              var series = view.series(channel.id, spark);
              var latest = view.latest(channel.id);
              var over = Math.abs(latest) * 0 + 0; // 仅为可读性保留变量位

              g.textAlign = 'left';
              g.textBaseline = 'middle';
              g.fillStyle = color;
              g.fillRect(8, y + rowHeight / 2 - 3, 6, 6);
              g.fillStyle = theme.fg;
              g.font = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
              var label = channel.name.length > 10 ? channel.name.slice(0, 9) + '…' : channel.name;
              g.fillText(label, 20, y + rowHeight / 2);

              // 迷你曲线
              if (series.length > 1) {
                var min = Math.min.apply(null, series);
                var max = Math.max.apply(null, series);
                var spanY = max - min || 1;
                g.beginPath();
                for (var k = 0; k < series.length; k++) {
                  var px = left + (k / (series.length - 1)) * (right - left);
                  var py = y + rowHeight - 6 - ((series[k] - min) / spanY) * (rowHeight - 12);
                  if (k === 0) g.moveTo(px, py);
                  else g.lineTo(px, py);
                }
                g.strokeStyle = color;
                g.lineWidth = 1.4;
                g.stroke();
              }

              g.textAlign = 'right';
              g.fillStyle = theme.dim;
              g.font = '11px ui-monospace, Consolas, monospace';
              g.fillText(
                Math.abs(latest) >= 100 ? latest.toFixed(0) : latest.toFixed(2) + (channel.unit ? ' ' + channel.unit : ''),
                w - 12,
                y + rowHeight / 2
              );
              void over;
            }
          },
          unmount: function () {
            ctx.log('视图已卸载');
          }
        });
      }

      // 配置改动要能立刻反映到界面，而不是等下次激活
      ctx.subscriptions.add(
        api.config.onDidChange(function (key, value) {
          if (key === 'warnChannels') limit = Number(value) || limit;
          if (key === 'sparkPoints') spark = Number(value) || spark;
          ctx.log(key + ' → ' + value);
        })
      );

      ctx.log('示例插件已激活，阈值 ' + limit);
    },
    deactivate: function () {
      // 内核会自动注销贡献点与订阅；这里只处理插件自己持有的资源
    }
  };
})();
