'use strict';
// 视图插件验收器：把一段视图代码丢进真实 Chromium 里挂载跑几帧，打印自检报告。
//   node tools/view-check.js --builtin=bar            验内置模板
//   node tools/view-check.js --code-file=tmp-view.js 验文件里的插件代码
//   node tools/view-check.js --code="({...})" --shot=out.png
//   node tools/view-check.js --all                   内置模板 + 全部已保存自定义视图
// 自检逻辑本体在浏览器里（assets/js/view-verify.js），这里只负责起页面、取结果、给退出码。
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

const args = process.argv.slice(2);
const argOf = (name) => (args.find((a) => a.startsWith('--' + name + '=')) || '').split('=').slice(1).join('=');
const builtin = argOf('builtin');
const codeFile = argOf('code-file');
const inlineCode = argOf('code');
const shotPath = argOf('shot');
const frames = Math.max(1, Math.min(40, Number(argOf('frames')) || 6));
const all = args.includes('--all');
const asJson = args.includes('--json');

const targets = [];
if (builtin) targets.push({ name: '内置模板 ' + builtin, code: null, prompt: builtin });
if (codeFile) targets.push({ name: path.basename(codeFile), code: fs.readFileSync(path.resolve(ROOT, codeFile), 'utf8') });
if (inlineCode) targets.push({ name: 'inline', code: inlineCode });
if (!targets.length) targets.push({ name: '内置模板 bar', code: null, prompt: '条形图' });

(async () => {
  const server = createStaticServer(ROOT);
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS_VIEW_VERIFY), null, { timeout: 20000 });
  await page.waitForTimeout(800);

  if (all) {
    ['条形图', '占比'].forEach((prompt) => targets.push({ name: '内置模板 ' + prompt, code: null, prompt: prompt }));
    const saved = await page.evaluate(() => (window.XHGCS.state.views || []).map((v) => ({ name: v.name, code: v.code })));
    saved.forEach((v) => targets.push({ name: '自定义视图 ' + v.name, code: v.code }));
  }

  let failed = 0;
  for (const target of targets) {
    const code = target.code || await page.evaluate((p) => window.XHGCS_VIEWS.fallbackTemplate(p).code, target.prompt);
    const report = await page.evaluate(
      (payload) => window.XHGCS_VIEW_VERIFY.verify(payload.code, { frames: payload.frames, shot: payload.shot }),
      { code: code, frames: frames, shot: Boolean(shotPath) }
    );
    if (asJson) {
      console.log(JSON.stringify({ target: target.name, ok: report.ok, score: report.score, errors: report.errors, warnings: report.warnings, metrics: report.metrics }, null, 2));
    } else {
      console.log('== ' + target.name + ' ==');
      console.log(await page.evaluate((r) => window.XHGCS_VIEW_VERIFY.format(r), report));
    }
    if (!report.ok) failed++;
    if (shotPath && report.shot) {
      const file = path.resolve(ROOT, shotPath);
      fs.writeFileSync(file, Buffer.from(String(report.shot).split(',')[1], 'base64'));
      console.log('  截图：' + path.relative(ROOT, file));
    }
  }
  if (consoleErrors.length) console.log('页面控制台报错：' + consoleErrors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  console.log(failed ? '\n' + failed + '/' + targets.length + ' 个视图未通过自检' : '\n' + targets.length + ' 个视图全部通过自检');
  process.exit(failed || consoleErrors.length ? 1 : 0);
})().catch((err) => {
  console.log('跑不起来：' + (err && err.message || err));
  process.exit(2);
});
