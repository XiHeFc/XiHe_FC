(function () {
  'use strict';
  const X = window.XHGCS;
  const A = window.XHGCS_ANALYSIS;
  const V = window.XHGCS_VIEWS;
  const state = X.state;
  const $ = (s) => document.querySelector(s);
  const LIVE_SCRIPT_ID = 'analysis-live';
  let previewTimer = 0;
  let previewHistory = [];
  let previewKey = '';
  let previewLastPush = 0;
  let previewError = '';
  let shelfExpanded = true;

  function liveScript() {
    return (state.scripts || []).find((script) => script.id === LIVE_SCRIPT_ID) || null;
  }

  function primaryOutput() {
    return (state.analysis.outputs && state.analysis.outputs[0]) || {
      id: 'out1', label: '结果', unit: '', color: X.canvasColors().acc, range: [0, 100]
    };
  }

  function outputNumber(value) {
    if (Array.isArray(value)) value = value.length ? value[value.length - 1] : 0;
    if (value && typeof value === 'object') {
      const out = primaryOutput();
      value = value[out.id] != null ? value[out.id] : (value.out1 != null ? value.out1 : Object.values(value)[0]);
    }
    return Number(value);
  }

  function previewKeyNow() {
    const outputs = state.analysis.outputs.map((out) => [out.id, out.label, out.unit, out.color, out.range[0], out.range[1]].join(':')).join('|');
    return [state.analysis.mode, state.analysis.formula, state.analysis.inputs.join(','), outputs].join('::');
  }

  function liveKeyNow(live) {
    if (!live) return '';
    return [
      live.type,
      live.formula,
      (live.inputs || []).join(','),
      (live.outputs || []).map((out) => [out.id, out.label, out.unit, out.color, out.range[0], out.range[1]].join(':')).join('|')
    ].join('::');
  }

  function formatPreviewNumber(value, range) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    const span = range && Number.isFinite(range[1] - range[0]) ? Math.abs(range[1] - range[0]) : 0;
    if (Math.abs(n) >= 1000) return n.toFixed(0);
    if (Math.abs(n) >= 100 || span >= 500) return n.toFixed(1);
    if (Math.abs(n) >= 1) return n.toFixed(2);
    return n.toFixed(3);
  }

  function setFormulaCodeState(text, kind) {
    const el = $('#formulaCodeState');
    if (!el) return;
    el.textContent = text;
    el.className = 'formula-code-state' + (kind ? ' ' + kind : '');
  }

  function setPreviewEmpty(text, kind) {
    previewHistory = [];
    previewKey = '';
    previewLastPush = 0;
    const box = $('#formulaPreview');
    const empty = $('#formulaSparkEmpty');
    if (box) box.className = 'formula-preview' + (kind === 'error' ? ' error' : '');
    if (empty) {
      empty.textContent = text;
      empty.classList.remove('hidden');
    }
    const value = $('#formulaPreviewValue');
    if (value) value.textContent = '--';
    const unit = $('#formulaPreviewUnit');
    if (unit) unit.textContent = '';
    const stats = $('#formulaPreviewStats');
    if (stats) stats.textContent = text;
    drawPreview();
  }

  function setPreviewValue(value, reset) {
    const out = primaryOutput();
    const n = outputNumber(value);
    if (!Number.isFinite(n)) throw new Error('公式没有返回数值');
    const key = previewKeyNow();
    if (reset || key !== previewKey) {
      previewHistory = [];
      previewKey = key;
      previewLastPush = 0;
    }
    previewError = '';
    const now = performance.now();
    if (reset || !previewHistory.length || now - previewLastPush >= 450) {
      previewHistory.push(n);
      if (previewHistory.length > 120) previewHistory.splice(0, previewHistory.length - 120);
      previewLastPush = now;
    }
    const min = Math.min.apply(null, previewHistory);
    const max = Math.max.apply(null, previewHistory);
    const avg = previewHistory.reduce((sum, item) => sum + item, 0) / Math.max(1, previewHistory.length);
    const box = $('#formulaPreview');
    if (box) box.className = 'formula-preview' + (liveScript() ? ' live' : '');
    const title = $('#formulaPreviewTitle');
    if (title) title.textContent = '实时结果 · ' + (out.label || '结果');
    const valueEl = $('#formulaPreviewValue');
    if (valueEl) valueEl.textContent = formatPreviewNumber(n, out.range);
    const unitEl = $('#formulaPreviewUnit');
    if (unitEl) unitEl.textContent = out.unit || '';
    const stats = $('#formulaPreviewStats');
    if (stats) stats.textContent = '当前 ' + formatPreviewNumber(n, out.range)
      + ' · 均 ' + formatPreviewNumber(avg, out.range)
      + ' · 范围 ' + formatPreviewNumber(min, out.range) + '~' + formatPreviewNumber(max, out.range)
      + ' · ' + previewHistory.length + ' 点';
    const empty = $('#formulaSparkEmpty');
    if (empty) empty.classList.add('hidden');
    setFormulaCodeState('语法通过', 'ok');
    drawPreview(out.color);
    syncLiveUI();
    return n;
  }

  function drawPreview(color) {
    const canvas = $('#analysisPreviewCanvas');
    if (!canvas || !V.ensureCanvas) return;
    const info = V.ensureCanvas(canvas);
    if (!info) return;
    const g = info.ctx, w = info.w, h = info.h;
    const TH = X.canvasColors();
    g.clearRect(0, 0, w, h);
    g.fillStyle = TH.bg;
    g.fillRect(0, 0, w, h);
    if (previewHistory.length < 1) return;
    const pad = 8;
    let min = Math.min.apply(null, previewHistory);
    let max = Math.max.apply(null, previewHistory);
    if (min === max) {
      const span = Math.max(1, Math.abs(min) * .1);
      min -= span;
      max += span;
    }
    const step = (w - pad * 2) / Math.max(1, previewHistory.length - 1);
    const yOf = (value) => pad + (h - pad * 2) * (1 - (value - min) / (max - min));
    g.strokeStyle = TH.grid;
    g.lineWidth = 1;
    for (let i = 0; i < 3; i += 1) {
      const y = pad + (h - pad * 2) * i / 2;
      g.beginPath();
      g.moveTo(pad, y);
      g.lineTo(w - pad, y);
      g.stroke();
    }
    const stroke = color || primaryOutput().color || TH.acc;
    g.beginPath();
    previewHistory.forEach((value, index) => {
      const x = pad + index * step;
      const y = yOf(value);
      if (index) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    if (previewHistory.length === 1) {
      g.lineTo(w - pad, yOf(previewHistory[0]));
    }
    g.strokeStyle = stroke;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
    const lastX = previewHistory.length === 1 ? w - pad : pad + (previewHistory.length - 1) * step;
    const lastY = yOf(previewHistory[previewHistory.length - 1]);
    g.fillStyle = stroke;
    g.beginPath();
    g.arc(lastX, lastY, 2.7, 0, Math.PI * 2);
    g.fill();
  }

  function computePreview(reset) {
    if (!isOpen() || $('#analysisQuickView').classList.contains('hidden')) return;
    if (state.analysis.mode !== 'functions') {
      setFormulaCodeState('运行后检查', '');
      setPreviewEmpty('Python 结果需要点击「试算」或「运行并查看图表」', '');
      return;
    }
    const formula = $('#analysisFormula').value.trim();
    if (!formula) {
      previewError = '先写一个公式';
      setFormulaCodeState('空公式', 'error');
      setPreviewEmpty(previewError, 'error');
      return;
    }
    const started = performance.now();
    try {
      const live = liveScript();
      const out = primaryOutput();
      const liveChannel = live && previewKeyNow() === liveKeyNow(live)
        ? (state.scriptChannels || []).find((ch) => ch.scriptId === LIVE_SCRIPT_ID && ch.outputId === out.id)
        : null;
      const value = liveChannel && liveChannel.data && liveChannel.data.length
        ? liveChannel.data[liveChannel.data.length - 1]
        : A.computeFormula(formula, state.analysis.inputs);
      const n = setPreviewValue(value, Boolean(reset));
      const ms = Math.max(0, performance.now() - started);
      const status = $('#analysisStatus');
      if (status) {
        status.textContent = '试算通过 · ' + state.analysis.inputs.length + ' 个输入 · ' + ms.toFixed(1) + ' ms';
        status.className = 'analysis-status';
      }
      return n;
    } catch (err) {
      previewError = String(err && err.message || err);
      if (/Unexpected|unexpected|SyntaxError|token/i.test(previewError)) {
        previewError = '公式语法不完整：检查括号、逗号和运算符';
      }
      setFormulaCodeState('语法错误', 'error');
      setPreviewEmpty(previewError, 'error');
      const status = $('#analysisStatus');
      if (status) {
        status.textContent = previewError;
        status.className = 'analysis-status error';
      }
      syncLiveUI();
      return null;
    }
  }

  function schedulePreview(reset) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      readConfig();
      computePreview(Boolean(reset));
    }, 120);
  }

  function syncLiveUI() {
    const live = liveScript();
    const box = $('#formulaPreview');
    const badge = $('#formulaLiveBadge');
    const toggle = $('#btnFormulaLive');
    const attach = $('#btnAnalysisAttach');
    const destination = $('#formulaDestination');
    const destinationNote = $('#formulaDestinationNote');
    const openChart = $('#btnFormulaOpenChart');
    const key = previewKeyNow();
    const liveKey = liveKeyNow(live);
    const stale = Boolean(live && key !== liveKey);
    if (box) {
      box.classList.toggle('live', Boolean(live && !stale && !previewError));
      box.classList.toggle('stale', stale);
      box.classList.toggle('error', Boolean(previewError));
    }
    if (badge) badge.textContent = live ? (stale ? '预览 · 未发布' : '实时 · 已发布') : '预览';
    if (toggle) {
      toggle.classList.toggle('hidden', !live);
      toggle.textContent = '停止实时';
      toggle.title = '停止并移除快速公式产生的脚本通道';
    }
    if (attach) attach.textContent = stale ? '发布修改到图表' : '运行并查看图表';
    if (destination) {
      destination.classList.toggle('live', Boolean(live && !stale));
      destination.classList.toggle('stale', stale);
    }
    if (destinationNote) {
      destinationNote.textContent = live
        ? (stale ? '有修改未发布' : '实时运行中 · 500ms 更新')
        : '尚未发布';
    }
    if (openChart) openChart.classList.toggle('hidden', !live || stale);
    const pipeline = $('#formulaPipeline');
    if (pipeline) {
      const out = primaryOutput();
      const inputNames = state.analysis.inputs.map((id) => {
        const ch = X.findChannel(id);
        return ch ? ch.name : id;
      });
      const formula = state.analysis.formula.trim();
      pipeline.innerHTML = '<span class="fp-node input" title="' + X.esc(inputNames.join('、')) + '">'
        + X.esc(inputNames.join(' + ') || '未选输入') + '</span><i>→</i>'
        + '<span class="fp-node formula" title="' + X.esc(formula) + '">' + X.esc(formula || '未填写公式')
        + '</span><i>→</i><span class="fp-node output" title="' + X.esc(out.label || '输出') + '">'
        + X.esc(out.label || '输出') + '</span>';
    }
  }

  function setShelfExpanded(open) {
    shelfExpanded = Boolean(open);
    const shelf = document.querySelector('.analysis-script-shelf');
    const btn = $('#btnToggleAnalysisShelf');
    if (shelf) shelf.classList.toggle('collapsed', !shelfExpanded);
    if (btn) {
      btn.setAttribute('aria-expanded', shelfExpanded ? 'true' : 'false');
      btn.innerHTML = (shelfExpanded ? '收起' : '展开') + ' <span>⌃</span>';
    }
  }

  function upsertLiveScript() {
    const script = currentScript(LIVE_SCRIPT_ID);
    const out = primaryOutput();
    script.name = '快速公式 · ' + (out.label || '结果');
    script.description = '快速公式实时结果';
    script.live = true;
    const index = state.scripts.findIndex((item) => item.id === LIVE_SCRIPT_ID);
    if (index >= 0) state.scripts.splice(index, 1, script);
    else state.scripts.push(script);
    state.mcp.deletedScripts = (state.mcp.deletedScripts || []).filter((id) => id !== LIVE_SCRIPT_ID);
    A.ensureOutputs(script);
    X.persist();
    renderScripts();
    return script;
  }

  function openLiveChart() {
    const live = liveScript();
    if (!live) return false;
    const plot = X.activePlot();
    const ids = (live.outputs || []).map((out) => out.id);
    if (plot && ids.length && X.setPlotChannels) X.setPlotChannels(plot.id, ids);
    V.switchChannelTab('script');
    V.switchSubView('wave');
    if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('visual');
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
    V.renderChart();
    return true;
  }

  function stopLiveFormula() {
    const live = liveScript();
    if (!live) return;
    state.scripts = state.scripts.filter((script) => script.id !== LIVE_SCRIPT_ID);
    state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== LIVE_SCRIPT_ID);
    const plot = X.activePlot();
    if (plot && Array.isArray(plot.channels)) {
      const liveIds = new Set((live.outputs || []).map((out) => out.id));
      const next = plot.channels.filter((id) => !liveIds.has(id));
      if (next.length) X.setPlotChannels(plot.id, next);
      else X.setPlotChannels(plot.id, null, { follow: true });
    }
    previewHistory = [];
    X.persist();
    V.renderChannelCards();
    V.renderThresholdRows();
    V.renderGaugeCards();
    syncLiveUI();
    updateStatus();
    toast('已停止快速公式，实时脚本通道已移除');
  }

  function setMode(mode) {
    state.analysis.mode = mode;
    document.querySelectorAll('[data-analysis-mode]').forEach((el) => el.classList.toggle('active', el.dataset.analysisMode === mode));
    $('#analysisFunctions').classList.toggle('hidden', mode !== 'functions');
    $('#analysisPython').classList.toggle('hidden', mode !== 'python');
    // 脚本库开合不再由 state.analysis.mode 决定：交给 graph-ui.setModeUI 按屏幕可见模式同步（单一来源）
    syncLiveUI();
    schedulePreview(true);
  }

  function readConfig() {
    state.analysis.mode = document.querySelector('[data-analysis-mode].active') ? document.querySelector('[data-analysis-mode].active').dataset.analysisMode : 'functions';
    state.analysis.formula = $('#analysisFormula').value;
    state.analysis.python = $('#analysisPythonCode').value;
    state.analysis.inputs = Array.from(document.querySelectorAll('#analysisInputs input:checked')).map((el) => el.dataset.channelId);
    if (!state.analysis.inputs.length) state.analysis.inputs = firstChannelId() ? [firstChannelId()] : [];
    return state.analysis;
  }

  // 勾选通道后把「自动形态」的均值表达式跟着改；手写过的公式一律不动，
  // 免得用户敲了半天的表达式被一次点击冲掉。
  function syncFormulaToInputs() {
    const el = $("#analysisFormula");
    if (!el) return;
    if (!/^\s*mean\([\w$,\s]*\)\s*$/.test(el.value)) return;
    el.value = "mean(" + state.analysis.inputs.map((id) => X.formulaAlias(id)).join(",") + ")";
  }

  function firstChannelId() { const ch = X.allChannels()[0]; return ch ? ch.id : ''; }

  function renderInputs() {
    const box = $('#analysisInputs');
    // 换数据引擎之后旧勾选可能已经不存在（默认的 ch1 遇上 WED 规格就是这种情况）；
    // 不清掉的话页面会停在「一个都没勾、公式却写着 mean(ch1)」，一点运行就报错。
    const alive = X.allChannels().map((ch) => ch.id);
    state.analysis.inputs = state.analysis.inputs.filter((id) => alive.indexOf(id) >= 0);
    if (!state.analysis.inputs.length && alive.length) state.analysis.inputs = [alive[0]];
    box.innerHTML = '';
    X.allChannels().forEach((ch) => {
      const label = document.createElement('label');
      label.className = 'analysis-check';
      // 通道名后面挂上「公式名」：WED 规格的 id 是 wed-fc-01，写进公式会被当成减法，
      // 公式里必须写 c01，那就把这个可写的名字直接摆在名字旁边。
      const alias = X.formulaAlias(ch.id);
      // 公式名只在和 id 不一样时才挂出来（WED 规格是 wed-fc-01 -> c01，ch1 这种本来就写得上）
      const aliasChip = alias === ch.id ? '' : '<code class="analysis-alias" title="公式里写这个名字">' + X.esc(alias) + '</code>';
      label.innerHTML = '<input type="checkbox" data-channel-id="' + ch.id + '" ' + (state.analysis.inputs.includes(ch.id) ? 'checked' : '') + ' /><span style="color:' + ch.color + '">●</span><span class="analysis-name">' + X.esc(ch.name) + ' (' + X.esc(ch.unit) + ')</span>' + aliasChip + '<b>' + (ch.data.length ? Number(ch.data[ch.data.length - 1]).toFixed(1) : '--') + '</b>';
      label.querySelector('input').addEventListener('change', () => {
        const values = Array.from(document.querySelectorAll('#analysisInputs input:checked')).map((el) => el.dataset.channelId);
        state.analysis.inputs = values.length ? values : (firstChannelId() ? [firstChannelId()] : []);
        syncFormulaToInputs();
        syncLiveUI();
        schedulePreview(true);
      });
      box.appendChild(label);
    });
    const count = $('#analysisInputCount');
    if (count) count.textContent = String(state.analysis.inputs.length);
  }

  function renderOutputs() {
    const box = $('#analysisOutputs');
    box.innerHTML = '';
    state.analysis.outputs.forEach((out, index) => {
      const item = document.createElement('div');
      item.className = 'analysis-output-item';
      // 每个字段带小标签：原来只有 placeholder，值一填满就看不出这一格是什么
      item.innerHTML = '<label class="ao-wide"><span>输出标签</span><input data-output-label value="' + X.esc(out.label) + '" /></label>' +
        '<label><span>单位</span><input data-output-unit value="' + X.esc(out.unit) + '" placeholder="可留空" /></label>' +
        '<label><span>颜色</span><input type="color" data-output-color value="' + out.color + '" /></label>' +
        '<label><span>最小</span><input type="number" data-output-min value="' + out.range[0] + '" /></label>' +
        '<label><span>最大</span><input type="number" data-output-max value="' + out.range[1] + '" /></label>' +
        '<button class="mini-btn" data-output-del="' + index + '" title="删除这个输出">✕</button>';
      const sync = () => {
        syncLiveUI();
        schedulePreview(true);
      };
      const bindField = (selector, apply) => {
        const input = item.querySelector(selector);
        input.addEventListener('input', () => {
          apply(input.value);
          sync();
        });
      };
      bindField('[data-output-label]', (value) => { out.label = String(value || '').trim() || out.label; });
      bindField('[data-output-unit]', (value) => { out.unit = value; });
      bindField('[data-output-color]', (value) => { out.color = value; });
      bindField('[data-output-min]', (value) => { out.range[0] = Number(value) || 0; });
      bindField('[data-output-max]', (value) => { out.range[1] = Number(value) || 100; });
      item.querySelector('[data-output-del]').addEventListener('click', () => {
        state.analysis.outputs.splice(index, 1);
        renderOutputs();
        syncLiveUI();
        schedulePreview(true);
      });
      box.appendChild(item);
    });
  }

  function currentScript(id) {
    readConfig();
    return {
      id: id || 'analysis-live',
      name: '分析画布',
      type: state.analysis.mode,
      formula: state.analysis.formula,
      code: state.analysis.python,
      inputs: state.analysis.inputs.slice(),
      outputs: state.analysis.outputs.map((out) => Object.assign({}, out)),
      builtin: false,
      description: '来自分析画布'
    };
  }

  // 脚本库的卡片：节点流程是「一张画布」，算式是「一条公式」—— 两者点下去的落点完全不同，
  // 所以卡片自己要把这件事说清，而不是把 functions / graph 这种类型名摊给用户看
  const SCRIPT_KIND_LABEL = { graph: '节点流程', functions: '算式', python: 'Python 算式' };

  function loadScriptInto(script) {
    if (script.type === 'graph' && window.XHGCS_GRAPH_UI) {
      // 切画布的提示与撤销说明由 loadScript 一处给出（同一件事只说一遍）
      window.XHGCS_GRAPH_UI.loadScript(script);
      renderScripts(); // 「当前画布」标记跟着换
      return;
    }
    state.analysis.mode = script.type || 'functions';
    state.analysis.formula = script.formula || state.analysis.formula;
    state.analysis.python = script.code || state.analysis.python;
    state.analysis.inputs = (script.inputs && script.inputs.length ? script.inputs : state.analysis.inputs).slice();
    state.analysis.outputs = (script.outputs || state.analysis.outputs || []).map((out) => Object.assign({}, out));
    $('#analysisFormula').value = state.analysis.formula;
    $('#analysisPythonCode').value = state.analysis.python;
    setMode(state.analysis.mode);
    renderInputs();
    renderOutputs();
    renderScripts();
    toast('已载入到快速公式：' + script.name);
  }

  function renderScripts() {
    const box = $('#analysisScripts');
    box.innerHTML = '';
    state.scripts.filter((script) => script.id !== LIVE_SCRIPT_ID).forEach((script) => {
      const isGraph = script.type === 'graph' && Boolean(script.graph);
      const isCurrent = isGraph && state.analysis.canvasScriptId === script.id;
      const item = document.createElement('div');
      item.className = 'script-item' + (isGraph ? ' is-graph' : '') + (isCurrent ? ' is-current' : '');
      // 说明句不进卡片：description 与点击提示只放 title，卡片只留名词 + 类型 + 入/出
      const pickHint = isGraph ? '把画布切到这张画布' : '载入快速公式';
      item.title = (script.description ? script.description + '；' : '') + '点击' + pickHint;
      const io = [];
      if (script.inputs && script.inputs.length) io.push('入 ' + script.inputs.length);
      if (script.outputs && script.outputs.length) io.push('出 ' + script.outputs.length);
      const kindText = X.esc(SCRIPT_KIND_LABEL[script.type] || script.type) + (io.length ? ' · ' + io.join(' · ') : '');
      item.innerHTML = '<b>' + X.esc(script.name) + (isCurrent ? '<i class="cur">当前画布</i>' : '') + '</b>'
        + '<span>' + kindText + '</span>'
        + '<div class="actions">'
        + '<button class="mini-btn" data-script-run="' + script.id + '">运行</button>'
        + '<button class="mini-btn" data-script-del="' + script.id + '">删除</button>'
        + '</div>';
      item.addEventListener('click', (e) => {
        // 动作按钮各有各的事，别让整卡的点击抢了
        if (e.target.closest && e.target.closest('.actions')) return;
        loadScriptInto(script);
      });
      item.querySelector('[data-script-run]').addEventListener('click', async () => {
        if (script.type === 'graph' && window.XHGCS_GRAPH_UI) {
          await window.XHGCS_GRAPH_UI.runSavedGraph(script);
          return;
        }
        readConfig();
        await A.runAndAttach(script, script.inputs || state.analysis.inputs);
        updateStatus();
        V.renderGaugeCards();
        V.renderThresholdRows();
        V.switchChannelTab('script');
        toast('脚本已运行并写入 ' + (script.outputs || []).length + ' 个通道');
      });
      item.querySelector('[data-script-del]').addEventListener('click', () => {
        A.deleteScript(script.id);
        renderScripts();
        V.renderGaugeCards();
        V.renderThresholdRows();
        V.switchChannelTab('script');
        toast('脚本已删除');
      });
      box.appendChild(item);
    });
  }

  function updateStatus() {
    const el = $('#analysisStatus');
    if (state.analysis.lastError) { el.textContent = '错误：' + state.analysis.lastError; el.className = 'analysis-status error'; }
    else if (liveScript()) { el.textContent = '实时公式运行中 · 每 500ms 更新图表'; el.className = 'analysis-status live'; }
    else if (state.analysis.lastRun) { el.textContent = '最近运行：' + new Date(state.analysis.lastRun).toLocaleTimeString(); el.className = 'analysis-status'; }
    else { el.textContent = '等待运行'; el.className = 'analysis-status'; }
  }

  async function runCurrent() {
    if (!$('#analysisGraphView').classList.contains('hidden') && window.XHGCS_GRAPH_UI) return window.XHGCS_GRAPH_UI.runGraph();
    readConfig();
    const script = currentScript('analysis-live');
    state.analysis.lastRun = Date.now();
    state.analysis.lastError = '';
    try {
      let value;
      if (state.analysis.mode === 'functions') {
        value = A.computeFormula(script.formula, script.inputs);
      } else {
        const values = await A.runPythonScript(script, script.inputs);
        const out = primaryOutput();
        value = values[out.id] != null ? values[out.id] : values[out.label] != null ? values[out.label] : Object.values(values || {})[0];
      }
      setPreviewValue(value, true);
      updateStatus();
    } catch (err) {
      state.analysis.lastError = String(err && err.message || err);
      setFormulaCodeState('运行失败', 'error');
      setPreviewEmpty(state.analysis.lastError, 'error');
      updateStatus();
      syncLiveUI();
    }
  }

  async function attachCurrent() {
    if (!$('#analysisGraphView').classList.contains('hidden') && window.XHGCS_GRAPH_UI) return window.XHGCS_GRAPH_UI.attachGraph();
    readConfig();
    const hadLive = Boolean(liveScript());
    let script = currentScript(LIVE_SCRIPT_ID);
    const values = await A.runAndAttach(script, script.inputs);
    if (!values) {
      if (!hadLive) state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== LIVE_SCRIPT_ID);
      X.persist();
      updateStatus();
      setPreviewEmpty(state.analysis.lastError || '实时公式发布失败', 'error');
      syncLiveUI();
      toast('快速公式没有运行成功，先修公式再发布');
      return;
    }
    script = upsertLiveScript();
    updateStatus();
    const out = primaryOutput();
    setPreviewValue(values[out.id] != null ? values[out.id] : Object.values(values)[0], true);
    V.renderGaugeCards();
    V.renderThresholdRows();
    openLiveChart();
    syncLiveUI();
    toast('已发布到图表 · 快速公式每 500ms 更新一次');
  }

  function saveCurrent() {
    if (!$('#analysisGraphView').classList.contains('hidden') && window.XHGCS_GRAPH_UI) return window.XHGCS_GRAPH_UI.saveGraph();
    const script = currentScript(X.uid('script'));
    script.name = '自定义·' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    A.saveScript(script);
    renderScripts();
    toast('脚本已保存到自定义模块');
  }

  // AI 生成脚本改成先弹对话框：以前它读的是画布上已经摆好的输入/输出，
  // 等于必须先拖一版流程才能生成，而且没有地方写「我到底要算什么」。
  function renderScriptDialogChannels(preselect) {
    const box = $("#sdChannels");
    const picked = Array.isArray(preselect) && preselect.length ? preselect : state.analysis.inputs;
    box.innerHTML = "";
    X.allChannels().forEach((ch) => {
      const label = document.createElement("label");
      label.className = "sd-channel";
      label.innerHTML = '<input type="checkbox" data-channel-id="' + ch.id + '" ' + (picked.includes(ch.id) ? "checked" : "") + ' /><span style="color:' + ch.color + '">●</span><span class="sd-name">' + X.esc(ch.name) + '</span><code>' + X.esc(X.formulaAlias(ch.id)) + "</code>";
      box.appendChild(label);
    });
    $("#sdChannelHint").textContent = X.allChannels().length + " 个通道 · 只勾一个就是取它自己的历史";
  }

  // 同一个对话框两种产物：算法脚本（函数 / Python）和节点流程。
  // 以前整页只有「AI 生成脚本」一个入口，一眼看不出它产出的是算式还是流程。
  let scriptDialogMode = "script";

  function openScriptDialog(prefill) {
    const p = prefill || {};
    const flow = p.mode === "flow";
    scriptDialogMode = flow ? "flow" : "script";
    $("#sdTitle").textContent = flow ? "AI 生成算法流程" : "AI 生成数据脚本";
    $("#sdDesc").textContent = flow
      ? "写一句算法要做什么，AI 在画布上搭出「输入 → 计算 → 输出」的节点流程，生成后可以继续手改。"
      : "写一句要算什么，勾上吃哪些通道；不用先拖一版画布流程。";
    $("#sdRow").classList.toggle("hidden", flow);
    $("#btnScriptDialogCreate").textContent = flow ? "生成流程" : "生成脚本";
    $("#sdPrompt").placeholder = flow
      ? "例如：把电压和电流求平均值，输出成均值通道"
      : "例如：把横滚角最近 100 点求均值，输出成脚本通道";
    $("#sdPrompt").value = p.prompt || "";
    $("#sdLabel").value = p.label || "";
    $("#sdType").value = p.type || "";
    $("#sdStatus").textContent = p.hint || (flow ? "勾上流程要读的输入通道；不勾就按描述里的通道名推导。" : "");
    renderScriptDialogChannels(p.inputs);
    $("#scriptDialog").classList.remove("hidden");
    $("#sdPrompt").focus();
  }

  function closeScriptDialog() { $("#scriptDialog").classList.add("hidden"); }

  async function createScriptFromDialog() {
    const status = $("#sdStatus");
    const prompt = $("#sdPrompt").value.trim();
    const inputs = Array.from($("#sdChannels").querySelectorAll("input:checked")).map((el) => el.dataset.channelId);
    if (!prompt) { status.textContent = "先写一句你要算什么。"; return; }
    if (!inputs.length) { status.textContent = "至少勾一个输入通道。"; return; }
    if (scriptDialogMode === "flow") { await createFlowFromDialog(prompt, inputs, status); return; }
    status.textContent = "正在生成…";
    const options = { inputs: inputs, outputLabel: $("#sdLabel").value.trim(), type: $("#sdType").value || "" };
    state.analysis.inputs = inputs.slice();
    try {
      const ai = window.XHGCS_AI;
      if (!ai || !ai.generateScript) throw new Error("AI 模块未加载");
      // 不再回退到本地关键词表：没配 API 就如实报错，别造一个看起来成功的脚本。
      const result = await ai.generateScript(prompt, options);
      if (!result) throw new Error("生成没有返回结果");
      renderInputs();
      renderScripts();
      syncFormulaToInputs();
      closeScriptDialog();
      toast(result && result.message ? result.message : "脚本已生成并保存到自定义模块");
    } catch (err) {
      status.textContent = "生成失败：" + (err && err.message ? err.message : err);
    }
  }

  // 流程模式：交给 XHGCS_AI.generateGraph 在画布上搭图，勾选的通道会作为 source 节点的输入。
  async function createFlowFromDialog(prompt, inputs, status) {
    state.analysis.inputs = inputs.slice();
    status.textContent = "正在生成流程…";
    try {
      const ai = window.XHGCS_AI;
      if (!ai || !ai.generateGraph) throw new Error("AI 模块未加载");
      const result = await ai.generateGraph(prompt, { inputs: inputs });
      if (!result) throw new Error("生成没有返回结果");
      closeScriptDialog();
      if (window.XHGCS_GRAPH_UI && window.XHGCS_GRAPH_UI.open) window.XHGCS_GRAPH_UI.open();
      renderInputs();
      renderScripts();
      syncFormulaToInputs();
      toast(result.message || "流程已生成并保存到自定义模块");
    } catch (err) {
      status.textContent = "生成失败：" + (err && err.message ? err.message : err);
    }
  }

  function drawFlow() {
    const canvas = $('#analysisCanvas');
    const flow = canvas.parentElement;
    const rect = flow.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(10, Math.round(rect.width * dpr));
    canvas.height = Math.max(10, Math.round(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const input = flow.querySelector('.input-block').getBoundingClientRect();
    const calc = flow.querySelector('.calc-block').getBoundingClientRect();
    const output = flow.querySelector('.output-block').getBoundingClientRect();
    const yInput = input.top - rect.top + input.height / 2;
    const yCalc = calc.top - rect.top + calc.height / 2;
    const yOut = output.top - rect.top + output.height / 2;
    ctx.strokeStyle = 'rgba(' + X.canvasColors().accRgb + ',.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(input.right - rect.left, yInput);
    ctx.bezierCurveTo(input.right - rect.left + 40, yInput, calc.left - rect.left - 40, yCalc, calc.left - rect.left, yCalc);
    ctx.moveTo(calc.right - rect.left, yCalc);
    ctx.bezierCurveTo(calc.right - rect.left + 40, yCalc, output.left - rect.left - 40, yOut, output.left - rect.left, yOut);
    ctx.stroke();
  }

  // 分析画布原来弹在 .modal-overlay 里（二级界面），现在是一级视图：
  // open() 只负责切页，渲染交给 navigate() 回调的 onShow()，两边不会重复跑。
  function open() {
    if (window.XHGCS_APP && window.XHGCS_APP.navigate) { window.XHGCS_APP.navigate('analysis'); return; }
    onShow();
  }
  function close() {
    if (window.XHGCS_APP && window.XHGCS_APP.navigate) { window.XHGCS_APP.navigate('visual'); return; }
  }
  function isOpen() { const el = $('#view-analysis'); return Boolean(el && !el.classList.contains('hidden')); }
  function onShow() {
    renderInputs();
    renderOutputs();
    renderScripts();
    $('#analysisFormula').value = state.analysis.formula;
    syncFormulaToInputs();
    $('#analysisPythonCode').value = state.analysis.python;
    setMode(state.analysis.mode);
    updateStatus();
    syncLiveUI();
    schedulePreview(true);
    if (window.XHGCS_GRAPH_UI) window.XHGCS_GRAPH_UI.open();
    requestAnimationFrame(() => { drawFlow(); drawPreview(); });
  }
  function toast(text) { if (window.XHGCS_APP) window.XHGCS_APP.toast(text); }

  function bind() {
    // 入口是左侧竖列的 [data-nav="analysis"]，由 app-core 的 navigate 切页；这里只保留 AI 面板里的软入口
    $('#btnOpenAnalysis').addEventListener('click', open);
    // 画布工具条的 AI 入口：说清产物是「流程」，跟脚本库那个「生成脚本」区分开
    $('#btnGraphAiFlow').addEventListener('click', () => openScriptDialog({ mode: 'flow', inputs: state.analysis.inputs }));
    document.querySelectorAll('[data-analysis-mode]').forEach((el) => el.addEventListener('click', () => setMode(el.dataset.analysisMode)));
    document.querySelectorAll('[data-fn]').forEach((el) => el.addEventListener('click', () => {
      const input = $('#analysisFormula');
      const fn = el.dataset.fn;
      const names = state.analysis.inputs.map((id) => X.formulaAlias(id));
      const tail = fn === 'lowpass' ? ', 10' : fn === 'slope' ? ', 5' : '';
      input.value = (input.value ? input.value + ' + ' : '') + fn + '(' + names.join(',') + tail + ')';
      input.focus();
      readConfig();
      schedulePreview(true);
    }));
    $('#btnAnalysisAddOutput').addEventListener('click', () => {
      state.analysis.outputs.push({ id: X.uid('out'), label: '输出' + (state.analysis.outputs.length + 1), unit: '', color: '#38bdf8', range: [0, 100] });
      renderOutputs();
      syncLiveUI();
      schedulePreview(true);
    });
    $('#btnAnalysisRun').addEventListener('click', runCurrent);
    $('#btnAnalysisAttach').addEventListener('click', attachCurrent);
    $('#btnFormulaLive').addEventListener('click', stopLiveFormula);
    $('#btnFormulaOpenChart').addEventListener('click', openLiveChart);
    $('#btnToggleAnalysisShelf').addEventListener('click', () => setShelfExpanded(!shelfExpanded));
    $('#analysisFormula').addEventListener('input', () => {
      state.analysis.formula = $('#analysisFormula').value;
      syncLiveUI();
      schedulePreview(true);
    });
    $('#analysisPythonCode').addEventListener('input', () => {
      state.analysis.python = $('#analysisPythonCode').value;
      syncLiveUI();
    });
    $('#btnAnalysisSaveScript').addEventListener('click', saveCurrent);
    $('#btnAnalysisAiScript').addEventListener('click', () => {
      const onGraph = $('#analysisGraphView') && !$('#analysisGraphView').classList.contains('hidden');
      openScriptDialog({
        inputs: state.analysis.inputs,
        hint: onGraph ? '要流程式的结果用对话里的「生成画布」；这里给的是脚本。' : ''
      });
    });
    $('#btnScriptDialogClose').addEventListener('click', closeScriptDialog);
    $('#btnScriptDialogCancel').addEventListener('click', closeScriptDialog);
    $('#btnScriptDialogCreate').addEventListener('click', createScriptFromDialog);
    $('#scriptDialog').addEventListener('click', (e) => { if (e.target.id === 'scriptDialog') closeScriptDialog(); });
    $('#sdPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) createScriptFromDialog(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth() > 0) return; if (e.key === 'Escape' && !$('#scriptDialog').classList.contains('hidden')) closeScriptDialog(); });
    $('#btnAnalysisClearScripts').addEventListener('click', () => {
      state.scripts.filter((script) => !script.builtin).forEach((script) => { if (!state.mcp.deletedScripts.includes(script.id)) state.mcp.deletedScripts.push(script.id); });
      state.scripts = state.scripts.filter((script) => script.builtin);
      X.clearScriptChannels();
      renderScripts();
      V.renderGaugeCards();
      V.switchChannelTab('script');
      toast('已清空自定义脚本');
    });
    window.addEventListener('resize', () => { if (isOpen()) drawFlow(); });
    window.addEventListener('xhgcs:scripts-changed', () => renderScripts());
    setInterval(() => {
      if (!isOpen() || $('#analysisQuickView').classList.contains('hidden')) return;
      if (state.analysis.mode === 'functions') computePreview(false);
    }, 500);
  }

  bind();
  window.XHGCS_ANALYSIS_UI = {
    open: open,
    close: close,
    isOpen: isOpen,
    onShow: onShow,
    runCurrent: runCurrent,
    attachCurrent: attachCurrent,
    saveCurrent: saveCurrent,
    previewNow: () => computePreview(true),
    setShelfExpanded: setShelfExpanded,
    renderScripts: renderScripts,
    renderInputs: renderInputs,
    renderOutputs: renderOutputs,
    openScriptDialog: openScriptDialog,
    closeScriptDialog: closeScriptDialog
  };
})();
