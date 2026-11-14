(function () {
  'use strict';
  const X = window.XHGCS;
  const A = window.XHGCS_ANALYSIS;
  const V = window.XHGCS_VIEWS;
  const P = window.XHGCS_PROTOCOL || {};
  const state = X.state;

  let timer = 0;
  let busy = false;
  let wasConnected = false;
  const processed = new Set();

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const options = { method: body ? 'POST' : 'GET', signal: controller.signal };
    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    try {
      const response = await X.mcpFetch(path, options);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timeout);
    }
  }

  // 视图自检结果只回传一次（Agent 用 verify_view 等它），所以 POST 成功后立即清空，
  // 不占每 1.5s 一次的同步带宽。
  const verifyReports = [];

  /**
   * 看板类队列项的执行体。
   * 看板文档存在浏览器 localStorage 里，桥那边看不到，所以读操作也必须排队过来取，
   * 再把结果放到 ack 的 data 里带回去。
   */
  function summarizeBoard(doc) {
    return {
      id: doc.id,
      name: doc.name,
      cols: doc.cols,
      updatedAt: doc.updatedAt,
      widgets: (doc.root.children || []).map((node) => ({
        id: node.id,
        type: node.type,
        title: (node.props && (node.props.title || node.props.text)) || '',
        grid: node.grid,
        bind: (node.bind || []).map((key) => doc.bindings[key]).filter(Boolean)
      }))
    };
  }

  function applyBoardAction(item) {
    const core = window.XHGCS_CORE;
    if (!core || !core.boards) throw new Error('插件内核未加载（assets/js/core.bundle.js），看板库不可用');
    const boards = core.boards;
    if (item.type === 'board_list') {
      return { changed: false, list: boards.list(), active: boards.active() };
    }
    // 看板 id 走 boardId：队列项自己的 id 是 qid，两者不能混用
    const boardId = String(item.boardId || item.id || '');
    if (item.type === 'board_get') {
      const id = boardId || boards.activeId();
      const doc = boards.get(id);
      if (!doc) throw new Error('看板不存在：' + id);
      return { changed: false, board: summarizeBoard(doc) };
    }
    if (item.type === 'board_create') {
      const id = boards.create(item.name || 'MCP 看板');
      return { changed: true, id: id, active: boards.active() };
    }
    if (item.type === 'board_open') {
      const id = boardId || boards.activeId();
      if (!boards.switchTo(id)) throw new Error('看板不存在：' + id);
      core.ui.openBoard();
      return { changed: false, opened: id };
    }
    if (item.type === 'board_patch') {
      // 先校验再动活动板：dry_run 不能有切换副作用，跨板补丁要先 open_board
      if (boardId && boardId !== boards.activeId() && item.dryRun) {
        return {
          changed: false,
          dryRun: true,
          preview: { ok: false, errors: ['dry_run 只校验当前活动板；跨板请先 open_board 或省略 id'] }
        };
      }
      if (boardId && boardId !== boards.activeId() && !boards.switchTo(boardId)) {
        throw new Error('看板不存在：' + boardId);
      }
      const patch = { ops: item.ops || [], baseUpdatedAt: item.baseUpdatedAt };
      const preview = typeof boards.previewPatch === 'function' ? boards.previewPatch(patch) : null;
      if (item.dryRun) return { changed: false, dryRun: true, preview: preview };
      const result = boards.applyPatch(patch);
      return { changed: Boolean(result && result.ok), preview: preview, result: result };
    }
    if (item.type === 'board_undo') {
      return { changed: true, result: boards.revertPatch() };
    }
    throw new Error('未知看板操作：' + item.type);
  }

  function buildPayload() {
    const snapshot = X.getDataSnapshot(Math.max(1, Number(state.ai.contextFrames) || 10));
    const series = {};
    X.allChannels().forEach((ch) => {
      const values = ch.data.slice(-100).map((v) => Number(v));
      series[ch.id] = values;
      if (ch.name) series[ch.name] = values;
    });
    return Object.assign({}, snapshot, { simulation: state.simulation, series: series, sentAt: Date.now(), scripts: state.scripts.slice(), engines: state.engines.slice(), components: state.components.slice(), views: (state.views || []).slice(), activeEngine: state.activeEngine, deletedScripts: state.mcp.deletedScripts || [], deletedEngines: state.mcp.deletedEngines || [], deletedComponents: state.mcp.deletedComponents || [], deletedViews: state.mcp.deletedViews || [], verifyReports: verifyReports.slice(), extensions: extensionSummary(), pipeline: pipelineSummary() });
  }

  // 内核可观测面：MCP / 外部 AI 想判断“某个插件在不在、引擎跑没跑”，
  // 不用再开浏览器、也不用猜 —— 这两个摘要跟着轮询一起过去。
  function extensionSummary() {
    const core = window.XHGCS_CORE;
    if (!core || !core.host) return [];
    try {
      return core.host.list().map((record) => ({
        id: record.manifest.id,
        name: record.manifest.name,
        version: record.manifest.version,
        status: record.status,
        message: record.message || ''
      }));
    } catch (err) {
      return [];
    }
  }

  function pipelineSummary() {
    const core = window.XHGCS_CORE;
    if (!core || !core.engine || !core.engine.pipeline) return null;
    try {
      const metrics = core.engine.pipeline.metrics();
      return {
        running: metrics.running,
        processed: metrics.processed,
        dropped: metrics.dropped,
        errors: metrics.errors,
        queued: metrics.queued,
        capacity: metrics.capacity,
        avgLatencyMs: Math.round(metrics.avgLatencyMs * 100) / 100,
        stages: metrics.operators,
        sinks: metrics.sinks
      };
    } catch (err) {
      return null;
    }
  }

  function mergeScript(script) {
    if (state.mcp.deletedScripts && state.mcp.deletedScripts.includes(script && script.id)) return false;
    if (!script || !script.id || state.scripts.some((item) => item.id === script.id)) return false;
    // 桥侧已经不再编造 inputs/outputs，这里也不兜底。以前缺 inputs 会补一个 ['ch1']，
    // 于是坏脚本照样进库、界面显示成功，只是永远跑不出数据。
    if (!Array.isArray(script.inputs) || !script.inputs.length) {
      throw new Error('脚本缺少 inputs：' + (script.name || script.id));
    }
    if (!Array.isArray(script.outputs) || !script.outputs.length) {
      throw new Error('脚本缺少 outputs：' + (script.name || script.id));
    }
    state.scripts.push(Object.assign({}, script, { builtin: false, origin: script.origin || 'mcp' }));
    return true;
  }

  // mergeScript 的语义是「存在即跳过」（轮询每 1.5s 都把已知脚本推回来，重复合并不该动东西）。
  // 更新必须另走 in-place 合并，保留 id/builtin/origin/createdAt，否则轮询会把更新冲掉。
  function mergeScriptUpdate(script) {
    if (!script || !script.id) return false;
    if (state.mcp.deletedScripts && state.mcp.deletedScripts.includes(script.id)) return false;
    const index = state.scripts.findIndex((item) => item.id === script.id);
    if (index < 0) return false;
    const existing = state.scripts[index];
    // 内置脚本只读：桥侧已拒绝，这里再防一层（防止手写队列绕过）
    if (existing.builtin) return false;
    if (!Array.isArray(script.inputs) || !script.inputs.length) throw new Error('脚本缺少 inputs：' + (script.name || script.id));
    if (!Array.isArray(script.outputs) || !script.outputs.length) throw new Error('脚本缺少 outputs：' + (script.name || script.id));
    state.scripts[index] = Object.assign({}, existing, script, {
      id: existing.id,
      builtin: Boolean(existing.builtin),
      origin: existing.origin || script.origin || 'mcp',
      createdAt: existing.createdAt || script.createdAt
    });
    return true;
  }

  function mergeEngineUpdate(engine) {
    if (!engine || !engine.id) return false;
    if (state.mcp.deletedEngines && state.mcp.deletedEngines.includes(engine.id)) return false;
    const index = state.engines.findIndex((item) => item.id === engine.id);
    if (index < 0) return false;
    const existing = state.engines[index];
    state.engines[index] = Object.assign({}, existing, engine, {
      id: existing.id,
      active: Boolean(existing.active),
      origin: existing.origin || engine.origin || 'mcp',
      createdAt: existing.createdAt || engine.createdAt
    });
    return true;
  }

  // 删除墓碑只留最近 200 个（与 data.js 的 DELETED_ID_LIMIT 一致；这里不另存一份结构）
  function pushScriptTombstone(id) {
    if (!id) return;
    if (!Array.isArray(state.mcp.deletedScripts)) state.mcp.deletedScripts = [];
    if (state.mcp.deletedScripts.includes(id)) return;
    state.mcp.deletedScripts.push(id);
    if (state.mcp.deletedScripts.length > 200) state.mcp.deletedScripts.splice(0, state.mcp.deletedScripts.length - 200);
  }

  // 远端组件/视图的内容指纹：忽略 updatedAt / createdAt 这类每次都变的元数据
  function componentSignature(component) {
    const src = component || {};
    return JSON.stringify({
      name: src.name || '',
      description: src.description || '',
      kind: src.kind || 'formula',
      inputs: src.inputs || [],
      outputs: src.outputs || [],
      parameters: src.parameters || [],
      config: src.config || {}
    });
  }

  function viewSignature(view) {
    const src = view || {};
    return JSON.stringify({
      name: src.name || '',
      icon: src.icon || '',
      desc: src.desc || src.description || '',
      code: String(src.code || '').trim()
    });
  }

  function mergeEngine(engine) {
    if (state.mcp.deletedEngines && state.mcp.deletedEngines.includes(engine && engine.id)) return false;
    if (!engine || !engine.id || state.engines.some((item) => item.id === engine.id)) return false;
    state.engines.push(Object.assign({}, engine, { origin: engine.origin || 'mcp', active: false }));
    return true;
  }

  function mergeComponent(component) {
    if (state.mcp.deletedComponents && state.mcp.deletedComponents.includes(component && component.id)) return false;
    if (!component || !component.id) return false;
    // 远端组件先过一遍乱码自愈：桥把汉字解成 U+FFFD 时，坏值不能就这么进 state
    const incoming = X.healComponentText ? X.healComponentText(component) : component;
    const existing = state.components.find((item) => item.id === incoming.id);
    if (existing) {
      // 只按内容判定变化：updatedAt 每轮都会刷新，直接比对象会把每次轮询都误判成“有更新”，
      // 进而让 applyRemote 每轮都强制切换通道页签。
      if (componentSignature(existing) === componentSignature(incoming)) return false;
      Object.assign(existing, incoming, {
        id: existing.id,
        builtin: Boolean(existing.builtin),
        origin: existing.builtin ? 'builtin' : (incoming.origin || 'mcp'),
        updatedAt: Date.now()
      });
      return true;
    }
    state.components.push(Object.assign({}, incoming, { builtin: false, origin: incoming.origin || 'mcp' }));
    return true;
  }

  function mergeView(view) {
    if (state.mcp.deletedViews && state.mcp.deletedViews.includes(view && view.id)) return false;
    if (!view || !view.id || !view.code) return false;
    if (!window.XHGCS_VIEWS || !window.XHGCS_VIEWS.saveViewSpec) return false;
    const current = (state.views || []).find((item) => item.id === view.id) || null;
    if (current && viewSignature(current) === viewSignature(view)) return false;
    try {
      window.XHGCS_VIEWS.saveViewSpec({
        id: view.id,
        name: view.name,
        icon: view.icon,
        desc: view.desc || view.description,
        code: view.code,
        origin: view.origin || 'mcp'
      });
    } catch (err) {
      console.warn('XiHe_GCS bridge: 视图插件无效', view.id, err);
      return false;
    }
    if (window.XHGCS_VIEWS.renderSwitcher) window.XHGCS_VIEWS.renderSwitcher();
    return true;
  }

  function needsWedChannels(engine) {
    if (!P.isWed || !P.isWed(engine) || !X.applyProtocolChannels) return false;
    const count = Number(engine.channelCount) || 20;
    const protocolId = String(engine.protocolId || (P.WED && P.WED.id) || '');
    return !(state.channels.length === count && state.channels.every((ch) => String(ch.protocolId || '') === protocolId));
  }

  function ensureWedChannels(engine) {
    if (!P.isWed || !P.isWed(engine) || !X.applyProtocolChannels) return;
    if (needsWedChannels(engine)) X.applyProtocolChannels(engine);
  }

  function activateEngine(id) {
    const engine = state.engines.find((item) => item.id === id);
    if (!engine) return;
    X.setActiveEngine(id);
    ensureWedChannels(engine);
  }

  async function applyRemote(remote) {
    if (!remote) return [];
    const acked = [];
    let changed = false;
    let scriptTouched = false;
    // 这一趟是桥把已知脚本推回来，坏实体只告警、不中断整轮同步。需要把原因带回给
    // 等着的那个工具的路径在下面的 queue —— 那里抛出的异常会变成 ok:false 的 ack。
    (remote.scripts || []).forEach((script) => {
      try { if (mergeScript(script)) changed = true; }
      catch (err) { console.warn('XiHe_GCS bridge: 远端脚本无效', script && script.id, err); }
    });
    (remote.engines || []).forEach((engine) => { if (mergeEngine(engine)) changed = true; });
    (remote.components || []).forEach((component) => { if (mergeComponent(component)) changed = true; });
    (remote.views || []).forEach((view) => { if (mergeView(view)) changed = true; });
    if (remote.activeEngine && state.engines.some((engine) => engine.id === remote.activeEngine)) {
      const target = state.engines.find((engine) => engine.id === remote.activeEngine);
      if (state.activeEngine !== remote.activeEngine || needsWedChannels(target)) {
        activateEngine(remote.activeEngine);
        changed = true;
      }
    }
    const queue = Array.isArray(remote.queue) ? remote.queue : [];
    // 每条队列项的执行结果，随 ack 一起回给桥 —— 桥那边有工具在等这一程。
    const results = [];
    for (const item of queue) {
      // 用 qid 而不是 id：component_deleted / view_deleted / engine_active 的 id 是实体 id，
      // 拿它当队列身份会撞车（同一个实体连删两次、ack 连带清掉别人的条目）。
      const id = item && (item.qid || item.id);
      if (!id || processed.has(id)) continue;
      // 用户已经删掉这条了：故意不动它，但仍算处理过
      const skipped = (item.type === 'script_created' && item.script && state.mcp.deletedScripts.includes(item.script.id))
        || (item.type === 'engine_created' && item.engine && state.mcp.deletedEngines.includes(item.engine.id))
        || (item.type === 'component_created' && item.component && state.mcp.deletedComponents && state.mcp.deletedComponents.includes(item.component.id));
      processed.add(id);
      // 先执行、后记账。以前是先 acked.push 再执行，而抛错只 console.warn ——
      // 于是「浏览器执行失败」和「执行成功」在桥那边长得一模一样。
      let ok = true;
      let error = '';
      let resultData = null;
      try {
        if (skipped) {
          // 用户已删除，跳过
        } else if (item.type === 'script_created' && item.script) {
          mergeScript(item.script);
          const script = state.scripts.find((s) => s.id === item.script.id);
          if (script && item.run !== false) {
            A.ensureOutputs(script);
            if (script.type === 'graph' && window.XHGCS_GRAPH) await window.XHGCS_GRAPH.runGraphScript(script, { persist: true });
            else await A.runAndAttach(script, script.inputs);
          }
          changed = true;
          scriptTouched = true;
        } else if (item.type === 'script_updated' && item.script) {
          // 更新：in-place 合并 + 重建输出通道；按需求「不自动 run」，是否运行由用户/AI 另行触发。
          // 后台更新也不切页签：scriptTouched 会把用户正在看的视图抢到「脚本数据」，
          // agent 改个公式不该让界面跳一下。
          if (mergeScriptUpdate(item.script)) changed = true;
          const updated = state.scripts.find((s) => s.id === item.script.id);
          if (updated) A.ensureOutputs(updated);
          changed = true;
        } else if (item.type === 'script_deleted' && item.id) {
          const before = state.scripts.length;
          state.scripts = state.scripts.filter((engineScript) => engineScript.id !== item.id || engineScript.builtin);
          state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== item.id);
          // 墓碑：防止下一轮 /api/state 把桥侧残留的脚本又合并回来
          pushScriptTombstone(item.id);
          if (state.analysis && state.analysis.canvasScriptId === item.id) state.analysis.canvasScriptId = '';
          if (state.scripts.length !== before) changed = true;
          scriptTouched = true;
        } else if (item.type === 'canvas_loaded' && item.graph && window.XHGCS_GRAPH) {
          window.XHGCS_GRAPH.setCanvas(item.graph);
          if (window.XHGCS_GRAPH_UI) window.XHGCS_GRAPH_UI.render();
          changed = true;
        } else if (item.type === 'engine_created' && item.engine) {
          mergeEngine(item.engine);
          if (item.activate !== false) activateEngine(item.engine.id);
          changed = true;
        } else if (item.type === 'engine_updated' && item.engine) {
          if (mergeEngineUpdate(item.engine)) changed = true;
          // 改的是当前活动引擎：重新激活（WED 会重建 20 个通道）
          if (item.active) activateEngine(item.engine.id);
          changed = true;
        } else if (item.type === 'engine_deleted' && item.id) {
          const before = state.engines.length;
          state.engines = state.engines.filter((engine) => engine.id !== item.id);
          if (Array.isArray(state.mcp.deletedEngines) && !state.mcp.deletedEngines.includes(item.id)) state.mcp.deletedEngines.push(item.id);
          if (state.activeEngine === item.id) state.activeEngine = state.engines[0] ? state.engines[0].id : '';
          if (state.engines.length !== before) changed = true;
        } else if (item.type === 'component_created' && item.component) {
          if (mergeComponent(item.component)) changed = true;
        } else if (item.type === 'component_updated' && item.component) {
          if (mergeComponent(item.component)) changed = true;
        } else if (item.type === 'component_deleted' && item.id) {
          const before = state.components.length;
          state.components = state.components.filter((comp) => comp.id !== item.id || comp.builtin);
          if (state.mcp.deletedComponents && !state.mcp.deletedComponents.includes(item.id)) state.mcp.deletedComponents.push(item.id);
          if (state.analysis && state.analysis.canvas && Array.isArray(state.analysis.canvas.nodes)) {
            state.analysis.canvas.nodes.forEach((node) => {
              if (node && node.type === 'component' && node.config && node.config.componentId === item.id) {
                node.config.componentSnapshot = null;
                node.config.missing = true;
                node.config.parameters = {};
              }
            });
          }
          if (state.components.length !== before) changed = true;
          if (window.XHGCS_GRAPH_UI) window.XHGCS_GRAPH_UI.render();
        } else if (item.type === 'view_created' && item.view) {
          if (mergeView(item.view)) changed = true;
        } else if (item.type === 'view_updated' && item.view) {
          if (mergeView(item.view)) changed = true;
        } else if (item.type === 'view_deleted' && item.id) {
          if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.removeView) {
            const before = (state.views || []).length;
            window.XHGCS_VIEWS.removeView(item.id);
            if ((state.views || []).length !== before) changed = true;
          }
        } else if (item.type === 'engine_active' && item.id) {
          activateEngine(item.id);
          changed = true;
        } else if (item.type === 'view_verify' && item.token) {
          const verify = window.XHGCS_VIEW_VERIFY;
          if (verify && typeof verify.verify === 'function') {
            const report = await verify.verify(item.code, { frames: item.frames });
            verifyReports.push({ token: item.token, at: Date.now(), report: report });
            if (verifyReports.length > 8) verifyReports.splice(0, verifyReports.length - 8);
          }
        } else if (item.type === 'run_analysis' && item.scriptId) {
          const script = state.scripts.find((s) => s.id === item.scriptId);
          if (script) {
            A.ensureOutputs(script);
            if (script.type === 'graph' && window.XHGCS_GRAPH) await window.XHGCS_GRAPH.runGraphScript(script, { persist: true });
            else await A.runAndAttach(script, script.inputs);
          }
          changed = true;
          scriptTouched = true;
        } else if (item.type && item.type.indexOf('board_') === 0) {
          // 看板类工具：只读的顺便把结果带回去（data 由桥合并进工具返回值）
          resultData = applyBoardAction(item);
          if (resultData && resultData.changed) changed = true;
        }
      } catch (err) {
        ok = false;
        error = (err && err.message) ? String(err.message) : String(err);
        console.warn('XiHe_GCS bridge queue', err);
      }
      acked.push(id);
      results.push({ id: id, ok: ok, error: error, data: resultData });
    }
    if (changed) {
      X.persist();
      if (window.XHGCS_ENGINE_UI) window.XHGCS_ENGINE_UI.renderList();
      if (window.XHGCS_ANALYSIS_UI) window.XHGCS_ANALYSIS_UI.renderScripts();
      if (window.XHGCS_GRAPH_UI && window.XHGCS_GRAPH_UI.renderComponents) window.XHGCS_GRAPH_UI.renderComponents();
      if (V.renderSwitcher) V.renderSwitcher();
      // 只有真的新增/运行了脚本数据才切到「脚本数据」，否则每轮同步都会把用户手选的页签抢回去
      if (scriptTouched) V.switchChannelTab('script');
      V.renderGaugeCards();
      V.renderThresholdRows();
    }
    return { acked: acked, results: results };
  }

  function setConnected(value) {
    state.mcp.connected = value;
    if (window.XHGCS_AI_UI) window.XHGCS_AI_UI.updateStatus();
    if (value && !wasConnected && window.XHGCS_APP) window.XHGCS_APP.toast('MCP 桥已连接');
    if (!value && wasConnected && window.XHGCS_APP) window.XHGCS_APP.toast('MCP 桥已断开');
    wasConnected = value;
  }

  async function syncNow() {
    if (!state.mcp.enabled) return;
    if (busy) return;
    busy = true;
    try {
      const remote = await request('/api/state', buildPayload());
      verifyReports.length = 0;
      setConnected(true);
      const applied = await applyRemote(remote && remote.remote);
      // 结果一起回：桥用它对上还在等的那个工具调用。只回 ids 的话，浏览器执行失败
      // 和成功在桥那边没有区别。
      if (applied && applied.acked && applied.acked.length) {
        await request('/api/ack', { ids: applied.acked, results: applied.results }).catch(() => {});
      }
    } catch (err) {
      setConnected(false);
    } finally {
      busy = false;
    }
  }

  function start() {
    state.mcp.enabled = true;
    X.persist();
    if (document.getElementById('aiBridgeToggle')) document.getElementById('aiBridgeToggle').checked = true;
    clearInterval(timer);
    syncNow();
    timer = setInterval(syncNow, 1500);
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
    state.mcp.enabled = false;
    setConnected(false);
    X.persist();
    if (document.getElementById('aiBridgeToggle')) document.getElementById('aiBridgeToggle').checked = false;
  }

  function init() {
    // 令牌与 MCP 开关无关：AI 代理和 Python 分析也走这个桥，进页面就先取一次
    X.ensureMcpToken();
    if (state.mcp.enabled) start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.XHGCS_BRIDGE = {
    start: start,
    stop: stop,
    pushNow: syncNow,
    isConnected: () => state.mcp.connected,
    // 看板队列项的执行体：MCP 工具与 core-smoke 共用同一条路径，避免测试和真实调用走两套实现
    applyBoardAction: applyBoardAction
  };
})();
