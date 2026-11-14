'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = {
  isDesktop: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    onStatus: (handler) => {
      const listener = (event, text) => handler(String(text));
      ipcRenderer.on('update:status', listener);
      return () => ipcRenderer.removeListener('update:status', listener);
    }
  },
  getStatus: () => ipcRenderer.invoke('desktop:status'),
  restartServices: () => ipcRenderer.invoke('desktop:restart-services'),
  // AI / MCP：实例身份、诊断、受限令牌。令牌只给本应用 origin 的页面。
  ai: {
    bridge: () => ipcRenderer.invoke('desktop:ai-bridge'),
    token: () => ipcRenderer.invoke('desktop:bridge-token'),
    configure: (patch) => ipcRenderer.invoke('desktop:bridge-config', patch || {})
  },
  // 软件内 AI 会话（默认 DSH / ACP）：消息、流式事件、取消
  aiChat: {
    generateView: (text) => ipcRenderer.invoke('ai:generate-view', text),
    status: () => ipcRenderer.invoke('ai:status'),
    send: (text) => ipcRenderer.invoke('ai:send', String(text || '')),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    clear: () => ipcRenderer.invoke('ai:clear'),
    onEvent: (handler) => {
      const listener = (event, payload) => handler(payload || {});
      ipcRenderer.on('ai:event', listener);
      return () => ipcRenderer.removeListener('ai:event', listener);
    }
  },
  // 随包 DSH 的 Web UI：起本地服务并把地址交给渲染层嵌入
  aiWeb: {
    start: (theme, palette) => ipcRenderer.invoke('ai:web', { theme: String(theme || ''), palette: palette || null }),
    status: () => ipcRenderer.invoke('ai:web-status'),
    stop: () => ipcRenderer.invoke('ai:web-stop'),
    openSettings: (frameName) => ipcRenderer.invoke('ai:open-settings', { frameName: String(frameName || '') }),
    applyPalette: (theme, palette) => ipcRenderer.invoke('ai:palette', { theme: String(theme || ''), palette: palette || null }),
    getSettings: () => ipcRenderer.invoke('ai:web-settings'),
    getCatalog: () => ipcRenderer.invoke('ai:dsh-catalog'),
    openDshHome: () => ipcRenderer.invoke('ai:dsh-open-home'),
    setSettings: (patch) => ipcRenderer.invoke('ai:web-settings-set', patch || {})
  },
  // 外部客户端（Claude Code / Codex）的只读状态与可复制配置
  aiClients: {
    status: () => ipcRenderer.invoke('ai:clients')
  },
  setAutoTts: (enabled) => ipcRenderer.invoke('desktop:set-auto-tts', !!enabled),
  setTheme: (name) => ipcRenderer.invoke('desktop:set-theme', String(name || 'dark')),
  setTitleBar: (colors) => ipcRenderer.invoke('desktop:set-titlebar', colors || {}),
  // 自绘窗口按钮：系统不再画 ─ ☐ ✕，改由渲染层调用这三个方法
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    state: () => ipcRenderer.invoke('window:state'),
    onMaximizedChange: (handler) => {
      const listener = (event, maximized) => handler(Boolean(maximized));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    }
  },
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  openUserData: () => ipcRenderer.invoke('desktop:open-user-data'),
  openAppRoot: () => ipcRenderer.invoke('desktop:open-app-root'),
  forgetSerialPort: () => ipcRenderer.invoke('desktop:forget-serial-port'),
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    winList: () => ipcRenderer.invoke('desktop:serial-winlist'),
    chooseResult: (payload) => ipcRenderer.invoke('serial:choose-result', payload || {}),
    // 主进程枚举到端口后把列表发过来，由界面的选口面板负责显示与回传
    onChoose: (handler) => {
      const listener = (event, payload) => handler(payload || {});
      ipcRenderer.on('serial:choose', listener);
      return () => ipcRenderer.removeListener('serial:choose', listener);
    }
  },
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  reload: () => ipcRenderer.invoke('desktop:reload'),
  zoom: (action) => ipcRenderer.invoke('desktop:zoom', String(action || 'reset')),
  toggleFullScreen: () => ipcRenderer.invoke('desktop:toggle-fullscreen'),
  toggleDevTools: () => ipcRenderer.invoke('desktop:toggle-devtools'),
  about: () => ipcRenderer.invoke('desktop:about'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', String(url || '')),
  log: (message) => ipcRenderer.send('desktop:log', String(message)),
  recordings: {
    status: () => ipcRenderer.invoke('recorder:status'),
    start: (manifest) => ipcRenderer.invoke('recorder:start', manifest || {}),
    append: (text, rowCount) => ipcRenderer.invoke('recorder:append', String(text || ''), Number(rowCount) || 0),
    stop: (reason) => ipcRenderer.invoke('recorder:stop', String(reason || '')),
    list: () => ipcRenderer.invoke('recorder:list'),
    clear: () => ipcRenderer.invoke('recorder:clear'),
    configure: (config) => ipcRenderer.invoke('recorder:configure', config || {}),
    open: () => ipcRenderer.invoke('recorder:open')
  },
  /** 用户插件目录：装机版里唯一可写的扩展位置（%APPDATA%\Xuanji\extensions） */
  extensions: {
    dir: () => ipcRenderer.invoke('extensions:dir'),
    list: () => ipcRenderer.invoke('extensions:list'),
    openDir: () => ipcRenderer.invoke('extensions:open-dir')
  }
};

contextBridge.exposeInMainWorld('XHGCS_DESKTOP', desktopApi);
