#!/usr/bin/env node
'use strict';
/**
 * 插件脚手架：把「写一个插件」从背清单变成一条命令。
 *
 *   npm run new:plugin -- --id=my.scope --name="我的示波器" [--dir=plugins] [--force]
 *
 * 产出：
 *   <dir>/<id>/xhgcs.extension.json   清单（命令 + 状态栏 + 一项配置，按需激活）
 *   <dir>/<id>/main.js                实现模板（注册命令、状态栏更新、配置订阅）
 *   <dir>/index.json                  自动追加索引项（已存在则跳过）
 *
 * 刻意不生成“空壳”：模板里的命令真能跑、状态栏真会更新，新插件第一次启动就能看到效果。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { dir: 'plugins', force: false };
  for (const arg of argv) {
    if (arg === '--force') out.force = true;
    else if (arg.startsWith('--id=')) out.id = arg.slice(5);
    else if (arg.startsWith('--name=')) out.name = arg.slice(7);
    else if (arg.startsWith('--dir=')) out.dir = arg.slice(6);
  }
  return out;
}

function fail(message) {
  console.error('✖ ' + message);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = String(args.id || '').trim();
  if (!id) fail('缺少 --id，例如 --id=my.scope');
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) fail('id 只能包含字母、数字、点、下划线、短横线，长度 3-64');
  const name = String(args.name || id).trim().slice(0, 40);
  const baseDir = path.resolve(ROOT, args.dir);
  const pluginDir = path.join(baseDir, id);
  if (fs.existsSync(pluginDir) && !args.force) fail('目录已存在：' + pluginDir + '（加 --force 覆盖）');

  const short = id.split('.').pop();
  const commandId = short + '.open';

  const manifest = {
    id,
    name,
    version: '0.1.0',
    publisher: 'local',
    description: name + '（由脚手架生成，改完直接生效）',
    apiVersion: '1',
    engines: { xhgcs: '>=0.10.0 <1.0.0' },
    main: 'main.js',
    activationEvents: ['onCommand:' + commandId],
    permissions: ['data:read', 'ui:statusBar', 'ui:toast', 'config:read', 'commands:execute'],
    contributes: {
      commands: [{ id: commandId, title: name, category: '插件' }],
      statusBar: [
        {
          id: short + '.status',
          text: name,
          alignment: 'right',
          priority: 45,
          command: commandId,
          tooltip: '点击执行 ' + commandId
        }
      ],
      configuration: {
        title: name,
        properties: {
          threshold: {
            type: 'number',
            default: 10,
            minimum: 1,
            maximum: 10000,
            description: '示例配置项：超过该值就在提示里标黄'
          }
        }
      }
    }
  };

  const mainJs = `/**
 * ${name}
 *
 * 脚手架说明：
 *   1. 清单先被内核读到（命令/状态栏/配置立刻可见），本文件只在激活事件命中时才加载；
 *   2. ctx.api 是按清单 permissions 投影出来的能力对象，没声明的能力根本不存在；
 *   3. ctx.subscriptions 里放的东西会在停用/重载时自动释放，不用手写清理。
 */
(function () {
  'use strict';

  window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};

  window.XHGCS_EXTENSIONS['${id}'] = {
    activate: function (ctx) {
      var api = ctx.api;
      var threshold = Number(api.config.get('threshold')) || 10;

      api.commands.register('${commandId}', function () {
        var channels = api.data ? api.data.channels() : [];
        var hot = channels.filter(function (channel) {
          return api.data.latest(channel.id) >= threshold;
        });
        api.toast(
          '${name}：' + channels.length + ' 个通道，' +
            (hot.length ? hot.length + ' 个超过阈值 ' + threshold : '都在阈值内')
        );
        if (api.statusBar) {
          api.statusBar.update('${short}.status', {
            text: '${name} ' + channels.length,
            tone: hot.length ? 'warn' : 'ok'
          });
        }
      });

      api.config.onDidChange(function (key, value) {
        if (key !== 'threshold') return;
        threshold = Number(value) || threshold;
        ctx.log('阈值改为 ' + threshold);
      });

      ctx.log('${name} 已激活');
    },
    deactivate: function () {}
  };
})();
`;

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'xhgcs.extension.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'main.js'), mainJs, 'utf8');

  const indexPath = path.join(baseDir, 'index.json');
  let index = { extensions: [] };
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (Array.isArray(parsed)) index = { extensions: parsed };
      else if (parsed && Array.isArray(parsed.extensions)) index = parsed;
    } catch (err) {
      console.warn('! 现有 index.json 解析失败，将重建：' + err.message);
    }
  }
  const relative = id + '/xhgcs.extension.json';
  if (!index.extensions.some((item) => item && item.manifest === relative)) {
    index.extensions.push({ manifest: relative });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log('✔ 已生成插件：' + path.relative(ROOT, pluginDir));
  console.log('  清单：' + path.relative(ROOT, path.join(pluginDir, 'xhgcs.extension.json')));
  console.log('  代码：' + path.relative(ROOT, path.join(pluginDir, 'main.js')));
  console.log('  索引：' + path.relative(ROOT, indexPath));
  console.log('');
  console.log('下一步：');
  console.log('  1. npm start，命令面板（Ctrl+Shift+P）里搜「' + name + '」');
  console.log('  2. 改 main.js 后：扩展面板（Ctrl+Shift+X）点「重载」即可热更新');
  console.log('  3. 需要新能力时先在清单 permissions 里加权限，再用 ctx.api 里对应的接口');
}

main();
