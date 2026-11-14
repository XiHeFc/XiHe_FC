(function () {
  'use strict';

  const X = window.XHGCS;
  const state = X.state;
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();

  let port = null;
  let reader = null;
  let reading = false;
  let stopping = false;
  let buffer = '';
  let binaryBuffer = [];
  let recoveredBreaks = 0;
  let breakWindowStart = 0;
  let firstFrameTimer = 0;
  let announcedReceiving = false;
  const P = window.XHGCS_PROTOCOL || {};
  const RECOVER_LIMIT = 3;
  const RECOVER_WINDOW_MS = 15000;
  const RECOVER_BACKOFF_MS = 300;
  const NO_DATA_WARN_MS = 2000;
  // 线路瞬态事件：BREAK / 帧错误 / 校验错误 / 溢出都只是「这一次没读好」，不是链路死了。
  // RX 悬空、设备正在复位、波特率半匹配都会持续冒这些；当成致命错误处理的话，一次 BREAK
  // 就会把整条链路永久废掉，而 Chromium 打开过的句柄还留在本进程手里。
  const LINE_ERROR_PATTERN = /break|framing|parity|overrun|帧错误|校验错误|溢出/i;
  // 真的没救了：设备被拔走、端口被别的程序占用、打不开。
  const FATAL_ERROR_PATTERN = /device lost|access denied|failed to open|no such device|拒绝访问|已被占用/i;

  function supported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  function requireSecure() {
    if (!supported()) throw new Error('当前浏览器或环境不支持 Web Serial，请改用 Edge/Chrome 并通过 localhost 打开。');
    if (!window.isSecureContext) throw new Error('Web Serial 需要安全上下文，请使用 http://localhost 或 https 打开页面。');
  }

  function hexOnly(value) {
    return String(value || '').replace(/[^0-9a-fA-F]/g, '');
  }


  function notify() {
    window.dispatchEvent(new CustomEvent('xhgcs:serial-changed', {
      detail: {
        connected: state.serial.connected,
        running: state.serial.running,
        receiving: state.serial.receiving,
        breaks: state.serial.breaks,
        port: state.serial.port,
        simulation: state.simulation.enabled
      }
    }));
  }

  function notice(message, level) {
    window.dispatchEvent(new CustomEvent('xhgcs:serial-notice', { detail: { message: message, level: level || 'info' } }));
  }

  function reportFault(message) {
    X.pushLog('err', message, 0);
    notice(message, 'error');
  }

  function serialOptions() {
    return {
      baudRate: Number(state.serial.baud) || 115200,
      dataBits: Number(state.serial.dataBits) || 8,
      parity: String(state.serial.parity || 'None').toLowerCase(),
      stopBits: Number(state.serial.stopBits) || 1,
      flowControl: 'none'
    };
  }

  // 关端口必须真的放句柄：BREAK 之后只改标志位不 close，Chromium 会把 COM 口一直占着。
  // 实测失败后 PowerShell 打开同一个口直接 Access denied，再点连接也只会挂到那条死掉的数据流上。
  async function closePort(options) {
    const target = port;
    reader = null;
    if (target) {
      try {
        if (target.readable || target.writable) await target.close();
      } catch (err) {
        // 设备被拔走时 close() 会抛，属于正常情况：句柄已经随设备一起消失了
      }
    }
    if (options && options.forget) port = null;
  }

  async function openPort() {
    if (!port) throw new Error('未选择串口设备');
    if (port.readable || port.writable) await closePort();
    try {
      await port.open(serialOptions());
    } catch (err) {
      if (!/already open/i.test(String(err && err.message || ''))) throw err;
    }
    return port;
  }

  function classifyReadError(err) {
    const message = String(err && err.message || err);
    if (LINE_ERROR_PATTERN.test(message)) return 'line';
    if (FATAL_ERROR_PATTERN.test(message)) return 'fatal';
    return 'unknown';
  }

  // 连续冒线路错误就不是「这一下没读好」：先把句柄放掉再重开，最多 3 次 / 15 秒。
  async function recoverFromLineError(err) {
    const message = String(err && err.message || err);
    const now = Date.now();
    state.serial.breaks += 1;
    state.serial.lastError = message;
    if (!breakWindowStart) breakWindowStart = now;
    recoveredBreaks += 1;
    if (recoveredBreaks > RECOVER_LIMIT || now - breakWindowStart > RECOVER_WINDOW_MS) {
      X.pushLog('warn', '串口接收连续中断 ' + recoveredBreaks + ' 次，停止自动重连', 0);
      return false;
    }
    X.pushLog('warn', '串口接收中断（瞬态）：' + message + ' · 第 ' + recoveredBreaks + ' 次，正在重连', 0);
    notify();
    await closePort();
    await new Promise((resolve) => setTimeout(resolve, RECOVER_BACKOFF_MS));
    if (stopping) return false;
    try {
      await openPort();
    } catch (openError) {
      state.serial.lastError = String(openError && openError.message || openError);
      X.pushLog('err', '串口重连失败：' + state.serial.lastError, 0);
      return false;
    }
    clearBuffers();
    return true;
  }

  // 端口打开不等于有数据：首帧之前不能报「接收中」，否则界面上就是「说连上了但一条数据都没有」
  function armFirstFrameWatch() {
    clearTimeout(firstFrameTimer);
    firstFrameTimer = setTimeout(() => {
      firstFrameTimer = 0;
      if (stopping || !state.serial.connected || state.serial.receiving) return;
      // 收到了数据、只是不符合当前协议：mismatch 提示已经把原因说清楚了，别再报「没收到数据」
      if (mismatchLines > 0) return;
      notice('端口已打开但暂未收到有效数据（线路可能处于 BREAK / 低电平）', 'warn');
    }, NO_DATA_WARN_MS);
  }

  // 收到第一帧之后的静默停摆：设备复位、线松了、对方不再发送。这些都不产生 read error，
  // connected/running 一直是 true，界面就永远显示「接收中」——原来只有连接时的首帧看门狗，
  // 过了首帧就把这事忘了。实测后果是一次 51 分钟的会话里有 50 分钟一行数据都没有，
  // 界面上却一直说在记录，文件里还看不出来。
  const STALL_FLOOR_MS = 2000;
  const STALL_FACTOR = 4;
  const STALL_TICK_MS = 500;
  let stallTimer = 0;
  let lastFramePerfMs = 0;
  let frameGapMs = 0;
  let stallNotified = false;

  function noteFrameArrived() {
    const now = performance.now();
    if (lastFramePerfMs) {
      const gap = now - lastFramePerfMs;
      // 用实测帧间隔的滑动平均估「正常间隔」：1Hz 的设备要等 4 秒才算停摆，不会被误判
      frameGapMs = frameGapMs ? frameGapMs * 0.7 + gap * 0.3 : gap;
    }
    lastFramePerfMs = now;
    stallNotified = false;
  }

  function armStallWatch() {
    if (stallTimer) return;
    stallTimer = setInterval(() => {
      if (stopping || !state.serial.connected || !state.serial.running) return;
      if (!lastFramePerfMs) return; // 还没收到过首帧，归首帧看门狗管
      const quietMs = performance.now() - lastFramePerfMs;
      if (quietMs <= Math.max(STALL_FLOOR_MS, frameGapMs * STALL_FACTOR)) return;
      state.serial.receiving = false;
      if (!stallNotified) {
        stallNotified = true;
        const secs = (quietMs / 1000).toFixed(1);
        X.pushLog('warn', '链路停摆：距上一帧已 ' + secs + ' 秒没有有效数据', 0);
        notice('串口已 ' + secs + ' 秒没有收到有效数据，链路可能已停摆（设备复位 / 接线松动 / 对方不再发送）', 'warn');
      }
      notify();
    }, STALL_TICK_MS);
  }

  function disarmStallWatch() {
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = 0;
    }
    lastFramePerfMs = 0;
    frameGapMs = 0;
    stallNotified = false;
  }

  // 距上一帧的真实秒数；没有在收数时返回 null。落盘一侧靠它判断「还在不在收」，
  // 不再只看 connected/running 两个标志位。
  function quietSeconds() {
    if (!lastFramePerfMs) return null;
    return (performance.now() - lastFramePerfMs) / 1000;
  }

  // 渲染层只能拿到 VID/PID，拿不到 COM 口号；桌面版向主进程要最近一次选中的端口名，
  // 界面上「USB 串口 · VID:1027 PID:24577 (COM18)」比光秃秃一串数字有用得多。
  async function resolvePortLabel(target, grantedCount) {
    let base = '串口设备';
    try {
      const info = target && target.getInfo ? target.getInfo() : null;
      if (info && (info.usbVendorId || info.usbProductId)) {
        base = 'USB 串口 · VID:' + info.usbVendorId + ' PID:' + info.usbProductId;
      }
    } catch (err) {}
    const api = window.XHGCS_DESKTOP;
    if (api && api.isDesktop && api.serial && api.serial.list && api.serial.winList) {
      try {
        const [list, win] = await Promise.all([api.serial.list(), api.serial.winList()]);
        const names = (win && win.ok ? win.ports : []) || [];
        const remembered = String(list && list.lastSerialPort || '');
        // 记住的口可能已经拔了（上次 COM3、这次插的是 COM18）：只有在系统列表里还找得到
        // 才敢写出来 —— 界面上那个 COM 号要是错的，比不写更坑人
        if (remembered && names.indexOf(remembered) >= 0) return base + ' (' + remembered + ')';
        // 只有 1 个能打开的设备、系统也只有 1 个 COM 口时，两者必然是同一个
        if (grantedCount === 1 && names.length === 1) return base + ' (' + names[0] + ')';
      } catch (err) {}
    }
    return base;
  }

  // 枚举到 0 个端口时问一次主进程：两边都没有 = 设备/驱动问题；Windows 有而应用没有 = 还没授权。
  // 原来这条路是静默 callback('')，用户只看到 Chromium 那句 No port selected by the user。
  async function describeMissingPorts() {
    const api = window.XHGCS_DESKTOP;
    if (api && api.isDesktop && api.serial && api.serial.winList) {
      try {
        const res = await api.serial.winList();
        const names = (res && res.ports) || [];
        if (names.length) {
          return 'Windows 检测到 ' + names.length + ' 个串口（' + names.join(' / ') + '），但应用还没有拿到端口授权：在端口下拉里选一个，或点「选择其它串口…」重新授权';
        }
      } catch (err) {}
    }
    return '未检测到串口设备，请检查 USB 连接、驱动与供电';
  }

  function clearBuffers() {
    buffer = '';
    binaryBuffer = [];
  }

  function updatePortInput() {
    const input = document.getElementById('portSelect');
    if (input) input.value = state.serial.port || '未选择';
  }

  // 换协议 = 新的解析会话：旧的帧/错计数属于上一个协议，留着只会误导「怎么还在报错」
  window.addEventListener('xhgcs:engine-active-changed', () => {
    clearBuffers();
    state.serial.frames = 0;
    state.serial.errors = 0;
    mismatchLines = 0;
    mismatchNotified = false;
    mismatchSample = '';
    notify();
  });

  async function selectPort() {
    requireSecure();
    if (state.serial.connected) await disconnect();
    // 授权是按运行/源算的，刚装机或换了端口后 getPorts 就是空 —— 这时候更要走 requestPort：
    // 只有它会唤起系统/应用内的选口面板。以前先判「没有已授权端口」就抛错，表现就是「扫不到 COM 口」。
    try {
      port = await navigator.serial.requestPort();
    } catch (err) {
      const message = String(err && err.message || err);
      if (/no port selected|cancel/i.test(message)) throw new Error('已取消选择串口');
      throw err;
    }
    const granted = navigator.serial.getPorts ? await navigator.serial.getPorts() : [];
    state.serial.port = await resolvePortLabel(port, granted.length || 1);
    X.persist();
    updatePortInput();
    notify();
    return port;
  }

  // 从已授权的端口里显式选一个（界面下拉框用）：与 selectPort 的区别是不弹系统选择器
  async function usePort(index) {
    requireSecure();
    const granted = navigator.serial.getPorts ? await navigator.serial.getPorts() : [];
    const target = granted[Number(index)] || null;
    if (!target) throw new Error('端口不存在或授权已失效，请重新选择');
    if (state.serial.connected) await disconnect();
    port = target;
    state.serial.port = await resolvePortLabel(port, granted.length);
    X.persist();
    updatePortInput();
    notify();
    return port;
  }

  // 按 COM 名选口（端口下拉里的 Windows 口列表）：requestPort 会让主进程把枚举列表交出来，
  // 桥接层（v43-bridge）看到 window.__XHGCS_PICK_NAME__ 就会自动回传匹配的那个 portId。
  async function selectByName(name) {
    requireSecure();
    const wanted = String(name || '').trim();
    if (!wanted) throw new Error('端口名为空');
    if (state.serial.connected) await disconnect();
    window.__XHGCS_PICK_NAME__ = wanted;
    try {
      port = await navigator.serial.requestPort();
    } catch (err) {
      const message = String(err && err.message || err);
      if (/no port selected|cancel/i.test(message)) throw new Error('已取消选择串口');
      throw err;
    } finally {
      window.__XHGCS_PICK_NAME__ = '';
    }
    let base = '串口设备';
    try {
      const info = port && port.getInfo ? port.getInfo() : null;
      if (info && (info.usbVendorId || info.usbProductId)) base = 'USB 串口 · VID:' + info.usbVendorId + ' PID:' + info.usbProductId;
    } catch (err) {}
    state.serial.port = base + ' (' + wanted + ')';
    X.persist();
    updatePortInput();
    notify();
    return port;
  }

  async function connect() {
    requireSecure();
    stopping = false;
    const granted = navigator.serial.getPorts ? await navigator.serial.getPorts() : [];
    if (!port) {
      // 没有已授权端口时也必须走 requestPort：选口面板/单口自动选择都在这一步发生，
      // 直接抛「没检测到串口」会让第一次使用的人永远连不上（扫不到 COM 口）。
      try {
        port = granted.length === 1 ? granted[0] : await navigator.serial.requestPort();
      } catch (err) {
        const message = String(err && err.message || err);
        if (/no port selected|cancel/i.test(message)) throw new Error('已取消选择串口');
        throw err;
      }
    }
    try {
      await openPort();
    } catch (err) {
      state.serial.lastError = String(err && err.message || err);
      await closePort({ forget: true });
      const raw = String(err && err.message || err);
      // Chromium 的报错只有一句 Failed to open serial port：最常见的成因是端口被别的程序占着
      // （Arduino IDE 串口监视器 / VOFA+ / 另一个本应用实例），其次是驱动异常或线被拔了
      if (/failed to open|access denied|busy|permission|占用/i.test(raw)) {
        const portLabel = state.serial.port || '串口';
        const com = String(portLabel).match(/\((COM\d+)\)/);
        throw new Error('打不开 ' + (com ? com[1] : portLabel) + '：端口可能正被其它程序占用（Arduino IDE 串口监视器 / VOFA+ / 另一个本应用窗口）或驱动异常。关闭占用程序后重试。（原始错误：' + raw + '）');
      }
      throw err;
    }
    if (state.simulation.enabled) X.setSimulationEnabled(false);
    state.serial.port = await resolvePortLabel(port, granted.length);
    state.serial.connected = true;
    state.serial.running = true;
    state.serial.receiving = false;
    // 计数按「本次连接」算：之前仿真产生的帧数混在 serial.frames 里，接上串口后
    // 界面显示 200+ 帧而实际一帧没收到，是排查「没数据」时最误导人的数字
    state.serial.frames = 0;
    state.serial.errors = 0;
    mismatchLines = 0;
    mismatchNotified = false;
    mismatchSample = '';
    recoveredBreaks = 0;
    breakWindowStart = 0;
    announcedReceiving = false;
    clearBuffers();
    X.persist();
    updatePortInput();
    X.pushLog('sys', '串口已打开 · ' + state.serial.port + ' ' + state.serial.baud, 0);
    notify();
    startReading();
    armFirstFrameWatch();
    armStallWatch();
    return true;
  }

  async function disconnect() {
    stopping = true;
    clearTimeout(firstFrameTimer);
    firstFrameTimer = 0;
    disarmStallWatch();
    const currentReader = reader;
    if (currentReader) {
      try { await currentReader.cancel(); } catch (err) {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    try {
      if (port && port.readable) await new Promise((resolve) => setTimeout(resolve, 40));
    } catch (err) {}
    await closePort();
    clearBuffers();
    state.serial.connected = false;
    state.serial.running = false;
    state.serial.receiving = false;
    stopping = false;
    X.persist();
    X.pushLog('sys', '串口已断开', 0);
    notify();
  }

  async function handlePortError(err, kind) {
    if (stopping) return;
    const message = String(err && err.message || err);
    state.serial.errors += 1;
    state.serial.lastError = message;
    state.serial.connected = false;
    state.serial.running = false;
    state.serial.receiving = false;
    clearTimeout(firstFrameTimer);
    firstFrameTimer = 0;
    disarmStallWatch();
    if (kind === 'line') {
      reportFault('串口信号异常：接收端持续 BREAK / 线路低电平，请检查接线、共地与供电');
    } else {
      X.pushLog('err', '串口读取异常：' + message, 0);
      notice('串口读取异常：' + message, 'error');
    }
    // 无论哪种错误都要把句柄放掉，否则这个口会被本进程一直占着
    await closePort({ forget: true });
    X.persist();
    notify();
  }

  async function startReading() {
    if (reading || !port || !port.readable) return;
    reading = true;
    stopping = false;
    try {
      while (port && port.readable && !stopping) {
        const currentReader = port.readable.getReader();
        reader = currentReader;
        let readError = null;
        try {
          while (!stopping && port && port.readable) {
            const item = await currentReader.read();
            if (item.done) break;
            if (item.value && item.value.length) handleChunk(item.value);
          }
        } catch (err) {
          readError = err;
        } finally {
          if (reader === currentReader) reader = null;
          try { currentReader.releaseLock(); } catch (err) {}
        }
        if (stopping) break;
        if (!readError) {
          if (!port || !port.readable) break;
          continue;
        }
        const kind = classifyReadError(readError);
        if (kind === 'line' && await recoverFromLineError(readError)) continue;
        await handlePortError(readError, kind);
        break;
      }
    } finally {
      reading = false;
      if (!stopping && state.serial.connected) {
        state.serial.connected = false;
        state.serial.running = false;
        state.serial.receiving = false;
        X.pushLog('warn', '串口链路已结束', 0);
        notify();
      }
    }
  }

  function handleChunk(bytes) {
    state.serial.rxBytes += bytes.length;
    if (state.simulation.enabled || !state.serial.running) return;
    const engine = X.getActiveEngine();
    if (!engine) return;
    // 插件协议自带分帧器时先交给它；没有就落到下面内置的 WED / 文本分帧
    const engineCore = window.XHGCS_CORE && window.XHGCS_CORE.engine;
    if (engineCore && engineCore.protocols) {
      const custom = engineCore.protocols.ingest(engine, bytes);
      if (custom) {
        custom.frames.forEach((frame) => processFrame(frame, engine));
        return;
      }
    }
    const protocol = String(engine.protocol || '').toUpperCase();
    if (protocol === 'WED' && P.ingest) {
      const result = P.ingest(bytes, engine, binaryBuffer);
      binaryBuffer = result.buffer || [];
      result.frames.forEach((frame) => processFrame(frame.raw, engine));
      return;
    }
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 65536) buffer = buffer.slice(-32768);
    extractFrames(engine).forEach((frame) => processFrame(frame, engine));
  }

  function findJsonEnd(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') {
        if (stack.length === 0) start = i;
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const open = stack[stack.length - 1];
        const matches = (ch === '}' && open === '{') || (ch === ']' && open === '[');
        if (!open || !matches) continue;
        stack.pop();
        if (stack.length === 0 && start >= 0) return i + 1;
      }
    }
    return -1;
  }

  // 协议不符的静默黑洞：JSON 在等 '{'、HEX 在等帧头，而设备打印的是 CSV 浮点 —— 原来既不出帧
  // 也不报错，界面只剩「已连接」和一直不动的计数，用户只会觉得「没数据」。这里把完整的
  // 非协议文本行计数、写日志，第 3 行时提示一次该切到哪个解析规则。
  const CSV_LIKE = /^\s*(?:[A-Za-z_][A-Za-z0-9_ .\-]*\s*[:：]\s*)?[-+]?\d+(?:\.\d+)?(?:[,\s;|]+[-+]?\d+(?:\.\d+)?){1,}\s*$/;
  // 首行名字表也算「像 CSV」：把 acc_roll,acc_pitch,… 这类标题行认出来，提示才指得对方向
  const CSV_HEADER_LIKE = /^\s*[A-Za-z_一-龥][A-Za-z0-9_一-龥 .\-]*(?:[,\s;|]+[A-Za-z0-9_一-龥 .\-]+)+\s*$/;
  let mismatchLines = 0;
  let mismatchNotified = false;
  let mismatchSample = '';

  function noteProtocolMismatch(line) {
    mismatchLines += 1;
    if (!mismatchSample) mismatchSample = String(line).trim().slice(0, 48);
    state.serial.errors += 1;
    if (mismatchLines === 1) X.pushLog('warn', '收到与当前协议不匹配的文本：' + mismatchSample, 0);
    if (mismatchLines === 3 && !mismatchNotified) {
      mismatchNotified = true;
      const engine = X.getActiveEngine();
      const protocol = String((engine && engine.protocol) || 'RAW').toUpperCase();
      if (CSV_LIKE.test(mismatchSample) || CSV_HEADER_LIKE.test(mismatchSample)) {
        notice('收到像 CSV 浮点的数据，但当前协议是 ' + protocol + ' · 示例 «' + mismatchSample + '» · 在「输入 → 协议」切到「CSV 浮点引擎」即可出数据', 'warn');
      } else {
        notice('收到 3 行无法按 ' + protocol + ' 解析的文本 · 示例 «' + mismatchSample + '» · 请在「输入 → 协议」检查解析规则', 'warn');
      }
    }
  }

  function extractFrames(engine) {
    const frames = [];
    const terminator = engine && engine.terminator ? String(engine.terminator) : '';
    const protocol = String(engine && engine.protocol || '').toUpperCase();
    if (protocol === 'JSON') {
      while (true) {
        const end = findJsonEnd(buffer);
        if (end > 0) {
          frames.push(buffer.slice(0, end));
          buffer = buffer.slice(end);
          continue;
        }
        // 没有成形的 JSON 之前，把完整的一行按「不匹配」处理：缓冲不无限增长，用户看得到原因；
        // 若这一行里已经有 '{' / '['，说明 JSON 正在跨行成形，继续等。
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const head = buffer.slice(0, nl);
        if (head.indexOf('{') >= 0 || head.indexOf('[') >= 0) break;
        buffer = buffer.slice(nl + 1);
        const line = head.trim();
        if (line) noteProtocolMismatch(line);
      }
    } else if (terminator) {
      let index = buffer.indexOf(terminator);
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + terminator.length);
        // 空行不是帧：CRLF 与 LF 混发、或连续换行时不必按错误计
        if (frame.trim()) frames.push(frame);
        index = buffer.indexOf(terminator);
      }
    }
    if (protocol === 'HEX') {
      while (true) {
        const frame = takeHexFrame(engine);
        if (!frame) break;
        frames.push(frame);
      }
    } else if (protocol !== 'JSON' && !terminator && buffer.trim()) {
      frames.push(buffer);
      buffer = '';
    }
    return frames;
  }

  function takeHexFrame(engine) {
    const header = hexOnly(engine.header || '');
    const tail = hexOnly(engine.tail || '');
    const checksum = crcLength(engine);
    const channels = Math.max(1, state.channels.length);
    const length = header.length + channels * 4 + tail.length + checksum;
    const start = header ? buffer.indexOf(header) : 0;
    if (start < 0) {
      // 看不到帧头：把完整的文本行按「与协议不符」处理，别静默攒到 64 字节一丢了之
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) noteProtocolMismatch(line);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > 64) buffer = buffer.slice(-32);
      return null;
    }
    if (buffer.length < start + length) return null;
    const frame = buffer.slice(start, start + length);
    buffer = buffer.slice(start + length);
    return frame;
  }

  function stripHeaderTail(text, engine) {
    let value = String(text || '').trim();
    const header = String(engine && engine.header || '').trim();
    const tail = String(engine && engine.tail || '').trim();
    if (header && value.indexOf(header) === 0) value = value.slice(header.length);
    if (tail) {
      const index = value.lastIndexOf(tail);
      if (index >= 0) value = value.slice(0, index);
    }
    return value.trim();
  }

  function crcLength(engine) {
    return String(engine && engine.checksum || '').toUpperCase() === 'CRC16' ? 4 : String(engine && engine.checksum || '').toUpperCase() === 'CRC32' ? 8 : 0;
  }

  function crc32Hex(text) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < text.length; i++) {
      crc ^= text.charCodeAt(i);
      for (let j = 0; j < 8; j++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
    }
    return ('00000000' + ((crc >>> 0).toString(16))).slice(-8).toUpperCase();
  }

  function checkTextChecksum(text, engine) {
    const kind = String(engine && engine.checksum || '').toUpperCase();
    if (kind === 'NONE') return { ok: true, body: text };
    const star = text.lastIndexOf('*');
    if (star < 0) return { ok: true, body: text };
    const expected = text.slice(star + 1).trim();
    const body = text.slice(0, star);
    const actual = kind === 'CRC32' ? crc32Hex(body) : X.crc16(body);
    if (expected.toUpperCase() !== actual) return { ok: false, body: body, error: 'CRC 校验失败' };
    return { ok: true, body: body };
  }

  function jsonValues(payload, reserved) {
    const values = {};
    if (Array.isArray(payload)) {
      payload.forEach((item, index) => {
        if (item != null && Number.isFinite(Number(item))) values['CH' + (index + 1)] = Number(item);
      });
      return values;
    }
    Object.keys(payload || {}).forEach((key) => {
      if (reserved[key]) return;
      const value = Number(payload[key]);
      if (Number.isFinite(value)) values[key] = value;
    });
    return values;
  }

  function parseJsonFrame(raw, engine) {
    let text = String(raw || '').trim();
    let obj = null;
    try { obj = JSON.parse(text); } catch (err) {
      text = stripHeaderTail(text, engine);
      try { obj = JSON.parse(text); } catch (err2) { return { ok: false, error: 'JSON 解析失败' }; }
    }
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'JSON 帧格式不支持' };
    const reserved = { t: 1, time: 1, ts: 1, timestamp: 1, seq: 1, id: 1, crc: 1, crc16: 1, crc32: 1 };
    const payload = Array.isArray(obj) ? obj : obj.ch != null ? obj.ch : obj.data != null ? obj.data : obj.values != null ? obj.values : obj;
    const values = jsonValues(payload, reserved);
    if (!Object.keys(values).length) return { ok: false, error: 'JSON 帧缺少数值字段' };
    const t = obj.t != null ? obj.t : obj.ts != null ? obj.ts : obj.time != null ? obj.time : obj.timestamp;
    return { ok: true, values: values, t: t == null ? null : Number(t) };
  }

  // CSV 浮点（Arduino 打印）：每行一串逗号分隔的数，行首「samples:」之类标签可有可无。
  // 首行若全是名字（acc_roll,acc_pitch,…）当作通道名表，之后的行按名字出键；
  // 名字有重复时补 _2/_3。数值行按每行个数决定通道数（首帧由注入端自动建通道）。
  function csvHeaderNames(engine, names) {
    const seen = Object.create(null);
    return names.map(function (name) {
      const clean = String(name || '').trim().slice(0, 24) || 'CH';
      if (!seen[clean]) { seen[clean] = 1; return clean; }
      seen[clean] += 1;
      return clean + '_' + seen[clean];
    });
  }

  function parseCsvFrame(raw, engine) {
    let text = String(raw == null ? '' : raw).replace(/﻿/g, '').trim();
    if (!text) return { ok: false, error: 'CSV 空行' };
    // 去掉行首标签：samples: / samples： / 其它字母开头的词 + 冒号，且后面紧跟数值
    const label = text.match(/^[A-Za-z_一-龥][A-Za-z0-9_ .\-一-龥]*\s*[:：]\s*(?=[-+0-9.])/);
    if (label) text = text.slice(label[0].length);
    const parts = text.split(/[,\s;|]+/).filter(Boolean);
    if (!parts.length) return { ok: false, error: 'CSV 行没有数值' };
    const numeric = [];
    let bad = null;
    parts.forEach(function (part) {
      const value = Number(part);
      if (Number.isFinite(value)) numeric.push(value);
      else bad = part;
    });
    if (bad == null) {
      const header = Array.isArray(engine && engine.csvHeader) ? engine.csvHeader : null;
      const values = {};
      numeric.forEach(function (value, index) {
        const key = header && header.length === numeric.length ? header[index] : 'CH' + (index + 1);
        values[key] = value;
      });
      return { ok: true, values: values, t: null };
    }
    if (!numeric.length && parts.length >= 2 && parts.every(function (part) { return /^[A-Za-z_一-龥][A-Za-z0-9_一-龥 .\-]*$/.test(part); })) {
      if (engine) engine.csvHeader = csvHeaderNames(engine, parts);
      return { ok: true, values: {}, t: null, header: true };
    }
    return { ok: false, error: 'CSV 行含非数字字段：' + String(bad).slice(0, 24) };
  }

  function parseAsciiFrame(raw, engine) {
    let text = stripHeaderTail(raw, engine);
    const check = checkTextChecksum(text, engine);
    if (!check.ok) return { ok: false, error: check.error };
    const parts = check.body.split(/[,\s;|]+/).filter(Boolean);
    if (!parts.length) return { ok: false, error: 'ASCII 帧为空' };
    const values = {};
    let index = 0;
    parts.forEach((part) => {
      const match = part.match(/^([^:=]+)[:=](.+)$/);
      let key = null;
      let rawValue = part;
      if (match) { key = match[1].trim(); rawValue = match[2]; }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return;
      if (key) values[key] = value;
      else { index += 1; values['CH' + index] = value; }
    });
    if (!Object.keys(values).length) return { ok: false, error: 'ASCII 帧没有有效数值' };
    return { ok: true, values: values, t: null };
  }

  function parseHexFrame(raw, engine) {
    let body = hexOnly(raw);
    const header = hexOnly(engine.header || '');
    const tail = hexOnly(engine.tail || '');
    if (header && body.indexOf(header) === 0) body = body.slice(header.length);
    else if (header) {
      const index = body.indexOf(header);
      if (index < 0) return { ok: false, error: 'HEX 未找到帧头' };
      body = body.slice(index + header.length);
    }
    if (tail) {
      const index = body.lastIndexOf(tail);
      if (index < 0) return { ok: false, error: 'HEX 未找到帧尾' };
      body = body.slice(0, index);
    }
    const length = crcLength(engine);
    if (length) {
      if (body.length < length) return { ok: false, error: 'HEX 校验长度不足' };
      const payload = body.slice(0, -length);
      const checksumKind = String(engine.checksum || 'NONE').toUpperCase();
      const actual = checksumKind === 'CRC32' ? crc32Hex(payload) : X.crc16(payload);
      if (body.slice(-length).toUpperCase() !== actual) return { ok: false, error: 'HEX CRC 校验失败' };
      body = payload;
    }
    if (body.length % 4 !== 0) return { ok: false, error: 'HEX 长度不是 16bit 对齐' };
    const values = {};
    const pairs = body.length / 4;
    const little = String(engine.byteOrder || 'little').toLowerCase() !== 'big';
    const scale = Number(engine.hexScale || 10);
    for (let i = 0; i < pairs; i++) {
      const pair = body.slice(i * 4, i * 4 + 4);
      const low = parseInt(pair.slice(0, 2), 16);
      const high = parseInt(pair.slice(2, 4), 16);
      const rawInt = little ? ((high << 8) | low) : ((low << 8) | high);
      const name = state.channels[i] ? state.channels[i].name : 'CH' + (i + 1);
      values[name] = rawInt / scale;
    }
    if (!Object.keys(values).length) return { ok: false, error: 'HEX 帧没有数据' };
    return { ok: true, values: values, t: null };
  }

  // WED 通道可被用户改名：解码键是协议定义名，注入按 id/名字匹配。
  // 先按通道模板（槽序）把键换成当前通道名，改名后下一帧不会再建出重复通道。
  // 放在 parseFrame 内：内核自定义解码器和内置解码器两条路径都覆盖。
  function remapWedValues(engine, parsed) {
    if (!parsed || !parsed.ok || !parsed.values || !P.channelTemplates) return parsed;
    const templates = P.channelTemplates(engine) || [];
    if (!templates.length) return parsed;
    const indexByName = {};
    templates.forEach(function (tpl, i) { indexByName[tpl.name] = i; });
    const profileId = String((engine && engine.protocolId) || 'wed-telemetry');
    const byIndex = {};
    (state.channels || []).forEach(function (ch) {
      const idx = Number(ch && ch.protocolIndex);
      if (!Number.isFinite(idx)) return;
      if (String(ch.protocolId || 'wed-telemetry') !== profileId) return;
      byIndex[idx] = ch;
    });
    const values = {};
    Object.keys(parsed.values).forEach(function (key) {
      const idx = indexByName[key];
      const ch = idx === undefined ? null : byIndex[idx];
      // 以通道 id 作键：改名/撞名都不会互相覆盖，注入端按 id 精确匹配
      values[ch ? ch.id : key] = parsed.values[key];
    });
    return Object.assign({}, parsed, { values: values });
  }

  function parseFrame(engine, raw) {
    const protocol = String(engine && engine.protocol || '').toUpperCase();
    // 插件协议优先：内核注册过且认领了这个 protocol 的适配器先解；返回 null 就继续走内置分支
    const engineCore = window.XHGCS_CORE && window.XHGCS_CORE.engine;
    if (engineCore && engineCore.protocols) {
      const custom = engineCore.protocols.decode(engine || {}, raw);
      if (custom) return protocol === 'WED' ? remapWedValues(engine, custom) : custom;
    }
    if (protocol === 'WED' && P.decodeFrame) return remapWedValues(engine, P.decodeFrame(raw, engine));
    if (protocol === 'JSON') return parseJsonFrame(raw, engine);
    if (protocol === 'CSV') return parseCsvFrame(raw, engine);
    if (protocol === 'HEX') return parseHexFrame(raw, engine);
    return parseAsciiFrame(raw, engine);
  }

  function processFrame(raw, engine) {
    const protocol = String(engine && engine.protocol || '').toUpperCase();
    const parsed = parseFrame(engine, raw);
    if (!parsed.ok) {
      state.serial.errors += 1;
      X.pushLog('err', '#ERR [' + engine.protocol + '] ' + String(parsed.error || '解析失败') + ' · ' + String(raw).slice(0, 180), 0);
      return;
    }
    if (!state.serial.receiving) {
      state.serial.receiving = true;
      if (!announcedReceiving) {
        announcedReceiving = true;
        notice('串口正在接收数据', 'info');
      }
    }
    // 收到有效帧就说明链路是通的：把连续中断计数清零，别让历史 BREAK 累积到上限
    recoveredBreaks = 0;
    breakWindowStart = 0;
    noteFrameArrived();
    state.serial.frames += 1;
    const number = String(state.serial.frames).padStart(5, '0');
    const shown = protocol === 'WED' && P.hexBytes ? P.hexBytes(raw) : String(raw).slice(0, 360);
    X.pushLog('rx', '#' + number + ' [' + engine.protocol + '] ' + shown, 0);
    if (Object.keys(parsed.values || {}).length) X.injectRealValues(parsed.values, { t: parsed.t, engine: engine, raw: raw });
  }

  async function sendCommand(raw) {
    const cmd = String(raw == null ? '' : raw);
    if (!state.serial.connected || !port) throw new Error('真实串口未连接');
    const active = X.getActiveEngine();
    const protocol = String(active && active.protocol || '').toUpperCase();
    const hex = protocol === 'WED' ? String(cmd).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '') : String(cmd).replace(/\s/g, '');
    const bytes = protocol === 'WED' && /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0
      ? Uint8Array.from(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)))
      : encoder.encode(cmd);
    X.pushLog('tx', 'TX> ' + cmd, bytes.length);
    if (!port.writable) throw new Error('串口不可写');
    const writer = port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
    return { type: 'sent', response: '', log: null };
  }

  window.XHGCS_SERIAL = {
    supported: supported,
    selectPort: selectPort,
    usePort: usePort,
    selectByName: selectByName,
    connect: connect,
    disconnect: disconnect,
    sendCommand: sendCommand,
    parseFrame: parseFrame,
    parseFrames: function (bytes, engine, buffer) { return P.ingest ? P.ingest(bytes, engine, buffer || []) : { frames: [], buffer: [] }; },
    clearBuffer: clearBuffers,
    quietSeconds: quietSeconds,
    getPort: function () { return port; },
    isConnected: function () { return state.serial.connected; }
  };
})();
