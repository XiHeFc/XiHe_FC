(function () {
  'use strict';
  const X = window.XHGCS;
  const TTS = window.XHGCS_TTS;
  let queue = [];
  let active = null;
  let running = false;
  let timer = null;
  let generation = 0;
  let audioWorker = null;
  let workerError = '';
  let pending = Object.create(null);

  function config() {
    return (X && X.state && X.state.ai && X.state.ai.tts) || {};
  }

  function modeValue() {
    const value = String(config().mode || '');
    if (value === 'chat' || value === 'alarm' || value === 'both') return value;
    return config().autoSpeak === false ? 'alarm' : 'chat';
  }

  function enabledFor(source) {
    const cfg = config();
    if (cfg.enabled === false) return false;
    const value = modeValue();
    if (source === 'alarm') return value === 'alarm' || value === 'both';
    return value === 'chat' || value === 'both';
  }

  function formatAlarm(alarm, overrides) {
    const cfg = Object.assign({}, config(), overrides || {});
    const template = String(cfg.alarmTemplate || '注意，{channel}{label}，当前值 {value}{unit}。');
    const value = Number(alarm && alarm.value);
    const valueText = Number.isFinite(value) ? Number(value).toFixed(2) : '--';
    return template
      .replace(/\{channel\}/g, String(alarm && alarm.name || '通道'))
      .replace(/\{label\}/g, String(alarm && alarm.label || '异常'))
      .replace(/\{value\}/g, valueText)
      .replace(/\{unit\}/g, String(alarm && alarm.unit || ''));
  }

  function status() {
    const alarms = (X && X.state && X.state.alarms) || [];
    const ttsStatus = TTS && typeof TTS.getStatus === 'function' ? TTS.getStatus() : {};
    return {
      running: running,
      enabled: config().enabled !== false,
      mode: modeValue(),
      queue: queue.length,
      active: active ? { id: active.id, text: String(active.text || '').slice(0, 80), source: active.source } : null,
      alarmPending: alarms.filter((item) => item.ttsPending).length,
      alarmUnack: alarms.filter((item) => !item.ack).length,
      engine: config().engine || 'browser',
      worker: Boolean(audioWorker),
      workerError: workerError,
      lastError: ttsStatus.lastError || ''
    };
  }

  function dispatch() {
    const detail = status();
    window.dispatchEvent(new CustomEvent('xhgcs:tts-worker-status-changed', { detail: detail }));
    window.dispatchEvent(new CustomEvent('xhgcs:tts-status-changed', { detail: Object.assign(detail, TTS ? TTS.getStatus() : {}) }));
  }

  function taskDetails(item) {
    return {
      source: item.origin || item.source,
      mode: modeValue(),
      engine: config().engine || 'browser',
      channel: item.alarm ? item.alarm.name || '' : '',
      level: item.alarm ? item.alarm.level || '' : '',
      alarmId: item.alarm ? item.alarm.id || '' : '',
      queueId: item.id
    };
  }

  function createWorker() {
    if (audioWorker) return audioWorker;
    if (typeof Worker !== 'function') {
      workerError = '当前环境不支持 Web Worker';
      return null;
    }
    try {
      const version = window.XHGCS_ASSET_VERSION || '0';
      const worker = new Worker('assets/js/tts-audio-worker.js?v=' + encodeURIComponent(version));
      worker.onmessage = function (event) {
        const message = event.data || {};
        const request = pending[message.requestId];
        if (!request) return;
        clearTimeout(request.timeout);
        delete pending[message.requestId];
        if (message.type === 'audio') {
          request.resolve({
            buffer: message.payload && message.payload.arrayBuffer,
            mimeType: (message.payload && message.payload.mimeType) || 'audio/wav'
          });
        } else {
          const error = message.payload && message.payload.error ? message.payload.error : '语音 Worker 返回错误';
          workerError = String(error);
          request.reject(new Error(workerError));
        }
      };
      worker.onerror = function (event) {
        workerError = event && event.message ? event.message : '语音 Worker 异常';
        const keys = Object.keys(pending);
        keys.forEach(function (key) {
          const request = pending[key];
          clearTimeout(request.timeout);
          request.reject(new Error(workerError));
          delete pending[key];
        });
        try { worker.terminate(); } catch (err) {}
        audioWorker = null;
      };
      return worker;
    } catch (err) {
      workerError = err && err.message ? err.message : '语音 Worker 创建失败';
      return null;
    }
  }

  function synthesize(text, options) {
    const worker = createWorker();
    return new Promise(function (resolve, reject) {
      if (!worker) {
        reject(new Error(workerError || '语音 Worker 不可用'));
        return;
      }
      const id = 'tts-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const timeout = setTimeout(function () {
        const request = pending[id];
        if (!request) return;
        delete pending[id];
        workerError = '语音合成超时';
        request.reject(new Error(workerError));
      }, 60000);
      pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      worker.postMessage({
        type: 'synthesize',
        requestId: id,
        payload: {
          text: text,
          endpoint: options.endpoint,
          apiKey: options.apiKey,
          voice: options.voice,
          speed: options.speed
        }
      });
    });
  }

  async function resolveVoice(options) {
    const voice = String(options.voice || config().voice || '');
    if (voice && voice !== 'default') return voice;
    if (TTS && typeof TTS.resolveSovitsVoice === 'function') {
      try {
        return await TTS.resolveSovitsVoice(voice, options.endpoint, options.apiKey);
      } catch (err) {}
    }
    return voice || 'default';
  }

  async function playItem(item) {
    const cfg = Object.assign({}, config(), item.options || {});
    const options = {
      source: item.source || 'chat',
      engine: cfg.engine || 'browser',
      endpoint: cfg.endpoint || 'http://127.0.0.1:8770',
      apiKey: cfg.apiKey || '',
      voice: cfg.voice || 'default',
      speed: Math.max(0.5, Math.min(2, Number(cfg.speed) || 1))
    };
    if (options.engine === 'sovits') {
      try {
        const voice = await resolveVoice(options);
        const audio = await synthesize(item.text, Object.assign({}, options, { voice: voice }));
        if (item.generation !== generation) return { ok: false, canceled: true };
        const blob = new Blob([audio.buffer], { type: audio.mimeType || 'audio/wav' });
        return await TTS.playBlob(blob, Object.assign({}, options, { engine: 'sovits' }));
      } catch (err) {
        workerError = err && err.message ? err.message : '语音合成失败';
        try { return await TTS.speak(item.text, Object.assign({}, options, { force: true })); }
        catch (fallback) { return { ok: false, error: fallback && fallback.message ? fallback.message : String(fallback) }; }
      }
    }
    try {
      return await TTS.speak(item.text, Object.assign({}, options, { force: true }));
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function finish(item, result) {
    const canceled = result && result.canceled === true;
    const keep = item.generation === generation;
    if (keep && item.alarm) {
      item.alarm.ttsPending = false;
      item.alarm.lastSpokenAt = Date.now();
    }
    const ok = result && result.ok !== false && !canceled;
    if (keep && item.task && X.updateAiTask) {
      X.updateAiTask(item.task.id, {
        status: ok ? 'success' : 'error',
        message: ok ? '已播报' : (canceled ? '已停止' : '播报失败：' + ((result && result.error) || (result && result.reason) || '未知错误')),
        details: Object.assign({}, item.task.details || {}, { durationMs: Date.now() - item.createdAt })
      });
    }
    if (item.resolve) item.resolve(result || { ok: false, reason: 'empty' });
  }

  function pump() {
    if (running || !queue.length) return;
    const item = queue.shift();
    if (!enabledFor(item.source)) {
      finish(item, { ok: false, reason: 'disabled' });
      dispatch();
      return;
    }
    running = true;
    active = item;
    item.startedAt = Date.now();
    if (item.task && X.updateAiTask) {
      X.updateAiTask(item.task.id, { status: 'running', message: '正在播报' });
    }
    const current = generation;
    Promise.resolve(playItem(item))
      .then(function (result) {
        finish(item, result);
      })
      .catch(function (err) {
        finish(item, { ok: false, error: err && err.message ? err.message : String(err) });
      })
      .finally(function () {
        if (active === item && item.generation === current && current === generation) {
          running = false;
          active = null;
          dispatch();
          pump();
        } else {
          dispatch();
        }
      });
  }

  function enqueue(text, options) {
    options = options || {};
    const content = String(text || '').trim();
    if (!content) return Promise.resolve({ ok: false, reason: 'empty' });
    const source = options.source === 'alarm' ? 'alarm' : 'chat';
    const origin = options.origin || (source === 'alarm' ? 'alarm' : 'local');
    if (!enabledFor(source)) return Promise.resolve({ ok: false, reason: 'disabled', source: source });
    const item = {
      id: 'ttsq-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      text: content,
      source: source,
      name: options.name || (source === 'alarm' ? '后台告警语音' : 'AI 回复语音'),
      message: options.message || content,
      origin: origin,
      alarm: options.alarm || null,
      options: options,
      generation: generation,
      createdAt: Date.now(),
      task: null,
      resolve: null,
      reject: null
    };
    const promise = new Promise(function (resolve, reject) {
      item.resolve = resolve;
      item.reject = reject;
    });
    queue.push(item);
    if (X.addAiTask) {
      item.task = X.addAiTask({
        type: 'speech',
        name: item.name || '语音播报',
        status: 'running',
        source: item.origin,
        message: item.message,
        speech: item.text,
        details: taskDetails(item)
      });
    }
    pump();
    dispatch();
    return promise;
  }

  function tick() {
    if (!timer) return;
    const cfg = config();
    if (cfg.enabled === false || !enabledFor('alarm')) return;
    // 一次只允许有一条告警播报在排队/播放中：
    // 入队速度（每秒一条）远快于朗读速度（3~4 秒一条），不设上限会无限堆积，
    // 队伍越拖越长且无法停止；同时新告警确认后立刻生效
    if ((active && active.source === 'alarm') || queue.some(function (item) { return item.source === 'alarm'; })) return;
    const alarms = (X && X.state && X.state.alarms) || [];
    const minLevel = cfg.alarmLevel === 'high' ? 'high' : 'warn';
    const cooldownMs = Math.max(1, Number(cfg.alarmCooldown) || 5) * 1000;
    const now = Date.now();
    for (let i = 0; i < alarms.length; i++) {
      const alarm = alarms[i];
      if (alarm.ack || alarm.ttsPending) continue;
      if (alarm.level === 'warn' && minLevel === 'high') continue;
      const last = alarm.lastSpokenAt || 0;
      if (last && now - last < cooldownMs) continue;
      const text = formatAlarm(alarm, {
        alarmTemplate: cfg.alarmTemplate,
        alarmLevel: cfg.alarmLevel,
        alarmCooldown: cfg.alarmCooldown
      });
      if (!text) continue;
      alarm.ttsPending = true;
      enqueue(text, {
        source: 'alarm',
        name: '后台告警语音',
        message: text,
        alarm: alarm
      }).finally(function () {
        if (alarm) alarm.ttsPending = false;
      });
      break;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 1000);
    tick();
    dispatch();
  }

  // 播报模式切走（例如 对话+告警 → 跟随 AI 对话）时，
  // 把已排队但再也播不出去的告警清掉，并复位 ttsPending，
  // 否则这些告警会被永久标记为“待播报”，重新打开告警语音后也不会再提醒
  function dropDisabled() {
    const kept = [];
    queue.forEach(function (item) {
      if (enabledFor(item.source)) { kept.push(item); return; }
      if (item.alarm) item.alarm.ttsPending = false;
      if (item.task && X.updateAiTask) X.updateAiTask(item.task.id, { status: 'error', message: '播报模式已关闭' });
      if (item.resolve) item.resolve({ ok: false, reason: 'disabled' });
    });
    queue = kept;
  }

  function stop() {
    generation++;
    const items = queue.splice(0);
    items.forEach(function (item) {
      if (item.alarm) {
        item.alarm.ttsPending = false;
        item.alarm.lastSpokenAt = Date.now();
      }
      if (item.task && X.updateAiTask) {
        X.updateAiTask(item.task.id, { status: 'error', message: '已停止' });
      }
      if (item.resolve) item.resolve({ ok: false, canceled: true, error: '已停止' });
    });
    if (active) {
      if (active.alarm) {
        active.alarm.ttsPending = false;
        active.alarm.lastSpokenAt = Date.now();
      }
      if (active.task && X.updateAiTask) X.updateAiTask(active.task.id, { status: 'error', message: '已停止' });
      if (active.resolve) active.resolve({ ok: false, canceled: true, error: '已停止' });
      active = null;
    }
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (TTS && typeof TTS.stop === 'function') TTS.stop();
    dispatch();
  }

  function sync() {
    if (config().enabled === false) {
      stop();
    } else {
      dropDisabled();
      start();
    }
  }

  function speakNow(text, options) {
    if (!TTS) return Promise.resolve({ ok: false, error: 'TTS 模块未加载' });
    return TTS.speak(String(text || ''), Object.assign({}, options, { force: true }));
  }

  window.XHGCS_TTS_WORKER = {
    start: start,
    stop: stop,
    sync: sync,
    tick: tick,
    status: status,
    formatAlarm: formatAlarm,
    speakNow: speakNow,
    enqueue: enqueue
  };
  sync();
})();
