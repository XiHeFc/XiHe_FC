/**
 * 长时数据落盘（渲染层）
 * - 只负责：按采样点生成 CSV 行、批量缓冲、通过 IPC 交给主进程同步写盘
 * - 会话列固定为 [t, ...原始通道, ...脚本通道, wall, miss]，通道集合变化即结束当前会话并新开一个
 *   （wall 是该行的 UTC 墙钟；t 是按帧到达时刻推进的经过秒数，断线会体现为跳变；miss 列出该行被前向填充的通道）
 * - 浏览器模式不落盘，仅在设置面板给出提示
 */
(function () {
  'use strict';

  const X = window.XHGCS;
  if (!X) return;
  const state = X.state;
  const desktop = window.XHGCS_DESKTOP;
  const rec = desktop && desktop.isDesktop && desktop.recordings ? desktop.recordings : null;

  const FLUSH_MS = 500;
  const ENQUEUE_ROWS = 500;
  const MAX_BUFFER_ROWS = 20000;
  const UI_REFRESH_MS = 2000;
  // 链路停摆多久就停录。设备复位 / 接线松动 / 对方不再发送都不产生 read error，
  // connected 与 running 一直是 true，只按标志位判断的话录制会在一条已经死掉的链路上
  // 空转几十分钟——实测有过一次 51 分钟的会话里 50 分钟一行数据都没有，界面上却一直写着「记录中」。
  const STALL_STOP_SECONDS = 60;

  let session = null;
  let starting = false;
  let buffer = [];
  let chain = Promise.resolve();
  let pendingRows = 0;
  let dropped = 0;
  let lastStatus = null;
  let appVersion = '';
  let uiTimer = null;

  function settings() {
    if (!state.recordings || typeof state.recordings !== 'object') {
      state.recordings = { enabled: true, autoStart: true, recordSimulation: false, rotateMB: 32, capGB: 2 };
    }
    const s = state.recordings;
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.autoStart !== 'boolean') s.autoStart = true;
    if (typeof s.recordSimulation !== 'boolean') s.recordSimulation = false;
    if (!Number.isFinite(Number(s.rotateMB)) || Number(s.rotateMB) <= 0) s.rotateMB = 32;
    if (!Number.isFinite(Number(s.capGB)) || Number(s.capGB) <= 0) s.capGB = 2;
    return s;
  }

  function columns() {
    return state.channels.concat(state.scriptChannels);
  }

  function signatureOf() {
    return state.channels.map((ch) => ch.id).join('|') + '#' + state.scriptChannels.map((ch) => ch.id).join('|');
  }

  function activeEngineLabel() {
    const engine = X.getActiveEngine ? X.getActiveEngine() : null;
    return engine ? String(engine.name || '') + ' / ' + String(engine.protocol || '') : '';
  }

  function manifestOf(source) {
    return {
      app: 'Xuanji',
      version: appVersion,
      intervalMs: state.intervalMs,
      source: source,
      engine: activeEngineLabel(),
      channels: columns().map((ch) => ({ id: ch.id, name: ch.name, unit: ch.unit || '' }))
    };
  }

  function toast(message) {
    if (window.XHGCS_APP && window.XHGCS_APP.toast) window.XHGCS_APP.toast(message);
  }

  function enqueue() {
    if (!rec || !buffer.length) return chain;
    const text = buffer.join('');
    const rows = buffer.length;
    buffer = [];
    pendingRows += rows;
    chain = chain.then(() => rec.append(text, rows)).then(
      (res) => {
        pendingRows -= rows;
        if (!res || res.ok === false) {
          dropped += rows;
          desktop.log('recorder append rejected: ' + ((res && res.reason) || 'unknown'));
        }
      },
      (err) => {
        pendingRows -= rows;
        dropped += rows;
        desktop.log('recorder append error: ' + err.message);
      }
    );
    return chain;
  }

  // 会话在 IPC 返回之前就先挂上了（started:false），让采样点知道「正在开一个会话」。
  // 代价是：chain 上只要有一个 promise 永远不 settle（主进程卡死 / IPC 丢了），session 就
  // 永远停在 started:false、starting 永远是 true —— 三条自愈路径全被挡住，界面写着「未记录」
  // 而后台每秒往一个已经死掉的通道灌数据（实测 desktop.log 里连刷了 314 秒）。加超时捞回来。
  const START_TIMEOUT_MS = 10000;

  function clearSessionTimer(target) {
    if (target && target.timer) {
      clearTimeout(target.timer);
      target.timer = 0;
    }
  }

  function startSession(source, silent) {
    if (!rec || session || starting || !settings().enabled) return null;
    const cols = columns();
    if (!cols.length) return null;
    starting = true;
    const manifest = manifestOf(source);
    const mine = { source: source, cols: cols, signature: signatureOf(), rows: 0, started: false, timer: 0 };
    session = mine;
    mine.timer = setTimeout(() => {
      mine.timer = 0;
      if (session !== mine || mine.started) return;
      desktop.log('recorder start timeout: 主进程 ' + START_TIMEOUT_MS + 'ms 未返回');
      session = null;
      starting = false;
      toast('记录启动超时，已放弃本次记录（可以再点一次开始记录）');
    }, START_TIMEOUT_MS);
    chain = chain.then(() => rec.start(manifest)).then(
      (res) => {
        clearSessionTimer(mine);
        if (session !== mine) return; // 已被超时或停止收走，别再改状态
        starting = false;
        if (!res || !res.session) {
          session = null;
          toast('记录启动失败');
          return;
        }
        mine.started = true;
        lastStatus = res.session;
        renderPanel();
        if (!silent) toast(source === 'serial' ? '已开始记录串口数据' : '已开始记录仿真数据');
      },
      (err) => {
        clearSessionTimer(mine);
        if (session !== mine) return;
        starting = false;
        session = null;
        desktop.log('recorder start error: ' + err.message);
        toast('记录启动失败：' + err.message);
      }
    );
    return session;
  }

  function stopSession(reason) {
    if (!rec || !session) return Promise.resolve(null);
    clearSessionTimer(session);
    // 还没启动起来就被停掉（或启动超时后又被停）：starting 得一起放掉，
    // 否则下一次 startSession 会因为 starting 为 true 直接返回 null，再也起不来
    if (!session.started) starting = false;
    session = null;
    return enqueue()
      .then(() => chain)
      .then(() => rec.stop(reason || 'stop'))
      .then(
        (res) => {
          if (res) lastStatus = null;
          refreshStatus();
          return res;
        },
        (err) => {
          desktop.log('recorder stop error: ' + err.message);
          return null;
        }
      );
  }

  function onSample(event) {
    if (!rec || !settings().enabled) return;
    const detail = (event && event.detail) || {};
    const source = detail.source === 'serial' ? 'serial' : 'simulation';
    if (!session) {
      if (starting) return;
      if (source === 'simulation' && !settings().recordSimulation) return;
      if (!settings().autoStart) return;
      startSession(source, true);
      if (!session) return;
    }
    if (session.source !== source) return;
    // 文件还没打开（IPC 尚未返回）时不要往缓冲里灌：主进程会以 inactive 拒收，
    // 而缓冲又被 tick() 反复冲刷，于是变成每秒一条的日志噪音，界面却显示「未记录」
    if (!session.started) return;
    const t = Number(detail.t);
    if (!Number.isFinite(t)) return;
    const parts = [t.toFixed(3)];
    session.cols.forEach((ch) => {
      const data = ch.data;
      const value = data && data.length ? Number(data[data.length - 1]) : NaN;
      parts.push(Number.isFinite(value) ? value.toFixed(4) : '');
    });
    // 末列补墙钟时间。t 列只是「经过秒数」，光靠它没法把文件对齐到现实时刻，
    // 也没法和 manifest 的 startedAt / endedAt 对上账。补在末列是为了不动前面
    // 已经按 manifest.channels 顺序排好的通道列，避免按位置解析的脚本静默错位。
    const wall = Number(detail.wall);
    parts.push(Number.isFinite(wall) && wall > 0 ? new Date(wall).toISOString() : '');
    // 再补一列「本行哪些通道是前向填充的」（| 分隔的通道 id，没有则空）。
    // 缺失值原来和实测值长得一模一样，事后统计会把同一批数字算两遍。
    const filled = Array.isArray(detail.filled) ? detail.filled : [];
    parts.push(filled.length ? filled.join('|').replace(/,/g, ' ') : '');
    buffer.push(parts.join(',') + '\n');
    session.rows += 1;
    if (buffer.length >= ENQUEUE_ROWS) enqueue();
    if (buffer.length > MAX_BUFFER_ROWS) {
      const lost = buffer.length - MAX_BUFFER_ROWS;
      buffer.splice(0, lost);
      dropped += lost;
    }
  }

  function checkChannelChange() {
    if (!session || !session.started) return;
    if (signatureOf() === session.signature) return;
    const wasSerial = session.source === 'serial';
    stopSession('channels-changed').then(() => {
      if (!settings().enabled) return;
      if (wasSerial && state.serial.connected && state.serial.running) startSession('serial', true);
      else if (!wasSerial && settings().recordSimulation && state.simulation.enabled) startSession('simulation', true);
    });
  }

  function checkAutoStop() {
    if (!session || !session.started) return;
    if (!settings().enabled) { stopSession('disabled'); return; }
    if (session.source === 'serial') {
      if (!state.serial.connected || !state.serial.running) {
        stopSession('disconnect');
        return;
      }
      // 标志位看不出「人还在、数据没了」：这类停摆只能靠距上一帧的真实时间来判
      const serial = window.XHGCS_SERIAL;
      const quiet = serial && serial.quietSeconds ? serial.quietSeconds() : null;
      if (quiet != null && quiet >= STALL_STOP_SECONDS) {
        stopSession('stalled');
        toast('串口已 ' + Math.round(quiet) + ' 秒没有收到数据，已停止记录（避免录出一份几乎全空的文件）');
      }
      return;
    }
    if (session.source === 'simulation' && !state.simulation.enabled) stopSession('simulation-off');
  }

  function tick() {
    if (!rec || !settings().enabled) return;
    enqueue();
    checkChannelChange();
    checkAutoStop();
  }

  function refreshStatus() {
    if (!rec) return Promise.resolve(null);
    return rec.status().then(
      (res) => { lastStatus = res; return res; },
      (err) => { desktop.log('recorder status error: ' + err.message); return null; }
    );
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1048576).toFixed(1) + ' MB';
    return (value / 1073741824).toFixed(2) + ' GB';
  }

  const esc = X.esc;

  function renderControls() {
    const s = settings();
    const set = (selector, value) => { const el = document.querySelector(selector); if (el) el.value = String(value); };
    set('#recEnabled', s.enabled ? '1' : '0');
    set('#recAutoStart', s.autoStart ? '1' : '0');
    set('#recSimulation', s.recordSimulation ? '1' : '0');
    set('#recRotateMB', s.rotateMB);
    set('#recCapGB', s.capGB);
  }

  function renderPanel() {
    const host = document.querySelector('#recPanel');
    if (!host) return;
    const s = settings();
    const live = session && session.started;
    const info = lastStatus || null;
    const rows = (live ? session.rows : (info && info.lastSession ? info.lastSession.rows : 0)) || 0;
    const dir = (info && info.dir) || '—';
    const totalBytes = info ? info.totalBytes : 0;
    const limitBytes = info ? info.limitBytes : 0;
    const part = info && info.part ? info.part : 0;
    const sessionDir = live ? (info && info.dir) || '' : (info && info.lastSession ? info.lastSession.dir : '');

    // 没在记录时「本次行数 0 / 分片 — / 丢弃行 0 / 上次会话 —」全是空话，摆一排等于什么都没说：
    // 只留「记录状态」和「记录总量」两块，真有内容（行数、分片、丢弃行、上次会话）才出现。
    const tiles = [
      ['记录状态', live ? '记录中 · ' + (session.source === 'serial' ? '串口' : '仿真') : '未记录'],
      live ? ['本次行数', String(rows)] : null,
      live && part ? ['分片', String(part)] : null,
      dropped > 0 ? ['丢弃行', String(dropped)] : null,
      ['记录总量', formatBytes(totalBytes) + ' / ' + formatBytes(limitBytes)],
      !live && info && info.lastSession ? ['上次会话', info.lastSession.sessionId + ' · ' + info.lastSession.rows + ' 行'] : null
    ].filter(Boolean);

    host.innerHTML =
      '<div class="desktop-meta">' +
      tiles.map((tile) => '<div><span>' + esc(tile[0]) + '</span><b>' + esc(tile[1]) + '</b></div>').join('') +
      '</div>' +
      '<div class="hint desktop-hint">记录目录 ' + esc(dir) + (sessionDir ? '<br />当前会话 ' + esc(sessionDir) : '') + '</div>';

    // 三个按钮点了没事发生时就不要装作能用：在记录时「立即开始」没用，没记录时「停止」没用，
    // 没有落盘文件时「清空全部记录」也没对象可清。
    const startBtn = document.querySelector('#recStartNow');
    if (startBtn) { startBtn.disabled = !!live; startBtn.title = live ? '已经在记录中' : ''; }
    const stopBtn = document.querySelector('#recStopNow');
    if (stopBtn) { stopBtn.disabled = !live; stopBtn.title = live ? '' : '当前没有记录会话'; }
    const clearBtn = document.querySelector('#recClearAll');
    if (clearBtn) { clearBtn.disabled = !totalBytes; clearBtn.title = totalBytes ? '' : '还没有已落盘的数据'; }
  }

  function loadSessions() {
    if (!rec) return;
    rec.list().then((list) => {
      const host = document.querySelector('#recSessions');
      if (!host) return;
      const items = (list || []).slice(0, 5);
      host.innerHTML = items.length
        ? items.map((item) => {
            const rows = item.manifest && item.manifest.rows != null ? item.manifest.rows : '—';
            const when = item.manifest && item.manifest.startedAt ? String(item.manifest.startedAt).replace('T', ' ').slice(0, 19) : item.name;
            return '<div class="desktop-service"><span class="desktop-dot ok"></span>' +
              '<div class="desktop-service-main"><b>' + esc(when) + '</b><small>' + esc(item.name) + ' · ' + esc(rows) + ' 行</small></div>' +
              '<span class="desktop-tag ok">' + esc(formatBytes(item.sizeBytes)) + '</span></div>';
          }).join('')
        : '<div class="hint">暂无历史记录</div>';
    }, (err) => desktop.log('recorder list error: ' + err.message));
  }

  function refreshUi() {
    renderControls();
    refreshStatus().then(() => { renderPanel(); loadSessions(); });
  }

  function applyConfig() {
    const s = settings();
    X.persist();
    if (!rec) return;
    rec.configure({ rotateMB: s.rotateMB, capGB: s.capGB }).then(
      (res) => { if (res) { s.rotateMB = res.rotateMB; s.capGB = res.capGB; X.persist(); } },
      (err) => desktop.log('recorder configure error: ' + err.message)
    );
  }

  function onToggleEnabled(event) {
    const s = settings();
    s.enabled = event.target.value === '1';
    applyConfig();
    if (!s.enabled) {
      stopSession('disabled');
    } else if (state.simulation.enabled) {
      if (s.recordSimulation) startSession('simulation', true);
    } else if (state.serial.connected && state.serial.running) {
      startSession('serial', true);
    }
    renderPanel();
  }

  function bindUi() {
    if (!rec) return;
    const on = (selector, type, handler) => {
      const el = document.querySelector(selector);
      if (el) el.addEventListener(type, handler);
    };
    on('#recEnabled', 'change', onToggleEnabled);
    on('#recAutoStart', 'change', (event) => {
      settings().autoStart = event.target.value === '1';
      applyConfig();
    });
    on('#recSimulation', 'change', (event) => {
      settings().recordSimulation = event.target.value === '1';
      applyConfig();
    });
    on('#recRotateMB', 'change', (event) => {
      const value = Math.max(1, Math.min(4096, Number(event.target.value) || 32));
      settings().rotateMB = value;
      event.target.value = String(value);
      applyConfig();
      renderPanel();
    });
    on('#recCapGB', 'change', (event) => {
      const value = Math.max(0.0625, Math.min(1024, Number(event.target.value) || 2));
      settings().capGB = value;
      event.target.value = String(value);
      applyConfig();
      renderPanel();
    });
    on('#recStartNow', 'click', () => {
      if (!settings().enabled) { toast('请先启用落盘'); return; }
      const source = state.simulation.enabled ? 'simulation' : 'serial';
      if (source === 'serial' && (!state.serial.connected || !state.serial.running)) { toast('串口未连接或未接收'); return; }
      if (source === 'simulation' && !settings().recordSimulation) { toast('请先开启“记录仿真数据”'); return; }
      if (session) { toast('已在记录中'); return; }
      startSession(source, false);
    });
    on('#recStopNow', 'click', () => {
      if (!session) { toast('当前没有进行中的记录'); return; }
      stopSession('manual').then(() => { toast('记录已停止'); refreshUi(); });
    });
    on('#recOpenDir', 'click', () => {
      if (!rec) return;
      rec.open().then((err) => { if (err) toast('打开目录失败：' + err); });
    });
    on('#recClearAll', 'click', () => {
      if (!rec) return;
      if (!window.confirm('清空全部记录？该操作会删除所有已落盘会话，不可恢复。')) return;
      stopSession('clear').then(() => rec.clear()).then(
        () => { toast('记录已清空'); refreshUi(); },
        (err) => toast('清空失败：' + err.message)
      );
    });
  }

  function boot() {
    if (!rec) return;
    if (desktop.getStatus) {
      desktop.getStatus().then((status) => {
        if (status && status.appVersion) appVersion = String(status.appVersion);
      }, () => {});
    }
    window.addEventListener('xhgcs:sample', onSample);
    window.addEventListener('xhgcs:serial-changed', () => { setTimeout(tick, 0); });
    window.addEventListener('pagehide', () => {
      if (session) {
        enqueue();
        rec.stop('page-unload');
      }
    });
    setInterval(tick, FLUSH_MS);
    uiTimer = setInterval(() => {
      const panel = document.querySelector('.settings-section[data-settings-panel="record"]');
      if (!panel || !panel.classList.contains('active')) return;
      refreshUi();
    }, UI_REFRESH_MS);
    const navButton = document.querySelector('.settings-nav-btn[data-settings-nav="record"]');
    if (navButton) navButton.addEventListener('click', refreshUi);
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-action="settings"]') : null;
      if (target) setTimeout(refreshUi, 60);
    }, true);
    bindUi();
    // 以界面配置为准同步给主进程，避免两侧阈值漂移
    applyConfig();
    refreshUi();
  }

  window.XHGCS_RECORDER = {
    start: (source) => startSession(source === 'simulation' ? 'simulation' : 'serial', false),
    stop: stopSession,
    flush: enqueue,
    settings: settings,
    refresh: refreshUi,
    get recording() { return Boolean(session && session.started); },
    get sessionRows() { return session ? session.rows : 0; },
    get droppedRows() { return dropped; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
