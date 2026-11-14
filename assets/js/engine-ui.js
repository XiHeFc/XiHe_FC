(function () {
  'use strict';
  const X = window.XHGCS;
  const P = window.XHGCS_PROTOCOL || {};
  const state = X.state;
  const $ = (s) => document.querySelector(s);
  const toast = (text) => window.XHGCS_APP && window.XHGCS_APP.toast(text);

  let selectedKey = 'json';
  let selectedEngineId = '';

  // 引擎帧头/帧尾里的回车换行制表符，在输入框里存成可见转义；
  // 跟 X.esc（HTML 转义）不是一回事，所以这里单独命名
  function escapeControlChars(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
  }

  function unescapeControlChars(value) {
    return String(value == null ? '' : value)
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }

  function presetList() {
    return typeof P.presetArray === 'function' ? P.presetArray() : [];
  }

  function presetAt(key) {
    return typeof P.presetByKey === 'function' ? P.presetByKey(key) : presetList()[0] || null;
  }

  function keyFor(engine) {
    if (typeof P.presetFor !== 'function') return '';
    const preset = P.presetFor(engine);
    return preset && preset.key || '';
  }

  function active() {
    return X.getActiveEngine();
  }

  function currentPreset() {
    return presetAt(selectedKey) || presetList()[0] || null;
  }

  function frameSummary(engine) {
    if (!engine) return '';
    if (typeof P.presetFor === 'function') {
      const preset = P.presetFor(engine);
      if (preset) return preset.summary || preset.description || '';
    }
    return String(engine.protocol || '') + ' · ' + String(engine.checksum || 'NONE');
  }

  function updateStatus() {
    const engine = active();
    const status = $('#engineStatus');
    if (!status) return;
    if (!engine) { status.textContent = '未选择'; status.classList.remove('hidden'); return; }
    // 内置预设的名字和规格都印在下面那张高亮卡片上，下拉框里还带一个 ★ —— 状态行再写一遍
    // 就是同一个名字说三遍（实测「JSON 数据引擎」在这个面板里出现 3 次）。整枚收起；
    // AI / 自定义引擎没有卡片可看，名字和规格只能留在状态行里。
    const preset = typeof P.presetFor === 'function' ? P.presetFor(engine) : null;
    status.classList.toggle('hidden', Boolean(preset));
    status.textContent = preset ? '' : '当前 · ' + engine.name + ' · ' + frameSummary(engine);
    renderDetail();
  }

  function escHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // 当前协议的无条件名词规格行（协议 · 字节序 · 校验），不写解释句
  function specLine(engine, preset) {
    const pick = (key) => {
      if (engine && engine[key] != null && engine[key] !== '') return engine[key];
      if (preset && preset[key] != null && preset[key] !== '') return preset[key];
      return '';
    };
    const parts = [];
    const protocol = String(pick('protocol') || '').toUpperCase();
    if (protocol) parts.push(protocol);
    const order = pick('byteOrder');
    if (order === 'little') parts.push('小端');
    else if (order === 'big') parts.push('大端');
    const sum = String(pick('checksum') || '').toUpperCase();
    if (sum) parts.push(sum === 'NONE' ? '无校验' : sum);
    return parts.join(' · ');
  }

  // 右侧协议详情：所有字段都从「当前生效引擎 / 当前预设定义」读，不编造
  function renderDetail() {
    const box = $('#engineDetail');
    if (!box) return;
    const engine = active();
    const preset = (engine && typeof P.presetFor === 'function' ? P.presetFor(engine) : null) || currentPreset();
    const nameEl = $('#engineActiveName');
    const hintEl = $('#engineActiveHint');
    if (!engine && !preset) {
      if (nameEl) nameEl.textContent = '当前协议';
      if (hintEl) hintEl.textContent = '—';
      box.innerHTML = '<div class="engine-detail-empty">无协议</div>';
      return;
    }
    const title = (engine && engine.name) || (preset && preset.name) || '当前协议';
    if (nameEl) nameEl.textContent = title;
    if (hintEl) hintEl.textContent = specLine(engine, preset);
    const pick = (key) => {
      if (engine && engine[key] != null && engine[key] !== '') return engine[key];
      if (preset && preset[key] != null && preset[key] !== '') return preset[key];
      return '';
    };
    const rows = [];
    const push = (label, value, mono) => {
      if (value == null || value === '') return;
      rows.push('<div class="ed-row"><span>' + escHtml(label) + '</span><b' + (mono ? ' class="mono"' : '') + '>' + escHtml(value) + '</b></div>');
    };
    push('协议', pick('protocol'), true);
    push('帧头', pick('header'), true);
    push('帧尾', pick('footer') || pick('tail'), true);
    push('结束符', pick('terminator'), true);
    push('字节序', pick('byteOrder') === 'little' ? '小端 (Little)' : pick('byteOrder') === 'big' ? '大端 (Big)' : '');
    push('校验', pick('checksum'), true);
    push('通道数', pick('channelCount') ? String(pick('channelCount')) + ' 通道' : '');
    push('负载字节', pick('payloadBytes'));
    // 字段表：引擎定义里真的有 fields 才渲染，没有就只列上面这些真实规格
    let fieldTable = '';
    const fields = engine && Array.isArray(engine.fields) ? engine.fields : Array.isArray(preset && preset.fields) ? preset.fields : null;
    if (fields && fields.length) {
      fieldTable = '<div class="ed-fields"><div class="ed-fields-head"><span>字段</span><span>类型</span><span>通道</span></div>'
        + fields.slice(0, 24).map((field) => '<div class="ed-fields-row"><span>' + escHtml(field.name || field.label || '') + '</span><span>'
          + escHtml(field.type || field.kind || '') + '</span><span>' + escHtml(field.channel || field.channelId || '') + '</span></div>').join('')
        + '</div>';
    }
    const out = $('#engineOut');
    if (out) {
      const lastLog = (state.logs && state.logs.length) ? state.logs[state.logs.length - 1] : null;
      out.innerHTML = lastLog
        ? '<span>' + escHtml(String(lastLog.text || '').slice(0, 220)) + '</span>'
        : '<span>无输出</span>';
    }
    let chBlock = '';
    try {
      const all = typeof X.allChannels === 'function' ? X.allChannels() : [];
      if (all && all.length) {
        const fmtNum = (value) => {
          if (!isFinite(value)) return '—';
          const abs = Math.abs(value);
          return abs >= 1000 ? value.toFixed(0) : abs >= 100 ? value.toFixed(1) : value.toFixed(2);
        };
        const rangeOf = (ch) => {
          const data = Array.isArray(ch.data) ? ch.data : [];
          if (!data.length) return '—';
          let min = data[0];
          let max = data[0];
          for (let i = 1; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
          }
          return fmtNum(min) + ' ~ ' + fmtNum(max);
        };
        const rowsHtml = all.slice(0, 24).map((ch) => {
          const color = typeof X.viewColor === 'function' ? X.viewColor(ch.color) : (ch.color || '#6da8d2');
          return '<div class="ed-chrow"><span class="ed-chname"><i style="background:' + escHtml(color || '#6da8d2') + '"></i>'
            + escHtml(ch.name || ch.id) + '</span><span class="mono">' + escHtml(ch.id) + '</span><span>'
            + escHtml(ch.unit || '—') + '</span><span class="mono">' + escHtml(rangeOf(ch)) + '</span></div>';
        }).join('');
        chBlock = '<div class="ed-chtable"><div class="ed-chtable-head"><span>当前通道</span><span>代号</span><span>单位</span><span>实时范围</span></div>'
          + rowsHtml + '</div>';
      }
    } catch (err) { /* 通道列表取不到就不显示这一块 */ }
    box.innerHTML = '<div class="engine-detail-grid">' + rows.join('') + '</div>' + fieldTable + chBlock;
    // 视觉：把左卡卡框拉到与右卡（detail-panel）同底边；只同步高度，不动内容/AI 行/占位
    const panelEl = box.closest('.engine-detail-panel');
    const sideEl = document.querySelector('#view-input .engine-side');
    if (panelEl && sideEl) {
      window.requestAnimationFrame(function () {
        sideEl.style.minHeight = Math.round(panelEl.getBoundingClientRect().height) + 'px';
      });
    }
  }

  function renderPresets() {
    const box = $('#enginePresets');
    if (!box) return;
    box.innerHTML = '';
    presetList().forEach((preset) => {
      if (!preset || !preset.key) return;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'engine-preset' + (preset.key === selectedKey ? ' active' : '');
      item.dataset.preset = preset.key;
      // 协议代号和名称原来各占一行，而名称本来就以代号开头（JSON / JSON 数据引擎），
      // 四张卡片等于把协议名说了八遍；并成一行，代号仍用强调色区分，卡片也收回一行高度
      const code = String(preset.protocol || '');
      const name = String(preset.name || '');
      const title = code && name.indexOf(code) === 0
        ? '<em class="eng-code">' + code + '</em>' + name.slice(code.length)
        : name;
      // 紧凑行：名称 12 + 元数据 10 dim；散文式 description 不再显示
      item.innerHTML = '<span class="engine-preset-top"><b>' + title + '</b>'
        + (preset.summary ? '<span class="engine-preset-meta">' + escHtml(preset.summary) + '</span>' : '')
        + '</span>';
      box.appendChild(item);
    });
    renderDetail();
    renderPreview();
  }

  // v43：只读帧预览 —— 当前预设的样例帧，随选中项更新
  function renderPreview() {
    const box = document.getElementById('inputFramePreview');
    if (!box) return;
    const preset = currentPreset();
    box.textContent = preset && preset.sample ? String(preset.sample) : '—';
  }

  function setField(id, value) {
    const el = $(id);
    if (el) el.value = value == null ? '' : String(value);
  }

  function loadPresetForm(key) {
    const preset = presetAt(key) || presetList()[0];
    if (!preset) return;
    selectedKey = preset.key || 'json';
    selectedEngineId = '';
    setField('#engineName', '');
    setField('#engineList', '');
    setField('#engineProtocol', preset.protocol);
    setField('#engineHeader', preset.header || '');
    setField('#engineTail', preset.tail || '');
    setField('#engineTerminator', escapeControlChars(preset.terminator));
    setField('#engineChecksum', preset.checksum || 'NONE');
    setField('#engineByteOrder', preset.byteOrder || 'little');
    setField('#engineHexScale', preset.hexScale != null ? preset.hexScale : 10);
    setField('#enginePayloadBytes', preset.payloadBytes != null ? preset.payloadBytes : 40);
    setField('#engineChannelCount', preset.channelCount != null ? preset.channelCount : 20);
    updateProtocolForm();
    renderPresets();
    updateStatus();
  }

  function loadForm(id) {
    const engine = id ? state.engines.find((item) => item.id === id) : null;
    if (!engine) {
      loadPresetForm(selectedKey);
      return;
    }
    selectedEngineId = engine.id;
    selectedKey = keyFor(engine) || selectedKey;
    setField('#engineList', engine.id);
    setField('#engineName', engine.name || '');
    setField('#engineProtocol', engine.protocol || 'JSON');
    setField('#engineHeader', engine.header || '');
    setField('#engineTail', engine.tail || '');
    setField('#engineTerminator', escapeControlChars(engine.terminator));
    setField('#engineChecksum', engine.checksum || 'NONE');
    setField('#engineByteOrder', engine.byteOrder || 'little');
    setField('#engineHexScale', engine.hexScale != null ? engine.hexScale : 10);
    setField('#enginePayloadBytes', engine.payloadBytes != null ? engine.payloadBytes : 40);
    setField('#engineChannelCount', engine.channelCount != null ? engine.channelCount : 20);
    updateProtocolForm();
    renderPresets();
    updateStatus();
  }

  function readForm(id) {
    const protocol = $('#engineProtocol').value;
    const existing = id ? state.engines.find((item) => item.id === id) : null;
    // 点预设卡片进来的、表单协议又和卡片一致，就用卡片自己的预设：
    // WED 家族有传感器 / 飞控两个规格，按协议代号去猜会一律猜成传感器那个
    const clicked = presetAt(selectedKey);
    const preset = clicked && String(clicked.protocol || '').toUpperCase() === String(protocol || '').toUpperCase()
      ? clicked
      : (typeof P.presetFor === 'function' ? P.presetFor({ protocol: protocol }) : null);
    const baseName = existing && existing.name || preset && preset.name || '自定义数据引擎';
    const name = $('#engineName').value.trim() || baseName + (existing ? '' : ' 副本 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    return {
      name: String(name).slice(0, 48),
      protocol: protocol,
      protocolId: protocol === 'WED' ? String(existing && existing.protocolId || preset && preset.protocolId || 'wed-telemetry') : '',
      header: $('#engineHeader').value,
      tail: $('#engineTail').value,
      terminator: unescapeControlChars($('#engineTerminator').value),
      checksum: $('#engineChecksum').value,
      byteOrder: $('#engineByteOrder').value || 'little',
      hexScale: Number($('#engineHexScale').value) || 10,
      payloadBytes: Number($('#enginePayloadBytes').value) || (protocol === 'WED' ? 40 : 0),
      channelCount: Number($('#engineChannelCount').value) || (protocol === 'WED' ? 20 : 0),
      description: existing && existing.description || '高级配置数据引擎'
    };
  }

  function updateProtocolForm() {
    const isWed = $('#engineProtocol').value === 'WED';
    ['#enginePayloadBytes', '#engineChannelCount'].forEach((id) => {
      const input = $(id);
      if (input && input.closest('label')) input.closest('label').hidden = !isWed;
    });
    const apply = $('#btnEngineApplyChannels');
    if (apply) apply.hidden = !isWed;
  }

  function applyWedDefaults() {
    if ($('#engineProtocol').value !== 'WED') return;
    const clicked = presetAt(selectedKey);
    const preset = clicked && String(clicked.protocol || '').toUpperCase() === 'WED' ? clicked : presetAt('wed');
    if (!preset) return;
    setField('#engineHeader', preset.header || '55AA');
    setField('#engineTail', preset.tail || '');
    setField('#engineTerminator', escapeControlChars(preset.terminator));
    setField('#enginePayloadBytes', preset.payloadBytes || 40);
    setField('#engineChannelCount', preset.channelCount || 20);
    setField('#engineChecksum', preset.checksum || 'SUM8');
    setField('#engineByteOrder', preset.byteOrder || 'big');
  }

  function renderList(selectedId) {
    const list = $('#engineList');
    if (!list) return;
    list.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '使用协议预设';
    list.appendChild(empty);
    state.engines.forEach((engine) => {
      const option = document.createElement('option');
      option.value = engine.id;
      // 预设引擎的名字本身就带协议代号（JSON 数据引擎），再补一个「· JSON」是同一句话说两遍
      const code = String(engine.protocol || '');
      const named = code && engine.name.toUpperCase().indexOf(code.toUpperCase()) >= 0;
      option.textContent = engine.name + (engine.active ? ' ★' : '') + (named ? '' : code ? ' · ' + code : '');
      list.appendChild(option);
    });
    const engine = selectedId ? state.engines.find((item) => item.id === selectedId) : active();
    if (engine && engine.id) loadForm(engine.id);
    else loadPresetForm(selectedKey);
    renderDetail();
  }

  function selectPreset(key) {
    loadPresetForm(key);
    // v43：预设即选即用（样稿里没有单独的「应用」一步），载入表单后立刻应用到链路
    applyCurrent();
  }

  function findPresetEngine(preset) {
    if (!preset) return null;
    const protocol = String(preset.protocol || '').toUpperCase();
    const protocolId = String(preset.protocolId || '');
    return state.engines.find((engine) => {
      if (String(engine.protocol || '').toUpperCase() !== protocol) return false;
      // WED 家族现在有多个规格：protocolId 不同就是两台不同引擎，不能互相认领
      // （原来所有 WED 都算同一台，点飞控卡片会改到传感器那台引擎身上）
      if (protocolId) return String(engine.protocolId || '') === protocolId;
      return !String(engine.protocolId || '');
    }) || null;
  }

  function applyCurrent() {
    const preset = currentPreset();
    const fields = readForm(selectedEngineId);
    const previous = active();
    const existing = (selectedEngineId && state.engines.find((item) => item.id === selectedEngineId)) || findPresetEngine(preset);
    let engine;
    if (existing) {
      Object.assign(existing, fields, { name: existing.name || fields.name });
      engine = existing;
    } else {
      engine = X.addEngine(fields);
    }
    X.setActiveEngine(engine.id);
    const count = Number(engine.channelCount) || 20;
    // 按引擎自己的规格比，别写死传感器那个 id：不然切到飞控引擎会每次都重建通道
    const profileId = String(engine.protocolId || 'wed-telemetry');
    const needsProtocolChannels = engine.protocol === 'WED' && (
      !previous || previous.id !== engine.id ||
      state.channels.length !== count ||
      !state.channels.every((ch) => String(ch.protocolId || '') === profileId)
    );
    if (needsProtocolChannels) X.applyProtocolChannels(engine);
    renderList(engine.id);
    toast('已应用数据引擎：' + engine.name + ' · ' + engine.protocol);
  }

  function saveCurrent() {
    const typedName = ($('#engineName').value || '').trim();
    const saved = selectedEngineId ? state.engines.find((item) => item.id === selectedEngineId) : null;
    const fields = readForm('');
    if (!typedName || (saved && typedName === saved.name)) {
      const base = String(fields.name || '自定义数据引擎').replace(/ 副本.*$/, '');
      fields.name = base + ' 副本 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
    const engine = X.addEngine(fields);
    X.setActiveEngine(engine.id);
    if (engine.protocol === 'WED') X.applyProtocolChannels(engine);
    renderList(engine.id);
    toast('已保存新引擎：' + engine.name);
  }

  function applyChannels() {
    const engine = (selectedEngineId && state.engines.find((item) => item.id === selectedEngineId)) || active();
    if (!engine) return toast('请先选择数据引擎');
    if (engine.protocol !== 'WED') return toast('仅 WED 协议支持应用协议通道');
    const count = Number(engine.channelCount) || 20;
    if (!confirm('将按 WED 协议重建 ' + count + ' 个原始通道，继续？')) return;
    const applied = X.applyProtocolChannels(engine);
    if (applied) toast('已应用 WED 协议通道：' + applied + ' 个');
  }

  function deleteCurrent() {
    if (!selectedEngineId) return toast('请先选择已保存引擎');
    const engine = state.engines.find((item) => item.id === selectedEngineId);
    if (!engine) return;
    if (!confirm('删除数据引擎「' + engine.name + '」？')) return;
    X.removeEngine(selectedEngineId);
    if (!state.mcp.deletedEngines.includes(selectedEngineId)) state.mcp.deletedEngines.push(selectedEngineId);
    X.persist();
    selectedEngineId = '';
    renderList();
    toast('数据引擎已删除');
  }

  function setAdvanced(open) {
    const box = $('#engineAdvanced');
    const button = $('#btnToggleEngineAdvanced');
    if (box) box.hidden = !open;
    const view = $('#view-input');
    if (view) view.classList.toggle('advanced-open', open);
    if (button) button.textContent = open ? '收起配置' : '高级配置';
    if (open) updateProtocolForm();
  }

  async function aiGenerate() {
    const prompt = ($('#enginePrompt').value || '').trim() || '生成一个 ' + $('#engineProtocol').value + ' 数据引擎';
    const button = $('#btnAiGenerateEngine');
    button.disabled = true;
    button.textContent = '生成中…';
    try {
      const result = await window.XHGCS_AI.generateEngine(prompt);
      renderList(result.id);
      toast(result.message);
    } catch (err) {
      toast('AI 生成失败：' + (err && err.message || err));
    } finally {
      button.disabled = false;
      button.textContent = 'AI 生成';
    }
  }

  function bind() {
    $('#enginePresets').addEventListener('click', (event) => {
      const card = event.target.closest('.engine-preset');
      if (card) selectPreset(card.dataset.preset);
    });
    $('#engineList').addEventListener('change', (event) => {
      const id = event.target.value;
      if (id) loadForm(id);
      else loadPresetForm(selectedKey);
    });
    $('#engineProtocol').addEventListener('change', () => {
      const preset = typeof P.presetFor === 'function' ? P.presetFor({ protocol: $('#engineProtocol').value }) : null;
      if (preset) loadPresetForm(preset.key);
      else {
        applyWedDefaults();
        updateProtocolForm();
      }
    });
    $('#enginePayloadBytes').addEventListener('change', () => {
      const value = Number($('#enginePayloadBytes').value) || 40;
      $('#engineChannelCount').value = String(Math.max(1, Math.floor(value / 2)));
    });
    $('#engineChannelCount').addEventListener('change', () => {
      const value = Math.max(1, Number($('#engineChannelCount').value) || 20);
      $('#enginePayloadBytes').value = String(value * 2);
    });
    $('#btnEngineApplyChannels').addEventListener('click', applyChannels);
    $('#btnEngineSave').addEventListener('click', saveCurrent);
    $('#btnEngineApply').addEventListener('click', applyCurrent);
    $('#btnEngineDelete').addEventListener('click', deleteCurrent);
    $('#btnToggleEngineAdvanced').addEventListener('click', () => setAdvanced($('#engineAdvanced').hidden));
    $('#btnAiGenerateEngine').addEventListener('click', aiGenerate);
    const aiAdd = $('#btnEngineAiAdd');
    if (aiAdd) {
      // 预设行末尾的「＋」：把焦点带到 AI 生成入口（AI 链路本身不动）
      aiAdd.addEventListener('click', () => {
        const prompt = $('#enginePrompt');
        if (!prompt) return;
        prompt.scrollIntoView({ block: 'nearest' });
        prompt.focus();
      });
    }
    $('#enginePrompt').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        aiGenerate();
      }
    });
  }

  function init() {
    bind();
    renderList();
    updateStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.addEventListener('xhgcs:engines-changed', () => renderList());
  window.addEventListener('xhgcs:engine-active-changed', () => updateStatus());

  window.XHGCS_ENGINE_UI = {
    renderList: renderList,
    loadForm: loadForm,
    renderPresets: renderPresets,
    updateProtocolForm: updateProtocolForm,
    applyChannels: applyChannels,
    updateStatus: updateStatus
  };
})();
