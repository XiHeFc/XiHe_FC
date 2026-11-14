'use strict';
// 随包 DSH 的 Web UI 宿主（主进程）：启动 `dsh web --no-open --port 0`，
// 把带一次性令牌的本地地址交给渲染层嵌入右侧「对话」页。
// 使用应用自己的 DSH_HOME（userData/ai/dsh），不读也不改用户的全局 ~/.dsh。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { resolveDshEntryAsync } = require('./task-service');
const { resolveUiRoot, applyUiOverlay, findTargetBase } = require('./dsh-ui-overlay');

function themeCss(p) {
  const col = (v, fb) => {
    const value = String(v || '').trim();
    return /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|hsl)a?\([0-9.,%+\- /]+\))$/i.test(value) ? value : fb;
  };
  const panel = col(p.panel, '#1B1512');
  const panel2 = col(p.panel2 || p['panel-2'], '#211A16');
  const panel3 = col(p.panel3 || p['panel-3'], '#28201B');
  const bg = col(p.bg, '#14100D');
  const ink = col(p.ink, '#F3EADC');
  const ink2 = col(p.ink2 || p['ink-2'], '#C3B3A0');
  const ink3 = col(p.ink3 || p['ink-3'], '#8C7C6A');
  const amber = col(p.amber, '#E2A35F');
  const amber2 = col(p.amber2 || p['amber-2'], '#F0BE7F');
  const onAmber = col(p.onAmber || p['on-amber'], '#241505');
  const ok = col(p.ok, '#84C8A8');
  const warn = col(p.warn, '#E3AA6C');
  const danger = col(p.danger, '#E0806C');
  const ha = String(p.ha || 'rgba(244,231,213,.08)').trim();
  const hb = String(p.hb || 'rgba(244,231,213,.13)').trim();
  const sel = 'html body,html body[data-ds-dark-theme]';
  const lines = [
    sel + '{',
    '  --dsw-alias-bg-base:' + panel + ';',
    '  --dsw-alias-bg-layer-1:' + panel2 + ';',
    '  --dsw-alias-bg-layer-2:' + panel2 + ';',
    '  --dsw-alias-bg-layer-3:' + panel3 + ';',
    '  --dsw-alias-bg-module-platform:' + panel3 + ';',
    '  --dsw-alias-bg-multi-select:' + panel3 + ';',
    '  --dsw-alias-bg-overlay:' + panel2 + ';',
    '  --dsw-alias-bg-skeleton:' + ha + ';',
    '  --dsw-alias-border-l1:' + ha + ';',
    '  --dsw-alias-border-l2:' + hb + ';',
    '  --dsw-alias-border-l2-darkmode-thin:' + hb + ';',
    '  --dsw-alias-border-l3:' + hb + ';',
    '  --dsw-alias-border-l4:' + hb + ';',
    '  --dsw-alias-label-primary:' + ink + ';',
    '  --dsw-alias-label-secondary:' + ink2 + ';',
    '  --dsw-alias-label-tertiary:' + ink3 + ';',
    '  --dsw-alias-label-caption:' + ink3 + ';',
    '  --dsw-alias-label-dimmed:' + panel3 + ';',
    '  --dsw-alias-label-primary-foreground:' + onAmber + ';',
    '  --dsw-alias-label-primary-inverted:' + panel3 + ';',
    '  --dsw-alias-brand-primary:' + amber + ';',
    '  --dsw-alias-brand-primary-invert:' + ink + ';',
    '  --dsw-alias-brand-primary-new-colorprimary-new-color:' + amber + ';',
    '  --dsw-alias-brand-text:' + ink + ';',
    '  --dsw-alias-button-primary-fill:' + amber + ';',
    '  --dsw-alias-button-primary-hover:' + amber2 + ';',
    '  --dsw-alias-button-primary-dimmed:' + panel3 + ';',
    '  --dsw-alias-button-contrast-fill:' + ink + ';',
    '  --dsw-alias-button-elevated-fill:' + panel3 + ';',
    '  --dsw-alias-button-floating-fill:' + panel3 + ';',
    '  --dsw-alias-button-floating-hover:' + panel2 + ';',
    '  --dsw-alias-button-ghost-active-fill:' + panel3 + ';',
    '  --dsw-alias-button-ghost-active-hover:' + panel2 + ';',
    '  --dsw-alias-button-ghost-active-border:' + ink3 + ';',
    '  --dsw-alias-button-info-fill:' + amber + ';',
    '  --dsw-alias-button-info-hover:' + amber2 + ';',
    '  --dsw-alias-interactive-bg-hover:' + ha + ';',
    '  --dsw-alias-interactive-bg-hover-solid:' + panel3 + ';',
    '  --dsw-alias-interactive-bg-hover-accent:' + hb + ';',
    '  --dsw-alias-interactive-bg-active:' + hb + ';',
    '  --dsw-specific-sidebar-fill:' + panel + ';',
    '  --dsw-specific-sidebar-nav-item-active:' + panel3 + ';',
    '  --dsw-specific-sidebar-nav-item-active-accent:' + panel2 + ';',
    '  --dsw-specific-sidebar-nav-item-hover:' + panel2 + ';',
    '  --dsw-specific-input-major:' + panel2 + ';',
    '  --dsw-specific-login-input:' + panel2 + ';',
    '  --dsw-specific-selector:' + panel2 + ';',
    '  --dsw-specific-tip:' + panel2 + ';',
    '  --dsw-specific-bubble:' + panel3 + ';',
    '  --dsw-specific-bubble-highlight:' + panel2 + ';',
    '  --dsw-alias-markdown-code-block:' + panel2 + ';',
    '  --dsw-alias-markdown-code-block-banner:' + panel3 + ';',
    '  --dsw-alias-markdown-inline-code:' + panel3 + ';',
    '  --dsw-alias-markdown-placeholder:' + panel3 + ';',
    '  --dsw-alias-markdown-tag:' + panel3 + ';',
    '  --dsw-alias-markdown-citation:' + panel3 + ';',
    '  --dsw-alias-markdown-code-segment-selected:' + panel3 + ';',
    '  --dsw-alias-markdown-code-segment-unselected:' + panel2 + ';',
    '  --dsw-alias-tooltip-bg:' + panel3 + ';',
    '  --dsw-alias-toast-bg:' + panel3 + ';',
    '  --dsw-alias-link:' + amber + ';',
    '  --dsw-alias-state-business-primary:' + amber + ';',
    '  --dsw-alias-state-business-tertiary:' + panel3 + ';',
    '  --dsw-alias-state-success-primary:' + ok + ';',
    '  --dsw-alias-state-error-primary:' + danger + ';',
    '  --dsw-alias-state-warn-primary:' + warn + ';',
    '  --dsw-alias-state-warn-label:' + warn + ';',
    '  --dsw-alias-scrollbar-bg-l1:' + panel2 + ';',
    '  --dsw-alias-scrollbar-bg-l2:' + panel2 + ';',
    '  --dsw-alias-scrollbar-hover-l1:' + panel3 + ';',
    '  --dsw-alias-scrollbar-hover-l2:' + panel3 + ';',
    '  --dsw-linear-gradient-think:linear-gradient(180deg, ' + panel + ' 20.19%, ' + 'transparent 100%);',
    '  --dsw-linear-think-select:linear-gradient(180deg, ' + panel2 + ' 20.19%, transparent 100%);',
    '}'
  ];
  return lines.join('\n') + '\n';
}

function createDshWebService(options) {
  const opts = options || {};
  const log = opts.log || function () {};
  const userData = opts.userData;
  // Web 版的 profile 放在用户目录（~/.xuanji/dsh-web），不放 %APPDATA%：
  // DSH 的模块代理在 AppData 下解析失败（实测 AppData 内任何路径都报 Cannot find package），
  // 用户目录与全局 DSH 的 ~/.dsh 同级，实测可正常启动；同时与 ACP 用的 ai/dsh 隔离。
  const home = opts.home || path.join(os.homedir(), '.xuanji', 'dsh-web');

  // DSH 的外观设置存在 DSH_HOME/settings.yaml（ui-theme.preference）。
  // 只做最小行级合并，避免为了一个字段依赖 YAML 库。
  async function applyTheme(theme) {
    const pref = theme === 'light' ? 'light' : 'dark';
    const file = path.join(home, 'settings.yaml');
    let text = '';
    try { text = await fs.promises.readFile(file, 'utf8'); } catch (err) { text = ''; }
    const block = 'ui-theme:\n  preference: ' + pref + '\n';
    if (/^ui-theme:/m.test(text)) {
      text = text.replace(/^ui-theme:[^\n]*\n(?:[ \t]+[^\n]*\n)*/m, block);
    } else {
      if (text && !text.endsWith('\n')) text += '\n';
      text += block;
    }
    await fs.promises.writeFile(file, text, 'utf8');
  }

  let child = null;
  let url = '';
  let status = 'idle';
  let error = '';
  let starting = null;
  let lastOptions = null;
  let generation = 0;
  let startupControl = null;

  function killTree() {
    if (adoptedPid) { killPid(adoptedPid); adoptedPid = 0; }
    if (!child) return;
    const pid = child.pid;
    child = null;
    killPid(pid);
  }

  function reset() {
    url = '';
    status = 'idle';
    error = '';
  }

  // 常驻（热）服务器：应用退出后 DSH Web 继续跑，下次启动直接复用，省掉约 8 秒的冷启动。
  // 状态文件记录 pid / 带令牌地址 / 运行时入口 / 界面覆盖版本；版本对不上或探活失败就重启。
  const stateFile = path.join(userData || home, 'ai', 'dsh-web-server.json');
  const logFile = path.join(userData || home, 'logs', 'dsh-web-child.log');
  const compileCacheDir = path.join(userData || home, 'ai', 'dsh-compile-cache');
  let adoptedPid = 0;

  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return false; }
  }
  function killPid(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (err) {
      log('dsh web: kill pid ' + pid + ' failed: ' + err.message);
    }
  }
  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (err) { return null; }
  }
  function writeState(value) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(value), 'utf8');
    } catch (err) { log('dsh web: state write failed: ' + err.message); }
  }
  function clearState() {
    try { fs.rmSync(stateFile, { force: true }); } catch (err) { /* ignore */ }
  }
  // 只有命令行确实是我们的 DSH 入口时才杀，避免 pid 复用误伤别的进程。
  function commandLineOf(pid) {
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      return String((r && r.stdout) || '').trim();
    } catch (err) { return ''; }
  }
  function ownedByDsh(pid, entry) {
    const cmd = commandLineOf(pid).toLowerCase();
    if (!cmd) return false;
    return cmd.includes(String(entry || '').toLowerCase()) || (cmd.includes('dsh') && cmd.includes(' web'));
  }
  function probeUrl(target) {
    return new Promise((resolve) => {
      try {
        const req = http.get(target, { timeout: 3000 }, (res) => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      } catch (err) { resolve(false); }
    });
  }

  // 用主界面当前的配色令牌生成 DSH 的主题覆盖，保证两边是同一套色系。
  // 由渲染层读取 computed tokens 后传进来；浅色/深色都由这份文件决定。


  async function writeThemeCss(entry, palette, logger) {
    if (!palette || typeof palette !== 'object') return;
    const base = findTargetBase(entry);
    if (!base) return;
    const file = path.join(base, 'dsh-web-frontend', 'dist', 'assets', 'xuanji-theme.css');
    try {
      await fs.promises.writeFile(file, themeCss(palette), 'utf8');
      logger('dsh web: theme from app palette');
    } catch (err) {
      logger('dsh web: theme write failed: ' + err.message);
    }
  }

  async function start(options) {
    // 设置页也会 start()；空参数不覆盖聊天页已传入的主题与配色。
    lastOptions = Object.assign({}, lastOptions || {}, options && options.theme ? { theme: options.theme } : {}, options && options.palette ? { palette: options.palette } : {});
    if (url && (child || adoptedPid)) return { ok: true, url: url, status: status };
    if (starting) {
      try { return await starting; } catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
    const run = ++generation;
    const controller = new AbortController();
    startupControl = controller;
    starting = (async () => {
      status = 'starting';
      error = '';
      const startedAt = Date.now();
      await fs.promises.mkdir(home, { recursive: true });
      log('dsh web: home ' + home);
      const entry = await resolveDshEntryAsync(opts, controller.signal);
      if (!entry) throw new Error('找不到内置 DSH：安装包缺少 resources/dsh');
      // 界面定制层：dsh-ui/ 覆盖到随包 DSH 的前端 dist 与客户端 bundle
      const uiRoot = resolveUiRoot(opts);
      let overlayRev = '';
      let overlayApplied = false;
      if (uiRoot) {
        try {
          const overlay = await applyUiOverlay(entry, uiRoot, log);
          overlayRev = overlay.rev || '';
          overlayApplied = overlay.applied === true;
          if (!overlay.ok) log('dsh web: ui overlay skipped (' + overlay.reason + ')');
        } catch (err) {
          log('dsh web: ui overlay failed: ' + err.message);
        }
      } else {
        log('dsh web: no dsh-ui, serving stock DSH interface');
      }
      // 主界面配色 → DSH 主题（覆盖 dsh-ui 里的默认配色）
      const theme = lastOptions && lastOptions.theme;
      if (theme) { try { await applyTheme(theme); } catch (err) { log('dsh web: theme failed: ' + err.message); } }
      await writeThemeCss(entry, lastOptions && lastOptions.palette, log);
      // 上次退出时留下的热服务：入口与界面覆盖版本一致、进程活着、地址可访问，就直接复用
      const saved = readState();
      if (!overlayApplied && saved && saved.url && saved.entry === entry && saved.home === home && String(saved.rev || '') === overlayRev && pidAlive(saved.pid)) {
        if (await probeUrl(saved.url)) {
          if (run !== generation) { killPid(saved.pid); throw new Error('DSH Web 启动已取消'); }
          adoptedPid = saved.pid;
          url = saved.url;
          status = 'running';
          log('dsh web: reused warm server pid ' + saved.pid + ' (' + (Date.now() - startedAt) + ' ms)');
          return { ok: true, url: url, status: status, adopted: true };
        }
        log('dsh web: warm server unreachable, restarting');
      }
      if (saved && saved.pid && pidAlive(saved.pid) && ownedByDsh(saved.pid, entry)) {
        log('dsh web: stopping stale server pid ' + saved.pid);
        killPid(saved.pid);
      }
      clearState();
      log('dsh web: preparation ' + (Date.now() - startedAt) + ' ms');
      if (run !== generation) throw new Error('DSH Web 启动已取消');
      log('dsh web: starting from ' + entry);
      // 独立进程 + 日志文件：应用退出后服务继续跑（stdout 不挂管道，父进程退出不会把它带走）
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (err) { /* ignore */ }
      const logFd = fs.openSync(logFile, 'w');
      child = spawn(opts.execPath, ['--expose-internals', entry, 'web', '--no-open', '--port', '0'], {
        cwd: home,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: home,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          NODE_COMPILE_CACHE: compileCacheDir
        })
      });
      try { fs.closeSync(logFd); } catch (err) { /* ignore */ }
      const spawned = child;
      try { spawned.unref(); } catch (err) { /* ignore */ }
      writeState({ pid: spawned.pid, url: '', entry: entry, rev: overlayRev, home: home, startedAt: Date.now() });
      const found = await new Promise((resolve, reject) => {
        let poll = null;
        const timer = setTimeout(() => reject(new Error('DSH Web 启动超时（45 s）')), 45000);
        const finish = (fn, value) => { clearTimeout(timer); if (poll) clearInterval(poll); fn(value); };
        poll = setInterval(() => {
          fs.readFile(logFile, 'utf8', (err, text) => {
            if (err) return;
            const hit = String(text).match(/dsh web:\s+(http:\/\/[^\s]+)/);
            if (hit) finish(resolve, hit[1]);
          });
        }, 200);
        spawned.on('exit', (code) => {
          finish(reject, new Error('DSH Web 已退出（code ' + code + '）'));
        });
        spawned.on('error', (err) => finish(reject, err));
      });
      // 启动过程中若已被 stop/并发取消，直接收掉
      if (child !== spawned) {
        try { spawned.kill(); } catch (err) { /* ignore */ }
        throw new Error('DSH Web 启动已取消');
      }
      url = found;
      status = 'running';
      writeState({ pid: spawned.pid, url: url, entry: entry, rev: overlayRev, home: home, startedAt: Date.now() });
      log('dsh web: ready on local port (' + (Date.now() - startedAt) + ' ms total)');
      spawned.on('exit', (code) => {
        log('dsh web: exited ' + code);
        if (child === spawned) { child = null; clearState(); reset(); }
      });
      return { ok: true, url: url, status: status };
    })();
    try {
      return await starting;
    } catch (err) {
      if (run !== generation) return { ok: false, error: 'DSH Web 启动已取消' };
      error = String((err && err.message) || err);
      status = 'error';
      killTree();
      return { ok: false, error: error };
    } finally {
      if (run === generation) { starting = null; startupControl = null; }
    }
  }

  function stop() {
    generation++;
    if (startupControl) startupControl.abort();
    startupControl = null;
    starting = null;
    killTree();
    clearState();
    reset();
    return info();
  }

  function info() {
    return { ok: true, status: status, url: status === 'running' ? url : '', error: error };
  }

  function dispose() {
    // 退出时保留 DSH Web 常驻（下次启动秒开）；安装/卸载由安装器的 customInit 结束进程。
  }

  async function restart() {
    stop();
    return await start(lastOptions || {});
  }

  return { start: start, stop: stop, restart: restart, info: info, dispose: dispose };
}

module.exports = { createDshWebService, paletteCss: themeCss };
