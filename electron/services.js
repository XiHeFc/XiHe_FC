'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const TTS_ENGINE_PORT = 9880;
const TTS_PROXY_PORT = 8770;

/** 打包后 asar 内的可执行资源会被解包到 app.asar.unpacked，这里做路径还原。 */
function unpackedPath(target) {
  const marker = 'app.asar' + path.sep;
  if (target.indexOf(marker) < 0) return target;
  const unpacked = target.replace(marker, 'app.asar.unpacked' + path.sep);
  return fs.existsSync(unpacked) ? unpacked : target;
}

function probeHttp(port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath, timeout: timeoutMs || 1200 },
      (response) => {
        response.resume();
        done(true);
      }
    );
    request.on('timeout', () => {
      request.destroy();
      done(false);
    });
    request.on('error', () => done(false));
  });
}

function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs || 800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// probeHttp 只要连上就算数；要判断「这份桥是哪一代代码」必须读 /api/health 的正文。
function probeJson(port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath, timeout: timeoutMs || 1200 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            request.destroy();
            done(null);
          }
        });
        response.on('end', () => {
          try {
            done(JSON.parse(body));
          } catch (error) {
            done(null);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      done(null);
    });
    request.on('error', () => done(null));
  });
}

// 必须和 bridge.mjs 里的 bridgeFingerprint 算法逐字节一致：桥与它导入的本地模块一起哈希。
function bridgeFingerprint(script) {
  const hash = crypto.createHash('sha256');
  for (const name of ['bridge.mjs', 'bytes.mjs']) {
    try {
      hash.update(fs.readFileSync(path.join(path.dirname(script), name)));
    } catch (error) {
      return '';
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function openLog(logsDir, name) {
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, name);
  try {
    const stat = fs.statSync(file);
    if (stat.size > 4 * 1024 * 1024) fs.renameSync(file, file + '.' + Date.now() + '.bak');
  } catch (err) {
    /* 文件不存在 */
  }
  return fs.createWriteStream(file, { flags: 'a' });
}

function createServices(options) {
  const rootDir = options.rootDir;
  const logsDir = options.logsDir;
  const execPath = options.execPath;
  const store = options.store;
  const log = options.log || function () {};
  // 实例身份：写进桥的环境变量与实例记录，launcher/外部客户端据此确认连的是当前实例
  const instanceId = String(options.instanceId || '');
  const workspaceId = String(options.workspaceId || '');
  const instanceFile = String(options.instanceFile || '');
  // 开发模式允许浏览器直接从 /api/health 取令牌；装机版不返回
  const allowHealthToken = Boolean(options.healthToken);
  // 写工具默认关闭；设置里打开后重启桥生效（每次 spawn 时从 store 读，避免进程内切换失效）
  function mcpWriteEnabled() { return store.get('mcpWrite') === true; }
  // 浏览器来源白名单：桥只认应用自己的端口，不再放行任意 localhost 端口
  const webPort = Number(options.webPort) || 0;
  const allowedOrigins = webPort
    ? 'http://127.0.0.1:' + webPort + ',http://localhost:' + webPort + ',http://[::1]:' + webPort
    : '';

  // 打包后 Electron 的 fs 补丁会让 app.asar 看起来像目录，Windows 无法作为子进程 cwd，必须排除。
  const baseCwd = options.cwd || rootDir;
  function safeCwd(fallback) {
    const usable = baseCwd && baseCwd.indexOf('app.asar') < 0;
    try {
      if (usable && fs.statSync(baseCwd).isDirectory()) return baseCwd;
    } catch (error) {
      /* ignore */
    }
    return path.dirname(fallback);
  }

  let bridgeProc = null;
  let ttsProc = null;
  let disposed = false;
  let bridgeGuardTimer = null;
  let bridgeGuardBusy = false;
  let bridgeGuardMisses = 0;

  function bridgePort() {
    const value = Number(store.get('bridgePort'));
    return Number.isFinite(value) && value > 1024 ? value : 8787;
  }

  // 8787 被无关服务占用时换一个空闲端口。实例记录会把真实端口带给 launcher，
  // 外部客户端不需要知道这个数字。
  async function freePort(start) {
    for (let port = start; port < start + 40 && port < 65536; port++) {
      if (!(await probePort(port, 350))) return port;
    }
    return 0;
  }

  function autoTts() {
    return store.get('autoTts') !== false;
  }

  // 桥的写操作令牌。持久化到桌面配置里：桥每次 spawn 都重新生成的话，
  // 「设置 → 桌面版 → 重启本地服务」之后渲染层手上就是过期令牌，所有 AI 调用变 403。
  function bridgeToken() {
    const saved = String(store.get('bridgeToken') || '').trim();
    if (saved) return saved;
    return store.set('bridgeToken', crypto.randomBytes(24).toString('hex'));
  }

  function ttsAvailable() {
    return fs.existsSync(path.join('D:\\', 'GPT-SoVITS-src', '.venv', 'Scripts', 'python.exe'));
  }

  // 8787 上的桥是旧代代码：接管它就等于「装了新版跑的是旧行为」。
  // 只对确认是 XiHe 桥（health 带 name=xhgcs）的进程调用；不认识的进程绝不动。
  async function stopStaleBridge(port, health) {
    const pid = Number(health && health.pid);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
    log('bridge stale on port ' + port + ' (sha=' + (health.sha || '(none)') + '), stopping pid ' + pid);
    try {
      process.kill(pid);
    } catch (error) {
      log('bridge stale stop failed: ' + error.message);
      return false;
    }
    for (let i = 0; i < 20; i++) {
      if (!(await probeHttp(port, '/api/health', 300))) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function ensureBridge() {
    if (disposed) return { running: false };
    let port = bridgePort();
    if (bridgeProc && !bridgeProc.killed) return { running: true, port, managed: true };

    const script = unpackedPath(path.join(rootDir, 'mcp-server', 'bridge.mjs'));
    const expected = fs.existsSync(script) ? bridgeFingerprint(script) : '';

    const health = await probeJson(port, '/api/health', 1200);
    if (health) {
      const isBridge = health.ok === true && health.name === 'xhgcs';
      const sha = String(health.sha || '');
      // 只接管「当前实例 + 同代代码」的桥。其他 xihe 桥（旧进程/别的实例）令牌不可知，
      // 直接替换成本进程托管的桥，避免出现「连上了却一直 403」。
      const sameInstance = String(health.instanceId || '') === instanceId;
      if (isBridge && sameInstance && (!expected || sha === expected)) {
        return { running: true, port, managed: false, sha, adopted: true };
      }
      if (isBridge) {
        if (!(await stopStaleBridge(port, health))) {
          log('bridge on port ' + port + ' (sha=' + (sha || '(none)') + ', instance=' + (health.instanceId || '(none)') + ') could not be stopped');
          return { running: true, port, managed: false, stale: true, sha };
        }
        log('bridge replaced (expected instance=' + instanceId + ', sha=' + expected + ')');
      } else {
        // 端口被非璇玑服务占用：换端口而不是让 AI 链路整体失败
        const next = await freePort(port + 1);
        if (!next) return { running: false, port, error: '端口 ' + port + ' 被占用，且附近没有可用端口' };
        log('bridge port ' + port + ' occupied by a foreign service, moving to ' + next);
        store.set('bridgePort', next);
        port = next;
      }
    } else if (await probePort(port, 500)) {
      const next = await freePort(port + 1);
      if (!next) return { running: false, port, error: '端口 ' + port + ' 被占用，且附近没有可用端口' };
      log('bridge port ' + port + ' occupied by a foreign service, moving to ' + next);
      store.set('bridgePort', next);
      port = next;
    }

    if (!fs.existsSync(script)) return { running: false, port, error: '缺少 mcp-server/bridge.mjs' };

    const out = openLog(logsDir, 'bridge.out.log');
    const err = openLog(logsDir, 'bridge.err.log');
    log('bridge spawn exec=' + execPath + ' script=' + script + ' cwd=' + safeCwd(script));
    bridgeProc = spawn(execPath, [script], {
      cwd: safeCwd(script),
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        XHGCS_BRIDGE_PORT: String(port),
        XHGCS_BRIDGE_TOKEN: bridgeToken(),
        XHGCS_INSTANCE_ID: instanceId,
        XHGCS_WORKSPACE_ID: workspaceId,
        XHGCS_INSTANCE_FILE: instanceFile,
        XHGCS_MCP_WRITE: mcpWriteEnabled() ? '1' : '0',
        ...(allowHealthToken ? { XHGCS_HEALTH_TOKEN: '1' } : {}),
        ...(allowedOrigins ? { XHGCS_ALLOWED_ORIGINS: allowedOrigins } : {}),
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1'
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    bridgeProc.stdout.on('error', () => {});
    bridgeProc.stderr.on('error', () => {});
    bridgeProc.stdout.pipe(out);
    bridgeProc.stderr.pipe(err);
    bridgeProc.on('exit', (code) => {
      log('bridge exited: ' + code);
      bridgeProc = null;
    });
    bridgeProc.on('error', (error) => {
      log('bridge spawn error: ' + error.message + ' (exec=' + execPath + ' cwd=' + safeCwd(script) + ')');
      bridgeProc = null;
    });

    for (let i = 0; i < 30; i++) {
      const up = await probeJson(port, '/api/health', 800);
      if (up && up.ok === true) return { running: true, port, managed: true, sha: String(up.sha || '') };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { running: false, port, error: 'MCP 桥启动超时' };
  }

  // 桌面版可能接管用户启动的桥。接管对象被外部关掉后，主进程不能一直以为它还在；
  // 连续两次探测失败就由本进程补起自己的桥，避免 AI/MCP 在设置页里忽好忽坏。
  function startBridgeGuard() {
    if (bridgeGuardTimer || disposed) return;
    bridgeGuardTimer = setInterval(async () => {
      if (disposed || bridgeGuardBusy) return;
      if (bridgeProc && !bridgeProc.killed) {
        bridgeGuardMisses = 0;
        return;
      }
      bridgeGuardBusy = true;
      try {
        const port = bridgePort();
        if (await probeHttp(port, '/api/health', 700)) {
          bridgeGuardMisses = 0;
          return;
        }
        bridgeGuardMisses += 1;
        if (bridgeGuardMisses < 2) return;
        bridgeGuardMisses = 0;
        log('bridge watchdog: local bridge unavailable, respawning');
        const result = await ensureBridge();
        log('bridge watchdog result: ' + JSON.stringify(result));
      } catch (error) {
        log('bridge watchdog error: ' + error.message);
      } finally {
        bridgeGuardBusy = false;
      }
    }, 3000);
    if (bridgeGuardTimer.unref) bridgeGuardTimer.unref();
  }

  function stopBridge() {
    if (!bridgeProc) return;
    const proc = bridgeProc;
    bridgeProc = null;
    try {
      proc.kill();
    } catch (error) {
      /* ignore */
    }
  }

  async function ensureTts(force) {
    if (disposed) return { running: false };
    if (!force && !autoTts()) return { running: false, enabled: false };
    if (!ttsAvailable()) return { running: false, available: false, error: '未检测到 D:\\GPT-SoVITS-src' };
    if (await probePort(TTS_PROXY_PORT)) {
      return { running: true, available: true, port: TTS_PROXY_PORT, enginePort: TTS_ENGINE_PORT, managed: false };
    }
    if (ttsProc && !ttsProc.killed) return { running: true, available: true, port: TTS_PROXY_PORT, managed: true };

    const script = unpackedPath(path.join(rootDir, 'tools', 'start-sovits.ps1'));
    if (!fs.existsSync(script)) return { running: false, available: true, error: '缺少 tools/start-sovits.ps1' };

    const out = openLog(logsDir, 'sovits.out.log');
    const err = openLog(logsDir, 'sovits.err.log');
    ttsProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: safeCwd(script), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    ttsProc.stdout.on('error', () => {});
    ttsProc.stderr.on('error', () => {});
    ttsProc.stdout.pipe(out);
    ttsProc.stderr.pipe(err);
    ttsProc.on('exit', (code) => {
      log('tts launcher exited: ' + code);
      ttsProc = null;
    });
    ttsProc.on('error', (error) => {
      log('tts spawn error: ' + error.message);
      ttsProc = null;
    });
    return { running: true, available: true, port: TTS_PROXY_PORT, enginePort: TTS_ENGINE_PORT, managed: true, starting: true };
  }

  function stopTts() {
    if (!ttsProc) return;
    const proc = ttsProc;
    ttsProc = null;
    try {
      proc.kill();
    } catch (error) {
      /* ignore */
    }
  }

  async function status() {
    const port = bridgePort();
    let bridgeRunning = bridgeProc && !bridgeProc.killed
      ? true
      : await probeHttp(port, '/api/health', 900);
    if (!bridgeRunning && !disposed) {
      const repaired = await ensureBridge();
      bridgeRunning = Boolean(repaired && repaired.running);
    }
    const ttsRunning = await probePort(TTS_PROXY_PORT);
    return {
      bridge: { running: !!bridgeRunning, port, managed: !!(bridgeProc && !bridgeProc.killed) },
      tts: {
        running: !!ttsRunning,
        available: ttsAvailable(),
        enabled: autoTts(),
        port: TTS_PROXY_PORT,
        enginePort: TTS_ENGINE_PORT,
        managed: !!(ttsProc && !ttsProc.killed)
      }
    };
  }

  async function restartAll() {
    stopBridge();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const bridge = await ensureBridge();
    const tts = await ensureTts(true);
    return { bridge, tts };
  }

  function dispose() {
    disposed = true;
    if (bridgeGuardTimer) clearInterval(bridgeGuardTimer);
    bridgeGuardTimer = null;
    stopBridge();
    stopTts();
  }

  startBridgeGuard();

  return {
    ensureBridge,
    ensureTts,
    stopBridge,
    stopTts,
    restartAll,
    status,
    dispose,
    ttsAvailable,
    bridgePort,
    bridgeToken,
    instanceId,
    workspaceId,
    instanceFile,
    writeEnabled: mcpWriteEnabled,
    autoTts
  };
}

module.exports = { createServices, probeHttp, probePort, probeJson, unpackedPath, TTS_ENGINE_PORT, TTS_PROXY_PORT };
