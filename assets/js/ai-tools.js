(function () {
  'use strict';
  const X = window.XHGCS;
  const state = X.state;

  // ---- 应用内只读工具 ----
  // 模型以前只拿到一段静态上下文就必须回答，想按名字找通道、看历史脚本、确认画布结构
  // 都做不到。这里给应用内 AI 装上「能自己查」的手：工具循环里只有只读工具。
  //
  // 写操作（创建脚本/引擎/组件/画布/视图）故意**不**放进来：它们仍然走文本动作协议 +
  // 确认卡片，模型不能借工具循环绕过「先预览、点应用才落库」那道门。

  // 结果裁剪：超过 12000 字符只留「头 8000 + 标记 + 尾 2000」。头尾都留是刻意的：
  // 模型常先看结尾的统计/错误，只留头会把它要的信息裁掉；标记里写清怎么拿完整内容。
  const MAX_RESULT_CHARS = 12000;
  const CLIP_HEAD_CHARS = 8000;
  const CLIP_TAIL_CHARS = 2000;
  // 单个工具的执行上限：只读工具都是本地快操作，15s 还没回来说明卡死/异常，
  // 必须回灌明确错误，不能让工具循环挂在这里。
  const TOOL_TIMEOUT_MS = 15000;

  function toolTimeoutMs() {
    const custom = Number(state.ai && state.ai.toolTimeoutMs);
    return Number.isFinite(custom) && custom >= 50 ? Math.min(60000, custom) : TOOL_TIMEOUT_MS;
  }

  // 统计量：模型要「最近这段数据的趋势」时不用自己算，也避免它从 JSON 里数错。
  function seriesStats(values) {
    const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number);
    if (!nums.length) return { min: null, max: null, mean: null, rms: null, slope: null, delta: null };
    const min = Math.min.apply(null, nums);
    const max = Math.max.apply(null, nums);
    const mean = nums.reduce((sum, v) => sum + v, 0) / nums.length;
    const rms = Math.sqrt(nums.reduce((sum, v) => sum + v * v, 0) / nums.length);
    const delta = nums[nums.length - 1] - nums[0];
    const slope = nums.length > 1 ? delta / (nums.length - 1) : 0;
    return { min: min, max: max, mean: mean, rms: rms, slope: slope, delta: delta };
  }

  function resolveToolChannel(key) {
    const text = String(key || '').trim();
    if (!text) return null;
    const all = X.allChannels ? X.allChannels() : [];
    return all.find((ch) => ch && String(ch.id) === text) || all.find((ch) => ch && String(ch.name) === text) || null;
  }

  function channelHistoryOf(args) {
    const opts = args || {};
    const key = String(opts.channel || opts.id || opts.name || '').trim();
    if (!key) return { ok: false, error: '缺少 channel：请给通道 id 或名字（先用 list_channels 查）' };
    const ch = resolveToolChannel(key);
    if (!ch) return { ok: false, error: '找不到通道：' + key + '（先用 list_channels 查真实 id）' };
    const requested = Math.max(1, Math.min(500, Number(opts.points) || 100));
    const data = Array.isArray(ch.data) ? ch.data.map(Number).filter((v) => Number.isFinite(v)) : [];
    const series = data.slice(-requested);
    return {
      ok: true,
      channel: {
        id: ch.id,
        name: ch.name || '',
        unit: ch.unit || '',
        kind: ch.scriptId ? 'script' : 'raw',
        points: data.length
      },
      points: series.length,
      requestedPoints: requested,
      series: series,
      stats: seriesStats(series)
    };
  }

  function compactChannel(ch) {
    return {
      id: ch.id,
      name: ch.name || '',
      unit: ch.unit || '',
      value: ch.value == null ? null : Number(ch.value),
      range: Array.isArray(ch.range) ? ch.range.slice(0, 2) : null,
      warnLow: ch.warnLow == null ? null : Number(ch.warnLow),
      warnHigh: ch.warnHigh == null ? null : Number(ch.warnHigh),
      points: Number(ch.points) || 0
    };
  }

  function snapshotOf(args) {
    const opts = args || {};
    const count = Math.max(0, Math.min(20, Number(opts.limit) || 1));
    const snap = X.getDataSnapshot(count);
    const canvas = (state.analysis && state.analysis.canvas) || { nodes: [], edges: [] };
    const out = {
      t: snap.t,
      playing: snap.playing,
      channels: (snap.raw || []).map(compactChannel),
      scriptChannels: (snap.script || []).map(compactChannel),
      serial: snap.serial,
      recording: snap.recording,
      alarms: snap.alarms,
      // 日志默认不塞：snapshot 是最常被调用的工具，整段串口日志很容易把上下文吃光。
      // 需要看日志时显式传 include_logs=true（limit 控制条数）。
      logs: opts.include_logs ? (snap.logs || []) : [],
      engines: snap.engines,
      scripts: (snap.scripts || []).map((s) => ({ id: s.id, name: s.name, type: s.type, outputs: (s.outputs || []).length })),
      components: snap.components,
      analysis: {
        lastRun: snap.analysis.lastRun,
        lastError: snap.analysis.lastError,
        nodes: (canvas.nodes || []).length,
        edges: (canvas.edges || []).length,
        autoRun: Boolean(canvas.autoRun)
      }
    };
    if (opts.include_series) out.series = snap.series;
    return out;
  }

  function listChannels(args) {
    const opts = args || {};
    const kind = String(opts.kind || 'all').toLowerCase();
    const includeSeries = Boolean(opts.include_series);
    const rows = [];
    const push = (ch, source) => {
      if (!ch || !ch.id) return;
      const row = {
        id: ch.id,
        name: ch.name || '',
        unit: ch.unit || '',
        kind: source,
        value: ch.data && ch.data.length ? Number(ch.data[ch.data.length - 1]) : null,
        points: ch.data ? ch.data.length : 0,
        range: Array.isArray(ch.range) ? ch.range.slice(0, 2) : null,
        warnLow: ch.warnLow == null ? null : Number(ch.warnLow),
        warnHigh: ch.warnHigh == null ? null : Number(ch.warnHigh)
      };
      if (ch.scriptId) row.scriptId = ch.scriptId;
      if (includeSeries && ch.data) row.series = ch.data.slice(-100).map(Number);
      rows.push(row);
    };
    if (kind !== 'script') (state.channels || []).forEach((ch) => push(ch, 'raw'));
    if (kind !== 'raw') (state.scriptChannels || []).forEach((ch) => push(ch, 'script'));
    return { count: rows.length, channels: rows };
  }

  function listScripts() {
    return {
      count: (state.scripts || []).length,
      scripts: (state.scripts || []).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        inputs: s.inputs || [],
        outputs: (s.outputs || []).map((o) => ({ id: o.id, label: o.label, unit: o.unit || '' })),
        description: s.description || ''
      }))
    };
  }

  function listEngines() {
    const numOrNull = (value) => (value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
    return {
      count: (state.engines || []).length,
      activeEngine: state.activeEngine || '',
      engines: (state.engines || []).map((e) => ({
        id: e.id,
        name: e.name,
        protocol: e.protocol,
        protocolId: e.protocolId || '',
        checksum: e.checksum || 'NONE',
        byteOrder: e.byteOrder || 'little',
        hexScale: numOrNull(e.hexScale),
        payloadBytes: numOrNull(e.payloadBytes),
        channelCount: numOrNull(e.channelCount),
        active: Boolean(e.active)
      }))
    };
  }

  function listComponents() {
    return {
      count: (state.components || []).length,
      components: (state.components || []).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        description: c.description || '',
        inputs: (c.inputs || []).length,
        outputs: (c.outputs || []).length,
        parameters: (c.parameters || []).length,
        builtin: Boolean(c.builtin)
      }))
    };
  }

  function listViews() {
    return {
      count: (state.views || []).length,
      views: (state.views || []).map((v) => ({ id: v.id, name: v.name, icon: v.icon || '', desc: v.desc || v.description || '' }))
    };
  }

  function getCanvas(args) {
    const canvas = (state.analysis && state.analysis.canvas) || { nodes: [], edges: [] };
    if (args && args.full) return { canvas: canvas };
    return {
      nodeCount: (canvas.nodes || []).length,
      edgeCount: (canvas.edges || []).length,
      autoRun: Boolean(canvas.autoRun),
      nodes: (canvas.nodes || []).map((n) => ({ id: n.id, type: n.type, label: n.label || '' })),
      edges: (canvas.edges || []).map((e) => e.source + '→' + e.target)
    };
  }

  const TOOLS = [
    {
      name: 'snapshot',
      description: '读取当前数据链快照：通道最新值与阈值、串口状态与实测速率、录制状态、告警、最近日志、引擎与脚本摘要。回答「现在是什么情况」之前先调它。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '日志条数，默认 1，最大 20（需同时 include_logs=true）' },
          include_logs: { type: 'boolean', description: '是否附带串口日志，默认 false' },
          include_series: { type: 'boolean', description: '是否附带每个通道最近 100 点序列，默认 false' }
        }
      },
      run: snapshotOf
    },
    {
      name: 'channel_history',
      description: '读取指定通道最近的真实历史序列与统计量（min/max/mean/rms/slope/delta）。channel 支持 id 或名字；points 默认 100、最大 500。要引用真实数值回答或看最近趋势时先调它。',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: '通道 id 或名字（可用 list_channels 查）' },
          points: { type: 'number', description: '最近点数，默认 100，最大 500' }
        },
        required: ['channel']
      },
      run: channelHistoryOf
    },
    {
      name: 'list_channels',
      description: '列出全部通道（原始 + 脚本），含 id、名称、单位、量程、报警阈值（null 表示未设）与样本数。要按名字找通道 id 时先调它。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['all', 'raw', 'script'], description: '默认 all' },
          include_series: { type: 'boolean', description: '是否附带最近 100 点序列，默认 false' }
        }
      },
      run: listChannels
    },
    {
      name: 'list_scripts',
      description: '列出现有数据脚本（含内置与自定义），带输入通道与输出端口。要修改或复用已有脚本时先看它。',
      parameters: { type: 'object', properties: {} },
      run: listScripts
    },
    {
      name: 'list_engines',
      description: '列出数据引擎（串口协议配置）与当前生效的那个。',
      parameters: { type: 'object', properties: {} },
      run: listEngines
    },
    {
      name: 'list_components',
      description: '列出可复用计算组件（公式与 Python）。',
      parameters: { type: 'object', properties: {} },
      run: listComponents
    },
    {
      name: 'list_views',
      description: '列出自定义可视化视图插件（内置波形/柱状/数据表/仪表/地图不在其中）。',
      parameters: { type: 'object', properties: {} },
      run: listViews
    },
    {
      name: 'get_canvas',
      description: '读取当前分析画布的节点与连线摘要；full=true 时返回完整画布。',
      parameters: { type: 'object', properties: { full: { type: 'boolean' } } },
      run: getCanvas
    },
    {
      name: 'list_extensions',
      description: '列出已安装的扩展（插件）及其状态、版本、贡献点数量与失败原因。排查“为什么某个按钮/视图没出现”时先看它。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '只看某个扩展 id' } } },
      run: listExtensions
    },
    {
      name: 'pipeline_metrics',
      description: '读取常驻数据引擎的实时指标：已处理帧、积压、丢弃、错误、平均耗时、启用的阶段与端点。',
      parameters: { type: 'object', properties: {} },
      run: pipelineMetrics
    },
    {
      name: 'list_boards',
      description: '列出本机所有看板（设计器文档）及当前活动看板，含 id、名称、控件数与更新时间。要改看板前先看它。',
      parameters: { type: 'object', properties: {} },
      run: listBoardsTool
    },
    {
      name: 'get_board',
      description: '读取某块看板的完整结构（控件 id、类型、栅格、绑定）。修改看板前必须先调用它拿准 id。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '看板 id；省略则读当前活动看板' } }
      },
      run: getBoardTool
    }
  ];

  function coreOf() {
    return window.XHGCS_CORE || null;
  }

  function listExtensions(args) {
    const core = coreOf();
    if (!core || !core.host) return { ok: false, error: '插件内核未加载：assets/js/core.bundle.js 没有引入' };
    const only = args && args.id ? String(args.id) : '';
    const rows = core.host
      .list()
      .filter((record) => !only || record.manifest.id === only)
      .map((record) => {
        const contributes = record.manifest.contributes || {};
        return {
          id: record.manifest.id,
          name: record.manifest.name,
          version: record.manifest.version,
          status: record.status,
          message: record.message || '',
          activatedBy: record.activatedBy || '',
          commands: (contributes.commands || []).map((item) => item.id),
          views: (contributes.views || []).map((item) => item.id),
          statusBar: (contributes.statusBar || []).map((item) => item.id)
        };
      });
    return {
      count: rows.length,
      contributions: core.registry && core.registry.stats ? core.registry.stats() : {},
      extensions: rows
    };
  }

  function pipelineMetrics() {
    const core = coreOf();
    if (!core || !core.engine || !core.engine.pipeline) return { ok: false, error: '数据引擎未启动' };
    const pipeline = core.engine.pipeline;
    const metrics = pipeline.metrics();
    return {
      metrics: metrics,
      recentErrors: pipeline.recentErrorList(),
      stages: pipeline.operatorList().map((operator) => ({
        id: operator.id,
        label: operator.label,
        enabled: pipeline.isOperatorEnabled(operator.id)
      })),
      sinks: pipeline.sinkList().map((sink) => ({ id: sink.id, label: sink.label }))
    };
  }

  function listBoardsTool() {
    const core = coreOf();
    if (!core || !core.boards) return { ok: false, error: '插件内核未加载，看板库不可用' };
    const boards = core.boards.list();
    return {
      active: core.boards.active(),
      count: boards.length,
      boards: boards.map((board) => ({ id: board.id, name: board.name, updatedAt: board.updatedAt, active: board.active }))
    };
  }

  function getBoardTool(args) {
    const core = coreOf();
    if (!core || !core.boards) return { ok: false, error: '插件内核未加载，看板库不可用' };
    const id = args && args.id ? String(args.id) : core.boards.activeId();
    const doc = core.boards.get(id);
    if (!doc) return { ok: false, error: '看板不存在：' + id };
    const widgets = (doc.root.children || []).map((node) => ({
      id: node.id,
      type: node.type,
      title: node.props && (node.props.title || node.props.text) || '',
      grid: node.grid,
      bind: (node.bind || []).map((key) => doc.bindings[key]).filter(Boolean)
    }));
    return {
      id: doc.id,
      name: doc.name,
      cols: doc.cols,
      updatedAt: doc.updatedAt,
      widgets: widgets,
      hint: '改看板请返回 {"action":"board_patch","ops":[...]}，只允许 add/remove/update/move/rename；不要重发整份文档'
    };
  }

  function definitions() {
    return TOOLS.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } }
    }));
  }

  // 头 8000 + 标记 + 尾 2000：只留头会把结尾的统计/错误裁掉，只留尾会丢字段说明。
  function clip(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text == null) return '';
    if (text.length <= MAX_RESULT_CHARS) return text;
    const marker = '\n…（结果过长已裁剪：仅保留头 ' + CLIP_HEAD_CHARS + ' 字符 + 尾 ' + CLIP_TAIL_CHARS
      + ' 字符；可用更小的 limit / points 重试以获取更聚焦的结果）…\n';
    return text.slice(0, CLIP_HEAD_CHARS) + marker + text.slice(-CLIP_TAIL_CHARS);
  }

  function byteLength(text) {
    try {
      return new TextEncoder().encode(String(text || '')).length;
    } catch (err) {
      return String(text || '').length;
    }
  }

  // 单个工具的执行上限。同步快操作也会走同一个 race：Promise.resolve().then 让同步工具
  // 在微任务里先完成，慢/挂死的实现（未来引入异步工具）由 timer 兜底。
  function runWithTimeout(fn, timeoutMs) {
    const limit = Math.max(50, Number(timeoutMs) || toolTimeoutMs());
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, limit);
      Promise.resolve()
        .then(() => fn())
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ value: value });
        }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ error: err });
        });
    });
  }

  // 模型发来的 arguments 是 JSON 字符串；解析失败要把错误如实回灌，让它自己改，
  // 而不是静默当成空参数执行。
  function parseArgs(raw) {
    if (raw == null || raw === '') return {};
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      throw new Error('工具参数不是合法 JSON：' + String(raw).slice(0, 200));
    }
  }

  // 返回 { id, name, ok, content, ms, bytes }：content 是回灌给模型的 role:'tool' 文本，
  // ms/bytes 会记进 meta.tools —— 工具循环以前完全不可观测，慢/大的调用只能靠猜。
  async function execute(toolCall) {
    const call = toolCall || {};
    const name = String((call.function && call.function.name) || call.name || '');
    const id = String(call.id || '');
    const startedAt = Date.now();
    const tool = TOOLS.filter((item) => item.name === name)[0];
    if (!tool) {
      const content = JSON.stringify({ ok: false, error: '未知工具：' + name, hint: '可用工具：' + names().join('、') });
      return { id: id, name: name, ok: false, content: content, ms: Date.now() - startedAt, bytes: byteLength(content) };
    }
    let args;
    try {
      args = parseArgs(call.function && call.function.arguments);
    } catch (err) {
      const content = JSON.stringify({ ok: false, error: String((err && err.message) || err) });
      return { id: id, name: name, ok: false, content: content, ms: Date.now() - startedAt, bytes: byteLength(content) };
    }
    const outcome = await runWithTimeout(() => tool.run(args), toolTimeoutMs());
    let ok = true;
    let content = '';
    if (outcome.timedOut) {
      ok = false;
      content = JSON.stringify({
        ok: false,
        error: '工具执行超时（' + Math.round(toolTimeoutMs() / 1000) + 's）：' + name + '；可用更小的 points / limit 重试'
      });
    } else if (outcome.error) {
      ok = false;
      content = JSON.stringify({ ok: false, error: String((outcome.error && outcome.error.message) || outcome.error) });
    } else {
      content = clip(outcome.value);
    }
    return { id: id, name: name, ok: ok, content: content, ms: Date.now() - startedAt, bytes: byteLength(content) };
  }

  function names() {
    return TOOLS.map((tool) => tool.name);
  }

  // 用户可以在设置里关掉工具循环：小模型被工具定义分心时，退回纯文本对话。
  if (typeof state.ai.tools !== 'boolean') state.ai.tools = true;

  window.XHGCS_AI_TOOLS = {
    definitions: definitions,
    execute: execute,
    names: names,
    enabled: () => state.ai.tools !== false,
    // 暴露超时执行器：单测能直接验证「挂死的工具 15s 内一定返回 timedOut」，
    // 未来加异步工具也沿用同一实现，不用再写第二份。
    runWithTimeout: runWithTimeout
  };
})();
