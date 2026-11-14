'use strict';
// 内核冒烟：验证「一切皆插件」这套地基真的能跑起来。
//   node tools/core-smoke.js           无头跑
//   node tools/core-smoke.js --headed  看着它跑
// 覆盖：内核启动、内置扩展激活、外部插件发现、按需激活、状态栏贡献、
//       命令面板、扩展面板、停用/启用后的贡献点回收、控制台无报错。
const fs = require('fs');
const path = require('path');
const { createStaticServer } = require('../electron/static-server');

const ROOT = path.resolve(__dirname, '..');
let chromium = null;
try {
  chromium = require('playwright').chromium;
} catch (err) {
  console.log('缺少 playwright，先在项目里执行：npm i');
  process.exit(2);
}

function findChrome() {
  if (process.env.XHGCS_CHROME) return process.env.XHGCS_CHROME;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let best = null;
  try {
    for (const dir of fs.readdirSync(base)) {
      const m = dir.match(/^chromium-(\d+)$/);
      if (!m) continue;
      const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && (!best || Number(m[1]) > best.rev)) best = { rev: Number(m[1]), exe };
    }
  } catch (err) {}
  return best ? best.exe : undefined;
}

const headed = process.argv.includes('--headed');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : ' → ' + detail));
}

async function main() {
  // 静态服务的额外挂载点：/ext 指向用户插件目录，且不能借此逃逸
  {
    const httpMod = require('node:http');
    const extDir = path.join(ROOT, 'plugins');
    const server = createStaticServer(ROOT, { mounts: [{ url: '/ext', dir: extDir }] });
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const request = (target) =>
      new Promise((resolve, reject) => {
        const req = httpMod.get({ host: '127.0.0.1', port, path: target }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
      });
    try {
      const okCode = await request('/ext/xhgcs.user.fixture/main.js');
      // 用编码反斜杠构造一个「不是 URL 点段、但解码后在 Windows 上会变成上级目录」的路径，
      // 验证挂载点自己的 canonical path 检查确实生效。
      const escapeCode = await request('/ext/..%5cindex.html');
      const missingCode = await request('/ext/xhgcs.user.fixture/nope.js');
      check(
        '静态服务可挂载用户扩展目录且阻止目录逃逸',
        okCode === 200 && escapeCode === 403 && missingCode === 404,
        JSON.stringify({ okCode, escapeCode, missingCode })
      );
    } finally {
      server.close();
    }
  }

  // 插件脚手架：生成到临时目录、校验结构、再删掉（不污染仓库里的 plugins/）
  const { execFileSync } = require('node:child_process');
  const tmpDir = path.join(ROOT, 'logs', 'tmp-scaffold-' + Date.now().toString(36));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'new-plugin.cjs'), '--id=smoke.gen', '--name=脚手架冒烟', '--dir=' + tmpDir], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'smoke.gen', 'xhgcs.extension.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, 'index.json'), 'utf8'));
    const mainSource = fs.readFileSync(path.join(tmpDir, 'smoke.gen', 'main.js'), 'utf8');
    let syntaxOk = true;
    try {
      new Function(mainSource);
    } catch (err) {
      syntaxOk = false;
    }
    check(
      '插件脚手架产出可解析的清单/索引/代码',
      manifest.id === 'smoke.gen' &&
        Array.isArray(manifest.activationEvents) &&
        manifest.activationEvents.length > 0 &&
        index.extensions.some((item) => item.manifest === 'smoke.gen/xhgcs.extension.json') &&
        syntaxOk,
      JSON.stringify({ id: manifest.id, index: index.extensions, syntaxOk })
    );
  } catch (err) {
    check('插件脚手架产出可解析的清单/索引/代码', false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }

  const server = createStaticServer(ROOT);
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const browser = await chromium.launch({ headless: !headed, executablePath: findChrome() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // 带 URL：只说「加载失败」等于没说，排查时第一件事就是看是哪个资源
      const loc = msg.location ? msg.location() : null;
      const text = 'console: ' + msg.text() + (loc && loc.url ? ' @ ' + loc.url : '');
      // 本地桥（8787）不归内核冒烟管：没起是 ERR_CONNECTION_REFUSED；起了也会因为
      // 页面是随机端口的来源被精确白名单挡下（CORS）。两种都是环境事实，不是产品缺陷；
      // 只放过这一条（URL 必须落在 /api/health），其余控制台错误照旧算失败。
      if (/127\.0\.0\.1:8787\/api\/health/.test(text) && /ERR_CONNECTION_REFUSED|blocked by CORS policy|ERR_FAILED/.test(text)) return;
      errors.push(text);
    }
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.XHGCS_CORE && window.XHGCS_CORE.host), null, { timeout: 15000 });
    await page.waitForFunction(() => window.XHGCS_CORE.host.list().some((r) => r.manifest.id === 'xihe.core'), null, { timeout: 15000 });
    await page.waitForTimeout(600);

    const boot = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const records = core.host.list().map((r) => ({ id: r.manifest.id, status: r.status, message: r.message }));
      return {
        version: core.version,
        apiVersion: core.apiVersion,
        records,
        commands: core.commands.list().map((c) => c.id),
        stats: core.registry.stats(),
        statusText: Array.from(document.querySelectorAll('.xhgcs-sb')).map((el) => el.textContent).join('|')
      };
    });
    check('内核加载并暴露版本号', Boolean(boot.version && boot.apiVersion), JSON.stringify(boot.version));
    const coreRec = boot.records.find((r) => r.id === 'xihe.core');
    check('内置扩展 xihe.core 已激活', Boolean(coreRec && coreRec.status === 'active'), JSON.stringify(coreRec));
    check('内置命令注册成功', boot.commands.includes('xhgcs.commandPalette') && boot.commands.includes('xhgcs.extensions'), boot.commands.join(','));
    check('状态栏贡献点上屏', /扩展/.test(boot.statusText), boot.statusText);

    const demo = boot.records.find((r) => r.id === 'xihe.demo.hello');
    check('外部插件被清单发现', Boolean(demo), JSON.stringify(boot.records));
    check('外部插件未被提前激活（按需）', Boolean(demo && demo.status !== 'active'), demo && demo.status);

    // 点状态栏 = 执行命令 = 触发 onCommand 激活
    await page.click('.xhgcs-sb[title*="统计当前通道"]');
    await page.waitForFunction(
      () => {
        const record = window.XHGCS_CORE.host.list().find((r) => r.manifest.id === 'xihe.demo.hello');
        return Boolean(record && record.status === 'active');
      },
      null,
      { timeout: 8000 }
    );
    const activated = await page.evaluate(() => {
      const record = window.XHGCS_CORE.host.list().find((r) => r.manifest.id === 'xihe.demo.hello');
      const items = Array.from(document.querySelectorAll('.xhgcs-sb')).map((el) => el.textContent);
      return { status: record.status, activatedBy: record.activatedBy, items };
    });
    check('按需激活：命令触发插件加载', activated.status === 'active', JSON.stringify(activated));
    check('插件运行后更新自己的状态栏项', activated.items.some((text) => /链路/.test(text)), activated.items.join('|'));

    // 命令面板
    await page.keyboard.press('Control+Shift+P');
    await page.waitForSelector('.xhgcs-palette', { timeout: 4000 });
    const paletteItems = await page.$$eval('.xhgcs-palette-item', (els) => els.map((el) => el.textContent));
    check('命令面板能列出全部命令', paletteItems.length >= 3, paletteItems.join(' / '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // 扩展面板
    await page.evaluate(() => window.XHGCS_CORE.commands.execute('xhgcs.extensions'));
    await page.waitForSelector('.xhgcs-panel', { timeout: 4000 });
    const panelRows = await page.$$eval('.xhgcs-ext-id', (els) => els.map((el) => el.textContent));
    check('扩展面板列出全部扩展与状态', panelRows.length >= 2, panelRows.join(' / '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // 停用：贡献点必须被回收
    const disabled = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      await core.host.disable('xihe.demo.hello');
      const status = core.registry.get('statusBar', 'demo.channels');
      const items = Array.from(document.querySelectorAll('.xhgcs-sb')).map((el) => el.textContent);
      return { status: Boolean(status), hasDemoItem: items.some((text) => /链路/.test(text)) };
    });
    check('停用后状态栏贡献被回收', !disabled.hasDemoItem, JSON.stringify(disabled));

    // 启用：贡献点必须回来
    const enabled = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      await core.host.enable('xihe.demo.hello');
      const items = Array.from(document.querySelectorAll('.xhgcs-sb')).map((el) => el.textContent);
      return { hasDemoItem: items.some((text) => /链路/.test(text)) };
    });
    check('启用后状态栏贡献恢复', enabled.hasDemoItem, JSON.stringify(enabled));

    // 配置读写
    const config = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const before = core.config.get('xihe.demo.hello', 'warnChannels');
      core.config.update('xihe.demo.hello', 'warnChannels', 99);
      const after = core.config.get('xihe.demo.hello', 'warnChannels');
      return { before, after };
    });
    check('配置贡献点可读可写并按 schema 夹取', config.before === 8 && config.after === 64, JSON.stringify(config));

    // 权限投影：没声明的能力必须不存在
    const perms = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const record = core.host.list().find((r) => r.manifest.id === 'xihe.demo.hello');
      return {
        hasNet: Boolean(record.permissions && record.permissions.includes('network')),
        declared: record.manifest.permissions
      };
    });
    check('示例插件没有网络权限（默认拒绝）', !perms.hasNet, JSON.stringify(perms.declared));

    // ---- 纯函数：版本范围 / when 表达式 / 清单校验 ----
    const pure = await page.evaluate(() => {
      const { semver, when } = window.XHGCS_CORE.internals;
      return {
        inRange: semver.satisfies('0.9.7', '^0.9.0'),
        outOfRange: semver.satisfies('1.2.0', '^0.9.0'),
        caret: semver.satisfies('0.9.7', '>=0.9.0 <1.0.0'),
        whenTrue: when.evaluate('a == 1 && b', { a: 1, b: 'x' }),
        whenFalse: when.evaluate('!a || c', { a: true, c: false }),
        whenIn: when.evaluate('view in [visual, wave]', { view: 'wave' }),
        whenBadSyntax: when.validate('a &&'),
        manifestBad: window.XHGCS_CORE.validate({ id: 'x' })
      };
    });
    check(
      '版本范围判断正确',
      pure.inRange === true && pure.outOfRange === false && pure.caret === true,
      JSON.stringify({ inRange: pure.inRange, outOfRange: pure.outOfRange, caret: pure.caret })
    );
    check(
      'when 表达式求值正确',
      pure.whenTrue === true && pure.whenFalse === false && pure.whenIn === true,
      JSON.stringify({ whenTrue: pure.whenTrue, whenFalse: pure.whenFalse, whenIn: pure.whenIn })
    );
    check('非法 when 与非法清单都会报错', pure.whenBadSyntax.ok === false && pure.manifestBad.ok === false, JSON.stringify(pure.manifestBad.issues));

    // ---- 数据引擎：协议可注册，且内置协议不受影响 ----
    const proto = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      core.engine.protocols.register('smoke', {
        id: 'smoke.bin',
        label: '冒烟二进制协议',
        protocols: ['SMOKEBIN'],
        decode: () => ({ ok: true, values: { probe: 7 } })
      });
      const custom = window.XHGCS_SERIAL.parseFrame({ protocol: 'SMOKEBIN' }, 'x');
      const json = window.XHGCS_SERIAL.parseFrame({ protocol: 'JSON' }, '{"ch1":5}');
      core.engine.protocols.removeOwner('smoke');
      const after = window.XHGCS_SERIAL.parseFrame({ protocol: 'SMOKEBIN' }, 'probe:8');
      return { custom, jsonOk: json && json.ok, afterOk: after && after.ok, afterValue: after && after.values && after.values.probe };
    });
    check('插件协议接管解码', Boolean(proto.custom && proto.custom.values.probe === 7), JSON.stringify(proto.custom));
    check('内置 JSON 协议行为不变', proto.jsonOk === true, JSON.stringify(proto.jsonOk));
    check('协议卸载后回落到内置分支', proto.afterOk === true && proto.afterValue === 8, JSON.stringify(proto));

    // ---- 数据引擎：算子可注册 ----
    const op = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      core.engine.operators.register('smoke', {
        id: 'smoke.double',
        label: '翻倍',
        run: (ctx) => ({ out: { value: Number(ctx.inputs[0] || 0) * 2, series: [] } })
      });
      const hit = await core.engine.operators.run({ type: 'smoke.double' }, { inputs: [21], windowPoints: 10 });
      const miss = await core.engine.operators.run({ type: 'math' }, { inputs: [1], windowPoints: 10 });
      const count = core.engine.operators.list().length;
      core.engine.operators.removeOwner('smoke');
      return { value: hit && hit.out && hit.out.value, miss, count, left: core.engine.operators.list().length };
    });
    check('插件算子可注册并执行', op.value === 42, JSON.stringify(op));
    check('未注册的节点类型仍然返回 null（回落内置）', op.miss === null && op.left === 0, JSON.stringify(op));

    // ---- 常驻数据引擎：时间戳、阶段链、端点、背压 ----
    const pipe = await page.evaluate(async () => {
      const p = window.XHGCS_CORE.engine.pipeline;
      const captured = [];
      const sinkHandle = p.registerSink('smoke', { id: 'smoke.collect', label: '收集', write: (frame) => captured.push(frame) });
      const opHandle = p.registerOperator('smoke', {
        id: 'smoke.scale',
        label: '冒烟放大',
        order: 5,
        process: (frame) =>
          typeof frame.values.probe === 'number'
            ? { ...frame, values: { ...frame.values, probe: frame.values.probe * 10 } }
            : frame
      });
      const before = p.metrics().processed;
      p.ingest({ t: 123.5, wall: Date.now(), source: 'smoke', values: { probe: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 160));
      const metrics = p.metrics();
      const hit = captured.filter((frame) => frame.values && frame.values.probe === 10).pop();
      opHandle.dispose();
      sinkHandle.dispose();
      return { running: metrics.running, delta: metrics.processed - before, t: hit ? hit.t : null, value: hit ? hit.values.probe : null };
    });
    check('数据引擎常驻运行', pipe.running === true, JSON.stringify(pipe));
    check('引擎逐帧处理且保留时间戳', pipe.delta >= 1 && pipe.t === 123.5, JSON.stringify(pipe));
    check('插件阶段参与处理链', pipe.value === 10, JSON.stringify(pipe));

    const backpressure = await page.evaluate(() => {
      const p = window.XHGCS_CORE.engine.pipeline;
      p.setCapacity(32);
      const before = p.metrics().dropped;
      for (let i = 0; i < 200; i++) p.ingest({ t: i, wall: Date.now(), source: 'flood', values: { probe: i } });
      const metrics = p.metrics();
      p.setCapacity(4096);
      return { dropped: metrics.dropped - before, queued: metrics.queued, capacity: metrics.capacity };
    });
    check('入口有界：超量时丢最旧帧', backpressure.dropped > 0 && backpressure.queued <= 32, JSON.stringify(backpressure));

    await page.evaluate(() => window.XHGCS_CORE.ui.openPipeline());
    await page.waitForSelector('.pipe-shell', { timeout: 4000 });
    const pipePanel = await page.evaluate(() => ({
      cards: document.querySelectorAll('.pipe-card').length,
      stages: document.querySelectorAll('.pipe-chip').length
    }));
    check('引擎监视面板展示指标与阶段', pipePanel.cards >= 8 && pipePanel.stages >= 2, JSON.stringify(pipePanel));

    // 算子参数：面板可调、即时生效、落盘持久化
    const opParamPanel = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('.pipe-param-field input')];
      return { fields: inputs.length, rows: document.querySelectorAll('.pipe-param-row').length };
    });
    const opParams = await page.evaluate(() => {
      const pipeline = window.XHGCS_CORE.engine.pipeline;
      const before = pipeline.operatorParamValues('builtin.lowpass');
      pipeline.setOperatorParams('builtin.lowpass', { alpha: 0.5 });
      const after = pipeline.operatorParamValues('builtin.lowpass');
      const stored = JSON.parse(localStorage.getItem('xhgcs.pipeline.params.v1') || 'null');
      // configure 是否真的作用到算子：α=1 输出等于输入；α=0.5 时按 y += α(x−y)
      const op = window.XHGCS_CORE.engine.stages.lowpass();
      op.configure({ alpha: 1 });
      const pass = op.process({ t: 1, wall: 1, source: 'x', values: { ch1: 10 } });
      const pass2 = op.process({ t: 2, wall: 2, source: 'x', values: { ch1: 30 } });
      op.configure({ alpha: 0.5 });
      const smooth = op.process({ t: 3, wall: 3, source: 'x', values: { ch1: 100 } });
      return {
        defaultAlpha: before.alpha,
        afterAlpha: after.alpha,
        storedAlpha: stored && stored['builtin.lowpass'] ? stored['builtin.lowpass'].alpha : null,
        passValues: [pass.values.ch1, pass2.values.ch1],
        smoothValue: smooth.values.ch1
      };
    });
    check(
      '算子参数面板可编辑并生成输入框',
      opParamPanel.rows >= 2 && opParamPanel.fields >= 6,
      JSON.stringify(opParamPanel)
    );
    check(
      '算子参数即时生效并落盘',
      opParams.afterAlpha === 0.5 &&
        opParams.defaultAlpha === 0.25 &&
        opParams.storedAlpha === 0.5 &&
        JSON.stringify(opParams.passValues) === '[10,30]' &&
        Math.abs(opParams.smoothValue - 65) < 0.001,
      JSON.stringify(opParams)
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    // ---- 数据源与回放：可注册、能产帧、录制后原样重放 ----
    const sourceTest = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      const pipeline = core.engine.pipeline;
      const recorder = core.engine.recorder;
      pipeline.stopSource('builtin.legacy-sample');
      recorder.clear();
      let emit = null;
      pipeline.registerSource('smoke', {
        id: 'smoke.gen',
        label: '冒烟源',
        start(fn) { emit = fn; },
        stop() { emit = null; }
      });
      pipeline.startSource('smoke.gen');
      const before = pipeline.metrics().processed;
      emit({ t: 1, wall: Date.now(), source: 'smoke', values: { probe: 5 } });
      await new Promise((resolve) => setTimeout(resolve, 140));
      const running = pipeline.isSourceRunning('smoke.gen');
      const sourced = pipeline.metrics().sources.length;
      pipeline.stopSource('smoke.gen');
      pipeline.removeOwner('smoke');
      return { delta: pipeline.metrics().processed - before, running, sourced };
    });
    check('数据源可注册并产帧', sourceTest.running === true && sourceTest.delta >= 1, JSON.stringify(sourceTest));

    const replayTest = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      const pipeline = core.engine.pipeline;
      const recorder = core.engine.recorder;
      recorder.clear();
      pipeline.setSinkEnabled('builtin.record', true);
      let emit = null;
      pipeline.registerSource('smoke', {
        id: 'smoke.record',
        label: '录制源',
        start(fn) { emit = fn; },
        stop() { emit = null; }
      });
      pipeline.startSource('smoke.record');
      const base = Date.now();
      for (let i = 0; i < 4; i++) emit({ t: i, wall: base + i * 20, source: 'smoke', values: { probe: i } });
      await new Promise((resolve) => setTimeout(resolve, 160));
      const recorded = recorder.size;
      pipeline.stopSource('smoke.record');
      pipeline.removeOwner('smoke');
      pipeline.setSinkEnabled('builtin.record', false);

      const before = pipeline.metrics().processed;
      pipeline.stopSource('builtin.replay');
      pipeline.startSource('builtin.replay');
      await new Promise((resolve) => setTimeout(resolve, 700));
      const delta = pipeline.metrics().processed - before;
      pipeline.stopSource('builtin.replay');
      pipeline.startSource('builtin.legacy-sample');
      return { recorded, delta };
    });
    check('内存录制能收到帧', replayTest.recorded === 4, JSON.stringify(replayTest));
    check('回放源按原始间隔重放', replayTest.delta >= 4, JSON.stringify(replayTest));

    // ---- views 贡献点容器：选中 → onView 激活 → 真挂载 → 出图 → 关闭清理 ----
    await page.evaluate(() => window.XHGCS_CORE.commands.execute('xhgcs.views'));
    await page.waitForSelector('.vc-shell', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('.vc-host canvas').length > 0, null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const viewInfo = await page.evaluate(() => {
      const canvas = document.querySelector('.vc-host canvas');
      const record = window.XHGCS_CORE.host.list().find((item) => item.manifest.id === 'xihe.demo.hello');
      return {
        navs: document.querySelectorAll('.vc-nav-item').length,
        width: canvas ? canvas.width : 0,
        height: canvas ? canvas.height : 0,
        ink: canvas ? canvas.toDataURL().length : 0,
        status: record ? record.status : 'missing',
        activatedBy: record ? record.activatedBy : ''
      };
    });
    check('views 贡献点在容器里可选中', viewInfo.navs >= 1, JSON.stringify(viewInfo));
    check('视图按 onView 事件激活插件', viewInfo.status === 'active' && /demo\.health/.test(viewInfo.activatedBy), JSON.stringify(viewInfo));
    check('视图挂载到真实画布并画出内容', viewInfo.width > 100 && viewInfo.ink > 2000, JSON.stringify(viewInfo));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vc-shell'), null, { timeout: 4000 });
    check('视图容器关闭后清理挂载', !(await page.$('.vc-host')), '宿主仍在 DOM 里');

    // 旧版表达式视图（state.views）也进同一个容器
    await page.evaluate(() => {
      const state = window.XHGCS.state;
      state.views = state.views || [];
      state.views.push({
        id: 'legacy-smoke',
        name: '旧版演示',
        icon: '◇',
        code: '({id:"legacy-smoke",mount(ctx){const c=document.createElement("canvas");c.style.width="100%";c.style.height="100%";ctx.host.appendChild(c);ctx.draw.scope(c,{channels:"*",points:40});},update(ctx){const c=ctx.host.querySelector("canvas");if(c)ctx.draw.scope(c,{channels:"*",points:40});}})',
        origin: 'user',
        createdAt: Date.now()
      });
      window.XHGCS_CORE.ui.openViews();
    });
    await page.waitForFunction(() => document.querySelectorAll('.vc-nav-item[data-legacy]').length > 0, null, { timeout: 5000 });
    await page.click('.vc-nav-item[data-legacy="1"]');
    await page.waitForTimeout(500);
    const legacyInfo = await page.evaluate(() => ({
      canvases: document.querySelectorAll('.vc-host canvas').length,
      foot: document.querySelector('.vc-foot span') ? document.querySelector('.vc-foot span').textContent : ''
    }));
    check('旧版表达式视图在新容器里可挂载', legacyInfo.canvases >= 1 && /旧版/.test(legacyInfo.foot), JSON.stringify(legacyInfo));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const state = window.XHGCS.state;
      if (Array.isArray(state.views)) state.views = state.views.filter((view) => view.id !== 'legacy-smoke');
    });

    // ---- 设置页集成：扩展分区直接长在老设置弹窗里 ----
    await page.click('#sideNav [data-action="settings"]');
    await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 4000 });
    await page.waitForSelector('[data-settings-nav="extensions"]', { timeout: 4000 });
    await page.click('[data-settings-nav="extensions"]');
    await page.waitForTimeout(250);
    const settingsPane = await page.evaluate(() => {
      const section = document.querySelector('.settings-section[data-settings-panel="extensions"]');
      return {
        active: Boolean(section && section.classList.contains('active')),
        rows: section ? section.querySelectorAll('.xst-ext').length : 0,
        fields: section ? section.querySelectorAll('.xst-row').length : 0,
        navCount: document.querySelectorAll('.settings-nav-btn').length
      };
    });
    check('设置页出现扩展分区并可激活', settingsPane.active === true, JSON.stringify(settingsPane));
    check('设置页展示扩展列表与配置', settingsPane.rows >= 2 && settingsPane.fields >= 1, JSON.stringify(settingsPane));
    await page.click('#btnCloseSettings');
    await page.waitForTimeout(200);

    // ---- AI 工具：能看见扩展与引擎 ----
    await page.waitForFunction(() => Boolean(window.XHGCS_AI_TOOLS), null, { timeout: 8000 });
    const aiTools = await page.evaluate(async () => {
      const tools = window.XHGCS_AI_TOOLS;
      const names = tools.names();
      const ext = await tools.execute({ id: 't1', function: { name: 'list_extensions', arguments: '{}' } });
      const pipe = await tools.execute({ id: 't2', function: { name: 'pipeline_metrics', arguments: '{}' } });
      return {
        names: names,
        extOk: ext.ok,
        extHas: /xihe\.demo\.hello/.test(ext.content),
        pipeOk: pipe.ok && /"processed"/.test(pipe.content)
      };
    });
    check('AI 工具能读扩展清单', aiTools.names.includes('list_extensions') && aiTools.extOk && aiTools.extHas, JSON.stringify(aiTools));
    check('AI 工具能读引擎指标', aiTools.pipeOk === true, JSON.stringify(aiTools));

    // ---- 用户扩展目录（装机版）：假 desktop API 验证发现 → 激活 → 冲突保留内置 ----
    const userExt = await page.evaluate(async () => {
      const fixtureManifest = {
        id: 'xhgcs.user.fixture',
        name: '用户目录插件样例',
        version: '0.1.0',
        apiVersion: '1',
        engines: { xhgcs: '>=0.10.0 <1.0.0' },
        main: '/plugins/xhgcs.user.fixture/main.js',
        activationEvents: ['onCommand:userfixture.ping'],
        permissions: ['ui:toast', 'commands:execute'],
        contributes: { commands: [{ id: 'userfixture.ping', title: '用户插件 Ping', category: '用户' }] }
      };
      window.XHGCS_DESKTOP = window.XHGCS_DESKTOP || {};
      window.XHGCS_DESKTOP.extensions = {
        list: async () => ({
          dir: 'C:/fake/extensions',
          items: [
            { dirName: 'xhgcs.user.fixture', manifest: fixtureManifest, baseUrl: '/plugins/xhgcs.user.fixture/' },
            {
              dirName: 'dupe',
              manifest: Object.assign({}, fixtureManifest, { id: 'xihe.demo.hello' }),
              baseUrl: '/plugins/dupe/'
            },
            { dirName: 'broken', error: '清单不是合法 JSON：Unexpected token' }
          ]
        })
      };
      const found = await window.XHGCS_CORE.host.discoverUserExtensions();
      const core = window.XHGCS_CORE;
      const record = core.host.list().find((item) => item.manifest.id === 'xhgcs.user.fixture');
      const statusAfterDiscover = record ? record.status : 'missing';
      // 未授权时激活必须被挡住
      const blocked = await core.host.activate('xhgcs.user.fixture', 'smoke');
      const statusAfterBlocked = record ? record.status : 'missing';
      // 授权（默认勾选低风险能力）后再激活
      core.host.grantAccess('xhgcs.user.fixture');
      const consentStored = Boolean(localStorage.getItem('xhgcs.ext.consent.v1'));
      const activated = await core.host.activate('xhgcs.user.fixture', 'consent');
      const pinged = await core.commands.execute('userfixture.ping').then(
        (value) => value,
        (err) => 'error:' + err.message
      );
      // 停用要持久化，重新读状态仍然停用
      await core.host.disable('xhgcs.user.fixture');
      const disabledPersisted = /xhgcs\.user\.fixture/.test(localStorage.getItem('xhgcs.ext.state.v1') || '');
      await core.host.enable('xhgcs.user.fixture');
      const enabledPersisted = /"xhgcs\.user\.fixture":"enabled"/.test(localStorage.getItem('xhgcs.ext.state.v1') || '');
      // 撤销授权后回到待授权
      await core.host.revokeAccess('xhgcs.user.fixture');
      const statusAfterRevoke = record ? record.status : 'missing';
      return {
        discovered: found.length,
        statusAfterDiscover,
        blocked,
        statusAfterBlocked,
        consentStored,
        activated,
        pinged,
        disabledPersisted,
        enabledPersisted,
        statusAfterRevoke,
        dupeSkipped: !core.host.list().some((item) => item.manifest.id === 'dupe')
      };
    });
    check(
      '用户扩展未授权时停在待授权',
      userExt.discovered === 1 && userExt.statusAfterDiscover === 'resolved' && userExt.blocked === false && userExt.statusAfterBlocked === 'pending',
      JSON.stringify(userExt)
    );
    check(
      '授权后可激活并执行命令',
      userExt.activated && userExt.pinged === 'pong' && userExt.consentStored === true,
      JSON.stringify(userExt)
    );
    check('停用状态持久化并可恢复', userExt.disabledPersisted && userExt.enabledPersisted, JSON.stringify(userExt));
    check('撤销授权回到待授权', userExt.statusAfterRevoke === 'pending', JSON.stringify(userExt));
    check('用户插件 id 冲突时保留内置', userExt.dupeSkipped === true, JSON.stringify(userExt));

    // ---- 扩展配置面板：由 schema 生成，改值写回，恢复默认 ----
    await page.evaluate(() => window.XHGCS_CORE.commands.execute('xhgcs.config'));
    await page.waitForSelector('.xst-mask .xst-shell', { timeout: 4000 });
    const cfgPanel = await page.evaluate(() => ({
      navs: document.querySelectorAll('.xst-mask .xst-nav-item').length,
      rows: document.querySelectorAll('.xst-mask .xst-row').length
    }));
    check('扩展配置面板由 schema 生成', cfgPanel.navs >= 1 && cfgPanel.rows >= 1, JSON.stringify(cfgPanel));

    await page.fill('.xst-mask .xst-row input[type="number"]', '12');
    await page.evaluate(() => {
      const input = document.querySelector('.xst-mask .xst-row input[type="number"]');
      if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const cfgValue = await page.evaluate(() => window.XHGCS_CORE.config.get('xihe.demo.hello', 'warnChannels'));
    check('面板改值写回配置', cfgValue === 12, String(cfgValue));

    await page.click('.xst-mask .xst-actions button');
    await page.waitForTimeout(150);
    const cfgReset = await page.evaluate(() => window.XHGCS_CORE.config.get('xihe.demo.hello', 'warnChannels'));
    check('恢复默认清掉用户值', cfgReset === 8, String(cfgReset));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // ---- 可视化设计器 ----
    const railButton = await page.$('[data-xhgcs-menu="xhgcs.designer"]');
    check('活动栏菜单由贡献点渲染', Boolean(railButton), 'sideNav 里没有设计器入口');

    await page.evaluate(() => window.XHGCS_CORE.commands.execute('xhgcs.designer'));
    await page.waitForSelector('.dsg-shell', { timeout: 5000 });
    const designerBoot = await page.evaluate(() => ({
      palette: document.querySelectorAll('.dsg-pal-item').length,
      groups: document.querySelectorAll('.dsg-group-head').length,
      cells: document.querySelectorAll('.dsg-cell').length,
      props: document.querySelectorAll('.dsg-field').length
    }));
    check('设计器控件库来自贡献点', designerBoot.palette >= 7, JSON.stringify(designerBoot));
    check('设计器首开有可读样板', designerBoot.cells >= 4, JSON.stringify(designerBoot));

    // 选中一个控件 → 属性面板按 schema 生成
    await page.click('.dsg-cell .dsg-cell-head');
    const propsAfterSelect = await page.evaluate(() => ({
      fields: document.querySelectorAll('.dsg-props .dsg-field').length,
      selected: document.querySelectorAll('.dsg-cell.is-selected').length
    }));
    check('选中控件后属性面板按 schema 生成', propsAfterSelect.fields >= 2 && propsAfterSelect.selected === 1, JSON.stringify(propsAfterSelect));

    // 数据绑定编辑器：勾一个未选中的通道，绑定必须写进文档
    const bindUi = await page.evaluate(() => ({
      groups: Array.from(document.querySelectorAll('.dsg-props .dsg-group-head')).map((el) => el.textContent),
      boxes: document.querySelectorAll('.dsg-props .dsg-chrow input').length
    }));
    check('属性面板带数据绑定编辑器', bindUi.groups.includes('数据绑定') && bindUi.boxes >= 1, JSON.stringify(bindUi));
    await page.evaluate(() => {
      const box = Array.from(document.querySelectorAll('.dsg-props .dsg-chrow input')).find((input) => !input.checked);
      if (box) box.click();
    });
    await page.waitForTimeout(150);
    const bindAfter = await page.evaluate(() => {
      const node = document.querySelector('.dsg-cell.is-selected');
      return { nodeId: node ? node.dataset.nodeId : '' };
    });
    await page.evaluate(() => document.querySelector('.dsg-btn[data-primary="1"]').click());
    await page.waitForTimeout(150);
    const bindDoc = await page.evaluate(() => {
      const store = JSON.parse(localStorage.getItem('xhgcs.ui.boards.v2') || 'null');
      const board = store ? store.boards.find((item) => item.id === store.activeId) : null;
      const doc = board ? board.doc : null;
      if (!doc) return { bindings: 0, bound: 0 };
      return {
        bindings: Object.keys(doc.bindings || {}).length,
        bound: (doc.root.children || []).filter((node) => Array.isArray(node.bind) && node.bind.length).length
      };
    });
    check('绑定写入文档并随保存落盘', bindDoc.bindings >= 1 && bindDoc.bound >= 1, JSON.stringify({ bindDoc, bindAfter }));

    // 从控件库拖入一个新控件
    const beforeCells = await page.$$eval('.dsg-cell', (els) => els.length);
    const palItem = await page.$('.dsg-pal-item[data-widget-type="widget.label"]');
    const palBox = await palItem.boundingBox();
    const canvasBox = await (await page.$('.dsg-canvas')).boundingBox();
    await page.mouse.move(palBox.x + 12, palBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 260, canvasBox.y + 420, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((n) => document.querySelectorAll('.dsg-cell').length > n, beforeCells, { timeout: 4000 });
    const afterCells = await page.$$eval('.dsg-cell', (els) => els.length);
    check('拖拽添加控件生效', afterCells === beforeCells + 1, beforeCells + ' → ' + afterCells);

    // 撤销必须精确回退一步
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const afterUndo = await page.$$eval('.dsg-cell', (els) => els.length);
    check('撤销回退到添加之前', afterUndo === beforeCells, beforeCells + ' vs ' + afterUndo);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(200);
    const afterRedo = await page.$$eval('.dsg-cell', (els) => els.length);
    check('重做恢复到添加之后', afterRedo === afterCells, afterCells + ' vs ' + afterRedo);

    // 方向键微调：一格挪动，Shift+方向键改大小
    await page.click('.dsg-cell .dsg-cell-head');
    await page.waitForTimeout(120);
    const arrow = await page.evaluate(async () => {
      const read = () => {
        const core = window.XHGCS_CORE;
        const doc = core.boards.activeDoc();
        const node = doc.root.children.find((item) => item.id === selectedId);
        return node ? { x: node.grid.x, y: node.grid.y, w: node.grid.w, h: node.grid.h } : null;
      };
      const el = document.querySelector('.dsg-cell.is-selected');
      if (!el) return { error: '没有选中控件' };
      window.__selectedId = el.dataset.nodeId;
      const selectedId = window.__selectedId;
      const before = read();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const moved = read();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const resized = read();
      return { before, moved, resized };
    });
    check(
      '方向键可微调控件位置与大小',
      !arrow.error && arrow.moved && arrow.before &&
        arrow.moved.x === arrow.before.x + 1 && arrow.moved.w === arrow.before.w &&
        arrow.resized && arrow.resized.w === Math.max(1, Math.min(12 - arrow.moved.x, arrow.moved.w + 1)),
      JSON.stringify(arrow)
    );

    // 保存后重新打开，文档必须一致
    const saved = await page.evaluate(async () => {
      const read = () => {
        const store = JSON.parse(localStorage.getItem('xhgcs.ui.boards.v2') || 'null');
        const board = store ? store.boards.find((item) => item.id === store.activeId) : null;
        return board ? board.doc : null;
      };
      const before = read();
      document.querySelector('.dsg-btn[data-primary="1"]').click();
      const after = read();
      return { before: before ? before.root.children.length : -1, after: after ? after.root.children.length : -1 };
    });
    check('保存写入本机文档', saved.after > 0, JSON.stringify(saved));

    // 预览模式：控件可交互，编辑手柄让位
    await page.click('.dsg-btn[title*="切换到可交互预览"]');
    const previewState = await page.evaluate(() => ({
      interactive: document.querySelector('.dsg-canvas').dataset.interactive,
      label: document.querySelector('.dsg-btn[data-on="1"]')?.textContent || ''
    }));
    check('预览模式切换生效', previewState.interactive === '1', JSON.stringify(previewState));

    // 关闭设计器
    await page.click('.dsg-head .dsg-btn:last-child');
    await page.waitForFunction(() => !document.querySelector('.dsg-shell'), null, { timeout: 4000 });
    check('设计器可正常关闭且不留遮罩', !(await page.$('.dsg-mask')), '遮罩仍在');

    // ---- 看板库：v1 迁移 + 新建/切换/重命名/复制/删除 + 最后一块保护 ----
    const migration = await page.evaluate(() => {
      const legacy = {
        format: 'xhgcs.ui',
        version: 2,
        id: 'legacy-board',
        name: '旧版看板',
        cols: 12,
        rowHeight: 44,
        root: {
          id: 'root',
          type: 'layout.grid',
          props: {},
          grid: { x: 0, y: 0, w: 12, h: 12 },
          children: [
            { id: 'ln1', type: 'widget.stat', props: { channels: ['ch1'], title: '旧值' }, grid: { x: 0, y: 0, w: 3, h: 2 } },
            { id: 'ln2', type: 'widget.gauge', props: { channels: ['ch1'] }, grid: { x: 3, y: 0, w: 3, h: 3 } },
            { id: 'ln3', type: 'widget.scope', props: { channels: ['ch1', 'ch2'] }, grid: { x: 6, y: 0, w: 6, h: 3 } },
            { id: 'ln4', type: 'widget.table', props: { channels: ['ch1'] }, grid: { x: 0, y: 3, w: 6, h: 3 } }
          ]
        },
        bindings: {},
        createdAt: 1,
        updatedAt: 1
      };
      localStorage.setItem('xhgcs.ui.doc.v1', JSON.stringify(legacy));
      localStorage.removeItem('xhgcs.ui.boards.v2');
      localStorage.removeItem('xhgcs.ui.doc.v1.bak');
      window.XHGCS_CORE.boards.resetCache();
      const doc = window.XHGCS_CORE.boards.activeDoc();
      return {
        name: doc ? doc.name : '',
        cells: doc ? doc.root.children.length : 0,
        legacyKept: Boolean(localStorage.getItem('xhgcs.ui.doc.v1')),
        backup: Boolean(localStorage.getItem('xhgcs.ui.doc.v1.bak')),
        storeCreated: Boolean(localStorage.getItem('xhgcs.ui.boards.v2'))
      };
    });
    check(
      'v1 存档迁移到看板库并保留原档与备份',
      migration.name === '旧版看板' && migration.cells === 4 && migration.legacyKept && migration.backup && migration.storeCreated,
      JSON.stringify(migration)
    );

    const boardLib = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const first = core.boards.active();
      const secondId = core.boards.create('第二块板');
      const afterCreate = core.boards.list().length;
      const switchedBack = core.boards.switchTo(first.id) && core.boards.activeId() === first.id;
      core.boards.rename(secondId, '改名后的板');
      const renamed = core.boards.list().some((board) => board.name === '改名后的板');
      const dupId = core.boards.duplicate(first.id);
      const afterDup = core.boards.list().length;
      const removedDup = core.boards.remove(dupId).ok;
      const removedSecond = core.boards.remove(secondId).ok;
      const afterDelete = core.boards.list().length;
      const guarded = core.boards.remove(core.boards.activeId());
      return {
        afterCreate,
        switchedBack,
        renamed,
        afterDup,
        removedDup,
        removedSecond,
        afterDelete,
        guarded: guarded.ok,
        guardError: guarded.error || '',
        active: core.boards.active()
      };
    });
    check(
      '看板库可新建/切换/重命名/复制/删除',
      boardLib.afterCreate === 2 && boardLib.switchedBack && boardLib.renamed && boardLib.afterDup === 3 && boardLib.removedDup && boardLib.removedSecond && boardLib.afterDelete === 1,
      JSON.stringify(boardLib)
    );
    check('最后一块看板不允许删除', boardLib.guarded === false && /至少/.test(boardLib.guardError), JSON.stringify(boardLib.guardError || boardLib));
    check('删减后活动看板仍有内容', boardLib.active && boardLib.active.widgets === 4, JSON.stringify(boardLib.active));

    // ---- 看板增量补丁：原子应用 / 拒绝非法 / 一次回退 / AI 产物与工具 ----
    const patched = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const before = core.boards.activeDoc();
      const first = before.root.children[0];
      const result = core.boards.applyPatch({
        ops: [
          { op: 'rename', name: '补丁看板' },
          { op: 'update', id: first.id, channel: 'ch2', props: { title: '改过的标题' } },
          { op: 'move', id: first.id, grid: { x: 6, y: 6, w: 3, h: 2 } },
          { op: 'add', widget: { type: 'bars', query: '*' } }
        ]
      });
      const after = core.boards.activeDoc();
      const node = (after.root.children || []).find((item) => item.id === first.id);
      const binding = node && node.bind && node.bind.length ? after.bindings[node.bind[0]] : null;
      return {
        ok: result.ok,
        summary: result.summary,
        diff: result.diff,
        name: after.name,
        count: (after.root.children || []).length,
        title: node ? node.props.title : '',
        grid: node ? node.grid : null,
        channel: binding ? binding.ref : ''
      };
    });
    check(
      '看板补丁原子应用（改名/改通道/移动/新增）',
      patched.ok &&
        patched.diff &&
        patched.diff.added === 1 &&
        patched.diff.updated === 1 &&
        patched.diff.moved === 1 &&
        patched.diff.renamed === 1 &&
        patched.name === '补丁看板' &&
        patched.count === 5 &&
        patched.title === '改过的标题' &&
        patched.grid && patched.grid.x === 6 &&
        patched.channel === 'ch2',
      JSON.stringify(patched)
    );

    const rejected = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const snapshot = JSON.stringify(core.boards.activeDoc());
      const firstId = core.boards.activeDoc().root.children[0].id;
      const r1 = core.boards.applyPatch({ ops: [{ op: 'update', id: 'nope', title: 'x' }] });
      const r2 = core.boards.applyPatch({ ops: [{ op: 'update', id: firstId, props: { notAllowedField: 1 } }] });
      const r3 = core.boards.applyPatch({ ops: [{ op: 'add', widget: { type: 'nope' } }] });
      const r4 = core.boards.applyPatch({ ops: [{ op: 'add', widget: { type: 'stat', channel: 'missing-channel' } }] });
      return {
        codes: [r1.ok, r2.ok, r3.ok, r4.ok],
        unchanged: snapshot === JSON.stringify(core.boards.activeDoc()),
        message: r4.error || ''
      };
    });
    check(
      '非法补丁整体拒绝且文档不变',
      rejected.codes.every((ok) => ok === false) && rejected.unchanged,
      JSON.stringify(rejected)
    );

    const reverted = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const applied = core.boards.applyPatch({ ops: [{ op: 'rename', name: '将被回退' }] });
      const revert = core.boards.revertPatch();
      const doc = core.boards.activeDoc();
      return {
        applied: applied.ok,
        revertOk: revert.ok,
        nameAfter: doc.name,
        count: (doc.root.children || []).length
      };
    });
    check(
      '补丁可一次性回退到应用前',
      reverted.applied && reverted.revertOk && reverted.nameAfter === '补丁看板' && reverted.count === 5,
      JSON.stringify(reverted)
    );

    const patchSpec = await page.evaluate(() => {
      const spec = window.XHGCS_AI_SPEC;
      const descriptor = spec.get('board_patch');
      return {
        has: Boolean(descriptor),
        okCheck: descriptor ? descriptor.check({ ops: [{ op: 'remove', id: 'n1' }] }) : 'missing',
        badCheck: descriptor ? descriptor.check({ ops: [{ op: 'boom' }] }) : 'missing',
        previewOk: descriptor ? descriptor.preview({ ops: [{ op: 'rename', name: 'x' }] }).ok : false
      };
    });
    check(
      'AI 注册表新增看板补丁产物',
      patchSpec.has && patchSpec.okCheck === '' && /不支持/.test(patchSpec.badCheck) && patchSpec.previewOk,
      JSON.stringify(patchSpec)
    );

    const boardTool = await page.evaluate(async () => {
      const tools = window.XHGCS_AI_TOOLS;
      const list = await tools.execute({ id: 'bt1', function: { name: 'list_boards', arguments: '{}' } });
      const one = await tools.execute({ id: 'bt2', function: { name: 'get_board', arguments: '{}' } });
      const parsed = JSON.parse(one.content);
      return {
        listOk: list.ok,
        widgets: Array.isArray(parsed.widgets) ? parsed.widgets.length : -1,
        hintsPatch: /board_patch/.test(parsed.hint || '')
      };
    });
    check(
      'AI 工具能列看板并读出结构（提示用补丁）',
      boardTool.listOk && boardTool.widgets === 5 && boardTool.hintsPatch,
      JSON.stringify(boardTool)
    );

    // 设计器打开时，外部补丁要能把界面刷新到最新文档
    const liveRefresh = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      core.ui.openDesigner();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const beforeTitle = document.querySelector('.dsg-title') ? document.querySelector('.dsg-title').value : '';
      const result = core.boards.applyPatch({ ops: [{ op: 'rename', name: '外部改名' }] });
      await new Promise((resolve) => setTimeout(resolve, 450));
      const afterTitle = document.querySelector('.dsg-title') ? document.querySelector('.dsg-title').value : '';
      const stillOpen = Boolean(document.querySelector('.dsg-shell'));
      if (stillOpen) document.querySelector('.dsg-head .dsg-btn:last-child').click();
      return { beforeTitle, afterTitle, applied: result.ok, stillOpen };
    });
    check(
      '外部补丁后设计器自动刷新',
      liveRefresh.applied && liveRefresh.stillOpen && liveRefresh.afterTitle === '外部改名',
      JSON.stringify(liveRefresh)
    );

    // ---- MCP 看板工具走的那条队列执行体（浏览器侧） ----
    await page.evaluate(async () => {
      // bridge.js 是懒加载组：MCP 没开时不会自动载入，测试里显式拉一次
      if (window.XHGCS_LOADER && typeof window.XHGCS_LOADER.ensure === 'function') {
        await window.XHGCS_LOADER.ensure('bridge');
      }
    });
    const boardQueue = await page.evaluate(() => {
      const bridge = window.XHGCS_BRIDGE;
      if (!bridge || typeof bridge.applyBoardAction !== 'function') return { missing: true };
      const core = window.XHGCS_CORE;
      const list = bridge.applyBoardAction({ type: 'board_list' });
      const got = bridge.applyBoardAction({ type: 'board_get', id: core.boards.activeId() });
      const dry = bridge.applyBoardAction({
        type: 'board_patch',
        dryRun: true,
        ops: [{ op: 'rename', name: '不应生效' }]
      });
      const applied = bridge.applyBoardAction({
        type: 'board_patch',
        ops: [{ op: 'rename', name: 'MCP 改名' }]
      });
      const renamed = core.boards.active().name;
      const undone = bridge.applyBoardAction({ type: 'board_undo' });
      return {
        missing: false,
        listCount: (list.list || []).length,
        widgets: got.board ? got.board.widgets.length : -1,
        dryOk: Boolean(dry.preview && dry.preview.ok),
        dryDidNotApply: renamed !== '不应生效',
        appliedOk: Boolean(applied.result && applied.result.ok),
        renamed,
        undoOk: Boolean(undone.result && undone.result.ok),
        afterUndo: core.boards.active().name
      };
    });
    check('MCP 看板队列项可列出/读取/预检', !boardQueue.missing && boardQueue.listCount >= 1 && boardQueue.widgets === 5 && boardQueue.dryOk, JSON.stringify(boardQueue));
    check(
      'MCP 看板补丁可应用并一步回退',
      !boardQueue.missing && boardQueue.dryDidNotApply && boardQueue.appliedOk && boardQueue.renamed === 'MCP 改名' && boardQueue.undoOk && boardQueue.afterUndo !== 'MCP 改名',
      JSON.stringify(boardQueue)
    );

    // 看板运行态：与设计器同一份文档，同一套控件
    await page.evaluate(() => window.XHGCS_CORE.commands.execute('xhgcs.board'));
    await page.waitForSelector('.board-mask', { timeout: 5000 });
    await page.waitForTimeout(420);
    const board = await page.evaluate(() => ({
      cells: document.querySelectorAll('.board-canvas .dsg-cell').length,
      canvases: document.querySelectorAll('.board-canvas .dsg-cell canvas').length,
      chrome: document.querySelector('.board-mask').dataset.chrome
    }));
    check('看板用同一份文档渲染色板', board.cells >= 4 && board.canvases >= 3, JSON.stringify(board));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-mask'), null, { timeout: 4000 });
    check('Esc 退出看板并释放渲染器', !(await page.$('.board-mask')), '看板未关闭');

    // ---- 浮层栈：看板叠在设计器上，Esc 只关最上层 ----
    await page.evaluate(() => window.XHGCS_CORE.ui.openDesigner());
    await page.waitForSelector('.dsg-shell', { timeout: 4000 });
    await page.evaluate(() => window.XHGCS_CORE.ui.openBoard());
    await page.waitForSelector('.board-mask', { timeout: 4000 });
    const layerDepth = await page.evaluate(() => window.XHGCS_OVERLAY.depth());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    const afterFirstEsc = await page.evaluate(() => ({
      board: Boolean(document.querySelector('.board-mask')),
      designer: Boolean(document.querySelector('.dsg-shell')),
      depth: window.XHGCS_OVERLAY.depth()
    }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    const afterSecondEsc = await page.evaluate(() => ({
      board: Boolean(document.querySelector('.board-mask')),
      designer: Boolean(document.querySelector('.dsg-shell')),
      depth: window.XHGCS_OVERLAY.depth()
    }));
    check('叠层 Esc 只关最上层（先看板后设计器）',
      layerDepth === 2 &&
        afterFirstEsc.board === false && afterFirstEsc.designer === true &&
        afterSecondEsc.board === false && afterSecondEsc.designer === false && afterSecondEsc.depth === 0,
      JSON.stringify({ layerDepth, afterFirstEsc, afterSecondEsc })
    );

    // ---- 舞台级 Dock：切视图不消失，AI 不再把人拽回可视化 ----
    const dockStruct = await page.evaluate(async () => {
      const dock = document.getElementById('workspaceDock');
      document.querySelector('[data-nav="input"]').click();
      await new Promise((r) => setTimeout(r, 120));
      return {
        insideView: Boolean(dock && dock.closest('.view')),
        activeView: (document.querySelector('.view.active') || {}).id || '',
        rail: document.querySelector('[data-nav="input"] .lbl').textContent
      };
    });
    await page.keyboard.press('Alt+3');
    await page.waitForTimeout(180);
    const dockAfter = await page.evaluate(() => {
      const dock = document.getElementById('workspaceDock');
      try {
        document.querySelector('[data-nav="visual"]').click();
      } catch (err) {
        /* ignore */
      }
      return {
        dockOpen: Boolean(dock && !dock.classList.contains('hidden') && dock.getBoundingClientRect().width > 100),
        aiTab: document.querySelector('[data-dock-tab="ai"]').getAttribute('aria-selected'),
        stillSerial: (document.querySelector('.view.active') || {}).id || ''
      };
    });
    check(
      'Dock 已提升到舞台级且跨视图常驻',
      dockStruct.insideView === false && dockStruct.activeView === 'view-input' && dockAfter.dockOpen === true && dockAfter.aiTab === 'true',
      JSON.stringify({ dockStruct, dockAfter })
    );
    check('左栏「协议」已并入「输入」', dockStruct.rail === '输入', JSON.stringify(dockStruct));

    // ---- 空态：没有数据时给三条出路 ----
    const emptyState = await page.evaluate(async () => {
      const chip = document.getElementById('btnSimHeaderToggle');
      const wasOn = Boolean(window.XHGCS && window.XHGCS.state.simulation.enabled);
      if (wasOn) chip.click();
      window.XHGCS.allChannels().forEach((ch) => { ch.data.length = 0; });
      await new Promise((r) => setTimeout(r, 380));
      const box = document.getElementById('chartEmpty');
      const buttons = Array.from(document.querySelectorAll('[data-empty-action]')).map((b) => b.textContent.trim());
      document.querySelector('[data-empty-action="protocol"]').click();
      await new Promise((r) => setTimeout(r, 140));
      const view = (document.querySelector('.view.active') || {}).id || '';
      document.querySelector('[data-nav="visual"]').click();
      if (wasOn) chip.click();
      return { visible: Boolean(box && !box.classList.contains('hidden')), buttons, view };
    });
    check(
      '图表空态可见且三条出路可跳转',
      emptyState.visible === true && emptyState.buttons.length === 3 && emptyState.view === 'view-input' && /仿真/.test(emptyState.buttons[0]),
      JSON.stringify(emptyState)
    );

    // ---- 浅色主题下的命令面板可读性（原为深底深字 1.12:1） ----
    const paletteContrast = await page.evaluate(async () => {
      const lum = (rgb) => {
        const parts = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
      };
      const parse = (text) => (String(text).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const root = document.documentElement;
      const prevTheme = root.dataset.theme || '';
      root.dataset.theme = 'light';
      window.XHGCS_CORE.ui.openPalette();
      await new Promise((r) => setTimeout(r, 220));
      const panel = document.querySelector('.xhgcs-palette');
      const input = panel.querySelector('input');
      const styles = getComputedStyle(panel);
      const bg = (styles.backgroundImage.match(/rgb\([^)]+\)/) || [styles.backgroundColor])[0];
      const fg = getComputedStyle(input).color;
      const l1 = lum(parse(fg));
      const l2 = lum(parse(bg));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      root.dataset.theme = prevTheme;
      await new Promise((r) => setTimeout(r, 150));
      return { ratio: Number(ratio.toFixed(2)), closed: !document.querySelector('.xhgcs-palette'), fg, bg };
    });
    check(
      '浅色主题命令面板对比度达标（≥4.5:1）',
      paletteContrast.ratio >= 4.5 && paletteContrast.closed,
      JSON.stringify(paletteContrast)
    );

    // ---- 左栏语义统一：单击切整页，Alt+单击开小窗 ----
    const clickSemantics = await page.evaluate(async () => {
      const bar = document.querySelector('.sw-item[data-subview="bar"]');
      bar.click();
      await new Promise((r) => setTimeout(r, 240));
      const afterClick = {
        subview: window.XHGCS.state.subview,
        work: !document.getElementById('chartWorkbench').classList.contains('hidden')
      };
      document
        .querySelector('.sw-item[data-subview="table"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
      await new Promise((r) => setTimeout(r, 240));
      const afterAlt = {
        subview: window.XHGCS.state.subview,
        work: !document.getElementById('chartWorkbench').classList.contains('hidden')
      };
      if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.closeChartWork) window.XHGCS_VIEWS.closeChartWork();
      document.querySelector('.sw-item[data-subview="wave"]').click();
      await new Promise((r) => setTimeout(r, 160));
      return {
        afterClick,
        afterAlt,
        options: Array.from(document.querySelectorAll('#wbSelect option')).map((o) => o.value)
      };
    });
    check(
      '左栏单击切整页、Alt+单击开小窗，且小窗下拉有选项',
      clickSemantics.afterClick.subview === 'bar' &&
        clickSemantics.afterClick.work === false &&
        clickSemantics.afterAlt.work === true &&
        clickSemantics.afterAlt.subview === 'bar' &&
        clickSemantics.options.includes('bar') &&
        clickSemantics.options.includes('map'),
      JSON.stringify(clickSemantics)
    );

    // ---- 插件生命周期：停用钩子必须执行，重载必须重新执行代码 ----
    const lifecycle = await page.evaluate(async () => {
      const core = window.XHGCS_CORE;
      window.__life = { activate: 0, deactivate: 0, version: 0 };
      const script =
        'window.__life = window.__life || {activate:0,deactivate:0,version:0};' +
        'function activate(){ window.__life.activate += 1; window.__life.version = 1; }' +
        'function deactivate(){ window.__life.deactivate += 1; }';
      core.host.add({
        id: 'smoke.lifecycle',
        name: '生命周期探针',
        version: '0.1.0',
        apiVersion: '1',
        engines: { xhgcs: '>=0.10.0 <1.0.0' },
        main: 'inline',
        activationEvents: ['onCommand:smoke.lifecycle.run'],
        inlineScript: script,
        permissions: []
      });
      const activated = await core.host.activate('smoke.lifecycle', 'smoke');
      const record = core.host.list().find((item) => item.manifest.id === 'smoke.lifecycle');
      if (record) record.manifest.inlineScript = script.replace('version = 1', 'version = 2');
      const reloaded = await core.host.reload('smoke.lifecycle');
      const afterReload = { ...window.__life };
      await core.host.disable('smoke.lifecycle');
      const afterDisable = { ...window.__life };
      return { activated, reloaded, afterReload, afterDisable };
    });
    check(
      '插件停用钩子会执行',
      lifecycle.activated === true && lifecycle.afterDisable.deactivate >= 2,
      JSON.stringify(lifecycle)
    );
    check(
      '插件重载会重新执行代码',
      lifecycle.reloaded === true && lifecycle.afterReload.version === 2 && lifecycle.afterReload.activate >= 2,
      JSON.stringify(lifecycle)
    );

    // ---- 导入看板不能把节点 id 当 HTML 执行 ----
    await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const evil = '<img src=x onerror="window.__xss=1">';
      window.__xss = 0;
      core.boards.importDoc(JSON.stringify({
        format: 'xhgcs.ui',
        version: 2,
        id: 'ui.xssprobe',
        name: 'XSS 探针',
        cols: 12,
        rowHeight: 44,
        root: {
          id: 'root',
          type: 'layout.grid',
          props: {},
          grid: { x: 0, y: 0, w: 12, h: 12 },
          children: [{ id: evil, type: 'widget.label', props: { text: 'x' }, grid: { x: 0, y: 0, w: 3, h: 2 } }]
        },
        bindings: {},
        createdAt: 1,
        updatedAt: 1
      }));
      core.ui.openDesigner();
    });
    await page.waitForSelector('.dsg-shell', { timeout: 4000 });
    await page.click('.dsg-cell .dsg-cell-head');
    await page.waitForTimeout(300);
    const xssProbe = await page.evaluate(() => {
      const title = document.querySelector('.dsg-props-title');
      const result = {
        imgs: title ? title.querySelectorAll('img').length : -1,
        text: title ? title.textContent : '',
        fired: window.__xss === 1,
        open: Boolean(document.querySelector('.dsg-shell'))
      };
      const close = document.querySelector('.dsg-head .dsg-btn[title="关闭"], .dsg-head .dsg-btn:last-of-type');
      if (result.open && close) close.click();
      return result;
    });
    check(
      '导入看板不会把节点 id 当 HTML 执行',
      xssProbe.imgs === 0 && xssProbe.fired === false && xssProbe.text.indexOf('img') >= 0,
      JSON.stringify(xssProbe)
    );

    // ---- 设计器关闭即保存（不再静默丢改动） ----
    await page.evaluate(() => window.XHGCS_CORE.ui.openDesigner());
    await page.waitForSelector('.dsg-shell', { timeout: 4000 });
    const beforeClose = await page.evaluate(() => {
      const doc = window.XHGCS_CORE.boards.activeDoc();
      const node = doc.root.children[0];
      return { id: node.id, x: node.grid.x };
    });
    await page.click('.dsg-cell .dsg-cell-head');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(160);
    // 第一下 Esc 取消选中（浮层栈的 onEscape），第二下才关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(160);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(320);
    const closeSave = await page.evaluate((before) => {
      const store = JSON.parse(localStorage.getItem('xhgcs.ui.boards.v2') || 'null');
      const board = store ? store.boards.find((item) => item.id === store.activeId) : null;
      const doc = board ? board.doc : null;
      const node = doc ? (doc.root.children || []).find((item) => item.id === before.id) : null;
      return { open: Boolean(document.querySelector('.dsg-shell')), x: node ? node.grid.x : -1 };
    }, beforeClose);
    check(
      '设计器关闭即保存（Esc 不丢改动）',
      closeSave.open === false && closeSave.x === beforeClose.x + 1,
      JSON.stringify({ beforeClose, closeSave })
    );

    // ---- AI 生成看板：窄规格 → UiDoc → 落库 → 打开 ----
    const boardGen = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const bad = core.ui.composeBoard({ name: '坏看板', widgets: [{ type: 'nope' }] });
      const good = core.ui.composeBoard({
        name: '冒烟看板',
        widgets: [
          { type: 'scope', channel: 'ch1', points: 60 },
          { type: 'stat', channel: 'ch1', title: '实时' },
          { type: 'table', query: '*' }
        ]
      });
      return {
        badOk: bad.ok,
        badError: bad.error || '',
        goodOk: good.ok,
        widgets: good.doc ? good.doc.root.children.length : 0,
        bindings: good.doc ? Object.keys(good.doc.bindings).length : 0
      };
    });
    check('看板规格拒绝未知控件类型', boardGen.badOk === false && /不支持/.test(boardGen.badError), JSON.stringify(boardGen));
    check('看板规格生成控件与绑定', boardGen.goodOk === true && boardGen.widgets === 3 && boardGen.bindings >= 3, JSON.stringify(boardGen));

    const specGate = await page.evaluate(() => {
      const SPEC = window.XHGCS_AI_SPEC;
      const descriptor = SPEC.get('board');
      return {
        has: Boolean(descriptor),
        okCheck: descriptor ? descriptor.check({ name: 'x', widgets: [{ type: 'scope', channel: 'ch1' }] }) : 'missing',
        badCheck: descriptor ? descriptor.check({ name: 'x', widgets: [{ type: 'zzz' }] }) : 'missing',
        previewOk: descriptor ? descriptor.preview({ name: 'x', widgets: [{ type: 'scope', channel: 'ch1' }] }).ok : false,
        gated: Array.isArray(SPEC.gated) && SPEC.gated.indexOf('board') >= 0
      };
    });
    check(
      'AI 注册表新增看板产物并过闸门',
      specGate.has && specGate.okCheck === '' && /不支持/.test(specGate.badCheck) && specGate.previewOk && specGate.gated,
      JSON.stringify(specGate)
    );

    const applied = await page.evaluate(() => {
      const core = window.XHGCS_CORE;
      const result = core.ui.applyBoard({
        name: 'AI 冒烟看板',
        widgets: [
          { type: 'stat', channel: 'ch1', title: '值' },
          { type: 'scope', channels: ['ch1'], points: 50 }
        ]
      });
      const store = JSON.parse(localStorage.getItem('xhgcs.ui.boards.v2') || 'null');
      const board = store ? store.boards.find((item) => item.id === store.activeId) : null;
      const savedDoc = board ? board.doc : null;
      return {
        ok: result.ok,
        widgets: result.widgets,
        savedName: savedDoc && savedDoc.name,
        boardOpen: Boolean(document.querySelector('.board-mask'))
      };
    });
    check(
      'AI 看板落库并立即全屏运行',
      applied.ok && applied.widgets === 2 && applied.savedName === 'AI 冒烟看板' && applied.boardOpen,
      JSON.stringify(applied)
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    check('全程无控制台报错', errors.length === 0, errors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(failed.length + ' 项未通过');
    process.exit(1);
  }
  console.log(results.length + ' 项全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


