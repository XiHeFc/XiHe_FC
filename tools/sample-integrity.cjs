'use strict';
// 在真实 Chromium 中验证采样可信度；当前 UI 与保留的频谱引擎分别验收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createStaticServer } = require('../electron/static-server');
const ROOT = path.resolve(__dirname, '..');

function findChrome() {
  if (process.env.XHGCS_CHROME) return process.env.XHGCS_CHROME;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  return fs.readdirSync(base).filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(n => path.join(base, n, 'chrome-win64', 'chrome.exe')).find(fs.existsSync);
}

(async () => {
  const server = createStaticServer(ROOT);
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  let passed = 0;
  try {
    const cdp = process.argv.find(a => a.startsWith('--cdp='));
    browser = cdp ? await chromium.connectOverCDP('http://127.0.0.1:' + cdp.slice(6))
      : await chromium.launch({ executablePath: findChrome(), headless: true });
    const page = cdp ? browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html'))
      : await browser.newPage({ viewport: { width: 1600, height: 900 } });
    assert(page, '没有找到装机版主页面');
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error' || (msg.type() === 'warning' && /drawScope:|updateValues:/.test(msg.text()))) errors.push(msg.text()); });
    // 记录实际画布路径，证明缺口处没有从一侧直连到另一侧。
    await page.addInitScript(() => {
      const proto = CanvasRenderingContext2D.prototype;
      const begin = proto.beginPath, move = proto.moveTo, line = proto.lineTo, stroke = proto.stroke;
      proto.beginPath = function () { this.__samplePath = []; return begin.apply(this, arguments); };
      proto.moveTo = function (x, y) { if (this.__samplePath) this.__samplePath.push(['M', x, y]); return move.apply(this, arguments); };
      proto.lineTo = function (x, y) { if (this.__samplePath) this.__samplePath.push(['L', x, y]); return line.apply(this, arguments); };
      proto.stroke = function () {
        if (this.canvas.id === 'scope' && Math.abs(this.lineWidth - 1.6) < .01 && this.__samplePath && this.__samplePath.length) {
          window.__samplePaths = (window.__samplePaths || []).slice(-39);
          window.__samplePaths.push(this.__samplePath.slice());
        }
        return stroke.apply(this, arguments);
      };
    });
    if (cdp) await page.reload();
    else await page.goto('http://127.0.0.1:' + server.address().port + '/index.html');
    await page.waitForFunction(() => window.XHGCS && document.getElementById('scope'));
    await page.evaluate(() => { XHGCS.state.playing = false; XHGCS.state.simulation.enabled = false; XHGCS.resetData(); });

    const calibrated = await page.evaluate(() => {
      const X = XHGCS, a = X.state.channels[0], b = X.state.channels[1];
      Object.assign(a, { scale: 2, offset: 1, range: [-10, 10], freezeRange: true });
      X.injectRealValues({ [a.id]: 3, [b.id]: 1 }, { t: 10 });
      X.injectRealValues({ [b.id]: 2 }, { t: 10.01 });
      X.injectRealValues({ [b.id]: 3 }, { t: 10.04 });
      X.injectRealValues({ [a.id]: 100, [b.id]: 4 }, { t: 12.04 });
      return { values: a.data.slice(), times: X.sampleTimeline(a).times.slice(),
        valid: X.sampleTimeline(a).valid.slice(), outOfRange: X.sampleTimeline(a).outOfRange.slice(), wall: X.sampleTimeline(a).walls.slice(), id: a.id };
    });
    assert.deepEqual(calibrated.values, [7, 7, 7, 201]);
    assert.deepEqual(calibrated.valid, [true, false, false, true]);
    assert.deepEqual(calibrated.outOfRange, [false, false, false, true]);
    assert.deepEqual(calibrated.times, [10, 10.01, 10.04, 12.04]);
    assert(calibrated.wall.every(Number.isFinite));
    console.log('PASS 标定与缺帧：7 → 保持 7 → 保持 7；越量程峰值 201 完整保留'); passed++;

    const retained = await page.evaluate(() => {
      const X = XHGCS, ch = X.state.channels[0];
      X.setIntervalMs(500);
      return { times: X.sampleTimeline(ch).times.slice(), index: X.sampleIndex(ch, 10.035) };
    });
    assert.deepEqual(retained.times, calibrated.times);
    assert.equal(retained.index, 2);
    console.log('PASS 历史时间：修改显示采样间隔不改变已采集样本的时间'); passed++;

    // 当前新壳：连续段两侧各放两点，中间明确留出 8 秒断流。
    const cursor = await page.evaluate(() => {
      const X = XHGCS, a = X.state.channels[0], b = X.state.channels[1];
      X.resetData();
      Object.assign(a, { scale: 1, offset: 0, range: [0, 100] });
      [20, 20.01, 28, 28.01].forEach((t, i) => X.injectRealValues({ [a.id]: 10 + i, [b.id]: 20 + i }, { t }));
      const rect = document.getElementById('scope').getBoundingClientRect();
      const win = Number(document.querySelector('.seg button[data-win].active')?.dataset.win) || 60;
      window.__samplePaths = [];
      return { id: a.id, x: rect.x + rect.width * (24 - (28.01 - win)) / win, y: rect.y + 40 };
    });
    await page.mouse.move(cursor.x, cursor.y);
    await page.waitForTimeout(350);
    const display = await page.locator('[data-lval="' + cursor.id + '"]').innerText();
    assert(display.includes('—'), '断流游标仍显示了插值：' + display);
    const paths = await page.evaluate(() => window.__samplePaths || []);
    assert(paths.some(p => p.length >= 4 && p.filter(cmd => cmd[0] === 'M').length >= 2), '实际波形路径没有在断流处断开：' + JSON.stringify(paths.slice(-4)));
    console.log('PASS 当前 UI：8 秒断流处无插值读数，真实画布路径分段'); passed++;
    await page.mouse.move(0, 0);

    await page.evaluate(() => {
      const X = XHGCS, ch = X.state.channels[0];
      X.resetData();
      for (let i = 0; i < 100; i++) {
        const t = 40 + i / 200;
        X.injectRealValues({ [ch.id]: 3 * t + 1 }, { t });
      }
      document.querySelector('#ppList [data-pp]').click();
      const checks = Array.from(document.querySelectorAll('#anInputs input'));
      checks.forEach(c => { c.checked = c.value === ch.id; });
      checks[0].dispatchEvent(new Event('change', { bubbles: true }));
      const formula = document.getElementById('anFormula');
      formula.value = 'slope(ch1, 5)';
      formula.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    assert.equal(Number(await page.locator('#anPreviewValue').innerText()), 3, '当前后处理斜率未按真实时间计算');
    await page.evaluate(() => { const X = XHGCS; X.injectRealValues({ [X.state.channels[1].id]: 2 }, { t: 40.5 }); });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#anPreviewValue').innerText(), '--');
    assert((await page.locator('#anPreviewStats').innerText()).includes('缺帧'));
    console.log('PASS 当前后处理：200 Hz 下斜率检出 3，缺帧窗口明确停止试算'); passed++;

    const bounded = await page.evaluate(() => {
      const X = XHGCS, ch = X.state.channels[0];
      X.resetData(); X.state.historyPoints = 4;
      for (let i = 0; i < 2100; i++) X.pushSample(ch, i, { t: i / 200, wall: 1700000000000 + i * 5, valid: i % 2 === 0 });
      const m = X.sampleTimeline(ch);
      const aligned = m.times.length === ch.data.length && m.walls.length === ch.data.length && m.valid.length === ch.data.length
        && ch.data.every((v, i) => m.times[i] === v / 200 && m.valid[i] === (v % 2 === 0));
      X.setHistoryHours(1);
      X.state.historyPoints = 4; X.setIntervalMs(3600000);
      const trim = ch.data.length === 2 && X.sampleTimeline(ch).times.length === 2;
      X.resetData();
      X.injectRealValues({ [ch.id]: 2 }, { t: 10 });
      X.injectRealValues({ [ch.id]: 3 }, { t: .1 });
      const clockReset = ch.data.length === 1 && X.sampleTimeline(ch).times[0] === .1;
      X.resetData();
      X.pushSample(ch, 123, { t: .5, wall: 1700000000000 });
      X.persist();
      const saved = JSON.parse(localStorage.getItem('xhgcs.pro.config.v1'));
      return { aligned, trim, clockReset, afterReset: X.sampleTimeline(ch).times.slice(),
        savedSample: Object.keys(saved.channels[0]).filter(k => /times|walls|valid|data/.test(k)) };
    });
    assert(bounded.aligned && bounded.trim && bounded.clockReset);
    assert.deepEqual(bounded.afterReset, [.5]);
    assert.deepEqual(bounded.savedSample, []);
    console.log('PASS 裁剪与重置：值/时间/有效性保持对齐，采样历史不进入配置'); passed++;

    // 当前壳不加载旧分析模块；直接加载保留的引擎验证其数值契约。
    await page.addScriptTag({ url: '/assets/js/analysis.js' });
    await page.addScriptTag({ url: '/assets/js/graph-engine.js' });
    async function fftProbe(kind) {
      return page.evaluate(async kind => {
        const X = XHGCS, G = XHGCS_GRAPH, ch = X.state.channels[0];
        X.resetData(); X.state.historyPoints = 10000;
        for (let i = 0; i < 256; i++) {
          let t = i / 200;
          if (kind === 'jitter') t += .15 * Math.sin(i * 2 * Math.PI / 17) / 200;
          if (kind === 'gap' && i >= 220) t += 2;
          if (kind === 'duplicate' && i === 220) t = 219 / 200;
          X.pushSample(ch, Math.sin(2 * Math.PI * 25 * t), { t, valid: !(kind === 'missing' && i === 220) });
        }
        if (kind === 'legacy') ch.data = ch.data.slice();
        const src = G.makeNode('source', {}, { channelId: ch.id });
        const fft = G.makeNode('fft', {}, { sampleRate: kind === 'legacy' ? 200 : 100, windowSize: 128 });
        const out = G.makeNode('output', {}, { label: '主频' });
        const graph = { nodes: [src, fft, out], edges: [
          { source: src.id, sourceHandle: 'out', target: fft.id, targetHandle: 'in1' },
          { source: fft.id, sourceHandle: 'freq', target: out.id, targetHandle: 'in1' }
        ] };
        try { return await G.runGraph(graph, { attach: false, persist: false }); }
        catch (err) { return { error: err.message }; }
      }, kind);
    }
    const uniform = await fftProbe('uniform');
    assert(!uniform.error, uniform.error);
    assert(Math.abs(uniform.values['主频'] - 25) < 1e-6);
    assert(Math.abs(uniform.timing[0].sampleRate - 200) < 1e-6);
    console.log('PASS 频谱：配置 100 Hz、真实 200 Hz，25 Hz 正弦仍检出 25 Hz'); passed++;
    const jitter = await fftProbe('jitter');
    assert(!jitter.error, jitter.error);
    assert(jitter.timing[0].resampled);
    assert(Math.abs(jitter.values['主频'] - 25) < .15);
    console.log('PASS 频谱抖动：连续窗口重采样，主频误差 ' + Math.abs(jitter.values['主频'] - 25).toFixed(6) + ' Hz'); passed++;
    for (const kind of ['gap', 'missing', 'duplicate']) {
      const invalid = await fftProbe(kind);
      assert(invalid.error, kind + ' 被误当有效频谱');
    }
    const legacy = await fftProbe('legacy');
    assert(legacy.notes.some(n => n.includes('无完整时间戳')));
    console.log('PASS 频谱质量：拒绝断流/缺失/重复时间；无时间戳时明确提示配置采样率'); passed++;
    assert.deepEqual(errors, [], '控制台错误：' + errors.join(' | '));
    console.log(passed + ' 项采样可信度验证全部通过');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
