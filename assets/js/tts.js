(function () {
  'use strict';

  const X = window.XHGCS;
  let requestId = 0;
  let audioEl = null;
  let audioUrl = '';
  let browserVoices = [];
  let browserSaved = false;
  let lastError = '';
  let speaking = false;
  let sovitsVoices = [];
  let audioSettle = null;

  function config() {
    return (X && X.state && X.state.ai && X.state.ai.tts) || {};
  }

  function dispatch(extra) {
    window.dispatchEvent(new CustomEvent('xhgcs:tts-status-changed', { detail: getStatus(extra || {}) }));
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' 代码已生成 ')
      .replace(/[#*`>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);
  }

  async function listSovitsVoices(endpoint, apiKey) {
    const base = String(endpoint || config().endpoint || 'http://127.0.0.1:8770').replace(/\/+$/, '');
    const headers = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const attempts = [base + '/api/status', base + '/api/voices'];
    for (const url of attempts) {
      try {
        const response = await fetch(url, { headers: headers });
        if (!response.ok) continue;
        const data = await response.json().catch(() => ({}));
        const list = data.voices || data.voiceList || [];
        sovitsVoices = list.map((item) => ({ id: String(item.id || item.name || ''), name: String(item.name || item.id || '') })).filter((item) => item.id);
        return sovitsVoices;
      } catch (err) {}
    }
    sovitsVoices = [];
    return sovitsVoices;
  }

  async function resolveSovitsVoice(voice, endpoint, key) {
    const chosen = String(voice || config().voice || '').trim();
    if (chosen && chosen !== 'default') return chosen;
    const list = await listSovitsVoices(endpoint, key);
    return list.length ? list[0].id : 'default';
  }

  function refreshVoices() {
    try {
      if ('speechSynthesis' in window) browserVoices = window.speechSynthesis.getVoices() || [];
    } catch (err) {
      browserVoices = [];
    }
    if (!browserSaved && Array.isArray(browserVoices) && browserVoices.length) {
      browserSaved = true;
      window.dispatchEvent(new CustomEvent('xhgcs:tts-voices-changed', { detail: { voices: browserVoices.map((voice) => ({ id: voice.name, name: voice.name, lang: voice.lang, local: voice.localService })) } }));
    }
    return browserVoices.map((voice) => ({ id: voice.name, name: voice.name, lang: voice.lang, local: voice.localService }));
  }

  function listVoices() {
    refreshVoices();
    return browserVoices.map((voice) => ({ id: voice.name, name: voice.name, lang: voice.lang, local: voice.localService }));
  }

  // 把 "zh-CN-XiaoxiaoNeural" 这类 Azure/Edge 短名拆成可比较的词元，
  // 便于和系统语音的真实名称（Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)）做模糊匹配
  const VOICE_STOP_WORDS = ['microsoft', 'online', 'natural', 'neural', 'default', 'voice', 'desktop', 'mobile', 'multilingual', 'standard'];
  function voiceTokens(name) {
    return String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 2 && VOICE_STOP_WORDS.indexOf(token) < 0 && /[a-z]/.test(token));
  }

  // 返回 { voice, match, score }，match 取值：
  //   auto          —— 留空/“default”，交给系统默认中文语音
  //   exact         —— 与系统语音名称完全一致
  //   fuzzy         —— 关键词近似命中（如 XiaoxiaoNeural → Xiaoxiao 语音包）
  //   lang-fallback —— 名字在系统里根本不存在，只能退回任意中文语音
  //   none          —— 没有可用语音
  // 设置界面据此提示“你填的名字其实没匹配上”，避免静默回退到别的语音
  function findBrowserVoiceMatch(name) {
    const voices = refreshVoices();
    if (!voices.length) return { voice: null, match: 'none', score: 0 };
    if (!name || name === 'default') return { voice: null, match: 'auto', score: 0 };
    const lower = String(name).toLowerCase();
    const exact = voices.find((v) => v.name.toLowerCase() === lower || v.id.toLowerCase() === lower);
    if (exact) return { voice: exact, match: 'exact', score: 99 };
    // 只有真的像语言标签（zh / zh-cn，后面不能紧跟字母）才当作语言前缀过滤，
    // 否则 "Xiaoxiao"、"Yaoyao" 会被误当成语言码 "xi"/"ya" 而筛掉所有候选语音
    const langPrefix = (lower.match(/^([a-z]{2})(?:-([a-z]{2}))?(?![a-z0-9])/) || [''])[0];
    const sameLang = (v) => !langPrefix || String(v.lang).toLowerCase().indexOf(langPrefix) === 0;
    const tokens = voiceTokens(name);
    let best = null;
    let bestScore = 0;
    voices.forEach((v) => {
      if (!sameLang(v)) return;
      const haystack = (v.name + ' ' + v.id).toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.indexOf(token) >= 0 ? 1 : 0), 0);
      if (score > bestScore) { best = v; bestScore = score; }
    });
    if (best && bestScore > 0) return { voice: best, match: 'fuzzy', score: bestScore };
    const fallback = voices.find((v) => String(v.lang).toLowerCase().indexOf('zh') === 0) || null;
    if (fallback) return { voice: fallback, match: 'lang-fallback', score: 0 };
    return { voice: null, match: 'none', score: 0 };
  }

  function findBrowserVoice(name) {
    return findBrowserVoiceMatch(name).voice;
  }

  function stopBrowser() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (err) {}
  }

  function stopAudio() {
    if (audioSettle) {
      const settle = audioSettle;
      audioSettle = null;
      settle({ ok: true, canceled: true });
    }
    if (audioEl) {
      try { audioEl.pause(); audioEl.currentTime = 0; } catch (err) {}
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl = null;
    }
    if (audioUrl) {
      try { URL.revokeObjectURL(audioUrl); } catch (err) {}
      audioUrl = '';
    }
  }

  function stop() {
    requestId++;
    speaking = false;
    stopBrowser();
    stopAudio();
    dispatch();
  }

  function speakBrowser(text, options) {
    if (!('speechSynthesis' in window)) return Promise.reject(new Error('当前浏览器不支持 Edge 本地语音'));
    return new Promise((resolve, reject) => {
      const utter = new SpeechSynthesisUtterance(text);
      const id = requestId;
      const voice = findBrowserVoice(options.voice || config().voice);
      // 必须传真正的 SpeechSynthesisVoice；lang 也必须是合法 BCP-47，
      // 否则像 zh-CN-XiaoxiaoNeural 这样的短名会让朗读静默失败
      const realVoice = voice ? (window.speechSynthesis.getVoices() || []).find((v) => v.name === voice.name) || null : null;
      if (realVoice) utter.voice = realVoice;
      utter.lang = (realVoice && realVoice.lang) || (voice && voice.lang) || 'zh-CN';
      utter.rate = Number(options.rate) || 1;
      utter.pitch = Number(options.pitch) || 1;
      utter.onstart = () => { speaking = true; dispatch(); };
      utter.onend = () => {
        if (id === requestId) { speaking = false; dispatch(); }
        resolve({ ok: true, engine: 'browser' });
      };
      utter.onerror = (event) => {
        if (event && event.error === 'canceled') { resolve({ ok: true, canceled: true }); return; }
        if (id === requestId) { speaking = false; lastError = event && event.error ? String(event.error) : '语音播放失败'; dispatch(); }
        reject(new Error(lastError));
      };
      window.speechSynthesis.speak(utter);
    });
  }

  function playBlob(blob, options) {
    options = options || {};
    const id = options.id || requestId;
    if (audioEl) stopAudio();
    if (!blob || !blob.size) return Promise.resolve({ ok: false, reason: 'empty-audio' });
    audioUrl = URL.createObjectURL(blob);
    audioEl = new Audio(audioUrl);
    speaking = true;
    dispatch();
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (result, error) => {
        if (settled) return;
        settled = true;
        if (audioSettle === wrapped) audioSettle = null;
        if (id === requestId) {
          speaking = false;
          lastError = error ? (error.message || String(error)) : '';
          dispatch();
        }
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(result || { ok: true, engine: 'sovits' });
      };
      const wrapped = (result) => settle(result || { ok: true, canceled: true });
      audioSettle = wrapped;
      audioEl.onended = () => settle({ ok: true, engine: 'sovits' });
      audioEl.onerror = () => settle(null, new Error('音频播放失败'));
      audioEl.play().catch((err) => settle(null, err));
    });
  }

  async function speakSovits(text, options) {
    const cfg = config();
    const endpoint = String(options.endpoint || cfg.endpoint || 'http://127.0.0.1:8770').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    const key = options.apiKey || cfg.apiKey;
    if (key) headers.Authorization = 'Bearer ' + key;
    const voice = await resolveSovitsVoice(options.voice || cfg.voice, endpoint, key);
    const response = await fetch(endpoint + '/v1/audio/speech', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        input: text,
        text: text,
        voice: voice,
        speed: Number(options.speed || cfg.speed || 1)
      })
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).detail || ''; } catch (err) {}
      throw new Error('GPT-SoVITS HTTP ' + response.status + (detail ? ' · ' + detail : ''));
    }
    const blob = await response.blob();
    if (requestId !== options.id) return { ok: true, canceled: true };
    return playBlob(blob, Object.assign({}, options, { id: options.id }));
  }

  async function speak(text, options) {
    options = options || {};
    if (options.force !== true && config().enabled === false) return { ok: false, reason: 'disabled' };
    stop();
    const id = requestId;
    const content = cleanText(text);
    if (!content) return { ok: false, reason: 'empty' };
    const engine = options.engine || config().engine || 'browser';
    lastError = '';
    try {
      let result;
      if (engine === 'sovits') result = await speakSovits(content, Object.assign({}, options, { id: id }));
      else result = await speakBrowser(content, options);
      return result || { ok: true, engine: engine };
    } catch (err) {
      if (id === requestId) {
        lastError = err && err.message ? err.message : String(err);
        speaking = false;
        dispatch();
      }
      return { ok: false, error: lastError || String(err) };
    }
  }

  function getStatus(extra) {
    const cfg = config();
    return Object.assign({
      enabled: cfg.enabled !== false,
      engine: cfg.engine || 'browser',
      autoSpeak: cfg.autoSpeak !== false,
      voice: cfg.voice || 'default',
      speed: Number(cfg.speed || 1),
      available: 'speechSynthesis' in window,
      voices: browserVoices.length,
      sovitsVoices: sovitsVoices,
      speaking: speaking,
      lastError: lastError
    }, extra || {});
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  }

  window.XHGCS_TTS = {
    speak: speak,
    stop: stop,
    listVoices: listVoices,
    listSovitsVoices: listSovitsVoices,
    resolveSovitsVoice: resolveSovitsVoice,
    resolveBrowserVoice: findBrowserVoice,
    resolveBrowserVoiceMatch: findBrowserVoiceMatch,
    playBlob: playBlob,
    refreshVoices: refreshVoices,
    getStatus: getStatus
  };
})();
