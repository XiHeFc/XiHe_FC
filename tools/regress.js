'use strict';
// 回归测试：不开 Electron、不接真实串口，用真实 Chromium 把核心数据链跑一遍。
//   node tools/regress.js              跑全部
//   node tools/regress.js --filter=协议  只跑名字里含关键字的用例
//   node tools/regress.js --headed     看着它跑
// 浏览器优先用 %LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64\chrome.exe（本机已有），
// 找不到就交给 playwright 自己的默认路径（需要 npm run 里先装浏览器）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStaticServer } = require('../electron/static-server');
const { createRecorder } = require('../electron/recorder');

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

const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith('--filter=')) || '').split('=')[1] || '';
const headed = args.includes('--headed');

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function assert(cond, message) { if (!cond) throw new Error(message); }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= Math.abs(Number(tol) || 0.0001); }

test('启动：模块齐全、无控制台报错', async (page, ctx) => {
  const info = await page.evaluate(() => ({
    core: !!window.XHGCS,
    protocol: !!window.XHGCS_PROTOCOL,
    analysis: !!window.XHGCS_ANALYSIS,
    views: !!window.XHGCS_VIEWS,
    channels: window.XHGCS ? window.XHGCS.state.channels.length : -1,
    scripts: window.XHGCS ? window.XHGCS.state.scripts.length : -1,
    assetVersion: window.XHGCS_ASSET_VERSION || '',
    version: window.XHGCS && window.XHGCS.state ? 'ok' : 'no'
  }));
  assert(info.core && info.protocol && info.analysis && info.views, '核心模块没加载齐：' + JSON.stringify(info));
  assert(info.channels >= 1, '通道数为 0：' + info.channels);
  assert(/^\d{8}[A-Z]$/.test(info.assetVersion), '资源版本没有传给 Worker/懒加载模块：' + info.assetVersion);
  assert(ctx.errors.length === 0, '控制台有报错：' + ctx.errors.slice(0, 3).join(' | '));
});

test('协议：WED 编解码往返 + 丢坏帧', async (page) => {
  const out = await page.evaluate(() => {
    const P = window.XHGCS_PROTOCOL;
    const preset = P.presetByKey('wed');
    const engine = preset && preset.engine ? preset.engine : preset;
    const defs = P.definitions(engine);
    const values = {};
    defs.forEach((d, i) => { values[d.name] = (i + 1) * (Number(d.scale) || 1) * 7; });
    const frame = P.encode(values, engine);
    const back = P.decodeFrame(frame, engine);
    const bad = Array.from(frame);
    bad[bad.length - 1] ^= 0xff;
    const stream = [1, 2, 3].concat(Array.from(frame), Array.from(frame), bad);
    const ingested = P.ingest(stream, engine, []);
    let worst = 0;
    defs.forEach((d) => { worst = Math.max(worst, Math.abs((back.values[d.name] || 0) - values[d.name])); });
    return { ok: back.ok, error: back.error || '', count: Object.keys(back.values || {}).length, defs: defs.length, worst, frames: ingested.frames.length };
  });
  assert(out.ok, '解码失败：' + out.error);
  assert(out.count === out.defs, '通道数对不上：' + out.count + ' != ' + out.defs);
  assert(out.worst < 1e-6, '往返值有偏差：' + out.worst);
  assert(out.frames === 2, '坏帧没被丢掉，解析出 ' + out.frames + ' 帧（期望 2）');
});

test('协议：四套预设都能给出通道定义', async (page) => {
  const out = await page.evaluate(() => {
    const P = window.XHGCS_PROTOCOL;
    return ['json', 'ascii', 'hex', 'wed'].map((key) => {
      const preset = P.presetByKey(key);
      const engine = preset && preset.engine ? preset.engine : preset;
      const defs = P.definitions(engine) || [];
      return { key, hasPreset: !!preset, name: preset ? preset.name || '' : '', defs: defs.length };
    });
  });
  out.forEach((r) => assert(r.hasPreset, r.key + ' 预设不存在'));
  assert(out[3].defs >= 20, 'WED 通道定义少于 20：' + out[3].defs);
  assert(out.some((r) => r.defs > 0), '没有一套预设能给出通道定义');
});

test('脚本：函数表达式跑通并写进脚本通道', async (page) => {
  const out = await page.evaluate(async () => {
    const A = window.XHGCS_ANALYSIS;
    const s = window.XHGCS.state;
    const chId = s.channels[0].id;
    const script = {
      id: 'regress-mean',
      name: '回归·均值',
      type: 'functions',
      formula: 'mean(' + chId + ')',
      inputs: [chId],
      outputs: [{ id: 'regress-out', label: '回归均值', unit: '', range: [0, 100] }]
    };
    A.ensureOutputs(script);
    const values = await A.runScript(script, [chId]);
    const ch = s.scriptChannels.find((c) => c.scriptId === 'regress-mean');
    return {
      out1: values ? values['regress-out'] : null,
      hasChannel: !!ch,
      last: ch && ch.data && ch.data.length ? ch.data[ch.data.length - 1] : null,
      error: s.analysis.lastError || ''
    };
  });
  assert(!out.error, '脚本执行报错：' + out.error);
  assert(Number.isFinite(Number(out.out1)), '脚本没返回数值：' + JSON.stringify(out));
  assert(out.hasChannel, '没有生成脚本通道');
});

test('视图：六个一级页面都能切且不报错', async (page, ctx) => {
  // 协议与串口已合并为「输入」；串口页经输入页头的「指令台」进入
  const views = { visual: 'view-wave', analysis: 'view-analysis', input: 'view-input', alarm: 'view-alarm', sim: 'view-sim' };
  for (const key of Object.keys(views)) {
    await page.click('[data-nav="' + key + '"]');
    await page.waitForTimeout(500);
    const visible = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    }, views[key]);
    assert(visible, key + ' 页面切不过去');
  }
  await page.click('[data-nav="input"]');
  await page.waitForTimeout(300);
  await page.click('#btnOpenSerialConsole');
  await page.waitForTimeout(500);
  const serialVisible = await page.evaluate(() => {
    const el = document.getElementById('view-serial');
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  assert(serialVisible, 'serial 指令台页面切不过去');
  assert(ctx.errors.length === 0, '切页面时控制台报错：' + ctx.errors.slice(0, 2).join(' | '));
});

test('布局：数据引擎一级页同步协议、实例与高级配置', async (page) => {
  await page.click('[data-nav="input"]');
  await page.waitForTimeout(350);
  const info = await page.evaluate(() => {
    const X = window.XHGCS;
    const view = document.getElementById('view-input');
    return {
      activeNav: document.querySelector('#sideNav [data-nav="input"]').classList.contains('active'),
      visible: !view.classList.contains('hidden') && view.getBoundingClientRect().height > 300,
      presets: document.querySelectorAll('#enginePresets .engine-preset').length,
      options: document.querySelectorAll('#engineList option').length,
      oldBottomBar: Boolean(document.getElementById('vofaBottomBar')),
      advancedHidden: document.getElementById('engineAdvanced').hidden
    };
  });
  assert(info.activeNav && info.visible, '数据引擎没有成为激活的一级页：' + JSON.stringify(info));
  assert(info.presets >= 5 && info.options >= 6, '协议预设或已保存引擎列表没有完整渲染：' + JSON.stringify(info));
  assert(!info.oldBottomBar, '底部重复状态条应已移除：' + JSON.stringify(info));
  assert(info.advancedHidden, '高级配置默认不该占掉工作区');

  await page.click('#btnToggleEngineAdvanced');
  await page.waitForTimeout(220);
  const advanced = await page.evaluate(() => {
    const view = document.getElementById('view-input');
    const workspace = view.querySelector('.engine-workspace');
    const panel = document.getElementById('engineAdvanced');
    const field = panel.querySelector('.field-grid');
    return {
      open: !panel.hidden && view.classList.contains('advanced-open'),
      columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').filter(Boolean).length,
      fields: getComputedStyle(field).gridTemplateColumns.split(' ').filter(Boolean).length,
      button: document.getElementById('btnToggleEngineAdvanced').textContent.trim()
    };
  });
  assert(advanced.open && advanced.columns === 2, '高级配置没有展开成双栏编辑：' + JSON.stringify(advanced));
  assert(advanced.fields === 2 && /收起/.test(advanced.button), '高级字段或按钮状态没有跟上：' + JSON.stringify(advanced));
  await page.click('#btnToggleEngineAdvanced');
});

test('布局：四种主题组合下绘图工具条都是单行', async (page) => {
  const bad = [];
  for (const theme of ['dark', 'light']) {
    for (const fx of ['glass', 'codex']) {
      await page.evaluate(([t, f]) => { window.XHGCS.setTheme(t); window.XHGCS.setFx(f); }, [theme, fx]);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.ctrl-head');
        const inSecondRow = Array.from(bar.children).filter((el) => {
          if (getComputedStyle(el).display === 'none') return false;
          const boxes = Array.from(el.querySelectorAll('button')).map((b) => Math.round(b.getBoundingClientRect().top));
          return boxes.length && new Set(boxes).size > 1;
        });
        return { h: Math.round(bar.getBoundingClientRect().height), wraps: inSecondRow.length };
      });
      if (m.h > 40 || m.wraps) bad.push(theme + '/' + fx + ' 高 ' + m.h + 'px / 折行 ' + m.wraps);
    }
  }
  assert(!bad.length, '工具条折行了：' + bad.join('；'));
});

test('布局：1024 窄屏绘图工具条可读，中心图不被侧栏吃掉', async (page) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.click('[data-nav="visual"]');
  await page.evaluate(() => {
    window.XHGCS_LAYOUT.setDockTab('data');
    window.XHGCS_LAYOUT.setDockOpen(true);
    window.XHGCS_LAYOUT.setSerialOpen(false);
  });
  await page.waitForTimeout(350);
  const narrow = await page.evaluate(() => {
    const head = document.querySelector('.ctrl-head');
    const chart = document.querySelector('.ctrl-view');
    const buttons = Array.from(document.querySelectorAll('#plotControls .hbtn')).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        id: button.id || button.textContent.trim(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        whiteSpace: getComputedStyle(button).whiteSpace
      };
    });
    return {
      headHeight: Math.round(head.getBoundingClientRect().height),
      chartWidth: Math.round(chart.getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      buttons,
      left: Math.round(document.querySelector('.ctrl-switch').getBoundingClientRect().width),
      dock: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width)
    };
  });
  assert(narrow.chartWidth >= 560, '1024 下中心图仍被侧栏挤得过窄：' + JSON.stringify(narrow));
  assert(narrow.left <= 170 && narrow.dock <= 220, '1024 下左右栏没有收敛：' + JSON.stringify(narrow));
  assert(narrow.headHeight <= 82, '1024 下绘图工具条占高过多：' + JSON.stringify(narrow));
  assert(!narrow.overflowX, '1024 下页面出现横向滚动：' + JSON.stringify(narrow));
  const cramped = narrow.buttons.filter((button) => button.width < 38 || button.height > 40 || button.whiteSpace !== 'nowrap');
  assert(!cramped.length, '1024 下绘图按钮被压成竖排或裁坏：' + JSON.stringify(cramped));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);
});

test('布局：AI 展开为右栏列：dock 收窄 64、图宽按列计算、图高不变', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForFunction(() => { const el = document.querySelector('.ctrl-view'); return !!el && el.getBoundingClientRect().width > 0; }, { timeout: 2000 });
  await page.evaluate(() => {
    window.XHGCS_LAYOUT.setDockTab('data');
    window.XHGCS_LAYOUT.setDockOpen(true);
  });
  await page.waitForFunction(() => document.querySelector('#workspaceDock').getBoundingClientRect().width > 220, { timeout: 2000 });
  const before = await page.evaluate(() => ({
    chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width),
    chartH: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().height),
    dock: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width),
    left: Math.round(document.querySelector('.ctrl-switch').getBoundingClientRect().width),
    data: !document.querySelector('.channels').hidden,
    ai: !document.getElementById('aiDrawer').hidden,
    panelInHost: document.getElementById('aiPanelHost').contains(document.getElementById('aiPanel')),
    chartLog: Boolean(document.getElementById('btnChartLog')),
    oldBottom: Boolean(document.getElementById('vofaBottomBar')),
    duplicatePalette: Boolean(document.querySelector('.palette-actions'))
  }));
  assert(before.chart > 700, 'VOFA 布局中心图宽过小：' + JSON.stringify(before));
  assert(before.dock >= 220 && before.left >= 180, '左右固定工作栏尺寸异常：' + JSON.stringify(before));
  assert(before.data && !before.ai, '默认应显示数据页并隐藏在列里的 AI：' + JSON.stringify(before));
  assert(before.panelInHost, 'AI 面板没有迁进抽屉宿主 #aiPanelHost');
  assert(before.chartLog && !before.oldBottom && !before.duplicatePalette, '底部重复状态条或控件箱重复入口仍然存在：' + JSON.stringify(before));

  await page.click('[data-workbench-panel="ai"]');
  await page.waitForFunction(() => {
    const d = document.getElementById('aiDrawer');
    return !!d && !d.hidden && d.getBoundingClientRect().width > 0 && Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width) === 64;
  }, { timeout: 2000 });
  const ai = await page.evaluate(() => {
    const messages = document.getElementById('aiMessages');
    const rect = messages.getBoundingClientRect();
    return {
      chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width),
      chartH: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().height),
      dock: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width),
      aiW: Math.round(document.getElementById('aiDrawer').getBoundingClientRect().width),
      left: Math.round(document.querySelector('.ctrl-switch').getBoundingClientRect().width),
      innerW: window.innerWidth,
      collapseDisabled: document.getElementById('btnCollapseDock').getAttribute('aria-disabled'),
      drawerOpen: !document.getElementById('aiDrawer').hidden,
      messagesVisible: rect.width > 80 && rect.height > 80 && getComputedStyle(messages).visibility !== 'hidden',
      active: window.XHGCS_LAYOUT.activePanel()
    };
  });
  assert(ai.drawerOpen, '点 Dock 的 AI 页签没有打开 AI 列：' + JSON.stringify(ai));
  assert(ai.messagesVisible, 'AI 列里看不到 #aiMessages：' + JSON.stringify(ai));
  assert(ai.active === 'ai', 'AI 打开后 activePanel() 该是 ai：' + JSON.stringify(ai));
  assert(ai.dock === 64, 'AI 展开后 dock 应固定 64 读数轨：' + ai.dock);
  assert(Math.abs(ai.chart - (ai.innerW - 52 - ai.left - 64 - ai.aiW)) <= 2, 'AI 展开后图宽应按列计算：' + JSON.stringify(ai));
  assert(ai.chartH === before.chartH, 'AI 展开不应压缩主图高度：' + before.chartH + ' -> ' + ai.chartH);
  assert(ai.collapseDisabled === 'true', 'AI 展开时 dock 收起按钮应 aria-disabled=true：' + ai.collapseDisabled);
  // 关列后继续后面的拖拽/专注模式断言（AI 列已不存在）
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('aiDrawer').hidden, { timeout: 2000 });
  assert(await page.evaluate(() => document.getElementById('aiDrawer').hidden), 'Esc 没关掉 AI 列');
  const closed = await page.evaluate(() => ({
    chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width),
    chartH: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().height),
    dock: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width),
    collapseDisabled: document.getElementById('btnCollapseDock').getAttribute('aria-disabled')
  }));
  assert(Math.abs(closed.chart - before.chart) <= 2 && Math.abs(closed.dock - before.dock) <= 2, '关闭 AI 后图宽与 dock 宽应同时恢复：' + JSON.stringify(closed));
  assert(closed.chartH === before.chartH, '关闭 AI 后主图高度应保持：' + before.chartH + ' -> ' + closed.chartH);
  assert(closed.collapseDisabled === 'false', '关闭 AI 后 dock 收起按钮应恢复可点（aria-disabled=false）：' + closed.collapseDisabled);

  const handle = await page.locator('[data-resize="dock"]').boundingBox();
  assert(handle && handle.width >= 3, '缺少右侧栏拖拽条');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 40, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((bd) => Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width) > bd + 20, before.dock, { timeout: 2000 });
  const resized = await page.evaluate(() => ({
    dock: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width),
    chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width)
  }));
  assert(resized.dock > before.dock + 20 && resized.chart < before.chart - 20, '拖动右栏没有改变宽度：' + JSON.stringify(resized));
  await page.dblclick('[data-resize="dock"]');
  await page.waitForFunction((prev) => Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width) !== prev, resized.dock, { timeout: 2000 });

  await page.evaluate(() => window.XHGCS_LAYOUT.focusChart());
  await page.waitForFunction(() => window.XHGCS_LAYOUT.activePanel() === '' && Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width) <= 64, { timeout: 2000 });
  const focused = await page.evaluate(() => ({
    active: window.XHGCS_LAYOUT.activePanel(),
    dockWidth: Math.round(document.querySelector('#workspaceDock').getBoundingClientRect().width),
    serial: document.querySelector('#serialPanel').classList.contains('hidden'),
    chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width)
  }));
  assert(!focused.active && focused.dockWidth <= 64 && focused.serial, '专注模式没有收起右栏与日志：' + JSON.stringify(focused));
  assert(focused.chart > before.chart, '专注模式没有把宽度还给图表：' + focused.chart);
  await page.evaluate(() => {
    window.XHGCS_LAYOUT.setDockTab('data');
    window.XHGCS_LAYOUT.setDockOpen(true);
  });
});
test('布局：AI 抽屉开合可持久化，顶部日志按钮能独立开合', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.XHGCS_LAYOUT.open('ai');
    window.XHGCS_LAYOUT.setDockOpen(false);
    window.XHGCS_LAYOUT.setSerialOpen(false);
  });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xhgcs.layout.v3') || '{}'));
  assert(saved.aiDrawer === true && saved.dockTab === 'data', '抽屉状态没有写入 layout.v3：' + JSON.stringify(saved));
  assert(await page.evaluate(() => !document.getElementById('aiDrawer').hidden), 'open(ai) 没打开 AI 抽屉');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS_LAYOUT), null, { timeout: 15000 });
  // 不要在这里点导航：点导航会把抽屉自动收起（切页即收），恢复断言就看不到了
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => {
    const messages = document.getElementById('aiMessages');
    const rect = messages.getBoundingClientRect();
    return {
      active: window.XHGCS_LAYOUT.activePanel(),
      drawerOpen: !document.getElementById('aiDrawer').hidden,
      messagesVisible: rect.width > 80 && rect.height > 80,
      panelInHost: document.getElementById('aiPanelHost').contains(document.getElementById('aiPanel'))
    };
  });
  assert(restored.drawerOpen && restored.active === 'ai', '重载后没有恢复 AI 抽屉：' + JSON.stringify(restored));
  assert(restored.messagesVisible && restored.panelInHost, '重载后抽屉里的 AI 面板不完整：' + JSON.stringify(restored));
  // 先关抽屉，后面还要点顶栏日志按钮
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.getElementById('aiDrawer').hidden), 'Esc 没关掉 AI 抽屉');

  await page.click('#btnChartLog');
  await page.waitForTimeout(180);
  const opened = await page.evaluate(() => ({
    open: window.XHGCS_LAYOUT.serialOpen(),
    hidden: document.getElementById('serialPanel').classList.contains('hidden'),
    label: document.getElementById('btnChartLog').textContent.trim()
  }));
  assert(opened.open && !opened.hidden && /收起日志/.test(opened.label), '顶部日志按钮没有展开串口日志：' + JSON.stringify(opened));

  await page.click('#btnChartLog');
  await page.waitForTimeout(180);
  const closed = await page.evaluate(() => ({
    open: window.XHGCS_LAYOUT.serialOpen(),
    hidden: document.getElementById('serialPanel').classList.contains('hidden'),
    label: document.getElementById('btnChartLog').textContent.trim()
  }));
  assert(!closed.open && closed.hidden && closed.label === '日志', '顶部日志按钮没有收起串口日志：' + JSON.stringify(closed));

  await page.evaluate(() => {
    window.XHGCS_LAYOUT.setAiDrawerOpen(false);
    window.XHGCS_LAYOUT.setDockTab('data');
    window.XHGCS_LAYOUT.setDockOpen(true);
    window.XHGCS_LAYOUT.setSerialOpen(false);
  });
});

test('折线图：取消全部数据后时间轴冻结，恢复通道后继续跟随', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    const X = window.XHGCS;
    X.setPlotChannels(X.state.activePlot, []);
    window.XHGCS_VIEWS.renderChart();
  });
  await page.waitForTimeout(250);
  const before = await page.evaluate(() => ({
    t: window.XHGCS.state.t,
    range: window.XHGCS_VIEWS.getChartView()
  }));
  await page.waitForTimeout(750);
  const after = await page.evaluate(() => ({
    t: window.XHGCS.state.t,
    range: window.XHGCS_VIEWS.getChartView(),
    status: document.getElementById('statusInfo').textContent
  }));
  assert(after.t > before.t + 0.35, '仿真时间没有继续推进，无法验证冻结：' + JSON.stringify({ before, after }));
  assert(Math.abs(after.range.xStart - before.range.xStart) < 1e-6
    && Math.abs(after.range.xEnd - before.range.xEnd) < 1e-6,
  '全部数据取消后时间轴仍在移动：' + JSON.stringify({ before: before.range, after: after.range }));
  assert(/时间轴已暂停/.test(after.status), '空图没有明确提示时间轴已暂停：' + after.status);
  await page.evaluate(() => {
    const X = window.XHGCS;
    X.setPlotChannels(X.state.activePlot, null, { follow: true });
    window.XHGCS_VIEWS.renderChart();
  });
});

test('折线图：控件箱以可拖动小窗叠加预览，不替换主图', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(220);
  // 0.23 起：单击左栏 = 切换整页，小窗走工具条的显式下拉。
  // 先单击「波形图」确保图表工具条处于显示状态（上一次用例可能停在数据表页）。
  await page.click('.sw-item[data-subview="wave"]');
  await page.waitForTimeout(180);
  await page.selectOption('#wbSelect', 'bar');
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => {
    const work = document.getElementById('chartWorkbench');
    const wrap = document.querySelector('.chart-wrap');
    const wr = work.getBoundingClientRect();
    const cr = wrap.getBoundingClientRect();
    return {
      open: !work.classList.contains('hidden'),
      title: document.getElementById('chartWorkTitle').textContent,
      view: window.XHGCS.state.subview,
      mainChart: !document.getElementById('chart').classList.contains('hidden'),
      mainActive: document.querySelector('.sw-item[data-subview="wave"]').classList.contains('active'),
      miniActive: document.querySelector('.sw-item[data-subview="bar"]').classList.contains('mini-active'),
      bars: document.querySelectorAll('#chartWorkBody .cwb-bar-row').length,
      inside: wr.left >= cr.left && wr.right <= cr.right + 1 && wr.top >= cr.top && wr.bottom <= cr.bottom + 1,
      resizable: getComputedStyle(work).resize
    };
  });
  assert(opened.open && opened.title === '柱状图', '柱状图小窗没有打开：' + JSON.stringify(opened));
  assert(opened.view === 'wave' && opened.mainChart && opened.mainActive, '小窗预览不应替换主折线图：' + JSON.stringify(opened));
  assert(opened.miniActive && opened.bars >= 1, '小窗状态或内容没有渲染：' + JSON.stringify(opened));
  assert(opened.inside && opened.resizable === 'both', '小窗应限制在图内并可缩放：' + JSON.stringify(opened));

  const beforeDrag = await page.locator('#chartWorkbench').boundingBox();
  const head = await page.locator('#chartWorkHead').boundingBox();
  await page.mouse.move(head.x + 80, head.y + 18);
  await page.mouse.down();
  await page.mouse.move(head.x + 20, head.y - 18, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterDrag = await page.locator('#chartWorkbench').boundingBox();
  assert(afterDrag.x < beforeDrag.x - 20 || afterDrag.y < beforeDrag.y - 10, '小窗没有响应拖动：' + JSON.stringify({ beforeDrag, afterDrag }));

  await page.click('#btnChartWorkClose');
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => document.getElementById('chartWorkbench').classList.contains('hidden')), '小窗关闭按钮失效');
  assert(await page.evaluate(() => window.XHGCS.state.subview === 'wave'), '关闭小窗后主图状态被改变');

  for (const id of ['table', 'gauge', 'map']) {
    await page.selectOption('#wbSelect', id, { force: true });
    await page.waitForTimeout(160);
    const rendered = await page.evaluate((viewId) => ({
      open: !document.getElementById('chartWorkbench').classList.contains('hidden'),
      active: window.XHGCS_VIEWS.chartWorkId(),
      content: document.querySelectorAll('#chartWorkBody > *').length,
      error: document.querySelectorAll('#chartWorkBody .chart-work-empty').length,
      main: !document.getElementById('chart').classList.contains('hidden')
    }), id);
    assert(rendered.open && rendered.active === id && rendered.content >= 1 && rendered.main,
      id + ' 小窗没有正常渲染：' + JSON.stringify(rendered));
    await page.click('#btnChartWorkClose');
  }
});

test('折线图：悬停出现时间游标并一次显示多通道值', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(250);
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .45);
  await page.waitForTimeout(180);
  const hover = await page.evaluate(() => ({
    cross: !document.getElementById('chartCrosshair').classList.contains('hidden'),
    tip: document.getElementById('chartTooltip').classList.contains('show'),
    rows: document.querySelectorAll('#chartTooltip .chart-tip-row').length,
    time: document.getElementById('chartTooltip').textContent
  }));
  assert(hover.cross && hover.tip && hover.rows >= 2, '悬停没有显示多通道时间游标：' + JSON.stringify(hover));
  assert(/t =/.test(hover.time), '时间提示缺少时刻：' + hover.time);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => document.getElementById('chartCrosshair').classList.contains('hidden')), '移出图表后时间游标没有收起');
});

test('构图板：多块视图编译、归一化折线与真挂载自检', async (page) => {
  const out = await page.evaluate(async () => {
    const B = window.XHGCS_VIEW_BLUEPRINT;
    const V = window.XHGCS_VIEWS;
    const spec = B.compile({
      layout: 'dashboard',
      blocks: [
        { type: 'trend', series: [] },
        { type: 'bars', series: [] },
        { type: 'kpi', series: [] }
      ]
    }, '生成一个包含趋势、对比和关键指标的看板');
    const lint = V.lintViewCode(spec.code);
    const report = await window.XHGCS_VIEW_VERIFY.verify(spec.code, { frames: 5 });
    return {
      lint: lint.errors,
      warnings: lint.warnings,
      report: { ok: report.ok, score: report.score, errors: report.errors },
      normalize: spec.code.indexOf('normalize:true') >= 0,
      blocks: (spec.code.match(/vp-blueprint-card/g) || []).length,
      name: spec.name
    };
  });
  assert(!out.lint.length, '构图板生成的代码没通过 lint：' + out.lint.join('；'));
  assert(!out.warnings.length, '构图板生成的代码还有画风警告：' + out.warnings.join('；'));
  assert(out.report.ok, '构图板生成视图自检未通过：' + JSON.stringify(out.report));
  assert(out.normalize, '组合看板的趋势块必须按通道量程归一化');
  assert(out.blocks === 3, '三块构图应生成三张卡，实测 ' + out.blocks);
});

test('AI 对话：一句话直接生成并启用视图，不卡通用动作确认', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(220);
  const backup = await page.evaluate(() => ({
    messages: window.XHGCS.state.ai.messages.slice(),
    viewCount: window.XHGCS.state.views.length
  }));
  await page.click('#sideNav [data-action="ai"]');
  await page.waitForTimeout(260);
  assert(await page.evaluate(() => !document.getElementById('aiDrawer').hidden), 'AI 抽屉没从导航入口打开');
  await page.fill('#aiInput', '生成一个包含趋势和关键指标的视图');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction((count) => window.XHGCS.state.views.length > count, backup.viewCount, { timeout: 8000 });
  const out = await page.evaluate(() => {
    const X = window.XHGCS;
    const view = X.state.views[X.state.views.length - 1];
    const last = X.state.ai.messages[X.state.ai.messages.length - 1];
    return {
      view: { id: view.id, name: view.name, origin: view.origin },
      active: X.state.subview,
      viewResult: last && last.meta && last.meta.viewResult,
      content: last && last.content,
      controlsHidden: document.querySelector('#plotControls').classList.contains('hidden'),
      tabText: Array.from(document.querySelectorAll('.plot-tab')).map((el) => el.textContent.trim()).join('|')
    };
  });
  assert(out.view.origin === 'local-blueprint', '一句话视图没有走可靠构图编译器：' + JSON.stringify(out.view));
  assert(out.active === out.view.id, '生成后没有切到新视图：' + out.active);
  assert(out.viewResult && out.viewResult.id === out.view.id && out.viewResult.verified, '对话里没有可打开的已验证视图卡：' + JSON.stringify(out.viewResult));
  assert(/自检通过/.test(out.content), '回复没有带自检结论：' + out.content);
  assert(out.controlsHidden, '自定义视图仍显示只对主波形有意义的绘图控制');
  assert(out.tabText.indexOf(out.view.name) >= 0, '图页标签没有跟着视图更新：' + out.tabText);

  await page.evaluate((saved) => {
    const X = window.XHGCS;
    const view = X.state.views[X.state.views.length - 1];
    if (view && view.origin === 'local-blueprint') window.XHGCS_VIEWS.removeView(view.id);
    X.state.ai.messages = saved.messages;
    X.state.subview = 'wave';
    X.persist();
    window.XHGCS_VIEWS.switchSubView('wave');
  }, backup);
  // 收尾：抽屉是覆盖层，留着会挡住后面的用例
  await page.evaluate(() => window.XHGCS_AI_UI && window.XHGCS_AI_UI.closeDrawer());
});

test('视图设计器：构图板一键生成并启用', async (page) => {
  await page.click('[data-nav="visual"]');
  await page.waitForTimeout(220);
  await page.click('#btnAiViewStudio');
  await page.waitForSelector('#viewModal:not(.hidden)');
  await page.click('[data-view-block="trend"]');
  await page.click('[data-view-block="kpi"]');
  await page.fill('#viewPrompt', '看姿态趋势并显示关键指标');
  await page.click('#btnViewAiGenerate');
  await page.waitForFunction(() => document.querySelector('#viewModal').classList.contains('hidden'), null, { timeout: 8000 });
  const out = await page.evaluate(() => {
    const X = window.XHGCS;
    const view = X.state.views[X.state.views.length - 1];
    return {
      id: view && view.id,
      name: view && view.name,
      origin: view && view.origin,
      cards: document.querySelectorAll('.vp-blueprint-card').length,
      status: document.querySelector('#toast').textContent,
      active: X.state.subview
    };
  });
  assert(out.cards === 2, '构图板两块图形应生成两张卡，实测 ' + out.cards);
  assert(out.origin === 'local-blueprint', '设计器没有标明本地构图来源：' + JSON.stringify(out));
  assert(out.active === out.id, '生成后没有启用设计器视图：' + out.active);
  assert(/自检通过/.test(out.status), '生成提示没有自检结论：' + out.status);
  await page.evaluate((id) => {
    window.XHGCS_VIEWS.removeView(id);
    window.XHGCS_VIEWS.switchSubView('wave');
  }, out.id);
});

test('共用工具：桥接地址拼接 + Python 降级解析', async (page) => {
  const out = await page.evaluate(() => {
    const X = window.XHGCS;
    const saved = X.state.mcp.endpoint;
    const probe = (value) => { X.state.mcp.endpoint = value; return X.mcpUrl('/api/analyze'); };
    const urls = [probe('http://127.0.0.1:8787/'), probe('http://127.0.0.1:8787'), probe('  http://127.0.0.1:9000//  '), probe('')];
    X.state.mcp.endpoint = saved;
    return {
      urls: urls,
      oneLine: [
        X.pythonOneLine('return np.mean(a)'),
        X.pythonOneLine('# 注释\nreturn a + 1'),
        X.pythonOneLine('def f():\n    return 1'),
        X.pythonOneLine('return math.sqrt(2)')
      ]
    };
  });
  const want = [
    'http://127.0.0.1:8787/api/analyze',
    'http://127.0.0.1:8787/api/analyze',
    'http://127.0.0.1:9000/api/analyze',
    'http://127.0.0.1:8787/api/analyze'
  ];
  out.urls.forEach((u, i) => assert(u === want[i], '第 ' + (i + 1) + ' 个地址不对：' + u));
  assert(out.oneLine[0] === 'mean(a)', 'np. 没被剥掉：' + out.oneLine[0]);
  assert(out.oneLine[1] === 'a + 1', '注释没被剥掉：' + JSON.stringify(out.oneLine[1]));
  assert(out.oneLine[2] === '', '带 def 的代码不该被降级：' + JSON.stringify(out.oneLine[2]));
  assert(out.oneLine[3] === 'sqrt(2)', 'math. 没被剥掉：' + out.oneLine[3]);
});
test('协议：飞控 WED 规格建出 20 通道并把偏置还原', async (page) => {
  const out = await page.evaluate(() => {
    const X = window.XHGCS;
    const P = window.XHGCS_PROTOCOL;
    const fc = P.PRESETS.wedfc;
    const engine = P.presetEngine(fc);
    // 预设里那串 sample 就是「全零位 + 电机怠速」的合法帧，直接拿来对拍
    const hex = String(fc.sample).replace(/[^0-9a-fA-F]/g, '');
    const bytes = Uint8Array.from(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
    const decoded = P.decodeFrame(bytes, engine);
    X.addEngine(Object.assign({}, engine, { id: 'regress-wed-fc', name: '回归·飞控遥测' }));
    X.setActiveEngine('regress-wed-fc');
    const count = X.applyProtocolChannels(X.getActiveEngine());
    const names = X.state.channels.map((ch) => ch.name);
    if (decoded.ok) X.injectRealValues(decoded.values, { engine: engine });
    const chOf = (name) => X.state.channels.find((ch) => ch.name === name) || {};
    const lastOf = (name) => {
      const ch = chOf(name);
      return ch.data && ch.data.length ? ch.data[ch.data.length - 1] : null;
    };
    return {
      byKeyword: P.presetByKey('飞控').key,
      byKey: P.presetByKey('wedfc').key,
      profileId: (X.getActiveEngine() || {}).protocolId,
      defs: P.definitions(engine).length,
      decodedOk: decoded.ok,
      decodedError: decoded.error || '',
      count: count,
      names: names,
      roll: lastOf('横滚角'),
      rate: lastOf('横滚角速度'),
      motor: lastOf('电机 LF'),
      acc: lastOf('机体 Z 加速度'),
      z2: lastOf('观测器 z2 总扰动'),
      scale: chOf('横滚角').scale,
      offset: chOf('横滚角').offset,
      warnLowMotor: chOf('电机 LF').warnLow,
      warnHighMotor: chOf('电机 LF').warnHigh
    };
  });
  assert(out.byKeyword === 'wedfc' && out.byKey === 'wedfc', '飞控预设没被认出来：' + out.byKeyword + '/' + out.byKey);
  assert(out.profileId === 'wed-fc', '引擎规格 id 不对：' + out.profileId);
  assert(out.defs === 20, '飞控规格的通道定义不是 20 条：' + out.defs);
  assert(out.decodedOk, '预设 sample 解不出来：' + out.decodedError);
  assert(out.count === 20, '按飞控规格建出的通道数不对：' + out.count);
  assert(out.names[0] === '横滚角' && out.names[6] === '陀螺 X 原始' && out.names[19] === '机体 Z 加速度', '通道名不对：' + out.names.slice(0, 7).join(','));
  assert(near(out.roll, 0, 0.001), '零位横滚角该是 0，实际 ' + out.roll);
  assert(near(out.rate, 0, 0.001), '零位角速度该是 0，实际 ' + out.rate);
  assert(near(out.z2, 0, 0.001), '零位 ESO 扰动该是 0，实际 ' + out.z2);
  assert(near(out.acc, 0, 0.001), '零位加速度该是 0，实际 ' + out.acc);
  assert(near(out.motor, 1100, 0.001), '怠速电机该是 1100，实际 ' + out.motor);
  assert(out.scale === 0.01 && out.offset === -180, '通道倍率/偏移没落到通道上：' + out.scale + '/' + out.offset);
  assert(out.warnLowMotor === 1040 && out.warnHighMotor === 1480, '电机阈值没覆盖默认值：' + out.warnLowMotor + '/' + out.warnHighMotor);
});
test('分析：单通道取它自己的历史均值，WED 通道必须用公式名', async (page) => {
  const out = await page.evaluate(() => {
    const X = window.XHGCS, A = window.XHGCS_ANALYSIS, S = X.state;
    const fc = (S.engines || []).find((e) => e.protocolId === 'wed-fc');
    X.applyProtocolChannels(fc);
    const ch = S.channels[0];
    ch.data = Array.from({ length: 80 }, (_, i) => 10 + i);   // 10..89，均值 49.5
    const alias = X.formulaAlias(ch.id);
    const script = A.createScriptFromPrompt('生成一个' + ch.name + '均值脚本');
    let rawError = '';
    try { A.computeFormula('mean(' + ch.id + ')', [ch.id]); } catch (err) { rawError = err.message; }
    return {
      alias: alias,
      mean: A.computeFormula('mean(' + alias + ')', [ch.id]),
      cn: A.computeFormula('mean(' + ch.name + ')', [ch.id]),
      inputs: script.inputs,
      formula: script.formula,
      label: script.outputs[0].label,
      rawError: rawError
    };
  });
  assert(out.alias === 'c01', 'WED 通道的公式名该是 c01，实际 ' + out.alias);
  assert(near(out.mean, 49.5, 0.001), '单通道均值该是 49.5，实际 ' + out.mean);
  assert(near(out.cn, 49.5, 0.001), '中文通道名写法该是 49.5，实际 ' + out.cn);
  assert(out.inputs.length === 1 && out.inputs[0] === 'wed-fc-01', '生成的脚本该只吃一个通道，实际 ' + JSON.stringify(out.inputs));
  assert(out.formula === 'mean(c01)', '生成的公式该写公式名，实际 ' + out.formula);
  assert(out.label.length > 1, '输出标签没推导出来：' + out.label);
  assert(/带减号/.test(out.rawError), '直接写带减号的 id 该给出可照做的提示，实际：' + out.rawError);
});

test('入口：数据源回顶栏、分析画布在左列，AI 生成脚本弹对话框', async (page) => {
  const info = await page.evaluate(() => {
    const chip = document.getElementById('btnSimHeaderToggle');
    const rail = document.getElementById('sideNav');
    const topRight = document.querySelector('.top-right');
    const open = document.getElementById('btnOpenAnalysis');
    const tools = Array.from(rail.querySelectorAll(':scope > button'));
    const at = tools.indexOf(open);
    return {
      chipInRail: Boolean(chip && rail.contains(chip)),
      chipInTopRight: Boolean(chip && topRight && topRight.contains(chip)),
      label: (document.getElementById('sourceText') || {}).textContent || '',
      plotButton: Boolean(document.querySelector('#plotControls #btnOpenAnalysis')),
      dialog: Boolean(document.getElementById('scriptDialog')),
      openInRail: Boolean(open && rail.contains(open)),
      prev: at > 0 ? (tools[at - 1].textContent || '').trim() : '',
      next: at >= 0 && at < tools.length - 1 ? (tools[at + 1].textContent || '').trim() : '',
      railLabels: tools.map((b) => (b.textContent || '').replace(/\s+/g, '')),
      analysisAsView: (() => {
        const view = document.getElementById('view-analysis');
        return {
          exists: Boolean(view),
          insideStack: Boolean(view && view.parentElement && view.parentElement.classList.contains('view-stack')),
          overlay: Boolean(view && view.classList.contains('modal-overlay')),
          oldModalGone: !document.getElementById('analysisModal'),
          navAttr: (document.getElementById('btnOpenAnalysis') || {}).dataset ? document.getElementById('btnOpenAnalysis').dataset.nav : ''
        };
      })()
    };
  });
  assert(info.chipInTopRight && !info.chipInRail, '数据源开关该回到顶栏、不再占左侧竖列：' + JSON.stringify(info));
  assert(info.label.length > 1, '数据源开关没有文字标签：' + info.label);
  assert(!info.plotButton, '图表工具条里不该再留分析画布按钮');
  assert(info.openInRail, '分析画布入口该在左侧竖列里：' + JSON.stringify(info));
  assert(/AI/.test(info.prev) && /协议|输入/.test(info.next), '后处理入口没有落在 AI 与输入（协议解析）之间：' + info.prev + ' / ' + info.next);
  assert(info.dialog, '找不到 AI 生成脚本对话框');
  assert(info.analysisAsView.exists && info.analysisAsView.insideStack, '分析画布该是 view-stack 里的一级视图：' + JSON.stringify(info.analysisAsView));
  assert(!info.analysisAsView.overlay && info.analysisAsView.oldModalGone, '分析画布不该再是二级浮层：' + JSON.stringify(info.analysisAsView));
  assert(info.analysisAsView.navAttr === 'analysis', '竖列分析入口该带 data-nav=analysis，实际 ' + info.analysisAsView.navAttr);

  // 上一个用例把页面切到了别的视图，先回到可视化：AI 抽屉入口和画布按钮都在这个视图里
  await page.click('#sideNav [data-nav="visual"]');
  await page.waitForTimeout(400);
  // P2.2：Dock 的 AI 页签已删除，AI 统一走导航入口 → 全局抽屉；断言升级为三条
  await page.click('#sideNav [data-action="ai"]');
  await page.waitForFunction(() => {
    const drawer = document.getElementById('aiDrawer');
    const messages = document.getElementById('aiMessages');
    if (!drawer || drawer.hidden || !messages) return false;
    const r = messages.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
  }, null, { timeout: 5000 });
  const aiEntry = await page.evaluate(() => {
    const drawer = document.getElementById('aiDrawer');
    const messages = document.getElementById('aiMessages');
    const r = messages.getBoundingClientRect();
    const dockTabs = Array.from(document.querySelectorAll('.dock-tab')).map((t) => (t.textContent || '').replace(/\s+/g, '').trim());
    return {
      drawerOpen: Boolean(drawer && !drawer.hidden),
      messagesInViewport: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      dockHasAiTab: dockTabs.some((t) => /AI/i.test(t)),
      dockTabs
    };
  });
  assert(aiEntry.drawerOpen, '导航 AI 入口没有打开全局 AI 抽屉：' + JSON.stringify(aiEntry));
  assert(aiEntry.messagesInViewport, 'AI 抽屉打开后 #aiMessages 不在视口内：' + JSON.stringify(aiEntry));
  assert(!aiEntry.dockHasAiTab, 'Dock 页签里不该再有 AI：' + JSON.stringify(aiEntry));
  // 「生成脚本」现在收在「+」技能菜单里，先开菜单再点
  await page.click('#btnAiPlus');
  await page.waitForTimeout(200);
  await page.click('#aiSuggest [data-ai-dialog="script"]');
  const opened = await page.evaluate(() => ({
    open: !document.getElementById('scriptDialog').classList.contains('hidden'),
    channels: document.querySelectorAll('#sdChannels input').length,
    hint: (document.getElementById('sdChannelHint') || {}).textContent || ''
  }));
  assert(opened.open, '点「生成脚本」没有弹出对话框');
  assert(opened.channels >= 1, '对话框里没有可勾的通道：' + opened.channels);
  assert(opened.hint.length > 0, '对话框缺少通道说明');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.getElementById('scriptDialog').classList.contains('hidden')), 'Esc 没能关掉对话框');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('aiDrawer').hidden, null, { timeout: 5000 });
  assert(await page.evaluate(() => document.getElementById('aiDrawer').hidden), 'Esc 没能关掉 AI 抽屉（P2.2 抽屉化后需要可关闭）');

  await page.click('#btnOpenAnalysis');
  await page.waitForTimeout(400);
  const switchedPage = await page.evaluate(() => {
    const view = document.getElementById('view-analysis');
    const wave = document.getElementById('view-wave');
    return {
      analysisActive: view.classList.contains('active') && !view.classList.contains('hidden'),
      waveHidden: wave.classList.contains('hidden'),
      railActive: document.querySelector('#sideNav [data-nav="analysis"]').classList.contains('active'),
      viewed: window.XHGCS.state.view,
      visible: view.getBoundingClientRect().height > 200
    };
  });
  assert(switchedPage.analysisActive && switchedPage.waveHidden, '点分析入口该把主舞台切到分析页：' + JSON.stringify(switchedPage));
  assert(switchedPage.railActive, '竖列分析入口该高亮');
  assert(switchedPage.viewed === 'analysis', 'state.view 该是 analysis，实际 ' + switchedPage.viewed);
  assert(switchedPage.visible, '分析页高度不够，没铺满舞台：' + switchedPage.visible);

  const synced = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('#analysisInputs input'));
    boxes.forEach((b) => { b.checked = false; });
    const target = boxes[1];
    target.checked = true;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      count: document.querySelectorAll('#analysisInputs input:checked').length,
      id: target.dataset.channelId,
      alias: window.XHGCS.formulaAlias(target.dataset.channelId),
      formula: document.getElementById('analysisFormula').value,
      inputs: window.XHGCS.state.analysis.inputs.join(',')
    };
  });
  assert(synced.count === 1, '该只剩一个勾选，实际 ' + synced.count);
  assert(synced.formula === 'mean(' + synced.alias + ')', '表达式没跟着收成单通道：' + synced.formula);
  assert(synced.inputs === synced.id, '勾选没写回 analysis.inputs：' + synced.inputs);

  // 换成 WED 规格之后，原来勾的 ch2 已经不存在了：勾选和公式都该自动落到第一个真实通道上，
  // 否则页面会停在「一个都没勾、公式写着 mean(ch2)」，点运行就报错。
  const switched = await page.evaluate(() => {
    const X = window.XHGCS;
    X.applyProtocolChannels((X.state.engines || []).find((e) => e.protocolId === 'wed-fc'));
    X.state.analysis.inputs = ['ch2'];   // 换规格前留下的旧勾选，在 WED 规格里根本不存在
    window.XHGCS_ANALYSIS_UI.open();
    const first = X.allChannels()[0];
    window.XHGCS_ANALYSIS_UI.openScriptDialog({});
    const out = {
      checked: X.state.analysis.inputs.slice(),
      formula: document.getElementById('analysisFormula').value,
      alias: X.formulaAlias(first.id),
      dialogChannels: document.querySelectorAll('#sdChannels input').length,
      marks: document.querySelectorAll('#analysisInputs .analysis-alias').length
    };
    window.XHGCS_ANALYSIS_UI.closeScriptDialog();
    return out;
  });
  assert(switched.checked.length === 1 && switched.checked[0] === 'wed-fc-01', '换规格后勾选没落到第一个通道：' + JSON.stringify(switched.checked));
  assert(switched.formula === 'mean(' + switched.alias + ')', '换规格后公式没跟上：' + switched.formula);
  assert(switched.dialogChannels >= 20, '对话框里的通道数不对：' + switched.dialogChannels);
  assert(switched.marks === 20, '通道行没挂公式名：' + switched.marks);
});

test('输入区：技能菜单插入提示词，模型胶囊能切到 DSH 并回写设置，输入框自动长高无拖拽手柄', async (page) => {
  await page.click('#sideNav [data-nav="visual"]');
  await page.waitForTimeout(300);
  await page.click('#sideNav [data-action="ai"]');
  await page.waitForTimeout(260);
  assert(await page.evaluate(() => !document.getElementById('aiDrawer').hidden), 'AI 抽屉没从导航入口打开');

  await page.click('#btnAiPlus');
  await page.waitForTimeout(150);
  const menu = await page.evaluate(() => ({
    open: !document.getElementById('aiSuggest').classList.contains('hidden'),
    skills: document.querySelectorAll('#aiSuggest [data-ai-skill]').length,
    quick: document.querySelectorAll('#aiSuggest [data-ai-cmd]').length,
    items: Array.from(document.querySelectorAll('#aiSuggest .ai-menu-item')).map((el) => el.textContent.trim())
  }));
  assert(menu.open, '「+」没打开技能菜单');
  assert(menu.skills >= 2, '技能里没有索引到 Skill：' + JSON.stringify(menu.items));
  assert(menu.quick >= 5, '快捷指令没跟着进菜单：' + JSON.stringify(menu.items));

  await page.click('#aiSuggest [data-ai-skill="xhgcs"]');
  await page.waitForTimeout(150);
  const applied = await page.evaluate(() => ({
    value: document.getElementById('aiInput').value,
    tag: document.getElementById('aiSkillTag').textContent,
    menuClosed: document.getElementById('aiSuggest').classList.contains('hidden')
  }));
  assert(applied.value.indexOf('xhgcs') >= 0, '技能没插进输入框：' + applied.value);
  assert(applied.tag.length > 0, '技能标签没显示');
  assert(applied.menuClosed, '选完技能菜单该收起');

  await page.click('#btnAiModel');
  await page.waitForTimeout(150);
  const models = await page.evaluate(() => ({
    open: !document.getElementById('aiModelMenu').classList.contains('hidden'),
    backends: Array.from(document.querySelectorAll('#aiModelMenu [data-ai-backend]')).map((el) => el.dataset.aiBackend)
  }));
  assert(models.open, '模型胶囊没打开菜单');
  assert(models.backends.join(',') === 'local,dsh', '后端选项不对：' + JSON.stringify(models.backends));

  await page.click('#aiModelMenu [data-ai-backend="dsh"]');
  await page.waitForTimeout(250);
  const dsh = await page.evaluate(() => ({
    backend: window.XHGCS.state.ai.backend,
    chip: document.getElementById('aiModelName').textContent,
    select: document.getElementById('setAiBackend').value,
    stillOpen: !document.getElementById('aiModelMenu').classList.contains('hidden')
  }));
  assert(dsh.backend === 'dsh', '没切到 DSH 后端：' + JSON.stringify(dsh));
  assert(/DSH/.test(dsh.chip), '胶囊没跟着显示 DSH：' + dsh.chip);
  assert(dsh.select === 'dsh', '设置页下拉没同步：' + dsh.select);
  assert(dsh.stillOpen, '切后端后菜单该留着，好接着挑模型');

  await page.click('#aiModelMenu [data-ai-backend="local"]');
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => ({ backend: window.XHGCS.state.ai.backend, select: document.getElementById('setAiBackend').value }));
  assert(back.backend === 'local' && back.select === 'local', '没切回本地模型：' + JSON.stringify(back));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => document.getElementById('aiModelMenu').classList.contains('hidden')), 'Esc 没关掉模型菜单');
  // 输入框不给手动拖拽：右下角斜杆手柄已移除，高度改由内容自动长（ai-ui.js 的 autoGrow）
  const grip = await page.evaluate(() => document.getElementById('aiInputGrip'));
  assert(grip === null, '输入框右下角还在渲染拖拽手柄 #aiInputGrip');
  const grow = await page.evaluate(() => {
    const input = document.getElementById('aiInput');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const base = input.getBoundingClientRect().height;
    input.value = Array.from({ length: 10 }, (_, i) => '第' + (i + 1) + ' 行').join(String.fromCharCode(10));
    input.dispatchEvent(new Event('input'));
    const tall = input.getBoundingClientRect().height;
    return {
      base,
      tall,
      cap: Math.min(window.innerHeight * 0.48, 460),
      resize: getComputedStyle(input).resize,
      overflow: input.scrollHeight > input.clientHeight + 1
    };
  });
  assert(grow.tall > grow.base + 20, '输入多行后没自动长高：' + JSON.stringify(grow));
  assert(grow.tall <= grow.cap + 1, '自动长高突破了上限：' + JSON.stringify(grow));
  assert(grow.resize === 'none', 'textarea 的 resize 不是 none，会冒出浏览器原生斜杆：' + grow.resize);

  // 抽屉是覆盖层：拖 Dock 之前先关掉，否则鼠标事件被抽屉面板吃掉；
  // 默认 Dock 是折叠的迷你轨，拖拽用例需要先展开（手柄才有可见高度）
  await page.evaluate(() => {
    if (window.XHGCS_AI_UI) window.XHGCS_AI_UI.closeDrawer();
    window.XHGCS_LAYOUT.setDockOpen(true);
  });
  await page.waitForTimeout(250);
  // 右侧 Dock 拖拽改的是整条 Dock
  const panelBefore = await page.evaluate(() => document.getElementById('workspaceDock').getBoundingClientRect().width);
  const handleBox = await page.locator('.resize-handle[data-resize="dock"]').boundingBox();
  assert(handleBox && handleBox.height > 0, '找不到右侧 Dock 的拖拽手柄');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 40, handleBox.y + handleBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const panelAfter = await page.evaluate(() => document.getElementById('workspaceDock').getBoundingClientRect().width);
  assert(Math.abs(panelAfter - panelBefore) > 10, '右侧 Dock 拖拽失效：' + panelBefore + ' → ' + panelAfter);
  // 双击复位，别把改过的列宽留给后面的用例
  await page.dblclick('.resize-handle[data-resize="dock"]');
  await page.waitForTimeout(150);
  // 收尾：把技能塞进去的提示词清掉（抽屉此时是关的，直接改值并派发 input）
  await page.evaluate(() => {
    const input = document.getElementById('aiInput');
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart());
});

test('入口：画布工具条「AI 生成流程」产出流程，脚本库只产算式', async (page) => {
  // 生成入口现在只走 API（本地关键词兜底已删），所以起一个假端点供它调用。
  const http = require('http');
  const graphSpec = {
    name: '横滚角速度标准差',
    description: '对勾选通道求标准差',
    nodes: [
      { id: 'n1', type: 'source', label: '输入通道', x: 60, y: 70, config: { channelId: 'wed-fc-04' } },
      { id: 'n2', type: 'math', label: '标准差', x: 350, y: 120, config: { op: 'std', inputCount: 1, formula: 'std(x1)' } },
      { id: 'n3', type: 'output', label: '标准差', x: 660, y: 115, config: { label: '标准差', unit: '', color: '#38bdf8', range: [0, 100], attach: true } }
    ],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in1' },
      { id: 'e2', source: 'n2', sourceHandle: 'out', target: 'n3', targetHandle: 'in1' }
    ]
  };
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(graphSpec) } }] }));
    });
  });
  const mockPort = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const savedAi = await page.evaluate((port) => {
    const state = window.XHGCS.state;
    const saved = {
      backend: state.ai.backend, useProxy: state.ai.useProxy,
      endpoint: state.ai.endpoint, model: state.ai.model
    };
    state.ai.backend = 'local';
    state.ai.useProxy = false;
    state.ai.endpoint = 'http://127.0.0.1:' + port;
    state.ai.model = 'probe-model';
    return saved;
  }, mockPort);
  try {
  await page.click('#sideNav [data-nav="analysis"]');
  await page.waitForTimeout(400);
  const entry = await page.evaluate(() => {
    const flowBtn = document.getElementById('btnGraphAiFlow');
    const shelfBtn = document.getElementById('btnAnalysisAiScript');
    return {
      inToolbar: Boolean(flowBtn && flowBtn.closest('.graph-toolbar')),
      flowLabel: (flowBtn || {}).textContent || '',
      flowTitle: (flowBtn || {}).title || '',
      shelfLabel: (shelfBtn || {}).textContent || '',
      shelfTitle: (shelfBtn || {}).title || ''
    };
  });
  assert(entry.inToolbar, '「AI 生成流程」该在画布工具条里：' + JSON.stringify(entry));
  assert(/流程/.test(entry.flowLabel) && !/脚本/.test(entry.flowLabel), '工具条入口的名字没点明产物是流程：' + entry.flowLabel);
  assert(/脚本/.test(entry.shelfLabel), '脚本库入口该点明产物是脚本：' + entry.shelfLabel);
  assert(/流程/.test(entry.shelfTitle) || /脚本/.test(entry.shelfTitle), '脚本库入口缺少说明');

  await page.click('#btnGraphAiFlow');
  await page.waitForTimeout(400);
  const dialog = await page.evaluate(() => ({
    open: !document.getElementById('scriptDialog').classList.contains('hidden'),
    title: document.getElementById('sdTitle').textContent,
    labelRowHidden: document.getElementById('sdRow').classList.contains('hidden'),
    createLabel: document.getElementById('btnScriptDialogCreate').textContent
  }));
  assert(dialog.open, '点「AI 生成流程」没弹对话框');
  assert(/流程/.test(dialog.title), '流程模式的标题不对：' + dialog.title);
  assert(dialog.labelRowHidden, '流程模式不该问「输出标签 / 类型」，那是脚本的字段');
  assert(/流程/.test(dialog.createLabel), '流程模式的按钮文案不对：' + dialog.createLabel);
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.getElementById('scriptDialog').classList.contains('hidden')), 'Esc 没能关掉流程对话框');

  // 勾选的通道必须真的成为流程的 source 节点：以前这里写死 电压→ch1 / 电流→ch2…，
  // 换成 WED 20 通道规格后生成的流程会挂在一堆不存在的通道上。
  await page.evaluate(() => {
    const X = window.XHGCS;
    X.applyProtocolChannels((X.state.engines || []).find((e) => e.protocolId === 'wed-fc'));
    window.XHGCS_ANALYSIS_UI.openScriptDialog({ mode: 'flow', inputs: [] });
    const boxes = Array.from(document.querySelectorAll('#sdChannels input'));
    boxes.forEach((b) => { b.checked = false; });
    const target = boxes.find((b) => b.dataset.channelId === 'wed-fc-04');
    target.checked = true;
  });
  await page.fill('#sdPrompt', '对横滚角速度求标准差');
  await page.click('#btnScriptDialogCreate');
  await page.waitForTimeout(2200);
  const generated = await page.evaluate(() => {
    const c = window.XHGCS.state.analysis.canvas;
    const ch = window.XHGCS.state.channels.map((x) => x.id);
    const sources = c.nodes.filter((n) => n.type === 'source').map((n) => n.config.channelId);
    return {
      sources: sources,
      allReal: sources.every((id) => ch.indexOf(id) >= 0),
      types: c.nodes.map((n) => n.type).join('>'),
      closed: document.getElementById('scriptDialog').classList.contains('hidden'),
      toast: (document.getElementById('toast') || {}).textContent || ''
    };
  });
  assert(generated.closed, '生成成功后对话框该关掉');
  assert(generated.sources.length === 1 && generated.sources[0] === 'wed-fc-04', '流程没按勾选建 source 节点：' + JSON.stringify(generated.sources));
  assert(generated.allReal, '流程挂到了不存在的通道上：' + JSON.stringify(generated.sources));
  assert(/source>math>output/.test(generated.types), '流程结构不对：' + generated.types);
  } finally {
    server.close();
    await page.evaluate((saved) => {
      const ai = window.XHGCS.state.ai;
      ai.backend = saved.backend;
      ai.useProxy = saved.useProxy;
      ai.endpoint = saved.endpoint;
      ai.model = saved.model;
    }, savedAi);
  }
});
// 串口链路：BREAK 是线路状态而不是断链 —— 必须放掉句柄再重开继续读。
// 0.8.1 的实测表现是「假报已连接 + 错误号一直涨 + COM18 被本进程占着谁都打不开」，
// 这里用打桩的 navigator.serial 把「一直 BREAK」和「BREAK 之后线路恢复」两条路都跑一遍。
test('串口：BREAK 放句柄重连，线路恢复后继续收数据', async (page) => {
  const broken = await page.evaluate(async () => {
    const state = window.XHGCS.state;
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serial');
    const port = {
      openCalls: 0,
      closeCalls: 0,
      _readable: null,
      _writable: null,
      getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }),
      get readable() { return port._readable; },
      get writable() { return port._writable; },
      async open() {
        port.openCalls += 1;
        port._readable = { getReader: () => ({ read: async () => { await new Promise((resolve) => setTimeout(resolve, 120)); throw new DOMException('Break received', 'NetworkError'); }, releaseLock() {}, cancel: async () => {} }) };
        port._writable = { getWriter: () => ({ write: async () => {}, releaseLock() {} }) };
      },
      async close() { port.closeCalls += 1; port._readable = null; port._writable = null; }
    };
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => ({ getPorts: async () => [port], requestPort: async () => port }) });
    state.simulation.enabled = false;
    try {
      await window.XHGCS_SERIAL.connect();
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return {
        openCalls: port.openCalls,
        closeCalls: port.closeCalls,
        connected: state.serial.connected,
        breaks: state.serial.breaks,
        lastError: state.serial.lastError,
        faults: state.logs.filter((log) => /串口信号异常/.test(log.text)).length
      };
    } finally {
      await window.XHGCS_SERIAL.disconnect().catch(() => {});
      if (descriptor) Object.defineProperty(Navigator.prototype, 'serial', descriptor);
      else delete Navigator.prototype.serial;
    }
  });
  assert(broken.openCalls >= 2 && broken.openCalls <= 4, '重连次数该是 1~3 次，实测 open ' + broken.openCalls + ' 次');
  assert(broken.closeCalls >= broken.openCalls, '每次失败都必须放掉句柄：open ' + broken.openCalls + ' 次 / close ' + broken.closeCalls + ' 次');
  assert(broken.connected === false, '线路一直 BREAK 时不该留在「已连接」状态');
  assert(broken.breaks >= 2, '线路中断次数没记上：' + broken.breaks);
  assert(/Break received/.test(broken.lastError), '最近一次错误原因没保留：' + broken.lastError);
  assert(broken.faults >= 1, '没有给出「检查接线」这种可照做的提示');

  const recovered = await page.evaluate(async () => {
    const state = window.XHGCS.state;
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serial');
    let rounds = 0;
    const port = {
      openCalls: 0,
      closeCalls: 0,
      _readable: null,
      _writable: null,
      getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }),
      get readable() { return port._readable; },
      get writable() { return port._writable; },
      async open() {
        port.openCalls += 1;
        rounds += 1;
        const isBroken = rounds <= 2;
        let fed = 0;
        port._readable = { getReader: () => ({ read: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (isBroken) throw new DOMException('Break received', 'NetworkError');
          fed += 1;
          if (fed > 3) return { done: false, value: new Uint8Array(0) };
          return { done: false, value: new TextEncoder().encode('{"t":1,"ch":{"电压":1.5}}\n') };
        }, releaseLock() {}, cancel: async () => {} }) };
        port._writable = { getWriter: () => ({ write: async () => {}, releaseLock() {} }) };
      },
      async close() { port.closeCalls += 1; port._readable = null; port._writable = null; }
    };
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => ({ getPorts: async () => [port], requestPort: async () => port }) });
    state.simulation.enabled = false;
    // 前面的用例可能已经把活动引擎换成 WED 了：这轮要喂的是 JSON 帧，先明确切回 JSON 引擎
    const jsonEngine = state.engines.find((engine) => String(engine.protocol || '').toUpperCase() === 'JSON');
    if (!jsonEngine) throw new Error('找不到 JSON 引擎，没法验证恢复后的收数');
    window.XHGCS.setActiveEngine(jsonEngine.id);
    state.serial.frames = 0;
    try {
      await window.XHGCS_SERIAL.connect();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return {
        openCalls: port.openCalls,
        connected: state.serial.connected,
        receiving: state.serial.receiving,
        frames: state.serial.frames
      };
    } finally {
      await window.XHGCS_SERIAL.disconnect().catch(() => {});
      if (descriptor) Object.defineProperty(Navigator.prototype, 'serial', descriptor);
      else delete Navigator.prototype.serial;
    }
  });
  assert(recovered.connected === true, '线路恢复后该重新接上，实测 connected=' + recovered.connected);
  assert(recovered.receiving === true, '线路恢复后该进入接收状态，实测 open ' + recovered.openCalls + ' 次仍没有数据');
  assert(recovered.frames > 0, '线路恢复后应该真的解出帧，实测 ' + recovered.frames + ' 帧');

  // 应用内选口面板：主进程那边只有 COM 口名（portName），渲染层的 SerialPort 只有 VID/PID，
  // 所以「插了两个设备该连哪个」只能在这个面板里说清楚。
  const picker = await page.evaluate(async () => {
    const host = document.getElementById('serialPicker');
    const promise = window.XHGCS_SERIAL_PICKER.open({
      requestId: 't1',
      ports: [
        { portId: 'p1', portName: 'COM3', displayName: 'USB-SERIAL CH340', vendorId: '6790', productId: '29987' },
        { portId: 'p2', portName: 'COM18', displayName: 'USB Serial Port', vendorId: '1027', productId: '24577' }
      ],
      preset: 'COM18'
    });
    const rows = Array.from(document.querySelectorAll('.serial-pick-row')).map((row) => row.textContent.trim());
    const checked = document.querySelector('input[name="serialPick"]:checked');
    const visible = !host.classList.contains('hidden');
    window.XHGCS_SERIAL_PICKER.confirm();
    const chosen = await promise;
    return {
      visible: visible,
      rows: rows,
      checked: checked ? checked.value : '',
      chosen: chosen,
      hiddenAfter: host.classList.contains('hidden')
    };
  });
  assert(picker.visible && picker.hiddenAfter, '选口面板没有正常开关');
  assert(picker.rows.length === 2, '面板应该列出两个端口，实测 ' + picker.rows.length + ' 行');
  assert(/COM3/.test(picker.rows[0]) && /COM18/.test(picker.rows[1]), '面板没按 COM 口号列出设备：' + JSON.stringify(picker.rows));
  assert(picker.checked === 'p2', '上次用过的串口该默认选中，实测 ' + picker.checked);
  assert(picker.chosen === 'p2', '确认后该回传选中的 portId，实测 ' + picker.chosen);

  const empty = await page.evaluate(async () => {
    const promise = window.XHGCS_SERIAL_PICKER.open({ requestId: 't2', ports: [] });
    const text = document.getElementById('serialPickList').textContent.trim();
    const disabled = document.getElementById('btnSerialPickConfirm').disabled;
    window.XHGCS_SERIAL_PICKER.cancel();
    return { text: text, disabled: disabled, chosen: await promise };
  });
  assert(/没有枚举到任何串口设备/.test(empty.text), '空列表该给出可照做的排查提示：' + empty.text);
  assert(empty.disabled === true, '空列表时「连接」该是禁用的');
  assert(empty.chosen === null, '取消该回传 null，实测 ' + empty.chosen);
});

test('桥：body 跨 TCP 分块也不会把汉字打成 U+FFFD', async () => {
  const { readRequestBody, captureStream } = await import('../mcp-server/bytes.mjs');
  const http = require('http');
  const { Readable } = require('stream');
  const marker = 'AB平均变化率CD';
  const body = Buffer.from(JSON.stringify({ name: marker }), 'utf8');
  const cut = body.indexOf(Buffer.from('变', 'utf8')) + 2; // 切在「变」的第 2 个字节后面

  // 先把坑本身钉住：逐块 toString() 再拼一定会解出 U+FFFD，也就是界面上看到的「乱码」
  const naive = body.subarray(0, cut).toString('utf8') + body.subarray(cut).toString('utf8');
  assert(naive.indexOf('\uFFFD') >= 0, '测试切点没落在汉字中间，这条用例就失去意义了');

  const server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(await readRequestBody(req, 5e6));
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const echoed = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.write(body.subarray(0, cut), () => setTimeout(() => req.end(body.subarray(cut)), 20));
  });
  server.close();
  assert(JSON.parse(echoed).name === marker, '分两段发出去的 body 该原样解出来，实测 ' + echoed);

  // 子进程输出走同一条路径：Python 统计结果、PowerShell 端点列表里都有中文
  const stream = new Readable({ read() {} });
  const captured = captureStream(stream, 5e6);
  const ended = new Promise((resolve) => stream.on('end', resolve));
  stream.push(body.subarray(0, cut));
  stream.push(body.subarray(cut));
  stream.push(null);
  await ended;
  assert(captured.text().indexOf('\uFFFD') < 0, 'captureStream 也会把跨分块的汉字打坏：' + captured.text());
  assert(JSON.parse(captured.text()).name === marker, 'captureStream 该拼回完整文本');
});

test('桥：body 超过上限仍然拒绝，超限的子进程输出会截断', async () => {
  const { readRequestBody, captureStream } = await import('../mcp-server/bytes.mjs');
  const { Readable } = require('stream');
  const big = Buffer.alloc(4096, 0x61);
  let rejected = '';
  try { await readRequestBody(Readable.from([big]), 1024); }
  catch (err) { rejected = err.message; }
  assert(/payload too large/.test(rejected), '超限的 body 该 reject，实测 ' + JSON.stringify(rejected));

  const stream = new Readable({ read() {} });
  const captured = captureStream(stream, 1024);
  const ended = new Promise((resolve) => stream.on('end', resolve));
  stream.push(big);
  stream.push(big);
  stream.push(null);
  await ended;
  assert(captured.text().length === 1024 && captured.truncated(), 'captureStream 超限该截断并标记，实测 ' + captured.text().length);
});

test('组件：存档里的 U+FFFD 乱码按内置文案修回来，自定义组件不乱动', async (page) => {
  const result = await page.evaluate(() => {
    const broken = {
      id: 'component-slope',
      name: '变化率',
      description: '计算最近 window 个点的平均\uFFFD\uFFFD\uFFFD化率',
      kind: 'formula',
      inputs: [{ id: 'x1', label: '\uFFFD\uFFFD\uFFFD入 1' }],
      outputs: [{ id: 'out1', label: '变化率', unit: '', color: '#fbbf24' }],
      parameters: [{ id: 'window', label: '窗口', type: 'number', default: 5 }],
      config: { formula: 'slope(x1, p_window)' },
      builtin: true
    };
    const mine = XHGCS.normalizeComponent({
      id: 'component-mine',
      name: '我的\uFFFD组件',
      description: '保留原样',
      kind: 'formula',
      inputs: [{ id: 'x1', label: '输入 1' }],
      outputs: [{ id: 'out1', label: '输出' }],
      config: { formula: 'mean(x1)' }
    });
    const clean = XHGCS.normalizeComponent(XHGCS.defaultComponents().find((item) => item.id === 'component-slope'));
    return { healed: XHGCS.normalizeComponent(broken), mine: mine, clean: clean };
  });
  assert(result.healed.description === '计算最近 window 个点的平均变化率', '内置组件的描述该按出厂文案修回来，实测 ' + result.healed.description);
  assert(result.healed.inputs[0].label === '输入 1', '内置组件的端口名该修回来，实测 ' + result.healed.inputs[0].label);
  assert(result.healed.config.formula === 'slope(x1, p_window)', 'config 是用户能改的，不该被动过');
  assert(result.mine.name === '我的\uFFFD组件', '没有出厂文案可比对的组件不该被改，实测 ' + result.mine.name);
  assert(result.clean.description === '计算最近 window 个点的平均变化率', '干净的组件不该被改写，实测 ' + result.clean.description);
});

test('视图规范：lint 拦禁用 API / 硬编码色，放行合规代码', async (page) => {
  const out = await page.evaluate(() => {
    const V = window.XHGCS_VIEWS;
    const bad = V.lintViewCode('({id:"bad",mount(ctx){ctx.host.innerHTML="<canvas></canvas>";ctx.timer=setInterval(function(){},100);},update(ctx){var g=ctx.host.querySelector("canvas").getContext("2d");g.fillStyle="#0d1117";g.fillRect(0,0,10,10);}})');
    const net = V.lintViewCode('({id:"net",mount(ctx){fetch("/x");},update(ctx){ctx.theme();}})');
    const good = V.lintViewCode(V.fallbackTemplate('条形图').code);
    return { bad: bad, net: net, good: good };
  });
  assert(out.bad.errors.length >= 1 && /setInterval/.test(out.bad.errors.join('')), '丢出 setInterval 没被判错：' + JSON.stringify(out.bad.errors));
  assert(out.bad.colors.indexOf('#0d1117') >= 0, '硬编码色没被记下来：' + JSON.stringify(out.bad.colors));
  assert(out.net.errors.length >= 1 && /fetch/.test(out.net.errors.join('')), 'fetch 没被判错：' + JSON.stringify(out.net.errors));
  assert(out.good.errors.length === 0, '内置模板不该有错误：' + out.good.errors.join('；'));
  assert(out.good.warnings.length === 0, '内置模板不该有画风警告：' + out.good.warnings.join('；'));
  assert(out.good.usesTheme === true, '内置模板必须走 ctx.theme()');
});

test('视图自检：坏代码不通过、合规模板真画出内容并清场', async (page) => {
  const out = await page.evaluate(async () => {
    const R = window.XHGCS_VIEW_VERIFY;
    const V = window.XHGCS_VIEWS;
    const broken = await R.verify('({id:"broken",mount(ctx){ctx.host.innerHTML="<canvas></canvas>";},update(ctx){throw new Error("boom");}})', { frames: 3 });
    const bars = await R.verify(V.fallbackTemplate('条形图').code, { frames: 4 });
    // 有 DOM 但什么都没画：不该算通过（同时会提醒没用界面工具类）
    const blank = await R.verify('({id:"blank",mount(ctx){ctx.host.innerHTML="<div></div>";},update(ctx){ctx.theme();}})', { frames: 3 });
    const domNoClass = await R.verify('({id:"dom",mount(ctx){ctx.host.innerHTML="<div class=\'mine\'><span>甲</span></div>";},update(ctx){ctx.theme();}})', { frames: 3 });
    return { broken: broken, bars: bars, blank: blank, domNoClass: domNoClass, hosts: document.querySelectorAll('.view-verify-host').length, active: (window.XHGCS_VIEWS.activeView() || {}).id || '' };
  });
  assert(out.broken.ok === false && /boom/.test(out.broken.errors.join('')), 'update 抛异常没被自检抓到：' + JSON.stringify(out.broken.errors));
  assert(out.bars.ok === true, '内置条形图模板该通过；错误 ' + JSON.stringify(out.bars.errors) + ' 未过项 ' + out.bars.checks.filter((c) => !c.ok).map((c) => c.label).join('、'));
  assert(out.bars.metrics.inkRatio > 0.01, '内置模板该在画布上画出东西，实测墨水率 ' + out.bars.metrics.inkRatio);
  assert(out.bars.metrics.themeReads > 0, '内置模板该取过主题令牌，实测 ' + out.bars.metrics.themeReads);
  assert(out.blank.ok === false, '整块空白不该算通过');
  assert(out.domNoClass.warnings.join('').indexOf('vp-') >= 0, 'DOM 版没用工具类该给画风提醒：' + JSON.stringify(out.domNoClass.warnings));
  assert(out.hosts === 0, '自检宿主必须清理干净，残留 ' + out.hosts);
  assert(out.active !== '__verify__', '自检不该抢走当前激活视图');
});

test('视图原语：选通道/刻度/三种图都画出内容且不溢出宿主', async (page) => {
  const out = await page.evaluate(async () => {
    const R = window.XHGCS_VIEW_VERIFY;
    const X = window.XHGCS;
    const K = window.XHGCS_VIEW_KIT;
    if (!K) return { error: 'view-kit 未加载' };


    // 1) 原语级：通道匹配与整齐刻度（不依赖应用状态，结果确定）
    const fake = { channels: () => [
      { id: 'a1', name: 'AHT20 温度', unit: '°C', color: '#38bdf8', data: [1, 2, 3], visible: true },
      { id: 'a2', name: 'AHT20 湿度', unit: '%RH', color: '#22c55e', data: [4, 5, 6], visible: true },
      { id: 'a3', name: 'JX90614 温度 2', unit: '°C', color: '#f59e0b', data: [7, 8, 9], visible: true }
    ] };
    const picked = K.pick(fake, '温度').map((c) => c.id);
    const all = K.pick(fake, '*').length;
    const ticks = K.ticks(0, 100, 4);

    // 2) 渲染级：真挂载三个原语，宿主里注入两条通道（跑完还原，不污染后面的用例）
    const seeded = [
      { id: 'kit-t1', name: 'AHT20 温度', unit: '°C', color: '#38bdf8', range: [0, 50], visible: true, data: [1, 3, 5, 7, 9, 11, 13, 15] },
      { id: 'kit-t2', name: 'AHT20 湿度', unit: '%RH', color: '#22c55e', range: [0, 100], visible: true, data: [40, 42, 44, 46, 48, 50, 52, 54] }
    ];
    const added = [];
    seeded.forEach((ch) => { if (!X.state.channels.some((c) => c.id === ch.id)) { X.state.channels.push(ch); added.push(ch.id); } });

    const wrap = (body) => '({ id:"kit", mount(ctx){ ctx.plot = ctx.draw.plot(); }, update(ctx){ ' + body + ' } })';
    const scope = await R.verify(wrap('ctx.draw.scope(ctx.plot.canvas, { series:"温度", limit:4, value:true, time:true });'), { frames: 4, shot: true });
    const bars = await R.verify(wrap('ctx.draw.bars(ctx.plot.canvas, { series:"*", limit:8 });'), { frames: 3 });
    const donut = await R.verify(wrap('ctx.draw.donut(ctx.plot.canvas, { series:"*", limit:5 });'), { frames: 3 });

    added.forEach((id) => {
      const at = X.state.channels.findIndex((c) => c.id === id);
      if (at >= 0) X.state.channels.splice(at, 1);
    });

    const fitOf = (r) => (r.checks.find((c) => c.id === 'fit') || {}).ok;
    const inkOf = (r) => r.metrics.inkRatio;
    return {
      picked: picked, all: all, ticks: ticks,
      scope: { ok: scope.ok, fit: fitOf(scope), ink: inkOf(scope), errors: scope.errors, failed: scope.checks.filter((c) => !c.ok).map((c) => c.label + ':' + c.detail) },
      bars: { ok: bars.ok, fit: fitOf(bars), ink: inkOf(bars), failed: bars.checks.filter((c) => !c.ok).map((c) => c.label + ':' + c.detail) },
      donut: { ok: donut.ok, fit: fitOf(donut), ink: inkOf(donut), failed: donut.checks.filter((c) => !c.ok).map((c) => c.label + ':' + c.detail) },
      shot: (scope.shot || '').slice(0, 22),
      hosts: document.querySelectorAll('.view-verify-host').length
    };
  });

  assert(!out.error, out.error || '');
  // 名字子串匹配：'温度' 要同时抓到「AHT20 温度」和「JX90614 温度 2」
  assert(out.picked.join(',') === 'a1,a3', "名字子串选通道不对，实测 " + JSON.stringify(out.picked));
  assert(out.all === 3, '"*" 该选中全部可见通道，实测 ' + out.all);
  assert(out.ticks.length >= 2 && out.ticks[0] === 0, '刻度该从 0 起：' + JSON.stringify(out.ticks));
  const step = out.ticks[1] - out.ticks[0];
  assert(step > 0 && out.ticks.every((v, i) => Math.abs(v - (out.ticks[0] + step * i)) < 1e-6), '刻度该等距：' + JSON.stringify(out.ticks));
  ['scope', 'bars', 'donut'].forEach((key) => {
    const r = out[key];
    assert(r.ok === true, key + ' 原语该通过自检；未过项 ' + JSON.stringify(r.failed) + ' 错误 ' + JSON.stringify(r.errors || []));
    assert(r.fit === true, key + ' 原语画布溢出了宿主：' + JSON.stringify(r.failed));
    assert(r.ink > 0.01, key + ' 原语没在画布上画出东西，墨水率 ' + r.ink);
  });
  assert(out.shot === 'data:image/png;base64,', 'scope 截图该产出 PNG，实测 ' + JSON.stringify(out.shot));
  assert(out.hosts === 0, '自检宿主必须清理干净，残留 ' + out.hosts);
});

test('对话：非流式后端（DSH / 关掉流式）的正文不会被吞成空串', async (page) => {
  // 打桩 /api/ai/chat 返回一份非流式响应：正文只能从 result.content 拿到，没有 onDelta 可用
  await page.route('**/api/ai/chat', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '非流式正文 OK' }, finish_reason: 'stop' }] })
  }));
  const out = await page.evaluate(async () => {
    const X = window.XHGCS;
    const backup = {
      endpoint: X.state.ai.endpoint, model: X.state.ai.model, stream: X.state.ai.stream,
      useProxy: X.state.ai.useProxy, backend: X.state.ai.backend, ttsEnabled: X.state.ai.tts.enabled
    };
    X.state.ai.backend = 'local';
    X.state.ai.endpoint = 'http://127.0.0.1:9';
    X.state.ai.model = 'stub-model';
    X.state.ai.useProxy = true;
    X.state.ai.stream = false;
    X.state.ai.tts.enabled = false;
    let result = null;
    let error = '';
    try {
      result = await window.XHGCS_AI.send('随便问一句');
    } catch (err) {
      error = String((err && err.message) || err);
    }
    X.state.ai.endpoint = backup.endpoint;
    X.state.ai.model = backup.model;
    X.state.ai.stream = backup.stream;
    X.state.ai.useProxy = backup.useProxy;
    X.state.ai.backend = backup.backend;
    X.state.ai.tts.enabled = backup.ttsEnabled;
    return { content: (result && result.content) || '', error: error };
  });
  await page.unroute('**/api/ai/chat');
  assert(!out.error, '非流式对话不该抛异常：' + out.error);
  assert(/非流式正文 OK/.test(out.content), '非流式后端的内容被吞了，实测 ' + JSON.stringify(out.content));
});

test('桥：/api/ai/dsh 报出 DSH 可用性，不可用时必须给可照做的提示', async () => {
  const { spawn } = require('child_process');
  const http = require('http');
  const port = 18700 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port) }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const get = (target) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: target, timeout: 40000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  try {
    let health = null;
    for (let i = 0; i < 40 && !health; i++) {
      try { health = await get('/api/health'); } catch (err) { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert(health && health.status === 200, '桥没起来，拿不到 /api/health');
    const raw = await get('/api/ai/dsh?refresh=1');
    assert(raw.status === 200, 'DSH 状态接口该存在，实测 HTTP ' + raw.status + ' ' + raw.body.slice(0, 120));
    const dsh = JSON.parse(raw.body);
    assert(typeof dsh.ok === 'boolean', 'DSH 状态缺少 ok 布尔字段：' + raw.body);
    if (dsh.ok) assert(dsh.entry && /dsh/i.test(dsh.entry), 'DSH 可用时该给出入口路径，实测 ' + dsh.entry);
    else assert(String(dsh.error || '').length > 10, 'DSH 不可用时必须给可照做的提示，实测 ' + JSON.stringify(dsh.error));
  } finally {
    child.kill();
  }
});

test('视图设计器：不合规代码拦下、合规代码保存并启用', async (page) => {
  await page.evaluate(() => { window.XHGCS_VIEWS.openViewDesigner(); document.getElementById('viewName').value = '设计器自检视图'; });
  await page.waitForSelector('#viewModal:not(.hidden)');
  const badCode = '({id:"designer-bad",mount(ctx){ctx.host.innerHTML="<canvas></canvas>";},update(ctx){setInterval(function(){},100);}})';
  await page.fill('#viewCode', badCode);
  const filled = await page.inputValue('#viewCode');
  assert(filled.trim() === badCode, '设计器代码框没写进去（并发/焦点把内容清了？），实测 ' + JSON.stringify(filled.slice(0, 40)));
  await page.click('#btnViewSave');
  const bad = await page.evaluate(() => ({
    status: document.getElementById('viewModalStatus').textContent,
    err: document.getElementById('viewModalStatus').classList.contains('err'),
    open: !document.getElementById('viewModal').classList.contains('hidden'),
    saved: (window.XHGCS.state.views || []).some((v) => v.id === 'designer-bad')
  }));
  assert(!bad.saved, '不合规代码居然被存进了视图库');
  assert(bad.err && bad.status.indexOf('不合规') >= 0, '设计器没提示不合规：' + bad.status);
  assert(bad.open, '被拦下来时不该关掉弹窗（用户还要改代码）');

  await page.fill('#viewCode', '({id:"designer-ok",mount(ctx){ctx.host.innerHTML="<canvas></canvas>";ctx.canvas=ctx.host.querySelector("canvas");},update(ctx){var i=ctx.ensureCanvas(ctx.canvas);if(!i)return;var g=i.ctx,TH=ctx.theme();g.clearRect(0,0,i.w,i.h);g.fillStyle=TH.acc;g.font=TH.font.body;g.fillText("自检视图",10,20);}})');
  await page.click('#btnViewSave');
  // 新建时 id 由 saveViewSpec 用 X.uid('view') 生成（record.id 优先于代码里的 id），所以按名字找
  const good = await page.evaluate(() => {
    const rec = (window.XHGCS.state.views || []).find((v) => v.name === '设计器自检视图');
    return {
      saved: Boolean(rec),
      id: rec ? rec.id : '',
      active: (window.XHGCS_VIEWS.activeView() || {}).id,
      host: document.querySelectorAll('.view-plugin-host').length
    };
  });
  assert(good.saved, '合规代码没保存进 state.views');
  assert(good.active === good.id, '保存后该自动启用，实测 active=' + good.active + ' / id=' + good.id);
  assert(good.host >= 1, '启用后宿主节点该出现，实测 ' + good.host);
  await page.evaluate((id) => window.XHGCS_VIEWS.removeView(id), good.id);
  const cleaned = await page.evaluate((id) => (window.XHGCS.state.views || []).some((v) => v.id === id), good.id);
  assert(!cleaned, '测试视图没清理干净');
});

test('视图规范：文档、lint、DOM 工具类、Skill 四处不漂移', async (page) => {
  const doc = await page.evaluate(() => window.XHGCS_VIEWS.viewApiDoc);
  const classes = await page.evaluate(() => window.XHGCS_VIEWS.viewDomClasses);
  const lintRules = await page.evaluate(() => window.XHGCS_VIEWS.lintViewCode('({id:"x",mount(ctx){ctx.theme();},update(ctx){}})').ok);
  assert(doc.indexOf('ctx.theme()') >= 0, 'API 文档必须要求 ctx.theme()');
  assert(doc.indexOf('禁止硬编码') >= 0, 'API 文档必须写明禁止硬编码颜色');
  assert(lintRules === true, '合规最小插件应通过 lint');
  assert(Array.isArray(classes) && classes.length >= 5, 'DOM 工具类清单为空：' + JSON.stringify(classes));
  const css = fs.readFileSync(path.join(ROOT, 'assets/css/styles.css'), 'utf8');
  classes.forEach((c) => assert(css.indexOf('.' + c) >= 0, 'styles.css 里没有 .' + c));
  classes.forEach((c) => assert(doc.indexOf(c) >= 0, 'API 文档漏了 DOM 工具类 ' + c));
  const skill = fs.readFileSync(path.join(ROOT, '.codex/skills/xhgcs-view/SKILL.md'), 'utf8');
  classes.forEach((c) => assert(skill.indexOf(c) >= 0, 'xhgcs-view Skill 漏了 DOM 工具类 ' + c));
  assert(skill.indexOf('ctx.theme()') >= 0 && skill.indexOf('verify_view') >= 0, 'xhgcs-view Skill 必须写清令牌与自检');
  const bridge = fs.readFileSync(path.join(ROOT, 'mcp-server/bridge.mjs'), 'utf8');
  assert(bridge.indexOf("'verify_view'") >= 0, 'MCP 桥缺少 verify_view 工具');
});

// 录制 CSV 的 t 列原来是用「界面里配的 intervalMs」一帧一帧累加出来的，不是时钟：
// 设备按 1Hz 送数会被记成 10Hz，中途断线 50 分钟在文件里也首尾相接、完全看不出来。
// 这条用例把「串口帧如何推进 state.t」的口径钉死在真实时钟上。
test('数据链：串口帧按真实时钟推进 t，不再按配置间隔累加', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const state = X.state;
    const prevSim = state.simulation.enabled;
    const prevInterval = state.intervalMs;
    const samples = [];
    const onSample = (e) => { if (e.detail.source === 'serial') samples.push(e.detail); };
    window.addEventListener('xhgcs:sample', onSample);
    try {
      // 仿真关掉后 stepData 直接返回，t 只可能由 injectRealValues 推进
      state.simulation.enabled = false;
      // 配置间隔设成 1000ms：老实现每帧给 t 加 1 秒（两帧 2.0s），新实现只加真实经过的时间
      state.intervalMs = 1000;
      const ch = state.channels[0];
      if (!ch) return { error: '没有可用通道' };
      // 先打一帧把时钟锚点落在当下，测量结果就与之前用例遗留的锚点无关
      X.injectRealValues({ [ch.id]: 0 }, null);
      const before = state.t;
      const p0 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const p1 = performance.now();
      X.injectRealValues({ [ch.id]: 1 }, null);
      return {
        before: before,
        after: state.t,
        realElapsed: (p1 - p0) / 1000,
        frames: samples.length,
        walls: samples.map((s) => s.wall)
      };
    } finally {
      window.removeEventListener('xhgcs:sample', onSample);
      state.simulation.enabled = prevSim;
      state.intervalMs = prevInterval;
    }
  });
  assert(!run.error, run.error);
  assert(run.frames === 2, '应派发两次串口采样事件，实际 ' + run.frames);
  const elapsed = run.after - run.before;
  assert(near(elapsed, run.realElapsed, 0.2),
    't 应走真实经过的 ' + run.realElapsed.toFixed(3) + 's，实际 ' + elapsed.toFixed(3) + 's（按 intervalMs 累加会得到 2.000s）');
  assert(run.walls.length === 2 && run.walls.every((w) => Number.isFinite(w) && w > 0),
    '串口采样事件必须带墙钟时间 wall：' + JSON.stringify(run.walls));
});

// 录制 CSV 是长时间试验唯一的交付物，表头的列名和列数必须和数据行严格对齐：
// 差一列就会让按位置取值的脚本静默错位（把某个通道的值当成时间用），而界面上看不出任何异常。
test('数据链：录制 CSV 表头为 t + 通道 + wall，且与数据行列数一致', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhgcs-recam-'));
  const recorder = createRecorder({ userData: tmp });
  const count = 3;
  const channels = [];
  for (let i = 1; i <= count; i++) channels.push({ id: 'c' + i, name: '通道' + i, unit: 'V' });
  try {
    recorder.start({ intervalMs: 100, source: 'serial', engine: '测试引擎', channels: channels });
    const row = ['0.000']
      .concat(channels.map(() => '1.0000'))
      .concat([new Date().toISOString(), 'c2|c3'])
      .join(',');
    recorder.append(row + '\n', 1);
    recorder.stop('test');

    const dir = recorder.dir;
    const session = fs.readdirSync(dir).filter((n) => n.indexOf('session-') === 0)[0];
    assert(session, '没有生成会话目录');
    const csv = fs.readdirSync(path.join(dir, session)).filter((n) => /^data-\d+\.csv$/.test(n))[0];
    assert(csv, '没有生成 data-000N.csv');
    const lines = fs.readFileSync(path.join(dir, session, csv), 'utf8').split(/\r?\n/).filter((l) => l.length);
    const header = lines.filter((l) => l.charAt(0) !== '#')[0];
    assert(header, 'CSV 里没有表头行');
    const head = header.split(',');
    assert(head.length === count + 3,
      '表头应为 t + ' + count + ' 个通道 + wall + miss 共 ' + (count + 3) + ' 列，实际 ' + head.length + '：' + header);
    assert(head[0] === 't', '第一列必须是 t，实际 ' + head[0]);
    assert(head[head.length - 2] === 'wall', '倒数第二列必须是 wall，实际 ' + head[head.length - 2]);
    assert(head[head.length - 1] === 'miss', '末列必须是 miss，实际 ' + head[head.length - 1]);
    assert(head[1] === '通道1(V)', '通道列应带单位，实际 ' + head[1]);
    assert(lines.some((l) => l.indexOf('#columns=') === 0), 'CSV 必须写明列含义');
    const cells = lines[lines.length - 1].split(',');
    assert(lines[lines.length - 1].charAt(0) !== '#', '最后一行应是数据行而不是注释：' + lines[lines.length - 1]);
    assert(cells.length === head.length,
      '数据行列数应与表头一致（' + head.length + '），实际 ' + cells.length);
    assert(cells[cells.length - 1] === 'c2|c3', '末列应原样带回本行被前向填充的通道，实际 ' + cells[cells.length - 1]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, session, 'manifest.json'), 'utf8'));
    assert(manifest.parts[0].rows === 1, 'manifest 应记录 1 行，实际 ' + manifest.parts[0].rows);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 一帧里没带到的通道会沿用上一帧的值。填充值必须能被认出来：落盘 CSV 里
// 「测到的」和「抄来的」原来长得一模一样，事后统计会把同一批数字算两遍。
test('数据链：帧里缺的通道会被标成前向填充', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const state = X.state;
    const prevSim = state.simulation.enabled;
    const picked = [];
    const events = [];
    const onSample = (e) => { if (e.detail.source === 'serial') events.push(e.detail); };
    window.addEventListener('xhgcs:sample', onSample);
    try {
      state.simulation.enabled = false;
      const a = state.channels[0];
      const b = state.channels[1];
      if (!a || !b) return { error: '至少需要两个通道' };
      picked.push(a.id, b.id);
      // 只带一个通道：另一个必须被标成填充
      X.injectRealValues({ [a.id]: 1 }, null);
      // 两个都带：都不该被标
      X.injectRealValues({ [a.id]: 1, [b.id]: 2 }, null);
      return { picked: picked, events: events.map((d) => ({ filled: d.filled })) };
    } finally {
      window.removeEventListener('xhgcs:sample', onSample);
      state.simulation.enabled = prevSim;
    }
  });
  assert(!run.error, run.error);
  assert(run.events.length === 2, '应派发两次采样事件，实际 ' + run.events.length);
  const first = run.events[0].filled;
  const second = run.events[1].filled;
  assert(Array.isArray(first), '采样事件必须带 filled 数组：' + JSON.stringify(run.events[0]));
  assert(first.indexOf(run.picked[0]) < 0, '帧里带了 ' + run.picked[0] + '，不该被标成填充');
  assert(first.indexOf(run.picked[1]) >= 0, '帧里没带 ' + run.picked[1] + '，必须被标成填充：' + JSON.stringify(first));
  assert(Array.isArray(second) && second.indexOf(run.picked[1]) < 0,
    '两个通道都在帧里，不该有填充标记：' + JSON.stringify(second));
});

// 桥原来对全网开放：ACAO: * 加上 Access-Control-Allow-Private-Network（专门用来允许公网页面
// 访问 localhost），任意网页都能 POST /api/mcp 把一段 JS 推进 state.views 并执行。
// 光收 CORS 不够 —— 攻击页面可以用 text/plain 发不触发预检的「简单请求」，请求照样执行。
test('桥：写操作必须带令牌，公网来源拿不到 CORS 放行', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'test-token-' + Date.now().toString(36);
  // 先占一个空闲端口再放掉，避免和本机在跑的桥撞车
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port), XHGCS_BRIDGE_TOKEN: token, XHGCS_ALLOWED_ORIGINS: '*loopback*' }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, '桥没能在超时内起来');

    const mcpBody = JSON.stringify({ name: 'snapshot', arguments: {} });
    const noToken = await call('POST', '/api/mcp', { 'Content-Type': 'application/json' }, mcpBody);
    assert(noToken.status === 403, '无令牌的写请求必须被拒，实际 ' + noToken.status);
    assert(noToken.headers['access-control-allow-private-network'] === undefined,
      '不能再回 Access-Control-Allow-Private-Network（那等于允许公网页面访问 localhost）');
    assert(noToken.headers['access-control-allow-origin'] === undefined,
      '不带 Origin 的请求不该回 ACAO，实际 ' + noToken.headers['access-control-allow-origin']);

    const foreign = await call('GET', '/api/health', { Origin: 'https://evil.example' });
    assert(foreign.headers['access-control-allow-origin'] === undefined,
      '公网来源不该拿到 ACAO，实际 ' + foreign.headers['access-control-allow-origin']);

    const local = await call('GET', '/api/health', { Origin: 'http://127.0.0.1:8123' });
    assert(local.headers['access-control-allow-origin'] === 'http://127.0.0.1:8123',
      '本机来源应被放行，实际 ' + local.headers['access-control-allow-origin']);
    assert(JSON.parse(local.body).token === token, '/api/health 应回出桥的令牌');

    const forged = await call('POST', '/api/mcp',
      { 'Content-Type': 'application/json', 'X-XHGCS-Token': token + 'x' }, mcpBody);
    assert(forged.status === 403, '错误令牌必须被拒，实际 ' + forged.status);

    const withToken = await call('POST', '/api/mcp',
      { 'Content-Type': 'application/json', 'X-XHGCS-Token': token }, mcpBody);
    assert(withToken.status === 200, '带正确令牌的写请求应通过，实际 ' + withToken.status);
  } finally {
    child.kill();
  }
});

// 桌面版启动时会探 8787：/api/health 的 sha 和它手里那份 bridge.mjs 一致才接管，不一致就
// 结束旧进程再起自己的。没有这个字段就会退回「装了新版跑旧桥」，而 smoke 全绿也看不出来。
test('桥：/api/health 带代码指纹与 pid，桌面版据此判断接管还是替换旧桥', async () => {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port) }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  try {
    let health = null;
    for (let i = 0; i < 60 && !health; i++) {
      health = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 500 }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (err) { resolve(null); }
          });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
      });
      if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(health && health.name === 'xhgcs', '桥没能在超时内起来');
    assert(health.pid === child.pid, '/api/health 应回报桥自己的 pid，实际 ' + health.pid);
    const expected = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'mcp-server', 'bridge.mjs')))
      .update(fs.readFileSync(path.join(ROOT, 'mcp-server', 'bytes.mjs')))
      .digest('hex').slice(0, 16);
    assert(health.sha === expected, '/api/health 的 sha 应等于 bridge.mjs+bytes.mjs 的摘要，实际 ' + health.sha);
  } finally {
    child.kill();
  }
});

// 上面那条只证明了桥会拒绝无令牌的请求；这条补上另一半：渲染层能不能自己把令牌取回来
// 并带上。少了这一半，桥一收紧就会变成「所有 AI 功能全部 403」——比不修还糟。
test('桥：渲染层会自己取回令牌并带上，收紧后 AI 功能照常可用', async (page) => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'renderer-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port), XHGCS_BRIDGE_TOKEN: token, XHGCS_ALLOWED_ORIGINS: '*loopback*' }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ok) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  try {
    assert(await waitReady(), '桥没能在超时内起来');
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const state = X.state;
      const saved = state.mcp.endpoint;
      state.mcp.endpoint = 'http://127.0.0.1:' + mockPort;
      try {
        const health = await X.mcpFetch('/api/health');
        const payload = await health.json();
        const posted = await X.mcpFetch('/api/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'snapshot', arguments: {} })
        });
        return { healthStatus: health.status, token: payload && payload.token, postStatus: posted.status };
      } finally {
        state.mcp.endpoint = saved;
      }
    }, port);
    assert(run.healthStatus === 200, '/api/health 应可读，实际 ' + run.healthStatus);
    assert(run.token && run.token.length > 0, '渲染层应能从 /api/health 取回令牌');
    assert(run.postStatus === 200, '带令牌的写操作应通过，实际 ' + run.postStatus + '（403 说明渲染层没带上令牌）');
  } finally {
    child.kill();
  }
});

// 桥每次启动都会换一个随机令牌（独立运行时；桌面版重启本地服务也一样）。
// 渲染层必须在 403 时自己重取令牌再试，否则「重启服务之后所有 AI 生成都报 403」——
// 而 chatOnce 正是四个生成入口和视图生成走的路径。
test('桥：桥换了令牌之后渲染层能自愈，不需要重启应用', async (page) => {
  const http = require('http');
  const { spawn } = require('child_process');
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const bootBridge = async (token) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
      env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port), XHGCS_BRIDGE_TOKEN: token, XHGCS_ALLOWED_ORIGINS: '*loopback*' }),
      stdio: ['pipe', 'ignore', 'ignore']
    });
    for (let i = 0; i < 80; i++) {
      const up = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.end();
      });
      if (up) return child;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  const post = (label) => page.evaluate(async (p) => {
    const X = window.XHGCS;
    window.__savedMcpEndpoint = window.__savedMcpEndpoint || X.state.mcp.endpoint;
    X.state.mcp.endpoint = 'http://127.0.0.1:' + p;
    try {
      const data = await X.mcpJson('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'snapshot', arguments: {} })
      }, 8000);
      return { ok: true, hasResult: Boolean(data && data.result) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }, port);

  let first = await bootBridge('rotate-A-' + Date.now().toString(36));
  const second = { child: null };
  try {
    assert(first, '第一座桥没起来');
    const before = await post('first');
    assert(before.ok, '第一次调用应成功，实际 ' + JSON.stringify(before));

    // 换一座桥（新令牌）占同一个端口：渲染层手上那个令牌就此过期
    first.kill();
    await new Promise((resolve) => setTimeout(resolve, 600));
    second.child = await bootBridge('rotate-B-' + Date.now().toString(36));
    assert(second.child, '第二座桥没起来');

    const after = await post('second');
    assert(after.ok, '桥换令牌后渲染层应自动重取令牌并成功，实际 ' + JSON.stringify(after));
    assert(after.hasResult, '重取令牌后应拿到正常结果，实际 ' + JSON.stringify(after));
  } finally {
    if (first) first.kill();
    if (second.child) second.child.kill();
    await page.evaluate(() => {
      if (window.__savedMcpEndpoint) window.XHGCS.state.mcp.endpoint = window.__savedMcpEndpoint;
    }).catch(() => {});
  }
});

// 「分析窗口点数」原来只有节点画布读，快速公式模式写死 slice(-100)：用户把窗口设成 2000，
// 写 mean(ch1) 拿到的还是最近 100 点的均值，界面上没有任何地方说明这个差异。
test('分析：快捷公式读「分析窗口点数」，不再写死 100 点', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const state = X.state;
    const A = window.XHGCS_ANALYSIS;
    const ch = X.allChannels()[0];
    if (!ch || !A) return { error: '缺少通道或分析模块' };
    const savedData = ch.data.slice();
    const savedPoints = state.analysis.windowPoints;
    try {
      // 1000 个递增样本：不同窗口算出来的均值差别很大，写死 100 的话两次会完全相同
      ch.data = [];
      for (let i = 1; i <= 1000; i++) ch.data.push(i);
      const expr = 'mean(' + X.formulaAlias(ch.id) + ')';
      state.analysis.windowPoints = 2000;
      const wide = Number(A.computeFormula(expr, [ch.id]));
      state.analysis.windowPoints = 100;
      const narrow = Number(A.computeFormula(expr, [ch.id]));
      return { wide: wide, narrow: narrow };
    } finally {
      ch.data = savedData;
      state.analysis.windowPoints = savedPoints;
    }
  });
  assert(!run.error, run.error);
  assert(near(run.wide, 500.5, 1), '窗口设为 2000 时应覆盖全部 1000 点（均值 500.5），实际 ' + run.wide);
  assert(near(run.narrow, 950.5, 1), '窗口设为 100 时应只覆盖最后 100 点（均值 950.5），实际 ' + run.narrow);
  assert(Math.abs(run.wide - run.narrow) > 100, '窗口大小必须真的影响结果，实际两次都是 ' + run.wide);
});

test('公式工作台：编辑即试算，结果同屏并能发布成实时图表', async (page) => {
  await page.click('[data-nav="analysis"]');
  await page.waitForTimeout(300);
  await page.click('#btnQuickMode');
  await page.waitForTimeout(350);

  const invalid = await page.evaluate(async () => {
    const input = document.getElementById('analysisFormula');
    input.value = 'mean(';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    return {
      state: document.getElementById('formulaCodeState').textContent,
      previewError: document.getElementById('formulaPreview').classList.contains('error'),
      status: document.getElementById('analysisStatus').textContent
    };
  });
  assert(invalid.state.indexOf('错误') >= 0 && invalid.previewError, '错误公式没有在编辑器旁直接报错：' + JSON.stringify(invalid));
  assert(/公式|错误|不是通道/.test(invalid.status), '错误说明没有留在结果区：' + invalid.status);

  const preview = await page.evaluate(async () => {
    const input = document.getElementById('analysisFormula');
    const first = window.XHGCS.allChannels()[0];
    const alias = first ? window.XHGCS.formulaAlias(first.id) : 'ch1';
    const formula = 'mean(' + alias + ')';
    input.value = formula;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const quick = document.getElementById('analysisQuickView');
    const previewEl = document.getElementById('formulaPreview');
    const pipeline = document.getElementById('formulaPipeline');
    return {
      value: document.getElementById('formulaPreviewValue').textContent,
      state: document.getElementById('formulaCodeState').textContent,
      status: document.getElementById('analysisStatus').textContent,
      quickScroll: quick.scrollHeight,
      quickClient: quick.clientHeight,
      previewHeight: previewEl.getBoundingClientRect().height,
      pipeline: pipeline.textContent.replace(/\s+/g, ' '),
      formula: formula,
      shelfCollapsed: document.querySelector('.analysis-script-shelf').classList.contains('collapsed'),
      button: document.getElementById('btnAnalysisAttach').textContent
    };
  });
  assert(preview.value !== '--' && preview.state === '语法通过', '有效公式没有就地显示结果：' + JSON.stringify(preview));
  assert(/试算通过/.test(preview.status), '结果区没有语法/耗时反馈：' + preview.status);
  assert(preview.previewHeight >= 140, '实时结果区域太小，仍像一条状态栏：' + preview.previewHeight);
  assert(preview.pipeline.indexOf(preview.formula) >= 0 && preview.pipeline.indexOf('均值') >= 0,
    '输入→公式→输出链路没有连起来：' + preview.pipeline);
  assert(preview.shelfCollapsed, '快速公式页的脚本库默认没有收起，结果区被挤小');
  assert(preview.quickScroll <= preview.quickClient + 3, '快速公式仍需内部滚动才能看全结果：' + preview.quickScroll + '/' + preview.quickClient);
  assert(preview.button.indexOf('查看图表') >= 0, '主操作没有说明结果会进入图表：' + preview.button);

  const recovered = await page.evaluate(async (formula) => {
    const input = document.getElementById('analysisFormula');
    input.value = 'not_a_channel(';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const error = {
      emptyVisible: !document.getElementById('formulaSparkEmpty').classList.contains('hidden'),
      previewError: document.getElementById('formulaPreview').classList.contains('error')
    };
    input.value = formula;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    return {
      error: error,
      stats: document.getElementById('formulaPreviewStats').textContent,
      emptyHidden: document.getElementById('formulaSparkEmpty').classList.contains('hidden')
    };
  }, preview.formula);
  assert(recovered.error.emptyVisible && recovered.error.previewError, '错误公式没有清空旧结果曲线：' + JSON.stringify(recovered));
  assert(recovered.emptyHidden && /1 点/.test(recovered.stats), '公式恢复后结果历史没有从新窗口开始：' + recovered.stats);

  await page.click('#btnAnalysisAttach');
  await page.waitForTimeout(650);
  const first = await page.evaluate(() => {
    const X = window.XHGCS;
    const live = (X.state.scripts || []).find((script) => script.id === 'analysis-live');
    const ch = (X.state.scriptChannels || []).find((item) => item.scriptId === 'analysis-live');
    return {
      view: X.state.view,
      subview: X.state.subview,
      live: Boolean(live && live.live),
      channels: ch ? ch.data.length : 0,
      plotChannels: X.activePlot() ? X.activePlot().channels : null,
      toast: document.getElementById('toast').textContent
    };
  });
  assert(first.view === 'wave' && first.subview === 'wave', '发布后没有切到图表：' + JSON.stringify(first));
  assert(first.live && first.plotChannels && first.plotChannels.length === 1, '实时公式没有成为当前图页的数据源：' + JSON.stringify(first));
  assert(/实时|发布/.test(first.toast), '发布后没有说明实时更新：' + first.toast);
  await page.waitForTimeout(1200);
  const secondCount = await page.evaluate(() => {
    const ch = (window.XHGCS.state.scriptChannels || []).find((item) => item.scriptId === 'analysis-live');
    return ch ? ch.data.length : 0;
  });
  assert(secondCount > first.channels, '发布后脚本通道没有持续采样：' + first.channels + ' -> ' + secondCount);

  await page.click('[data-nav="analysis"]');
  await page.waitForTimeout(300);
  await page.click('#btnQuickMode');
  await page.waitForTimeout(250);
  const stale = await page.evaluate(async () => {
    const X = window.XHGCS;
    const ch = X.allChannels()[0];
    const input = document.getElementById('analysisFormula');
    input.value = 'max(' + X.formulaAlias(ch.id) + ')';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    return {
      badge: document.getElementById('formulaLiveBadge').textContent,
      button: document.getElementById('btnAnalysisAttach').textContent,
      stale: document.getElementById('formulaPreview').classList.contains('stale'),
      destination: document.getElementById('formulaDestinationNote').textContent
    };
  });
  assert(/未发布/.test(stale.badge) && stale.stale, '修改已发布公式后没有标出未发布状态：' + JSON.stringify(stale));
  assert(/发布修改/.test(stale.button) && /未发布/.test(stale.destination), '主操作没有提示需要重新发布：' + JSON.stringify(stale));

  await page.evaluate(() => {
    const X = window.XHGCS;
    window.XHGCS_ANALYSIS.deleteScript('analysis-live');
    const plot = X.activePlot();
    if (plot) X.setPlotChannels(plot.id, null, { follow: true });
    X.state.subview = 'wave';
    X.persist();
    window.XHGCS_VIEWS.switchSubView('wave');
  });
});

// 「自适应」原来写成 Math.min(windowSec, fullSpan)，而 windowSec 下拉最多 30 秒：
// 跑过 30 秒之后它和「固定」渲染完全一样，用户点「自适应」想看全貌、波形纹丝不动，
// 内存里留着的几小时数据在界面上根本看不到。
test('可视化：自适应模式覆盖全量历史，不被 30 秒窗口截断', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const V = window.XHGCS_VIEWS;
    const state = X.state;
    const ch = X.allChannels()[0];
    if (!ch) return { error: '没有可用通道' };
    const savedData = ch.data.slice();
    const savedMode = state.zoomMode;
    const savedView = state.view;
    const savedT = state.t;
    const readWindow = () => {
      const el = document.getElementById('statusInfo');
      const m = el && String(el.textContent).match(/窗口\s*([\d.]+)\s*s/);
      return m ? Number(m[1]) : null;
    };
    const settle = () => new Promise((r) => setTimeout(r, 1300));
    try {
      const nav = document.querySelector('[data-nav="visual"]');
      if (nav) nav.click();
      if (V && V.activateView) V.activateView('wave');
      // 横轴是以 state.t 为锚的：数据长度和 state.t 都要够大，跨度才可能超过 30 秒。
      // 2000 点 × 默认 100ms ≈ 200 秒。
      ch.data = [];
      for (let i = 0; i < 2000; i++) ch.data.push(i);
      state.t = 200;
      state.zoomMode = 'fit';
      await settle();
      const fitWindow = readWindow();
      state.zoomMode = 'fixed';
      await settle();
      const fixedWindow = readWindow();
      return { fitWindow: fitWindow, fixedWindow: fixedWindow };
    } finally {
      ch.data = savedData;
      state.zoomMode = savedMode;
      state.view = savedView;
      state.t = savedT;
    }
  });
  assert(!run.error, run.error);
  assert(run.fitWindow != null, '没能从图表底栏读到窗口秒数');
  assert(run.fitWindow > 100,
    '自适应应覆盖约 200 秒的全量历史，实际 ' + run.fitWindow + 's（若停在 30 左右说明仍被窗口上限截断）');
  assert(run.fixedWindow != null && run.fixedWindow <= 31,
    '固定模式仍应只显示配置的窗口（≤30s），实际 ' + run.fixedWindow);
});

// manifest 只在 start/stop 写的话，会话被 taskkill / 断电打断后就停在初始值（rows:0、endedAt:null），
// 事后按索引找会话会以为那份记录是空的，而 CSV 里其实有几百行。
test('数据链：录制被异常中断时 manifest 索引仍与已写行数一致', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhgcs-recidx-'));
  // 把补写周期调小，测试不必真等默认的 5 秒
  const recorder = createRecorder({ userData: tmp, config: { manifestIntervalMs: 20 } });
  try {
    recorder.start({
      intervalMs: 100,
      source: 'serial',
      engine: '测试引擎',
      channels: [{ id: 'c1', name: '通道1', unit: 'V' }]
    });
    const line = (a, b) => a + ',' + b + ',' + new Date().toISOString() + ',\n';
    for (let i = 0; i < 5; i++) recorder.append(line('0.100', '1.0000'), 1);
    await new Promise((resolve) => setTimeout(resolve, 60)); // 让节流窗口过去
    recorder.append(line('0.200', '2.0000'), 1);

    // 关键：不调 stop()，直接读盘 —— 模拟进程被 kill
    const dir = recorder.dir;
    const session = fs.readdirSync(dir).filter((n) => n.indexOf('session-') === 0)[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, session, 'manifest.json'), 'utf8'));
    assert(manifest.rows === 6, '中断时 manifest.rows 应已同步到 6，实际 ' + manifest.rows);
    assert(manifest.parts[0].rows === 6, 'parts[0].rows 应为 6，实际 ' + manifest.parts[0].rows);
    assert(manifest.endedAt === null, '会话没正常结束，endedAt 应保持 null');
    const csv = fs.readdirSync(path.join(dir, session)).filter((n) => /^data-\d+\.csv$/.test(n))[0];
    const rows = fs.readFileSync(path.join(dir, session, csv), 'utf8')
      .split(/\r?\n/).filter((l) => l && l.charAt(0) !== '#').length - 1;
    assert(rows === 6, 'CSV 应有 6 行数据，实际 ' + rows);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 四个「AI 生成」入口（脚本 / 流程 / 引擎 / 组件）原来无论配没配模型，一律调
// createScriptFromPrompt 那类正则查表 —— 用户配好本地模型和 DSH 也一样，
// 「对电机 PWM 求三阶滑动中位数」会被无视、返回固定 mean(...)。
// 这条用例用一个假的 OpenAI 兼容端点把「确实调了模型」这个不变量钉住。
test('AI：四个生成入口在有模型时必须真的请求模型，而不是走本地正则表', async (page) => {
  const http = require('http');
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  // 公式里写的是公式名；WED 通道 id 带减号（wed-fc-01），公式名 c01
  const formulaName = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? window.XHGCS.formulaAlias(ch.id) : '';
  });
  assert(formulaName, '测试环境里通道应能取到公式名');
  const seen = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { seen.push(JSON.parse(body)); } catch (err) { seen.push({}); }
      // 故意返回本地正则表不可能产出的形状：rms 而不是 mean
      const spec = {
        name: '模型给的脚本',
        type: 'functions',
        formula: 'rms(' + formulaName + ')',
        inputs: [channelId],
        outputs: [{ label: '有效值' }]
      };
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(spec) } }] }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const channel = X.allChannels()[0];
      if (!channel) return { error: '没有可用通道' };
      const saved = {
        useProxy: state.ai.useProxy,
        endpoint: state.ai.endpoint,
        model: state.ai.model,
        backend: state.ai.backend
      };
      state.ai.useProxy = false;                       // 直连假端点，不走本地桥
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      try {
        const result = await AI.generateScript('对电机 PWM 求三阶滑动中位数', { inputs: [channel.id] });
        const made = (state.scripts || []).filter((s) => s.name === '模型给的脚本');
        return {
          scriptFormula: made.length ? String(made[made.length - 1].formula) : '',
          scriptMessage: String(result && result.message || '')
        };
      } finally {
        state.ai.useProxy = saved.useProxy;
        state.ai.endpoint = saved.endpoint;
        state.ai.model = saved.model;
        state.ai.backend = saved.backend;
      }
    }, port);
    assert(!run.error, run.error);
    assert(seen.length >= 1, '有模型时「AI 生成脚本」必须发出模型请求，实际一次都没有');
    assert(run.scriptFormula.indexOf('rms(') === 0,
      '生成结果应来自模型返回的规格，实际 formula=' + JSON.stringify(run.scriptFormula)
      + '（若是 mean( 之类，说明又走回本地正则表了）');
    assert(run.scriptMessage.indexOf('已生成') >= 0, '返回消息应说明已生成：' + run.scriptMessage);
  } finally {
    server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P1「生成即试运行」：共用假端点
// 起一个假的 OpenAI 兼容端点，按请求返回一份产物规格 JSON。用例只关心「模型返回什么」，
// 不碰真模型；requests 里留着完整请求体，方便断言确实走了模型而不是本地模板。
function startAiSpecStub(makeSpec) {
  const http = require('http');
  const requests = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (err) { payload = {}; }
      requests.push(payload);
      const spec = makeSpec(payload, requests.length);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(spec) } }] }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests: requests,
      close: () => server.close()
    }));
  });
}

// 生成脚本以前把 runScript 的 null（公式引用不存在的通道）当成正常返回：脚本卡片建好了、
// 脚本通道也建了，但一个数都没有，用户只看到「已生成并保存」。这是最伤信任的失败。
// 这条钉住三件事：跑不出来必须抛错、错误带具体原因、坏脚本和它的通道都不留在库里。
test('AI 生成脚本：试运行跑不出数就明确失败，坏脚本不留在库里', async (page) => {
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  // 规格本身能过静态校验（inputs 是真实通道），但公式引用了一个不存在的通道
  const stub = await startAiSpecStub(() => ({
    name: '坏公式脚本',
    type: 'functions',
    formula: 'mean(不存在的通道)',
    inputs: [channelId],
    outputs: [{ label: '均值', unit: 'V' }]
  }));
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        lastError: state.analysis.lastError,
        playing: state.playing
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      // 分析面板可能正显示着别的错误：一次 AI 生成/试运行不能把它清掉
      state.playing = false; state.analysis.lastError = '用户正在看的错误';
      const scriptsBefore = (state.scripts || []).length;
      const channelsBefore = (state.scriptChannels || []).length;
      let error = '';
      let result = null;
      try {
        result = await AI.generateScript('算个不存在通道的均值', { inputs: [args.channelId] });
      } catch (err) {
        error = String((err && err.message) || err);
      }
      const out = {
        error: error,
        ok: result ? result.ok : null,
        addedScripts: (state.scripts || []).length - scriptsBefore,
        addedChannels: (state.scriptChannels || []).length - channelsBefore,
        left: (state.scripts || []).filter((s) => s.name === '坏公式脚本').length,
        lastErrorAfter: String(state.analysis.lastError || ''),
        task: (state.ai.tasks || [])[0]
          ? { status: state.ai.tasks[0].status, message: String(state.ai.tasks[0].message || '') }
          : null
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.lastError = saved.lastError; if (saved.playing !== undefined) state.playing = saved.playing;
      return out;
    }, { port: stub.port, channelId: channelId });
    assert(!run.ok, '试运行失败时不能返回成功结果');
    assert(/试运行失败/.test(run.error), '生成入口必须抛「试运行失败」，实际：' + JSON.stringify(run.error));
    assert(/不是通道也不是函数/.test(run.error), '错误里要带具体原因（哪个引用不存在），实际：' + JSON.stringify(run.error));
    assert(run.addedScripts === 0 && run.left === 0, '试运行失败的脚本不该留在库里，实际新增 ' + run.addedScripts + ' 个');
    assert(run.addedChannels === 0, '试运行失败的脚本不该留下脚本通道，实际新增 ' + run.addedChannels + ' 个');
    assert(run.task && run.task.status === 'error', '子任务应记成 error，实际：' + JSON.stringify(run.task));
    assert(run.lastErrorAfter === '用户正在看的错误',
      '试运行结束时不能把分析面板正在显示的错误清掉，实际：' + JSON.stringify(run.lastErrorAfter));
  } finally {
    stub.close();
  }
});

// 回滚必须只撤本次新建的那一份。saveScript 的语义以后可能变成「有 id 则更新」（聊天动作的
// spec 也可能带 id），那时按 id 从库里 filter 会把用户原来的脚本一起删掉——比「假成功」严重
// 得多。这条用同 id 覆盖场景钉住：试运行失败后用户既有脚本与它的通道仍在、内容没被换掉。
test('AI 生成脚本：试运行回滚不误删同 id 的既有脚本', async (page) => {
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  const stub = await startAiSpecStub(() => ({
    name: '覆盖失败脚本',
    type: 'functions',
    formula: 'mean(不存在的通道)',
    inputs: [channelId],
    outputs: [{ label: '均值', unit: 'V' }]
  }));
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        lastError: state.analysis.lastError,
        playing: state.playing
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      // 预置一条「用户既有脚本」+ 它的输出通道，占住生成入口接下来会拿到的那个 id
      const fixedId = 'script-preexisting-probe';
      state.scripts = (state.scripts || []).concat([{
        id: fixedId, name: '用户既有脚本', type: 'functions',
        formula: 'mean(' + args.channelId + ')', inputs: [args.channelId],
        outputs: [{ id: 'out1', label: '均值', unit: 'V', color: '#38bdf8', range: [0, 100] }],
        builtin: false, origin: 'user'
      }]);
      state.scriptChannels = (state.scriptChannels || []).concat([{
        id: 'sc-preexisting-probe', name: '均值', unit: 'V', color: '#38bdf8',
        range: [0, 100], data: [1, 2, 3], isScript: true,
        scriptId: fixedId, outputId: 'out1'
      }]);
      // 生成入口的脚本 id 来自 X.uid('script')：临时钉死同 id，模拟「覆盖既有脚本」
      const originalUid = X.uid;
      X.uid = (prefix) => (prefix === 'script' ? fixedId : originalUid(prefix));
      let error = '';
      try {
        await AI.generateScript('覆盖一个既有脚本', { inputs: [args.channelId] });
      } catch (err) {
        error = String((err && err.message) || err);
      }
      X.uid = originalUid;
      const sameId = (state.scripts || []).filter((s) => s.id === fixedId);
      const keptChannels = (state.scriptChannels || []).filter((ch) => ch.scriptId === fixedId);
      const out = {
        error: error,
        sameIdCount: sameId.length,
        keptName: sameId.length ? String(sameId[0].name) : '',
        keptFormula: sameId.length ? String(sameId[0].formula) : '',
        keptChannels: keptChannels.length,
        keptSamples: keptChannels.reduce((sum, ch) => sum + (Array.isArray(ch.data) ? ch.data.length : 0), 0),
        replacedByName: (state.scripts || []).filter((s) => s.name === '覆盖失败脚本').length
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.lastError = saved.lastError; if (saved.playing !== undefined) state.playing = saved.playing;
      return out;
    }, { port: stub.port, channelId: channelId });
    assert(/试运行失败/.test(run.error), '同 id 覆盖时试运行失败也必须报错，实际：' + JSON.stringify(run.error));
    assert(run.sameIdCount === 1, '用户既有脚本不能被回滚删掉或变成两份，实际 ' + run.sameIdCount);
    assert(run.keptName === '用户既有脚本', '用户既有脚本不该被失败的新内容覆盖，实际：' + run.keptName);
    assert(run.keptFormula.indexOf('mean(') === 0, '用户既有脚本的公式应恢复成原值，实际：' + run.keptFormula);
    assert(run.keptChannels === 1, '用户既有脚本的输出通道不能被回滚删掉，实际 ' + run.keptChannels);
    assert(run.keptSamples === 3, '既有通道的数据不该被这次失败的回滚清掉，实际样本 ' + run.keptSamples);
    assert(run.replacedByName === 0, '失败的新脚本不该留在脚本库里');
  } finally {
    stub.close();
  }
});

// 反方向：合法的脚本必须真的算一次，成功消息里要带真实输出值（不是只说「已生成」），
// 并且脚本通道立刻有值 —— 这样用户不用再等下一次仿真推进才知道脚本是不是活的。
test('AI 生成脚本：成功消息带真实试运行输出，脚本通道同时有值', async (page) => {
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  // 公式里只能写公式名：WED 通道 id 带减号（wed-fc-01 会被当成减法），公式名是 c01
  const formulaName = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? window.XHGCS.formulaAlias(ch.id) : '';
  });
  assert(formulaName, '测试环境里通道应能取到公式名');
  const stub = await startAiSpecStub(() => ({
    name: '试运行均值脚本',
    type: 'functions',
    formula: 'mean(' + formulaName + ')',
    inputs: [channelId],
    outputs: [{ label: '均值', unit: 'V' }]
  }));
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        lastError: state.analysis.lastError,
        playing: state.playing
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      // 成功的试运行同样不能把分析面板正在显示的错误清掉
      state.playing = false; state.analysis.lastError = '用户正在看的错误';
      let error = '';
      let result = null;
      try {
        result = await AI.generateScript('算个均值', { inputs: [args.channelId] });
      } catch (err) {
        error = String((err && err.message) || err);
      }
      const made = (state.scripts || []).filter((s) => s.name === '试运行均值脚本');
      const channel = (state.scriptChannels || []).find((item) => made.length && item.scriptId === made[0].id);
      const samples = channel && Array.isArray(channel.data) ? channel.data.length : 0;
      const out = {
        error: error,
        ok: result ? result.ok : null,
        message: String((result && result.message) || ''),
        lastErrorAfter: String(state.analysis.lastError || ''),
        samples: samples,
        value: samples ? Number(channel.data[channel.data.length - 1]) : null
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.lastError = saved.lastError; if (saved.playing !== undefined) state.playing = saved.playing;
      return out;
    }, { port: stub.port, channelId: channelId });
    assert(!run.error, run.error);
    assert(run.ok === true, '合法脚本应当返回成功，实际 ok=' + JSON.stringify(run.ok));
    assert(/已生成/.test(run.message), '成功消息要说明已生成：' + run.message);
    assert(/试运行输出：均值=-?\d/.test(run.message), '成功消息要带真实试运行数值，实际：' + run.message);
    assert(run.samples > 0 && Number.isFinite(run.value),
      '对应脚本通道应立刻有值，实际样本 ' + run.samples + '，值 ' + JSON.stringify(run.value));
    assert(run.lastErrorAfter === '用户正在看的错误',
      '成功的试运行也不能把分析面板正在显示的错误清掉，实际：' + JSON.stringify(run.lastErrorAfter));
  } finally {
    stub.close();
  }
});

// 节点画布的生成入口以前只 save + setCanvas，从不运行：连线接错、组件不存在、通道没数据
// 都要等用户自己点运行才发现，而生成入口已经报过「已生成」。这条钉住「画出数才算生成成功」。
test('AI 生成画布：生成后真跑一遍，输出通道已有数值', async (page) => {
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  const stub = await startAiSpecStub(() => ({
    name: '试运行画布',
    nodes: [
      { id: 'n1', type: 'source', label: '输入通道', x: 60, y: 70, config: { channelId: channelId } },
      { id: 'n2', type: 'math', label: '函数计算', x: 350, y: 120, config: { op: 'mean', inputCount: 1, formula: 'mean(x1)' } },
      { id: 'n3', type: 'output', label: '均值', x: 660, y: 115, config: { label: '均值', unit: 'V', color: '#38bdf8', range: [0, 100], attach: true } }
    ],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in1' },
      { id: 'e2', source: 'n2', sourceHandle: 'out', target: 'n3', targetHandle: 'in1' }
    ]
  }));
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        canvas: JSON.parse(JSON.stringify(state.analysis.canvas || {})),
        canvasScriptId: state.analysis.canvasScriptId
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      let error = '';
      let result = null;
      try {
        result = await AI.generateGraph('画一个单通道均值流程', { inputs: [args.channelId] });
      } catch (err) {
        error = String((err && err.message) || err);
      }
      const made = (state.scripts || []).filter((s) => s.name === '试运行画布');
      const outputs = made.length ? (made[0].outputs || []).length : 0;
      const channel = (state.scriptChannels || []).find((item) => made.length && item.scriptId === made[0].id);
      const samples = channel && Array.isArray(channel.data) ? channel.data.length : 0;
      const out = {
        error: error,
        ok: result ? result.ok : null,
        message: String((result && result.message) || ''),
        outputs: outputs,
        samples: samples,
        value: samples ? Number(channel.data[channel.data.length - 1]) : null,
        canvasNodes: (state.analysis.canvas && state.analysis.canvas.nodes || []).length
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.canvas = saved.canvas;
      state.analysis.canvasScriptId = saved.canvasScriptId;
      return out;
    }, { port: stub.port, channelId: channelId });
    assert(!run.error, run.error);
    assert(run.ok === true, '合法画布应当返回成功，实际 ok=' + JSON.stringify(run.ok));
    assert(/已生成/.test(run.message), '成功消息要说明已生成：' + run.message);
    assert(/试运行输出：均值=-?\d/.test(run.message), '成功消息要带真实运行结论，实际：' + run.message);
    assert(run.outputs >= 1, '画布脚本应有 output 端口，实际 ' + run.outputs);
    assert(run.samples > 0 && Number.isFinite(run.value), '输出通道应已有数值，实际样本 ' + run.samples + '，值 ' + JSON.stringify(run.value));
    assert(run.canvasNodes === 3, '生成成功后画布应切到新流程（3 节点），实际 ' + run.canvasNodes);
  } finally {
    stub.close();
  }
});

// Python 的试运行失败必须分成两类，不能一刀切：
//   ① 环境缺失（桥没起 / 没装 Python）—— 只是「没能验证」，产物保留，消息如实说无法试运行；
//   ② 脚本自身算错（引用不存在通道 / 除零 / 输出不是数字）—— 回滚 + 抛「试运行失败」。
// 两类混在一起会让没起桥的用户连脚本都拿不到（AI 直接不给产物），比静默成功好但也是坏体验。
test('AI 生成 Python 脚本：环境缺失保留产物，计算错误才回滚', async (page) => {
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  const stub = await startAiSpecStub(() => ({
    name: 'Python 均值脚本',
    type: 'python',
    code: 'def analyze(ctx):\n    import statistics as st\n    return {"out1": st.mean(ctx.get("' + channelId + '", []))}',
    inputs: [channelId],
    outputs: [{ label: '均值' }]
  }));
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const A = window.XHGCS_ANALYSIS;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        lastError: state.analysis.lastError,
        playing: state.playing
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      const originalRunAndAttach = A.runAndAttach;
      const scriptsBefore = (state.scripts || []).length;
      const channelsBefore = (state.scriptChannels || []).length;
      const callAndCapture = async () => {
        state.playing = false; state.analysis.lastError = '用户正在看的错误';
        let error = '';
        let result = null;
        try {
          result = await AI.generateScript('用 Python 算个均值', { inputs: [args.channelId] });
        } catch (err) {
          error = String((err && err.message) || err);
        }
        return {
          error: error,
          ok: result ? result.ok : null,
          verified: result ? result.verified : null,
          message: String((result && result.message) || ''),
          addedScripts: (state.scripts || []).length - scriptsBefore,
          addedChannels: (state.scriptChannels || []).length - channelsBefore,
          lastErrorAfter: String(state.analysis.lastError || '')
        };
      };
      const envResult = await (async () => {
        // 打桩：模拟「桥没起 / Python 不可用」这一类的试运行失败
        A.runAndAttach = async () => {
          state.analysis.lastError = 'Python 模式需要启动 MCP 桥接服务：Failed to fetch';
          return null;
        };
        const out = await callAndCapture();
        state.scripts = saved.scripts;
        state.scriptChannels = saved.channels;
        return out;
      })();
      const calcResult = await (async () => {
        // 打桩：脚本自身算错（不是环境问题），必须回滚
        A.runAndAttach = async () => {
          state.analysis.lastError = '除零：公式 mean(...) 输出不是数字';
          return null;
        };
        const out = await callAndCapture();
        state.scripts = saved.scripts;
        state.scriptChannels = saved.channels;
        return out;
      })();
      A.runAndAttach = originalRunAndAttach;
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.lastError = saved.lastError; if (saved.playing !== undefined) state.playing = saved.playing;
      return { env: envResult, calc: calcResult };
    }, { port: stub.port, channelId: channelId });
    // ① 环境缺失：产物保留 + 明确「无法试运行」，不抛「试运行失败」
    assert(!run.env.error, '环境缺失不该抛「试运行失败」，实际：' + JSON.stringify(run.env.error));
    assert(run.env.ok === true && run.env.verified === false, '环境缺失时结果应标 verified:false，实际：' + JSON.stringify(run.env));
    assert(/无法试运行/.test(run.env.message), '消息要说清当前环境无法试运行，实际：' + run.env.message);
    assert(/MCP 桥接服务/.test(run.env.message), '消息要给出可照做的提示（启动 MCP 桥），实际：' + run.env.message);
    assert(run.env.addedScripts === 1, '环境缺失时产物应保留，实际新增 ' + run.env.addedScripts);
    assert(run.env.lastErrorAfter === '用户正在看的错误', '不能清掉分析面板正在显示的错误，实际：' + JSON.stringify(run.env.lastErrorAfter));
    // ② 计算错误：回滚 + 抛「试运行失败：具体原因」
    assert(/试运行失败/.test(run.calc.error), '计算错误必须抛「试运行失败」，实际：' + JSON.stringify(run.calc.error));
    assert(/除零/.test(run.calc.error), '错误里要带具体原因，实际：' + JSON.stringify(run.calc.error));
    assert(run.calc.addedScripts === 0 && run.calc.addedChannels === 0, '计算错误的产物必须回滚，实际新增脚本 ' + run.calc.addedScripts + ' / 通道 ' + run.calc.addedChannels);
    assert(run.calc.lastErrorAfter === '用户正在看的错误', '失败路径也不能清掉分析面板正在显示的错误，实际：' + JSON.stringify(run.calc.lastErrorAfter));
  } finally {
    stub.close();
  }
});

// P2 错误可诊断：同一类失败以前只有一句原始报错（HTTP 401 / Failed to fetch…），
// 用户不知道该改 Key、等一等，还是去起桥。这条用假端点逐类制造失败，钉住 diagnoseError
// 的 kind 分类与 title/hint 是否可读，以及生成入口抛出的错误是否带 err.info。
test('AI 错误诊断：HTTP/网络/空回复/校验失败都能归到可读 kind', async (page) => {
  const http = require('http');
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? ch.id : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  const validSpec = {
    name: '诊断用脚本',
    type: 'functions',
    formula: 'mean(' + (channelId === 'x' ? 'x' : 'c01') + ')',
    inputs: [channelId],
    outputs: [{ label: '均值' }]
  };
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let model = '';
      try { model = String(JSON.parse(body || '{}').model || ''); } catch (err) {}
      const reply = (status, payload) => {
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify(payload));
      };
      if (model === 'case-auth') return reply(401, { error: { message: 'invalid api key' } });
      if (model === 'case-quota') return reply(402, { error: { message: 'insufficient_quota：余额不足' } });
      if (model === 'case-rate') return reply(429, { error: { message: 'rate limit exceeded' } });
      if (model === 'case-server') return reply(500, { error: { message: 'internal server error' } });
      if (model === 'case-context') return reply(400, { error: { message: 'context_length_exceeded: maximum context length is 8192 tokens' } });
      if (model === 'case-notfound') return reply(404, { error: { message: 'model not found' } });
      if (model === 'case-empty') return reply(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
      if (model === 'case-invalid') return reply(200, { choices: [{ message: { content: JSON.stringify({ name: '缺字段脚本' }) } }] });
      return reply(200, { choices: [{ message: { content: JSON.stringify(validSpec) } }] });
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        lastError: state.analysis.lastError,
        playing: state.playing
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'local';
      const cases = {};
      const record = async (label, setup) => {
        setup();
        try {
          await AI.generateScript('算个均值', { inputs: [args.channelId] });
          cases[label] = { ok: true, kind: '', title: '', hint: '', hasErrInfo: false, message: '' };
        } catch (err) {
          const info = AI.diagnose(err);
          cases[label] = {
            ok: false,
            kind: info.kind,
            title: info.title,
            hint: info.hint,
            status: info.status,
            retryable: Boolean(info.retryable),
            hasErrInfo: Boolean(err && err.info && err.info.kind),
            message: String((err && err.message) || err)
          };
        }
      };
      await record('auth', () => { state.ai.model = 'case-auth'; });
      await record('quota', () => { state.ai.model = 'case-quota'; });
      await record('rate_limit', () => { state.ai.model = 'case-rate'; });
      await record('upstream', () => { state.ai.model = 'case-server'; });
      await record('context_length', () => { state.ai.model = 'case-context'; });
      await record('model_not_found', () => { state.ai.model = 'case-notfound'; });
      await record('empty_response', () => { state.ai.model = 'case-empty'; });
      await record('validation', () => { state.ai.model = 'case-invalid'; });
      await record('network', () => {
        state.ai.model = 'probe-model';
        state.ai.endpoint = 'http://127.0.0.1:1';
      });
      await record('not_configured', () => {
        state.ai.endpoint = '';
        state.ai.model = '';
      });
      // 剩下三类在生成入口里不好稳定制造，直接钉纯函数的分类
      const synth = {
        truncated: AI.diagnose(Object.assign(new Error('回复被截断'), { finish: 'length' })),
        aborted: AI.diagnose(Object.assign(new Error('已停止生成'), { name: 'AbortError' })),
        timeout: AI.diagnose(new Error('模型输出超时：超过 45 秒没有任何内容，已中断')),
        unknown: AI.diagnose(new Error('嘎？'))
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.analysis.lastError = saved.lastError; if (saved.playing !== undefined) state.playing = saved.playing;
      return { cases: cases, synth: synth };
    }, { port: port, channelId: channelId });
    const expected = {
      auth: 'auth',
      quota: 'quota',
      rate_limit: 'rate_limit',
      upstream: 'upstream',
      context_length: 'context_length',
      model_not_found: 'model_not_found',
      empty_response: 'empty_response',
      validation: 'validation',
      network: 'network',
      not_configured: 'not_configured'
    };
    Object.keys(expected).forEach((label) => {
      const row = run.cases[label];
      assert(row, '缺少诊断用例：' + label);
      assert(row.ok === false, label + ' 应该失败但返回成功了');
      assert(row.kind === expected[label], label + ' 的 kind 应为 ' + expected[label] + '，实际 ' + row.kind + '（' + row.message + '）');
      assert(row.hasErrInfo === true, label + ' 抛出的错误应带 err.info.kind');
      assert(/[\u4e00-\u9fa5]/.test(row.title), label + ' 的 title 要是中文：' + row.title);
      assert(/[\u4e00-\u9fa5]/.test(row.hint), label + ' 的 hint 要是中文：' + row.hint);
    });
    assert(run.synth.truncated.kind === 'truncated', 'finish_reason=length 应归 truncated，实际 ' + run.synth.truncated.kind);
    assert(run.synth.aborted.kind === 'aborted', 'AbortError 应归 aborted，实际 ' + run.synth.aborted.kind);
    assert(run.synth.timeout.kind === 'timeout', '超时文案应归 timeout，实际 ' + run.synth.timeout.kind);
    assert(run.synth.unknown.kind === 'unknown', '无法识别的错误应归 unknown，实际 ' + run.synth.unknown.kind);
  } finally {
    server.close();
  }
});

// 诊断信息不只在抛出的错误里：send() 失败后，最后一条 assistant 消息与 state.ai.lastErrorDetail
// 都要留下完整诊断（at/endpoint/model），面板与外部 MCP 调用方才不用自己猜。
test('AI 错误诊断：send 失败后 meta.errorInfo 与 lastErrorDetail 同步落地', async (page) => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let model = '';
      try { model = String(JSON.parse(body || '{}').model || ''); } catch (err) {}
      res.writeHead(model === 'case-auth' ? 401 : 200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (model === 'case-auth') res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      else res.end(JSON.stringify({ choices: [{ message: { content: '好的，收到。' }, finish_reason: 'stop' }] }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        messages: (state.ai.messages || []).slice(),
        lastError: state.ai.lastError,
        lastErrorDetail: state.ai.lastErrorDetail,
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend, stream: state.ai.stream, tts: state.ai.tts.enabled
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.backend = 'local';
      state.ai.stream = false;
      state.ai.tts.enabled = false;
      state.ai.model = 'case-auth';
      const failed = await AI.send('在吗');
      const failMsg = state.ai.messages[state.ai.messages.length - 1] || {};
      const failMeta = failMsg.meta || {};
      const failDetail = state.ai.lastErrorDetail || null;
      const failLastError = String(state.ai.lastError || '');
      // 成功一轮要清掉上一条失败诊断，避免面板一直挂着旧错误
      state.ai.model = 'case-ok';
      state.ai.lastErrorDetail = { stale: true };
      const okResult = await AI.send('再试一次');
      const out = {
        failedOk: failed && failed.ok,
        kindsInResult: failed && failed.errorInfo ? failed.errorInfo.kind : '',
        failKind: failMeta.errorInfo ? failMeta.errorInfo.kind : '',
        detailKind: failDetail ? failDetail.kind : '',
        detailAt: failDetail ? failDetail.at : null,
        detailEndpoint: failDetail ? failDetail.endpoint : '',
        detailModel: failDetail ? failDetail.model : '',
        lastError: failLastError,
        okResult: okResult && okResult.ok,
        clearedAfterOk: state.ai.lastErrorDetail
      };
      state.ai.messages = saved.messages;
      state.ai.lastError = saved.lastError;
      state.ai.lastErrorDetail = saved.lastErrorDetail;
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.ai.stream = saved.stream;
      state.ai.tts.enabled = saved.tts;
      return out;
    }, port);
    assert(run.failedOk === false, '401 时 send 不该返回成功');
    assert(run.kindsInResult === 'auth', 'send 返回值应带 errorInfo.kind=auth，实际：' + run.kindsInResult);
    assert(run.failKind === 'auth', '最后一条 assistant 消息 meta.errorInfo.kind 应为 auth，实际：' + run.failKind);
    assert(run.detailKind === 'auth', 'state.ai.lastErrorDetail.kind 应为 auth，实际：' + run.detailKind);
    assert(typeof run.detailAt === 'number' && run.detailAt > 0, 'lastErrorDetail.at 应是时间戳');
    assert(String(run.detailEndpoint).indexOf('127.0.0.1') >= 0, 'lastErrorDetail.endpoint 要记下端点：' + run.detailEndpoint);
    assert(String(run.detailModel).length > 0, 'lastErrorDetail.model 要记下模型名');
    assert(typeof run.lastError === 'string' && run.lastError.length > 0, 'state.ai.lastError 字符串要保持兼容');
    assert(run.okResult === true, '第二次成功调用应返回 ok');
    assert(run.clearedAfterOk === null, '成功后应清掉旧诊断，实际：' + JSON.stringify(run.clearedAfterOk));
  } finally {
    server.close();
  }
});

// normalizeFormulaIds 是生成前的确定性改写（带横杠通道 id → 公式名），会静默改掉
// 用户看到的公式文本，必须有钉子：① 带横杠 id 要换成公式名且能跑；② 普通公式不许被改写。
test('AI 生成脚本：带横杠通道 id 会换成公式名，普通公式保持原样', async (page) => {
  const http = require('http');
  // 不依赖测试顺序：过滤跑（只跑 AI 用例）时页面可能只有 ch1 这类合法 id，
  // 此时临时造一个飞控式带横杠通道 wed-fc-probe-01，用完在 evaluate 里还原。
  const ids = await page.evaluate(() => {
    const X = window.XHGCS;
    const all = X.allChannels();
    const dashed = all.find((ch) => String(ch.id) !== X.formulaAlias(ch.id));
    if (dashed) return { dashedId: String(dashed.id), dashedAlias: X.formulaAlias(dashed.id) };
    return { dashedId: 'wed-fc-probe-01', dashedAlias: X.formulaAlias('wed-fc-probe-01') };
  });
  assert(ids.dashedId && ids.dashedAlias, '测试环境里需要可用的通道');
  assert(ids.dashedId !== ids.dashedAlias, '该通道应有不同的公式名：' + JSON.stringify(ids));
  const stub = await startAiSpecStub((payload) => {
    const model = String(payload && payload.model || '');
    if (model === 'case-plain') {
      return { name: '普通公式脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'], outputs: [{ label: '均值' }] };
    }
    return { name: '横杠公式脚本', type: 'functions', formula: 'mean(' + ids.dashedId + ')', inputs: [ids.dashedId], outputs: [{ label: '均值' }] };
  });
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend,
        scripts: (state.scripts || []).slice(),
        channels: (state.scriptChannels || []).slice(),
        rawChannels: (state.channels || []).slice()
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'local';
      // 临时加带横杠通道（若过滤跑环境里本来没有）+ 普通 id 通道，测试结束都还原
      if (!X.findChannel(args.dashedId)) {
        state.channels = (state.channels || []).concat([{
          id: args.dashedId, name: '探针飞控通道', unit: '', color: '#38bdf8', range: [0, 100], data: [1, 2, 3, 4]
        }]);
      }
      // 临时加一个普通 id 通道（ch1）给反例用；测试结束还原
      if (!X.findChannel('ch1')) {
        state.channels = (state.channels || []).concat([{
          id: 'ch1', name: '测试通道ch1', unit: 'V', color: '#38bdf8', range: [0, 100], data: [1, 2, 3, 4]
        }]);
      }
      let dashedError = '';
      let plainError = '';
      let dashedMessage = '';
      let plainMessage = '';
      try {
        state.ai.model = 'case-dashed';
        const dashed = await AI.generateScript('算带横杠通道的均值', { inputs: [args.dashedId] });
        dashedMessage = String((dashed && dashed.message) || '');
      } catch (err) {
        dashedError = String((err && err.message) || err);
      }
      try {
        state.ai.model = 'case-plain';
        const plain = await AI.generateScript('算 ch1 的均值', { inputs: ['ch1'] });
        plainMessage = String((plain && plain.message) || '');
      } catch (err) {
        plainError = String((err && err.message) || err);
      }
      const dashedScript = (state.scripts || []).filter((s) => s.name === '横杠公式脚本').slice(-1)[0] || null;
      const plainScript = (state.scripts || []).filter((s) => s.name === '普通公式脚本').slice(-1)[0] || null;
      const dashedChannel = dashedScript
        ? (state.scriptChannels || []).filter((ch) => ch.scriptId === dashedScript.id)
        : [];
      const out = {
        dashedError: dashedError,
        plainError: plainError,
        dashedMessage: dashedMessage,
        plainMessage: plainMessage,
        dashedFormula: dashedScript ? String(dashedScript.formula) : '',
        plainFormula: plainScript ? String(plainScript.formula) : '',
        dashedSamples: dashedChannel.reduce((sum, ch) => sum + (Array.isArray(ch.data) ? ch.data.length : 0), 0)
      };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.channels = saved.rawChannels;
      return out;
    }, { port: stub.port, dashedId: ids.dashedId });
    assert(!run.dashedError, '带横杠 id 的合法公式不该生成失败：' + run.dashedError);
    assert(/试运行/.test(run.dashedMessage), '成功消息要带试运行结论：' + run.dashedMessage);
    assert(run.dashedFormula === 'mean(' + ids.dashedAlias + ')',
      '公式里的带横杠 id 应被换成公式名，实际：' + JSON.stringify(run.dashedFormula));
    assert(run.dashedFormula.indexOf(ids.dashedId) < 0, '库里不应该再留着带横杠的通道 id：' + run.dashedFormula);
    assert(run.dashedSamples > 0, '换名后的公式应能跑出值，实际样本 ' + run.dashedSamples);
    assert(!run.plainError, '普通公式 mean(ch1) 不该生成失败：' + run.plainError);
    assert(run.plainFormula === 'mean(ch1)', '普通公式不许被改写，实际：' + JSON.stringify(run.plainFormula));
  } finally {
    stub.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P3' DSH 后端打桩：假 dsh（tests/fixtures/fake-dsh.cjs）+ 测试桥
// 桥用 process.execPath 起 XHGCS_DSH_BIN 指向的脚本，所以不碰真 DSH、真模型、~/.dsh。
function bridgeHttpCall(bridge, method, target, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bridge.token) headers['X-XHGCS-Token'] = bridge.token;
    if (payload) headers['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: target, method: method, headers: headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startDshProbeBridge(extraEnv) {
  const { spawn } = require('child_process');
  const http = require('http');
  const fakeDsh = path.join(ROOT, 'tests', 'fixtures', 'fake-dsh.cjs');
  const probe = http.createServer();
  const freePort = await new Promise((resolve, reject) => {
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close(() => resolve(picked));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(freePort),
      XHGCS_ALLOWED_ORIGINS: '*loopback*',
      XHGCS_DSH_BIN: fakeDsh,
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '2500'
    }, extraEnv || {}),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const bridge = { port: freePort, token: '', child: child, call: null, stop: () => { try { child.kill(); } catch (err) { /* 已经退出 */ } } };
  bridge.call = (method, target, body) => bridgeHttpCall(bridge, method, target, body);
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await bridge.call('GET', '/api/health');
      if (res.status === 200) {
        const data = JSON.parse(res.body || '{}');
        bridge.token = String(data.token || '');
        return bridge;
      }
    } catch (err) { /* 桥还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  bridge.stop();
  throw new Error('打桩桥没能在 8 秒内起来');
}

// A：headless 失败时把真因写在 stderr（dsh: <code>: <message>），退出码只有 1。
// 以前桥只回「DSH 退出码 1」，用户和 AI 都不知道是模型不可用。这条同时钉桥级 JSON
// 与页面级 ai.js 抛出的错误，并验证 xhgcs:ai-error 事件带真因。
test('DSH 后端：stderr 里的失败真因能回到用户面前，不再只剩退出码', async (page) => {
  const bridge = await startDshProbeBridge({});
  try {
    const plain = JSON.parse((await bridge.call('POST', '/api/ai/dsh', { task: 'fake:fail', mode: 'answer' })).body);
    assert(plain.ok === false, '打桩 dsh 失败时桥应返回 ok:false，实际：' + JSON.stringify(plain));
    assert(/模型不可用/.test(String(plain.error)), '桥返回的 error 应是 stderr 里的真因，实际：' + JSON.stringify(plain.error));
    assert(String(plain.error).indexOf('DSH 退出码') !== 0, '不能只报退出码：' + JSON.stringify(plain.error));
    assert(typeof plain.stderrTail === 'string' && plain.stderrTail.length > 0, '失败应附 stderrTail 便于定位');

    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) { try { await window.XHGCS_LOADER.ensure('bridge'); } catch (err) { /* 非必须 */ } }
      // 页面侧统一保存/还原 DSH 环境（这些函数必须定义在 evaluate 里，页面上下文访问不到 Node helper）
      const saveDsh = () => ({
        backend: state.ai.backend, dshMode: state.ai.dshMode, dshProfile: state.ai.dshProfile,
        endpoint: state.mcp.endpoint, messages: (state.ai.messages || []).slice(),
        tts: state.ai.tts.enabled, lastError: state.ai.lastError, lastDetail: state.ai.lastErrorDetail
      });
      const restoreDsh = (saved) => {
        state.ai.backend = saved.backend;
        state.ai.dshMode = saved.dshMode;
        state.ai.dshProfile = saved.dshProfile;
        state.mcp.endpoint = saved.endpoint;
        state.ai.messages = saved.messages;
        state.ai.tts.enabled = saved.tts;
        state.ai.lastError = saved.lastError;
        state.ai.lastErrorDetail = saved.lastDetail;
      };
      const saved = saveDsh();
      state.mcp.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'dsh';
      state.ai.dshMode = 'agent';
      state.ai.dshProfile = 'headless';
      state.ai.tts.enabled = false;
      const errors = [];
      const onErr = (event) => errors.push(event && event.detail ? event.detail : {});
      window.addEventListener('xhgcs:ai-error', onErr);
      let result = null;
      try {
        result = await AI.send('fake:fail');
      } catch (err) {
        result = { ok: false, error: String((err && err.message) || err) };
      }
      window.removeEventListener('xhgcs:ai-error', onErr);
      const out = {
        ok: result ? result.ok : null,
        error: String((result && result.error) || ''),
        errorKind: result && result.errorInfo ? result.errorInfo.kind : '',
        aiErrorEvents: errors.slice(0, 3)
      };
      restoreDsh(saved);
      return out;
    }, { port: bridge.port });
    assert(run.ok === false, 'DSH 失败时 send 不该报成功');
    assert(/模型不可用/.test(run.error), 'ai.js 拿到的错误也必须是真因，实际：' + JSON.stringify(run.error));
    assert(run.errorKind && run.errorKind.length > 0, 'send 失败结果应带 errorInfo.kind');
    assert(run.aiErrorEvents.length >= 1, '应派发 xhgcs:ai-error 事件');
    assert(/模型不可用/.test(String(run.aiErrorEvents[0].raw || '')), 'ai-error 的 raw 里要带真因，实际：' + JSON.stringify(run.aiErrorEvents[0]));
  } finally {
    bridge.stop();
  }
});

// B：停止要真杀进程树。以前 /api/ai/dsh 没挂 close，浏览器 abort 只断 HTTP：
// 子进程跑到 180s 超时，dshState.running 一直 >0，用户点停止后立刻再问会被「正在执行」挡住。
test('DSH 后端：停止真杀进程树，复位后 2 秒内能再问', async (page) => {
  const os = require('os');
  const fs = require('fs');
  const pidFile = path.join(os.tmpdir(), 'xhgcs-fake-dsh-' + Date.now().toString(36) + '.pid');
  const bridge = await startDshProbeBridge({ XHGCS_FAKE_DSH_PIDFILE: pidFile });
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) { try { await window.XHGCS_LOADER.ensure('bridge'); } catch (err) { /* 非必须 */ } }
      // 页面侧统一保存/还原 DSH 环境（这些函数必须定义在 evaluate 里，页面上下文访问不到 Node helper）
      const saveDsh = () => ({
        backend: state.ai.backend, dshMode: state.ai.dshMode, dshProfile: state.ai.dshProfile,
        endpoint: state.mcp.endpoint, messages: (state.ai.messages || []).slice(),
        tts: state.ai.tts.enabled, lastError: state.ai.lastError, lastDetail: state.ai.lastErrorDetail
      });
      const restoreDsh = (saved) => {
        state.ai.backend = saved.backend;
        state.ai.dshMode = saved.dshMode;
        state.ai.dshProfile = saved.dshProfile;
        state.mcp.endpoint = saved.endpoint;
        state.ai.messages = saved.messages;
        state.ai.tts.enabled = saved.tts;
        state.ai.lastError = saved.lastError;
        state.ai.lastErrorDetail = saved.lastDetail;
      };
      const saved = saveDsh();
      state.mcp.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'dsh';
      state.ai.dshMode = 'agent';
      state.ai.dshProfile = 'headless';
      state.ai.tts.enabled = false;
      const busy = [];
      const onBusy = (event) => busy.push(event && event.detail ? event.detail : {});
      window.addEventListener('xhgcs:ai-busy', onBusy);
      const pending = AI.send('fake:sleep');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      AI.abort();
      try { await pending; } catch (err) { /* send 内部已处理 */ }
      // 页面内轮询桥的 running：取消后 2 秒内必须回到 0
      const startedAt = Date.now();
      let running = null;
      for (let i = 0; i < 40; i += 1) {
        const status = await X.mcpJson('/api/ai/dsh', { method: 'GET' }, 3000).catch(() => ({}));
        running = typeof status.running === 'number' ? status.running : null;
        if (running === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const waitedMs = Date.now() - startedAt;
      // 2 秒内再问：不该再撞「DSH 正在执行其它任务」
      const second = await AI.send('fake:quick');
      window.removeEventListener('xhgcs:ai-busy', onBusy);
      const out = {
        running: running,
        waitedMs: waitedMs,
        secondOk: Boolean(second && second.ok === true),
        secondError: String((second && second.error) || ''),
        busyEnd: busy.filter((item) => item.busy === false).length
      };
      restoreDsh(saved);
      return out;
    }, { port: bridge.port });
    assert(run.running === 0, '取消后 2 秒内 dshState.running 必须回到 0，实际 ' + run.running + '（等待 ' + run.waitedMs + 'ms）');
    assert(run.waitedMs <= 2000, '复位耗时应在 2 秒内，实际 ' + run.waitedMs + 'ms');
    assert(run.secondOk === true, '取消后紧接着再问不该撞「正在执行其它任务」，实际 error=' + run.secondError);
    assert(run.busyEnd >= 1, '停止后应派发 ai-busy busy:false');
    assert(fs.existsSync(pidFile), '打桩进程没写出 pid 文件（长跑任务没启动）');
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    assert(pid > 0, 'pid 文件内容不对');
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try { process.kill(pid, 0); } catch (err) { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(!alive, '取消后打桩 dsh 进程仍活着（pid ' + pid + '）：只断了 HTTP，没杀进程树');
  } finally {
    bridge.stop();
    try { require('fs').unlinkSync(pidFile); } catch (err) { /* 没写出来就算了 */ }
  }
});

// C：headless 把 reasoning 实时写 stderr，桥等进程退出才回 JSON 的话用户要对着
// 「AI 正在思考…」死等。这条验证进度走 SSE 回到页面、最终正文正确、进度不阻塞退出。
test('DSH 后端：进度走 SSE 回到页面，最终正文正确且进程正常退出', async (page) => {
  const bridge = await startDshProbeBridge({});
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) { try { await window.XHGCS_LOADER.ensure('bridge'); } catch (err) { /* 非必须 */ } }
      // 页面侧统一保存/还原 DSH 环境（这些函数必须定义在 evaluate 里，页面上下文访问不到 Node helper）
      const saveDsh = () => ({
        backend: state.ai.backend, dshMode: state.ai.dshMode, dshProfile: state.ai.dshProfile,
        endpoint: state.mcp.endpoint, messages: (state.ai.messages || []).slice(),
        tts: state.ai.tts.enabled, lastError: state.ai.lastError, lastDetail: state.ai.lastErrorDetail
      });
      const restoreDsh = (saved) => {
        state.ai.backend = saved.backend;
        state.ai.dshMode = saved.dshMode;
        state.ai.dshProfile = saved.dshProfile;
        state.mcp.endpoint = saved.endpoint;
        state.ai.messages = saved.messages;
        state.ai.tts.enabled = saved.tts;
        state.ai.lastError = saved.lastError;
        state.ai.lastErrorDetail = saved.lastDetail;
      };
      const saved = saveDsh();
      state.mcp.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'dsh';
      state.ai.dshMode = 'agent';
      state.ai.dshProfile = 'headless';
      state.ai.tts.enabled = false;
      const reasons = [];
      const busy = [];
      const onBusy = (event) => busy.push(event && event.detail ? event.detail : {});
      window.addEventListener('xhgcs:ai-busy', onBusy);
      const result = await AI.send('fake:stream', {
        onReason: (delta) => reasons.push(String(delta || '')),
        onDelta: () => {}
      });
      window.removeEventListener('xhgcs:ai-busy', onBusy);
      const status = await X.mcpJson('/api/ai/dsh', { method: 'GET' }, 3000).catch(() => ({}));
      const out = {
        ok: Boolean(result && result.ok),
        content: String((result && result.content) || ''),
        reasons: reasons.slice(),
        running: typeof status.running === 'number' ? status.running : null,
        busyStart: busy.filter((item) => item.busy === true).length,
        busyEnd: busy.filter((item) => item.busy === false).length
      };
      restoreDsh(saved);
      return out;
    }, { port: bridge.port });
    assert(run.ok === true, 'SSE 进度模式下最终仍应成功，实际 content=' + JSON.stringify(run.content));
    assert(run.reasons.length >= 3, '应收到至少 3 段 reasoning 增量，实际 ' + JSON.stringify(run.reasons));
    const reasonText = run.reasons.join('');
    assert(/读取通道数据/.test(reasonText) && /整理结论/.test(reasonText),
      '进度内容应是 dsh: reasoning: 之后的文本，实际：' + JSON.stringify(run.reasons));
    assert(/最终答案：均值 3.21/.test(run.content), '最终正文应来自 final 事件，实际：' + JSON.stringify(run.content));
    assert(run.running === 0, '进度不能阻塞退出：结束后 running 应为 0，实际 ' + run.running);
    assert(run.busyStart >= 1 && run.busyEnd >= 1, '应有 ai-busy 开始/结束事件，实际 ' + JSON.stringify({ start: run.busyStart, end: run.busyEnd }));
  } finally {
    bridge.stop();
  }
});

// C-real：真实 headless 的 stderr 是「一次 dsh: reasoning: 头 + 裸文本增量、无前缀无换行」。
// 只按整行前缀识别会把进度全丢（实测 SSE 只剩一个换行）。这条回放真实抓包，钉住
// ① 进度能到页面 ② 可观测判据（首段先于 final、多段分布在 ≥100ms、正文不混入 reasoning）。
test('DSH 后端：真实 headless 抓包的裸文本进度也能回到页面', async (page) => {
  const bridge = await startDshProbeBridge({});
  try {
    const run = await page.evaluate(async (args) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) { try { await window.XHGCS_LOADER.ensure('bridge'); } catch (err) { /* 非必须 */ } }
      // 页面侧统一保存/还原 DSH 环境（这些函数必须定义在 evaluate 里，页面上下文访问不到 Node helper）
      const saveDsh = () => ({
        backend: state.ai.backend, dshMode: state.ai.dshMode, dshProfile: state.ai.dshProfile,
        endpoint: state.mcp.endpoint, messages: (state.ai.messages || []).slice(),
        tts: state.ai.tts.enabled, lastError: state.ai.lastError, lastDetail: state.ai.lastErrorDetail
      });
      const restoreDsh = (saved) => {
        state.ai.backend = saved.backend;
        state.ai.dshMode = saved.dshMode;
        state.ai.dshProfile = saved.dshProfile;
        state.mcp.endpoint = saved.endpoint;
        state.ai.messages = saved.messages;
        state.ai.tts.enabled = saved.tts;
        state.ai.lastError = saved.lastError;
        state.ai.lastErrorDetail = saved.lastDetail;
      };
      const saved = saveDsh();
      state.mcp.endpoint = 'http://127.0.0.1:' + args.port;
      state.ai.backend = 'dsh';
      state.ai.dshMode = 'agent';
      state.ai.dshProfile = 'headless';
      state.ai.tts.enabled = false;
      const reasons = [];
      const reasonTimes = [];
      const busy = [];
      const onBusy = (event) => busy.push(event && event.detail ? event.detail : {});
      window.addEventListener('xhgcs:ai-busy', onBusy);
      const result = await AI.send('fake:stream-real', {
        onReason: (delta) => {
          reasons.push(String(delta || ''));
          reasonTimes.push(performance.now());
        },
        onDelta: () => {}
      });
      const finalAt = performance.now();
      window.removeEventListener('xhgcs:ai-busy', onBusy);
      const status = await X.mcpJson('/api/ai/dsh', { method: 'GET' }, 3000).catch(() => ({}));
      const out = {
        ok: Boolean(result && result.ok),
        content: String((result && result.content) || ''),
        reasons: reasons.slice(),
        reasonTimes: reasonTimes.slice(),
        finalAt: finalAt,
        running: typeof status.running === 'number' ? status.running : null,
        busyStart: busy.filter((item) => item.busy === true).length,
        busyEnd: busy.filter((item) => item.busy === false).length
      };
      restoreDsh(saved);
      return out;
    }, { port: bridge.port });
    assert(run.ok === true, '真实格式的进度模式最终仍应成功，实际 content=' + JSON.stringify(run.content));
    assert(run.reasons.length >= 3, '真实格式下应收到多段进度，实际 ' + JSON.stringify(run.reasons));
    const reasonText = run.reasons.join('');
    assert(/The user asks in Chinese/.test(reasonText), '真实抓包里的裸文本应完整到达页面，实际：' + JSON.stringify(reasonText.slice(0, 120)));
    // 可观测判据 1：首段 reason 先于 final 到达（且不是最后一次性倒出来的）
    const spread = run.reasonTimes.length > 1 ? run.reasonTimes[run.reasonTimes.length - 1] - run.reasonTimes[0] : 0;
    assert(run.finalAt - run.reasonTimes[0] >= 100, '首段进度应明显早于 final 到达，实际差 ' + Math.round(run.finalAt - run.reasonTimes[0]) + 'ms');
    // 可观测判据 2：多段 reason 的时间分布 ≥100ms
    assert(spread >= 100, '多段进度应分布在 ≥100ms 区间，实际 ' + Math.round(spread) + 'ms');
    // 可观测判据 3：final 正文不能混入 reasoning 文本
    assert(run.content.indexOf('The user asks') < 0 && run.content.indexOf('Let me craft') < 0,
      'final 正文混入了 reasoning 文本：' + JSON.stringify(run.content.slice(0, 120)));
    assert(run.content.indexOf('瑞利散射') >= 0, 'final 正文应是真实 stdout 内容，实际：' + JSON.stringify(run.content.slice(0, 120)));
    assert(run.running === 0, '进度不能阻塞退出：结束后 running 应为 0，实际 ' + run.running);
    assert(run.busyStart >= 1 && run.busyEnd >= 1, '应有 ai-busy 开始/结束事件，实际 ' + JSON.stringify({ start: run.busyStart, end: run.busyEnd }));
  } finally {
    bridge.stop();
  }
});

// P3：MCP 侧能 update/delete 脚本（引擎同理），浏览器执行体必须真的改/删并写删除墓碑。
// 否则 agent 生成完改不了、清不掉，只能让用户手动善后 —— 「AI 自己完成任务」直接断在这里。
test('桥：MCP 脚本 update/delete 端到端改得动、删得掉、不复活', async (page) => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'p3-mcp-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close(() => resolve(picked));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(port),
      XHGCS_BRIDGE_TOKEN: token,
      XHGCS_ALLOWED_ORIGINS: '*loopback*',
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '6000'
    }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const mcp = (name, args) => call('POST', '/api/mcp', H, JSON.stringify({ name: name, arguments: args || {} }));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let scriptId = '';
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) { /* 还没起来 */ }
      if (!ready) await pause(100);
    }
    assert(ready, '桥没能在超时内起来');
    // 页面开桥（真渲染层），让排队项由浏览器执行体处理
    const setup = await page.evaluate(async (bridgePort) => {
      const X = window.XHGCS;
      const state = X.state;
      const L = window.XHGCS_LOADER;
      if (L && L.ensure) { try { await L.ensure('bridge'); } catch (err) { /* 非必须 */ } }
      const B = window.XHGCS_BRIDGE;
      if (!B || !B.start) return { error: '没有桥模块' };
      window.__p3SavedMcp = { enabled: state.mcp.enabled, endpoint: state.mcp.endpoint };
      if (B.stop) B.stop();
      state.mcp.endpoint = 'http://127.0.0.1:' + bridgePort;
      B.start();
      for (let i = 0; i < 50; i += 1) {
        if (state.mcp.connected) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const ch = X.allChannels()[0];
      return {
        connected: Boolean(state.mcp.connected),
        channelId: ch ? String(ch.id) : '',
        formulaName: ch ? X.formulaAlias(ch.id) : ''
      };
    }, port);
    assert(!setup.error, setup.error);
    assert(setup.connected, '渲染层没能连上测试桥');
    assert(setup.channelId && setup.formulaName, '测试环境里需要至少一个可用通道');

    const scriptName = 'P3 端到端脚本';
    const oldFormula = 'mean(' + setup.formulaName + ')';
    const newFormula = 'rms(' + setup.formulaName + ')';
    const created = JSON.parse((await mcp('create_script', {
      name: scriptName, type: 'functions', formula: oldFormula, inputs: [setup.channelId],
      outputs: [{ id: 'out_old', label: '旧均值', unit: 'V' }], run: true
    })).body).result || {};
    scriptId = String((created.script || {}).id || '');
    assert(created.applied === true && scriptId, 'create_script 应被浏览器真正应用：' + JSON.stringify(created).slice(0, 240));
    await page.waitForFunction((id) => (window.XHGCS.state.scripts || []).some((s) => s.id === id), scriptId, { timeout: 6000 });

    // 记录更新前的页签：后台脚本更新不该把用户视图抢到「脚本数据」
    const tabBeforeUpdate = await page.evaluate(() => String(window.XHGCS.state.channelTab || ''));
    const updated = JSON.parse((await mcp('update_script', {
      id: scriptId, formula: newFormula, new_name: 'P3 端到端脚本改',
      outputs: [{ id: 'out_new', label: '新有效值', unit: 'V' }]
    })).body).result || {};
    assert(updated.applied === true, 'update_script 应被浏览器真正应用：' + JSON.stringify(updated).slice(0, 240));
    await page.waitForFunction((args) => {
      const script = (window.XHGCS.state.scripts || []).find((s) => s.id === args.id);
      return Boolean(script && script.formula === args.formula);
    }, { id: scriptId, formula: newFormula }, { timeout: 6000 });
    const afterUpdate = await page.evaluate((id) => {
      const state = window.XHGCS.state;
      const script = (state.scripts || []).find((s) => s.id === id) || null;
      return {
        name: script ? String(script.name || '') : '',
        formula: script ? String(script.formula || '') : '',
        channels: (state.scriptChannels || []).filter((ch) => ch.scriptId === id).map((ch) => ch.outputId),
        channelTab: String(state.channelTab || '')
      };
    }, scriptId);
    assert(afterUpdate.name === 'P3 端到端脚本改', '脚本名应被更新，实际：' + JSON.stringify(afterUpdate.name));
    assert(afterUpdate.channels.length === 1 && afterUpdate.channels[0] === 'out_new',
      '更新后输出通道应重建为 out_new（旧 out_old 清掉），实际：' + JSON.stringify(afterUpdate.channels));
    assert(afterUpdate.channelTab === tabBeforeUpdate,
      '后台 script_updated 不该抢用户页签：更新前 ' + tabBeforeUpdate + '，更新后 ' + afterUpdate.channelTab);

    // 删除：同时验证脚本通道清掉、删除墓碑写入、画布不再指向它
    await page.evaluate((id) => { window.XHGCS.state.analysis.canvasScriptId = id; }, scriptId);
    const deleted = JSON.parse((await mcp('delete_script', { id: scriptId })).body).result || {};
    assert(deleted.applied === true && deleted.ok !== false, 'delete_script 应成功：' + JSON.stringify(deleted).slice(0, 240));
    const afterDelete = await page.evaluate((id) => {
      const state = window.XHGCS.state;
      return {
        exists: (state.scripts || []).some((s) => s.id === id),
        channels: (state.scriptChannels || []).filter((ch) => ch.scriptId === id).length,
        tombstone: (state.mcp.deletedScripts || []).indexOf(id) >= 0,
        canvasScriptId: String(state.analysis.canvasScriptId || '')
      };
    }, scriptId);
    assert(!afterDelete.exists, '删除后脚本应从脚本库消失');
    assert(afterDelete.channels === 0, '删除后脚本通道应一起清掉，实际残留 ' + afterDelete.channels);
    assert(afterDelete.tombstone === true, '删除后应写删除墓碑（deletedScripts）');
    assert(afterDelete.canvasScriptId !== scriptId, '画布 canvasScriptId 指向被删脚本时应置空');
    // 再等两轮轮询（同步间隔 1.5s）：桥侧残留不能把它复活
    await pause(3600);
    const revived = await page.evaluate((id) => (window.XHGCS.state.scripts || []).some((s) => s.id === id), scriptId);
    assert(!revived, '删除的脚本被下一轮同步复活了：删墓碑没生效');
  } finally {
    await page.evaluate((id) => {
      const X = window.XHGCS;
      const B = window.XHGCS_BRIDGE;
      const saved = window.__p3SavedMcp || {};
      const state = X.state;
      if (B && B.stop) B.stop();
      const doomed = (state.scripts || []).filter((s) => s.id === id || String(s.name || '').indexOf('P3 端到端脚本') === 0).map((s) => s.id);
      state.scripts = (state.scripts || []).filter((s) => doomed.indexOf(s.id) < 0);
      state.scriptChannels = (state.scriptChannels || []).filter((ch) => doomed.indexOf(ch.scriptId) < 0);
      state.mcp.deletedScripts = (state.mcp.deletedScripts || []).filter((sid) => doomed.indexOf(sid) < 0);
      if (doomed.indexOf(state.analysis.canvasScriptId) >= 0) state.analysis.canvasScriptId = '';
      state.mcp.endpoint = saved.endpoint || state.mcp.endpoint;
      if (saved.enabled && B && B.start) B.start();
      delete window.__p3SavedMcp;
    }, scriptId).catch(() => {});
    child.kill();
  }
});

// P4：工具循环以前完全不可观测。toolTrace() 空态必须返回 []（不是 undefined/null），
// 界面与排障面板可以直接渲染，不用到处判空。
test('AI 工具：toolTrace 空态返回空数组且不抛异常', async (page) => {
  const run = await page.evaluate(() => {
    const AI = window.XHGCS_AI;
    if (!AI || typeof AI.toolTrace !== 'function') return { error: '没有 XHGCS_AI.toolTrace' };
    const first = AI.toolTrace();
    return { isArray: Array.isArray(first), length: first.length };
  });
  assert(!run.error, run.error);
  assert(run.isArray === true, 'toolTrace() 必须返回数组，实际：' + JSON.stringify(run));
  assert(run.length === 0, '还没调用过工具时 toolTrace() 应为空数组，实际长度 ' + run.length);
});

// P4：未知工具 / 参数非 JSON / 工具超时三种失败都要回灌明确错误，不能抛到循环外或挂死；
// 结果超 12000 字符改为「头 8000 + 标记 + 尾 2000」。这四件事直接测 ai-tools 执行体。
test('AI 工具：未知工具/坏参数/超时都回灌明确错误，超长结果保头保尾', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const TOOLS = window.XHGCS_AI_TOOLS;
    if (!TOOLS || typeof TOOLS.execute !== 'function') return { error: '没有 XHGCS_AI_TOOLS' };
    const state = X.state;
    const saved = { toolTimeoutMs: state.ai.toolTimeoutMs };
    try {
      // 1) 未知工具：明确报错并列出可用工具
      const unknown = await TOOLS.execute({ id: 'u1', function: { name: 'no_such_tool', arguments: '{}' } });
      // 2) 参数不是合法 JSON：如实回灌解析错误
      const badArgs = await TOOLS.execute({ id: 'u2', function: { name: 'snapshot', arguments: '{not-json' } });
      // 3) 超时：挂死的实现必须在 15s 上限内返回 timedOut（这里用 120ms 缩短等待）
      const startedAt = Date.now();
      const timed = await Promise.race([
        TOOLS.runWithTimeout(() => new Promise(() => { /* 永不 resolve，模拟挂死工具 */ }), 120),
        new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 3000))
      ]);
      const timedMs = Date.now() - startedAt;
      // 4) 超长结果裁剪：临时加 12 个带 100 点历史的探针通道，保证 list_channels(include_series)
      // 一定超过 12000 字符（回归环境默认通道数因测试顺序可能只有 5 个，不靠它凑长度）
      const rawBefore = (state.channels || []).slice();
      for (let i = 0; i < 12; i += 1) {
        state.channels.push({
          id: 'p4-probe-' + i,
          name: 'P4 探针 ' + i,
          unit: '',
          range: [0, 100],
          data: Array.from({ length: 100 }, (_, k) => Math.sin((k + i) / 7) * 1234.5678)
        });
      }
      let huge = null;
      try {
        huge = await TOOLS.execute({ id: 'u4', function: { name: 'list_channels', arguments: JSON.stringify({ include_series: true }) } });
      } finally {
        state.channels = rawBefore;
      }
      const text = String((huge && huge.content) || '');
      return {
        unknown: { ok: unknown.ok, content: String(unknown.content || ''), hasMs: typeof unknown.ms === 'number', hasBytes: typeof unknown.bytes === 'number' },
        badArgs: { ok: badArgs.ok, content: String(badArgs.content || '') },
        timed: { timedOut: Boolean(timed && timed.timedOut), hung: Boolean(timed && timed.hung), ms: timedMs },
        huge: { ok: huge.ok, length: text.length, head: text.slice(0, 120), tail: text.slice(-160), hasMarker: text.indexOf('结果过长已裁剪') >= 0, hasRetry: text.indexOf('可用更小的 limit / points 重试') >= 0 }
      };
    } finally {
      state.ai.toolTimeoutMs = saved.toolTimeoutMs;
    }
  });
  assert(!run.error, run.error);
  // 未知工具
  assert(run.unknown.ok === false && /未知工具/.test(run.unknown.content), '未知工具要回灌「未知工具」错误：' + run.unknown.content.slice(0, 160));
  assert(run.unknown.hasMs && run.unknown.hasBytes, '工具结果要带 {ms,bytes} 计量');
  // 坏参数
  assert(run.badArgs.ok === false && /JSON/.test(run.badArgs.content), '非法参数要回灌 JSON 解析错误：' + run.badArgs.content.slice(0, 160));
  // 超时
  assert(run.timed.timedOut === true && run.timed.hung !== true, '挂死工具必须在上限内返回 timedOut，实际：' + JSON.stringify(run.timed));
  assert(run.timed.ms < 2000, '超时保护应尽快返回（<2s），实际 ' + run.timed.ms + 'ms');
  // 超长裁剪
  assert(run.huge.ok === true, 'list_channels 大结果本身应成功：' + JSON.stringify(run.huge).slice(0, 160));
  assert(run.huge.hasMarker && run.huge.hasRetry, '超长结果必须有裁剪标记与重试提示，实际：' + JSON.stringify(run.huge).slice(0, 400));
  assert(run.huge.length > 9000 && run.huge.length < 11000, '裁剪后长度应约为头 8000 + 尾 2000，实际 ' + run.huge.length);
  assert(run.huge.head.indexOf('"count"') >= 0 || run.huge.head.indexOf('{') === 0, '裁剪后要保留头部：' + run.huge.head);
  assert(run.huge.tail.indexOf('}]') >= 0 || run.huge.tail.indexOf('}') >= 0, '裁剪后要保留尾部：' + run.huge.tail);
});

// P4：工具循环要能自己取真实历史序列来回答（channel_history），并把每轮调用记进 meta.tools。
test('AI 工具循环：channel_history 回传真实序列并记入 meta.tools', async (page) => {
  const http = require('http');
  const channelId = await page.evaluate(() => {
    const ch = window.XHGCS.allChannels()[0];
    return ch ? String(ch.id) : '';
  });
  assert(channelId, '测试环境里应该至少有一个通道');
  const seen = [];
  let round = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (err) { payload = {}; }
      seen.push(payload);
      round += 1;
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (round === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_hist',
                type: 'function',
                function: { name: 'channel_history', arguments: JSON.stringify({ channel: channelId, points: 20 }) }
              }]
            },
            finish_reason: 'tool_calls'
          }]
        }));
        return;
      }
      const toolMsg = (payload.messages || []).filter((m) => m.role === 'tool')[0] || {};
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '工具回传：' + String(toolMsg.content || '').slice(0, 220) } }]
      }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) { try { await window.XHGCS_LOADER.ensure('ai'); } catch (err) { /* 非必须 */ } }
      const ch = X.allChannels()[0];
      if (!ch) return { error: '没有可用通道' };
      for (let i = 0; i < 40; i += 1) X.pushSample(ch, 3 + Math.sin(i / 5));
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend, stream: state.ai.stream, tools: state.ai.tools,
        messages: (state.ai.messages || []).slice()
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      state.ai.stream = false;
      state.ai.tools = true;
      try {
        const result = await AI.send('看看 ' + ch.id + ' 最近的数据');
        const last = state.ai.messages[state.ai.messages.length - 1] || {};
        const meta = last.meta || {};
        return {
          content: String((result && result.content) || ''),
          channelId: String(ch.id),
          toolTrace: AI.toolTrace(),
          metaTools: Array.isArray(meta.tools) ? meta.tools : null
        };
      } finally {
        state.ai.useProxy = saved.useProxy;
        state.ai.endpoint = saved.endpoint;
        state.ai.model = saved.model;
        state.ai.backend = saved.backend;
        state.ai.stream = saved.stream;
        state.ai.tools = saved.tools;
        state.ai.messages = saved.messages;
      }
    }, port);
    assert(!run.error, run.error);
    assert(seen.length >= 2, '模型要求 channel_history 后必须再发一轮请求，实际只发了 ' + seen.length + ' 轮');
    const toolMsg = (seen[1].messages || []).filter((m) => m.role === 'tool')[0];
    assert(toolMsg, '第二轮必须把 channel_history 结果以 role:tool 回灌');
    const toolContent = String(toolMsg.content || '');
    assert(toolContent.indexOf(channelId) >= 0, '工具回灌里要含真实通道 id，实际：' + toolContent.slice(0, 160));
    assert(toolContent.indexOf('"series"') >= 0 && toolContent.indexOf('"stats"') >= 0,
      'channel_history 回灌应含真实序列与统计量，实际：' + toolContent.slice(0, 200));
    assert(/"mean":\s*-?\d/.test(toolContent), '统计量里应有真实数值，实际：' + toolContent.slice(0, 240));
    assert(run.metaTools && run.metaTools.length >= 1, 'meta.tools 应记录工具调用，实际：' + JSON.stringify(run.metaTools));
    const entry = run.metaTools[0] || {};
    assert(entry.name === 'channel_history' && entry.ok === true, 'meta.tools 应含成功的 channel_history，实际：' + JSON.stringify(entry));
    assert(typeof entry.ms === 'number' && entry.bytes > 0, 'meta.tools 条目要带 ms/bytes：' + JSON.stringify(entry));
    assert(run.content.indexOf(channelId) >= 0, '最终回答应引用工具回传的真实通道，实际：' + run.content.slice(0, 200));
    assert(Array.isArray(run.toolTrace) && run.toolTrace.length >= 1 && run.toolTrace[0].name === 'channel_history',
      'toolTrace() 应能读到本轮轨迹，实际：' + JSON.stringify(run.toolTrace));
  } finally {
    server.close();
  }
});

// P5：上下文预算驱动裁剪——40 轮 × 3000 字符的长历史必须按预算裁，
// 但当前问题完整保留、最近一轮 assistant 保留，contextUsage() 要对得上。
test('AI 上下文预算：长历史按预算裁剪，当前问题完整保留', async (page) => {
  const http = require('http');
  const payloads = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (err) { payload = {}; }
      payloads.push(payload);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ choices: [{ message: { content: '收到。' }, finish_reason: 'stop' }] }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend, stream: state.ai.stream, budget: state.ai.contextBudgetChars,
        messages: (state.ai.messages || []).slice(), tts: state.ai.tts.enabled
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      state.ai.stream = false;
      state.ai.tts.enabled = false;
      state.ai.contextBudgetChars = 24000;
      const history = [];
      for (let i = 0; i < 40; i += 1) {
        const text = ('轮' + i + '：').padEnd(3000, 'x');
        history.push({ id: 'm' + i, role: i % 2 === 0 ? 'user' : 'assistant', content: text, raw: text, time: Date.now() });
      }
      state.ai.messages = history;
      const prompt = '当前问题：' + '这是完整的问题内容'.repeat(20);
      let ok = false;
      let error = '';
      try {
        const sent = await AI.send(prompt);
        ok = Boolean(sent && sent.ok);
      } catch (err) {
        error = String((err && err.message) || err);
      }
      const usage = AI.contextUsage();
      const out = { ok: ok, error: error, usage: usage, prompt: prompt, budget: 24000 };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.ai.stream = saved.stream;
      state.ai.contextBudgetChars = saved.budget;
      state.ai.messages = saved.messages;
      state.ai.tts.enabled = saved.tts;
      return out;
    }, port);
    assert(!run.error, '预算裁剪这一问不该失败：' + run.error);
    assert(run.ok === true, '这一问应成功');
    const withPrompt = payloads.filter((payload) => {
      const list = Array.isArray(payload && payload.messages) ? payload.messages : [];
      const last = list[list.length - 1] || {};
      return last.role === 'user' && String(last.content || '') === run.prompt;
    });
    assert(withPrompt.length >= 1, '没有捕获到带完整当前问题的请求 payload');
    const messages = withPrompt[0].messages;
    const chars = messages.reduce((sum, msg) => sum + String(msg.content || '').length, 0);
    const lastAssistant = messages.slice().reverse().find((msg) => msg.role === 'assistant');
    assert(chars <= run.budget, '发给模型的上下文总字符应 ≤ 预算 ' + run.budget + '，实际 ' + chars + '（没裁？）');
    assert(lastAssistant, '最近一轮 assistant 必须保留（不然模型接不上上一轮）');
    assert(run.usage.trimmed === true, '长历史应标记 trimmed=true，实际：' + JSON.stringify(run.usage));
    assert(run.usage.chars > 0 && run.usage.chars <= run.budget && run.usage.estTokens > 0 && run.usage.budget === run.budget,
      'contextUsage() 应对得上预算：' + JSON.stringify(run.usage));
  } finally {
    server.close();
  }
});

// P5：小预算 + 两轮工具调用时，请求里的 assistant.tool_calls 与 role:tool 结果必须成对，
// 上下文裁剪不能把一轮工具往返拆散（拆散上游会 400，也等于让模型凭空收到工具结果）。
test('AI 上下文预算：小预算下工具调用成对，不被裁半', async (page) => {
  const http = require('http');
  const payloads = [];
  let round = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (err) { payload = {}; }
      payloads.push(payload);
      round += 1;
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (round === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'snapshot', arguments: '{}' } },
                { id: 'call_b', type: 'function', function: { name: 'list_channels', arguments: JSON.stringify({ kind: 'all' }) } }
              ]
            },
            finish_reason: 'tool_calls'
          }]
        }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '工具都查完了。' } }] }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend, stream: state.ai.stream, tools: state.ai.tools,
        budget: state.ai.contextBudgetChars, messages: (state.ai.messages || []).slice(),
        tts: state.ai.tts.enabled
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      state.ai.stream = false;
      state.ai.tools = true;
      state.ai.tts.enabled = false;
      // 小预算 + 一段长历史，逼预算裁剪先发生，再看后续工具往返是否成对
      state.ai.contextBudgetChars = 20000;
      const history = [];
      for (let i = 0; i < 12; i += 1) {
        const text = ('历史轮' + i + '：').padEnd(2000, 'y');
        history.push({ id: 'h' + i, role: i % 2 === 0 ? 'user' : 'assistant', content: text, raw: text, time: Date.now() });
      }
      state.ai.messages = history;
      let content = '';
      let error = '';
      try {
        const result = await AI.send('用工具确认一下当前数据链');
        content = String((result && result.content) || '');
      } catch (err) {
        error = String((err && err.message) || err);
      }
      const out = { content: content, error: error, usage: AI.contextUsage() };
      state.ai.useProxy = saved.useProxy;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.backend = saved.backend;
      state.ai.stream = saved.stream;
      state.ai.tools = saved.tools;
      state.ai.contextBudgetChars = saved.budget;
      state.ai.messages = saved.messages;
      state.ai.tts.enabled = saved.tts;
      return out;
    }, port);
    assert(!run.error, '小预算工具循环不该失败：' + run.error);
    assert(run.content.indexOf('工具都查完了') >= 0, '第二轮回答应回到正文，实际：' + run.content.slice(0, 160));
    const toolRound = payloads.filter((payload) => (payload.messages || []).some((msg) => msg.role === 'tool'));
    assert(toolRound.length >= 1, '必须捕获到带 role:tool 的第二轮请求');
    const messages = toolRound[0].messages;
    const callIds = [];
    messages.forEach((msg, index) => {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((call) => callIds.push({ id: String(call.id || ''), index: index }));
      }
    });
    assert(callIds.length >= 2, 'assistant.tool_calls 应保留两轮调用，实际：' + JSON.stringify(callIds));
    callIds.forEach((call) => {
      const paired = messages.some((msg, index) => index > call.index && msg.role === 'tool' && String(msg.tool_call_id || '') === call.id);
      assert(paired, 'tool_call ' + call.id + ' 缺少配对的 role:tool 结果（被裁半了）');
    });
    messages.forEach((msg, index) => {
      if (msg.role !== 'tool') return;
      const called = callIds.some((call) => call.id === String(msg.tool_call_id || '') && call.index < index);
      assert(called, 'role:tool 结果没有对应的 assistant.tool_calls：' + JSON.stringify(msg.tool_call_id));
    });
  } finally {
    server.close();
  }
});

// P5：桥代理路径（useProxy=true）的 400 body 要能被诊断成 context_length（而不是 upstream），
// 否则自动降预算重试永远触发不到。
test('AI 错误诊断：桥代理 400 context_length body 归为 context_length', async (page) => {
  const http = require('http');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (String(req.url || '').indexOf('/api/health') === 0) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ ok: true, token: 'proxy-probe-token' }));
      return;
    }
    res.writeHead(400, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ ok: false, error: '上游 HTTP 400 · context_length_exceeded: maximum context length 8192 tokens' }));
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      const saved = {
        endpoint: state.mcp.endpoint, aiEndpoint: state.ai.endpoint, aiModel: state.ai.model,
        backend: state.ai.backend, useProxy: state.ai.useProxy,
        scripts: (state.scripts || []).slice(), channels: (state.scriptChannels || []).slice(),
        messages: (state.ai.messages || []).slice(), tts: state.ai.tts.enabled
      };
      state.mcp.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.useProxy = true;
      state.ai.backend = 'local';
      state.ai.endpoint = 'http://127.0.0.1:9';
      state.ai.model = 'stub-model';
      state.ai.tts.enabled = false;
      const ch = X.allChannels()[0];
      let error = '';
      let kind = '';
      let status = 0;
      let detail = '';
      try {
        await AI.generateScript('算个均值', { inputs: [ch ? ch.id : 'ch1'] });
      } catch (err) {
        error = String((err && err.message) || err);
        const info = AI.diagnose(err);
        kind = info.kind;
        status = info.status;
        detail = String(info.detail || '');
      }
      const out = { error: error, kind: kind, status: status, detail: detail };
      state.mcp.endpoint = saved.endpoint;
      state.ai.endpoint = saved.aiEndpoint;
      state.ai.model = saved.aiModel;
      state.ai.backend = saved.backend;
      state.ai.useProxy = saved.useProxy;
      state.scripts = saved.scripts;
      state.scriptChannels = saved.channels;
      state.ai.messages = saved.messages;
      state.ai.tts.enabled = saved.tts;
      return out;
    }, port);
    assert(run.kind === 'context_length', '代理路径 400 body 应归为 context_length，实际 kind=' + run.kind + '，detail=' + JSON.stringify(run.detail).slice(0, 160));
    assert(run.status === 400, '诊断要保留 HTTP 状态码，实际 ' + run.status);
    assert(/context_length_exceeded/.test(run.detail), '诊断 detail 要带上游 body，实际：' + run.detail.slice(0, 160));
  } finally {
    server.close();
  }
});

// 应用内 AI 以前只有一段静态上下文，模型想按名字找通道都做不到。这条验证工具循环真的
// 跑起来了：第一轮模型要求调 list_channels，客户端执行后把结果以 role:'tool' 回灌，
// 第二轮模型能引用工具返回的真实通道。
test('AI 工具循环：模型调用只读工具后能拿到真实回传', async (page) => {
  const http = require('http');
  const seen = [];
  let round = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (err) {}
      seen.push(payload);
      round += 1;
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      if (round === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'list_channels', arguments: JSON.stringify({ kind: 'all' }) }
              }]
            },
            finish_reason: 'tool_calls'
          }]
        }));
        return;
      }
      const toolMsg = (payload.messages || []).filter((m) => m.role === 'tool')[0] || {};
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '工具回传：' + String(toolMsg.content || '').slice(0, 160) } }]
      }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) await window.XHGCS_LOADER.ensure('ai');
      const channel = X.allChannels()[0];
      if (!channel) return { error: '没有可用通道' };
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint, model: state.ai.model,
        backend: state.ai.backend, stream: state.ai.stream, tools: state.ai.tools,
        messages: state.ai.messages.slice()
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      state.ai.stream = false;
      state.ai.tools = true;
      try {
        const result = await AI.send('现在有几个通道？');
        return { content: String(result && result.content || ''), channelId: channel.id };
      } finally {
        state.ai.useProxy = saved.useProxy;
        state.ai.endpoint = saved.endpoint;
        state.ai.model = saved.model;
        state.ai.backend = saved.backend;
        state.ai.stream = saved.stream;
        state.ai.tools = saved.tools;
        state.ai.messages = saved.messages;
      }
    }, port);
    assert(!run.error, run.error);
    assert(seen.length >= 2, '模型要求工具后必须再发一轮请求，实际只发了 ' + seen.length + ' 轮');
    const toolDefs = (seen[0].tools || []).map((t) => t && t.function && t.function.name);
    assert(toolDefs.indexOf('list_channels') >= 0,
      '第一轮请求必须带上只读工具定义，实际 tools=' + JSON.stringify(toolDefs));
    const toolMsg = (seen[1].messages || []).filter((m) => m.role === 'tool')[0];
    assert(toolMsg, '第二轮必须把工具结果以 role:tool 回灌');
    assert(toolMsg.tool_call_id === 'call_1', 'tool_call_id 要对上模型给的 id，实际 ' + toolMsg.tool_call_id);
    assert(String(toolMsg.content).indexOf(run.channelId) >= 0,
      '工具结果里要包含真实通道 id，实际 ' + String(toolMsg.content).slice(0, 120));
    assert(run.content.indexOf('工具回传：') === 0 && run.content.indexOf(run.channelId) >= 0,
      '最终回答要能引用工具返回的真实通道，实际 ' + run.content.slice(0, 200));
  } finally {
    server.close();
  }
});

// 内置模式（没配模型时的关键词表）已经删掉。这条钉住新行为：没配后端时如实报错，
// 不再用 mean(ch1) 之类的罐头模板假装生成。
test('AI：没配后端时如实报错，不再走本地关键词表', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const AI = window.XHGCS_AI;
    const state = X.state;
    if (window.XHGCS_LOADER && window.XHGCS_LOADER.ensure) await window.XHGCS_LOADER.ensure('ai');
    const saved = { backend: state.ai.backend, endpoint: state.ai.endpoint, model: state.ai.model, messages: state.ai.messages.slice() };
    state.ai.backend = 'local';
    state.ai.endpoint = '';
    state.ai.model = '';
    const scriptsBefore = (state.scripts || []).length;
    try {
      const sent = await AI.send('生成一个计算均值的脚本');
      let genError = '';
      try { await AI.generateScript('生成一个计算均值的脚本'); } catch (err) { genError = String((err && err.message) || err); }
      return {
        sendOk: Boolean(sent && sent.ok),
        sendContent: String((sent && sent.content) || ''),
        genError: genError,
        scriptsAdded: (state.scripts || []).length - scriptsBefore
      };
    } finally {
      state.ai.backend = saved.backend;
      state.ai.endpoint = saved.endpoint;
      state.ai.model = saved.model;
      state.ai.messages = saved.messages;
    }
  });
  assert(run.sendOk === false, '没配后端时 send 不该报成功');
  assert(/没有配置 AI 后端/.test(run.sendContent), 'send 要引导用户去配置 API，实际：' + run.sendContent);
  assert(/配置 API|Endpoint|DSH/.test(run.genError), '生成入口要给出可照做的错误，实际：' + run.genError);
  assert(run.scriptsAdded === 0, '没配后端时不该凭空生成脚本，实际新增 ' + run.scriptsAdded + ' 条');
});

test('AI：视图请求分类集中，普通表述与复杂图形走同一判定', async (page) => {
  const out = await page.evaluate(() => {
    const AI = window.XHGCS_AI;
    return {
      curve: AI.classifyViewPrompt('画个姿态曲线'),
      oscilloscope: AI.classifyViewPrompt('做个示波器'),
      compose: AI.classifyViewPrompt('把这三路叠起来'),
      complex: AI.classifyViewPrompt('生成一个雷达图'),
      explain: AI.classifyViewPrompt('解释一下这个视图怎么看')
    };
  });
  assert(out.curve.direct && out.curve.localFirst, '“画个姿态曲线”没有进入直达视图链路：' + JSON.stringify(out.curve));
  assert(out.oscilloscope.direct && out.oscilloscope.localFirst, '“做个示波器”没有进入直达视图链路：' + JSON.stringify(out.oscilloscope));
  assert(out.compose.direct && out.compose.localFirst, '“把这三路叠起来”没有进入直达视图链路：' + JSON.stringify(out.compose));
  assert(out.complex.direct && !out.complex.localFirst, '复杂图形没有标记为模型路径：' + JSON.stringify(out.complex));
  assert(!out.explain.direct, '解释类问题被误判成生成视图：' + JSON.stringify(out.explain));
});

// 回复原来一律 textContent 直出，生成的脚本、公式、JSON 全糊成一整块纯文本。
// 这条既验证 markdown 子集认得出代码块/列表/标题，也验证消息里的 HTML 只当文本——
// 富文本渲染最容易在这里引入注入面。
test('对话：回复渲染成代码块/列表/标题，且不解析消息里的 HTML', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const UI = window.XHGCS_AI_UI;
    const state = X.state;
    if (!UI || !UI.renderMessages) return { error: '没有 AI 界面模块' };
    const saved = state.ai.messages.slice();
    try {
      state.ai.messages = [{
        id: 'probe-markdown',
        role: 'assistant',
        time: Date.now(),
        content: [
          '## 均值脚本',
          '做了 **两件事**：',
          '- 取 `mean` 作为算子',
          '- 写入脚本通道',
          '```python',
          'def analyze(ctx):',
          '    return {"out1": 1}',
          '```',
          '危险内容 <img src=x onerror="window.__xss=1"> 结束'
        ].join('\n'),
        meta: { source: 'remote', model: 'probe' }
      }];
      UI.renderMessages();
      const box = document.getElementById('aiMessages');
      const code = box.querySelector('.ai-code');
      return {
        codeBlocks: box.querySelectorAll('.ai-code').length,
        listItems: box.querySelectorAll('.ai-md-list li').length,
        headings: box.querySelectorAll('.ai-md-h').length,
        bold: box.querySelectorAll('strong').length,
        inlineCode: box.querySelectorAll('.ai-inline-code').length,
        codeText: code ? code.querySelector('pre').textContent : '',
        hasCopy: Boolean(code && code.querySelector('.ai-code-copy')),
        rawFence: box.textContent.indexOf('```') >= 0,
        injectedImg: box.querySelectorAll('img').length,
        xss: Boolean(window.__xss),
        rawTagKeptAsText: box.textContent.indexOf('<img') >= 0
      };
    } finally {
      state.ai.messages = saved;
      UI.renderMessages();
    }
  });
  assert(!run.error, run.error);
  assert(run.codeBlocks === 1, '应识别出 1 个代码块，实际 ' + run.codeBlocks);
  assert(run.codeText.indexOf('def analyze(ctx):') === 0, '代码块内容应原样保留，实际 ' + JSON.stringify(run.codeText));
  assert(run.hasCopy, '代码块应带复制按钮（生成脚本的场景全靠它）');
  assert(run.listItems === 2, '两条列表项应渲染成 li，实际 ' + run.listItems);
  assert(run.headings === 1, '## 应渲染成标题，实际 ' + run.headings);
  assert(run.bold === 1, '**加粗** 应渲染成 strong，实际 ' + run.bold);
  assert(run.inlineCode === 1, '行内代码应渲染成 code，实际 ' + run.inlineCode);
  assert(!run.rawFence, '不该把 ``` 原样铺在气泡里');
  assert(run.injectedImg === 0 && !run.xss, '消息里的 HTML 必须只当文本，不能解析成元素');
  assert(run.rawTagKeptAsText, 'HTML 标签应以纯文本形式保留下来');
});

// 图页的核心不变量：多页之间互不影响 —— 每页记自己的图种与通道清单，
// 在某页上勾掉通道不能波及别的页（这正是「一个窗口开多张图」的意义）。
test('可视化：图页各自记住图种与通道，互不影响', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const state = X.state;
    if (!X.addPlot || !X.plotChannels) return { error: '没有图页接口' };
    const saved = JSON.parse(JSON.stringify({
      plots: state.plots, activePlot: state.activePlot, subview: state.subview
    }));
    const all = X.allChannels();
    if (all.length < 2) return { error: '至少需要两个通道' };
    try {
      const first = X.activePlot();
      X.updatePlot(first.id, { view: 'wave' });
      const second = X.addPlot('bar');
      state.activePlot = second.id;
      X.togglePlotChannel(second.id, all[1].id); // 勾掉第二个通道
      return {
        firstView: X.plotById(first.id).view,
        secondView: X.plotById(second.id).view,
        firstChannels: X.plotById(first.id).channels,
        secondChannels: X.plotById(second.id).channels,
        firstDrawn: X.plotChannels(X.plotById(first.id)).length,
        secondDrawn: X.plotChannels(X.plotById(second.id)).length,
        total: all.length
      };
    } finally {
      state.plots = saved.plots;
      state.activePlot = saved.activePlot;
      state.subview = saved.subview;
      X.persist();
    }
  });
  assert(!run.error, run.error);
  assert(run.firstView === 'wave' && run.secondView === 'bar',
    '两个图页应各自记住自己的图种，实际 ' + run.firstView + ' / ' + run.secondView);
  assert(Array.isArray(run.secondChannels), '勾选过的图页应固化出自己的通道清单');
  assert(run.secondDrawn === run.total - 1, '勾掉一个后该页应少画一个通道，实际 ' + run.secondDrawn);
  assert(run.firstChannels === null, '没动过的图页应保持「跟随全局」');
  assert(run.firstDrawn === run.total, '另一页不该被这一页的勾选影响，实际 ' + run.firstDrawn);
});

// 右键勾通道是这次的主交互：菜单得挂在 body 下（玻璃面板的 backdrop-filter 会成为
// fixed 定位的包含块，留在面板里会错位），并且 Esc 能关掉。
test('可视化：在图表上右键弹出当前图页的通道勾选菜单', async (page) => {
  await page.evaluate(() => {
    const nav = document.querySelector('[data-nav="visual"]');
    if (nav) nav.click();
  });
  // 等页面真的显示出来，否则量到的是折叠状态下的盒模型
  await page.waitForFunction(() => {
    const el = document.getElementById('view-wave');
    return el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 100;
  }, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  // 直接派发 contextmenu 而不是用鼠标点：坐标点选依赖布局时序（切页有一帧过渡），
  // 偶发会把右键落在图表外面。派发事件同样覆盖「处理函数 + 菜单渲染 + 贴边定位」。
  const opened = await page.evaluate(() => {
    const area = document.querySelector('.chart-wrap');
    if (!area) return false;
    const r = area.getBoundingClientRect();
    area.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    }));
    return true;
  });
  assert(opened, '找不到图表区域');
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const menu = document.querySelector('.plot-menu');
    if (!menu) return { open: false };
    return {
      open: true,
      onBody: menu.parentNode === document.body,
      rows: menu.querySelectorAll('.pm-row').length,
      actions: Array.from(menu.querySelectorAll('.pm-act')).map((b) => b.textContent).join('/'),
      head: String((menu.querySelector('.pm-head') || {}).textContent || ''),
      inside: (function () {
        const r = menu.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
      })()
    };
  });
  assert(info.open, '在图表上右键应弹出通道菜单');
  assert(info.onBody, '菜单必须挂在 body 下，否则玻璃面板会让 fixed 定位错位');
  assert(info.rows >= 1, '菜单里应列出通道，实际 ' + info.rows);
  assert(info.actions === '全选/全不选/跟随全局', '菜单应带三个批量动作，实际 ' + info.actions);
  assert(info.inside, '菜单不该超出窗口');
  assert(info.head.indexOf('显示哪些通道') >= 0, '菜单标题应说明这是在勾本页的通道：' + info.head);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const closed = await page.evaluate(() => !document.querySelector('.plot-menu'));
  assert(closed, 'Esc 应关掉菜单');
});

// 拖动平移走的是 clampChartX，而它在 state.t 还没起步时原来原样返回、完全不夹取，
// 于是随便一拖就能把视野滑到任意负时间，用户卡在一个「-3865s」的空画面上出不来。
test('可视化：时间轴没起步时也不会把视野拖到负时间', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const V = window.XHGCS_VIEWS;
    if (typeof V.clampChartX !== 'function') return { error: '没有 clampChartX' };
    const savedT = X.state.t;
    try {
      X.state.t = 0; // 刚清过数据 / 时间轴还没起步
      const atZero = V.clampChartX(-3865.6, -3865.45);
      X.state.t = 100;
      const negative = V.clampChartX(-50, -20);
      const beyond = V.clampChartX(500, 700);
      const inside = V.clampChartX(30, 50);
      return { atZero: atZero, negative: negative, beyond: beyond, inside: inside };
    } finally {
      X.state.t = savedT;
    }
  });
  assert(!run.error, run.error);
  assert(run.atZero.xStart >= 0, 't 为 0 时左边界也要夹在 0 之后，实际 ' + run.atZero.xStart);
  assert(run.negative.xStart === 0, '拖到负时间应夹回 0，实际 ' + run.negative.xStart);
  assert(run.negative.xEnd > run.negative.xStart, '夹取之后窗口宽度不能塌成 0');
  assert(run.beyond.xEnd <= 100 + 1e-6, '往后拖不该越过当前时间，实际 ' + run.beyond.xEnd);
  assert(run.inside.xStart === 30 && run.inside.xEnd === 50, '范围内的窗口不该被改动，实际 ' + JSON.stringify(run.inside));
});

// 曲线下方原来会铺一条 46px 高的渐变光带。它在 visible.forEach 里逐通道「先描线、再填光带」，
// 后画通道的光带会盖住先画通道的曲线，通道一多下半部分就糊成一片。
// 这里用画布像素量测：只留一条醒目颜色的通道，红色像素应该只剩 2px 描边那些。
test('可视化：曲线不再往下方铺渐变光带', async (page) => {
  await page.evaluate(() => {
    const nav = document.querySelector('[data-nav="visual"]');
    if (nav) nav.click();
  });
  await page.waitForTimeout(600);
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const V = window.XHGCS_VIEWS;
    const state = X.state;
    const ch = X.allChannels()[0];
    if (!ch || !V.renderChart) return { error: '缺少通道或绘图模块' };
    const plot = X.activePlot();
    if (!plot) return { error: '没有活动图页' };
    const saved = { color: ch.color, data: ch.data.slice(), t: state.t, mode: state.zoomMode, view: state.subview };
    try {
      // 只留这一条通道，并给它一个别人的颜色里不会出现的纯红
      X.setPlotChannels(plot.id, [ch.id]);
      ch.color = '#ff0000';
      ch.data = [];
      for (let i = 0; i < 400; i++) ch.data.push(60);
      state.t = 40;
      state.zoomMode = 'fit';
      V.resetChartView();
      V.renderChart();
      const canvas = document.getElementById('chart');
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i] - Math.max(img[i + 1], img[i + 2]) > 8) red++;
      }
      return { red: red, total: Math.round(img.length / 4) };
    } finally {
      ch.color = saved.color;
      ch.data = saved.data;
      state.t = saved.t;
      state.zoomMode = saved.mode;
      X.setPlotChannels(plot.id, null, { follow: true });
      V.renderChart();
    }
  });
  assert(!run.error, run.error);
  assert(run.red > 0, '曲线本身应该画出红色像素');
  // 只剩 2px 描边加数值标签时约一两千个像素；铺光带会把它推到三四万
  assert(run.red < run.total * 0.05,
    '曲线下方不该再有渐变光带：红色像素 ' + run.red + ' / ' + run.total
    + '（占比 ' + (run.red / run.total * 100).toFixed(1) + '%）');
});

// 脚本通道卡片上加右键菜单：最想知道的是「它是怎么来的、去画布上看一眼」。
// 菜单必须挂在 body 下（卡片自带 backdrop-filter，会变成 fixed 定位的包含块），
// 并且非图脚本的那一项要禁用且写明原因，而不是点了没反应。
test('多通道数据：脚本通道卡片右键能跳到分析画布', async (page) => {
  const setup = await page.evaluate(() => {
    const X = window.XHGCS;
    const V = window.XHGCS_VIEWS;
    const A = window.XHGCS_ANALYSIS;
    if (!A || !A.findScript) return { error: '没有 findScript' };
    window.__savedScripts = X.state.scripts.slice();
    window.__savedScriptChannels = X.state.scriptChannels.slice();
    window.__savedTab = X.state.channelTab;
    X.state.scripts = window.__savedScripts.concat([
      { id: 't-graph', name: '测试流程', type: 'graph', inputs: [], outputs: [], graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, autoRun: false, initialized: true } },
      { id: 't-fn', name: '测试算式', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'], outputs: [] }
    ]);
    X.addScriptChannel({ id: 'o1', label: '流程输出', unit: 'V', range: [0, 100], scriptId: 't-graph' });
    X.addScriptChannel({ id: 'o2', label: '算式输出', unit: 'V', range: [0, 100], scriptId: 't-fn' });
    V.switchChannelTab('script');
    return { found: Boolean(A.findScript('t-graph')), missing: A.findScript('不存在') === null };
  });
  assert(!setup.error, setup.error);
  assert(setup.found && setup.missing, 'findScript 应按 id 取到脚本、取不到时返回 null');

  const readMenu = (label) => page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.chl[data-channel-id]')).find((el) => el.textContent.indexOf(name) >= 0);
    if (!card) return { error: '找不到卡片 ' + name };
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 12 }));
    const menu = document.querySelector('.chl-menu');
    if (!menu) return { error: '没弹出菜单' };
    const rows = Array.from(menu.querySelectorAll('.pm-row')).map((b) => ({ text: b.textContent, disabled: b.disabled, title: b.title }));
    const out = { onBody: menu.parentNode === document.body, head: menu.querySelector('.pm-head').textContent, rows: rows };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return out;
  }, label);

  const graphMenu = await readMenu('流程输出');
  assert(!graphMenu.error, graphMenu.error);
  assert(graphMenu.onBody, '菜单必须挂在 body 下，否则卡片的 backdrop-filter 会让 fixed 定位错位');
  assert(graphMenu.head.indexOf('流程输出') >= 0, '菜单标题应带通道名：' + graphMenu.head);
  const graphOpen = graphMenu.rows.find((r) => r.text.indexOf('在分析画布中打开') >= 0);
  assert(graphOpen && !graphOpen.disabled, '图脚本产出的通道，「在分析画布中打开」应可用');

  const fnMenu = await readMenu('算式输出');
  assert(!fnMenu.error, fnMenu.error);
  const fnOpen = fnMenu.rows.find((r) => r.text.indexOf('在分析画布中打开') >= 0);
  assert(fnOpen, '函数脚本产出的通道也要有这一项');
  assert(fnOpen.disabled, '非节点流程的产出，这一项应禁用而不是假装能点');
  assert(fnOpen.title && fnOpen.title.length > 4, '禁用时要写明原因：' + JSON.stringify(fnOpen.title));

  await page.evaluate(() => {
    const X = window.XHGCS;
    X.state.scripts = window.__savedScripts;
    X.state.scriptChannels = window.__savedScriptChannels;
    window.XHGCS_VIEWS.switchChannelTab(window.__savedTab || 'raw');
    const m = document.querySelector('.chl-menu');
    if (m) m.parentNode.removeChild(m);
  });
});

// 画布这边新用户的三个坎：唯一那句操作说明被首屏示例图挡掉、点了「运行」不知道结果去哪、
// 右侧配置栏首屏收成 30px 竖缝。这条把修完之后的三个不变式钉住。
// 2026-10-28：用户要求「页面不许有解释性小字」，原用例断言 modal-head 里有导语，
// 现改为反向断言（导语必须为空），把这条产品规则钉住。
test('分析画布：无解释性导语、主操作只有一个、首屏不折叠配置栏', async (page) => {
  const info = await page.evaluate(() => {
    const X = window.XHGCS;
    const nav = document.querySelector('[data-nav="analysis"]');
    if (nav) nav.click();
    return {
      lead: String((document.querySelector('#view-analysis .modal-head p') || {}).textContent || ''),
      runButtons: document.querySelectorAll('#btnGraphRun').length,
      attachButtons: document.querySelectorAll('#btnGraphAttach').length,
      runIsPrimary: Boolean(document.querySelector('#btnGraphRun.primary')),
      hasSampleButton: Boolean(document.querySelector('#btnGraphSample')),
      samplePointerEvents: (function () {
        const b = document.querySelector('#btnGraphSample');
        if (!b) return null;
        return getComputedStyle(b).pointerEvents;
      })(),
      paletteTitles: Array.from(document.querySelectorAll('#graphPalette [data-add-node]')).map((b) => b.title)
    };
  });
  await page.waitForTimeout(400);
  const insp = await page.evaluate(() => ({
    collapsed: Boolean(document.querySelector('.graph-inspector.collapsed')),
    nodeCount: (window.XHGCS.state.analysis.canvas.nodes || []).length
  }));

  assert(info.lead === '',
    '页面不该再有解释性导语（用户要求「一律不要」），实际：' + info.lead);
  assert(info.runButtons === 1 && info.attachButtons === 0,
    '「运行」和「运行并附加」实现完全相同，工具栏只该留一个：run=' + info.runButtons + ' attach=' + info.attachButtons);
  assert(info.runIsPrimary, '运行是画布模式唯一的主操作，应该是主色按钮');
  assert(info.hasSampleButton, '空画布上要有「搭一个最小示例」');
  assert(info.samplePointerEvents === 'auto',
    '空状态整块是 pointer-events:none，里面的按钮必须单独放行，否则是个点不动的假按钮');
  assert(info.paletteTitles.every((t) => t.indexOf('：') > 0),
    '调色板每条都要在 title 里说清它产出什么：' + JSON.stringify(info.paletteTitles));
  assert(!insp.collapsed,
    '首屏不折叠右侧配置栏 —— 折起来连「选中节点或连线后在此配置。」也一起被隐藏，新用户找不到改参数的地方');
  assert(insp.nodeCount > 0, '首屏应有示例图可参照');

  // 挂在通道上的空图脚本：tick 每 500ms 重跑一次，没有护栏就会一直抛「画布为空」
  const tickGuard = await page.evaluate(async () => {
    const X = window.XHGCS;
    const A = window.XHGCS_ANALYSIS;
    const savedScripts = X.state.scripts.slice();
    const savedChannels = X.state.scriptChannels.slice();
    const savedError = X.state.analysis.lastError;
    try {
      X.state.scripts = savedScripts.concat([{
        id: 't-empty-graph', name: '空图', type: 'graph', inputs: [], outputs: [],
        graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, autoRun: false, initialized: true }
      }]);
      X.addScriptChannel({ id: 'eo', label: '空图输出', unit: '', range: [0, 100], scriptId: 't-empty-graph' });
      X.state.analysis.lastError = '';
      await A.tick();
      await new Promise((r) => setTimeout(r, 700));
      await A.tick();
      return { lastError: String(X.state.analysis.lastError || '') };
    } finally {
      X.state.scripts = savedScripts;
      X.state.scriptChannels = savedChannels;
      X.state.analysis.lastError = savedError;
    }
  });
  assert(tickGuard.lastError.indexOf('画布为空') < 0,
    '空图脚本挂上通道后不该每 500ms 抛一次「画布为空」：' + tickGuard.lastError);
});

// 脚本库的卡片点下去会发生什么，两类卡完全不同：节点流程换的是画布，算式换的是公式。
// 这条把「卡片自己说清落点」「点卡片即切画布」「切完标出当前画布」三件事钉住。
test('脚本库：点卡片即切画布，并标出「当前画布」', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const UI = window.XHGCS_ANALYSIS_UI;
    const nav = document.querySelector('[data-nav="analysis"]');
    if (nav) nav.click();
    const savedScripts = X.state.scripts.slice();
    const savedId = X.state.analysis.canvasScriptId;
    const savedMode = X.state.analysis.mode;
    const settle = () => new Promise((r) => setTimeout(r, 80));
    try {
      const channelId = (X.allChannels()[0] || {}).id || 'ch1';
      X.state.scripts = savedScripts.concat([
        {
          id: 't-card-graph', name: '卡片流程', type: 'graph', inputs: [], outputs: [],
          graph: {
            nodes: [{ id: 'n1', type: 'source', label: '输入通道', x: 60, y: 70, config: { channelId: channelId } }],
            edges: [], viewport: { x: 0, y: 0, zoom: 1 }, autoRun: false, initialized: true
          }
        },
        { id: 't-card-fn', name: '卡片算式', type: 'functions', formula: 'mean(' + channelId + ')', inputs: [channelId], outputs: [] }
      ]);
      UI.renderScripts();
      await settle();

      const cards = () => Array.from(document.querySelectorAll('#analysisScripts .script-item'));
      const graphCard = cards().find((el) => el.textContent.indexOf('卡片流程') >= 0);
      const fnCard = cards().find((el) => el.textContent.indexOf('卡片算式') >= 0);
      if (!graphCard || !fnCard) return { error: '卡片没渲染出来' };
      const graphPick = graphCard.title;
      const fnPick = fnCard.title;
      const fnText = fnCard.textContent;
      const loadButtons = document.querySelectorAll('#analysisScripts [data-script-load]').length;

      // 点动作区（不是按钮本身）不该触发整卡载入
      const actions = fnCard.querySelector('.actions');
      actions.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const afterActionsClick = X.state.analysis.canvasScriptId;

      // 点流程卡本体 = 切画布
      graphCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const marked = cards().filter((el) => el.classList.contains('is-current'));

      // 保存按钮的文案要跟着模式走（存的是画布还是算式随模式变）
      const saveBtn = document.getElementById('btnAnalysisSaveScript');
      const graphLabel = saveBtn.textContent;
      const quick = document.getElementById('btnQuickMode');
      if (quick) quick.click();
      await settle();
      const quickLabel = saveBtn.textContent;
      const back = document.getElementById('btnGraphMode');
      if (back) back.click();
      await settle();

      return {
        graphPick: graphPick,
        fnPick: fnPick,
        fnText: fnText,
        loadButtons: loadButtons,
        afterActionsClick: afterActionsClick,
        canvasScriptId: X.state.analysis.canvasScriptId,
        canvasNodes: (X.state.analysis.canvas.nodes || []).map((n) => n.id),
        currentCount: marked.length,
        currentBadge: marked.length ? String((marked[0].querySelector('.cur') || {}).textContent || '') : '',
        graphLabel: graphLabel,
        quickLabel: quickLabel
      };
    } finally {
      X.state.scripts = savedScripts;
      X.state.analysis.canvasScriptId = savedId;
      X.state.analysis.mode = savedMode;
      UI.renderScripts();
    }
  });
  assert(!run.error, run.error);
  assert(run.graphPick.indexOf('切到这张画布') >= 0, '流程卡要说清点它是切画布，实际：' + run.graphPick);
  assert(run.fnPick.indexOf('快速公式') >= 0, '算式卡要说清点它是载入公式，实际：' + run.fnPick);
  assert(run.fnText.indexOf('functions') < 0, '不该把 functions 这种类型名摊给用户看：' + run.fnText);
  assert(!/算式：|点卡片/.test(run.fnText), '卡片可见文本里不许出现「算式：」「点卡片」这类操作/描述句：' + run.fnText);
  assert(run.loadButtons === 0, '「载入」按钮应并入整卡点击，同一个动作不留两个入口');
  assert(!run.afterActionsClick, '点动作区不该触发整卡载入');
  assert(run.canvasScriptId === 't-card-graph', '点流程卡应把画布切到那一张，实际 ' + run.canvasScriptId);
  assert(run.canvasNodes.indexOf('n1') >= 0, '切过来之后画布上应该是那张图的节点：' + JSON.stringify(run.canvasNodes));
  assert(run.currentCount === 1 && run.currentBadge.indexOf('当前画布') >= 0,
    '切完要在卡片上标出「当前画布」，否则切换没有锚点');
  assert(run.graphLabel.indexOf('画布') >= 0 && run.quickLabel.indexOf('算式') >= 0,
    '保存按钮的文案要跟着模式走：画布模式=' + run.graphLabel + ' 快速模式=' + run.quickLabel);
});

// 用户反馈：一接上设备就满屏告警。根因是早期版本给**每个**通道凭空算一对预警阈值
// （协议通道按量程 ±2%，其余按 base±amp），而真实信号的范围接上设备之前谁也不知道 ——
// 传感器规格量程 0..65535，±2% 就是 1310.7 / 64224.3，正常读数全被判成越限。
// 这条把「默认不设、填了才生效、旧垃圾值会被清掉且不误伤手填值」三件事钉住。
test('告警：阈值默认不设，只有填过的通道才报警', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const ch = X.allChannels()[0];
    if (!ch) return { error: '没有可用通道' };
    const saved = { high: ch.warnHigh, low: ch.warnLow, data: ch.data.slice() };
    try {
      const P = window.XHGCS_PROTOCOL;
      // 传感器规格不许凭空造阈值（用户遇到的就是这个）；
      // 飞控规格里按工况显式定过的（电机怠速 PWM=1100 不能被判低值）必须留着
      const tele = P.channelTemplates({ protocol: 'WED', protocolId: 'wed-telemetry', channelCount: 20 });
      const fc = P.channelTemplates({ protocol: 'WED', protocolId: 'wed-fc', channelCount: 20 });

      // 没设阈值 = 不报警，哪怕值远远超出量程
      ch.warnHigh = null;
      ch.warnLow = null;
      ch.data = [ch.range[1] + 1e6];
      const unset = X.getAlarm(ch);

      // 设了才生效；严重线只在两侧都设时才存在
      ch.warnHigh = 10;
      ch.data = [20];
      const highOnly = X.getAlarm(ch);
      ch.data = [-20];
      const highOnlyLowSide = X.getAlarm(ch);
      // hi=10 / lo=0 → 预警带 10，严重线在带外 50%：高 15 / 低 -5
      ch.warnLow = 0;
      ch.data = [12];
      const bothWarn = X.getAlarm(ch);
      ch.data = [20];
      const bothDanger = X.getAlarm(ch);
      const t = X.alarmThresholds(ch);

      return {
        invented: tele.filter((item) => item.warnHigh != null || item.warnLow != null).map((item) => item.name),
        fcKept: fc.filter((item) => item.warnHigh != null || item.warnLow != null).length,
        unsetLevel: unset.level,
        highOnlyLevel: highOnly.level,
        highOnlyLowSideLevel: highOnlyLowSide.level,
        bothWarnLevel: bothWarn.level,
        bothDangerLevel: bothDanger.level,
        dangerHigh: t.dangerHigh,
        dangerLow: t.dangerLow
      };
    } finally {
      ch.warnHigh = saved.high;
      ch.warnLow = saved.low;
      ch.data = saved.data;
    }
  });
  assert(!run.error, run.error);
  assert(run.invented.length === 0,
    '传感器规格不该给通道凭空造阈值，实际这些带上了：' + JSON.stringify(run.invented));
  assert(run.fcKept > 0,
    '飞控规格里按工况显式定过的阈值必须留着（电机怠速 1100 不能被判低值）');
  assert(run.unsetLevel === 'ok', '没设阈值的通道不该报警，实际 ' + run.unsetLevel);
  assert(run.highOnlyLevel === 'warn', '只设了预警高、值越过它，应报预警，实际 ' + run.highOnlyLevel);
  assert(run.highOnlyLowSideLevel === 'ok',
    '只设了预警高时，低侧不该报警（严重低线只有两侧都设才存在），实际 ' + run.highOnlyLowSideLevel);
  assert(run.bothWarnLevel === 'warn' && run.bothDangerLevel === 'high',
    '两侧都设之后，越过预警带 50% 应升到严重：' + run.bothWarnLevel + ' / ' + run.bothDangerLevel);
  assert(run.dangerHigh === 15 && run.dangerLow === -5,
    '严重线应由预警带推出（带外 50%）：hi=10/lo=0 时应是 15 / -5，实际 ' + run.dangerHigh + ' / ' + run.dangerLow);

  // 迁移：只清「旧公式算出来的」和「卡在量程边界的」值，用户手填的不能误伤
  const mig = await page.evaluate(() => {
    const X = window.XHGCS;
    const ch = X.allChannels()[0];
    const span = ch.range[1] - ch.range[0];
    const saved = { high: ch.warnHigh, low: ch.warnLow, flag: X.state.thresholdsMigrated };
    try {
      ch.warnHigh = 123.456;                    // 像是手填的，不该被清
      ch.warnLow = ch.range[0] + span * 0.02;   // 旧协议公式
      X.state.thresholdsMigrated = false;
      const cleared = X.migrateFabricatedThresholds(X.state);
      const first = { high: ch.warnHigh, low: ch.warnLow };

      // 另一类残留：旧代码在阈值串位时把 warnHigh 直接补成量程上限
      // （原始 ADC 通道上就是 65535 = 0xFFFF 那个「无数据」哨兵值）
      ch.range = [0, 65535];
      ch.warnHigh = 65535;
      ch.warnLow = 1000;
      X.state.thresholdsMigrated = false;
      const cleared2 = X.migrateFabricatedThresholds(X.state);
      return {
        cleared: cleared, high: first.high, low: first.low,
        clearedEdge: cleared2, edgeHigh: ch.warnHigh, edgeLow: ch.warnLow
      };
    } finally {
      ch.warnHigh = saved.high;
      ch.warnLow = saved.low;
      X.state.thresholdsMigrated = saved.flag;
    }
  });
  assert(mig.cleared >= 1, '旧公式算出来的阈值应被迁移清掉，实际清了 ' + mig.cleared + ' 个');
  assert(mig.low === null, '被迁移清掉之后应该是「没设」，实际 ' + JSON.stringify(mig.low));
  assert(mig.high === 123.456, '用户手填的阈值不该被迁移误清，实际 ' + JSON.stringify(mig.high));
  assert(mig.clearedEdge >= 1 && mig.edgeHigh === null,
    '卡在量程上限的阈值（65535 哨兵）应被清掉，实际 ' + JSON.stringify(mig.edgeHigh));
  assert(mig.edgeLow === 1000, '量程内的阈值不该被边界规则误清，实际 ' + JSON.stringify(mig.edgeLow));
});

// 量程漂移过的那批旧值对不上任何公式，迁移清不掉 —— 得有一个一键回到「都没设」的出口
test('告警：可以一键清空全部阈值', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const chs = X.allChannels().slice(0, 3);
    if (chs.length < 2) return { error: '通道不够' };
    const saved = chs.map((ch) => ({ ch: ch, high: ch.warnHigh, low: ch.warnLow }));
    try {
      chs.forEach((ch) => { ch.warnHigh = 10; ch.warnLow = -10; });
      window.XHGCS_VIEWS.renderThresholdRows();
      const btn = document.getElementById('btnClearThresholds');
      if (!btn) return { error: '没有「全部清空」按钮' };
      const enabledBefore = !btn.disabled;
      // 挡掉确认框，只测清空本身
      const realConfirm = window.confirm;
      window.confirm = () => true;
      try { btn.click(); } finally { window.confirm = realConfirm; }
      const inputs = Array.from(document.querySelectorAll('#thresholdList input'));
      return {
        enabledBefore: enabledBefore,
        after: chs.map((ch) => [ch.warnHigh, ch.warnLow]),
        emptyInputs: inputs.filter((el) => el.value === '').length,
        totalInputs: inputs.length,
        disabledAfter: document.getElementById('btnClearThresholds').disabled
      };
    } finally {
      saved.forEach((item) => { item.ch.warnHigh = item.high; item.ch.warnLow = item.low; });
      window.XHGCS_VIEWS.renderThresholdRows();
    }
  });
  assert(!run.error, run.error);
  assert(run.enabledBefore, '有通道设了阈值时，按钮应可用');
  assert(run.after.every((pair) => pair[0] === null && pair[1] === null),
    '一键清空后每个通道都应该是「没设」，实际 ' + JSON.stringify(run.after));
  assert(run.emptyInputs === run.totalInputs, '阈值输入框应该全部变空');
  assert(run.disabledAfter, '没东西可清时按钮应禁用，不做假按钮');
});

// 回归套件一直是「全新浏览器 + 空 localStorage」，于是 loadState() 里
// `if (!raw) return state;` 那条提前返回把「本地存过配置」的代码路径整个跳过了 ——
// 一个只在有存档时才触发的 ReferenceError 就此躲过全部用例，装到用户机器上直接白屏。
// 这条专门补上那个场景：先往 localStorage 塞一份「旧版本存的」配置，再重载。
test('启动：本地存过配置时也能起来，并清掉旧版本凭空算出来的阈值', async (page) => {
  const seeded = await page.evaluate(() => {
    const key = 'xhgcs.pro.config.v1';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (err) { saved = {}; }
    const range = [0, 100];
    const span = range[1] - range[0];
    const channels = (saved.channels || []).length ? saved.channels.slice() : [{ id: 'ch1', name: '测试通道', unit: 'V', color: '#38bdf8' }];
    channels[0] = Object.assign({}, channels[0], {
      range: range,
      // 旧版本给协议通道算出来的那对值
      warnHigh: range[1] - span * 0.02,
      warnLow: range[0] + span * 0.02
    });
    localStorage.setItem(key, JSON.stringify(Object.assign({}, saved, {
      version: 1,
      channels: channels,
      // 标记现在会落盘，用例得自己归零，否则上一轮跑完的状态会让迁移被跳过
      thresholdsMigrated: 0,
      analysis: Object.assign({}, saved.analysis, {
        canvas: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, autoRun: false, initialized: false }
      })
    })));
    return localStorage.getItem(key).length > 0;
  });
  assert(seeded, '没能写入本地配置');
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const out = await page.evaluate(() => {
      const X = window.XHGCS;
      if (!X || !X.state) return { alive: false };
      const ch = X.allChannels()[0];
      return {
        alive: true,
        channels: X.allChannels().length,
        migrated: X.state.thresholdsMigrated,
        thresholds: ch ? [ch.warnHigh, ch.warnLow] : null,
        alarm: ch ? X.getAlarm(ch).level : null
      };
    });
    assert(out.alive, '本地存过配置时应用必须还能启动（window.XHGCS 未定义 = data.js 加载时就抛了）');
    assert(out.channels >= 1, '通道没从存档读回来：' + out.channels);
    assert(Number(out.migrated) >= 2, '载入存档时应跑一次阈值迁移（标记是版本号），实际 ' + JSON.stringify(out.migrated));
    assert(out.thresholds && out.thresholds[0] === null && out.thresholds[1] === null,
      '旧公式算出来的阈值应被清成 null，实际 ' + JSON.stringify(out.thresholds));
    assert(out.alarm === 'ok', '迁移之后不该还在报警，实际 ' + out.alarm);
  } finally {
    // 把页面还原成干净状态，别把这份存档留给后面的用例
    await page.evaluate(() => { localStorage.removeItem('xhgcs.pro.config.v1'); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 15000 });
    await page.waitForTimeout(1200);
  }
});

// 阈值第二轮对齐：判据从「值对不对得上旧公式」换成「协议有没有声明」。
// 旧代码是在每次 normalize 时按 *当时的量程* 补值的，量程又会被输入数据撑大，
// 于是残留值再也对不上任何公式（实测存档里就是 900 / 4000 / 3999.7 / 1310.7 这一批）。
// 换判据之后：协议没声明阈值的通道（WED 传感器/计数）一律清成「未设」，
// 协议声明过的（电机 1040/1480 那类飞控工况线）和用户自建通道必须原样保留 —— 这条钉住。
test('阈值对齐：协议没声明的通道清空，协议声明过的和用户自建的都保留', async (page) => {
  const key = 'xhgcs.pro.config.v1';
  const seeded = await page.evaluate((key) => {
    const profiles = window.XHGCS_PROTOCOL && window.XHGCS_PROTOCOL.WED_PROFILES;
    const fc = profiles && profiles['wed-fc'];
    const sensor = profiles && profiles['wed-telemetry'];
    if (!fc || !sensor || !Array.isArray(fc.channels) || !Array.isArray(sensor.channels)) return null;
    // 协议里自己声明了阈值的那条（电机 LF：1040 / 1480）
    const declaredIndex = fc.channels.findIndex((d) => Number.isFinite(d.warnLow) && Number.isFinite(d.warnHigh));
    const declared = fc.channels[declaredIndex];
    // 协议里没给阈值的传感器通道
    const silentIndex = sensor.channels.findIndex((d) => !Number.isFinite(d.warnLow) && !Number.isFinite(d.warnHigh));
    const silent = sensor.channels[silentIndex];
    if (declaredIndex < 0 || silentIndex < 0) return null;
    const channels = [
      // 量程漂过（65535 → 78642）之后就对不上旧公式的残留
      {
        id: 'ch1', name: silent.name, unit: '', color: '#38bdf8', range: [0, 78642],
        protocol: 'WED', protocolId: 'wed-telemetry', protocolIndex: silentIndex, warnHigh: 64224.3, warnLow: 1310.7
      },
      // 同一批残留里对得上「别的量程」的那些值
      {
        id: 'ch2', name: silent.name + '(副本)', unit: '', color: '#38bdf8', range: [0, 65535],
        protocol: 'WED', protocolId: 'wed-telemetry', protocolIndex: silentIndex, warnHigh: null, warnLow: 900
      },
      // 协议自己声明的阈值：必须留着
      {
        id: 'ch3', name: declared.name, unit: '', color: '#38bdf8', range: [1000, 1600],
        protocol: 'WED', protocolId: 'wed-fc', protocolIndex: declaredIndex,
        warnHigh: declared.warnHigh, warnLow: declared.warnLow
      },
      // 用户自己建的通道（对不上协议表）：判断不了来源，必须留着
      { id: 'ch4', name: '我自己的通道', unit: 'V', color: '#38bdf8', range: [0, 100], warnHigh: null, warnLow: 700 }
    ];
    const prev = JSON.parse(localStorage.getItem(key) || '{}') || {};
    localStorage.setItem(key, JSON.stringify(Object.assign({}, prev, {
      version: 1,
      channels: channels,
      activeEngine: 'engine-wed',
      // 用例自备标记：不继承上一轮跑出来的状态，否则对齐会被版本标记跳过
      thresholdsMigrated: 0,
      thresholdsAligned: 0,
      thresholdsArchived: [],
      protocol: { id: 'wed-telemetry', name: 'WED 遥测协议', protocol: 'WED', channelCount: 20, updatedAt: Date.now() }
    })));
    return { declaredName: declared.name, declaredHigh: declared.warnHigh, declaredLow: declared.warnLow };
  }, key);
  assert(seeded, '没能从协议表里找到做对照的通道');
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const out = await page.evaluate(() => {
      const X = window.XHGCS;
      const ch = (id) => X.state.channels.find((item) => item.id === id) || {};
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('xhgcs.pro.config.v1') || '{}') || {}; } catch (err) { saved = {}; }
      return {
        aligned: X.state.thresholdsAligned,
        savedAligned: saved.thresholdsAligned,
        archived: (X.state.thresholdsArchived || []).length,
        ch1: [ch('ch1').warnHigh, ch('ch1').warnLow],
        ch2: [ch('ch2').warnHigh, ch('ch2').warnLow],
        ch3: [ch('ch3').warnHigh, ch('ch3').warnLow],
        ch4: [ch('ch4').warnHigh, ch('ch4').warnLow]
      };
    });
    assert(out.ch1[0] === null && out.ch1[1] === null, '量程漂过、对不上公式的残留应被清掉，实际 ' + JSON.stringify(out.ch1));
    assert(out.ch2[1] === null, '对不上公式的残留应被清掉，实际 ' + JSON.stringify(out.ch2));
    assert(out.ch3[0] === seeded.declaredHigh && out.ch3[1] === seeded.declaredLow,
      '协议声明过的阈值必须保留（' + seeded.declaredName + '），实际 ' + JSON.stringify(out.ch3));
    assert(out.ch4[0] === null && out.ch4[1] === 700, '用户自建通道的值不能动，实际 ' + JSON.stringify(out.ch4));
    assert(Number(out.aligned) >= 1, '对齐之后要打版本标记，实际 ' + JSON.stringify(out.aligned));
    assert(Number(out.savedAligned) >= 1,
      '标记必须落盘 —— 否则用户之后手填的阈值会在下次启动被再清一遍，实际 ' + JSON.stringify(out.savedAligned));
    assert(out.archived >= 3, '清掉的值要留档，实际 ' + out.archived);
  } finally {
    await page.evaluate(() => { localStorage.removeItem('xhgcs.pro.config.v1'); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 15000 });
    await page.waitForTimeout(1200);
  }
});

// 导出的配置常被拷给别人或存进网盘，里面带着 API key 就等于把密钥一起送出去；
// 反过来，导入一份不含密钥的配置也不该把本机已经配好的 key 抹掉。
// 放在最后跑：importConfig 会替换整份状态，不适合再有别的用例依赖它。
test('配置导出：不带出 API 密钥，导入时也不会抹掉本机已配的密钥', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const state = X.state;
    state.ai.apiKey = 'sk-secret-ai';
    state.ai.tts.apiKey = 'sk-secret-tts';
    const exported = X.exportConfig();
    // 模拟「从文件读回来的那份配置」：导出已经把密钥清空，结构原样
    const imported = JSON.parse(JSON.stringify(exported));
    X.importConfig(imported);
    return {
      exportedAi: exported.ai.apiKey,
      exportedTts: exported.ai.tts.apiKey,
      afterAi: state.ai.apiKey,
      afterTts: state.ai.tts.apiKey
    };
  });
  assert(run.exportedAi === '', '导出不该带 AI apiKey，实际 ' + JSON.stringify(run.exportedAi));
  assert(run.exportedTts === '', '导出不该带 TTS apiKey，实际 ' + JSON.stringify(run.exportedTts));
  assert(run.afterAi === 'sk-secret-ai', '导入不含密钥的配置后本机 AI key 应保留，实际 ' + JSON.stringify(run.afterAi));
  assert(run.afterTts === 'sk-secret-tts', '导入后本机 TTS key 应保留，实际 ' + JSON.stringify(run.afterTts));
});

test('存储：AI 记忆去重压缩，墓碑 id 不会无限增长', async (page) => {
  const out = await page.evaluate(() => {
    const X = window.XHGCS;
    const s = X.state;
    const saved = {
      messages: s.ai.messages.slice(),
      tasks: s.ai.tasks.slice(),
      deletedScripts: s.mcp.deletedScripts.slice()
    };
    try {
      const same = '同一条回复'.repeat(100);
      s.ai.messages = Array.from({ length: 45 }, (_, i) => ({
        id: 'store-' + i,
        role: i % 2 ? 'assistant' : 'user',
        content: i === 44 ? same : '消息 ' + i,
        raw: i === 44 ? same : '',
        time: Date.now(),
        meta: { streaming: false, model: 'probe' }
      }));
      s.ai.tasks = Array.from({ length: 90 }, (_, i) => ({
        id: 'task-' + i, type: 'ai', name: '任务', status: 'success',
        message: 'ok', speech: 'ok', createdAt: 1, finishedAt: 2
      }));
      s.mcp.deletedScripts = Array.from({ length: 240 }, (_, i) => 'del-' + i);
      X.persist();
      const stored = JSON.parse(localStorage.getItem('xhgcs.pro.config.v1'));
      const last = stored.ai.messages[stored.ai.messages.length - 1];
      return {
        messages: stored.ai.messages.length,
        tasks: stored.ai.tasks.length,
        deleted: stored.mcp.deletedScripts.length,
        lastHasRaw: Object.prototype.hasOwnProperty.call(last, 'raw'),
        lastStreaming: Boolean(last.meta && last.meta.streaming)
      };
    } finally {
      s.ai.messages = saved.messages;
      s.ai.tasks = saved.tasks;
      s.mcp.deletedScripts = saved.deletedScripts;
      X.persist();
    }
  });
  assert(out.messages === 40, 'AI 消息持久化上限不对：' + out.messages);
  assert(out.tasks === 80, 'AI 子任务持久化上限不对：' + out.tasks);
  assert(out.deleted === 200, 'MCP 删除墓碑没有限长：' + out.deleted);
  assert(!out.lastHasRaw && !out.lastStreaming, 'AI 消息没有去掉重复 raw / 临时 streaming 字段：' + JSON.stringify(out));
});

// 原来 ensure() 无论成败都会写 loaded[name] = true，于是一次瞬时 404 就让对应功能
// 整场会话都起不来（ai-ui.js 没加载上 → AI 面板的输入框和发送键全都没有监听器），
// 而且所有失败路径都是 .catch(() => {})，界面上一个字都不说。
// 这条用例会故意触发一次脚本 404，所以收尾把自己造出来的控制台报错摘掉。
test('启动：模块加载失败不会被永久缓存为已加载', async (page, ctx) => {
  const before = ctx.errors.length;
  try {
    const run = await page.evaluate(async () => {
      const L = window.XHGCS_LOADER;
      if (!L || !L.groups) return { error: '没有 XHGCS_LOADER' };
      L.groups.__probe = { files: ['__no_such_module__.js'] };
      const first = await L.ensure('__probe');
      const cached = Boolean(L.loaded.__probe);
      const flagged = Boolean(L.failed.__probe);
      const second = await L.ensure('__probe');
      delete L.groups.__probe;
      delete L.loaded.__probe;
      delete L.failed.__probe;
      return { first: first, cached: cached, flagged: flagged, second: second };
    });
    assert(!run.error, run.error);
    assert(run.first === false, '不存在的模块必须返回 false，实际 ' + JSON.stringify(run.first));
    assert(run.cached === false, '加载失败不该被标记为已加载（原来无论成败都写 loaded）');
    assert(run.flagged === true, '加载失败应记进 failed，供界面说明原因');
    assert(run.second === false, '再次 ensure 应重试并仍然失败，而不是当成已加载直接返回');
  } finally {
    ctx.errors.length = before;
  }
});

// 上下文原来只印通道名（ch.name），而动作协议示例和 checkScriptSpec / findChannel 都要求
// 模型输出真实通道 id —— 模型被要求写 id、却只见过名字，只能靠猜，猜错还会被静默接受。
// 这条把「清单必须写成 id(名字…)」钉住。
test('AI 上下文：通道清单写的是 id(名字…)，不是只印名字', async (page) => {
  const run = await page.evaluate(() => {
    const X = window.XHGCS;
    const AI = window.XHGCS_AI;
    if (!AI || !AI.contextText) return { error: '没有 AI 模块' };
    const ch = (X.state.channels || [])[0];
    if (!ch) return { error: '没有可用通道' };
    const text = AI.contextText();
    const first = text.split('\n').filter((line) => line.indexOf('- 原始通道') === 0)[0] || '';
    return {
      hasTag: text.indexOf(ch.id + '(') >= 0,
      nameOnly: text.indexOf('- 原始通道: ' + ch.name + '=') >= 0,
      first: first.slice(0, 120)
    };
  });
  assert(!run.error, run.error);
  assert(run.hasTag, '上下文里的通道要写成 id(名字…) 形式，实际：' + run.first);
  assert(!run.nameOnly, '上下文不能只印名字，否则模型猜不出真实通道 id：' + run.first);
});

// 聊天动作路径原来零校验：inputs 编造成不存在的通道、formula 缺失就地编一个，都会被洗成
// 「已生成」。这条钉住「不合格就报错且不落库」，同时确认合法动作仍然照常落库。
test('AI 动作：编造通道 id 的脚本被拒绝且不落库，合法动作仍能落库', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const AI = window.XHGCS_AI;
    const state = X.state;
    if (!AI || !AI.executeReplyActions) return { error: '没有 AI 模块' };
    const ch = (state.channels || [])[0];
    if (!ch) return { error: '没有可用通道' };
    const savedScripts = (state.scripts || []).slice();
    const savedChannels = (state.scriptChannels || []).slice();
    const block = (obj) => '好的。\n```json\n' + JSON.stringify(obj) + '\n```';
    try {
      const bad = await AI.executeReplyActions(block({
        action: 'script', name: '编造通道脚本', type: 'functions',
        formula: 'mean(不存在的通道)', inputs: ['不存在的通道'], outputs: [{ label: '均值' }], run: false
      }));
      const good = await AI.executeReplyActions(block({
        action: 'script', name: '回归用脚本', type: 'functions',
        formula: 'mean(' + ch.id + ')', inputs: [ch.id], outputs: [{ label: '均值' }], run: false
      }));
      return {
        badOk: bad.length === 1 ? bad[0].ok : null,
        badMessage: bad.length ? String(bad[0].message || '') : '',
        createdByBad: (state.scripts || []).filter((s) => s.name === '编造通道脚本').length,
        goodOk: good.length === 1 ? good[0].ok : null,
        createdByGood: (state.scripts || []).filter((s) => s.name === '回归用脚本').length
      };
    } finally {
      state.scripts = savedScripts;
      state.scriptChannels = savedChannels;
    }
  });
  assert(!run.error, run.error);
  assert(run.badOk === false, '编造通道 id 的动作必须明确失败，实际 ok=' + JSON.stringify(run.badOk));
  assert(/不合格/.test(run.badMessage), '失败原因要说清是不合格，实际：' + run.badMessage);
  assert(run.createdByBad === 0, '不合格的脚本不该落库，实际建了 ' + run.createdByBad + ' 个');
  assert(run.goodOk === true, '合法动作应当照常成功，实际 ok=' + JSON.stringify(run.goodOk));
  assert(run.createdByGood === 1, '合法动作应当落库，实际 ' + run.createdByGood + ' 个');
});

// finish_reason 以前抓了却从不比较：被 max_tokens 截断的回复会连着半截 JSON 动作块当完整
// 答案交付，动作在 jsonBlocks 里解析失败后无声消失，用户只看到模型说「已生成」。
test('AI 对话：回复被 max_tokens 截断时明确提示，不假装完整', async (page) => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-XHGCS-Token'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({
        choices: [{ message: { content: '好的，我这就' }, finish_reason: 'length' }]
      }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const run = await page.evaluate(async (mockPort) => {
      const X = window.XHGCS;
      const AI = window.XHGCS_AI;
      const state = X.state;
      if (!AI || !AI.send) return { error: '没有 AI 模块' };
      const saved = {
        useProxy: state.ai.useProxy, endpoint: state.ai.endpoint,
        model: state.ai.model, backend: state.ai.backend,
        tts: (state.ai.tts || {}).enabled, messages: (state.ai.messages || []).slice()
      };
      state.ai.useProxy = false;
      state.ai.endpoint = 'http://127.0.0.1:' + mockPort;
      state.ai.model = 'probe-model';
      state.ai.backend = 'local';
      if (state.ai.tts) state.ai.tts.enabled = false;   // 别让冒烟里的语音队列掺进来
      try {
        const result = await AI.send('随便问一句');
        return { content: String((result && result.content) || '') };
      } finally {
        state.ai.useProxy = saved.useProxy;
        state.ai.endpoint = saved.endpoint;
        state.ai.model = saved.model;
        state.ai.backend = saved.backend;
        if (state.ai.tts) state.ai.tts.enabled = saved.tts;
        state.ai.messages = saved.messages;
      }
    }, port);
    assert(!run.error, run.error);
    assert(run.content.indexOf('Max Tokens') >= 0 && run.content.indexOf('截断') >= 0,
      '被截断的回复必须明说，实际正文：' + JSON.stringify(run.content));
    assert(run.content.indexOf('好的，我这就') >= 0, '原文仍要保留，不能被提示顶掉：' + JSON.stringify(run.content));
  } finally {
    server.close();
  }
});

// 会创建东西的动作原来在回复到达时就执行：模型正文里写一个 {"action":"script"}，脚本立刻落库，
// 没有预览也没有撤销。这条钉住「先出待确认卡片、点应用才落库」，以及校验没过的那条即使点了
// 也不会落库（它只是在卡片上说明原因）。
test('AI 动作确认：先出预告、点应用才落库，校验未过的不落库', async (page) => {
  const run = await page.evaluate(async () => {
    const X = window.XHGCS;
    const AI = window.XHGCS_AI;
    const state = X.state;
    if (!AI || !AI.buildPendingActions || !AI.applyPendingActions) return { error: '没有确认流程' };
    const ch = (state.channels || [])[0];
    if (!ch) return { error: '没有可用通道' };
    const savedScripts = (state.scripts || []).slice();
    const savedChannels = (state.scriptChannels || []).slice();
    const ids = [];
    const block = (obj) => '好的。\n```json\n' + JSON.stringify(obj) + '\n```';
    const count = (name) => (state.scripts || []).filter((s) => s.name === name).length;
    try {
      const built = AI.buildPendingActions(block({
        action: 'script', name: '待确认脚本', type: 'functions',
        formula: 'mean(' + ch.id + ')', inputs: [ch.id], outputs: [{ label: '均值' }], run: false
      }));
      const beforeApply = count('待确认脚本');
      const msg = X.addAiMessage('assistant', AI.composeAssistantText('好的。', { pending: built.pending }),
        { source: 'remote', pending: built.pending });
      ids.push(msg.id);
      const composed = String(msg.content || '');
      await AI.applyPendingActions(msg.id);

      const badBuilt = AI.buildPendingActions(block({
        action: 'script', name: '不该落库的脚本', type: 'functions',
        formula: 'mean(不存在的通道)', inputs: ['不存在的通道'], outputs: [{ label: 'x' }], run: false
      }));
      const badMsg = X.addAiMessage('assistant', '好的。', { source: 'remote', pending: badBuilt.pending });
      ids.push(badMsg.id);
      await AI.applyPendingActions(badMsg.id);

      return {
        pendingCount: built.pending.length,
        previewOk: built.pending.length ? Boolean(built.pending[0].preview && built.pending[0].preview.ok) : null,
        previewTitle: built.pending.length && built.pending[0].preview ? built.pending[0].preview.title : '',
        beforeApply: beforeApply,
        composed: composed,
        applied: count('待确认脚本'),
        appliedStatus: (msg.meta.pending[0] || {}).status,
        finalText: String(msg.content || ''),
        badPreviewOk: badBuilt.pending.length ? Boolean(badBuilt.pending[0].preview && badBuilt.pending[0].preview.ok) : null,
        badCreated: count('不该落库的脚本'),
        badStatus: (badMsg.meta.pending[0] || {}).status
      };
    } finally {
      state.ai.messages = (state.ai.messages || []).filter((m) => ids.indexOf(m.id) < 0);
      state.scripts = savedScripts;
      state.scriptChannels = savedChannels;
    }
  });
  assert(!run.error, run.error);
  assert(run.pendingCount === 1, '会创建东西的动作应先进入待确认，实际 ' + run.pendingCount);
  assert(run.previewOk === true, '合法动作的预告应标记为可用，标题：' + run.previewTitle);
  assert(run.beforeApply === 0, '还没点应用就不该落库，实际已建 ' + run.beforeApply + ' 个');
  assert(run.composed.indexOf('等你确认') >= 0, '正文要提示有待确认动作：' + JSON.stringify(run.composed));
  assert(run.applied === 1, '点了应用之后应当落库，实际 ' + run.applied + ' 个');
  assert(run.appliedStatus === 'applied', '卡片上该条应变成已应用，实际 ' + run.appliedStatus);
  assert(run.finalText.indexOf('✔') >= 0 && run.finalText.indexOf('等你确认') < 0,
    '应用之后正文要换成结果、不再提示待确认：' + JSON.stringify(run.finalText));
  assert(run.badPreviewOk === false, '编造通道的动作预告应当标记为不可用');
  assert(run.badCreated === 0, '校验未过的动作即使点了应用也不该落库，实际建了 ' + run.badCreated + ' 个');
  assert(run.badStatus === 'failed', '校验未过的那条应记成失败，实际 ' + run.badStatus);
});

// 排队的工具原来无论浏览器做没做成都回 ok:true，Agent 只能靠事后 snapshot 去猜。
// 这条把反馈闭环钉住：模拟浏览器同步并回传结果时应当拿到 applied:true；浏览器报失败时
// 要把原因带出来；根本没人应答时要明确 ok:false，而不是假装成功。
test('桥：排队的工具会等浏览器回传结果，没人应答时明确失败', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'queue-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(port),
      XHGCS_BRIDGE_TOKEN: token,
      XHGCS_ALLOWED_ORIGINS: '*loopback*',
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '2500'   // 用例里把等待压短，别真等 8 秒
    }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const mcp = (name, args) => call('POST', '/api/mcp', H, JSON.stringify({ name: name, arguments: args || {} }));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 扮演浏览器：轮询 /api/state 拿到排队项
  const findQueued = async (scriptName) => {
    for (let i = 0; i < 30; i += 1) {
      const state = JSON.parse((await call('POST', '/api/state', H, '{}')).body);
      const queue = (state.remote && state.remote.queue) || [];
      const hit = queue.find((row) => row.type === 'script_created' && row.script && row.script.name === scriptName);
      if (hit) return hit;
      await pause(100);
    }
    return null;
  };
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await pause(100);
    }
    assert(ready, '桥没能在超时内起来');

    // 1) 浏览器应答成功
    const inFlight = mcp('create_script', { name: '排队往返脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'] });
    const item = await findQueued('排队往返脚本');
    assert(item, '排队项应出现在 /api/state 的 remote.queue 里');
    assert(item.qid, '排队项要带自己的 qid（id 对 deleted/active 类是实体 id，不能当队列身份）');
    await call('POST', '/api/ack', H, JSON.stringify({ ids: [item.qid], results: [{ id: item.qid, ok: true, error: '' }] }));
    const done = JSON.parse((await inFlight).body).result;
    assert(done.ok === true, '有人应答时工具应当回 ok:true，实际 ' + JSON.stringify(done));
    assert(done.applied === true, '有人应答时应当回 applied:true，实际 ' + JSON.stringify(done));
    assert(done.script && done.script.name === '排队往返脚本', '返回体里仍要带上创建的脚本');

    // 2) 浏览器报失败：必须把原因带回来
    const inFlight2 = mcp('create_script', { name: '排队失败脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'] });
    const item2 = await findQueued('排队失败脚本');
    assert(item2, '第二个排队项应出现');
    await call('POST', '/api/ack', H, JSON.stringify({ ids: [item2.qid], results: [{ id: item2.qid, ok: false, error: '浏览器里抛了个错' }] }));
    const failed = JSON.parse((await inFlight2).body).result;
    assert(failed.ok === false, '浏览器报失败时工具必须回 ok:false，实际 ' + JSON.stringify(failed));
    assert(String(failed.error || '').indexOf('浏览器里抛了个错') >= 0,
      '失败原因要带出来，实际 ' + String(failed.error));

    // 3) 根本没人应答：超时必须明确失败
    const orphan = JSON.parse((await mcp('create_script', { name: '没人应答脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'] })).body).result;
    assert(orphan.ok === false, '没人应答时工具必须回 ok:false，实际 ' + JSON.stringify(orphan));
    assert(orphan.applied === false, '没人应答时 applied 应为 false，实际 ' + JSON.stringify(orphan));
    assert(String(orphan.error || '').indexOf('浏览器') >= 0,
      '没人应答时要说明是浏览器没回传，实际 ' + String(orphan.error));

    // 快照里要能看出还有多少排队项没被处理
    const snap = JSON.parse((await mcp('snapshot', {})).body).result.state;
    assert(snap.queue && snap.queue.pending >= 1,
      '快照应当报出未处理的排队项数量，实际 ' + JSON.stringify(snap.queue));
  } finally {
    child.kill();
  }
});

// 桥以前会给缺失字段编造默认值：formula 兜底 mean(ch1,ch2,ch3)、inputs 兜底 ['ch1','ch2','ch3']、
// 认不出的协议静默按 ASCII 建。结果是模型漏一个字段也能「创建成功」，产物却挂着一组不存在的
// 通道跑不出任何数据。这条把「缺什么就报什么、坏实体不落库」钉死。
test('桥：缺必填字段的产物调用明确失败，不再编造通道', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'strict-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(port),
      XHGCS_BRIDGE_TOKEN: token,
      XHGCS_ALLOWED_ORIGINS: '*loopback*',
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '500'
    }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const mcp = (name, args) => call('POST', '/api/mcp', H, JSON.stringify({ name: name, arguments: args || {} }));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await pause(100);
    }
    assert(ready, '桥没能在超时内起来');

    const cases = [
      { label: '脚本缺 inputs', tool: 'create_script', args: { name: '缺通道脚本', type: 'functions', formula: 'mean(ch1)' }, want: /inputs/ },
      { label: '脚本缺 formula', tool: 'create_script', args: { name: '缺公式脚本', type: 'functions', inputs: ['ch1'] }, want: /formula/ },
      { label: 'Python 脚本缺 code', tool: 'create_script', args: { name: '缺代码脚本', type: 'python', inputs: ['ch1'] }, want: /code/ },
      { label: '引擎缺协议', tool: 'create_engine', args: { name: '没协议引擎' }, want: /preset|protocol|协议/ },
      { label: '组件缺 inputs', tool: 'create_component', args: { name: '缺端口组件', kind: 'formula', outputs: [{ id: 'out1' }], config: { formula: 'mean(x1)' } }, want: /inputs/ },
      { label: '组件缺 outputs', tool: 'create_component', args: { name: '缺输出组件', kind: 'formula', inputs: [{ id: 'x1' }], config: { formula: 'mean(x1)' } }, want: /outputs/ },
      { label: '组件缺公式', tool: 'create_component', args: { name: '缺公式组件', kind: 'formula', inputs: [{ id: 'x1' }], outputs: [{ id: 'out1' }] }, want: /formula/ }
    ];
    for (const item of cases) {
      const res = await mcp(item.tool, item.args);
      const payload = JSON.parse(res.body);
      assert(payload.ok === false, item.label + ' 必须明确失败，实际 ' + res.body.slice(0, 220));
      assert(item.want.test(String(payload.error || '')), item.label + ' 的失败原因要说清楚，实际 ' + String(payload.error));
    }

    // 失败的创建不能把半成品塞进桥的服务端状态
    const scripts = JSON.parse((await mcp('list_scripts', {})).body).result;
    const scriptNames = (scripts.scripts || []).map((s) => s.name);
    ['缺通道脚本', '缺公式脚本', '缺代码脚本'].forEach((name) => {
      assert(scriptNames.indexOf(name) < 0, '不合格的脚本不该进脚本库：' + name);
    });
    const engines = JSON.parse((await mcp('list_engines', {})).body).result;
    assert((engines.engines || []).every((e) => e.name !== '没协议引擎'), '不合格的引擎不该进引擎列表');
    const comps = JSON.parse((await mcp('list_components', {})).body).result;
    assert((comps.components || []).every((c) => c.name !== '缺端口组件'), '不合格的组件不该进组件库');
  } finally {
    child.kill();
  }
});

// 产物语义在浏览器（ai-spec.js）和桥（bridge.mjs 的 TOOLS）各存一份 —— 没有打包器能把它们
// 绑在一起。这条用例在同一个测试里同时读两侧：描述符的必填字段必须与 MCP 工具 schema 的
// required 一致，且每条示例本身要包含这些字段。漂移会在这里被抓住，而不是等用户发现
// 「AI 说的不算数」。
test('AI 产物注册表：必填字段与 MCP 工具 schema 一致，示例自身完整', async (page) => {
  const registry = await page.evaluate(async () => {
    const L = window.XHGCS_LOADER;
    if (L && L.ensure) await L.ensure('ai');
    const S = window.XHGCS_AI_SPEC;
    if (!S) return null;
    return S.list().map((d) => {
      let exampleError = '';
      try {
        const spec = JSON.parse(d.example);
        if (!spec || typeof spec !== 'object') exampleError = '示例不是对象';
        else {
          const missing = (d.requiredFields || []).filter((key) => spec[key] == null);
          if (missing.length) exampleError = '示例缺少必填字段 ' + missing.join('/');
        }
      } catch (err) {
        exampleError = '示例不是合法 JSON：' + (err && err.message);
      }
      return {
        type: d.type,
        requiredFields: d.requiredFields || [],
        exampleError: exampleError
      };
    });
  });
  assert(registry, 'window.XHGCS_AI_SPEC 没加载出来');
  // 新增产物类型会让这个数字变；这里按“注册表 = 应用内 AI 能产出的全部产物”钉住，
  // 与 MCP 工具数量解耦（board 目前只在应用内生成，桥还没有对应写工具）。
  const EXPECTED_TYPES = ['script', 'graph', 'engine', 'component', 'view', 'board', 'board_patch'];
  assert(
    registry.length === EXPECTED_TYPES.length,
    '注册表应当有 ' + EXPECTED_TYPES.length + ' 类产物（' + EXPECTED_TYPES.join('/') + '），实际 ' + registry.length
  );
  registry.forEach((item) => {
    assert(EXPECTED_TYPES.indexOf(item.type) >= 0, '注册表出现未登记的类型：' + item.type);
  });

  const { spawn } = require('child_process');
  const http = require('http');
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port) }),
    stdio: ['pipe', 'pipe', 'ignore']
  });
  try {
    const tools = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('桥没有在 10 秒内回 tools/list')), 10000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch (err) { continue; }
          if (msg && msg.id === 2 && msg.result && msg.result.tools) {
            clearTimeout(timer);
            resolve(msg.result.tools);
            return;
          }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    });

    const TOOL_BY_TYPE = { script: 'create_script', graph: 'create_graph', engine: 'create_engine', component: 'create_component', view: 'create_view' };
    // board 没有对应 MCP 写工具：它只在应用内由 AI 生成（走确认闸门后由内核 composeBoard 落库）。
    // 这里仍然要求它有合法示例，只是跳过“与桥 schema 完全一致”的比对。
    const NO_MCP_TOOL = ['board', 'board_patch'];
    registry.forEach((item) => {
      assert(!item.exampleError, item.type + ' 的动作示例自身不完整：' + item.exampleError);
      if (NO_MCP_TOOL.indexOf(item.type) >= 0) return;
      const toolName = TOOL_BY_TYPE[item.type];
      const tool = tools.filter((row) => row.name === toolName)[0];
      assert(tool, '桥里缺少工具 ' + toolName + '（注册表有 ' + item.type + '）');
      const required = ((tool.inputSchema && tool.inputSchema.required) || []).slice().sort();
      const declared = item.requiredFields.slice().sort();
      assert(JSON.stringify(required) === JSON.stringify(declared),
        item.type + ' 的必填字段与 MCP 工具不一致：注册表 ' + declared.join('/') + ' vs 桥 ' + required.join('/'));
    });
  } finally {
    child.kill();
  }
});

// Agent 想按名字反查 id、想知道某条通道有没有设阈值，以前只能从 snapshot 的最新值里猜。
// 这条钉住 list_channels 的字段，以及 snapshot 里新加的采样率 / 录制状态。
test('桥：list_channels 能反查真实 id 与阈值，snapshot 带采样率与录制状态', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'channels-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port), XHGCS_BRIDGE_TOKEN: token, XHGCS_ALLOWED_ORIGINS: '*loopback*' }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const mcp = (name, args) => call('POST', '/api/mcp', H, JSON.stringify({ name: name, arguments: args || {} }));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await pause(100);
    }
    assert(ready, '桥没能在超时内起来');

    // 扮演浏览器推一份带阈值与录制状态的快照
    await call('POST', '/api/state', H, JSON.stringify({
      raw: [{ id: 'gyro-x', name: '陀螺 X', unit: 'deg/s', value: 1.5, points: 200, range: [-2000, 2000], warnLow: -500, warnHigh: 500 }],
      script: [{ id: 'script-out-1', name: '角速度均值', unit: 'deg/s', value: 1.2, points: 50, range: [-2000, 2000], warnLow: null, warnHigh: null, scriptId: 's1' }],
      serial: { rate: 200, frames: 12, errors: 0 },
      recording: { active: true, rows: 120, dropped: 0, enabled: true }
    }));

    const channels = JSON.parse((await mcp('list_channels', {})).body).result;
    assert(channels.count === 2, '应当列出 2 条通道，实际 ' + channels.count);
    const gyro = (channels.channels || []).filter((row) => row.id === 'gyro-x')[0];
    assert(gyro, 'list_channels 要能按 id 找回来：gyro-x');
    assert(gyro.name === '陀螺 X' && gyro.kind === 'raw', '通道名与来源不对：' + JSON.stringify(gyro));
    assert(gyro.warnLow === -500 && gyro.warnHigh === 500, '阈值要如实带出，实际 ' + gyro.warnLow + '/' + gyro.warnHigh);
    assert(Array.isArray(gyro.range) && gyro.range[0] === -2000 && gyro.range[1] === 2000, '量程要带出，实际 ' + JSON.stringify(gyro.range));
    const script = (channels.channels || []).filter((row) => row.id === 'script-out-1')[0];
    assert(script && script.kind === 'script' && script.scriptId === 's1', '脚本通道要标出来源与 scriptId');
    assert(script.warnLow === null && script.warnHigh === null, '未设阈值应当是 null，不是 0');

    const onlyScript = JSON.parse((await mcp('list_channels', { kind: 'script' })).body).result;
    assert(onlyScript.count === 1 && onlyScript.channels[0].id === 'script-out-1', 'kind=script 只该返回脚本通道');

    const snap = JSON.parse((await mcp('snapshot', {})).body).result.state;
    assert(snap.serial && snap.serial.rate === 200, 'snapshot 要带实测采样率，实际 ' + JSON.stringify(snap.serial && snap.serial.rate));
    assert(snap.recording && snap.recording.active === true && snap.recording.rows === 120,
      'snapshot 要带录制状态，实际 ' + JSON.stringify(snap.recording));
    assert(snap.raw[0].warnHigh === 500, 'snapshot 的通道也要带阈值');
  } finally {
    child.kill();
  }
});

// DSH 挂 MCP 时会再起一个 bridge.mjs --mcp-stdio。它不能绑 HTTP（端口归主桥），也不能
// 自己处理工具（它没有浏览器轮询，写工具会永远排队）。这条验证它确实是代理：tools/call
// 转发给正在跑的主桥，主桥不在时给出可照做的错误。
test('桥：--mcp-stdio 只当代理，工具调用转发给主桥', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'proxy-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const main = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port), XHGCS_BRIDGE_TOKEN: token, XHGCS_ALLOWED_ORIGINS: '*loopback*' }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  let proxy = null;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await pause(100);
    }
    assert(ready, '主桥没能在超时内起来');
    await call('POST', '/api/state', H, JSON.stringify({
      raw: [{ id: 'proxy-chan', name: '代理通道', unit: 'V', value: 3.3, points: 5, range: [0, 5], warnLow: null, warnHigh: null }]
    }));

    proxy = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs'), '--mcp-stdio'], {
      env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(port) }),
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const replies = new Map();
    let buffer = '';
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.id != null) replies.set(msg.id, msg);
        } catch (err) {}
      }
    });
    const send = (payload) => proxy.stdin.write(JSON.stringify(payload) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_channels', arguments: {} } });
    for (let i = 0; i < 60 && !replies.has(3); i += 1) await pause(100);
    assert(replies.get(2) && replies.get(2).result && replies.get(2).result.tools, '--mcp-stdio 也要能回 tools/list');
    const callResult = replies.get(3);
    assert(callResult && callResult.result, '--mcp-stdio 的 tools/call 没有回包');
    assert(callResult.result.isError === false, '代理调用不该失败：' + JSON.stringify(callResult.result).slice(0, 200));
    const payload = JSON.parse(callResult.result.content[0].text);
    assert((payload.channels || []).some((ch) => ch.id === 'proxy-chan'),
      '代理必须把调用转发给主桥：主桥里推进去的通道没有回传，实际 ' + callResult.result.content[0].text.slice(0, 200));
  } finally {
    if (proxy) proxy.kill();
    main.kill();
  }

  // 主桥不在时，代理要给出可照做的错误，而不是假装成功
  const emptyPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const lonely = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs'), '--mcp-stdio'], {
    env: Object.assign({}, process.env, { XHGCS_BRIDGE_PORT: String(emptyPort) }),
    stdio: ['pipe', 'pipe', 'ignore']
  });
  try {
    const replies = new Map();
    let buffer = '';
    lonely.stdout.setEncoding('utf8');
    lonely.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.id != null) replies.set(msg.id, msg);
        } catch (err) {}
      }
    });
    lonely.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'snapshot', arguments: {} } }) + '\n');
    for (let i = 0; i < 60 && !replies.has(9); i += 1) await pause(100);
    const result = replies.get(9);
    assert(result && result.result && result.result.isError === true, '主桥不在时调用必须明确失败');
    assert(/本地桥|MCP 桥|没有在/.test(String(result.result.content[0].text)),
      '失败原因要告诉用户先打开应用并启用桥，实际 ' + String(result.result.content[0].text).slice(0, 200));
  } finally {
    lonely.kill();
  }
});

// 上面那条用的是假浏览器，只覆盖桥这一侧。这条让真渲染层接上桥跑一遍完整回路：
// 工具入队 → 渲染层轮询执行 → 带结果 ack → 工具拿到 applied:true。
// 渲染侧的 applyRemote 如果没把结果带回去，这条会红。
test('桥：真渲染层跑完整回路，工具能拿到 applied:true', async (page) => {
  const http = require('http');
  const { spawn } = require('child_process');
  const token = 'loop-token-' + Date.now().toString(36);
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(port),
      XHGCS_BRIDGE_TOKEN: token,
      XHGCS_ALLOWED_ORIGINS: '*loopback*',
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '6000'   // 渲染层每 1.5s 同步一次，留够余量
    }),
    stdio: ['pipe', 'ignore', 'ignore']
  });
  const call = (method, target, headers, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: method,
      headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call('GET', '/api/health')).status === 200; } catch (err) {}
      if (!ready) await pause(100);
    }
    assert(ready, '桥没能在超时内起来');

    const setup = await page.evaluate(async (bridgePort) => {
      const X = window.XHGCS;
      const state = X.state;
      // bridge.js 是按需加载的（boot.js 只在 MCP 已开启时才急切拉它），先显式加载
      const L = window.XHGCS_LOADER;
      if (L && L.ensure) { try { await L.ensure('bridge'); } catch (err) {} }
      const B = window.XHGCS_BRIDGE;
      if (!B || !B.start) return { error: '没有桥模块' };
      window.__probeSavedMcp = { enabled: state.mcp.enabled, endpoint: state.mcp.endpoint };
      if (B.stop) B.stop();
      state.mcp.endpoint = 'http://127.0.0.1:' + bridgePort;
      B.start();
      for (let i = 0; i < 50; i += 1) {
        if (state.mcp.connected) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { connected: Boolean(state.mcp.connected) };
    }, port);
    assert(!setup.error, setup.error);
    assert(setup.connected, '渲染层没能连上测试桥');

    const made = JSON.parse((await call('POST', '/api/mcp',
      { 'Content-Type': 'application/json', 'X-XHGCS-Token': token },
      JSON.stringify({ name: 'create_script', arguments: { name: '回路脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'] } })
    )).body).result;
    assert(made.ok === true, '渲染层接上时工具应当回 ok:true，实际 ' + JSON.stringify(made));
    assert(made.applied === true, '渲染层真的应用了才该是 applied:true，实际 ' + JSON.stringify(made));

    // 渲染层这边也要能看见那个脚本（证明确实执行了，不是只回了个 ok）
    const seen = await page.evaluate(() => (window.XHGCS.state.scripts || []).some((s) => s.name === '回路脚本'));
    assert(seen, '渲染层的脚本库里应当出现这个脚本');
  } finally {
    await page.evaluate(() => {
      const X = window.XHGCS;
      const B = window.XHGCS_BRIDGE;
      const saved = window.__probeSavedMcp || {};
      if (B && B.stop) B.stop();
      X.state.scripts = (X.state.scripts || []).filter((s) => s.name !== '回路脚本');
      X.state.mcp.endpoint = saved.endpoint || X.state.mcp.endpoint;
      if (saved.enabled && B && B.start) B.start();
      delete window.__probeSavedMcp;
    }).catch(() => {});
    child.kill();
  }
});

(async () => {
  const chrome = findChrome();
  const server = createStaticServer(ROOT);
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const ctx = { errors: [] };
  page.on('console', (m) => { if (m.type() === 'error') ctx.errors.push(m.text()); });
  page.on('pageerror', (e) => ctx.errors.push('pageerror: ' + e.message));
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 15000 });
  await page.waitForTimeout(1200);

  let failed = 0;
  for (const item of cases) {
    if (filter && item.name.indexOf(filter) < 0) continue;
    try {
      await item.fn(page, ctx);
      console.log('  ok   ' + item.name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + item.name + ' —— ' + err.message);
    }
  }
  const total = cases.filter((c) => !filter || c.name.indexOf(filter) >= 0).length;
  console.log(failed ? '\n' + failed + '/' + total + ' 个用例失败' : '\n' + total + ' 个用例全部通过');
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('跑不起来：' + err.message);
  process.exit(2);
});
