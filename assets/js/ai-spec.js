(function () {
  'use strict';
  const X = window.XHGCS;

  // ---- 产物描述符注册表 ----
  // 脚本 / 画布 / 引擎 / 组件 / 视图这五类产物的「校验、归一、确认卡片、给模型的示例与
  // 字段说明」全部收在这里。生成入口、聊天动作、确认卡片都从这一份取。
  //
  // 以前同一个产物有 3~4 份实现（生成入口一套、聊天动作一套、MCP 桥一套、浏览器合并一套），
  // 只有生成入口那套有校验，另外几套会就地编造默认值 —— 模型漏字段也能「创建成功」，
  // 产物却挂着一组不存在的通道。收口之后，判合格的只有这一个地方。
  //
  // 约定：check 只判断、fromSpec 只归一、preview 只出卡片，三者都不落库。
  // 落库仍然走 analysis / graph / views 的现有入口，由 ai.js 的 apply 路径调用。

  function specSystemPrompt(role, example, rules, extraExample) {
    return ['你把用户的一句话需求变成' + role + '。只输出一个 JSON 对象：不要解释，不要写 JSON 以外的文字，也不要使用代码块包裹。']
      .concat([example])
      .concat(extraExample ? [extraExample] : [])
      .concat(rules || [])
      .join('\n');
  }

  // ===========================================================================
  // 脚本
  // ===========================================================================

  function checkScriptSpec(spec) {
    if (!String(spec.name || '').trim()) return '缺少 name';
    const type = String(spec.type || '').toLowerCase();
    if (type !== 'functions' && type !== 'python') return 'type 必须是 functions 或 python';
    if (type === 'functions') {
      const formula = String(spec.formula || '').trim();
      if (!formula) return 'functions 类型缺少 formula';
      if (!/[a-zA-Z_]\(/.test(formula)) return 'formula 里没有任何函数调用：' + formula;
      // 中文通道名本身是合法标识符，要放行
      if (/[^\w\s+\-*/().,'一-龥]/.test(formula)) return 'formula 含不支持的字符：' + formula;
    } else if (!/def\s+analyze\s*\(/.test(String(spec.code || ''))) {
      return 'python 类型的 code 里没有 def analyze(ctx)';
    }
    const inputs = (Array.isArray(spec.inputs) ? spec.inputs : []).filter((id) => X.findChannel(id));
    if (!inputs.length) return 'inputs 里没有一个是真实存在的通道 id，请从给定清单里选';
    return '';
  }

  function scriptFromSpec(spec, prompt, options) {
    const opts = options || {};
    const type = String(spec.type).toLowerCase() === 'python' ? 'python' : 'functions';
    const inputs = Array.from(new Set(spec.inputs.filter((id) => X.findChannel(id)))).slice(0, 8);
    const first = X.findChannel(inputs[0]) || {};
    const outList = (Array.isArray(spec.outputs) && spec.outputs.length ? spec.outputs : [{}]).slice(0, 8);
    const outputs = outList.map((item, i) => ({
      // 统一用 out1/out2：resultToValues 和 updateScriptChannels 都是先按这个键找值，
      // 所以模型只要 return {"out1": ...} 就能对上，不需要知道内部生成的 id
      id: 'out' + (i + 1),
      label: String(item && item.label || opts.outputLabel || ('输出 ' + (i + 1))),
      unit: String(item && item.unit || first.unit || ''),
      color: String(item && item.color || first.color || '#38bdf8'),
      range: Array.isArray(item && item.range) && item.range.length === 2
        ? item.range.slice()
        : (Array.isArray(first.range) ? first.range.slice() : [0, 100])
    }));
    return {
      id: X.uid('script'),
      name: String(spec.name).slice(0, 40),
      type: type,
      formula: type === 'functions' ? String(spec.formula).trim() : '',
      code: type === 'python' ? String(spec.code) : '',
      inputs: inputs,
      outputs: outputs,
      builtin: false,
      description: '由 AI 生成：' + String(prompt || '').slice(0, 120)
    };
  }

  // 规格归一：预览和真正执行必须走同一套，否则会出现「卡片说没问题、点应用却失败」。
  function normalizeScriptSpec(spec) {
    return Object.assign({}, spec, {
      type: String(spec.type || (spec.code ? 'python' : 'functions')).toLowerCase()
    });
  }

  function actionOutputs(list) {
    const source = Array.isArray(list) && list.length ? list : [{ label: 'AI 输出' }];
    return source.map((item, index) => ({
      id: String(item && item.id || X.uid('out')),
      label: String(item && item.label || item && item.name || 'AI 输出' + (index + 1)).slice(0, 24) || 'AI 输出' + (index + 1),
      unit: String(item && item.unit || '').slice(0, 12),
      color: String(item && item.color || ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'][index % 5]),
      range: Array.isArray(item && item.range) ? item.range.slice(0, 2) : [0, 100]
    }));
  }

  function previewScript(spec) {
    const normalized = normalizeScriptSpec(spec);
    const title = '数据脚本「' + String(spec.name || '未命名') + '」';
    const problem = checkScriptSpec(normalized);
    if (problem) return { ok: false, title: title, error: problem };
    return {
      ok: true, title: title,
      detail: normalized.type === 'python' ? 'Python analyze(ctx)' : '公式 ' + String(normalized.formula).trim(),
      extra: '输入通道：' + normalized.inputs.join('、')
    };
  }

  const SCRIPT_SYSTEM_PROMPT = specSystemPrompt('XiHe_GCS 的一条数据分析脚本',
    '{"name":"电压均值","type":"functions","formula":"mean(ch1)","inputs":["ch1"],"outputs":[{"label":"电压均值","unit":"V"}]}',
    [
      'type 只能是 functions 或 python。',
      'functions 用 formula：可调用的函数有 mean/sum/rms/std/min/max/slope/lowpass/diff/last/first，参数是通道名；也可以用 + - * / 组合，例如 mean(ch1)*2。',
      'python 用 code：形如 def analyze(ctx): ...，用 ctx.get("通道id", []) 取该通道最近若干点，最后 return {"out1": 数值}；多路输出依次用 out1/out2/out3。',
      'inputs 必须从下面给的真实通道 id 里选，不要编造，也不要凑够三个。',
      'outputs 至少写一项，label 与 unit 按需求含义填写；unit 拿不准就留空。'
    ],
    '{"name":"电压均值","type":"python","code":"def analyze(ctx):\\n    data = ctx.get(\\"ch1\\", [])\\n    return {\\"out1\\": sum(data)/len(data) if data else 0}","inputs":["ch1"],"outputs":[{"label":"电压均值","unit":"V"}]}');

  // ===========================================================================
  // 节点画布
  // ===========================================================================

  function checkGraphSpec(spec) {
    if (!String(spec.name || '').trim()) return '缺少 name';
    if (!Array.isArray(spec.nodes) || !spec.nodes.length) return '缺少 nodes';
    const types = ['source', 'math', 'filter', 'fft', 'python', 'component', 'output'];
    const ids = new Set();
    for (const node of spec.nodes) {
      if (!node || !String(node.id || '').trim()) return '有节点缺少 id';
      if (ids.has(node.id)) return '节点 id 重复：' + node.id;
      ids.add(node.id);
      if (types.indexOf(String(node.type || '')) < 0) return '未知节点类型：' + node.type;
      if (node.type === 'source') {
        const cid = node.config && node.config.channelId;
        if (!cid || !X.findChannel(cid)) return 'source 节点的 config.channelId 不是真实通道：' + cid;
      }
    }
    if (!spec.nodes.some((node) => node.type === 'output')) return '画布至少要有一个 output 节点';
    const edges = Array.isArray(spec.edges) ? spec.edges : [];
    for (const edge of edges) {
      if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) {
        return '连线指向了不存在的节点：' + JSON.stringify(edge);
      }
    }
    return '';
  }

  function graphFromSpec(spec) {
    return {
      nodes: spec.nodes.map((node) => ({
        id: String(node.id),
        type: String(node.type),
        label: String(node.label || ''),
        x: Number(node.x) || 60,
        y: Number(node.y) || 70,
        config: Object.assign({}, node.config || {})
      })),
      edges: (Array.isArray(spec.edges) ? spec.edges : []).map((edge, i) => ({
        id: String(edge.id || ('e' + (i + 1))),
        source: String(edge.source),
        sourceHandle: String(edge.sourceHandle || 'out'),
        target: String(edge.target),
        targetHandle: String(edge.targetHandle || 'in1')
      })),
      viewport: { x: 60, y: 70, zoom: 0.95 },
      autoRun: false,
      initialized: true
    };
  }

  function previewGraph(spec, action) {
    const title = '节点画布「' + String(action.name || spec.name || '未命名') + '」';
    const problem = checkGraphSpec(spec);
    if (problem) return { ok: false, title: title, error: problem };
    return {
      ok: true, title: title,
      detail: (spec.nodes || []).length + ' 个节点 / ' + (Array.isArray(spec.edges) ? spec.edges.length : 0) + ' 条连线',
      extra: '应用后会切换画布'
    };
  }

  const GRAPH_SYSTEM_PROMPT = specSystemPrompt('XiHe_GCS 节点画布的图结构',
    '{"name":"单通道均值","description":"对指定通道求均值","nodes":[{"id":"n1","type":"source","label":"输入通道","x":60,"y":70,"config":{"channelId":"ch1"}},{"id":"n2","type":"math","label":"函数计算","x":350,"y":120,"config":{"op":"mean","inputCount":1,"formula":"mean(x1)"}},{"id":"n3","type":"output","label":"均值","x":660,"y":115,"config":{"label":"均值","unit":"","color":"#38bdf8","range":[0,100],"attach":true}}],"edges":[{"id":"e1","source":"n1","sourceHandle":"out","target":"n2","targetHandle":"in1"},{"id":"e2","source":"n2","sourceHandle":"out","target":"n3","targetHandle":"in1"}]}',
    [
      'node.type 只能是 source / math / filter / fft / python / component / output。',
      'source 的 config 是 {"channelId":"真实通道id"}；math 是 {"op":"mean|sum|rms|std|min|max|slope|add|sub|mul|div","inputCount":N,"formula":"mean(x1,x2)"}；',
      'filter 是 {"kind":"movingAverage|onePole|lowpass|highpass","windowSize":10,"sampleRate":100}；fft 是 {"windowSize":128,"windowType":"hann","sampleRate":100,"output":"freq"}；',
      'output 是 {"label":"...","unit":"","color":"#38bdf8","range":[0,100],"attach":true}。',
      '端口名是硬约定：source/math/filter/python 的出边写 sourceHandle:"out"，fft 写 "freq"/"magnitude"/"power"；入边一律 targetHandle:"in1"/"in2"…。',
      '每条 edge 的 source/target 必须是上面 nodes 里出现过的 id；通道 id 必须真实存在，不要编造。'
    ],
    '{"name":"滤波频谱","description":"通道滤波后做FFT输出频谱","nodes":[{"id":"n1","type":"source","label":"输入通道","x":60,"y":70,"config":{"channelId":"ch1"}},{"id":"n2","type":"filter","label":"低通滤波","x":320,"y":90,"config":{"kind":"lowpass","windowSize":10,"sampleRate":100}},{"id":"n3","type":"fft","label":"频谱分析","x":600,"y":110,"config":{"windowSize":128,"windowType":"hann","sampleRate":100,"output":"freq"}},{"id":"n4","type":"output","label":"频谱","x":880,"y":110,"config":{"label":"频谱","unit":"Hz","color":"#38bdf8","range":[0,100],"attach":true}}],"edges":[{"id":"e1","source":"n1","sourceHandle":"out","target":"n2","targetHandle":"in1"},{"id":"e2","source":"n2","sourceHandle":"out","target":"n3","targetHandle":"in1"},{"id":"e3","source":"n3","sourceHandle":"freq","target":"n4","targetHandle":"in1"}]}');

  // ===========================================================================
  // 数据引擎
  // ===========================================================================

  function checkEngineSpec(spec) {
    if (!String(spec.name || '').trim()) return '缺少 name';
    const P = window.XHGCS_PROTOCOL || {};
    const preset = String(spec.preset || '').toLowerCase();
    if (preset) {
      if (!(P.presetByKey && P.presetByKey(preset))) return 'preset 只能是 json/ascii/hex/wed/wedfc，实际 ' + preset;
    } else if (['JSON', 'ASCII', 'HEX', 'WED'].indexOf(String(spec.protocol || '').toUpperCase()) < 0) {
      return 'protocol 必须是 JSON / ASCII / HEX / WED，或者给出合法的 preset';
    }
    const checksum = String(spec.checksum || '').toUpperCase();
    if (checksum && ['NONE', 'CRC16', 'CRC32', 'SUM8'].indexOf(checksum) < 0) return 'checksum 不合法：' + checksum;
    const order = String(spec.byteOrder || '').toLowerCase();
    if (order && order !== 'little' && order !== 'big') return 'byteOrder 只能是 little 或 big';
    return '';
  }

  function engineConfigFromSpec(spec, prompt) {
    const P = window.XHGCS_PROTOCOL || {};
    const presetId = String(spec.preset || '').toLowerCase();
    let config = null;
    if (presetId && P.presetByKey && P.presetEngine) {
      const preset = P.presetByKey(presetId);
      if (preset) config = P.presetEngine(preset, {});
    }
    if (!config) {
      config = {
        name: 'AI 数据引擎',
        protocol: String(spec.protocol || 'ASCII').toUpperCase(),
        header: '', tail: '', terminator: '',
        checksum: 'NONE', byteOrder: 'little', hexScale: 10, payloadBytes: 0, channelCount: 0
      };
    }
    config.name = String(spec.name).slice(0, 32);
    ['header', 'tail', 'terminator'].forEach((key) => {
      if (spec[key] != null) config[key] = String(spec[key]);
    });
    if (spec.checksum) config.checksum = String(spec.checksum).toUpperCase();
    if (spec.byteOrder) config.byteOrder = String(spec.byteOrder).toLowerCase();
    if (spec.hexScale != null) config.hexScale = Math.max(0.0001, Number(spec.hexScale) || 10);
    if (spec.payloadBytes != null) config.payloadBytes = Math.max(0, Math.min(4096, Math.round(Number(spec.payloadBytes) || 0)));
    if (spec.channelCount != null) config.channelCount = Math.max(0, Math.min(256, Math.round(Number(spec.channelCount) || 0)));
    // WED 有传感器 / 飞控两个规格，预设已经带上了正确的 protocolId，别覆盖
    config.protocolId = String(config.protocol).toUpperCase() === 'WED' ? (config.protocolId || 'wed-telemetry') : '';
    config.description = String(spec.description || ('AI 生成：' + String(prompt || '').slice(0, 140)));
    return config;
  }

  function engineProbeSpec(action, spec) {
    return {
      name: action.name || spec.name,
      preset: String(action.preset || action.protocolId || action.protocol || spec.preset || spec.protocol || '').toLowerCase(),
      protocol: action.protocol || spec.protocol,
      checksum: spec.checksum,
      byteOrder: spec.byteOrder
    };
  }

  function previewEngine(spec, action) {
    const probe = engineProbeSpec(action, spec);
    const title = '数据引擎「' + String(action.name || spec.name || '未命名') + '」';
    const problem = checkEngineSpec(probe);
    if (problem) return { ok: false, title: title, error: problem };
    return {
      ok: true, title: title,
      detail: '协议 ' + String(probe.protocol || probe.preset || '').toUpperCase(),
      extra: probe.preset ? '预设 ' + probe.preset : ''
    };
  }

  const ENGINE_SYSTEM_PROMPT = specSystemPrompt('XiHe_GCS 的串口数据引擎配置',
    '{"name":"电池遥测引擎","protocol":"ASCII","header":"XH[","tail":"]","terminator":"\\r\\n","checksum":"CRC16","byteOrder":"little","hexScale":10,"payloadBytes":0,"channelCount":0}',
    [
      'protocol 只能是 JSON / ASCII / HEX / WED。',
      'preset 可选 json / ascii / hex / wed / wedfc；wed = 20 路 uint16 传感器遥测，wedfc = 飞控 20 通道姿态闭环，两者都会自动建 20 个通道，此时 header/tail 不用填。',
      'checksum 只能是 NONE / CRC16 / CRC32 / SUM8。byteOrder 只能是 little 或 big。',
      '不确定的字段省略即可，不要编造帧头帧尾。'
    ],
    '{"name":"飞控姿态闭环","protocol":"WED","preset":"wedfc","checksum":"CRC16","byteOrder":"little"}');

  // ===========================================================================
  // 可复用组件
  // ===========================================================================

  function checkComponentSpec(spec) {
    if (!String(spec.name || '').trim()) return '缺少 name';
    const kind = String(spec.kind || '').toLowerCase();
    if (kind !== 'formula' && kind !== 'python') return 'kind 必须是 formula 或 python';
    const cfg = spec.config || {};
    if (kind === 'formula') {
      const formula = String(cfg.formula || '').trim();
      if (!formula) return '缺少 config.formula';
      if (!/[a-zA-Z_]\(/.test(formula)) return 'config.formula 里没有任何函数调用：' + formula;
    } else if (!/def\s+analyze\s*\(/.test(String(cfg.code || ''))) {
      return 'config.code 里没有 def analyze(ctx)';
    }
    if (!Array.isArray(spec.inputs) || !spec.inputs.length) return '缺少 inputs';
    if (!Array.isArray(spec.outputs) || !spec.outputs.length) return '缺少 outputs';
    return '';
  }

  function componentFromSpec(spec, prompt) {
    const kind = String(spec.kind || '').toLowerCase() === 'python' ? 'python' : 'formula';
    const inputs = spec.inputs.slice(0, 6).map((item, i) => ({
      id: String(item && item.id || ('x' + (i + 1))),
      label: String(item && item.label || ('输入 ' + (i + 1)))
    }));
    const outputs = spec.outputs.slice(0, 6).map((item, i) => ({
      id: String(item && item.id || ('out' + (i + 1))),
      label: String(item && item.label || ('输出 ' + (i + 1))),
      unit: String(item && item.unit || ''),
      color: String(item && item.color || '#38bdf8'),
      range: Array.isArray(item && item.range) && item.range.length === 2 ? item.range.slice() : [0, 100]
    }));
    const parameters = (Array.isArray(spec.parameters) ? spec.parameters : []).slice(0, 6).map((item, i) => ({
      id: String(item && item.id || ('p' + (i + 1))),
      label: String(item && item.label || ('参数 ' + (i + 1))),
      type: String(item && item.type || 'number'),
      default: item && item.default != null ? item.default : 0
    }));
    const cfg = spec.config || {};
    return {
      id: X.uid('component'),
      name: String(spec.name).slice(0, 32),
      kind: kind,
      description: String(spec.description || ('AI 生成：' + String(prompt || '').slice(0, 120))).slice(0, 200),
      inputs: inputs,
      outputs: outputs,
      parameters: parameters,
      config: kind === 'python' ? { code: String(cfg.code || '') } : { formula: String(cfg.formula || '') }
    };
  }

  function previewComponent(spec) {
    const title = '计算组件「' + String(spec.name || '未命名') + '」';
    const problem = checkComponentSpec(spec);
    if (problem) return { ok: false, title: title, error: problem };
    return {
      ok: true, title: title,
      detail: String(spec.kind).toLowerCase() === 'python' ? 'Python analyze(ctx)' : '公式 ' + String((spec.config || {}).formula || '').trim(),
      extra: '输入 ' + (spec.inputs || []).map((item) => item && (item.label || item.id)).filter(Boolean).join('、')
    };
  }

  const COMPONENT_SYSTEM_PROMPT = specSystemPrompt('XiHe_GCS 的一个可复用计算组件',
    '{"name":"双通道均值","kind":"formula","description":"两路输入求均值","inputs":[{"id":"x1","label":"输入1"},{"id":"x2","label":"输入2"}],"outputs":[{"label":"均值","unit":"","range":[0,100]}],"parameters":[],"config":{"formula":"mean(x1,x2)"}}',
    [
      'kind 只能是 formula 或 python。',
      'formula 组件用 config.formula，可用函数 mean/sum/rms/std/min/max/slope/lowpass/add/sub/mul/div，输入端口按 x1/x2/x3 引用；需要可调参数时写成 p_参数名 并在 parameters 里声明。',
      'python 组件用 config.code，形如 def analyze(ctx): ...，返回 {"out1": 数值}。',
      'inputs 的 id 用 x1/x2/x3…，outputs 依次对应 out1/out2/…。'
    ],
    '{"name":"带增益的均值","kind":"formula","description":"均值乘可调增益","inputs":[{"id":"x1","label":"输入"}],"outputs":[{"label":"输出","unit":"","range":[0,100]}],"parameters":[{"id":"gain","label":"增益","type":"number","default":1}],"config":{"formula":"mean(x1)*p_gain"}}');

  // ===========================================================================
  // 可视化视图
  // ===========================================================================

  const VIEW_SYSTEM_PROMPT = [
    '你是 XiHe_GCS 可视化视图插件生成器。',
    '第一优先：用 ctx.draw.plot() 拿到受控画布槽，再用 ctx.draw.scope / ctx.draw.bars / ctx.draw.donut 出图；',
    '如果提示里带「# 构图板」，严格按其中的图形块、顺序和通道生成；没有写通道时才用全部可见通道。',
    '不要自己手写坐标轴、图例位置、量程和裁切——图面画歪（图例被裁、曲线挤成一条、画布撑破宿主）几乎都是手写坐标造成的。',
    'series 直接写通道名子串（如 "温度"）或 id 数组，多通道折线必须写 limit。',
    '颜色/字体一律取 ctx.theme() 令牌，禁止硬编码色值；禁止 fetch/setInterval/setTimeout（用 ctx.interval/ctx.frame）；',
    'ensureCanvas 返回 null 要判空 return；没有数据要写文字提示。只输出一个 JSON 对象，不要任何解释，不要用代码块包裹。'
  ].join('');

  function previewView(spec) {
    const title = '可视化视图「' + String(spec.name || '未命名') + '」';
    const code = String(spec.code || '');
    if (!code) return { ok: false, title: title, error: '缺少 code（插件表达式）' };
    const V = window.XHGCS_VIEWS;
    const lint = V && V.lintViewCode ? V.lintViewCode(code) : { errors: [], warnings: [] };
    if (lint.errors.length) return { ok: false, title: title, error: '代码不合规：' + lint.errors.join('；') };
    return {
      ok: true, title: title,
      detail: '插件代码 ' + code.length + ' 字符',
      extra: lint.warnings.length ? lint.warnings.length + ' 条画风提醒，保存时会真挂载自检' : '应用后会真挂载自检并切换过去'
    };
  }

  // ===========================================================================
  // 数据看板（内核设计器文档的窄规格）
  // ===========================================================================

  // 模型不应该直接吐完整 UiDoc（嵌套树 + 绑定表很容易写坏）。这里只让它写
  // 「控件类型 + 通道 + 少量样式」，布局、绑定 key、props 默认值由内核的
  // composeBoard 生成 —— 校验失败也能给出可照做的原因。
  const BOARD_WIDGET_TYPES = ['scope', 'gauge', 'stat', 'table', 'donut', 'bars', 'label'];

  const BOARD_SYSTEM_PROMPT = specSystemPrompt(
    'XiHe_GCS 的一块数据看板（若干控件在 12 列栅格上自动排布）',
    '{"name":"姿态看板","widgets":[{"type":"scope","title":"姿态曲线","query":"angle","points":120},{"type":"gauge","title":"横滚","channel":"ch1"},{"type":"stat","title":"高度","channel":"ch2"},{"type":"table","title":"全部通道","query":"*"}]}',
    [
      'widgets[].type 只能是 ' + BOARD_WIDGET_TYPES.join(' / ') + '。',
      '数据来源三选一：channel（单通道 id）、channels（id 数组）、query（通道名/ID 子串，* 表示全部）。gauge/stat 只画第一条序列。',
      'points 是折线取多少采样点（默认 120）；normalize=true 时按 0-1 归一化。label 是纯文本块，用 title 或 text 给正文。',
      '不要写坐标、颜色、栅格位置、宽高 —— 布局由内核自动排；控件数量 1~12。',
      '通道 id 必须来自上下文里的通道清单；不确定就先列通道。只输出一个 JSON 对象，不要代码块。'
    ],
    '{"name":"极简看板","widgets":[{"type":"stat","channel":"ch1","title":"实时值"},{"type":"scope","channels":["ch1","ch2"],"points":200,"normalize":true}]}'
  );

  function checkBoardSpec(spec) {
    if (!String(spec.name || '').trim()) return '缺少 name';
    const widgets = Array.isArray(spec.widgets) ? spec.widgets : [];
    if (!widgets.length) return '缺少 widgets（至少一个控件）';
    if (widgets.length > 12) return '控件不要超过 12 个';
    const channels = (X.allChannels ? X.allChannels() : []).map((ch) => ch.id);
    for (let i = 0; i < widgets.length; i++) {
      const item = widgets[i] || {};
      const type = String(item.type || '').toLowerCase();
      if (BOARD_WIDGET_TYPES.indexOf(type) < 0) return 'widgets[' + i + '].type 不支持：' + type;
      if (item.channel && channels.length && channels.indexOf(String(item.channel)) < 0) {
        return 'widgets[' + i + '].channel 不存在：' + item.channel;
      }
      if (Array.isArray(item.channels)) {
        const bad = item.channels.filter((id) => channels.length && channels.indexOf(String(id)) < 0);
        if (bad.length) return 'widgets[' + i + '].channels 有未知通道：' + bad.join(',');
      }
    }
    return '';
  }

  function previewBoard(spec) {
    const title = '数据看板「' + String(spec.name || '未命名') + '」';
    const problem = checkBoardSpec(spec);
    if (problem) return { ok: false, title: title, error: problem };
    const counts = {};
    (spec.widgets || []).forEach((item) => {
      const type = String((item && item.type) || '').toLowerCase();
      counts[type] = (counts[type] || 0) + 1;
    });
    const detail = (spec.widgets || []).length + ' 个控件：' +
      Object.keys(counts).map((key) => key + '×' + counts[key]).join('、');
    return { ok: true, title: title, detail: detail, extra: '应用后保存为本机看板并立即全屏运行' };
  }

  // ===========================================================================
  // 看板增量补丁
  // ===========================================================================

  // 改看板不该重新生成整块（会丢掉用户调好的布局、绑定变换与顺序，也没法只撤销改动的那一处）。
  // 这里只描述 5 种操作；真正的校验与原子应用在内核 board-patch 里。
  const BOARD_PATCH_OPS = ['add', 'remove', 'update', 'move', 'rename'];

  const BOARD_PATCH_SYSTEM_PROMPT = specSystemPrompt(
    'XiHe_GCS 看板的一组增量修改操作（patch）',
    '{"action":"board_patch","ops":[{"op":"update","id":"n123","channel":"ch2"},{"op":"add","widget":{"type":"table","query":"*"}}]}',
    [
      '先调用 get_board 拿到控件 id 与当前绑定；没有 id 不要猜。',
      'op 只能是 ' + BOARD_PATCH_OPS.join(' / ') + '。',
      'add 的 widget.type 只能是 scope/gauge/stat/table/donut/bars/label；数据用 channel/channels/query 指定。',
      'update 可改 props（只能是该控件 schema 里的字段）或 channel/channels/query；改通道会重写绑定。',
      'remove 必须给已存在的 id；move 给 grid（x/y/w/h 的任意子集）；rename 给看板名。',
      '一次最多 50 个操作；不要输出整份看板文档，不要删除根容器。'
    ],
    '{"action":"board_patch","ops":[{"op":"rename","name":"姿态总览"},{"op":"add","widget":{"type":"scope","query":"angle","points":160}},{"op":"move","id":"n456","grid":{"x":0,"y":6,"w":6,"h":4}}]}'
  );

  function checkBoardPatchSpec(spec) {
    const ops = Array.isArray(spec.ops) ? spec.ops : [];
    if (!ops.length) return '缺少 ops（至少一个操作）';
    if (ops.length > 50) return '一次最多 50 个操作';
    const channels = (X.allChannels ? X.allChannels() : []).map((ch) => ch.id);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] || {};
      const kind = String(op.op || '');
      if (BOARD_PATCH_OPS.indexOf(kind) < 0) return 'ops[' + i + '].op 不支持：' + (kind || '(空)');
      if (kind === 'add') {
        const widget = op.widget || {};
        if (BOARD_WIDGET_TYPES.indexOf(String(widget.type || '')) < 0) return 'ops[' + i + '].widget.type 不支持';
        if (widget.channel && channels.length && channels.indexOf(String(widget.channel)) < 0) {
          return 'ops[' + i + '].widget.channel 不存在：' + widget.channel;
        }
        continue;
      }
      if (kind === 'rename') {
        if (!String(op.name || '').trim()) return 'ops[' + i + '] 缺少 name';
        continue;
      }
      if (!String(op.id || '').trim()) return 'ops[' + i + '] 缺少 id';
      if (kind === 'update') {
        const channelsGiven = op.channel || (Array.isArray(op.channels) && op.channels.length) || op.query;
        const propsGiven = op.props && Object.keys(op.props).length;
        if (!channelsGiven && !propsGiven) return 'ops[' + i + '] 没有任何修改内容';
        if (op.channel && channels.length && channels.indexOf(String(op.channel)) < 0) {
          return 'ops[' + i + '].channel 不存在：' + op.channel;
        }
      }
    }
    return '';
  }

  function previewBoardPatch(spec) {
    const title = '看板增量修改';
    const problem = checkBoardPatchSpec(spec);
    if (problem) return { ok: false, title: title, error: problem };
    const counts = {};
    (spec.ops || []).forEach((op) => {
      const kind = String(op.op || '');
      counts[kind] = (counts[kind] || 0) + 1;
    });
    const detail = (spec.ops || []).length + ' 个操作：' +
      Object.keys(counts).map((key) => key + '×' + counts[key]).join('、');
    return { ok: true, title: title, detail: detail, extra: '应用后可用「回退补丁」一步还原' };
  }

  // ===========================================================================
  // 注册表
  // ===========================================================================

  const DESCRIPTORS = [
    {
      type: 'script',
      aliases: ['function', 'python'],
      label: '数据脚本',
      requiredFields: ['name', 'inputs'],
      systemPrompt: SCRIPT_SYSTEM_PROMPT,
      example: '{"action":"script","name":"均值脚本","type":"functions","formula":"mean(ch1,ch2)","inputs":["ch1","ch2"],"outputs":[{"label":"均值","unit":""}]}',
      extraExamples: ['{"action":"script","name":"FFT 频率","type":"python","code":"def analyze(ctx):\\n    import statistics as st\\n    return {\\"out1\\": st.mean(ctx.get(\\"ch1\\", []))}","inputs":["ch1"],"outputs":[{"label":"主频","unit":"Hz"}]}'],
      pick: (action) => action.script || action,
      check: checkScriptSpec,
      fromSpec: scriptFromSpec,
      preview: previewScript
    },
    {
      type: 'graph',
      aliases: ['canvas'],
      label: '节点画布',
      requiredFields: ['name', 'nodes'],
      systemPrompt: GRAPH_SYSTEM_PROMPT,
      // 画布示例必须给全 nodes/edges：只给 name+description 的话，模型永远学不会产出真正的
      // 画布结构。端口名是硬约定：source/math/filter/python 出边是 out，fft 是 freq/magnitude/power，
      // 入边一律 in1/in2…；source 的通道写在 config.channelId。
      example: '{"action":"graph","name":"单通道均值","description":"对指定通道求均值","nodes":[{"id":"n1","type":"source","label":"输入通道","x":60,"y":70,"config":{"channelId":"ch1"}},{"id":"n2","type":"math","label":"函数计算","x":350,"y":120,"config":{"op":"mean","inputCount":1,"formula":"mean(x1)"}},{"id":"n3","type":"output","label":"均值","x":660,"y":115,"config":{"label":"均值","unit":"","color":"#38bdf8","range":[0,100],"attach":true}}],"edges":[{"id":"e1","source":"n1","sourceHandle":"out","target":"n2","targetHandle":"in1"},{"id":"e2","source":"n2","sourceHandle":"out","target":"n3","targetHandle":"in1"}]}',
      pick: (action) => action.graph || action,
      check: checkGraphSpec,
      fromSpec: graphFromSpec,
      preview: previewGraph
    },
    {
      type: 'engine',
      aliases: ['protocol'],
      label: '数据引擎',
      requiredFields: ['name'],
      systemPrompt: ENGINE_SYSTEM_PROMPT,
      example: '{"action":"engine","name":"JSON 引擎","preset":"json"}',
      pick: (action) => action.engine || action.config || action,
      check: checkEngineSpec,
      fromSpec: engineConfigFromSpec,
      preview: previewEngine
    },
    {
      type: 'component',
      aliases: [],
      label: '计算组件',
      requiredFields: ['name', 'inputs', 'outputs'],
      systemPrompt: COMPONENT_SYSTEM_PROMPT,
      example: '{"action":"component","name":"双通道均值组件","kind":"formula","description":"均值计算","inputs":[{"id":"x1","label":"输入1"},{"id":"x2","label":"输入2"}],"outputs":[{"id":"out1","label":"均值","unit":"","color":"#38bdf8","range":[0,100]}],"parameters":[],"config":{"formula":"mean(x1,x2)"}}',
      pick: (action) => action.component || action,
      check: checkComponentSpec,
      fromSpec: componentFromSpec,
      preview: previewComponent
    },
    {
      type: 'view',
      aliases: ['visual', 'widget'],
      label: '可视化视图',
      requiredFields: ['name', 'code'],
      systemPrompt: VIEW_SYSTEM_PROMPT,
      // view 的 code 不能给空壳（原来写 mount(ctx){},update(ctx){}，等于教模型输出空实现）。
      // 这里给一个真能跑的最小示例；完整规范在用户确实要生成视图时随系统提示注入。
      example: '{"action":"view","name":"多通道折线","icon":"◈","desc":"三轴折线示波","code":"({id:\'scope3\',mount(ctx){ctx.plot=ctx.draw.plot();},update(ctx){ctx.draw.scope(ctx.plot.canvas,{series:\'温度\',limit:4,value:true,time:true});}})"}',
      pick: (action) => action.view || action,
      check: (spec) => (String(spec.code || '').trim() ? '' : '缺少 code（插件表达式）'),
      fromSpec: null,
      preview: previewView
    },
    {
      type: 'board',
      aliases: ['dashboard'],
      label: '数据看板',
      requiredFields: ['name', 'widgets'],
      systemPrompt: BOARD_SYSTEM_PROMPT,
      example: '{"action":"board","name":"姿态看板","widgets":[{"type":"scope","title":"姿态曲线","query":"angle","points":120},{"type":"gauge","title":"横滚","channel":"ch1"},{"type":"stat","title":"高度","channel":"ch2"},{"type":"table","title":"全部通道","query":"*"}]}',
      extraExamples: ['{"action":"board","name":"极简看板","widgets":[{"type":"stat","channel":"ch1","title":"实时值"},{"type":"scope","channels":["ch1","ch2"],"points":200,"normalize":true}]}'],
      pick: (action) => action.board || action,
      check: checkBoardSpec,
      fromSpec: null,
      preview: previewBoard
    },
    {
      type: 'board_patch',
      aliases: ['patch_board'],
      label: '看板增量修改',
      requiredFields: ['ops'],
      systemPrompt: BOARD_PATCH_SYSTEM_PROMPT,
      example: '{"action":"board_patch","ops":[{"op":"update","id":"n123","channel":"ch2"},{"op":"add","widget":{"type":"table","query":"*"}}]}',
      extraExamples: ['{"action":"board_patch","ops":[{"op":"remove","id":"n789"},{"op":"move","id":"n101","grid":{"w":6,"h":4}}]}'],
      pick: (action) => action.board_patch || action.patch || action,
      check: checkBoardPatchSpec,
      fromSpec: null,
      preview: previewBoardPatch
    }
  ];

  function get(type) {
    const key = String(type || '').toLowerCase();
    for (const d of DESCRIPTORS) {
      if (d.type === key) return d;
      if (d.aliases.indexOf(key) >= 0) return d;
    }
    return null;
  }

  function typeOf(action) {
    return String((action && action.action) || '').toLowerCase();
  }

  function gated() {
    const out = [];
    DESCRIPTORS.forEach((d) => { out.push(d.type); d.aliases.forEach((a) => out.push(a)); });
    return out;
  }

  function labels() {
    const out = {};
    DESCRIPTORS.forEach((d) => { out[d.type] = d.label; d.aliases.forEach((a) => { out[a] = d.label; }); });
    return out;
  }

  // ACTION_PROTOCOL 里那几句 few-shot 由描述符拼出来，保证和校验器同源。
  function protocolExamples() {
    const out = [];
    DESCRIPTORS.forEach((d) => {
      out.push(d.example);
      (d.extraExamples || []).forEach((line) => out.push(line));
    });
    return out;
  }

  window.XHGCS_AI_SPEC = {
    list: () => DESCRIPTORS.slice(),
    get: get,
    typeOf: typeOf,
    gated: gated(),
    labels: labels(),
    protocolExamples: protocolExamples,
    checkScriptSpec: checkScriptSpec,
    checkGraphSpec: checkGraphSpec,
    checkEngineSpec: checkEngineSpec,
    checkComponentSpec: checkComponentSpec,
    checkBoardSpec: checkBoardSpec,
    scriptFromSpec: scriptFromSpec,
    graphFromSpec: graphFromSpec,
    engineConfigFromSpec: engineConfigFromSpec,
    componentFromSpec: componentFromSpec,
    normalizeScriptSpec: normalizeScriptSpec,
    engineProbeSpec: engineProbeSpec,
    actionOutputs: actionOutputs
  };
})();
