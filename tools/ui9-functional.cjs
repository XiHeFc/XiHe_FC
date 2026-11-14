'use strict';
// ui9 功能测试项目：按真实使用路径驱动界面（不测源码），逐项 PASS/FAIL。
// 运行：node tools/ui9-functional.cjs
// 自带静态服务 + Chromium（与 ui-contract 同款启动方式），不写仓库文件。
const fs = require('fs');
const path = require('path');
const { createStaticServer } = require('../electron/static-server');
const { chromium: pwChromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { passed++; console.log('[PASS] ' + name); }
function fail(name, detail) {
  failed++;
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('[FAIL] ' + name + (detail ? ' — ' + detail : ''));
}
function check(name, cond, detail) { if (cond) pass(name); else fail(name, detail); }

async function canvasDrawn(page, sel) {
  return page.evaluate((s) => {
    const cv = document.querySelector(s);
    if (!cv) return false;
    const r = cv.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;
    const ctx = cv.getContext('2d');
    const x0 = Math.round(r.width * 0.25), y0 = Math.round(r.height * 0.15);
    const w = Math.max(8, Math.round(r.width * 0.5)), h = Math.max(8, Math.round(r.height * 0.6));
    const img = ctx.getImageData(x0, y0, w, h).data;
    let base = [img[0], img[1], img[2]];
    let diff = 0;
    for (let i = 0; i < img.length; i += 16) {
      if (Math.abs(img[i] - base[0]) + Math.abs(img[i + 1] - base[1]) + Math.abs(img[i + 2] - base[2]) > 24) diff++;
    }
    return diff > 140;
  }, sel);
}

(async () => {
  const server = createStaticServer(ROOT);
  const port = await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  const browser = await pwChromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // 模拟 Electron 桌面桥（字段与 electron/preload.js 同名）：系统 COM 列表 + 选口面板 IPC
  await page.addInitScript(() => {
    window.XHGCS_DESKTOP = {
      isDesktop: true,
      versions: { electron: 'test', chrome: 'test', node: 'test' },
      windowControls: { minimize() {}, toggleMaximize() {}, close() {}, state: async () => ({}), onMaximizedChange: () => () => {} },
      serial: {
        list: async () => ({ ports: [], lastSerialPort: 'COM7' }),
        winList: async () => ({ ok: true, ports: ['COM7', 'COM8'] }),
        chooseResult: async (payload) => { window.__serialChoice = payload; return { ok: true }; },
        onChoose: (handler) => { window.__onChooseSerial = handler; return () => {}; }
      }
    };
  });

  const boot = async () => {
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && document.getElementById('themeBtn')), null, { timeout: 25000 });
    await sleep(1600);
  };
  const ensureSim = async () => {
    // 仿真入口已从界面移除，测试直接用内部钩子给图表供数
    await page.evaluate(() => {
      if (!(window.XHGCS.state.simulation && window.XHGCS.state.simulation.enabled)) window.XHGCS.setSimulationEnabled(true);
    });
    await sleep(600);
  };
  const backVisual = async () => {
    await page.evaluate(() => {
      const b = document.querySelector('.rail-btn[data-nav="visual"]');
      if (b) b.click();
      const chip = document.getElementById('followChip');
      if (chip && !chip.hidden) chip.click();
    });
    await sleep(350);
  };
  const activePageName = () => page.evaluate(() => {
    const t = document.querySelector('#ptabs .ptab.active .ptab-main');
    return t ? t.textContent.trim() : '';
  });

  try {
    await boot();
    await ensureSim();

    /* ---------- 1. 导航：rail / 侧栏视图 ---------- */
    const railCases = [
      ['engine', 'protocol'], ['alarm', 'alarms'], ['plugins', 'plugins'], ['visual', 'explorer']
    ];
    for (const [nav, side] of railCases) {
      await page.evaluate((n) => { const b = document.querySelector('.rail-btn[data-nav="' + n + '"]'); if (b) b.click(); }, nav);
      await sleep(320);
      const sideView = await page.evaluate(() => (document.getElementById('app') || document.documentElement).dataset.sideView || '');
      check('导航：rail「' + nav + '」切到侧栏视图 ' + side, sideView === side, 'actual=' + sideView);
    }

    /* ---------- 2. 图页标签逐个切换 ---------- */
    await backVisual();
    const tabCount = await page.evaluate(() => document.querySelectorAll('#ptabs .ptab').length);
    for (let i = 0; i < tabCount; i++) {
      await page.evaluate((idx) => {
        const tabs = document.querySelectorAll('#ptabs .ptab .ptab-main');
        if (tabs[idx]) tabs[idx].click();
      }, i);
      await sleep(700);
      const st = await page.evaluate((idx) => ({
        active: (() => { const t = document.querySelectorAll('#ptabs .ptab')[idx]; return !!t && t.classList.contains('active'); })(),
        stage: document.getElementById('stage').dataset.mode,
        chans: (() => { const t = document.querySelectorAll('#ptabs .ptab')[idx]; const c = t && t.querySelector('.cnt'); return c ? +c.textContent : 0; })()
      }), i);
      check('图页 ' + (i + 1) + '：点击标签激活且回到图表舞台', st.active && st.stage === 'chart', JSON.stringify(st));
      if (st.chans > 0) {
        await sleep(900);
        check('图页 ' + (i + 1) + '：曲线有绘制内容', await canvasDrawn(page, '#scope'));
      }
    }

    /* ---------- 2b. 页签条：降高 + 按住拖拽横向滚动 ---------- */
    const barHeight = await page.evaluate(() => document.querySelector('.pagebar').getBoundingClientRect().height);
    check('页签条：高度收窄到 32px', barHeight <= 34, 'h=' + barHeight);
    const dragRes = await page.evaluate(async () => {
      const strip = document.getElementById('tabsScroll');
      const tabs = document.getElementById('ptabs');
      const prev = tabs.style.width;
      tabs.style.width = '2400px';
      await new Promise((r) => setTimeout(r, 60));
      const rect = strip.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const opts = (x, extra) => Object.assign({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, extra || {});
      strip.dispatchEvent(new PointerEvent('pointerdown', opts(rect.left + 300)));
      strip.dispatchEvent(new PointerEvent('pointermove', opts(rect.left + 240)));
      strip.dispatchEvent(new PointerEvent('pointermove', opts(rect.left + 100)));
      strip.dispatchEvent(new PointerEvent('pointerup', opts(rect.left + 100, { buttons: 0 })));
      await new Promise((r) => setTimeout(r, 60));
      const scrolled = strip.scrollLeft;
      tabs.style.width = prev || '';
      return { scrolled };
    });
    check('页签条：按住拖动可横向滚动', dragRes.scrolled > 50, JSON.stringify(dragRes));

    /* ---------- 3. 新建 / 重命名 / 删除图页（真实对话框） ---------- */
    const beforeAdd = await page.evaluate(() => document.querySelectorAll('#ptabs .ptab').length);
    await page.click('#addPageTab');
    await sleep(300);
    await page.fill('#npName', '功能测试页');
    await page.evaluate(() => { const inp = document.querySelector('#npChans input'); if (inp && !inp.checked) inp.click(); });
    await page.click('#npCreate');
    await sleep(500);
    const afterAdd = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#ptabs .ptab').length,
      active: (document.querySelector('#ptabs .ptab.active .ptab-main') || {}).textContent || ''
    }));
    check('图页：通过「＋」新建成功并激活', afterAdd.tabs === beforeAdd + 1 && afterAdd.active.indexOf('功能测试页') >= 0, JSON.stringify(afterAdd));

    await page.dblclick('#ptabs .ptab.active .ptab-main');
    await sleep(300);
    await page.fill('#rnName', '功能测试页B');
    await page.click('#rnSave');
    await sleep(400);
    check('图页：双击标签可重命名', (await activePageName()).indexOf('功能测试页B') >= 0, await activePageName());

    await page.hover('#ptabs .ptab.active');
    await sleep(150);
    await page.click('#ptabs .ptab.active .ptab-x');
    await sleep(300);
    await page.click('#delOk');
    await sleep(500);
    const afterDel = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#ptabs .ptab').length,
      names: Array.from(document.querySelectorAll('#ptabs .ptab-main')).map((e) => e.textContent)
    }));
    check('图页：关闭按钮删除图页且至少保留一页', afterDel.tabs === beforeAdd && !afterDel.names.some((n) => n.indexOf('功能测试页B') >= 0), JSON.stringify(afterDel));

    /* ---------- 3b. 页签拖拽排序：按住标签拖到别的位置换位，刷新后保持 ---------- */
    let reorderCount = await page.evaluate(() => document.querySelectorAll('#ptabs .ptab').length);
    if (reorderCount < 2) {
      await page.click('#addPageTab');
      await sleep(300);
      await page.fill('#npName', '排序页');
      await page.evaluate(() => { const inp = document.querySelector('#npChans input'); if (inp && !inp.checked) inp.click(); });
      await page.click('#npCreate');
      await sleep(500);
      reorderCount = await page.evaluate(() => document.querySelectorAll('#ptabs .ptab').length);
    }
    const tabNames = () => page.evaluate(() => Array.from(document.querySelectorAll('#ptabs .ptab .ptab-main')).map((b) => (b.firstChild ? b.firstChild.textContent : b.textContent).trim()));
    const activeName = () => page.evaluate(() => { const t = document.querySelector('#ptabs .ptab.active .ptab-main'); return t ? ((t.firstChild ? t.firstChild.textContent : t.textContent) || '').trim() : ''; });
    const beforeOrder = await tabNames();
    const beforeActive = await activeName();
    const dragPos = await page.evaluate(() => {
      const mains = document.querySelectorAll('#ptabs .ptab .ptab-main');
      const last = mains[mains.length - 1].getBoundingClientRect();
      const first = mains[0].getBoundingClientRect();
      return { xLast: last.left + last.width / 2, xFirst: first.left + first.width / 2, y: last.top + last.height / 2 };
    });
    await page.mouse.move(dragPos.xLast, dragPos.y);
    await page.mouse.down();
    await page.mouse.move(dragPos.xFirst, dragPos.y, { steps: 6 });
    await sleep(120);
    const anim = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('#ptabs .ptab'));
      return {
        lifted: els.some((el) => el.classList.contains('dragging') && (el.style.transform || '').indexOf('translateX') >= 0),
        sliding: els.some((el) => !el.classList.contains('dragging') && (el.style.transition || '').indexOf('transform') >= 0)
      };
    });
    check('页签：拖动时被拖标签抬起、其余标签滑让（有动画）', anim.lifted && anim.sliding, JSON.stringify(anim));
    await page.mouse.move(dragPos.xFirst, dragPos.y, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    const afterOrder = await tabNames();
    check('页签：拖动标签可换位排序', afterOrder.length === beforeOrder.length && afterOrder[0] === beforeOrder[beforeOrder.length - 1], JSON.stringify({ beforeOrder, afterOrder }));
    check('页签：拖动排序不改变当前激活页', (await activeName()) === beforeActive, JSON.stringify({ beforeActive, activeAfter: await activeName() }));

    // 反向再拖一次：把现在的第一个拖回最后，验证左右两个方向对称
    const posR = await page.evaluate(() => {
      const m = document.querySelectorAll('#ptabs .ptab .ptab-main');
      const first = m[0].getBoundingClientRect();
      const last = m[m.length - 1].getBoundingClientRect();
      return { xFirst: first.left + first.width / 2, xLast: last.left + last.width / 2, y: first.top + first.height / 2 };
    });
    await page.mouse.move(posR.xFirst, posR.y);
    await page.mouse.down();
    await page.mouse.move(posR.xLast + 12, posR.y, { steps: 10 });
    await page.mouse.up();
    await sleep(500);
    const afterRight = await tabNames();
    check('页签：向右拖动也可换位（方向对称）', afterRight.length === afterOrder.length && afterRight[afterRight.length - 1] === afterOrder[0], JSON.stringify({ afterOrder, afterRight }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 20000 });
    await sleep(1200);
    await ensureSim();
    const reloadOrder = await tabNames();
    check('页签：排序刷新后保持', reloadOrder[0] === afterRight[0], JSON.stringify({ afterRight, reloadOrder }));

    /* ---------- 4. 通道：加入 / 移出 / 改名 / 换色（在独立测试页上进行） ---------- */
    const createPage = async (name, checkedCount) => {
      await page.click('#addPageTab');
      await sleep(300);
      await page.fill('#npName', name);
      await page.evaluate((n) => {
        const inputs = Array.from(document.querySelectorAll('#npChans input'));
        inputs.forEach((inp, i) => { const want = i < n; if (inp.checked !== want) inp.click(); });
      }, checkedCount);
      await page.click('#npCreate');
      await sleep(500);
    };
    await createPage('通道测试页', 1);
    const hasNotIn = await page.evaluate(() => !!document.querySelector('#chList .ch-row.not-in .ch-act'));
    check('通道：当前页存在可加入的通道行', hasNotIn);
    if (hasNotIn) {
      const cntBefore = await page.evaluate(() => document.querySelector('#chCount').textContent);
      await page.evaluate(() => { const b = document.querySelector('#chList .ch-row.not-in .ch-act'); if (b) b.click(); });
      await sleep(400);
      const cntAfter = await page.evaluate(() => document.querySelector('#chCount').textContent);
      check('通道：从通道源加入当前图页', cntBefore !== cntAfter, cntBefore + ' → ' + cntAfter);
      await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#chList .ch-row.in-page'));
        const last = rows[rows.length - 1];
        const b = last && last.querySelector('.ch-act');
        if (b) b.click();
      });
      await sleep(400);
      const cntBack = await page.evaluate(() => document.querySelector('#chCount').textContent);
      check('通道：再次点击移出当前图页', cntBack === cntBefore, cntBack + ' vs ' + cntBefore);
    }

    const oldName = await page.evaluate(() => (document.querySelector('#chList .ch-row .ch-name') || {}).textContent || '');
    if (oldName) {
      const renameInfo = await page.evaluate(() => {
        const b = document.querySelector('#chList .ch-row .ch-name');
        if (!b) return { ok: false };
        b.click();
        const inp = document.querySelector('.ch-name-input');
        if (!inp) return { ok: false, why: 'no input' };
        const cs = getComputedStyle(inp);
        const r = inp.getBoundingClientRect();
        inp.value = '功能通道';
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { ok: true, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 };
      });
      await sleep(400);
      const renamed = await page.evaluate(() => ({
        row: (document.querySelector('#chList .ch-row .ch-name') || {}).textContent || '',
        legend: (document.getElementById('legend') || {}).textContent || ''
      }));
      check('通道：原地改名并同步图例', renameInfo.ok && renameInfo.visible && renamed.row === '功能通道' && renamed.legend.indexOf('功能通道') >= 0, JSON.stringify({ oldName, renameInfo, renamed }));
      await page.evaluate((name) => {
        const b = document.querySelector('#chList .ch-row .ch-name');
        if (b) b.click();
        const inp = document.querySelector('.ch-name-input');
        if (!inp) return;
        inp.value = name;
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }, oldName);
      await sleep(300);
    }

    const styleBefore = await page.evaluate(() => (document.querySelector('#chList .ch-row') || {}).getAttribute ? document.querySelector('#chList .ch-row').getAttribute('style') : '');
    await page.evaluate(() => { const b = document.querySelector('#chList .ch-row [data-ch-color-btn]'); if (b) b.click(); });
    await sleep(300);
    const swatchCount = await page.evaluate(() => document.querySelectorAll('#chList .ch-colors .chc').length);
    if (swatchCount > 1) {
      await page.evaluate(() => { const list = document.querySelectorAll('#chList .ch-colors .chc'); if (list[1]) list[1].click(); });
      await sleep(350);
    }
    const styleAfter = await page.evaluate(() => (document.querySelector('#chList .ch-row') || {}).getAttribute ? document.querySelector('#chList .ch-row').getAttribute('style') : '');
    check('通道：点色块换配色', swatchCount > 1 && styleBefore !== styleAfter, styleBefore + ' → ' + styleAfter);

    // 清理通道测试页
    await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('#ptabs .ptab')).find((el) => (el.textContent || '').indexOf('通道测试页') >= 0);
      const x = t && t.querySelector('.ptab-x');
      if (x) x.click();
    });
    await sleep(300);
    await page.evaluate(() => { const b = document.getElementById('delOk'); if (b) b.click(); });
    await sleep(400);

    /* ---------- 5. 图表交互：滚轮缩放 / 平移 / 回到现在 ---------- */
    await backVisual();
    const box = await page.locator('#scope').boundingBox();
    const winBefore = await page.evaluate(() => (document.getElementById('footWin') || {}).textContent || '');
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await sleep(400);
    }
    const winAfter = await page.evaluate(() => (document.getElementById('footWin') || {}).textContent || '');
    check('图表：滚轮缩放改变窗口', winBefore !== winAfter, winBefore + ' → ' + winAfter);
    // 平移需要历史长于视窗：切到 30 s 窗口，并等到真实历史超过窗口（最多等 45 s）
    await page.click('.seg [data-win="30"]');
    await page.waitForFunction(() => window.XHGCS.state.t >= 33, null, { timeout: 45000 }).catch(() => {});
    await sleep(400);

    if (box) {
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await sleep(400);
    }
    const chipVisible = await page.evaluate(() => !document.getElementById('followChip').hidden);
    check('图表：Shift+拖动平移后出现「回到现在」', chipVisible);
    await page.evaluate(() => { const c = document.getElementById('followChip'); if (c && !c.hidden) c.click(); });
    await sleep(500);
    const chipGone = await page.evaluate(() => document.getElementById('followChip').hidden);
    check('图表：点「回到现在」恢复跟随且曲线可见', chipGone && await canvasDrawn(page, '#scope'));

    /* ---------- 6. 暂停 = 冻结查看；数据继续 ---------- */
    await page.click('#playBtn');
    await sleep(300);
    const pauseState1 = await page.evaluate(() => ({
      chip: !document.getElementById('followChip').hidden,
      win: (document.getElementById('footWin') || {}).textContent,
      frames: (document.getElementById('stFrames') || {}).textContent
    }));
    await sleep(1200);
    const pauseState2 = await page.evaluate(() => ({
      win: (document.getElementById('footWin') || {}).textContent,
      frames: (document.getElementById('stFrames') || {}).textContent
    }));
    check('暂停：视图冻结（窗口不变）而数据继续（帧计数增长）',
      pauseState1.chip === true && pauseState1.win === pauseState2.win && Number(pauseState2.frames) > Number(pauseState1.frames),
      JSON.stringify({ pauseState1, pauseState2 }));

    /* ---------- 7. 暂停超过缓冲：视图应跟随缓冲边缘，不应空白 ---------- */
    await page.evaluate(() => { window.XHGCS.state.t += 140; });
    await sleep(900);
    const afterAging = await page.evaluate(() => ({
      frozenChip: !document.getElementById('followChip').hidden,
      win: (document.getElementById('footWin') || {}).textContent
    }));
    check('暂停：数据滚出缓冲后视图自动前移、曲线不空白',
      afterAging.frozenChip === true && afterAging.win === pauseState1.win && await canvasDrawn(page, '#scope'),
      JSON.stringify(afterAging));
    await page.click('#playBtn');
    await sleep(500);
    check('暂停：恢复后回到跟随且曲线可见',
      (await page.evaluate(() => document.getElementById('followChip').hidden)) && await canvasDrawn(page, '#scope'));

    /* ---------- 8. 数据源：仿真入口已移除（只留内部测试钩子） ---------- */
    const simUi = await page.evaluate(() => ({
      railSim: !!document.querySelector('.rail-btn[data-nav="sim"]'),
      title: (document.getElementById('srcBtn') || {}).title || ''
    }));
    check('界面：模拟/仿真入口已移除（rail 无「模拟」）', !simUi.railSim && simUi.title.indexOf('仿真') < 0, JSON.stringify(simUi));
    await page.evaluate(() => window.XHGCS.setSimulationEnabled(false));
    await sleep(500);
    const off1 = await page.evaluate(() => ({
      label: (document.querySelector('#srcBtn b') || {}).textContent,
      frames: Number((document.getElementById('stFrames') || {}).textContent || 0)
    }));
    await sleep(1000);
    const off2 = await page.evaluate(() => Number((document.getElementById('stFrames') || {}).textContent || 0));
    check('数据源：关闭仿真后停止推流且标签为未连接', /未连接/.test(off1.label || '') && off2 === off1.frames, JSON.stringify({ off1, off2 }));
    await page.evaluate(() => window.XHGCS.setSimulationEnabled(true));
    await sleep(900);
    const onFrames = await page.evaluate(() => Number((document.getElementById('stFrames') || {}).textContent || 0));
    check('数据源：重新开启仿真恢复推流（仅内部钩子，界面无入口）', onFrames > off2, off2 + ' → ' + onFrames);

    /* ---------- 9. 阈值页：真实通道卡 + 编辑保留 ---------- */
    await page.evaluate(() => { const b = document.querySelector('.rail-btn[data-nav="alarm"]'); if (b) b.click(); });
    await sleep(300);
    await page.click('#alThresholds');
    await sleep(600);
    const thInfo = await page.evaluate(() => ({
      stage: document.getElementById('stage').dataset.mode,
      cards: document.querySelectorAll('[data-tv-card]').length,
      channels: window.XHGCS.state.channels.length
    }));
    check('阈值设置：工作区打开且每个真实通道一张卡', thInfo.stage === 'thresholds' && thInfo.cards === thInfo.channels, JSON.stringify(thInfo));
    const firstCard = await page.$('[data-tv-card]');
    if (firstCard) {
      const cardId = await firstCard.getAttribute('data-tv-card');
      await page.evaluate((id) => {
        const card = document.querySelector('[data-tv-card="' + id + '"]');
        const hi = card.querySelector('[data-side="hi"]');
        const rng = window.XHGCS.state.channels.find((c) => c.id === id).range;
        hi.value = String((rng[0] + rng[1]) / 2);
        hi.dispatchEvent(new Event('change', { bubbles: true }));
      }, cardId);
      await sleep(300);
      const kept = await page.evaluate((id) => (document.querySelector('[data-tv-card="' + id + '"] [data-side="hi"]') || {}).value, cardId);
      check('阈值设置：修改上限即时生效（输入保留）', !!kept, 'value=' + kept);
    }

    /* ---------- 10. 告警：全部确认 ---------- */
    await page.evaluate(() => {
      const t = document.querySelector('#dtabs .dtab .ptab-x');
      if (t) t.click();
    });
    await sleep(300);
    const alarmInfo = await page.evaluate(() => ({
      rows: document.querySelectorAll('#alList [data-al-row]').length,
      badge: (document.getElementById('railBadge') || {}).textContent
    }));
    await page.click('#alAckAll');
    await sleep(500);
    const ackedInfo = await page.evaluate(() => ({
      unackedBlockRows: document.querySelectorAll('#alList [data-al-ack]').length,
      badgeHidden: (() => { const b = document.getElementById('railBadge'); return !b || b.style.display === 'none' || b.textContent === '0'; })(),
      ackedRows: document.querySelectorAll('#alList [data-al-row].acked').length
    }));
    check('告警：列表可见、全部确认后未确认清零', alarmInfo.rows >= 1 && ackedInfo.unackedBlockRows === 0 && ackedInfo.badgeHidden && ackedInfo.ackedRows >= 1, JSON.stringify({ alarmInfo, ackedInfo }));

    /* ---------- 11. 插件视图与详情 ---------- */
    await page.evaluate(() => { const b = document.querySelector('.rail-btn[data-nav="plugins"]'); if (b) b.click(); });
    await sleep(400);
    const plgRows = await page.evaluate(() => document.querySelectorAll('#plgList [data-plg-open]').length);
    check('插件：侧栏列出本机扩展', plgRows >= 1, 'rows=' + plgRows);
    if (plgRows >= 1) {
      const rowName = await page.evaluate(() => (document.querySelector('#plgList .plg-name .nm') || {}).textContent || '');
      await page.evaluate(() => { const b = document.querySelector('#plgList [data-plg-open]'); if (b) b.click(); });
      await sleep(500);
      const dv = await page.evaluate(() => ({
        stage: document.getElementById('stage').dataset.mode,
        name: (document.getElementById('dvName') || {}).textContent || ''
      }));
      check('插件：点行打开详情标签', dv.stage === 'detail' && dv.name === rowName, JSON.stringify({ rowName, dv }));
      await page.evaluate(() => { const t = document.querySelector('#dtabs .dtab .ptab-x'); if (t) t.click(); });
      await sleep(300);
    }

    /* ---------- 12. 命令面板 ---------- */
    await page.click('#cmdBtn');
    await sleep(300);
    const palOpen = await page.evaluate(() => document.getElementById('palette').classList.contains('open'));
    await page.fill('#paletteInput', '新建图页');
    await sleep(300);
    const palHit = await page.evaluate(() => document.querySelectorAll('#paletteList .palette-item').length);
    await page.press('#paletteInput', 'Enter');
    await sleep(400);
    const dlgOpen = await page.evaluate(() => document.getElementById('dlg').classList.contains('open'));
    check('命令面板：打开、过滤、回车执行命令（弹出新建图页）', palOpen && palHit >= 1 && dlgOpen, JSON.stringify({ palOpen, palHit, dlgOpen }));
    await page.evaluate(() => { const c = document.querySelector('#dlg [data-dlg-cancel]'); if (c) c.click(); });
    await sleep(200);

    /* ---------- 13. AI 坞面板切换 ---------- */
    const paneSwitch = [];
    for (const pane of ['ctx', 'task', 'voice', 'chat']) {
      await page.evaluate((p) => { const b = document.querySelector('.dock-tab[data-pane="' + p + '"]'); if (b) b.click(); }, pane);
      await sleep(200);
      paneSwitch.push(await page.evaluate((p) => !!(document.querySelector('.dock-pane.active[data-pane="' + p + '"]')), pane));
    }
    check('AI 坞：四页签切换正常', paneSwitch.every(Boolean), JSON.stringify(paneSwitch));

    /* ---------- 14. 布局四格 ---------- */
    const layoutTest = async (mode, expect) => {
      await page.evaluate((m) => { const b = document.querySelector('.layout-btn[data-layout="' + m + '"]'); if (b) b.click(); }, mode);
      await sleep(300);
      return page.evaluate((exp) => {
        const app = document.getElementById('app');
        return (app.dataset.toolbox === 'on') === exp.toolbox && (app.dataset.dock === 'on') === exp.dock;
      }, expect);
    };
    check('布局：仅左栏', await layoutTest('left', { toolbox: true, dock: false }));
    check('布局：仅右栏', await layoutTest('right', { toolbox: false, dock: true }));
    check('布局：专注（两侧隐藏）', await layoutTest('none', { toolbox: false, dock: false }));
    check('布局：恢复双栏', await layoutTest('both', { toolbox: true, dock: true }));

    /* ---------- 15. 设置页 ---------- */
    await page.click('#settingsBtn');
    await sleep(400);
    const setStage = await page.evaluate(() => ({
      stage: document.getElementById('stage').dataset.mode,
      mode: (document.querySelector('#setPostMode button.active') || {}).textContent || ''
    }));
    await page.evaluate(() => { const b = document.querySelector('#setPostMode button[data-post-mode="merged"]'); if (b) b.click(); });
    await sleep(300);
    const setMode = await page.evaluate(() => (document.querySelector('#setPostMode button.active') || {}).textContent || '');
    check('设置：工作区打开，后处理模式可切换', setStage.stage === 'settings' && setMode.indexOf('快速合并') >= 0, JSON.stringify({ setStage, setMode }));
    await page.evaluate(() => { const t = document.querySelector('#dtabs .dtab .ptab-x'); if (t) t.click(); });
    await sleep(300);

    /* ---------- 16. 输入页 ---------- */
    await page.evaluate(() => { const b = document.querySelector('.rail-btn[data-nav="engine"]'); if (b) b.click(); });
    await sleep(300);
    await page.evaluate(() => { const r = document.getElementById('linkOpenRow'); if (r) r.click(); });
    await sleep(500);
    const inputInfo = await page.evaluate(() => ({
      stage: document.getElementById('stage').dataset.mode,
      presets: document.querySelectorAll('#protoPresets [data-preset]').length,
      savedList: !!document.getElementById('protoSavedList')
    }));
    check('输入：打开输入页，预设与已保存区在', inputInfo.stage === 'protocol' && inputInfo.presets >= 5 && inputInfo.savedList, JSON.stringify(inputInfo));
    await page.evaluate(() => { const t = document.querySelector('#dtabs .dtab .ptab-x'); if (t) t.click(); });
    await sleep(300);
    await backVisual();

    /* ---------- 16b. 输入页接真实串口（CSV 浮点，samples: 前缀可有可无） ---------- */
    // 假串口：授权 1 个设备，打开后按 10 Hz 打印；首行名字表，数值行隔行带 samples: 前缀
    await page.evaluate(() => {
      const clock = { lines: 0 };
      let ctrl = null;
      let timer = null;
      const enc = new TextEncoder();
      const push = (text) => { try { ctrl.enqueue(enc.encode(text)); } catch (e) {} };
      const port = {
        _readable: null,
        getInfo() { return { usbVendorId: 6790, usbProductId: 29987 }; },
        async open(opts) {
          window.__fakeSerial.opened = true;
          window.__fakeSerial.opts = opts || null;
          this._readable = new ReadableStream({ start(c) {
            ctrl = c;
            const t0 = performance.now();
            timer = setInterval(() => {
              const t = (performance.now() - t0) / 1000;
              const vals = [Math.sin(t), Math.sin(2 * t), Math.sin(3 * t), Math.sin(4 * t)];
              const line = (clock.lines % 2 === 0 ? 'samples: ' : '') + vals.map((v) => v.toFixed(4)).join(', ') + '\n';
              clock.lines++;
              push(line);
            }, 100);
          } });
        },
        async close() {
          if (timer) clearInterval(timer);
          timer = null;
          try { if (ctrl) ctrl.close(); } catch (e) {}
          ctrl = null;
          this._readable = null;
        },
        get readable() { return this._readable; },
        writable: null
      };
      window.__fakeSerial = { opened: false, opts: null, lines: () => clock.lines, requestCalls: 0 };
      window.__fakePort = port;
      Object.defineProperty(navigator, 'serial', {
        configurable: true,
        value: {
          getPorts: async () => [port],
          // 模拟 Electron：requestPort 触发主进程枚举并把列表发给渲染层选口面板；
          // 面板按 window.__XHGCS_PICK_NAME__ 自动回传（selectByName）或展示面板
          requestPort: async () => {
            window.__fakeSerial.requestCalls += 1;
            if (window.__onChooseSerial) {
              window.__onChooseSerial({
                requestId: 'req-' + window.__fakeSerial.requestCalls,
                ports: [
                  { portId: 'p7', portName: 'COM7', displayName: 'COM7' },
                  { portId: 'p8', portName: 'COM8', displayName: 'COM8' }
                ],
                preset: ''
              });
            }
            await new Promise((r) => setTimeout(r, 150));
            return port;
          }
        }
      });
    });

    const parseChecks = await page.evaluate(() => {
      const S = window.XHGCS_SERIAL;
      const P = window.XHGCS_PROTOCOL;
      const mk = () => P.presetEngine(P.PRESETS.csv, {});
      const a = S.parseFrame(mk(), 'samples: 1.5, 2.5, 3.5');
      const b = S.parseFrame(mk(), '-1.5, -2.5, -3.5, 4');
      const c = S.parseFrame(mk(), 'samples:1.5,2.5');
      const crlf = S.parseFrame(mk(), '7.5, 8.5\r');
      const bad = S.parseFrame(mk(), 'samples: 1.0, x, 3.0');
      const h = mk();
      const hf = S.parseFrame(h, 'acc_roll,acc_pitch,acc_yaw');
      const hd = S.parseFrame(h, '1,2,3');
      return { a: a.values, b: b.values, c: c.values, crlf: crlf.values, bad: bad.ok, hOk: hf.ok, hd: hd.values };
    });
    check('CSV 协议：带/不带 samples 前缀都能解析（含负数与 CRLF）',
      parseChecks.a.CH1 === 1.5 && parseChecks.a.CH3 === 3.5 && parseChecks.b.CH4 === 4 && parseChecks.c.CH2 === 2.5 && parseChecks.crlf.CH2 === 8.5,
      JSON.stringify(parseChecks));
    check('CSV 协议：首行名字表按名字命名通道，混入非数字字段报错',
      parseChecks.hOk === true && parseChecks.hd.acc_pitch === 2 && parseChecks.bad === false,
      JSON.stringify({ hd: parseChecks.hd, bad: parseChecks.bad }));

    await page.evaluate(() => { const b = document.querySelector('.rail-btn[data-nav="engine"]'); if (b) b.click(); });
    await sleep(300);
    await page.evaluate(() => { const r = document.getElementById('linkOpenRow'); if (r) r.click(); });
    await sleep(400);
    const presetInfo = await page.evaluate(() => ({
      keys: Array.from(document.querySelectorAll('#protoPresets [data-preset]')).map((b) => b.dataset.preset),
      badge: (document.getElementById('linkStateBadge') || {}).textContent || '',
      linkRow: (document.getElementById('sideLinkPort') || {}).textContent || ''
    }));
    check('输入：预设来自真实协议库（含 CSV 浮点）', presetInfo.keys.indexOf('csv') >= 0 && presetInfo.keys.indexOf('wedfc') >= 0, JSON.stringify(presetInfo.keys));
    check('输入：链路默认未连接（真实状态，非演示 COM7）', presetInfo.badge.indexOf('已断开') >= 0 && presetInfo.linkRow.indexOf('COM7') < 0, JSON.stringify(presetInfo));

    await page.evaluate(() => { document.querySelector('[data-uart="port"]').click(); });
    await sleep(400);
    const portItems = await page.evaluate(() => Array.from(document.querySelectorAll('.uart-dd:not([hidden]) button')).map((b) => b.textContent));
    check('串口：端口下拉列出已授权设备（可唤起选择器）', portItems.length >= 2 && portItems.join('|').indexOf('VID:6790') >= 0, JSON.stringify(portItems));
    await page.evaluate(() => { const b = document.querySelector('.uart-dd:not([hidden]) [data-port]'); if (b) b.click(); });
    await sleep(400);
    const portChosen = await page.evaluate(() => ({
      port: window.XHGCS.state.serial.port,
      row: (document.getElementById('sideLinkPort') || {}).textContent || ''
    }));
    check('串口：选中已授权端口写入真实链路状态（带 COM 名）', String(portChosen.port).indexOf('6790') >= 0 && portChosen.row.indexOf('COM7') >= 0, JSON.stringify(portChosen));

    // 端口下拉也列出「系统有、本次会话还没授权」的 COM 口；点它按名字自动回传选择
    await page.evaluate(() => { document.querySelector('[data-uart="port"]').click(); });
    await sleep(500);
    const namedItems = await page.evaluate(() => Array.from(document.querySelectorAll('.uart-dd:not([hidden]) [data-name]')).map((b) => b.dataset.name));
    check('串口：下拉列出未授权的系统 COM 口', namedItems.indexOf('COM8') >= 0, JSON.stringify(namedItems));
    await page.evaluate(() => { const b = document.querySelector('.uart-dd:not([hidden]) [data-name="COM8"]'); if (b) b.click(); });
    await sleep(600);
    const namedChosen = await page.evaluate(() => ({
      choice: window.__serialChoice || null,
      port: window.XHGCS.state.serial.port
    }));
    check('串口：点 COM8 后选口面板按名字自动回传（COM8→p8，不二次询问）', !!namedChosen.choice && namedChosen.choice.portId === 'p8' && String(namedChosen.port).indexOf('COM8') >= 0, JSON.stringify(namedChosen));

    // 选口面板本体：没有预先指定端口时弹出面板，点行回传并关闭
    await page.evaluate(() => {
      window.__serialChoice = null;
      window.__onChooseSerial({
        requestId: 'panel-1',
        ports: [
          { portId: 'p7', portName: 'COM7', displayName: 'COM7' },
          { portId: 'p8', portName: 'COM8', displayName: 'COM8' }
        ],
        preset: 'COM7'
      });
    });
    await sleep(400);
    const panel = await page.evaluate(() => ({
      open: !!document.querySelector('.xhsp-mask'),
      rows: Array.from(document.querySelectorAll('.xhsp-mask .xhsp-row')).map((b) => b.textContent)
    }));
    await page.evaluate(() => { const rows = document.querySelectorAll('.xhsp-mask .xhsp-row'); if (rows[1]) rows[1].click(); });
    await sleep(300);
    const panelChoice = await page.evaluate(() => ({ choice: window.__serialChoice, open: !!document.querySelector('.xhsp-mask') }));
    check('串口：多端口时弹应用内选口面板，点选回传并关闭', panel.open && panel.rows.length === 2 && !!panelChoice.choice && panelChoice.choice.portId === 'p8' && !panelChoice.open, JSON.stringify({ panel, panelChoice }));

    // 默认协议仍是 JSON：先直接连（设备在打 CSV），验证协议不符不再静默、帧计数从 0 起
    await page.evaluate(() => { const sw = document.getElementById('uartRxSwitch'); if (sw) sw.click(); });
    await page.waitForFunction(() => !!window.XHGCS.state.serial.connected, null, { timeout: 12000 });
    await page.waitForFunction(() => window.XHGCS.state.serial.errors >= 3, null, { timeout: 8000 });
    const mismatch = await page.evaluate(() => ({
      connected: window.XHGCS.state.serial.connected,
      badge: (document.getElementById('linkStateBadge') || {}).textContent || '',
      sw: document.getElementById('uartRxSwitch').checked,
      opened: window.__fakeSerial.opened,
      baud: (window.__fakeSerial.opts || {}).baudRate,
      frames: window.XHGCS.state.serial.frames,
      errors: window.XHGCS.state.serial.errors,
      logs: (window.XHGCS.state.logs || []).map((l) => l.text).filter((t) => t.indexOf('不匹配') >= 0).slice(-1),
      toast: (document.getElementById('toastText') || {}).textContent || ''
    }));
    check('串口：开关打开后真实连接（115200）', mismatch.connected && mismatch.opened && mismatch.baud === 115200 && mismatch.sw && mismatch.badge.indexOf('已连接') >= 0, JSON.stringify(mismatch));
    check('协议不符：JSON 收到 CSV 文本时计数与提示可见（不再静默吞数据）', mismatch.errors >= 3 && mismatch.frames === 0 && mismatch.logs.length >= 1 && mismatch.toast.indexOf('CSV 浮点') >= 0, JSON.stringify(mismatch));

    // 不重连、直接切到 CSV 浮点：应立刻按新协议解析（用户现场就是这条恢复路径）
    await page.evaluate(() => { const b = document.querySelector('#protoPresets [data-preset="csv"]'); if (b) b.click(); });
    await sleep(400);
    const csvApplied = await page.evaluate(() => ({
      name: (document.getElementById('protoName') || {}).textContent || '',
      active: (window.XHGCS.getActiveEngine() || {}).protocol
    }));
    check('输入：应用 CSV 浮点协议', csvApplied.name === 'CSV 浮点引擎' && csvApplied.active === 'CSV', JSON.stringify(csvApplied));

    await page.waitForFunction(() => window.XHGCS.state.channels.length === 4, null, { timeout: 8000 });
    const stillOn = await page.evaluate(() => document.getElementById('uartRxSwitch').checked);
    check('协议切换：不重连即按 CSV 解析并自动建通道', stillOn === true, 'switch=' + stillOn);
    await sleep(500);
    const discovered = await page.evaluate(() => ({
      names: window.XHGCS.state.channels.map((c) => c.name).join(','),
      stCh: (document.getElementById('stChannels') || {}).textContent || '',
      values: window.XHGCS.state.channels.map((c) => (c.data.length ? c.data[c.data.length - 1] : null))
    }));
    check('CSV：首帧自动建成 CH1–CH4 四个通道', discovered.names === 'CH1,CH2,CH3,CH4' && discovered.stCh === '4' && discovered.values.every((v) => v != null), JSON.stringify(discovered));
    const f1 = await page.evaluate(() => ({ frames: window.XHGCS.state.serial.frames, errors: window.XHGCS.state.serial.errors }));
    await sleep(800);
    const f2 = await page.evaluate(() => ({
      frames: window.XHGCS.state.serial.frames,
      errors: window.XHGCS.state.serial.errors,
      latest: window.XHGCS.state.channels.map((c) => (c.data.length ? c.data[c.data.length - 1] : null))
    }));
    check('CSV：10 Hz 持续收帧且两种前缀都不报错', f2.frames > f1.frames + 2 && f2.errors === f1.errors, JSON.stringify({ f1, frames: f2.frames, errors: f2.errors }));
    check('CSV：通道样本持续更新', f2.latest.every((v) => v != null), JSON.stringify(f2.latest));

    await page.evaluate(() => { const t = document.querySelector('#dtabs .dtab .ptab-x'); if (t) t.click(); });
    await sleep(300);
    await backVisual();
    await sleep(900);
    const vis = await page.evaluate(() => ({
      legend: Array.from(document.querySelectorAll('#legend .l-name')).map((e) => e.textContent).join(','),
      src: (document.querySelector('#srcBtn b') || {}).textContent || '',
      hz: (document.querySelector('#srcBtn .hz') || {}).textContent || ''
    }));
    check('CSV：图例出现新通道，数据源胶囊切到真实串口', vis.legend.indexOf('CH1') >= 0 && vis.src.indexOf('串口') >= 0, JSON.stringify(vis));
    check('CSV：主图按真实串口样本绘制', await canvasDrawn(page, '#scope'));

    /* ---------- 16c. 图表右键菜单（VOFA 风格） ---------- */
    await page.click('#scope', { button: 'right' });
    await sleep(400);
    const menu1 = await page.evaluate(() => ({
      open: !!document.querySelector('.xh-cmenu'),
      labels: Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item .xh-cmenu-label')).map((e) => e.textContent)
    }));
    check('右键菜单：图表右键打开，含 Y轴 / 图形种类 / 截图 / Auto',
      menu1.open && ['Y轴', '图形种类', 'X轴', '截图'].every((n) => menu1.labels.indexOf(n) >= 0) && menu1.labels.join('|').indexOf('Auto') >= 0,
      JSON.stringify(menu1));

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').indexOf('图形种类') >= 0);
      if (btn) btn.click();
    });
    await sleep(350);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').trim() === '叠加');
      if (btn) btn.click();
    });
    await sleep(400);
    const modeNow = await page.evaluate(() => (document.querySelector('#modeSeg button.active') || {}).dataset.mode || '');
    check('右键菜单：图形种类切到叠加', modeNow === 'overlay', 'mode=' + modeNow);

    const chipsBefore = await page.evaluate(() => document.querySelectorAll('#legend .legend-chip').length);
    await page.click('#scope', { button: 'right' });
    await sleep(300);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').indexOf('Y轴') >= 0);
      if (btn) btn.click();
    });
    await sleep(350);
    const yClicked = await page.evaluate(() => {
      const menus = Array.from(document.querySelectorAll('.xh-cmenu'));
      const sub = menus[menus.length - 1];
      const items = Array.from(sub.querySelectorAll('.xh-cmenu-item')).filter((b) => b.querySelector('.xh-cmenu-dot'));
      const target = items[items.length - 1];
      if (!target) return false;
      target.click();
      return true;
    });
    await sleep(450);
    const chipsAfter = await page.evaluate(() => document.querySelectorAll('#legend .legend-chip').length);
    check('右键菜单：Y轴通道列表可移出通道', yClicked && chipsAfter === chipsBefore - 1, JSON.stringify({ chipsBefore, chipsAfter }));

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').trim() === '填充');
      if (btn) btn.click();
    });
    await sleep(250);
    const fillState = await page.evaluate(() => window.__xhChartMenuState());
    check('右键菜单：填充开关生效', fillState.fill === true, JSON.stringify(fillState));

    await page.keyboard.press('Escape');
    await sleep(200);
    await page.click('#scope', { button: 'right' });
    await sleep(300);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').indexOf('Auto') >= 0);
      if (btn) btn.click();
    });
    await sleep(250);
    const autoState = await page.evaluate(() => window.__xhChartMenuState());
    check('右键菜单：Auto 量程开关生效', autoState.autoRange === false, JSON.stringify(autoState));

    const dlPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.click('#scope', { button: 'right' });
    await sleep(300);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.xh-cmenu .xh-cmenu-item')).find((b) => (b.textContent || '').trim() === '截图');
      if (btn) btn.click();
    });
    const download = await dlPromise;
    check('右键菜单：截图导出 PNG', !!download && /\.png$/i.test(download.suggestedFilename() || ''), download ? download.suggestedFilename() : 'no download');
    await page.keyboard.press('Escape');
    await sleep(200);

    await page.evaluate(() => { const b = document.querySelector('.rail-btn[data-nav="engine"]'); if (b) b.click(); });
    await sleep(250);
    await page.evaluate(() => { const r = document.getElementById('linkOpenRow'); if (r) r.click(); });
    await sleep(350);
    await page.evaluate(() => { const sw = document.getElementById('uartRxSwitch'); if (sw) sw.click(); });
    await page.waitForFunction(() => !window.XHGCS.state.serial.connected, null, { timeout: 8000 });
    const g1 = await page.evaluate(() => window.XHGCS.state.serial.frames);
    await sleep(700);
    const afterOff = await page.evaluate(() => ({
      frames: window.XHGCS.state.serial.frames,
      badge: (document.getElementById('linkStateBadge') || {}).textContent || '',
      sw: document.getElementById('uartRxSwitch').checked
    }));
    check('串口：关闭开关后断开并停止收帧', !afterOff.sw && afterOff.badge.indexOf('已断开') >= 0 && afterOff.frames <= g1 + 1, JSON.stringify({ g1, afterOff }));

    // 用户现场回归：全新启动、没有任何已授权端口时，点「开启串口」也必须唤起端口选择并连接
    {
      const page2 = await ctx.newPage();
      page2.on('pageerror', (e) => errors.push('pageerror(p2): ' + e.message));
      await page2.addInitScript(() => {
        window.XHGCS_DESKTOP = {
          isDesktop: true,
          versions: { electron: 'test', chrome: 'test', node: 'test' },
          windowControls: { minimize() {}, toggleMaximize() {}, close() {}, state: async () => ({}), onMaximizedChange: () => () => {} },
          serial: {
            list: async () => ({ ports: [], lastSerialPort: '' }),
            winList: async () => ({ ok: true, ports: ['COM9'] }),
            chooseResult: async () => ({ ok: true }),
            onChoose: () => () => {}
          }
        };
      });
      await page2.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
      await page2.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && document.getElementById('themeBtn')), null, { timeout: 25000 });
      await sleep(1400);
      await page2.evaluate(() => {
        let ctrlRef = null;
        const p2 = {
          _r: null,
          getInfo() { return { usbVendorId: 6790, usbProductId: 29987 }; },
          async open() {
            window.__p2Open = true;
            this._r = new ReadableStream({ start(c) { ctrlRef = c; c.enqueue(new TextEncoder().encode('1.5, 2.5\n')); } });
          },
          async close() { try { if (ctrlRef) ctrlRef.close(); } catch (e) {} this._r = null; },
          get readable() { return this._r; },
          writable: null
        };
        window.__p2 = { requestCalls: 0 };
        Object.defineProperty(navigator, 'serial', {
          configurable: true,
          value: {
            getPorts: async () => [],
            requestPort: async () => { window.__p2.requestCalls += 1; return p2; }
          }
        });
      });
      await page2.evaluate(() => {
        const b = document.querySelector('.rail-btn[data-nav="engine"]'); if (b) b.click();
        const r = document.getElementById('linkOpenRow'); if (r) r.click();
      });
      await sleep(500);
      await page2.evaluate(() => { const sw = document.getElementById('uartRxSwitch'); if (sw) sw.click(); });
      await page2.waitForFunction(() => !!window.XHGCS.state.serial.connected, null, { timeout: 10000 });
      const p2out = await page2.evaluate(() => ({ calls: window.__p2.requestCalls, connected: window.XHGCS.state.serial.connected, opened: !!window.__p2Open }));
      check('串口：无授权端口时点开启也能唤起端口选择并连接（用户现场问题）', p2out.connected && p2out.opened && p2out.calls === 1, JSON.stringify(p2out));
      await page2.evaluate(() => { const sw = document.getElementById('uartRxSwitch'); if (sw) sw.click(); });
      await sleep(600);
      await page2.close();
    }

    await page.evaluate(() => { document.getElementById('protoSaveBtn').click(); });
    await page.waitForSelector('#psName', { timeout: 5000 });
    await page.fill('#psName', 'CSV 测试保存');
    await page.evaluate(() => { document.getElementById('psOk').click(); });
    await sleep(600);
    const savedInfo = await page.evaluate(() => ({
      saves: (window.XHGCS.state.inputSaves || []).map((s) => s.name),
      rows: Array.from(document.querySelectorAll('#protoSavedList [data-save] .tb-row-name')).map((e) => e.textContent),
      chans: ((window.XHGCS.state.inputSaves || [])[0] || {}).channels || []
    }));
    check('保存：协议 + 通道快照写入真实保存列表', savedInfo.saves.indexOf('CSV 测试保存') >= 0 && savedInfo.rows.indexOf('CSV 测试保存') >= 0 && savedInfo.chans.length === 4, JSON.stringify(savedInfo));

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && document.getElementById('themeBtn')), null, { timeout: 25000 });
    await sleep(1200);
    const afterReload = await page.evaluate(() => ({
      engine: (window.XHGCS.getActiveEngine() || {}).protocol,
      rows: Array.from(document.querySelectorAll('#protoSavedList [data-save] .tb-row-name')).map((e) => e.textContent)
    }));
    check('保存：刷新后保存仍在且协议保持 CSV', afterReload.engine === 'CSV' && afterReload.rows.indexOf('CSV 测试保存') >= 0, JSON.stringify(afterReload));

    /* ---------- 17. 主题：图标=下一风格，且刷新后保持 ---------- */
    const themeBefore = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      sun: !!document.querySelector('#themeBtn circle')
    }));
    await page.click('#themeBtn');
    await sleep(400);
    const themeAfter = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      sun: !!document.querySelector('#themeBtn circle'),
      stored: localStorage.getItem('xhgcs.ui.theme')
    }));
    check('主题：图标显示点击后切到的风格', themeBefore.theme === 'dark' ? (themeBefore.sun === true && themeAfter.sun === false) : (themeBefore.sun === false && themeAfter.sun === true), JSON.stringify({ themeBefore, themeAfter }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!document.getElementById('themeBtn'), null, { timeout: 20000 });
    await sleep(800);
    const themeReload = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stored: localStorage.getItem('xhgcs.ui.theme')
    }));
    check('主题：刷新后保持上次选择', themeReload.theme === themeReload.stored, JSON.stringify(themeReload));

    /* ---------- 18. 图页持久化：新建后刷新仍在 ---------- */
    await ensureSim();
    await page.click('#addPageTab');
    await sleep(300);
    await page.fill('#npName', '持久化页');
    await page.evaluate(() => { const inp = document.querySelector('#npChans input'); if (inp && !inp.checked) inp.click(); });
    await page.click('#npCreate');
    await sleep(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state), null, { timeout: 20000 });
    await sleep(1200);
    const persisted = await page.evaluate(() => Array.from(document.querySelectorAll('#ptabs .ptab-main')).map((e) => e.textContent));
    check('持久化：新建图页刷新后仍在', persisted.some((n) => n.indexOf('持久化页') >= 0), JSON.stringify(persisted));
    // 清理
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#ptabs .ptab'));
      const t = tabs.find((el) => (el.textContent || '').indexOf('持久化页') >= 0);
      const x = t && t.querySelector('.ptab-x');
      if (x) x.click();
    });
    await sleep(300);
    await page.evaluate(() => { const b = document.getElementById('delOk'); if (b) b.click(); });
    await sleep(400);

    /* ---------- 19. 1100×720 窄窗 ---------- */
    await backVisual();
    await page.setViewportSize({ width: 1100, height: 720 });
    await sleep(700);
    const narrow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      canvas: (() => { const c = document.getElementById('scope'); return c ? c.getBoundingClientRect().width > 200 : false; })()
    }));
    check('窄窗 1100：无横向溢出且图仍可用', narrow.scrollW <= narrow.innerW + 1 && narrow.canvas, JSON.stringify(narrow));
    await page.setViewportSize({ width: 1600, height: 900 });
    await sleep(400);

    /* ---------- 20. 稳定性：控制台零错误 ---------- */
    check('稳定性：全程无 console error / pageerror', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (err) {
    fail('测试脚本执行中断', err && err.message ? err.message : String(err));
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    console.log('失败明细：');
    failures.forEach((f) => console.log(' - ' + f));
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('跑不起来：' + (err && err.stack || err));
  process.exit(2);
});
