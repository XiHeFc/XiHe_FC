(function () {
  'use strict';
  const X = window.XHGCS;
  const V = window.XHGCS_VIEWS;
  const APP = window.XHGCS_APP;
  const state = X.state;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TASK_LABELS = { script: '脚本', graph: '画布', engine: '引擎', analysis: '分析', speech: '语音', ai: 'AI' };
  const TASK_STATUS = { pending: '等待', running: '运行中', success: '完成', error: '失败', interrupted: '已中断' };

  function openSettings(section) {
    $('#setPort').value = state.serial.port;
    $('#setBaud').value = String(state.serial.baud);
    $('#setInterval').value = String(state.intervalMs);
    $('#setHistoryHours').value = String(state.historyHours);
    $('#setAnalysisWindow').value = String(state.analysis.windowPoints || 2000);
    $('#setWindowSec').value = String(state.windowSec);
    $('#setGrid').value = state.showGrid ? '1' : '0';
    $('#setStake').value = state.showStake ? '1' : '0';
    $('#setMcpEndpoint').value = state.mcp.endpoint || 'http://127.0.0.1:8787';
    $('#setMcpEnabled').value = state.mcp.enabled ? '1' : '0';
    $('#setAiBackend').value = state.ai.backend === 'dsh' ? 'dsh' : 'local';
    $('#setAiDshProfile').value = state.ai.dshProfile || 'headless';
    $('#setAiDshTimeout').value = String(Math.round((Number(state.ai.dshTimeoutMs) || 180000) / 1000));
    $('#setAiDshStatus').value = state.ai.backend === 'dsh' ? '点「检测 DSH」确认可用性' : '';
    $('#setAiEndpoint').value = state.ai.endpoint || '';
    $('#setAiModel').value = state.ai.model || '';
    $('#setAiKey').value = state.ai.apiKey || '';
    $('#setAiContextFrames').value = String(state.ai.contextFrames || 10);
    $('#setAiSystemPrompt').value = state.ai.systemPrompt || '';
    $('#setAiTemperature').value = String(state.ai.temperature != null ? state.ai.temperature : 0.2);
    $('#setAiMaxTokens').value = String(state.ai.maxTokens || 1024);
    $('#setAiStream').checked = state.ai.stream !== false;
    $('#setAiProxy').checked = state.ai.useProxy !== false;
    $('#setAiDisableThinking').checked = state.ai.disableThinking !== false;
    $('#setAiTools').checked = state.ai.tools !== false;
    $('#setAiDshAgent').checked = state.ai.dshMode !== 'answer';
    // 设置面板里的「停止生成」在标记里就是 disabled，而全仓库没有一处再启用它 —— 永远点不动。
    // 它接的是 stopAiGeneration（内部走 AI.abort），跟着流式状态开关即可。注意各生成按钮
    // 走的是没有注册 controller 的 chatOnce，拦不住，所以这里只对聊天流有效。
    $('#btnStopAi').disabled = !state.ai.streaming;
    $('#setTtsEnabled').checked = state.ai.tts.enabled !== false;
    $('#setTtsMode').value = state.ai.tts.mode || (state.ai.tts.autoSpeak === false ? 'alarm' : 'chat');
    $('#setTtsAlarmLevel').value = state.ai.tts.alarmLevel || 'warn';
    $('#setTtsAlarmCooldown').value = String(state.ai.tts.alarmCooldown || 5);
    $('#setTtsAlarmTemplate').value = state.ai.tts.alarmTemplate || '注意，{channel}{label}，当前值 {value}{unit}。';
    $('#setTtsEngine').value = state.ai.tts.engine || 'browser';
    $('#setTtsEndpoint').value = state.ai.tts.endpoint || 'http://127.0.0.1:8770';
    $('#setTtsKey').value = state.ai.tts.apiKey || '';
    voiceChoice[state.ai.tts.engine || 'browser'] = state.ai.tts.voice || 'default';
    $('#setTtsSpeed').value = String(state.ai.tts.speed || 1);
    $('#settingsModal').classList.remove('hidden');
    switchSettingsSection(section || 'base');
    renderThemeSwitch();
    renderAiTaskList();
    renderTtsStatus();
    renderAiModels();
    renderAiDiscovery();
    renderAiSettingsStatus();
    syncAiBackendFields();
    refreshTtsVoices();
  }

  function closeSettings() {
    $('#settingsModal').classList.add('hidden');
  }

  function saveSettings() {
    const port = $('#setPort').value.trim() || 'COM3';
    const baud = Number($('#setBaud').value);
    const interval = Number($('#setInterval').value);
    const historyHours = Number($('#setHistoryHours').value);
    const windowSec = Number($('#setWindowSec').value);
    state.serial.port = port;
    state.serial.baud = baud;
    state.windowSec = windowSec;
    state.analysis.windowPoints = Math.max(100, Math.min(200000, Number($('#setAnalysisWindow').value) || 2000));
    X.setIntervalMs(interval);
    X.setHistoryHours(historyHours);
    state.showGrid = $('#setGrid').value === '1';
    state.showStake = $('#setStake').value === '1';
    state.mcp.endpoint = $('#setMcpEndpoint').value.trim() || 'http://127.0.0.1:8787';
    state.mcp.enabled = $('#setMcpEnabled').value === '1';
    state.ai.backend = $('#setAiBackend').value === 'dsh' ? 'dsh' : 'local';
    state.ai.dshProfile = $('#setAiDshProfile').value.trim() || 'headless';
    state.ai.dshTimeoutMs = Math.max(10000, Math.min(300000, (Number($('#setAiDshTimeout').value) || 180) * 1000));
    state.ai.endpoint = $('#setAiEndpoint').value.trim();
    state.ai.model = $('#setAiModel').value.trim();
    state.ai.apiKey = $('#setAiKey').value.trim();
    state.ai.contextFrames = Math.max(0, Math.min(100, Number($('#setAiContextFrames').value) || 0));
    state.ai.systemPrompt = $('#setAiSystemPrompt').value.trim();
    state.ai.temperature = Math.max(0, Math.min(2, Number($('#setAiTemperature').value) || 0));
    state.ai.maxTokens = Math.max(16, Math.min(8192, Number($('#setAiMaxTokens').value) || 1024));
    state.ai.stream = $('#setAiStream').checked;
    state.ai.useProxy = $('#setAiProxy').checked;
    state.ai.disableThinking = $('#setAiDisableThinking').checked;
    state.ai.tools = $('#setAiTools').checked;
    state.ai.dshMode = $('#setAiDshAgent').checked ? 'agent' : 'answer';
    state.ai.tts.enabled = $('#setTtsEnabled').checked;
    state.ai.tts.mode = $('#setTtsMode').value;
    state.ai.tts.autoSpeak = state.ai.tts.mode === 'alarm' ? false : true;
    state.ai.tts.alarmLevel = $('#setTtsAlarmLevel').value;
    state.ai.tts.alarmCooldown = Math.max(1, Math.min(60, Number($('#setTtsAlarmCooldown').value) || 5));
    state.ai.tts.alarmTemplate = $('#setTtsAlarmTemplate').value.trim() || '注意，{channel}{label}，当前值 {value}{unit}。';
    state.ai.tts.engine = $('#setTtsEngine').value;
    state.ai.tts.endpoint = $('#setTtsEndpoint').value.trim() || 'http://127.0.0.1:8770';
    state.ai.tts.apiKey = $('#setTtsKey').value.trim();
    state.ai.tts.voice = $('#setTtsVoice').value.trim() || 'default';
    state.ai.tts.speed = Math.max(0.5, Math.min(2, Number($('#setTtsSpeed').value) || 1));
    $('#btnStake').textContent = '标桩：' + (state.showStake ? '显示' : '隐藏');
    $('#btnGrid').textContent = '网格：' + (state.showGrid ? '开' : '关');
    X.persist();
    if (window.XHGCS_TTS_WORKER) window.XHGCS_TTS_WORKER.sync();
    if (window.XHGCS_BRIDGE) { if (state.mcp.enabled) window.XHGCS_BRIDGE.start(); else window.XHGCS_BRIDGE.stop(); }
    if (window.XHGCS_AI_UI) window.XHGCS_AI_UI.updateStatus();
    // AI 面板顶栏的「上下文 / MCP 桥」和这里的 #setAiContextFrames / #setMcpEnabled 是同一份状态，
    // 保存后把面板那两颗控件刷回来 —— 不刷就会出现「状态 30、面板还写着 10」。
    if (window.XHGCS_AI_UI && window.XHGCS_AI_UI.syncControls) window.XHGCS_AI_UI.syncControls();
    if (window.XHGCS_ENGINE_UI) window.XHGCS_ENGINE_UI.renderList();
    APP.syncSerialSettings();
    V.updateHeadText();
    // 这里改的是全局采样率 / 内存历史 / 固定窗口，模拟器页的「采集参数」卡是同一份状态的镜像。
    // 不刷新的话，在模拟器页开设置改完采样间隔，页面还显示旧频率，要切页或刷新才纠正（实测 state 已是 50，下拉仍显示 100）。
    if (V.renderSimControls) V.renderSimControls();
    closeSettings();
    APP.toast('设置已保存');
  }

  function switchSettingsSection(key) {
    $$('.settings-nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.settingsNav === key));
    $$('.settings-section').forEach((section) => section.classList.toggle('active', section.dataset.settingsPanel === key));
    if (key === 'tasks') renderAiTaskList();
    if (key === 'tts') renderTtsStatus();
    if (key === 'theme') renderThemeSwitch();
  }

  function renderThemeSwitch() {
    const mode = (X.state.theme === 'light' || X.state.theme === 'auto') ? X.state.theme : 'dark';
    $$('.theme-opt').forEach((btn) => btn.classList.toggle('active', btn.dataset.themeMode === mode));
    const fx = X.normalizeFx ? X.normalizeFx(X.state.fx) : 'codex';
    $$('.fx-opt').forEach((btn) => btn.classList.toggle('active', btn.dataset.fxMode === fx));
    const current = $('#themeCurrent');
    if (!current) return;
    const effective = X.themeName ? X.themeName() : mode;
    const resolved = effective === 'light' ? '浅色' : '深色';
    // 深色 / 浅色模式下"当前生效"就是上面那个高亮的分段按钮本身，等于同一个值说两遍；
    // 只有"跟随系统"时它才带新信息（系统实际解析成深色还是浅色），所以那种情况才显示
    const row = $('#themeCurrentRow');
    if (row) row.classList.toggle('hidden', mode !== 'auto');
    current.value = resolved;
  }

  function taskTypeLabel(task) {
    return TASK_LABELS[task.type] || TASK_LABELS.ai;
  }

  function taskStatusLabel(task) {
    return TASK_STATUS[task.status] || task.status || '等待';
  }

  function taskTime(task) {
    if (!task.createdAt) return '';
    const clock = new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
    // 没结束的任务 finishedAt 还是 0，end 会退回 createdAt，于是每次都算出「0.0s」——
    // 那是假数据，左边状态徽标已经写着「运行中 / 等待」，再挂一个 0.0s 只是噪声
    if (!task.finishedAt) return clock;
    const seconds = Math.max(0, (task.finishedAt - task.createdAt) / 1000);
    return clock + ' · ' + seconds.toFixed(1) + 's';
  }

  function renderAiTaskList() {
    const box = $('#aiTaskList');
    if (!box) return;
    const tasks = state.ai.tasks || [];
    const running = tasks.filter((task) => task.status === 'running').length;
    const success = tasks.filter((task) => task.status === 'success').length;
    const error = tasks.filter((task) => task.status === 'error').length;
    const interrupted = tasks.filter((task) => task.status === 'interrupted').length;
    // 空列表时「共 0 条 · 运行 0 · 完成 0 · 失败 0」四个零等于什么都没说，下面还有空状态说明；
    // 同一行的「清空记录」这时也没有对象可清，一并禁用，避免点下去毫无反应
    const statParts = ['共 ' + tasks.length + ' 条'];
    if (running) statParts.push('运行 ' + running);
    if (success) statParts.push('完成 ' + success);
    if (interrupted) statParts.push('已中断 ' + interrupted);
    if (error) statParts.push('失败 ' + error);
    $('#settingsTaskStats').textContent = tasks.length
      ? statParts.join(' · ')
      : '暂无任务';
    const clearTasks = $('#btnClearAiTasks');
    if (clearTasks) clearTasks.disabled = !tasks.length;
    // 没有任务时这一行（统计 + 清空记录）和下面的空状态框说的是同一件事，整行收起来
    const taskToolbar = $('.ai-task-toolbar');
    if (taskToolbar) taskToolbar.classList.toggle('hidden', !tasks.length);
    box.innerHTML = '';
    if (!tasks.length) {
      box.innerHTML = '<div class="ai-task-empty">还没有 AI 子任务。让 AI 生成脚本、画布、数据引擎或运行分析后，会在这里显示调试记录。</div>';
      return;
    }
    tasks.forEach((task) => {
      const item = document.createElement('div');
      item.className = 'ai-task-item ' + (task.status || 'pending');

      const head = document.createElement('div');
      head.className = 'ai-task-head';
      const meta = document.createElement('span');
      meta.className = 'ai-task-type';
      meta.textContent = taskTypeLabel(task);
      const name = document.createElement('b');
      name.textContent = task.name || 'AI 子任务';
      const stateEl = document.createElement('span');
      stateEl.className = 'ai-task-state ' + (task.status || 'pending');
      stateEl.textContent = taskStatusLabel(task);
      const actions = document.createElement('div');
      actions.className = 'ai-task-actions';
      const play = document.createElement('button');
      play.className = 'mini-btn';
      play.textContent = '试听';
      play.disabled = !window.XHGCS_TTS;
      play.title = '使用当前 TTS 配置朗读';
      play.addEventListener('click', () => {
        if (window.XHGCS_TTS) window.XHGCS_TTS.speak(task.speech || task.message, { force: true });
      });
      const copy = document.createElement('button');
      copy.className = 'mini-btn';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(task.speech || task.message || '');
          APP.toast('内容已复制');
        } catch (err) {
          APP.toast('复制失败：' + (err && err.message || err));
        }
      });
      const del = document.createElement('button');
      del.className = 'mini-btn danger';
      del.textContent = '✕';
      del.addEventListener('click', () => X.removeAiTask(task.id));
      actions.appendChild(play);
      actions.appendChild(copy);
      actions.appendChild(del);
      head.appendChild(meta);
      head.appendChild(name);
      head.appendChild(stateEl);
      head.appendChild(actions);

      const message = document.createElement('div');
      message.className = 'ai-task-message';
      message.textContent = task.message || '（无消息）';
      const time = document.createElement('div');
      time.className = 'ai-task-time';
      time.textContent = taskTime(task) + (task.source === 'remote' ? ' · 远端 AI' : ' · 本地 AI');
      item.appendChild(head);
      item.appendChild(message);
      item.appendChild(time);
      box.appendChild(item);
    });
  }

  function engineLabel(engine) {
    if (engine === 'sovits') return 'GPT-SoVITS';
    return 'Edge 浏览器语音';
  }

  function renderTtsStatus() {
    const el = $('#ttsStatusText');
    if (!el) return;
    if (!window.XHGCS_TTS) {
      el.textContent = 'TTS 模块未加载';
      return;
    }
    const engine = $('#setTtsEngine') ? $('#setTtsEngine').value : (state.ai.tts.engine || 'browser');
    // Endpoint / API Key 只有 GPT-SoVITS 用得上：Edge 是本机浏览器合成，不走 HTTP。
    // 常驻显示会让人以为这里还得填地址，按引擎显隐；隐藏只改 CSS，取值逻辑不受影响
    $$('.sovits-only').forEach((el) => el.classList.toggle('hidden', engine !== 'sovits'));
    const status = window.XHGCS_TTS.getStatus({ engine: engine });
    const workerStatus = window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.status === 'function' ? window.XHGCS_TTS_WORKER.status() : null;
    const sovitsCount = Array.isArray(status.sovitsVoices) ? status.sovitsVoices.length : 0;
    const modeLabel = workerStatus && workerStatus.mode === 'alarm' ? '后台告警' : workerStatus && workerStatus.mode === 'both' ? '对话+告警' : '跟随 AI';
    const queueLabel = workerStatus && workerStatus.queue ? ' · 队列 ' + workerStatus.queue : '';
    el.textContent = status.speaking ? '正在播放 · ' + engineLabel(engine) + ' · ' + modeLabel + queueLabel : (status.lastError ? '异常：' + status.lastError : '空闲 · ' + engineLabel(engine) + ' · ' + modeLabel + queueLabel + (engine === 'sovits' ? ' · ' + sovitsCount + ' 个音色' : (status.voices ? ' · ' + status.voices + ' 个本地语音' : '')));
    const hint = $('#ttsVoiceHint');
    if (hint && engine === 'browser') {
      const typed = String(($('#setTtsVoice') ? $('#setTtsVoice').value : state.ai.tts.voice) || '').trim();
      const info = window.XHGCS_TTS.resolveBrowserVoiceMatch
        ? window.XHGCS_TTS.resolveBrowserVoiceMatch(typed)
        : { voice: null, match: 'none' };
      const chosen = info.voice;
      let verdict = '为默认，将自动选择本机中文语音';
      let offList = false;
      if (typed && typed !== 'default') {
        if (info.match === 'exact') verdict = '已精确匹配系统语音「' + chosen.name + '」（' + chosen.lang + '）';
        else if (info.match === 'fuzzy') verdict = '系统内没有同名语音，近似匹配到「' + chosen.name + '」（' + chosen.lang + '）';
        else if (info.match === 'lang-fallback') { verdict = '系统内不存在「' + typed + '」，已回退到本机中文语音「' + chosen.name + '」（' + chosen.lang + '）'; offList = true; }
        else { verdict = '系统内不存在「' + typed + '」，且本机没有可用语音'; offList = true; }
      }
      hint.dataset.match = info.match;
      const voiceLoaded = Number(status.voices) || 0;
      // 「留空会自动选本机中文语音」原本被说了三遍：输入框占位符、上面的 meta 行、再加这一行。
      // 默认语音时这句没有新信息，收起；只有「语音还没加载完」和「填了自定义名、需要给匹配结论」才占一行
      const line = voiceLoaded
        ? (typed && typed !== 'default'
          ? '当前 Voice ' + verdict + '。' + (offList ? '（zh-CN-XiaoxiaoNeural 这类 Azure 短名只在真正的 Edge 浏览器里生效，桌面版要先用「Microsoft Xiaoxiao Online (Natural)」这类系统语音名）' : '')
          : '')
        : '语音列表还没加载完，稍等或点「刷新」；留空会自动选择本机中文语音。';
      hint.textContent = line;
      hint.classList.toggle('hidden', !line);
    } else if (hint) {
      if (hint.dataset) delete hint.dataset.match;
      hint.classList.remove('hidden');
      hint.textContent = 'GPT-SoVITS：服务地址为 ' + ($('#setTtsEndpoint') && $('#setTtsEndpoint').value || state.ai.tts.endpoint || 'http://127.0.0.1:8770') + ' 的 /v1/audio/speech；已发现 ' + sovitsCount + ' 个音色。';
    }
    const modeHint = $('#ttsModeHint');
    const ttsMode = $('#setTtsMode') ? $('#setTtsMode').value : (state.ai.tts.mode || 'chat');
    // 敏感等级 / 重复播报间隔 / 告警播报模板只在会播报告警的模式下生效：
    // 「跟随 AI 对话」时这三项改了也不起作用，常驻显示就是假字段，
    // 还跟同一面板上的提示「通道告警不会自动播报」自相矛盾
    $$('.alarm-only').forEach((el) => el.classList.toggle('hidden', ttsMode === 'chat'));
    if (modeHint) {
      modeHint.textContent = ttsMode === 'alarm'
        ? '只朗读未确认告警，AI 回复不朗读。'
        : ttsMode === 'both'
          ? 'AI 回复与未确认告警都会朗读。'
          : '只朗读 AI 回复；通道告警不会自动播报。';
    }
  }

  // 告警播报总览：告警面板右上角的开关，
  // 避免出现“以为在播报、其实播报模式是跟随 AI 对话”这种静默失配
  function alarmSpeechFlags() {
    const cfg = (state.ai && state.ai.tts) || {};
    const mode = cfg.mode || (cfg.autoSpeak === false ? 'alarm' : 'chat');
    const enabled = cfg.enabled !== false;
    return { enabled: enabled, mode: mode, alarmOn: enabled && (mode === 'alarm' || mode === 'both') };
  }

  function renderAlarmTtsChip() {
    const chip = $('#alarmTtsChip');
    if (!chip) return;
    const flags = alarmSpeechFlags();
    chip.classList.toggle('on', flags.alarmOn);
    chip.classList.toggle('off', !flags.alarmOn);
    // 胶囊只留「名称：状态」，模式与后果都进 tooltip，跟「自动滚动：开」「网格：开」保持同一套写法
    if (flags.alarmOn) {
      chip.textContent = '告警语音：开';
      chip.title = '当前模式：' + (flags.mode === 'both' ? '对话 + 告警' : '仅告警') + '；点击关闭告警播报（保留 AI 对话朗读）';
    } else if (!flags.enabled) {
      chip.textContent = '告警语音：关';
      chip.title = '语音总开关已关闭，点此开启并让未确认告警按间隔播报';
    } else {
      chip.textContent = '告警语音：关';
      chip.title = '当前仅朗读 AI 回复；点此开启：未确认告警会按重复播报间隔提醒';
    }
  }

  function toggleAlarmTts() {
    if (!state.ai.tts) state.ai.tts = {};
    const flags = alarmSpeechFlags();
    if (flags.alarmOn) {
      state.ai.tts.mode = 'chat';
      state.ai.tts.autoSpeak = true;
    } else {
      state.ai.tts.enabled = true;
      state.ai.tts.mode = 'both';
      state.ai.tts.autoSpeak = true;
    }
    X.persist();
    if (window.XHGCS_TTS_WORKER) window.XHGCS_TTS_WORKER.sync();
    const modeSel = $('#setTtsMode');
    if (modeSel) modeSel.value = state.ai.tts.mode;
    const enabledBox = $('#setTtsEnabled');
    if (enabledBox) enabledBox.checked = true;
    renderAlarmTtsChip();
    renderTtsStatus();
    APP.toast(flags.alarmOn ? '已关闭告警语音播报' : '已开启告警语音播报：未确认告警会按间隔提醒');
  }

  // 两个引擎的 Voice 各自记住上一次的选择，避免来回切换时互相覆盖
  let sovitsVoiceCache = [];
  const voiceChoice = { browser: '', sovits: '' };
  let renderedVoiceEngine = '';
  function currentTtsEngine() {
    return $('#setTtsEngine') ? $('#setTtsEngine').value : (state.ai.tts.engine || 'browser');
  }
  function rememberVoiceChoice() {
    const input = $('#setTtsVoice');
    if (input && renderedVoiceEngine) voiceChoice[renderedVoiceEngine] = input.value.trim() || 'default';
  }

  // Voice 是自由输入框 + datalist 补全：既能从系统/接口检测到的语音里挑，
  // 也能手填任意语音名（Edge 的 zh-CN-XiaoxiaoNeural 之类短名也可，播报时按名称模糊匹配）
  function renderTtsVoiceOptions() {
    const input = $('#setTtsVoice');
    if (!input) return;
    const list = $('#ttsVoiceOptions');
    const engine = currentTtsEngine();
    const desired = voiceChoice[engine] || state.ai.tts.voice || 'default';
    const entries = [];
    let autoLabel = '默认（自动选择本机中文语音）';
    let metaText = '';
    if (engine === 'sovits') {
      sovitsVoiceCache.forEach((voice) => {
        const id = voice.id || '';
        const name = voice.name || id;
        entries.push({ value: id, label: name && id && name !== id ? name + ' · ' + id : (name || id) });
      });
      autoLabel = '默认（使用接口的第一个音色）';
      metaText = sovitsVoiceCache.length
        ? '已从接口发现 ' + sovitsVoiceCache.length + ' 个音色，下拉可选，也可直接填写音色 id。'
        : '还没读到音色；确认 GPT-SoVITS 已启动后点“刷新”，也可以直接填写音色 id。';
    } else {
      const voices = (window.XHGCS_TTS && window.XHGCS_TTS.listVoices) ? window.XHGCS_TTS.listVoices() : [];
      const zh = voices.filter((voice) => /^zh/i.test(voice.lang || ''));
      zh.concat(voices.filter((voice) => !/^zh/i.test(voice.lang || ''))).forEach((voice) => {
        entries.push({ value: voice.name, label: voice.name + ' · ' + voice.lang });
      });
      metaText = voices.length
        ? '可输入任意语音名，播报时按名称模糊匹配。'
        : '系统语音还没加载完，稍等或点“刷新”；也可以直接输入语音名。';
    }
    if (list) {
      list.innerHTML = '';
      const add = (value, label) => {
        if (!value) return;
        const option = document.createElement('option');
        option.value = value;
        if (label && label !== value) option.label = label;
        list.appendChild(option);
      };
      entries.forEach((item) => add(item.value, item.label));
    }
    input.placeholder = autoLabel;
    input.value = desired === 'default' ? '' : desired;
    renderedVoiceEngine = engine;
    const meta = $('#ttsVoiceMeta');
    if (meta) meta.textContent = metaText;
  }

  async function refreshTtsVoices() {
    if (currentTtsEngine() === 'sovits' && window.XHGCS_TTS && window.XHGCS_TTS.listSovitsVoices) {
      try {
        sovitsVoiceCache = await window.XHGCS_TTS.listSovitsVoices($('#setTtsEndpoint').value.trim(), $('#setTtsKey').value.trim());
      } catch (err) {
        sovitsVoiceCache = [];
      }
    }
    renderTtsVoiceOptions();
    renderTtsStatus();
  }

  function renderAiModels() {
    const list = $('#setAiModelList');
    if (!list) return;
    list.innerHTML = '';
    (state.ai.models || []).forEach((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.label = model;
      list.appendChild(option);
    });
  }

  function renderAiDiscovery() {
    const box = $('#aiDiscoveryList');
    if (!box) return;
    box.innerHTML = '';
    (state.ai.discovered || []).slice(0, 8).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'ai-discovery-item';
      const name = document.createElement('b');
      name.textContent = item.endpoint.replace(/^https?:\/\//, '');
      const models = document.createElement('span');
      models.textContent = (item.models || []).slice(0, 4).join(' · ') || '未返回模型';
      row.appendChild(name);
      row.appendChild(models);
      box.appendChild(row);
    });
  }

  function renderAiSettingsStatus(text, error) {
    const el = $('#setAiStatus');
    if (!el) return;
    const dsh = state.ai.backend === 'dsh';
    const model = state.ai.model || '';
    const configured = dsh ? true : Boolean(state.ai.endpoint);
    const idle = dsh ? '后端 DSH · ' + (state.ai.dshProfile || 'headless') : (state.ai.endpoint ? (model ? '已配置 · ' + model : '已配置 Endpoint') : (state.ai.lastError || '未连接'));
    const value = text || idle;
    el.textContent = value;
    el.className = 'ai-settings-status-text' + (error || state.ai.lastError ? ' error' : configured ? ' ok' : '');
  }

  async function refreshAiModels() {
    if (!window.XHGCS_AI || !window.XHGCS_AI.refreshModels) {
      renderAiSettingsStatus('AI 模块未加载', true);
      return;
    }
    // 刷新用的是输入框里的 Endpoint，先把它写进 state
    state.ai.endpoint = $('#setAiEndpoint').value.trim();
    state.ai.apiKey = $('#setAiKey').value;
    if (!state.ai.endpoint) {
      renderAiSettingsStatus('请先填写 Endpoint', true);
      return;
    }
    renderAiSettingsStatus('正在向 API 请求模型列表…');
    try {
      const models = await window.XHGCS_AI.refreshModels();
      if (!$('#setAiModel').value && models.length) $('#setAiModel').value = models[0];
      renderAiModels();
      renderAiDiscovery();
      renderAiSettingsStatus('已获取 ' + models.length + ' 个模型');
    } catch (err) {
      renderAiSettingsStatus('获取失败：' + ((err && err.message) || err), true);
    }
  }

  // 后端切换时把不相关的字段置灰：省得选了 DSH 还在填 Endpoint，或者反过来以为填了没生效
  function syncAiBackendFields() {
    const dsh = $('#setAiBackend').value === 'dsh';
    ['setAiEndpoint', 'setAiModel', 'setAiKey', 'btnDiscoverAi'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.disabled = dsh;
    });
    ['setAiDshProfile', 'setAiDshTimeout', 'btnDetectDsh'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.disabled = !dsh;
    });
  }

  async function detectDsh(refresh) {
    const button = $('#btnDetectDsh');
    const field = $('#setAiDshStatus');
    const previous = field ? field.value : '';
    if (button) button.disabled = true;
    if (field) field.value = '检测中…';
    try {
      const status = await window.XHGCS_AI.dshStatus(refresh !== false);
      const ok = Boolean(status && status.ok);
      const text = ok
        ? '可用 · v' + (status.version || '?') + (status.running ? ' · 运行中 ' + status.running : '')
        : '不可用 · ' + String((status && status.error) || '未找到 dsh');
      if (field) field.value = text;
      renderAiSettingsStatus('DSH ' + text, !ok);
    } catch (err) {
      if (field) field.value = previous || '检测失败';
      renderAiSettingsStatus('DSH 检测失败：' + (err && err.message || err), true);
    } finally {
      if (button && $('#setAiBackend').value === 'dsh') button.disabled = false;
    }
  }

  // 设置面板的报错原来直接铺原始 message（整段 Failed to fetch / HTTP 401 {...}），
  // 和聊天面板的 humanizeError 不一致。复用同一份映射；模块还没加载时退回原文。
  function friendlyAiError(raw) {
    const text = String(raw || '').trim() || '未知错误';
    const ui = window.XHGCS_AI_UI;
    const friendly = ui && typeof ui.humanizeError === 'function' ? ui.humanizeError(text) : '';
    return friendly || text;
  }

  async function testAiConnection() {
    if ($('#setAiBackend').value === 'dsh') return detectDsh(true);
    const endpoint = $('#setAiEndpoint').value.trim();
    const model = $('#setAiModel').value.trim();
    if (!endpoint || !model) {
      renderAiSettingsStatus('请先填写 Endpoint 和 Model', true);
      return;
    }
    renderAiSettingsStatus('正在连接 ' + model + ' …');
    try {
      const result = await window.XHGCS_AI.testConnection({
        endpoint: endpoint,
        model: model,
        apiKey: $('#setAiKey').value.trim(),
        useProxy: $('#setAiProxy').checked
      });
      state.ai.lastModel = model;
      state.ai.lastError = result.ok ? '' : (result.error || '连接失败');
      state.ai.lastOk = result.ok ? Date.now() : 0;
      X.persist();
      if (result.ok) renderAiSettingsStatus('连接成功 · ' + model + ' · ' + (result.ms || 0) + 'ms');
      else renderAiSettingsStatus('连接失败：' + friendlyAiError(result.error), true);
    } catch (err) {
      renderAiSettingsStatus('测试异常：' + friendlyAiError(err && err.message || err), true);
    }
  }

  function stopAiGeneration() {
    if (window.XHGCS_AI && window.XHGCS_AI.abort) window.XHGCS_AI.abort();
    renderAiSettingsStatus('已停止生成');
  }

  async function testTts() {
    const text = $('#setTtsTestText').value.trim() || '语音试听';
    if (!window.XHGCS_TTS) {
      APP.toast('TTS 模块未加载');
      return;
    }
    renderTtsStatus();
    const result = await window.XHGCS_TTS.speak(text, {
      force: true,
      engine: $('#setTtsEngine').value,
      endpoint: $('#setTtsEndpoint').value.trim(),
      apiKey: $('#setTtsKey').value.trim(),
      voice: $('#setTtsVoice').value.trim() || 'default',
      speed: Number($('#setTtsSpeed').value) || 1
    });
    renderTtsStatus();
    if (!result.ok && result.error) APP.toast('试听失败：' + result.error);
  }

  async function testTtsAlarm() {
    const alarm = X.state.alarms.find((item) => !item.ack) || X.state.alarms[0];
    if (!alarm) {
      APP.toast('暂无告警，无法播报');
      return;
    }
    const options = {
      engine: $('#setTtsEngine').value,
      endpoint: $('#setTtsEndpoint').value.trim(),
      apiKey: $('#setTtsKey').value.trim(),
      voice: $('#setTtsVoice').value.trim() || 'default',
      speed: Number($('#setTtsSpeed').value) || 1
    };
    let text = '';
    if (window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.formatAlarm === 'function') {
      text = window.XHGCS_TTS_WORKER.formatAlarm(alarm, {
        alarmTemplate: $('#setTtsAlarmTemplate').value,
        alarmLevel: $('#setTtsAlarmLevel').value,
        alarmCooldown: $('#setTtsAlarmCooldown').value
      });
    } else {
      text = String($('#setTtsAlarmTemplate').value || '注意，{channel}{label}，当前值 {value}{unit}。')
        .replace(/\{channel\}/g, alarm.name || '通道')
        .replace(/\{label\}/g, alarm.label || '异常')
        .replace(/\{value\}/g, Number.isFinite(Number(alarm.value)) ? Number(alarm.value).toFixed(2) : '--')
        .replace(/\{unit\}/g, alarm.unit || '');
    }
    if (window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.speakNow === 'function') {
      const result = await window.XHGCS_TTS_WORKER.speakNow(text, options);
      if (!result.ok && result.error) APP.toast('告警试听失败：' + result.error);
      return;
    }
    if (!window.XHGCS_TTS) {
      APP.toast('TTS 模块未加载');
      return;
    }
    const result = await window.XHGCS_TTS.speak(text, Object.assign({}, options, { force: true }));
    if (!result.ok && result.error) APP.toast('告警试听失败：' + result.error);
  }

  function resetSettings() {
    if (!confirm('恢复默认配置将覆盖当前通道与参数，是否继续？')) return;
    X.resetAll();
    if (window.XHGCS_TTS_WORKER) window.XHGCS_TTS_WORKER.sync();
    V.refreshAll();
    if (V.resetChartView) V.resetChartView();
    APP.syncSerialSettings();
    if (window.XHGCS_BRIDGE) { if (state.mcp.enabled) window.XHGCS_BRIDGE.start(); else window.XHGCS_BRIDGE.stop(); }
    closeSettings();
    APP.toast('已恢复默认配置');
  }

  function exportConfig() {
    const data = X.exportConfig();
    const name = 'XiHe_GCS_config_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    downloadBlob(JSON.stringify(data, null, 2), name, 'application/json');
    APP.toast('配置已导出');
  }

  function importConfig() {
    $('#configFileInput').click();
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        X.importConfig(reader.result);
        V.refreshAll();
        if (V.resetChartView) V.resetChartView();
        if (window.XHGCS_TTS_WORKER) window.XHGCS_TTS_WORKER.sync();
        APP.syncSerialSettings();
        if (window.XHGCS_BRIDGE) { if (state.mcp.enabled) window.XHGCS_BRIDGE.start(); else window.XHGCS_BRIDGE.stop(); }
        closeSettings();
        APP.toast('配置导入成功');
      } catch (err) {
        APP.toast('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportPng() {
    const map = {
      wave: $('#chart'),
      bar: $('#barChart'),
      map: $('#mapCanvas')
    };
    const canvas = map[state.subview];
    if (!canvas || canvas.classList.contains('hidden')) {
      APP.toast('当前视图没有可导出的画布');
      return;
    }
    // 波形画布是半透明的玻璃底，导出时先铺一层不透明背景，避免 PNG 透明发黑。
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d');
    g.fillStyle = '#0b1017';
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = 'XiHe_GCS_' + state.subview + '_' + Date.now() + '.png';
    a.click();
    APP.toast('PNG 已导出');
  }

  function exportCsv() {
    const channels = state.channels;
    const maxLen = Math.max.apply(null, channels.map((ch) => ch.data.length).concat([0]));
    if (!maxLen) { APP.toast('暂无数据可导出'); return; }
    const header = ['序号', '时间'].concat(channels.map((ch) => ch.name + '(' + ch.unit + ')'));
    const rows = [header.join(',')];
    for (let i = 0; i < maxLen; i++) {
      const time = new Date(Date.now() - (maxLen - 1 - i) * state.intervalMs).toLocaleTimeString('zh-CN', { hour12: false });
      const vals = channels.map((ch) => ch.data[i] == null ? '' : Number(ch.data[i]).toFixed(2));
      rows.push([i + 1, time].concat(vals).join(','));
    }
    const name = 'XiHe_GCS_data_' + Date.now() + '.csv';
    downloadBlob('\ufeff' + rows.join('\r\n'), name, 'text/csv;charset=utf-8');
    APP.toast('CSV 已导出');
  }

  function downloadBlob(content, name, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function applySimSettings() {
    X.setIntervalMs(Number($('#simInterval').value));
    X.setHistoryHours(Number($('#simHistoryHours').value));
    state.windowSec = Number($('#simWindowSec').value);
    X.persist();
    APP.toast('采集参数已应用');
  }

  function applySignal() {
    const ch = state.channels.find((c) => c.id === state.selectedChannel);
    if (!ch) return;
    ch.waveform = $('#simWaveSelect').value;
    ch.base = Number($('#simBase').value) || 0;
    ch.amp = Number($('#simAmp').value) || 0;
    ch.freq = Number($('#simFreq').value) || 0;
    ch.noise = Math.max(0, Number($('#simNoise').value) || 0);
    X.persist();
    // 通道信号一览是这张表单的只读镜像，改完要跟着刷新（也顺手把被夹紧过的输入回显成真实值）
    if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.renderSimControls) window.XHGCS_VIEWS.renderSimControls();
    APP.toast('已更新 ' + ch.name + ' 信号参数');
  }

  function findChannel(fragment) {
    return state.channels.find((ch) => ch.name.indexOf(fragment) > -1) || state.channels[0];
  }

  function injectFault(kind, channel, seconds) {
    const ch = channel || state.channels[0];
    ch.faultKind = kind;
    ch.faultUntil = Date.now() + seconds * 1000;
    APP.toast('故障注入：' + ch.name + ' · ' + seconds + 's');
  }

  function bindEvents() {
    $$('.settings-nav-btn').forEach((btn) => btn.addEventListener('click', () => switchSettingsSection(btn.dataset.settingsNav)));
    $('#btnCloseSettings').addEventListener('click', closeSettings);
    $('#btnCancelSettings').addEventListener('click', closeSettings);
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $$('.theme-opt').forEach((btn) => btn.addEventListener('click', () => {
      if (X.setTheme) X.setTheme(btn.dataset.themeMode);
      renderThemeSwitch();
    }));
    $$('.fx-opt').forEach((btn) => btn.addEventListener('click', () => {
      if (X.setFx) X.setFx(btn.dataset.fxMode);
      renderThemeSwitch();
    }));
    $('#btnTestTts').addEventListener('click', testTts);
    $('#btnTestTtsAlarm').addEventListener('click', testTtsAlarm);
    $('#btnStopTts').addEventListener('click', () => {
      if (window.XHGCS_TTS_WORKER) window.XHGCS_TTS_WORKER.stop();
      if (window.XHGCS_TTS) window.XHGCS_TTS.stop();
    });
    $('#setAiBackend').addEventListener('change', () => {
      syncAiBackendFields();
      if ($('#setAiBackend').value === 'dsh' && $('#setAiDshStatus').value.indexOf('可用') < 0) detectDsh(true);
    });
    $('#btnDetectDsh').addEventListener('click', () => detectDsh(true));
    $('#btnDiscoverAi').addEventListener('click', refreshAiModels);
    $('#btnTestAi').addEventListener('click', testAiConnection);
    $('#btnStopAi').addEventListener('click', stopAiGeneration);
    $('#btnClearAiTasks').addEventListener('click', () => X.clearAiTasks());
    $('#setTtsEngine').addEventListener('change', () => { rememberVoiceChoice(); refreshTtsVoices(); });
    $('#setTtsVoice').addEventListener('change', () => { rememberVoiceChoice(); renderTtsStatus(); });
    $('#btnRefreshTtsVoices').addEventListener('click', refreshTtsVoices);
    $('#setTtsMode').addEventListener('change', renderTtsStatus);
    $('#setTtsAlarmLevel').addEventListener('change', renderTtsStatus);
    $('#setTtsAlarmCooldown').addEventListener('change', renderTtsStatus);
    $('#setTtsAlarmTemplate').addEventListener('input', renderTtsStatus);
    $('#alarmTtsChip').addEventListener('click', toggleAlarmTts);
    $('#setTtsEndpoint').addEventListener('change', refreshTtsVoices);
    $('#setTtsKey').addEventListener('change', refreshTtsVoices);
    window.addEventListener('xhgcs:ai-tasks-changed', () => renderAiTaskList());
    window.addEventListener('xhgcs:tts-status-changed', () => { renderTtsStatus(); renderAlarmTtsChip(); });
    $('#btnResetConfig').addEventListener('click', resetSettings);
    $('#btnExportConfig').addEventListener('click', exportConfig);
    $('#btnImportConfig').addEventListener('click', importConfig);
    $('#configFileInput').addEventListener('change', handleImportFile);
    $('#btnExportPng').addEventListener('click', exportPng);
    $('#btnExportCsv').addEventListener('click', exportCsv);
    $('#btnAckAll').addEventListener('click', () => {
      X.ackAlarms();
      V.renderAlarmPanel();
      if (V.renderDockAlarmPage) V.renderDockAlarmPage(true);
      if (V.updateDockBadge) V.updateDockBadge();
      APP.updateAlarmBadge();
      APP.toast('已确认全部告警');
    });
    $('#btnClearAlarms').addEventListener('click', () => {
      X.clearAlarms();
      V.renderAlarmPanel();
      if (V.renderDockAlarmPage) V.renderDockAlarmPage(true);
      if (V.updateDockBadge) V.updateDockBadge();
      APP.updateAlarmBadge();
      APP.toast('告警记录已清空');
    });
    $('#btnApplySim').addEventListener('click', applySimSettings);
    $('#btnApplySignal').addEventListener('click', applySignal);
    $('#simChannelSelect').addEventListener('change', () => {
      state.selectedChannel = $('#simChannelSelect').value;
      V.renderSimControls();
    });
    $('#btnFaultHigh').addEventListener('click', () => injectFault('high', findChannel('电压'), 6));
    $('#btnFaultDrop').addEventListener('click', () => injectFault('drop', findChannel('电流'), 5));
    $('#btnFaultNoise').addEventListener('click', () => injectFault('jump', findChannel('电流'), 5));
    $('#btnEnableCruise').addEventListener('click', () => {
      state.channels.forEach((ch) => { ch.faultUntil = 0; ch.faultKind = ''; });
      state.cruise = true;
      state.homeMode = false;
      V.updateMapButtons();
      APP.toast('已恢复巡航并清除故障注入');
    });
    $('#btnResetData').addEventListener('click', () => {
      X.resetData();
      if (V.resetChartView) V.resetChartView();
      V.renderChannelCards();
      V.renderGaugeCards();
      APP.toast('模拟数据已重置');
    });
    $('#btnSimResetAll').addEventListener('click', () => {
      if (!confirm('恢复默认模拟参数？')) return;
      X.resetAll();
      V.refreshAll();
      if (V.resetChartView) V.resetChartView();
      APP.syncSerialSettings();
      APP.toast('模拟器已恢复默认');
    });
    renderAlarmTtsChip();
  }

  APP.openSettings = openSettings;
  APP.closeSettings = closeSettings;
  APP.saveSettings = saveSettings;
  APP.resetSettings = resetSettings;
  APP.exportConfig = exportConfig;
  APP.importConfig = importConfig;
  APP.exportPng = exportPng;
  APP.exportCsv = exportCsv;
  APP.injectFault = injectFault;
  APP.switchSettingsSection = switchSettingsSection;
  APP.renderAiTaskList = renderAiTaskList;
  APP.renderTtsStatus = renderTtsStatus;
  APP.renderAlarmTtsChip = renderAlarmTtsChip;

  bindEvents();
})();
