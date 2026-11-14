(function () {
  'use strict';
  const X = window.XHGCS;
  const A = window.XHGCS_ANALYSIS;
  const state = X.state;

  function canvas() {
    if (!state.analysis.canvas) {
      state.analysis.canvas = { nodes: [], edges: [], viewport: { x: 70, y: 70, zoom: 1 }, autoRun: false, initialized: false };
    }
    if (!Array.isArray(state.analysis.canvas.nodes)) state.analysis.canvas.nodes = [];
    if (!Array.isArray(state.analysis.canvas.edges)) state.analysis.canvas.edges = [];
    if (!state.analysis.canvas.viewport) state.analysis.canvas.viewport = { x: 70, y: 70, zoom: 1 };
    return state.analysis.canvas;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const NODE_DEFAULTS = {
    source: { channelId: 'ch1', label: '输入通道' },
    math: { op: 'mean', inputCount: 2, formula: 'mean(x1,x2)', label: '函数计算' },
    filter: { kind: 'movingAverage', windowSize: 10, sampleRate: 100, label: '滤波器' },
    fft: { windowSize: 128, windowType: 'hann', sampleRate: 100, output: 'freq', label: '频谱分析' },
    python: { code: 'def analyze(ctx):\n    x1 = ctx.get("x1", [])\n    x2 = ctx.get("x2", [])\n    vals = list(x1) + list(x2)\n    return {"out": mean(vals)}', inputCount: 2, label: 'Python 脚本' },
    component: { componentId: '', componentSnapshot: null, parameters: {}, label: '可复用组件' },
    output: { label: '分析输出', unit: '', color: '#34d399', range: [0, 100], attach: true }
  };

  function componentDef(node) {
    const cfg = node && node.config || {};
    if (cfg.componentId && X.getComponent) {
      const found = X.getComponent(cfg.componentId);
      if (found) return found;
    }
    return cfg.componentSnapshot && cfg.componentSnapshot.id ? cfg.componentSnapshot : null;
  }

  function componentParameters(node) {
    const def = componentDef(node);
    const params = {};
    (def && def.parameters || []).forEach((item) => { params[item.id] = item.default; });
    return Object.assign(params, (node && node.config && node.config.parameters) || {});
  }

  function componentSnapshotFor(node) {
    const def = componentDef(node);
    return def ? clone(def) : (node && node.config && node.config.componentSnapshot) || null;
  }

  function normalizeConfig(type, config) {
    if (type === 'component') {
      const cfg = Object.assign({}, NODE_DEFAULTS.component, config || {});
      const def = componentDef({ config: cfg });
      const parameters = componentParameters({ config: cfg });
      return Object.assign(cfg, {
        componentId: String(cfg.componentId || ''),
        componentSnapshot: cfg.componentSnapshot || (def ? clone(def) : null),
        parameters: parameters,
        missing: !def && !cfg.componentSnapshot
      });
    }
    return Object.assign({}, NODE_DEFAULTS[type] || {}, config || {});
  }

  function syncPorts(node) {
    const type = node.type || 'math';
    if (type === 'component') {
      const def = componentDef(node);
      node.inputs = def && Array.isArray(def.inputs) && def.inputs.length ? clone(def.inputs) : [{ id: 'in1', label: '输入 1' }];
      node.outputs = def && Array.isArray(def.outputs) && def.outputs.length ? clone(def.outputs) : [{ id: 'out', label: '数据', color: '#38bdf8' }];
      return;
    }
    const inputCount = ['math', 'python'].includes(type) ? Math.max(1, Math.min(6, Number(node.config && node.config.inputCount) || 1)) : type === 'source' ? 0 : 1;
    const outputs = type === 'source' ? [{ id: 'out', label: '数据' }] : type === 'fft' ? [{ id: 'freq', label: '主频' }, { id: 'magnitude', label: '幅值' }, { id: 'power', label: '功率' }] : type === 'output' ? [] : [{ id: 'out', label: '数据' }];
    node.inputs = Array.from({ length: inputCount }, (_, i) => ({ id: 'in' + (i + 1), label: '输入' + (i + 1) }));
    node.outputs = outputs;
  }

  // 节点标题是创建时从组件定义抄下来的：定义曾经被打成 U+FFFD 时这里也跟着坏，而
  // syncPorts() 只重算端口、不重算标题，坏标题会一直挂在节点上。定义干净了就按定义改回。
  function healNodeLabel(node) {
    if (!node || !node.label || String(node.label).indexOf('\uFFFD') < 0) return;
    const def = componentDef(node);
    const fallback = (NODE_DEFAULTS[node.type] || {}).label;
    if (def && def.name && def.name.indexOf('\uFFFD') < 0) node.label = def.name;
    else if (fallback) node.label = fallback;
  }

  function makeNode(type, position, config) {
    const id = X.uid('gn');
    const node = {
      id: id,
      type: type,
      label: type === 'source' ? '输入通道' : type === 'component' && config && config.name ? config.name : (NODE_DEFAULTS[type] && NODE_DEFAULTS[type].label) || type,
      x: Number((position && position.x) || 80),
      y: Number((position && position.y) || 80),
      config: normalizeConfig(type, Object.assign({}, config || {}, { id: id }))
    };
    syncPorts(node);
    return node;
  }

  function ensureCanvas(graphArg) {
    const c = graphArg || canvas();
    c.nodes.forEach((node) => {
      node.config = node.config || {};
      node.config = normalizeConfig(node.type, node.config);
      node.config.id = node.id;
      syncPorts(node);
      healNodeLabel(node);
    });
    c.edges = c.edges.filter((edge) => {
      const src = c.nodes.find((n) => n.id === edge.source);
      const dst = c.nodes.find((n) => n.id === edge.target);
      if (!src || !dst) return false;
      const sourceHandle = src.outputs && src.outputs.find((p) => p.id === edge.sourceHandle);
      const targetHandle = dst.inputs && dst.inputs.find((p) => p.id === edge.targetHandle);
      if (!sourceHandle || !targetHandle) return false;
      edge.id = edge.id || X.uid('ge');
      return true;
    });
    // 视口是对象而不是数组；此处曾经误用 Array.isArray 导致每次渲染都把画布重置回原点
    if (!c.viewport || typeof c.viewport !== 'object' || Array.isArray(c.viewport)) {
      c.viewport = { x: 70, y: 70, zoom: 1 };
    } else {
      c.viewport.x = Number(c.viewport.x) || 0;
      c.viewport.y = Number(c.viewport.y) || 0;
      c.viewport.zoom = Number(c.viewport.zoom) > 0 ? Number(c.viewport.zoom) : 1;
    }
    return c;
  }

  function setCanvas(graph) {
    const c = canvas();
    c.nodes = graph && Array.isArray(graph.nodes) ? clone(graph.nodes) : [];
    c.edges = graph && Array.isArray(graph.edges) ? clone(graph.edges) : [];
    if (graph && graph.viewport) c.viewport = clone(graph.viewport);
    c.autoRun = graph ? Boolean(graph.autoRun) : false;
    c.initialized = true;
    ensureCanvas();
    X.persist();
    return c;
  }

  function findNode(id) { return canvas().nodes.find((node) => node.id === id) || null; }
  function findEdge(id) { return canvas().edges.find((edge) => edge.id === id) || null; }

  function inputIds(graphArg) {
    const g = graphArg || canvas();
    return g.nodes.filter((node) => node.type === 'source').map((node) => node.config.channelId).filter(Boolean);
  }
  function outputConfigs(graphArg) {
    const g = graphArg || canvas();
    return g.nodes.filter((node) => node.type === 'output' && node.config.attach !== false).map((node) => ({
      id: node.id,
      label: node.config.label || '分析输出',
      unit: node.config.unit || '',
      color: node.config.color || '#34d399',
      range: Array.isArray(node.config.range) ? [Number(node.config.range[0]) || 0, Number(node.config.range[1]) || 100] : [0, 100]
    }));
  }

  function graphToScript(graph, name) {
    const g = graph || canvas();
    return {
      id: X.uid('script'),
      name: name || '节点画布模块',
      type: 'graph',
      formula: '',
      code: '',
      inputs: inputIds(g),
      outputs: outputConfigs(g),
      graph: clone(g),
      componentSnapshots: (g.nodes || []).filter((node) => node.type === 'component').map(componentSnapshotFor).filter(Boolean),
      builtin: false,
      origin: 'canvas',
      description: '由节点画布生成，包含 ' + (g.nodes || []).length + ' 个节点 / ' + (g.edges || []).length + ' 条连线'
    };
  }

  function toScript(name) { return graphToScript(canvas(), name); }

  function seriesOf(value) {
    if (Array.isArray(value)) return value.map(Number);
    if (value && typeof value === 'object' && Array.isArray(value.series)) return value.series.map(Number);
    if (value && typeof value === 'object' && Number.isFinite(Number(value.value))) return [Number(value.value)];
    return Number.isFinite(Number(value)) ? [Number(value)] : [];
  }
  function scalarOf(value) {
    const s = seriesOf(value);
    return s.length ? s[s.length - 1] : 0;
  }

  function componentValueMap(raw, def) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    const map = {};
    (def && def.outputs || [{ id: 'out1', label: '输出' }]).forEach((port, index) => {
      let value;
      if (source) value = source[port.id] != null ? source[port.id] : source['out' + (index + 1)] != null ? source['out' + (index + 1)] : source.out;
      else if (Array.isArray(raw)) value = raw[index];
      else value = raw;
      const series = seriesOf(value);
      map[port.id] = { value: scalarOf(value), series: series.length ? series : [scalarOf(value)] };
    });
    const first = def && def.outputs && def.outputs[0] || { id: 'out1' };
    map.out = map[first.id] || map.out1 || { value: 0, series: [0] };
    return map;
  }

  function evaluateFormula(expr, vars) {
    const safe = String(expr || '').trim();
    if (!safe) throw new Error('表达式为空');
    if (/[;{}]/.test(safe)) throw new Error('表达式包含不允许的符号');
    const names = Object.keys(vars);
    const fn = new Function('__m', ...names, 'with (__m) { return (' + safe + '); }');
    return fn(A.math, ...names.map((name) => vars[name]));
  }

  function reduceSeries(vals) {
    const out = [];
    vals.forEach((v) => seriesOf(v).forEach((n) => out.push(n)));
    return out;
  }

  function computeMath(node, inputs) {
    const cfg = node.config || {};
    const op = String(cfg.op || 'mean');
    const seriesList = inputs.map(seriesOf);
    const scalars = inputs.map(scalarOf);
    const all = reduceSeries(seriesList);
    let value = 0;
    if (op === 'mean' || op === 'avg') value = A.math.mean.apply(null, seriesList);
    else if (op === 'sum') value = A.math.sum.apply(null, seriesList);
    else if (op === 'min') value = A.math.min.apply(null, seriesList);
    else if (op === 'max') value = A.math.max.apply(null, seriesList);
    else if (op === 'rms') value = A.math.rms.apply(null, seriesList);
    else if (op === 'std') value = A.math.std.apply(null, seriesList);
    else if (op === 'last') value = A.math.last.apply(null, seriesList);
    else if (op === 'abs') value = Math.abs(scalars[0] || 0);
    else if (op === 'sqrt') value = Math.sqrt(Math.max(0, scalars[0] || 0));
    else if (op === 'log') value = Math.log(Math.max(1e-9, scalars[0] || 1));
    else if (op === 'add') value = scalars.reduce((a, b) => a + b, 0);
    else if (op === 'sub') value = (scalars[0] || 0) - (scalars[1] || 0);
    else if (op === 'mul') value = scalars.reduce((a, b) => a * b, 1);
    else if (op === 'div') value = (scalars[0] || 0) / (scalars[1] || 1);
    else if (op === 'slope' || op === 'diff') value = Math.abs(cfg.windowSize || 1) > 1 ? A.math.slope(all, cfg.windowSize || 1) : A.math.diff(all, 1);
    else if (op === 'lowpass') value = A.math.lowpass(all, cfg.windowSize || 10);
    else if (op === 'custom') {
      const vars = { x1: seriesList[0] || [], x2: seriesList[1] || [], x3: seriesList[2] || [], v1: scalars[0] || 0, v2: scalars[1] || 0, v3: scalars[2] || 0 };
      value = scalarOf(evaluateFormula(cfg.formula, vars));
    } else value = scalarOf(A.math[op] ? A.math[op].apply(null, seriesList) : 0);
    return { value: Number(value) || 0, series: [Number(value) || 0] };
  }

  function computeFilter(node, inputs) {
    const cfg = node.config || {};
    const kind = String(cfg.kind || 'movingAverage');
    const series = seriesOf(inputs[0]);
    const window = Math.max(1, Number(cfg.windowSize) || 10);
    let out = series.slice(-window);
    let value = 0;
    if (kind === 'movingAverage') {
      value = out.length ? out.reduce((a, b) => a + b, 0) / out.length : 0;
    } else if (kind === 'median') {
      const sorted = out.slice().sort((a, b) => a - b);
      value = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    } else if (kind === 'onePole' || kind === 'lowpass') {
      const alpha = 2 / (window + 1);
      value = series.length ? series.reduce((acc, v) => acc + alpha * (v - acc), series[0]) : 0;
    } else if (kind === 'highpass') {
      const alpha = 2 / (window + 1);
      let y = series.length ? series[0] : 0;
      const low = series.reduce((acc, v) => { y = acc + alpha * (v - acc); return y; }, series[0] || 0);
      value = (series.length ? series[series.length - 1] : 0) - low;
    } else if (kind === 'derivative') {
      value = series.length > window ? series[series.length - 1] - series[series.length - 1 - window] : (series.length > 1 ? series[series.length - 1] - series[0] : 0);
    } else if (kind === 'rms') {
      value = out.length ? Math.sqrt(out.reduce((sum, v) => sum + v * v, 0) / out.length) : 0;
    } else value = scalarOf(inputs[0]);
    const input = inputs[0];
    return { value: Number(value) || 0, series: out,
      times: input && input.times ? input.times.slice(-out.length) : null,
      valid: input && input.valid ? input.valid.slice(-out.length) : null };
  }

  function applyWindow(data, type) {
    const n = data.length;
    const out = data.slice();
    for (let i = 0; i < n; i++) {
      const x = i / Math.max(1, n - 1);
      if (type === 'hann') out[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
      else if (type === 'hamming') out[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * x);
      else if (type === 'blackman') out[i] *= 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
    }
    return out;
  }

  function fft(re) {
    const n = re.length;
    const im = new Array(n).fill(0);
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j |= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    return { re, im };
  }

  function spectrum(series, cfg) {
    const size = Math.max(16, Math.min(1024, Number(cfg.windowSize) || 128));
    const sampleRate = Math.max(1, Number(cfg.sampleRate) || 100);
    const data = series.slice(-size);
    const padded = new Array(size).fill(0);
    data.forEach((v, i) => padded[i] = Number(v) || 0);
    const real = applyWindow(padded, cfg.windowType || 'hann');
    const out = fft(real);
    const bins = [];
    const half = Math.floor(size / 2);
    let total = 0;
    for (let k = 0; k <= half; k++) {
      const re = out.re[k], im = out.im[k];
      const mag = Math.sqrt(re * re + im * im) / size;
      const power = (re * re + im * im) / (size * size);
      bins.push({ freq: k * sampleRate / size, magnitude: mag, power: power });
      if (k > 0) total += power;
    }
    const dominant = bins.slice(1).sort((a, b) => b.magnitude - a.magnitude)[0] || { freq: 0, magnitude: 0 };
    return { dominant, total };
  }

  function computeFft(node, inputs) {
    const cfg = node.config || {};
    const input = inputs[0];
    let data = seriesOf(input);
    // radix-2 FFT 必须用 2 的幂，不能直接对任意窗口长度执行蝶形运算。
    const requested = Math.max(16, Math.min(1024, Number(cfg.windowSize) || 128));
    const size = Math.pow(2, Math.floor(Math.log2(requested)));
    data = data.slice(-size);
    const times = input && Array.isArray(input.times) ? input.times.slice(-size) : null;
    const valid = input && Array.isArray(input.valid) ? input.valid.slice(-size) : null;
    const notes = [];
    let sampleRate = Number(cfg.sampleRate) || 100;
    let resampled = false;
    if (times && times.length === data.length && times.every(Number.isFinite)) {
      if (data.length < 16) throw new Error('频谱至少需要 16 个带时间戳的有效样本');
      if (valid && valid.some(v => v === false)) throw new Error('频谱窗口包含缺失/保持值，请选择连续有效数据');
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      if (gaps.some(g => g <= 0)) throw new Error('频谱时间戳必须严格递增，请排除重复或时钟回退');
      const sorted = gaps.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (gaps.some(g => g > median * 5)) throw new Error('频谱窗口包含断流，请选择连续数据，不能跨断流插值');
      const step = (times[times.length - 1] - times[0]) / (times.length - 1);
      sampleRate = 1 / step;
      resampled = gaps.some(g => Math.abs(g - step) > step * .01);
      if (resampled) {
        // 仅在连续窗口内线性重采样，不跨缺帧、长断流或设备复位。
        let j = 1;
        data = data.map((_, i) => {
          const t = times[0] + i * step;
          while (j < times.length - 1 && times[j] < t) j++;
          const f = (t - times[j - 1]) / (times[j] - times[j - 1]);
          return data[j - 1] + f * (data[j] - data[j - 1]);
        });
      }
      notes.push('频谱采样率 ' + sampleRate.toFixed(3) + ' Hz（真实时间戳' + (resampled ? '，已线性重采样' : '') + '）');
    } else {
      notes.push('频谱输入无完整时间戳，使用配置采样率 ' + sampleRate + ' Hz；请核对实际采样率');
    }
    const s = spectrum(data, Object.assign({}, cfg, { windowSize: size, sampleRate: sampleRate }));
    const mode = String(cfg.output || 'freq');
    let value = mode === 'magnitude' ? s.dominant.magnitude : mode === 'power' ? s.total : mode === 'db' ? 20 * Math.log10(Math.max(1e-9, s.dominant.magnitude)) : s.dominant.freq;
    return {
      freq: { value: s.dominant.freq, series: [s.dominant.freq] },
      magnitude: { value: s.dominant.magnitude, series: [s.dominant.magnitude] },
      power: { value: s.total, series: [s.total] },
      out: { value: value, series: [value] },
      value: value,
      timing: { sampleRate: sampleRate, resampled: resampled, samples: data.length },
      notes: notes
    };
  }

  async function computePython(node, inputs) {
    const cfg = node.config || {};
    const code = cfg.code || NODE_DEFAULTS.python.code;
    const vars = {};
    inputs.forEach((value, index) => { vars['x' + (index + 1)] = seriesOf(value); });
    const parameters = componentParameters(node);
    const data = { series: vars, inputs: Object.keys(vars), parameters: parameters, mode: 'graph-python' };
    try {
      const response = await X.mcpFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, mode: 'python', inputs: Object.keys(vars), data: data })
      });
      if (!response.ok) throw new Error('桥接返回 ' + response.status);
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || 'Python 执行失败');
      const result = payload.outputs || payload.result;
      const first = result && typeof result === 'object' && !Array.isArray(result) ? Object.values(result)[0] : result;
      const raw = result && typeof result === 'object' ? result : result;
      return { value: scalarOf(first), series: seriesOf(first), raw: raw };
    } catch (err) {
      const expr = X.pythonOneLine(code);
      if (expr) {
        const value = scalarOf(evaluateFormula(expr, vars));
        return { value: value, series: [value], raw: value };
      }
      throw new Error('Python 节点需要启动 MCP 桥：' + (err.message || err));
    }
  }

  function componentFormulaVars(node, inputs) {
    const vars = {};
    inputs.forEach((value, index) => {
      vars['x' + (index + 1)] = seriesOf(value);
      vars['v' + (index + 1)] = scalarOf(value);
    });
    const parameters = componentParameters(node);
    Object.keys(parameters).forEach((key) => {
      vars['p_' + key] = parameters[key];
      if (/^[A-Za-z_$][\w$]*$/.test(key)) vars[key] = parameters[key];
    });
    return vars;
  }

  function computeComponentFormula(node, inputs) {
    const def = componentDef(node);
    if (!def) throw new Error('组件不存在：' + (node.config && node.config.componentId || node.label));
    const cfg = def.config || {};
    const vars = componentFormulaVars(node, inputs);
    const map = {};
    const formulas = cfg.formulas && typeof cfg.formulas === 'object' ? cfg.formulas : {};
    const outputs = Array.isArray(def.outputs) && def.outputs.length ? def.outputs : [{ id: 'out1', label: '输出' }];
    outputs.forEach((port, index) => {
      const expr = String(formulas[port.id] || (Array.isArray(cfg.formulasArr) ? cfg.formulasArr[index] : '') || (index === 0 ? cfg.formula : '') || '').trim();
      if (!expr) {
        map[port.id] = { value: 0, series: [0] };
        return;
      }
      const value = evaluateFormula(expr, vars);
      const series = seriesOf(value);
      map[port.id] = { value: scalarOf(value), series: series.length ? series : [scalarOf(value)] };
    });
    const first = outputs[0] || { id: 'out1' };
    map.out = map[first.id] || map.out1 || { value: 0, series: [0] };
    return map;
  }

  async function computeComponentPython(node, inputs) {
    const def = componentDef(node);
    if (!def) throw new Error('组件不存在：' + (node.config && node.config.componentId || node.label));
    const result = await computePython(node, inputs);
    return componentValueMap(result.raw, def);
  }

  function componentsFromScript(script) {
    const graph = script && script.graph;
    if (!graph) return [];
    return (graph.nodes || []).filter((node) => node.type === 'component').map((node) => {
      if (node.config && node.config.componentSnapshot) return node.config.componentSnapshot;
      return X.getComponent && X.getComponent(node.config && node.config.componentId) || null;
    }).filter(Boolean);
  }

  function resolveScriptComponents(script) {
    if (!script || !script.graph) return;
    const snapshots = Array.isArray(script.componentSnapshots) ? script.componentSnapshots : [];
    (script.graph.nodes || []).forEach((node) => {
      if (!node || node.type !== 'component' || !node.config) return;
      const current = X.getComponent && X.getComponent(node.config.componentId);
      node.config.componentSnapshot = node.config.componentSnapshot || snapshots.find((item) => item && item.id === node.config.componentId) || current || null;
      node.config.missing = !node.config.componentSnapshot;
    });
  }

  function topo(nodes, edges) {
    const byId = {};
    nodes.forEach((node) => byId[node.id] = node);
    const indegree = {};
    nodes.forEach((node) => indegree[node.id] = 0);
    const adj = {};
    nodes.forEach((node) => adj[node.id] = []);
    edges.forEach((edge) => {
      if (!byId[edge.source] || !byId[edge.target]) return;
      adj[edge.source].push(edge.target);
      indegree[edge.target]++;
    });
    const queue = nodes.filter((node) => indegree[node.id] === 0).map((node) => node.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      (adj[id] || []).forEach((next) => {
        indegree[next]--;
        if (indegree[next] === 0) queue.push(next);
      });
    }
    if (order.length !== nodes.length) throw new Error('画布存在循环依赖，请检查连线');
    return order.map((id) => byId[id]);
  }

  function canConnect(sourceId, sourceHandle, targetId, targetHandle) {
    const source = findNode(sourceId);
    const target = findNode(targetId);
    if (!source || !target || source.id === target.id) return { ok: false, reason: '节点或连线无效' };
    if (source.type === 'output' || target.type === 'source') return { ok: false, reason: '输出节点不能再作为输入' };
    const sourcePort = source.outputs.find((p) => p.id === sourceHandle);
    const targetPort = target.inputs.find((p) => p.id === targetHandle);
    if (!sourcePort || !targetPort) return { ok: false, reason: '端口不存在' };
    if (canvas().edges.some((edge) => edge.source === sourceId && edge.sourceHandle === sourceHandle && edge.target === targetId && edge.targetHandle === targetHandle)) return { ok: false, reason: '连线已存在' };
    if (canvas().edges.some((edge) => edge.target === targetId && edge.targetHandle === targetHandle)) return { ok: false, reason: '该输入端口已有连线' };
    const reached = new Set();
    const walk = (id) => {
      canvas().edges.filter((e) => e.source === id).forEach((edge) => { if (!reached.has(edge.target)) { reached.add(edge.target); walk(edge.target); } });
    };
    walk(targetId);
    if (reached.has(sourceId)) return { ok: false, reason: '会形成循环依赖' };
    return { ok: true };
  }

  function connect(sourceId, sourceHandle, targetId, targetHandle) {
    const check = canConnect(sourceId, sourceHandle, targetId, targetHandle);
    if (!check.ok) throw new Error(check.reason);
    const edge = { id: X.uid('ge'), source: sourceId, sourceHandle: sourceHandle || 'out', target: targetId, targetHandle: targetHandle || 'in1' };
    canvas().edges.push(edge);
    X.persist();
    return edge;
  }

  function ensureOutputChannels(scriptId, outputs) {
    const keep = new Set(outputs.map((out) => out.id));
    state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== scriptId || keep.has(ch.outputId));
    outputs.forEach((out) => {
      const saved = state.scriptChannels.find((ch) => ch.scriptId === scriptId && ch.outputId === out.id);
      if (saved) {
        saved.name = out.label || saved.name;
        saved.unit = out.unit || saved.unit;
        saved.color = out.color || saved.color;
        saved.range = Array.isArray(out.range) ? out.range.slice() : saved.range;
      } else {
        X.addScriptChannel(Object.assign({}, out, { scriptId: scriptId, id: out.id }));
      }
    });
  }

  function outputNodes(graph) {
    return (graph && graph.nodes ? graph.nodes : canvas().nodes).filter((node) => node.type === 'output' && node.config.attach !== false);
  }

  async function runGraph(graphArg, options) {
    const g = ensureCanvas(graphArg || canvas());
    const opts = options || {};
    const scriptId = opts.scriptId || 'graph-live';
    const nodes = g.nodes;
    if (!nodes.length) throw new Error('画布为空，请添加节点');
    const orders = topo(nodes, g.edges);
    const computed = {};
    const include = new Set(nodes.map((n) => n.id));
    for (const node of orders) {
      const inputs = (node.inputs || []).map((port) => {
        const edge = (g.edges || []).find((e) => e.target === node.id && e.targetHandle === port.id);
        if (!edge || !include.has(edge.source)) return [];
        const src = computed[edge.source] || {};
        return src[edge.sourceHandle] || src.out || 0;
      });
      let result;
      // 插件算子优先：注册表里认领了这个 node.type 就先执行；没命中才走内置分支
      const engineCore = window.XHGCS_CORE && window.XHGCS_CORE.engine;
      const customOperator = engineCore && engineCore.operators
        ? await engineCore.operators.run(node, {
            inputs: inputs,
            windowPoints: Math.max(16, Math.min(200000, Number(state.analysis.windowPoints) || 2000)),
            findChannel: X.findChannel,
            state: state
          })
        : null;
      if (customOperator) result = customOperator;
      else if (node.type === 'source') {
        const ch = X.findChannel(node.config.channelId);
        // 只取分析窗口内的点数，避免长历史（小时级）每次运行都复制整段数组
        const windowPoints = Math.max(16, Math.min(200000, Number(state.analysis.windowPoints) || 2000));
        const series = ch && ch.data ? ch.data.slice(-windowPoints).map(Number) : [];
        const value = series.length ? series[series.length - 1] : 0;
        const timeline = ch && X.sampleTimeline(ch);
        result = { out: { value: value, series: series,
          times: timeline ? timeline.times.slice(-windowPoints) : null,
          valid: timeline ? timeline.valid.slice(-windowPoints) : null }, value: value };
      } else if (node.type === 'math') result = { out: computeMath(node, inputs), value: 0 };
      else if (node.type === 'filter') result = { out: computeFilter(node, inputs), value: 0 };
      else if (node.type === 'fft') result = computeFft(node, inputs);
      else if (node.type === 'python') result = { out: await computePython(node, inputs), value: 0 };
      else if (node.type === 'component') {
        const def = componentDef(node);
        if (!def) throw new Error('组件不存在：' + (node.config && node.config.componentId || node.label));
        result = def.kind === 'python' ? await computeComponentPython(node, inputs) : computeComponentFormula(node, inputs);
      }
      else if (node.type === 'output') {
        const first = inputs[0];
        result = { out: { value: scalarOf(first), series: seriesOf(first) }, value: scalarOf(first), input: first };
      } else result = { out: { value: 0, series: [] } };
      if (node.type !== 'output') {
        const main = result.out || result.freq || result;
        result.value = main.value != null ? main.value : scalarOf(main);
      }
      computed[node.id] = result;
    }
    const outputs = outputNodes(g);
    const values = {};
    outputs.forEach((node) => {
      const result = computed[node.id];
      values[node.id] = result ? result.value : 0;
      if (node.config.label) values[node.config.label] = values[node.id];
    });
    if (outputs.length && opts.attach !== false) ensureOutputChannels(scriptId, outputConfigs(g));
    X.updateScriptChannels(values, scriptId);
    state.analysis.lastRun = Date.now();
    state.analysis.lastError = '';
    if (opts.persist !== false) X.persist();
    const notes = orders.reduce((all, n) => all.concat(computed[n.id].notes || []), []);
    notes.forEach(note => X.pushLog('sys', note));
    return { values: values, order: orders.map((n) => n.id), nodes: nodes.length, edges: g.edges.length, notes: notes,
      timing: orders.filter(n => computed[n.id].timing).map(n => Object.assign({ nodeId: n.id }, computed[n.id].timing)) };
  }

  async function runGraphScript(script, options) {
    if (!script || !script.graph) throw new Error('脚本没有画布数据');
    resolveScriptComponents(script);
    const opts = options || {};
    const outputs = outputNodes(script.graph);
    script.outputs = outputs.map((node) => ({ id: node.id, label: node.config.label || '分析输出', unit: node.config.unit || '', color: node.config.color || '#34d399', range: Array.isArray(node.config.range) ? node.config.range : [0, 100] }));
    script.inputs = script.graph.nodes.filter((node) => node.type === 'source').map((node) => node.config.channelId).filter(Boolean);
    const result = await runGraph(script.graph, Object.assign({}, opts, { scriptId: script.id, attach: true }));
    if (opts.persist !== false) X.persist();
    return result;
  }

  function sampleCanvas() {
    const c = canvas();
    if (c.initialized && c.nodes.length) return c;
    // 示例必须挂在真实存在的通道上。写死 ch1/ch2 在 WED 飞控规格下（通道是 wed-fc-01…）
    // 会挂到不存在的通道，节点卡片直接显示「未选择」，示例反而成了反例。
    const all = X.allChannels();
    const ids = all.slice(0, 2).map((ch) => ch.id);
    if (!ids.length) ids.push('ch1');
    const sources = ids.map((id, i) => makeNode('source', { x: 70, y: 90 + i * 132 }, { channelId: id }));
    const math = makeNode('math', { x: 330, y: 110 }, {
      op: 'mean',
      inputCount: sources.length,
      formula: sources.length > 1 ? 'mean(x1,x2)' : 'mean(x1)'
    });
    const first = all[0] || {};
    const out = makeNode('output', { x: 610, y: 105 }, {
      label: (first.name || '通道') + '均值',
      unit: first.unit || '',
      color: '#34d399',
      range: Array.isArray(first.range) ? first.range.slice() : [0, 100],
      attach: true
    });
    c.nodes = sources.concat([math, out]);
    c.edges = sources.map((node, i) => ({
      id: X.uid('ge'), source: node.id, sourceHandle: 'out', target: math.id, targetHandle: 'in' + (i + 1)
    })).concat([{ id: X.uid('ge'), source: math.id, sourceHandle: 'out', target: out.id, targetHandle: 'in1' }]);
    c.autoRun = false;
    c.initialized = true;
    X.persist();
    return c;
  }

  // 流程的输入通道按「描述里点名 → 调用方勾选 → 分析页勾选 → 前几个真实通道」取。
  // 以前这里写死 电压→ch1 / 电流→ch2…，换成 WED 20 通道规格后，生成的流程会挂在一堆
  // 根本不存在的 ch1/ch2 上，跑了等于没跑。
  function promptSourceIds(prompt, options) {
    const picked = (options && Array.isArray(options.inputs) ? options.inputs : []).filter((id) => X.findChannel(id));
    const named = A.matchChannels ? A.matchChannels(prompt) : [];
    const fromState = (state.analysis.inputs || []).filter((id) => X.findChannel(id));
    const list = named.length ? named : (picked.length ? picked : fromState);
    return (list.length ? list : X.allChannels().map((ch) => ch.id)).slice(0, 6);
  }

  function graphFromPrompt(prompt, options) {
    const text = String(prompt || '').toLowerCase();
    const sourceIds = promptSourceIds(prompt, options);
    const nodes = sourceIds.map((id, i) => makeNode('source', { x: 60, y: 70 + i * 105 }, { channelId: id }));
    let mathType = 'math';
    let mathConfig = { op: 'mean', inputCount: sourceIds.length, formula: 'mean(' + sourceIds.map((_, i) => 'x' + (i + 1)).join(',') + ')' };
    if (/fft|频谱/.test(text)) { mathType = 'fft'; mathConfig = { windowSize: 128, windowType: 'hann', sampleRate: 100, output: 'freq' }; }
    else if (/滤波|低通|平滑/.test(text)) { mathType = 'filter'; mathConfig = { kind: 'movingAverage', windowSize: 10, sampleRate: 100 }; }
    else if (/标准差|方差/.test(text)) mathConfig.op = 'std';
    else if (/rms|均方根|有效值/.test(text)) mathConfig.op = 'rms';
    else if (/变化率|斜率/.test(text)) mathConfig.op = 'slope';
    else if (/最大值/.test(text)) mathConfig.op = 'max';
    else if (/最小值/.test(text)) mathConfig.op = 'min';
    else if (/求和|总和/.test(text)) mathConfig.op = 'sum';
    const mathNode = makeNode(mathType, { x: 350, y: 120 }, mathConfig);
    const outputLabel = (/fft|频谱/.test(text) ? '主频' : /滤波|低通/.test(text) ? '滤波输出' : /rms/.test(text) ? 'RMS' : /标准差/.test(text) ? '标准差' : /变化率/.test(text) ? '变化率' : /最大值/.test(text) ? '最大值' : /最小值/.test(text) ? '最小值' : /求和/.test(text) ? '总和' : '均值');
    const outputNode = makeNode('output', { x: 660, y: 115 }, { label: outputLabel, unit: '', color: '#38bdf8', range: [0, 100], attach: true });
    const edges = [];
    nodes.forEach((node, i) => edges.push({ id: X.uid('ge'), source: node.id, sourceHandle: 'out', target: mathNode.id, targetHandle: 'in' + (i + 1) }));
    if (mathType === 'fft') edges.push({ id: X.uid('ge'), source: mathNode.id, sourceHandle: 'freq', target: outputNode.id, targetHandle: 'in1' });
    else edges.push({ id: X.uid('ge'), source: mathNode.id, sourceHandle: 'out', target: outputNode.id, targetHandle: 'in1' });
    const graph = { nodes: nodes.concat([mathNode, outputNode]), edges: edges, viewport: { x: 60, y: 70, zoom: 0.95 }, autoRun: false, initialized: true };
    return graph;
  }

  async function createScriptFromPrompt(prompt, options) {
    const graph = graphFromPrompt(prompt, options);
    const script = graphToScript(graph, (String(prompt || 'AI 节点画布').replace(/^(请|帮我|直接)?\s*(生成|创建|写|做一个)?\s*(一个)?\s*/, '') || 'AI 节点画布').split(/[，,。；;\n]/)[0].slice(0, 24) + '画布');
    script.origin = 'ai';
    script.description = 'AI 生成节点画布：' + String(prompt || '').slice(0, 120);
    A.saveScript(script);
    A.ensureOutputs(script);
    await runGraphScript(script, { persist: true });
    return script;
  }

  window.XHGCS_GRAPH = {
    canvas: canvas,
    ensureCanvas: ensureCanvas,
    setCanvas: setCanvas,
    makeNode: makeNode,
    sampleCanvas: sampleCanvas,
    topo: topo,
    canConnect: canConnect,
    connect: connect,
    runGraph: runGraph,
    runGraphScript: runGraphScript,
    graphToScript: graphToScript,
    toScript: toScript,
    componentDef: componentDef,
    componentsFromScript: componentsFromScript,
    resolveScriptComponents: resolveScriptComponents,
    outputConfigs: outputConfigs,
    inputIds: inputIds,
    graphFromPrompt: graphFromPrompt,
    createScriptFromPrompt: createScriptFromPrompt,
    findNode: findNode,
    findEdge: findEdge,
    clone: clone,
    ensureOutputChannels: ensureOutputChannels,
    spectrum: spectrum,
    fft: fft
  };
})();
