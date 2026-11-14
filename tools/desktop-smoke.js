// 桌面版冒烟测试：node tools/desktop-smoke.js [cdpPort] [--settings]
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error('缺少 playwright：请先在项目目录执行 npm install');
  process.exit(2);
}

const cdpPort = Number(process.argv[2] || 9222);
const openSettings = process.argv.includes('--settings');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort);
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => p.url().includes('index.html'));
  if (!page) throw new Error('未找到主界面页面');

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => ({
    desktopBridge: !!window.XHGCS_DESKTOP,
    desktopUi: !!window.XHGCS_DESKTOP_UI,
    isDesktopClass: document.body.classList.contains('is-desktop'),
    chip: (document.getElementById('desktopChip') || {}).textContent || null,
    mcpEnabled: window.XHGCS && window.XHGCS.state ? window.XHGCS.state.mcp.enabled : null,
    bridgeConnected: window.XHGCS_BRIDGE ? window.XHGCS_BRIDGE.isConnected() : null,
    serialSupported: typeof navigator.serial !== 'undefined',
    channelCount: window.XHGCS ? window.XHGCS.state.channels.length : null,
    scripts: window.XHGCS ? window.XHGCS.state.scripts.length : null,
    engines: window.XHGCS ? window.XHGCS.state.engines.length : null,
    components: window.XHGCS && window.XHGCS.state.components ? window.XHGCS.state.components.length : null,
    versions: window.XHGCS_DESKTOP ? window.XHGCS_DESKTOP.versions : null
  }));
  console.log('INFO ' + JSON.stringify(info, null, 2));

  if (openSettings) {
    await page.click('[data-action="settings"]');
    await page.waitForTimeout(700);
    await page.click('.settings-nav-btn[data-settings-nav="desktop"]');
    await page.waitForTimeout(2000);
    const panel = await page.evaluate(() => (document.getElementById('desktopPanel') || {}).innerText || null);
    console.log('PANEL\n' + panel);
  }

  await page.screenshot({ path: 'tools/desktop-screenshot.png' });
  console.log('ERRORS ' + JSON.stringify(errors));
  process.exit(errors.length ? 2 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
