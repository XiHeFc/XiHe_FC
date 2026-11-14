'use strict';
// 单文件界面契约测试：node tools/ui-contract.js
// 自己起临时静态服务 + Playwright Chromium，不依赖 regress/手动 8123，不读截图、不写仓库文件。
// 输出：一行一条 PASS/FAIL（[A]~[E] 组标），失败夹带实际值；末尾汇总，失败 exit 1。
const fs = require('fs');
const path = require('path');
const { createStaticServer } = require('../electron/static-server');
const { chromium: pwChromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 白名单纪律 ----------
// 只允许放「已由 Lead 裁决保留的例外」；每条必须带 why + decidedBy。
// 禁止把「当前不达标」的项塞进来（先报给 ui-lead/Lead，裁决后才可入列）。
// 没有裁决记录的一律按违约 FAIL 报出，不得静默豁免。
const FONT_ALLOWED = [10, 11, 12, 13, 14, 16]; // 全站设计档位
const FONT_BOARD_ONLY = [24, 32]; // 仅看板全屏大数字允许（.board-mask 存在时）
const TEXT_SENTENCE_PATTERNS = [/[。；;]/, /点击|拖动|拖拽|双击|可以|建议|请注意|提示：|说明：/];
const WHITELISTS = {
  text: [
    { text: "Esc 退出", why: "快捷键提示，不属于解释性小字", decidedBy: "Lead 2026-10-28 段1 工单白名单" },
    { text: "应用没有枚举到串口设备", why: "错误/失败提示 ≠ 解释性小字", decidedBy: "Lead 2026-10-28 P3.3a 裁决保留" },
    { text: "暂无日志", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁（串口空态唯一文案）" },
    { text: "暂无数据", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁（保持不动）" },
    { text: "空画布", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "未选中控件", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "未设置阈值", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "无数据", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" }
  ],
  cssContent: [
    { text: "上面这份代码真挂载自检没通过", why: "AI 校验 prompt 字符串（发给模型的内容，不是界面文案）", decidedBy: "Lead 2026-10-28 UI 文案扫描豁免（ai.js:554）" },
    { text: "上面这份不合格", why: "AI 校验 prompt 字符串（不是界面文案）", decidedBy: "Lead 2026-10-28 UI 文案扫描豁免（ai.js:779）" },
    { text: "暂无日志", why: "空态名词短语（串口空态唯一文案）", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "暂无数据", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 裁决保持不动" },
    { text: "空画布", why: "空态名词短语（设计器空画布）", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "未选中控件", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "未设置阈值", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" },
    { text: "无数据", why: "空态名词短语", decidedBy: "Lead 2026-10-28 P3.3a 终裁" }
  ]
};

// 仓库源码 CSS content 中文扫描：递归 src/** + assets/**，逐条 file:line + 原始串 + 判定
function scanSourceContent() {
  const exts = new Set([".css", ".ts", ".js", ".html", ".json"]);
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!exts.has(path.extname(ent.name).toLowerCase())) continue;
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch (err) { continue; }
      const re = /content\s*:\s*(['"])([\s\S]*?)\1/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const value = m[2];
        if (!/[\u4e00-\u9fa5]/.test(value)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        hits.push({ file: path.relative(ROOT, full).replace(/\\/g, "/"), line, value });
      }
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "assets"));
  return hits;
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

let passed = 0;
let failed = 0;
function pass(group, name) { passed++; console.log('[PASS] [' + group + '] ' + name); }
function fail(group, name, actual) {
  failed++;
  console.log('[FAIL] [' + group + '] ' + name + (actual === undefined ? '' : ' —— 实测：' + actual));
}
function check(group, name, cond, actual) {
  if (cond) pass(group, name); else fail(group, name, actual);
}

(async () => {
  const server = createStaticServer(ROOT);
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const browser = await pwChromium.launch({ executablePath: findChrome(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.goto(BASE + port + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && window.XHGCS_LAYOUT), null, { timeout: 15000 });
  await sleep(800);

  try {
    // ================= A. 结构锚点 =================
    const anchors = await page.evaluate(() => {
      const ids = ['swList', 'plotTabs', 'chlList', 'workspaceDock', 'btnCollapseDock', 'view-wave', 'btnPlay', 'sideNav', 'aiDrawer', 'aiMessages', 'plotControls', 'newChlName', 'btnAddChl'];
      return ids.map((id) => ({ id, exists: !!document.getElementById(id) }));
    });
    const missing = anchors.filter((a) => !a.exists).map((a) => a.id);
    check('A', '13 个结构 id 全部存在', missing.length === 0, missing.join(','));
    await page.waitForFunction(() => document.querySelectorAll('#sideNav [data-xhgcs-menu]').length >= 3, null, { timeout: 2000 }).catch(() => {});
    const nav = await page.evaluate(() => {
      const navEl = document.getElementById('sideNav');
      const dataNav = Array.from(navEl.querySelectorAll('[data-nav]')).map((el) => el.dataset.nav);
      const dataAction = Array.from(navEl.querySelectorAll('[data-action]')).map((el) => el.dataset.action);
      const menu = Array.from(navEl.querySelectorAll('[data-xhgcs-menu]')).map((el) => el.dataset.xhgcsMenu);
      return { dataNav, dataAction, menu };
    });
    const expectNav = ['visual', 'analysis', 'input', 'alarm', 'sim'];
    check('A', 'sideNav data-nav 五项齐全且协议/串口已并入输入', expectNav.every((n) => nav.dataNav.includes(n)) && !nav.dataNav.includes('engine') && !nav.dataNav.includes('serial'), JSON.stringify(nav.dataNav));
    const expectAct = ['ai', 'settings', 'help'];
    check('A', 'sideNav data-action 3 项齐全', expectAct.every((n) => nav.dataAction.includes(n)), JSON.stringify(nav.dataAction));
    const expectMenu = ['xhgcs.designer', 'xhgcs.views', 'xhgcs.board'];
    check('A', '内核注入 3 个 [data-xhgcs-menu] 齐全', expectMenu.every((n) => nav.menu.includes(n)), JSON.stringify(nav.menu));

    // ================= B. 几何（1600x1000 默认态） =================
    // ui5 外壳：AI 列默认常驻，右 Dock 被样品 CSS 收纳（visibility:hidden，不占列）
    await page.waitForFunction(() => {
      const d = document.getElementById('aiDrawer');
      return !!d && !d.hidden && d.getBoundingClientRect().width > 0;
    }, null, { timeout: 3000 });
    const geo = await page.evaluate(() => {
      const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
      const statusbar = document.querySelector('.statusbar');
      const grid = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns || '';
      const railTrack = parseFloat((grid.trim().split(/\s+/)[0] || '').replace('px', ''));
      return {
        gridColumns: grid,
        railTrack: Number.isFinite(railTrack) ? Math.round(railTrack) : -1,
        chart: w('.ctrl-view'),
        rail: w('#sideNav'),
        left: w('.ctrl-switch'),
        dock: w('#workspaceDock'),
        dockVis: getComputedStyle(document.querySelector('#workspaceDock')).visibility,
        aiW: w('#aiDrawer'),
        aiOpenClass: document.querySelector('.app').classList.contains('ai-open'),
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        statusBottom: statusbar ? Math.round(statusbar.getBoundingClientRect().bottom) : -1
      };
    });
    check('B', 'workspace grid 第一列==52', geo.railTrack === 52, (geo.railTrack + ' (grid: ' + geo.gridColumns + ')'));
    check('B', '#sideNav 元素宽 52（附加信息）', geo.rail === 52, geo.rail);
    check('B', '左栏宽 300（ui5 默认）', geo.left === 300, geo.left);
    check('B', '右 Dock 被收纳不可见', geo.dockVis === 'hidden', geo.dockVis);
    check('B', '默认 AI 列打开（.app.ai-open）', geo.aiOpenClass === true && geo.aiW >= 320, 'aiW=' + geo.aiW + ' ai-open=' + geo.aiOpenClass);
    check('B', 'scrollWidth==innerWidth', geo.scrollW === geo.innerW, geo.scrollW + ' vs ' + geo.innerW);
    check('B', 'scrollHeight==innerHeight', geo.scrollH === geo.innerH, geo.scrollH + ' vs ' + geo.innerH);
    check('B', '状态栏底边贴窗口底', geo.statusBottom === geo.innerH, geo.statusBottom + ' vs ' + geo.innerH);
    const overflow = await page.evaluate(() => {
      const out = [];
      const vis = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      document.querySelectorAll('body *').forEach((el) => {
        if (!vis(el)) return;
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth + 1 || r.left < -1) out.push((el.tagName || '').toLowerCase() + '.' + String(el.className || '').split(/\s+/).slice(0, 3).join('.') + '[' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
      });
      return out.slice(0, 8);
    });
    check('B', '无横向溢出可见元素', overflow.length === 0, overflow.join(' | '));
    // 守恒用 #sideNav 实际宽做 rail 分量，并与上面 grid 第一 track 交叉校验：
    // 若 grid 列被改动而元素未跟上，这条会红（避免只看元素自身宽而漏掉布局列变异）。
    const defaultSum = geo.rail + geo.left + geo.chart + geo.aiW;
    check('B', '默认态守恒 rail+left+chart+aiW==innerWidth（±2）', Math.abs(defaultSum - geo.innerW) <= 2, 'rail=' + geo.rail + ' left=' + geo.left + ' chart=' + geo.chart + ' aiW=' + geo.aiW + ' sum=' + defaultSum + ' innerW=' + geo.innerW + ' grid=' + geo.gridColumns);

    // ================= C. AI 列契约（ui5：默认常驻，Esc 收起，rail 重开） =================
    const aiDefault = await page.evaluate(() => {
      const chart = document.querySelector('.ctrl-view').getBoundingClientRect();
      const drawer = document.getElementById('aiDrawer').getBoundingClientRect();
      const fold = document.getElementById('btnCollapseDock');
      return {
        chart: Math.round(chart.width),
        chartH: Math.round(chart.height),
        aiW: Math.round(drawer.width),
        left: Math.round(document.querySelector('.ctrl-switch').getBoundingClientRect().width),
        innerW: window.innerWidth,
        foldVis: fold ? getComputedStyle(fold).visibility : 'missing'
      };
    });
    check('C', 'AI 列宽 == 380（1600 宽默认）', aiDefault.aiW === 380, aiDefault.aiW);
    const expectChart = aiDefault.innerW - 52 - aiDefault.left - aiDefault.aiW;
    check('C', 'AI 打开时图宽===innerWidth-52-left-aiW（±2）', Math.abs(aiDefault.chart - expectChart) <= 2, aiDefault.chart + ' vs ' + expectChart);
    check('C', 'Dock 收纳后折叠按钮不可见', aiDefault.foldVis === 'hidden', aiDefault.foldVis);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('aiDrawer').hidden, null, { timeout: 2000 });
    const aiClosed = await page.evaluate(() => ({
      chart: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().width),
      chartH: Math.round(document.querySelector('.ctrl-view').getBoundingClientRect().height),
      left: Math.round(document.querySelector('.ctrl-switch').getBoundingClientRect().width),
      aiOpenClass: document.querySelector('.app').classList.contains('ai-open'),
      innerW: window.innerWidth
    }));
    check('C', 'Esc 关闭后图宽===innerWidth-52-left（±2）', Math.abs(aiClosed.chart - (aiClosed.innerW - 52 - aiClosed.left)) <= 2, aiClosed.chart + ' vs ' + (aiClosed.innerW - 52 - aiClosed.left));
    check('C', 'Esc 关闭后 .app 无 ai-open', aiClosed.aiOpenClass === false, aiClosed.aiOpenClass);
    await page.click('[data-action="ai"]');
    await page.waitForFunction(() => {
      const d = document.getElementById('aiDrawer');
      return !!d && !d.hidden;
    }, null, { timeout: 3000 });
    const aiReopen = await page.evaluate(() => {
      const chart = document.querySelector('.ctrl-view').getBoundingClientRect();
      const drawer = document.getElementById('aiDrawer').getBoundingClientRect();
      return { chart: Math.round(chart.width), chartH: Math.round(chart.height), aiW: Math.round(drawer.width) };
    });
    check('C', 'rail 点击可重开 AI 列，图宽恢复 ±2', Math.abs(aiReopen.chart - (aiDefault.innerW - 52 - aiDefault.left - aiReopen.aiW)) <= 2, aiReopen.chart);
    check('C', '主图高度开合前后一致', aiReopen.chartH === aiDefault.chartH && aiClosed.chartH === aiDefault.chartH, aiDefault.chartH + ' -> ' + aiClosed.chartH + ' -> ' + aiReopen.chartH);

    // ================= F. 工作区标签条（v43：单滚动容器 + ＋外置 + 激活自动滚入） =================
    await page.evaluate(() => {
      for (let i = 0; i < 6; i++) window.XHGCS.addPlot(window.XHGCS.state.subview);
      const tabs = document.querySelectorAll('#plotTabs .ptab');
      if (tabs.length) tabs[tabs.length - 1].click();
    });
    await sleep(150);
    const tabs = await page.evaluate(() => {
      const scroller = document.getElementById('tabsScroll');
      const host = document.getElementById('plotTabs');
      const add = document.getElementById('btnAddPlot');
      const active = host ? host.querySelector('.ptab.active') : null;
      const sr = scroller ? scroller.getBoundingClientRect() : null;
      const ar = active ? active.getBoundingClientRect() : null;
      return {
        hasScroller: !!scroller,
        count: host ? host.querySelectorAll('.ptab').length : -1,
        scrollable: scroller ? scroller.scrollWidth > scroller.clientWidth : false,
        activeVisible: !!(sr && ar && ar.left >= sr.left - 1 && ar.right <= sr.right + 1),
        addOutside: !!(scroller && add && !scroller.contains(add)),
        addVisible: !!(add && add.getBoundingClientRect().width > 0)
      };
    });
    check('F', '图页标签条有单滚动容器 #tabsScroll', tabs.hasScroller, JSON.stringify(tabs));
    check('F', '多图页时标签条可横向滚动', tabs.count >= 7 && tabs.scrollable, 'count=' + tabs.count + ' scrollable=' + tabs.scrollable);
    check('F', '激活图页标签滚动后完整可见', tabs.activeVisible, JSON.stringify(tabs));
    check('F', '＋固定在滚动区外且可见', tabs.addOutside && tabs.addVisible, JSON.stringify(tabs));

    // ================= G. 详情标签底座（v43：dtabs + 详情舞台 + 单例标签） =================
    const g1 = await page.evaluate(() => {
      const D = window.XHGCS_DETAILS;
      if (!D) return { hasApi: false };
      D.open({ id: '__t1', name: '测试详情', render: (h) => { h.textContent = 'ok'; } });
      const stage = document.getElementById('detailStage');
      const tabEl = document.querySelector('#detailTabs .dtab.active');
      const scroller = document.getElementById('tabsScroll');
      const sr = scroller.getBoundingClientRect();
      const tr = tabEl ? tabEl.getBoundingClientRect() : null;
      return {
        hasApi: true,
        stageVisible: !!stage && !stage.hidden && stage.getBoundingClientRect().width > 0,
        stageText: stage ? stage.textContent : '',
        bodyDetail: document.body.dataset.detail || '',
        tabText: tabEl ? tabEl.textContent : '',
        tabVisible: !!(tr && tr.left >= sr.left - 1 && tr.right <= sr.right + 1),
        stackHidden: getComputedStyle(document.querySelector('.view-stack')).display === 'none'
      };
    });
    check('G', '详情 API 打开后舞台可见', !!(g1.hasApi && g1.stageVisible && g1.stageText === 'ok'), JSON.stringify(g1));
    check('G', '详情标签激活并滚入视野', g1.bodyDetail === '__t1' && String(g1.tabText).indexOf('测试详情') >= 0 && g1.tabVisible === true, JSON.stringify(g1));
    check('G', '详情打开时图页栈隐藏', g1.stackHidden === true, JSON.stringify(g1));
    const g2 = await page.evaluate(() => {
      const D = window.XHGCS_DETAILS;
      D.open({ id: '__t1', name: '测试详情', render: (h) => { h.textContent = 'ok'; } });
      const dup = document.querySelectorAll('#detailTabs .dtab[data-detail="__t1"]').length;
      D.close('__t1');
      const stage = document.getElementById('detailStage');
      return {
        dup,
        closedHidden: !!stage && stage.hidden,
        bodyDetail: document.body.dataset.detail || '',
        stackBack: getComputedStyle(document.querySelector('.view-stack')).display !== 'none',
        tabGone: document.querySelectorAll('#detailTabs .dtab[data-detail="__t1"]').length === 0
      };
    });
    check('G', '同 id 重复打开只保留一个详情标签', g2.dup === 1, JSON.stringify(g2));
    check('G', '关闭详情后舞台收起、图页栈恢复', g2.closedHidden && g2.bodyDetail === '' && g2.stackBack && g2.tabGone, JSON.stringify(g2));
    const g3 = await page.evaluate(() => {
      const D = window.XHGCS_DETAILS;
      D.open({ id: '__t2', name: '测试详情2', render: (h) => { h.textContent = 'ok2'; } });
      document.querySelector('#plotTabs .ptab').click();
      const stage = document.getElementById('detailStage');
      const dismissed = (document.body.dataset.detail || '') === '' && !!stage && stage.hidden;
      const tabKept = document.querySelectorAll('#detailTabs .dtab[data-detail="__t2"]').length === 1;
      D.close('__t2');
      return { dismissed, tabKept };
    });
    check('G', '点击图页标签切回图页，详情标签保留可回', g3.dismissed && g3.tabKept, JSON.stringify(g3));

    // ================= H. 输入页与侧栏输入视图（v43：协议 + 串口合并为「输入」） =================
    await page.click('#sideNav [data-nav="input"]');
    await page.waitForTimeout(600);
    const h1 = await page.evaluate(() => {
      const page = document.getElementById('view-input');
      const side = document.getElementById('sideInput');
      const secs = Array.from(document.querySelectorAll('.widgetbox .wb-scroll > .wb-sec'));
      return {
        view: document.body.dataset.view,
        pageVisible: !!page && page.classList.contains('active') && page.getBoundingClientRect().height > 300,
        railActive: document.querySelector('#sideNav [data-nav="input"]').classList.contains('active'),
        sideVisible: !!side && getComputedStyle(side).display !== 'none',
        secHidden: secs.length >= 4 && secs.every((el) => getComputedStyle(el).display === 'none'),
        linkRow: !!document.getElementById('sideLinkRow'),
        savedList: !!document.getElementById('sideSavedList'),
        presets: document.querySelectorAll('#enginePresets .engine-preset').length
      };
    });
    check('H', '输入页可打开且 rail 高亮', h1.view === 'input' && h1.pageVisible && h1.railActive, JSON.stringify(h1));
    check('H', '侧栏切为输入视图（链路行 + 已保存），四分区隐藏', h1.sideVisible && h1.secHidden && h1.linkRow && h1.savedList, JSON.stringify(h1));
    check('H', '输入页协议预设随页渲染', h1.presets >= 5, JSON.stringify(h1));
    await page.evaluate(() => { document.querySelector('#plotTabs .ptab').click(); });
    await page.waitForTimeout(250);
    const h2 = await page.evaluate(() => ({
      view: document.body.dataset.view || '',
      waveActive: document.getElementById('view-wave').classList.contains('active')
    }));
    check('H', '输入页点图页标签切回可视化', h2.view === 'wave' && h2.waveActive, JSON.stringify(h2));
    await page.click('#sideNav [data-nav="visual"]');

    // ================= I. 输入页 UART 卡（v43：自绘下拉 + 停止位 + 参数落盘） =================
    await page.click('#sideNav [data-nav="input"]');
    await page.waitForTimeout(400);
    const i1 = await page.evaluate(() => ({
      btns: ['uartBaudBtn', 'uartDataBitsBtn', 'uartParityBtn', 'uartStopBitsBtn'].every((id) => !!document.getElementById(id)),
      switchEl: !!document.getElementById('uartOpenSwitch'),
      pick: !!document.getElementById('uartPickPort'),
      dotRed: (() => {
        const el = document.getElementById('sideLinkDot');
        return !!el && !el.classList.contains('ok');
      })()
    }));
    check('I', 'UART 卡四个下拉、开关、选口按钮齐全', i1.btns && i1.switchEl && i1.pick, JSON.stringify(i1));
    check('I', '侧栏链路点为断开态（红）', i1.dotRed, JSON.stringify(i1));
    if (i1.btns) {
      await page.click('#uartBaudBtn');
      const menuOpen = await page.evaluate(() => {
        const menu = document.querySelector('.uart-menu');
        return !!menu && menu.getBoundingClientRect().width > 20;
      });
      await page.keyboard.press('Escape');
      const menuClosed = await page.evaluate(() => !document.querySelector('.uart-menu'));
      check('I', '下拉菜单打开且 Esc 可收起', menuOpen && menuClosed, 'open=' + menuOpen + ' closed=' + menuClosed);
      await page.click('#uartStopBitsBtn');
      await page.click('.uart-menu [data-value="2"]');
      await page.click('#uartDataBitsBtn');
      await page.click('.uart-menu [data-value="7"]');
      await page.click('#uartParityBtn');
      await page.click('.uart-menu [data-value="Even"]');
      const i2 = await page.evaluate(() => ({
        stopBits: window.XHGCS.state.serial.stopBits,
        dataBits: window.XHGCS.state.serial.dataBits,
        parity: window.XHGCS.state.serial.parity,
        stopLabel: document.getElementById('uartStopBitsBtn').textContent
      }));
      check('I', '停止位/数据位/校验写入状态', i2.stopBits === 2 && i2.dataBits === 7 && i2.parity === 'Even' && /2/.test(i2.stopLabel), JSON.stringify(i2));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && window.XHGCS_LAYOUT), null, { timeout: 15000 });
      await sleep(800);
      await page.click('#sideNav [data-nav="input"]');
      await page.waitForTimeout(500);
      const i3 = await page.evaluate(() => ({
        stopBits: window.XHGCS.state.serial.stopBits,
        dataBits: window.XHGCS.state.serial.dataBits,
        parity: window.XHGCS.state.serial.parity,
        stopLabel: document.getElementById('uartStopBitsBtn') ? document.getElementById('uartStopBitsBtn').textContent : ''
      }));
      check('I', '刷新后串口参数不丢（含停止位）', i3.stopBits === 2 && i3.dataBits === 7 && i3.parity === 'Even' && /2/.test(i3.stopLabel), JSON.stringify(i3));
      const i4 = await page.evaluate(() => {
        const exported = window.XHGCS.exportConfig();
        const data = typeof exported === 'string' ? JSON.parse(exported) : exported;
        const before = data && data.serial ? data.serial.stopBits : null;
        if (data) window.XHGCS.importConfig(data);
        return { before, after: window.XHGCS.state.serial.stopBits };
      });
      check('I', '配置导出/导入往返保留停止位', i4.before === 2 && i4.after === 2, JSON.stringify(i4));
      await page.keyboard.press('Alt+5');
      await page.waitForTimeout(400);
      const i5 = await page.evaluate(() => ({
        view: document.body.dataset.view || '',
        active: (() => { const el = document.getElementById('view-input'); return !!el && el.classList.contains('active'); })()
      }));
      check('I', 'Alt+5 打开输入页', i5.view === 'input' && i5.active, JSON.stringify(i5));
    } else {
      failed++;
      console.log('[FAIL] [I] 下拉菜单用例跳过 —— UART 卡按钮缺失');
      failed++;
      console.log('[FAIL] [I] 参数落盘用例跳过 —— UART 卡按钮缺失');
    }
    await page.click('#sideNav [data-nav="visual"]');

    // ================= J. 输入页协议区（v43：预设即选即用 + AI ＋ + 只读帧预览） =================
    await page.click('#sideNav [data-nav="input"]');
    await page.waitForTimeout(400);
    const j1 = await page.evaluate(() => ({
      presets: document.querySelectorAll('#enginePresets .engine-preset').length,
      aiAdd: !!document.getElementById('btnEngineAiAdd'),
      preview: !!document.getElementById('inputFramePreview'),
      sideW: (() => {
        const el = document.querySelector('#view-input .engine-side');
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
      })()
    }));
    check('J', '协议区预设行 + AI ＋ + 帧预览齐全', j1.presets >= 5 && j1.aiAdd && j1.preview, JSON.stringify(j1));
    check('J', '协议侧栏吃回协议页专属宽度 308', j1.sideW === 308, 'sideW=' + j1.sideW);
    await page.click('#enginePresets [data-preset="wedfc"]');
    await page.waitForTimeout(500);
    const j2 = await page.evaluate(() => {
      const engine = window.XHGCS.getActiveEngine();
      const preview = document.getElementById('inputFramePreview');
      return {
        protocolId: engine ? String(engine.protocolId || '') : '',
        channels: window.XHGCS.state.channels.length,
        preview: preview ? preview.textContent.trim() : ''
      };
    });
    check('J', '点 WED 飞控预设即应用（20 通道）', j2.protocolId === 'wed-fc' && j2.channels === 20, JSON.stringify(j2));
    check('J', '帧预览随预设更新且非空', j2.preview.length > 3 && j2.preview !== '—', JSON.stringify(j2));
    await page.click('#enginePresets [data-preset="json"]');
    await page.waitForTimeout(300);
    await page.click('#sideNav [data-nav="visual"]');

    // ================= K. 保存快照（v43：协议规则 + 通道名字/颜色；保存详情标签） =================
    await page.click('#sideNav [data-nav="input"]');
    await page.waitForTimeout(400);
    const k0 = await page.evaluate(() => ({
      saveName: !!document.getElementById('inputSaveName'),
      saveBtn: !!document.getElementById('btnInputSave')
    }));
    check('K', '保存行（名称 + 保存按钮）齐全', k0.saveName && k0.saveBtn, JSON.stringify(k0));
    if (k0.saveName && k0.saveBtn) {
      await page.click('#enginePresets [data-preset="wedfc"]');
      await page.waitForTimeout(500);
      const kRenamed = await page.evaluate(() => {
        const ch = window.XHGCS.state.channels.find((c) => Number(c.protocolIndex) === 0 && String(c.protocolId || '') === 'wed-fc');
        if (!ch) return false;
        ch.name = '高度A';
        window.XHGCS.persist();
        return true;
      });
      await page.fill('#inputSaveName', 's1');
      await page.click('#btnInputSave');
      await page.waitForTimeout(300);
      const k1 = await page.evaluate(() => ({
        saves: (window.XHGCS.state.inputSaves || []).length,
        rows: document.querySelectorAll('#sideSavedList .side-saved-row').length
      }));
      check('K', '保存后状态与侧栏列表各一条', kRenamed && k1.saves === 1 && k1.rows === 1, JSON.stringify(k1));
      await page.click('#enginePresets [data-preset="json"]');
      await page.waitForTimeout(300);
      await page.click('#sideSavedList .side-saved-row');
      await page.waitForTimeout(350);
      const k2 = await page.evaluate(() => ({
        detail: document.body.dataset.detail || '',
        name: (document.querySelector('#detailStage .saved-name') || {}).textContent || '',
        rows: document.querySelectorAll('#detailStage .saved-chrow').length,
        // v43：标签条是舞台级，从输入页打开详情时仍应可见
        tabbarVisible: (() => {
          const el = document.getElementById('tabsScroll');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 100 && r.height > 10 && r.top >= 0 && r.top < innerHeight / 2;
        })()
      }));
      check('K', '保存详情标签：名称 + 20 行通道表 + 标签条仍可见', k2.detail.indexOf('saved:') === 0 && k2.name === 's1' && k2.rows === 20 && k2.tabbarVisible, JSON.stringify(k2));
      await page.click('#detailStage .saved-load-btn');
      await page.waitForTimeout(450);
      const k3 = await page.evaluate(() => {
        const engine = window.XHGCS.getActiveEngine();
        const ch = window.XHGCS.state.channels.find((c) => Number(c.protocolIndex) === 0 && String(c.protocolId || '') === 'wed-fc');
        return {
          detail: document.body.dataset.detail || '',
          protocolId: engine ? String(engine.protocolId || '') : '',
          channels: window.XHGCS.state.channels.length,
          firstName: ch ? ch.name : ''
        };
      });
      check('K', '加载保存：引擎回 WED 飞控、通道名回填', k3.detail === '' && k3.protocolId === 'wed-fc' && k3.channels === 20 && k3.firstName === '高度A', JSON.stringify(k3));
      const k4 = await page.evaluate(() => {
        const hex = '55 AA 28 46 50 46 50 46 50 27 10 27 10 27 10 27 10 27 10 27 10 03 E8 03 E8 03 E8 04 4C 04 4C 04 4C 04 4C 46 50 4E 20 4E 20 0B B8 6A';
        const bytes = Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
        // 撞名：把槽 0 改成槽 1 的定义名，值映射必须以通道身份而不是名字为键
        const slots = window.XHGCS.state.channels.filter((c) => String(c.protocolId || '') === 'wed-fc');
        if (slots[0] && slots[1]) { slots[0].name = slots[1].name; window.XHGCS.persist(); }
        const engine = window.XHGCS.getActiveEngine();
        const parsed = window.XHGCS_SERIAL.parseFrame(engine, bytes);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        window.XHGCS.injectRealValues(parsed.values, { t: null, engine: engine, raw: bytes });
        return { ok: true, keys: Object.keys(parsed.values).length, channels: window.XHGCS.state.channels.length };
      });
      check('K', 'WED 改名/撞名后收帧不建重复通道且槽位不丢', k4.ok === true && k4.keys === 20 && k4.channels === 20, JSON.stringify(k4));
      await page.click('#sideSavedList .side-saved-row');
      await page.waitForTimeout(300);
      await page.click('#detailStage .saved-delete-btn');
      await page.waitForTimeout(300);
      const k5 = await page.evaluate(() => ({
        saves: (window.XHGCS.state.inputSaves || []).length,
        detail: document.body.dataset.detail || '',
        empty: (() => {
          const el = document.getElementById('sideSavedEmpty');
          return !!el && getComputedStyle(el).display !== 'none';
        })()
      }));
      check('K', '删除保存：列表清空、详情收起、空态可见', k5.saves === 0 && k5.detail === '' && k5.empty, JSON.stringify(k5));
    } else {
      for (const name of ['保存后状态与侧栏列表各一条', '保存详情标签', '加载保存', 'WED 改名收帧', '删除保存']) {
        failed++;
        console.log('[FAIL] [K] ' + name + ' —— 保存行缺失');
      }
    }
    await page.click('#sideNav [data-nav="visual"]');

    // ================= L. 暂停 = 冻结查看（v43：数据继续接收，恢复回到现在） =================
    await page.evaluate(() => {
      window.XHGCS.state.simulation.enabled = true;
      window.XHGCS.state.playing = true;
    });
    await sleep(700);
    const l1 = await page.evaluate(() => ({
      t: window.XHGCS.state.t,
      view: window.XHGCS_VIEWS.getChartView()
    }));
    await page.click('#btnPlay');
    await page.waitForTimeout(250);
    const l2 = await page.evaluate(() => ({
      frozen: window.XHGCS_VIEWS.isChartFrozen ? window.XHGCS_VIEWS.isChartFrozen() : null,
      title: document.getElementById('btnPlay').title,
      view: window.XHGCS_VIEWS.getChartView()
    }));
    await sleep(700);
    const l3 = await page.evaluate(() => ({
      t: window.XHGCS.state.t,
      view: window.XHGCS_VIEWS.getChartView(),
      status: document.getElementById('statusInfo').textContent || ''
    }));
    check('L', '暂停后进入冻结态（按钮与页脚同步）', l2.frozen === true && /继续|回到/.test(l2.title) && /视图已暂停/.test(l3.status), JSON.stringify(l2) + ' status=' + l3.status);
    check('L', '冻结期间数据继续推进、窗口停在冻结时刻', l3.t > l1.t + 0.2 && Math.abs(l3.view.xEnd - l2.view.xEnd) < 0.11 && l3.view.follow === false, 't ' + l1.t + '→' + l3.t + ' xEnd ' + l2.view.xEnd + '→' + l3.view.xEnd);
    const chartBox = await page.locator('.ctrl-view').boundingBox();
    if (chartBox) {
      await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(250);
    }
    const l3b = await page.evaluate(() => ({
      frozen: window.XHGCS_VIEWS.isChartFrozen(),
      status: document.getElementById('statusInfo').textContent || ''
    }));
    check('L', '冻结后滚轮缩放仍保持冻结态', l3b.frozen === true && /视图已暂停/.test(l3b.status), JSON.stringify(l3b));
    await page.click('#btnPlay');
    await page.waitForTimeout(250);
    const l4 = await page.evaluate(() => ({
      frozen: window.XHGCS_VIEWS.isChartFrozen(),
      view: window.XHGCS_VIEWS.getChartView(),
      t: window.XHGCS.state.t
    }));
    check('L', '恢复后回到跟随现在', l4.frozen === false && l4.view.follow === true && l4.view.xEnd > l3.view.xEnd - 0.01, JSON.stringify(l4));

    // ================= D. 字号 / 文案 / CSS content（dark + light） =================
    const scan = async () => page.evaluate((payload) => {
      const { fontAllowed, fontBoardOnly, textPatterns, whitelist, contentWhitelist } = payload;
      const allowed = new Set(fontAllowed);
      const boardOnly = new Set(fontBoardOnly);
      const boardOpen = !!document.querySelector('.board-mask');
      const visible = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      const badFonts = [];
      const badText = [];
      const textWhitelist = whitelist;
      const textPatternsRe = textPatterns.map((entry) => new RegExp(entry.source, entry.flags || ''));
      document.querySelectorAll('body *').forEach((el) => {
        if (!visible(el)) return;
        const txt = ownText(el);
        if (!txt) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (!allowed.has(fs) && !(boardOpen && boardOnly.has(fs))) {
          badFonts.push((el.tagName || '').toLowerCase() + '.' + String(el.className || '').split(/\s+/).slice(0, 2).join('.') + ' "' + txt.slice(0, 20) + '" ' + fs + 'px');
        }
        if (!textWhitelist.some((entry) => txt.indexOf(entry.text) >= 0) && textPatternsRe.some((re) => re.test(txt))) {
          badText.push((el.tagName || '').toLowerCase() + ' "' + txt.slice(0, 40) + '"');
        }
      });
      // CSS content 中文扫描（递归 @media / @supports 等）
      const badContent = [];
      const collect = (rules, origin) => {
        for (const rule of rules) {
          if (rule.cssRules) { collect(rule.cssRules, origin); continue; }
          if (!rule.style) continue;
          const content = rule.style.getPropertyValue('content');
          if (!content) continue;
          const val = content.replace(/^['"]|['"]$/g, '');
          if (!/[\u4e00-\u9fa5]/.test(val)) continue;
          if (contentWhitelist.some((entry) => val.indexOf(entry.text) >= 0)) continue;
          badContent.push((rule.selectorText || '') + ' content=' + JSON.stringify(val));
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        let rules = null;
        try { rules = sheet.cssRules; } catch (err) { continue; }
        if (rules) collect(rules, sheet.href || 'inline');
      }
      return { badFonts: badFonts.slice(0, 10), badText: badText.slice(0, 10), badContent: badContent.slice(0, 10) };
    }, {
      fontAllowed: FONT_ALLOWED,
      fontBoardOnly: FONT_BOARD_ONLY,
      textPatterns: TEXT_SENTENCE_PATTERNS.map((re) => ({ source: re.source, flags: re.flags })),
      whitelist: WHITELISTS.text,
      contentWhitelist: WHITELISTS.cssContent
    });
    // D-源码：CSS content 中文逐条判定（src/** + assets/**）
    const sourceHits = scanSourceContent();
    const sourceBad = [];
    sourceHits.forEach((hit) => {
      const allowed = WHITELISTS.cssContent.find((entry) => hit.value.indexOf(entry.text) >= 0);
      const label = hit.file + ":" + hit.line + " " + JSON.stringify(hit.value);
      if (allowed) pass("D", "content 名词短语 " + label + "（" + allowed.decidedBy + "）");
      else { sourceBad.push(label); fail("D", "content 未裁决中文 " + label); }
    });
    check("D", "源码 content 中文扫描无非白名单项（" + sourceHits.length + " 条命中明细见上）", sourceBad.length === 0, sourceBad.slice(0, 8).join(" | "));
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { window.XHGCS.setTheme(t); window.XHGCS.setFx('glass'); }, theme);
      await sleep(350);
      const res = await scan();
      check('D', theme + ' 主题字号只出现 10/11/12/13/14/16', res.badFonts.length === 0, res.badFonts.join(' | '));
      check('D', theme + ' 主题无解释性整句可见文本', res.badText.length === 0, res.badText.join(' | '));
      check('D', theme + ' 主题 CSS content 中文无非白名单句子', res.badContent.length === 0, res.badContent.join(' | '));
    }
    await page.evaluate(() => window.XHGCS.setTheme('dark'));

    // ================= M. 窄窗 1100×720（v43：不横向溢出、输入页两卡可见） =================
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.waitForTimeout(500);
    const m1 = await page.evaluate(() => {
      const out = [];
      const vis = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      // 祖先里有横向滚动容器的元素不算溢出：内容可达（窄屏工具条按设计横滚收口）
      const inScroller = (el) => {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (/(auto|scroll)/.test(cs.overflowX)) return true;
        }
        return false;
      };
      document.querySelectorAll('body *').forEach((el) => {
        if (!vis(el)) return;
        const r = el.getBoundingClientRect();
        if ((r.right > innerWidth + 1 || r.left < -1) && !inScroller(el)) out.push((el.tagName || '').toLowerCase() + '.' + String(el.className || '').split(/\s+/).slice(0, 2).join('.'));
      });
      return { overflow: out.slice(0, 8), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
    });
    check('M', '1100 宽无横向溢出', m1.overflow.length === 0 && m1.scrollW <= m1.innerW + 1, JSON.stringify(m1));
    await page.click('#sideNav [data-nav="input"]');
    await page.waitForTimeout(450);
    const m2 = await page.evaluate(() => {
      const link = document.getElementById('inputLinkCard');
      const proto = document.getElementById('inputProtoCard');
      const uart = Array.from(document.querySelectorAll('.uart-dd')).every((el) => el.getBoundingClientRect().right <= innerWidth + 1);
      const workspaceEl = document.querySelector('.input-workspace');
      const main = proto ? proto.querySelector('.engine-main') : null;
      return {
        linkW: link ? Math.round(link.getBoundingClientRect().width) : 0,
        protoW: proto ? Math.round(proto.getBoundingClientRect().width) : 0,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        uartInside: uart,
        fit: workspaceEl ? workspaceEl.scrollWidth <= workspaceEl.clientWidth + 1 : false
      };
    });
    check('M', '1100 宽输入页两卡可见、协议主区不被挤扁、UART 不出窗且工作区无横向滚动', m2.linkW > 200 && m2.protoW > 200 && m2.mainW >= 200 && m2.uartInside && m2.fit, JSON.stringify(m2));
    const m3 = await page.evaluate(() => {
      const bar = document.getElementById('wsTabbar').getBoundingClientRect();
      const head = document.querySelector('#view-input .page-head').getBoundingClientRect();
      return { barBottom: Math.round(bar.bottom), headTop: Math.round(head.top) };
    });
    check('M', '输入页页面内容整体在标签条下方（不重叠）', m3.headTop >= m3.barBottom - 1, JSON.stringify(m3));
    await page.click('#sideNav [data-action="ai"]');
    await page.waitForTimeout(450);
    const m4 = await page.evaluate(() => {
      const main = document.querySelector('#view-input .engine-main');
      return {
        aiOpen: !!document.querySelector('.app.ai-open'),
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0
      };
    });
    check('M', '1100 宽 + AI 列打开时协议主区仍可用（≥200）', m4.aiOpen === true && m4.mainW >= 200, JSON.stringify(m4));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(300);
    await page.click('#sideNav [data-nav="visual"]');

    // ================= N. 空态「查看协议」按需加载协议区（v43） =================
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.XHGCS && window.XHGCS.state && window.XHGCS_LAYOUT), null, { timeout: 15000 });
    await sleep(800);
    await page.evaluate(() => {
      window.XHGCS.state.simulation.enabled = false;
      window.XHGCS.allChannels().forEach((ch) => { ch.data.length = 0; });
    });
    await sleep(600);
    const n0 = await page.evaluate(() => ({
      engineUiLoaded: !!window.XHGCS_ENGINE_UI,
      emptyVisible: (() => {
        const el = document.getElementById('chartEmpty');
        return !!el && !el.classList.contains('hidden');
      })()
    }));
    if (n0.emptyVisible) {
      await page.click('[data-empty-action="protocol"]');
      await page.waitForTimeout(900);
      const n1 = await page.evaluate(() => ({
        view: document.body.dataset.view || '',
        loaded: !!window.XHGCS_ENGINE_UI,
        presets: document.querySelectorAll('#enginePresets .engine-preset').length
      }));
      check('N', '空态「查看协议」直达输入页并加载协议区', n0.engineUiLoaded === false && n1.view === 'input' && n1.loaded && n1.presets >= 5, JSON.stringify({ n0, n1 }));
    } else {
      failed++;
      console.log('[FAIL] [N] 空态「查看协议」用例跳过 —— 空态未显示 ' + JSON.stringify(n0));
    }
    await page.evaluate(() => { window.XHGCS.state.simulation.enabled = true; });
    await sleep(500);
    await page.click('#sideNav [data-nav="visual"]');

    // ================= E. 控制台 =================
    check('E', 'console error == 0', consoleErrors.filter((e) => e.indexOf('console:') === 0).length === 0, consoleErrors.filter((e) => e.indexOf('console:') === 0).slice(0, 5).join(' | '));
    check('E', 'pageerror == 0', consoleErrors.filter((e) => e.indexOf('pageerror:') === 0).length === 0, consoleErrors.filter((e) => e.indexOf('pageerror:') === 0).slice(0, 5).join(' | '));
  } catch (err) {
    failed++;
    console.log('[FAIL] [X] 脚本执行中断 —— ' + (err && err.message ? err.message : String(err)));
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('跑不起来：' + (err && err.message ? err.message : String(err)));
  process.exit(2);
});
