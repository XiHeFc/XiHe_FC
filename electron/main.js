'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startStaticServer } = require('./static-server');
const { createStore } = require('./store');
const { createServices, probeJson } = require('./services');
const { createRecorder } = require('./recorder');
const { createAiTaskService, resolveDshEntry } = require('./ai/task-service');
const { createDshWebService, paletteCss } = require('./ai/dsh-web');
const { readSettings: readDshSettings, applySettings: applyDshSettings, webHome: dshWebHome, listPlugins: listDshPlugins, listPresets: listDshPresets, hasCredentials: dshHasCredentials, MODEL_CATALOG: DSH_MODEL_CATALOG } = require('./ai/dsh-settings');
const { findTargetBase } = require('./ai/dsh-ui-overlay');
const { createClientIntegrations } = require('./integrations/clients');

// 改名「璇玑」（Xuanji）：旧数据目录整体迁移到新名字（XiHe_Vofa 优先，更早的 XiHe GCS PRO 兜底）。
// 迁移失败（目录被占用等）就继续用旧目录——宁可目录名旧一点，也不能丢历史配置与录制。
(function migrateUserDataDir() {
  const appData = process.env.APPDATA || app.getPath('appData');
  const nextDir = path.join(appData, 'Xuanji');
  const sources = ['XiHe_Vofa', 'XiHe GCS PRO'];
  try {
    if (!fs.existsSync(nextDir)) {
      for (const name of sources) {
        const dir = path.join(appData, name);
        if (fs.existsSync(dir)) { try { fs.renameSync(dir, nextDir); break; } catch (err) {} }
      }
    }
  } catch (err) {}
  try {
    if (fs.existsSync(nextDir)) app.setPath('userData', nextDir);
    else {
      for (const name of sources) {
        const dir = path.join(appData, name);
        if (fs.existsSync(dir)) { app.setPath('userData', dir); break; }
      }
    }
  } catch (err) {}
})();

const isDev = process.argv.includes('--dev') || !app.isPackaged;
// XHGCS_WEB_PORT 只用于开发期并行跑第二实例（同机已开着装机版时），装机版不读这个变量。
const DEFAULT_WEB_PORT = Number(process.env.XHGCS_WEB_PORT) || 8123;
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 980;

let mainWindow = null;
let staticServer = null;
let webPort = DEFAULT_WEB_PORT;
let store = null;
let services = null;
let aiService = null;
let dshWeb = null;
let clientIntegrations = null;
let recorder = null;
let logStream = null;
let quitting = false;
let logsDir = '';
let serialPorts = [];
let serialChoice = null;
let serialSeq = 0;
let winListCache = { at: 0, ok: false, ports: [] };
const SERIAL_CHOICE_TIMEOUT_MS = 60000;
const WIN_LIST_TTL_MS = 5000;
const WIN_LIST_TIMEOUT_MS = 3000;

// 当前运行实例的身份。launcher 与外部 MCP 客户端通过实例记录确认
// 「连的是这个窗口、这个工作区」，而不是端口上的任意进程。
const instanceId = crypto.randomUUID();
const instanceStartedAt = new Date().toISOString();
let workspaceId = '';
let instanceFile = '';

function writeInstanceRecord(bridge) {
  if (!instanceFile || !services) return;
  try {
    fs.mkdirSync(path.dirname(instanceFile), { recursive: true });
    const payload = {
      schema: 1,
      instanceId: instanceId,
      workspaceId: workspaceId,
      pid: process.pid,
      webPort: webPort,
      bridgePort: (bridge && bridge.port) || services.bridgePort(),
      bridgeToken: services.bridgeToken(),
      bridgeSha: String((bridge && bridge.sha) || ''),
      appVersion: app.getVersion(),
      startedAt: instanceStartedAt,
      protocolVersion: '2024-11-05'
    };
    fs.writeFileSync(instanceFile, JSON.stringify(payload, null, 2), 'utf8');
    log('instance record written ' + instanceFile);
  } catch (error) {
    log('instance record failed: ' + error.message);
  }
}

function removeInstanceRecord() {
  if (!instanceFile) return;
  try {
    fs.unlinkSync(instanceFile);
  } catch (error) {
    /* 文件不存在或已被清理 */
  }
}

async function bridgeHealth() {
  if (!services) return null;
  const port = services.bridgePort();
  const health = await probeJson(port, '/api/health', 1200);
  return health ? Object.assign({ port: port }, health) : { port: port, ok: false };
}

function appRoot() {
  return app.getAppPath();
}

// 外部 MCP 客户端的稳定入口：装机版用安装目录里的 xuanji-mcp.cmd；
// 开发模式用 node + 源码 launcher。
function launcherEntry() {
  if (app.isPackaged) {
    return { mode: 'packaged', command: 'cmd.exe', args: ['/c', path.join(path.dirname(process.execPath), 'xuanji-mcp.cmd')] };
  }
  return { mode: 'dev', command: 'node', args: [path.join(appRoot(), 'mcp-server', 'launcher.mjs')] };
}

/**
 * 用户插件目录：装机版里唯一可写、且不在 app.asar 里的扩展位置。
 * 打包后 appRoot() 指向只读的 app.asar，用户不可能往里加插件 —— 这是「可安装插件」的前提。
 */
function userExtensionsDir() {
  return path.join(app.getPath('userData'), 'extensions');
}

function ensureExtensionsDir() {
  const dir = userExtensionsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log('extensions dir failed: ' + err.message);
  }
  return dir;
}

/**
 * 扫描用户扩展目录。只认 `<id>/xhgcs.extension.json` 且清单 id 必须等于目录名；
 * 入口文件必须留在插件目录内（符号链接逃逸一并拒绝），并通过 /ext 路由暴露给渲染层。
 */
function listUserExtensions() {
  const dir = ensureExtensionsDir();
  const items = [];
  let realRoot = dir;
  try {
    realRoot = fs.realpathSync(dir);
  } catch (err) {
    /* 目录刚建好一般不会失败 */
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { dir, items, error: err && err.message ? err.message : String(err) };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const pluginDir = path.join(dir, id);
    const manifestPath = path.join(pluginDir, 'xhgcs.extension.json');
    if (!fs.existsSync(manifestPath)) continue;
    let realPlugin = pluginDir;
    try {
      realPlugin = fs.realpathSync(pluginDir);
    } catch (err) {
      /* 退化为普通路径 */
    }
    if (realPlugin !== realRoot && !realPlugin.startsWith(realRoot + path.sep)) {
      items.push({ dirName: id, error: '插件目录逃逸出扩展根目录，已拒绝' });
      continue;
    }
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      items.push({ dirName: id, error: '清单不是合法 JSON：' + (err && err.message ? err.message : err) });
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || manifest.id !== id) {
      items.push({ dirName: id, error: '清单 id 必须与目录名一致（' + id + '）' });
      continue;
    }
    const main = typeof manifest.main === 'string' ? manifest.main : '';
    if (main && main !== 'inline') {
      const mainPath = path.resolve(pluginDir, main);
      if (mainPath !== realPlugin && !mainPath.startsWith(realPlugin + path.sep)) {
        items.push({ dirName: id, error: '入口文件逃逸插件目录：' + main });
        continue;
      }
      if (!fs.existsSync(mainPath)) {
        items.push({ dirName: id, error: '入口文件不存在：' + main });
        continue;
      }
      manifest.main = '/ext/' + encodeURIComponent(id) + '/' + main.split(path.sep).join('/');
    }
    items.push({ dirName: id, manifest, baseUrl: '/ext/' + encodeURIComponent(id) + '/' });
  }
  return { dir, items };
}

function log(message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n';
  if (logStream) {
    try {
      logStream.write(line);
    } catch (error) {
      /* ignore */
    }
  }
  if (isDev) process.stdout.write(line);
}

function iconPath() {
  const candidates = [
    path.join(appRoot(), 'assets', 'icon.png'),
    path.join(appRoot(), 'build', 'icon.png'),
    path.join(appRoot(), 'build', 'icon.ico')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function windowState() {
  const saved = store.get('window') || {};
  const width = Number(saved.width) >= 900 ? Math.round(saved.width) : DEFAULT_WIDTH;
  const height = Number(saved.height) >= 600 ? Math.round(saved.height) : DEFAULT_HEIGHT;
  const state = { width, height, maximized: !!saved.maximized };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    state.x = Math.round(saved.x);
    state.y = Math.round(saved.y);
  }
  return state;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  store.patch({
    window: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized()
    }
  });
}

// 退出清理。before-quit 会跑，但 app.exit() 不会派发 before-quit —— 所以
// desktop:relaunch 那条路必须自己调一次，否则每次「重新启动」都会留下孤儿 MCP 桥
// 进程、录制会话不写 manifest 结尾、配置不 flush、静态服务端口被占着。
function shutdown() {
  if (quitting) return;
  quitting = true;
  saveWindowState();
  removeInstanceRecord();
  if (recorder) recorder.stop('quit');
  if (aiService) aiService.dispose();
  if (dshWeb) dshWeb.dispose();
  if (store) store.flush();
  if (services) services.dispose();
  if (staticServer) {
    try {
      staticServer.close();
    } catch (error) {
      /* ignore */
    }
  }
  log('app quitting');
}

async function statusPayload() {
  const serviceStatus = services
    ? await services.status()
    : { bridge: { running: false, port: 8787 }, tts: { running: false, available: false, enabled: false } };
  return {
    isDesktop: true,
    productName: '璇玑',
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    dev: isDev,
    webPort,
    webUrl: 'http://127.0.0.1:' + webPort + '/index.html',
    bridge: serviceStatus.bridge,
    ai: {
      instanceId: instanceId,
      workspaceId: workspaceId,
      instanceFile: instanceFile,
      write: store ? store.get('mcpWrite') === true : false
    },
    tts: serviceStatus.tts,
    autoTts: services ? services.autoTts() : false,
    ttsAvailable: services ? services.ttsAvailable() : false,
    logsDir,
    userDataDir: app.getPath('userData'),
    extensionsDir: userExtensionsDir(),
    appRoot: appRoot(),
    lastSerialPort: store.get('lastSerialPort') || '',
    recordings: recorder ? recorder.status() : null
  };
}

function appOrigin() {
  return 'http://127.0.0.1:' + webPort;
}

/** 渲染层必须是本机应用 origin 的主框架；任何远程/子框架来源都不许调 IPC */
function isTrustedSender(event) {
  try {
    const frame = event && event.senderFrame;
    const url = String((frame && frame.url) || '');
    if (!url) return false;
    return url === appOrigin() || url.indexOf(appOrigin() + '/') === 0;
  } catch (err) {
    return false;
  }
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) {
    log('ipc rejected from untrusted frame: ' + (event && event.senderFrame ? event.senderFrame.url : 'unknown'));
    throw new Error('IPC 来源不可信');
  }
}

/** 所有 IPC 统一经过来源校验，避免逐个 handler 漏写 */
function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

function registerIpc() {
  handleTrusted('desktop:status', () => statusPayload());

  // 自绘窗口按钮（渲染层）→ 主进程。返回是否最大化，界面据此换图标。
  handleTrusted('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });
  handleTrusted('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  handleTrusted('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });
  handleTrusted('window:state', () => ({
    maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  }));

  // 长时数据落盘：主进程同步追加，渲染层只负责批量缓冲
  handleTrusted('recorder:status', () => (recorder ? recorder.status() : null));

  handleTrusted('recorder:start', (event, manifest) => {
    if (!recorder) return null;
    const result = recorder.start(manifest);
    log('recorder start ' + result.session.sessionId + ' ' + result.session.dir);
    return result;
  });

  handleTrusted('recorder:append', (event, text, rowCount) => {
    if (!recorder) return { ok: false, reason: 'unavailable' };
    return recorder.append(text, rowCount);
  });

  handleTrusted('recorder:stop', (event, reason) => {
    if (!recorder) return null;
    const result = recorder.stop(reason || 'stop');
    if (result) log('recorder stop ' + result.sessionId + ' rows=' + result.rows + ' bytes=' + result.bytes);
    return result;
  });

  handleTrusted('recorder:list', () => (recorder ? recorder.list() : []));

  handleTrusted('recorder:clear', () => (recorder ? recorder.clearAll() : null));

  handleTrusted('recorder:configure', (event, next) => {
    if (!recorder) return null;
    const config = recorder.configure(next);
    store.set('recording', config);
    return config;
  });

  handleTrusted('recorder:open', () => {
    if (!recorder) return 'unavailable';
    fs.mkdirSync(recorder.dir, { recursive: true });
    return shell.openPath(recorder.dir);
  });

  handleTrusted('desktop:restart-services', async () => {
    log('restart local services requested');
    const result = await services.restartAll();
    writeInstanceRecord(result && result.bridge);
    return statusPayload();
  });

  // AI 连接页：实例身份、真实健康状态与工具数量。令牌只单独通道返回，
  // 不混在诊断对象里，避免被“复制诊断”带出去。
  handleTrusted('desktop:bridge-token', () => (services ? services.bridgeToken() : ''));

  handleTrusted('desktop:ai-bridge', async () => {
    const health = await bridgeHealth();
    const bridgeOk = Boolean(health && health.ok === true && health.name === 'xhgcs');
    const instance = {
      instanceId: instanceId,
      workspaceId: workspaceId,
      instanceFile: instanceFile,
      pid: process.pid,
      startedAt: instanceStartedAt,
      bridgePort: services ? services.bridgePort() : 0,
      write: store.get('mcpWrite') === true
    };
    const checks = {
      instanceFile: instanceFile ? fs.existsSync(instanceFile) : false,
      process: true,
      bridge: bridgeOk,
      identity: Boolean(bridgeOk && String(health.instanceId || '') === instanceId),
      token: Boolean(services && services.bridgeToken())
    };
    // 外部客户端配置用的稳定入口：装机版是安装目录里的 xuanji-mcp.cmd，
    // 开发模式是 node + 源码里的 launcher.mjs。
    const launcher = launcherEntry();
    return {
      instance: instance,
      checks: checks,
      bridge: health,
      tools: Number(health && health.tools) || 0,
      write: Boolean(health && health.write),
      launcher: launcher
    };
  });

  handleTrusted('desktop:bridge-config', async (event, patch) => {
    const data = patch && typeof patch === 'object' ? patch : {};
    if (data.port != null) {
      const port = Number(data.port);
      if (!Number.isFinite(port) || port < 1024 || port > 65535) {
        return { ok: false, error: '端口必须在 1024–65535 之间' };
      }
      store.set('bridgePort', Math.round(port));
    }
    if (data.write != null) store.set('mcpWrite', Boolean(data.write));
    if (data.rotateToken) store.set('bridgeToken', crypto.randomBytes(24).toString('hex'));
    if (data.enabled === false) {
      services.stopBridge();
      removeInstanceRecord();
      return { ok: true, enabled: false };
    }
    const changed = data.port != null || data.write != null || data.rotateToken;
    if (changed) {
      services.stopBridge();
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    const bridge = await services.ensureBridge();
    writeInstanceRecord(bridge);
    if (aiService && (data.write != null || data.port != null || data.rotateToken || data.enabled === false)) {
      // 权限/端口变化后旧会话里的工具列表已经过期，重建会话
      aiService.resetSession().catch(() => {});
    }
    return { ok: Boolean(bridge && bridge.running), bridge: bridge, enabled: true };
  });

  // 软件内 AI 会话（默认 DSH / ACP）。渲染层只发文本，进程与会话都在主进程。
  handleTrusted('ai:status', () => (aiService ? aiService.status() : { ok: false, available: false }));
  handleTrusted('ai:generate-view', (event, text) => {
    if (!aiService) throw new Error('内置助手尚未就绪');
    return aiService.generateView(text);
  });
  handleTrusted('ai:send', (event, text) => (aiService ? aiService.send(text) : { ok: false, error: 'AI 服务未就绪' }));
  handleTrusted('ai:cancel', () => (aiService ? aiService.cancel() : { ok: false }));
  handleTrusted('ai:clear', () => (aiService ? aiService.clear() : { ok: false }));
  // 随包 DSH 的 Web UI：主进程起本地服务，渲染层在「对话」页嵌入
  handleTrusted('ai:web', (event, opts) => (dshWeb ? dshWeb.start(opts || {}) : { ok: false, error: 'AI 服务未就绪' }));
  handleTrusted('ai:web-status', () => (dshWeb ? dshWeb.info() : { ok: false, status: 'idle' }));
  handleTrusted('ai:web-stop', () => (dshWeb ? dshWeb.stop() : { ok: false }));
  // 软件设置里的「内置 AI」：在指定 DSH 子框架里点它自己的设置按钮
  handleTrusted('ai:open-settings', async (event, options) => {
    const frameName = options && options.frameName ? String(options.frameName) : '';
    const info = dshWeb ? dshWeb.info() : null;
    if (!info || !info.url) return { ok: false, error: 'DSH 尚未启动' };
    let dshOrigin = '';
    try { dshOrigin = new URL(info.url).origin; } catch (err) { return { ok: false, error: 'DSH 地址无效' }; }
    const all = [];
    const walk = (frame) => {
      if (!frame) return;
      all.push(frame);
      for (const child of (frame.frames || [])) walk(child);
    };
    walk(event.sender.mainFrame);
    const candidates = all.filter((frame) => {
      try { return Boolean(frame.url) && new URL(frame.url).origin === dshOrigin; } catch (err) { return false; }
    });
    let target = null;
    if (frameName) {
      for (const frame of candidates) {
        try {
          const name = await frame.executeJavaScript('window.name', false);
          if (name === frameName) { target = frame; break; }
        } catch (err) { /* 换个框架继续找 */ }
      }
    } else if (candidates.length) {
      target = candidates[0];
    }
    if (!target) return { ok: false, error: '找不到 DSH 界面' };
    try {
      const clicked = await target.executeJavaScript(
        "(function(){var b=document.querySelector('.VOzbGW_trigger'); if(!b) return false; b.click(); return true;})()",
        true
      );
      if (!clicked) return { ok: false, error: 'DSH 设置按钮未找到' };
      await new Promise((resolve) => setTimeout(resolve, 500));
      const open = await target.executeJavaScript(
        "(function(){var p=document.querySelector('.VOzbGW_panel'); return Boolean(p) && p.getBoundingClientRect().width > 0;})()",
        false
      ).catch(() => false);
      return { ok: true, open: Boolean(open) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  // 应用主题切换时，实时把新配色注入已打开的 DSH 视图（聊天面板与设置页）
  handleTrusted('ai:palette', async (event, options) => {
    const palette = options && options.palette;
    if (!palette || !dshWeb) return { ok: false };
    const info = dshWeb.info();
    if (!info || !info.url) return { ok: false, error: 'DSH 尚未启动' };
    let dshOrigin = '';
    try { dshOrigin = new URL(info.url).origin; } catch (err) { return { ok: false, error: 'DSH 地址无效' }; }
    const css = paletteCss(palette);
    const all = [];
    const walk = (frame) => {
      if (!frame) return;
      all.push(frame);
      for (const child of (frame.frames || [])) walk(child);
    };
    walk(event.sender.mainFrame);
    const frames = all.filter((frame) => {
      try { return Boolean(frame.url) && new URL(frame.url).origin === dshOrigin; } catch (err) { return false; }
    });
    let applied = 0;
    for (const frame of frames) {
      try {
        await frame.executeJavaScript(
          "(function(css,theme){var id='xuanji-live-theme';var el=document.getElementById(id);if(!el){el=document.createElement('style');el.id=id;(document.head||document.documentElement).appendChild(el);}if(el.textContent!==css)el.textContent=css;document.documentElement.style.colorScheme=theme;if(document.body)document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');})(\n" + JSON.stringify(css) + "," + JSON.stringify(options.theme === "light" ? "light" : "dark") + "\n)",
          false
        );
        applied += 1;
      } catch (err) { /* 子框架还没就绪就跳过 */ }
    }
    return { ok: true, applied: applied };
  });
  handleTrusted('ai:web-settings', () => {
    try {
      return { ok: true, settings: readDshSettings({ home: dshWebHome() }), home: dshWebHome() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  handleTrusted('ai:dsh-catalog', () => {
    try {
      const entry = resolveDshEntry({ userData: app.getPath('userData'), rootDir: appRoot(), packaged: app.isPackaged, resourcesPath: process.resourcesPath }, false);
      const base = entry ? findTargetBase(entry) : '';
      return {
        ok: true,
        settings: readDshSettings({ home: dshWebHome() }),
        models: DSH_MODEL_CATALOG,
        plugins: listDshPlugins(base),
        presets: listDshPresets(dshWebHome()),
        account: { credentials: dshHasCredentials(dshWebHome()) },
        home: dshWebHome()
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  handleTrusted('ai:dsh-open-home', () => shell.openPath(dshWebHome()));
  handleTrusted('ai:web-settings-set', async (event, patch) => {
    try {
      const next = applyDshSettings({ home: dshWebHome() }, patch || {});
      let url = '';
      if (dshWeb) {
        const info = dshWeb.info();
        if (info && info.status === 'running') {
          const restarted = await dshWeb.restart();
          if (restarted && restarted.ok) url = restarted.url || '';
        }
      }
      return { ok: true, settings: next, url: url };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  handleTrusted('ai:clients', () => (clientIntegrations ? clientIntegrations.status() : { ok: false, clients: {}, configs: {} }));

  handleTrusted('desktop:set-auto-tts', async (event, enabled) => {
    store.set('autoTts', !!enabled);
    if (enabled) await services.ensureTts(true);
    return statusPayload();
  });

  handleTrusted('desktop:open-logs', async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    return shell.openPath(logsDir);
  });

  handleTrusted('desktop:open-user-data', () => shell.openPath(app.getPath('userData')));

  handleTrusted('desktop:open-app-root', () => shell.openPath(appRoot()));
  handleTrusted('extensions:dir', () => userExtensionsDir());
  handleTrusted('extensions:open-dir', async () => shell.openPath(ensureExtensionsDir()));
  handleTrusted('extensions:list', () => listUserExtensions());

  // 渲染进程切换昼夜主题时同步原生标题栏与窗口底色
  handleTrusted('desktop:set-theme', (event, name) => {
    const light = String(name || '') === 'light';
    store.set('theme', light ? 'light' : 'dark');
    nativeTheme.themeSource = light ? 'light' : 'dark';
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(light ? '#e8edf4' : '#0d1117');
    return { themeSource: nativeTheme.themeSource };
  });

  // 保留这个通道做兼容：窗口按钮已改为渲染层自绘并跟随主题变量，
  // 系统覆盖层不再存在，所以这里没有可设置的对象，直接如实返回未处理。
  handleTrusted('desktop:set-titlebar', () => ({ ok: false, reason: 'custom-window-controls' }));

  handleTrusted('desktop:forget-serial-port', async () => {
    store.set('lastSerialPort', '');
    return statusPayload();
  });

  // Windows 侧的 COM 列表：主进程拿不到 Electron 的串口枚举结果（只有 select-serial-port
  // 事件里才有），但「系统到底认没认到这个口」是排障时最先要分清的，所以按需问一次系统。
  handleTrusted('desktop:serial-winlist', () => windowsSerialList());

  // 应用内选口面板用：列表来自最近一次 select-serial-port，lastSerialPort 是上次的选择
  handleTrusted('serial:list', () => ({ ports: serialPorts, lastSerialPort: store.get('lastSerialPort') || '' }));

  handleTrusted('serial:choose-result', (event, payload) => {
    const request = serialChoice;
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!request || String(data.requestId || '') !== request.requestId) return { ok: false };
    clearTimeout(request.timer);
    serialChoice = null;
    const chosen = serialPorts.find((port) => port.portId === String(data.portId || '')) || null;
    if (chosen) {
      const name = chosen.portName || chosen.displayName || '';
      store.set('lastSerialPort', name);
      log('serial: 面板选择 ' + name + ' (portId ' + chosen.portId + ')');
      request.callback(chosen.portId);
    } else {
      log('serial: 面板取消选择');
      request.callback('');
    }
    return { ok: true, portName: chosen ? chosen.portName || chosen.displayName || '' : '' };
  });

  handleTrusted('desktop:relaunch', () => {
    app.relaunch();
    // 先跑清理再 exit：app.exit() 不派发 before-quit，不手动调就会漏掉
    // recorder.stop / store.flush / 子进程回收
    shutdown();
    app.exit(0);
  });

  handleTrusted('desktop:quit', () => {
    app.quit();
  });

  handleTrusted('desktop:open-external', async (event, url) => {
    const value = String(url || '');
    if (!/^https?:\/\//i.test(value)) return '仅支持 http/https 链接';
    return shell.openExternal(value);
  });

  // 原生菜单栏移除后，界面里的「设置 → 桌面版」通过这些通道驱动窗口命令
  handleTrusted('desktop:reload', () => { reloadWindow(); });
  handleTrusted('desktop:zoom', (event, action) => zoomWindow(String(action || 'reset')));
  handleTrusted('desktop:toggle-fullscreen', () => toggleFullScreen());
  handleTrusted('desktop:toggle-devtools', () => toggleDevTools());
  handleTrusted('desktop:about', () => { showAbout(); });

  ipcMain.on('desktop:log', (event, message) => {
    log('[renderer] ' + String(message));
  });
}

function registerPermissions() {
  const allowed = new Set([
    'serial',
    'usb',
    'hid',
    'notifications',
    'fullscreen',
    'clipboard-sanitized-write',
    'pointerLock'
  ]);
  const defaultSession = session.defaultSession;
  const trustedContents = (webContents) => {
    try {
      const url = String((webContents && webContents.getURL && webContents.getURL()) || '');
      return url === appOrigin() || url.indexOf(appOrigin() + '/') === 0;
    } catch (err) {
      return false;
    }
  };

  // 设备级权限检查（Web Serial 的 open() 就会走这里）拿到的 webContents 可能是 null
  // （Electron 文档明确说明），此时只能按 requestingOrigin 判断。以前一律 trustedContents(null)
  // → false，表现是：能枚举端口、requestPort 正常，但 open() 永远 Failed to open serial port。
  const trustedOrigin = (origin) => {
    const value = String(origin || '');
    return value === appOrigin() || value.indexOf(appOrigin() + '/') === 0;
  };
  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (!allowed.has(permission)) return false;
    if (webContents) return trustedContents(webContents);
    return trustedOrigin(requestingOrigin);
  });
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(trustedContents(webContents) && allowed.has(permission));
  });
  defaultSession.setDevicePermissionHandler((details) => {
    const byContents = details && details.webContents ? trustedContents(details.webContents) : false;
    const byOrigin = trustedOrigin(details && (details.origin || details.requestingOrigin));
    if (!byContents && !byOrigin) return false;
    return details.deviceType === 'serial' || details.deviceType === 'usb' || details.deviceType === 'hid';
  });
  // 先上 Report-Only：老界面仍有内联脚本/样式，直接强制会打穿首屏；观察稳定后再收紧
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:8787 http://localhost:8787 ws://127.0.0.1:8787; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    const headers = Object.assign({}, details.responseHeaders, {
      'Content-Security-Policy-Report-Only': [csp]
    });
    callback({ responseHeaders: headers });
  });
}

function windowsSerialList() {
  const now = Date.now();
  if (now - winListCache.at < WIN_LIST_TTL_MS) return winListCache;
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '',
    'powershell.exe'
  ].filter(Boolean);
  let ports = [];
  let ok = false;
  for (const exe of candidates) {
    try {
      const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() -join ","'], { encoding: 'utf8', timeout: WIN_LIST_TIMEOUT_MS, windowsHide: true });
      if (result.error) throw result.error;
      ports = String(result.stdout || '').split(/[,\r\n]+/).map((name) => name.trim()).filter(Boolean);
      ok = true;
      break;
    } catch (error) {
      log('serial: 查询 Windows COM 列表失败 · ' + String(error && error.message || error));
    }
  }
  winListCache = { at: now, ok: ok, ports: ports };
  return winListCache;
}

// 原来这里是 dialog.showMessageBox：多串口时弹一个原生对话框，被主窗口挡住就是
// 「点了连接没反应」；取消后 Chromium 只回一句 No port selected by the user。
// 现在把列表交给渲染层的应用内面板，选完回传 portId。
// 注意：select-serial-port 是 session 的事件（不是 webContents 的）——挂在 webContents 上
// 永远收不到，Chromium 会把 requestPort 当作无人处理直接取消，表现就是「扫不到 COM 口」。
function registerSerialPicker() {
  session.defaultSession.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    // 兼容两种签名：(event, portList, webContents, callback) 与旧版 (event, portList, callback)
    if (typeof wc === 'function') {
      callback = wc;
      wc = mainWindow && mainWindow.webContents;
    }
    if (typeof callback !== 'function') return;
    serialPorts = (Array.isArray(portList) ? portList : []).map((port) => ({
      portId: String(port.portId || ''),
      portName: String(port.portName || ''),
      displayName: String(port.displayName || ''),
      vendorId: port.vendorId ? String(port.vendorId) : '',
      productId: port.productId ? String(port.productId) : '',
      deviceInstanceId: String(port.deviceInstanceId || '')
    }));
    // 端口列表写进日志：下次「连不上」的时候至少知道应用当时枚举到了什么
    log('serial: select-serial-port 枚举到 ' + serialPorts.length + ' 个端口 · ' + serialPorts.map((port) => port.portName || port.displayName || '?').join(', '));
    respondSerialChoice(wc, callback);
  });
}

function respondSerialChoice(wc, callback) {
  if (!wc || (wc.isDestroyed && wc.isDestroyed())) {
    log('serial: 窗口不可用，取消本次选择（枚举到 ' + serialPorts.length + ' 个端口）');
    callback('');
    return;
  }
  if (serialPorts.length === 1) {
    const only = serialPorts[0];
    const name = only.portName || only.displayName || '';
    store.set('lastSerialPort', name);
    log('serial: 只有一个端口，自动选择 ' + name);
    callback(only.portId);
    return;
  }
  // 0 个或多个都走面板：0 个时面板给出排查提示，不再静默取消
  const requestId = 'serial-' + (++serialSeq);
  const timer = setTimeout(() => {
    if (!serialChoice || serialChoice.requestId !== requestId) return;
    serialChoice = null;
    log('serial: 选口面板 ' + (SERIAL_CHOICE_TIMEOUT_MS / 1000) + ' 秒未响应，取消本次选择');
    callback('');
  }, SERIAL_CHOICE_TIMEOUT_MS);
  serialChoice = { requestId, callback, timer };
  wc.send('serial:choose', { requestId, ports: serialPorts, preset: store.get('lastSerialPort') || '' });
}

// 原生菜单栏已移除：窗口命令全部走 IPC，由界面里的「设置 → 桌面版」和快捷键驱动
function webContents() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
}

function zoomWindow(action) {
  const wc = webContents();
  if (!wc) return null;
  const current = wc.getZoomLevel();
  if (action === 'in') wc.setZoomLevel(Math.min(4, current + 0.5));
  else if (action === 'out') wc.setZoomLevel(Math.max(-4, current - 0.5));
  else wc.setZoomLevel(0);
  log('zoom level ' + wc.getZoomLevel());
  return wc.getZoomLevel();
}

function toggleFullScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
}

function toggleDevTools() {
  const wc = webContents();
  if (!wc) return false;
  if (wc.isDevToolsOpened()) { wc.closeDevTools(); return false; }
  wc.openDevTools({ mode: 'detach' });
  return true;
}

function reloadWindow() {
  const wc = webContents();
  if (wc) wc.reload();
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 璇玑',
    message: '璇玑  ' + app.getVersion(),
    detail:
      'Electron ' + process.versions.electron + '  ·  Chromium ' + process.versions.chrome + '\n' +
      '本地服务：http://127.0.0.1:' + webPort + '\n' +
      'MCP 桥：http://127.0.0.1:' + (store.get('bridgePort') || 8787) + '\n' +
      '数据目录：' + app.getPath('userData') + '\n' +
      '日志目录：' + logsDir,
    buttons: ['确定'],
    noLink: true
  });
}

// 菜单栏去掉后快捷键得自己接管，否则 Ctrl+R / F12 / Ctrl+/- / F11 都会失效
function bindWindowShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '');
    const lower = key.toLowerCase();
    if (mod && lower === 'r') { event.preventDefault(); reloadWindow(); return; }
    if (mod && input.shift && (lower === 'i' || lower === 'j')) { event.preventDefault(); toggleDevTools(); return; }
    if (!mod && lower === 'f12') { event.preventDefault(); toggleDevTools(); return; }
    if (mod && (key === '=' || key === '+' || key === 'Add')) { event.preventDefault(); zoomWindow('in'); return; }
    if (mod && (key === '-' || key === 'Subtract')) { event.preventDefault(); zoomWindow('out'); return; }
    if (mod && key === '0') { event.preventDefault(); zoomWindow('reset'); return; }
    if (!mod && lower === 'f11') { event.preventDefault(); toggleFullScreen(); return; }
  });
}

async function createWindow() {
  const state = windowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    backgroundColor: store.get('theme') === 'light' ? '#e8edf4' : '#0d1117',
    title: '璇玑',
    icon: iconPath(),
    autoHideMenuBar: true,
    // 顶栏当标题栏：去掉系统那条「图标 + 标题」的标题栏，只留右上角三个系统按钮。
    // 按钮条的底色由渲染进程按当前主题回填（desktop:set-titlebar），这里只是首帧的兜底。
    // 窗口按钮由渲染层自绘（index.html 的 .win-controls + shell-decorate.js 接线）。
    // 不用 titleBarOverlay：系统那三个按钮画在页面之上，任何浮层都盖不住，
    // 全屏设计器/看板打开时必然错位压在弹层右上角。
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  registerSerialPicker();
  bindWindowShortcuts(mainWindow);

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // 只允许留在应用自身 origin：插件/AI 产物的 location.href、外链点击都不能把窗口带走。
  // 例外：右侧「对话」页嵌入的 DSH Web 是另一个本地端口，只放行它的子框架跳转。
  const dshWebOrigin = () => {
    try {
      const info = dshWeb && dshWeb.info();
      return info && info.url ? new URL(info.url).origin : '';
    } catch (err) { return ''; }
  };
  const guardNavigation = (event, url) => {
    if (url === appOrigin() || url.indexOf(appOrigin() + '/') === 0) return;
    event.preventDefault();
    log('blocked navigation ' + url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', (event, url, isInPlace, isMainFrame) => {
    const origin = dshWebOrigin();
    if (!isMainFrame && origin && (url === origin || url.indexOf(origin + '/') === 0)) return;
    guardNavigation(event, url);
  });

  if (app.isPackaged && !process.argv.includes('--dev')) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      if (key === 'f12' || (input.control && input.shift && key === 'i')) event.preventDefault();
    });
    try { mainWindow.webContents.closeDevTools(); } catch (err) { /* ignore */ }
  }

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', () => {
    scheduleSave();
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    scheduleSave();
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', false);
  });

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log('did-fail-load ' + code + ' ' + description + ' ' + url);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log('renderer gone: ' + JSON.stringify(details));
  });

  await mainWindow.loadURL('http://127.0.0.1:' + webPort + '/index.html');
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

async function bootstrap() {
  app.setAppUserModelId('com.xihe.gcs.pro');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

  const userData = app.getPath('userData');
  workspaceId = crypto.createHash('sha256').update(userData).digest('hex').slice(0, 16);
  instanceFile = path.join(userData, 'ai', 'instance.json');
  logsDir = path.join(userData, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });

  store = createStore(path.join(userData, 'desktop-config.json'), {
    autoTts: true,
    bridgePort: 8787,
    lastSerialPort: '',
    recording: { rotateMB: 32, capGB: 2 },
    window: {}
  });

  recorder = createRecorder({
    userData,
    config: store.get('recording') || { rotateMB: 32, capGB: 2 }
  });
  log('recordings dir ' + recorder.dir);

  registerPermissions();
  registerIpc();
  Menu.setApplicationMenu(null);

  try {
    const result = await startStaticServer(appRoot(), DEFAULT_WEB_PORT, 8, {
      mounts: [{ url: '/ext', dir: ensureExtensionsDir() }],
      // 装机版禁止复用外部服务：复用等于让本机任意进程冒充应用 UI；
      // 开发期指定了自定义端口时也不复用，便于和已装机版本并行调试。
      allowReuse: !app.isPackaged && !process.env.XHGCS_WEB_PORT
    });
    webPort = result.port;
    staticServer = result.server;
    log('static server ' + (result.reused ? 'reused' : 'started') + ' on port ' + webPort);
  } catch (error) {
    log('static server failed: ' + error.message);
    dialog.showErrorBox('璇玑 启动失败', String(error.message || error));
    app.quit();
    return;
  }

  services = createServices({
    rootDir: appRoot(),
    webPort,
    cwd: app.isPackaged ? process.resourcesPath : appRoot(),
    logsDir,
    execPath: process.execPath,
    store,
    log,
    instanceId: instanceId,
    workspaceId: workspaceId,
    instanceFile: instanceFile,
    // 仅开发模式允许浏览器从 /api/health 取令牌；装机版走 preload 的受限 IPC
    healthToken: !app.isPackaged
  });

  aiService = createAiTaskService({
    userData: userData,
    rootDir: appRoot(),
    execPath: process.execPath,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    bridgePort: () => services.bridgePort(),
    instanceFile: instanceFile,
    writeEnabled: () => services.writeEnabled(),
    log: log,
    send: (event) => {
      const wc = webContents();
      if (wc) wc.send('ai:event', event);
    }
  });

  dshWeb = createDshWebService({
    userData: userData,
    rootDir: appRoot(),
    execPath: process.execPath,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    log: log
  });

  clientIntegrations = createClientIntegrations({
    home: app.getPath('home'),
    entry: launcherEntry()
  });

  // 不等渲染层或用户点 AI：后台预热同一实例，准备工作均为异步。
  dshWeb.start({ theme: store.get('theme') || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') })
    .then(result => { if (!result.ok) log('dsh web: prewarm failed: ' + result.error); })
    .catch(err => log('dsh web: prewarm failed: ' + err.message));
  await createWindow();

  services.ensureBridge().then((result) => {
    log('bridge: ' + JSON.stringify(result));
    if (result && result.running) writeInstanceRecord(result);
  }).catch((error) => log('bridge error: ' + error.message));
  services.ensureTts().then((result) => log('tts: ' + JSON.stringify(result))).catch((error) => log('tts error: ' + error.message));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', shutdown);
}
