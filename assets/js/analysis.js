(function () {
  'use strict';
  const X = window.XHGCS;
  const state = X.state;

  function flatten() {
    const out = [];
    Array.from(arguments).forEach((item) => {
      if (Array.isArray(item)) item.forEach((v) => { if (Number.isFinite(Number(v))) out.push(Number(v)); });
      else if (Number.isFinite(Number(item))) out.push(Number(item));
    });
    return out;
  }

  function mean() { const a = flatten.apply(null, arguments); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function sum() { const a = flatten.apply(null, arguments); return a.reduce((x, y) => x + y, 0); }
  function min() { const a = flatten.apply(null, arguments); return a.length ? Math.min.apply(null, a) : 0; }
  function max() { const a = flatten.apply(null, arguments); return a.length ? Math.max.apply(null, a) : 0; }
  function rms() { const a = flatten.apply(null, arguments); return a.length ? Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length) : 0; }
  function std() {
    const a = flatten.apply(null, arguments);
    if (!a.length) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
  }
  function last() { const a = flatten.apply(null, arguments); return a.length ? a[a.length - 1] : 0; }
  function first() { const a = flatten.apply(null, arguments); return a.length ? a[0] : 0; }
  function diff(arr, n) {
    const a = flatten(arr);
    const k = Number(n) || 1;
    return a.length > k ? a[a.length - 1] - a[a.length - 1 - k] : 0;
  }
  function slope(arr, n) {
    const a = flatten(arr);
    const k = Number(n) || 1;
    if (a.length <= k) return 0;
    return (a[a.length - 1] - a[a.length - 1 - k]) / k;
  }
  function lowpass(arr, n) {
    const a = flatten(arr);
    const k = Math.max(1, Number(n) || 1);
    if (!a.length) return 0;
    return a.slice(-k).reduce((x, y) => x + y, 0) / Math.min(k, a.length);
  }
  function clampVal(v, lo, hi) { return Math.max(Number(lo) || 0, Math.min(Number(hi) || 0, Number(v))); }

  function add() { const a = flatten.apply(null, arguments); return a.reduce((x, y) => x + y, 0); }
  function subtract(a, b) { const v = flatten(arguments); return (v[0] || 0) - (v[1] || 0); }
  function multiply() { const a = flatten.apply(null, arguments); return a.length ? a.reduce((x, y) => x * y, 1) : 0; }
  function divide(a, b) { const v = flatten(arguments); return (v[1] || 1) ? (v[0] || 0) / v[1] : 0; }

  const math = { mean: mean, avg: mean, sum: sum, add: add, sub: subtract, mul: multiply, div: divide, min: min, max: max, rms: rms, std: std, last: last, first: first, diff: diff, slope: slope, lowpass: lowpass, clamp: clampVal, sqrt: Math.sqrt, abs: Math.abs, log: Math.log, exp: Math.exp };

  function validateFormula(formula) {
    if (!formula || !String(formula).trim()) throw new Error('公式为空');
    const value = String(formula);
    if (/[;{}]/.test(value)) throw new Error('公式包含不允许的符号');
    return value.trim();
  }

  const RESERVED_WORDS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Date", "Map", "Set", "RegExp", "Error", "Promise", "parseInt", "parseFloat", "isNaN", "isFinite", "if", "else", "return", "new", "typeof", "in", "of", "this", "void", "delete"]);

  // 公式里既不是通道也不是数学函数的标识符：以前直接抛 "ch2 is not defined"，
  // 用户看不出是哪个通道写错了；这里先扫出来，换成一句能照着改的话。
  function unknownRefs(formula, bound) {
    const src = String(formula);
    const out = new Set();
    for (const m of src.matchAll(/[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*/g)) {
      const word = m[0];
      if (m.index > 0 && src.charAt(m.index - 1) === ".") continue;
      if (bound.indexOf(word) >= 0) continue;
      if (RESERVED_WORDS.has(word) || Object.prototype.hasOwnProperty.call(math, word)) continue;
      out.add(word);
    }
    return Array.from(out);
  }

  function formulaErrorText(formula, unknown, scope, inputs) {
    // 带减号的通道 id 写进公式会被当成减法，这种情况点名说清楚该用哪个公式名
    const dashed = X.allChannels().find((ch) => formula.indexOf(ch.id) >= 0 && ch.id !== X.formulaAlias(ch.id));
    if (dashed) return "通道「" + dashed.name + "」的 id 是 " + dashed.id + "，带减号不能直接写进公式，用它的公式名 " + X.formulaAlias(dashed.id) + "。";
    const picked = (inputs || []).map((id) => { const ch = X.findChannel(id); return ch ? X.formulaAlias(id) + "=" + ch.name : id; });
    const available = Object.keys(scope.params).slice(0, 8).map((n) => n + "=" + (scope.labels[n] || n)).join("、");
    return "公式里的「" + unknown.join("、") + "」不是通道也不是函数。" + (picked.length ? "当前勾选：" + picked.join("、") + "。" : "") + "可用：" + available + "…";
  }

  function computeFormula(formula, inputs) {
    const safe = validateFormula(formula);
    // 作用域里放的是全部通道，不再只放 inputs：公式写别的通道名也能算，
    // 单通道传感器数据只需要它自己（历史）+ 这个通道名。
    const scope = X.formulaScope();
    const names = Object.keys(scope.params);
    const unknown = unknownRefs(safe, names);
    if (unknown.length) throw new Error(formulaErrorText(safe, unknown, scope, inputs));
    const fn = new Function("__m", ...names, "with (__m) { return (" + safe + "); }");
    return fn(math, ...names.map((name) => scope.params[name]));
  }

  function resultToValues(script, result) {
    const values = {};
    const outputs = (script && script.outputs) || state.analysis.outputs || [];
    outputs.forEach((out, index) => {
      let value;
      if (result && typeof result === 'object' && !Array.isArray(result)) value = result[out.id] != null ? result[out.id] : result['out' + (index + 1)];
      else if (Array.isArray(result)) value = result[index];
      else value = result;
      values[out.id] = Array.isArray(value) ? Number(value[value.length - 1] || 0) : Number(value || 0);
      values[out.label || ('out' + (index + 1))] = values[out.id];
    });
    return values;
  }

  function runFunctionScript(script, inputs) {
    const formula = script && script.formula ? script.formula : state.analysis.formula;
    const result = computeFormula(formula, inputs || state.analysis.inputs || []);
    return resultToValues(script, result);
  }

  async function runPythonScript(script, inputs) {
    const code = script && script.code ? script.code : state.analysis.python;
    const data = X.getDataSnapshot(20);
    try {
      const response = await X.mcpFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, mode: 'python', inputs: inputs, data: data })
      });
      if (!response.ok) throw new Error('Python 桥返回 ' + response.status);
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || 'Python 执行失败');
      return resultToValues(script, payload.outputs || payload.result);
    } catch (err) {
      const expr = X.pythonOneLine(code);
      if (expr) return runFunctionScript({ formula: expr }, inputs);
      throw new Error('Python 模式需要启动 MCP 桥接服务：' + err.message);
    }
  }

  async function runScript(script, inputs) {
    const mode = script && script.type ? script.type : state.analysis.mode;
    state.analysis.lastRun = Date.now();
    state.analysis.lastError = '';
    try {
      if (mode === 'graph' && window.XHGCS_GRAPH) {
        return window.XHGCS_GRAPH.runGraphScript(script, { persist: true });
      }
      const values = mode === 'python' ? await runPythonScript(script, inputs) : runFunctionScript(script, inputs);
      X.updateScriptChannels(values, script && script.id);
      return values;
    } catch (err) {
      state.analysis.lastError = String(err.message || err);
      return null;
    }
  }

  async function runCurrent() {
    return runScript(null, state.analysis.inputs);
  }

  function ensureOutputs(script) {
    const outputs = (script && script.outputs) || state.analysis.outputs || [];
    const keep = new Set(outputs.map((out) => out.id));
    state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== script.id || keep.has(ch.outputId));
    outputs.forEach((out) => {
      const saved = state.scriptChannels.find((ch) => ch.scriptId === script.id && ch.outputId === out.id);
      if (saved) {
        saved.name = out.label || saved.name;
        saved.unit = out.unit || saved.unit;
        saved.color = out.color || saved.color;
        saved.range = Array.isArray(out.range) ? out.range.slice() : saved.range;
      } else {
        X.addScriptChannel(Object.assign({}, out, { scriptId: script.id, id: out.id }));
      }
    });
    X.persist();
  }

  async function runAndAttach(script, inputs) {
    ensureOutputs(script);
    const values = await runScript(script, inputs || state.analysis.inputs);
    if (values) X.persist();
    return values;
  }

  let lastTick = 0;
  async function tick() {
    if (!state.playing) return;
    const now = Date.now();
    if (now - lastTick < 500) return;
    lastTick = now;
    const canvas = state.analysis && state.analysis.canvas;
    if (canvas && canvas.autoRun && Array.isArray(canvas.nodes) && canvas.nodes.length && window.XHGCS_GRAPH) {
      try { await window.XHGCS_GRAPH.runGraph(canvas, { scriptId: 'graph-live', persist: false }); }
      catch (err) { state.analysis.lastError = String(err.message || err); }
    }
    const ids = new Set(state.scriptChannels.map((ch) => ch.scriptId).filter(Boolean));
    const attached = state.scripts.filter((script) => ids.has(script.id));
    for (const script of attached) {
      try {
        if (script.type === 'graph' && window.XHGCS_GRAPH) {
          // 空画布脚本没什么可算的，runGraphScript 会抛「画布为空，请添加节点」；
          // 这一段每 500ms 跑一次，不挡的话就是每秒两条的报错刷屏，
          // 而且原来这里没有 try/catch，异常会变成未处理的 Promise 拒绝
          if (!script.graph || !Array.isArray(script.graph.nodes) || !script.graph.nodes.length) continue;
          await window.XHGCS_GRAPH.runGraphScript(script, { persist: false });
        } else {
          await runScript(script, script.inputs || state.analysis.inputs);
        }
      } catch (err) {
        // 单个脚本出错不该让整轮 tick 崩掉，也不该刷屏
        state.analysis.lastError = String(err && err.message ? err.message : err);
      }
    }
  }

  const OP_LABEL_RE = /^(均值|平均|标准差|方差|最大值|最小值|总和|求和|滤波|变化率|斜率|均方根|rms|有效值)$/i;

  // 从一句话里认出通道：按通道全名和 id 匹配，被更长的那次匹配吃掉的短名不再重复计入，
  // 「横滚角速度」不会顺带把「横滚角」也算进来；脚本输出叫「均值」这类通用标签时不算点名，
  // 否则「电压均值」会把「电压」和一条叫「均值」的脚本通道一起塞进输入。
  function matchChannels(prompt) {
    const lower = String(prompt || "").toLowerCase();
    const found = [];
    X.allChannels().forEach((ch) => {
      const name = String(ch.name || "").trim();
      const isScript = Boolean(ch.scriptId);
      [name, String(ch.id || "")].forEach((probe) => {
        if (probe.length < 2 || lower.indexOf(probe.toLowerCase()) < 0) return;
        if (probe === name && OP_LABEL_RE.test(name)) return;
        found.push({ id: ch.id, probe: probe.toLowerCase(), script: isScript });
      });
    });
    found.sort((a, b) => b.probe.length - a.probe.length);
    const kept = [];
    found.forEach((item) => {
      if (kept.some((k) => k.id === item.id || k.probe.indexOf(item.probe) >= 0)) return;
      // 原始通道已经点过名，就别再让脚本输出挤进来
      if (item.script && kept.some((k) => !k.script)) return;
      kept.push(item);
    });
    return kept.map((k) => k.id);
  }

  const OP_WORDS = [
    { re: /标准差|方差/, label: "标准差", fn: "std" },
    { re: /均方根|rms|有效值/, label: "RMS", fn: "rms" },
    { re: /最大值/, label: "最大值", fn: "max" },
    { re: /最小值/, label: "最小值", fn: "min" },
    { re: /求和|总和|总功率/, label: "总和", fn: "sum" },
    { re: /低通|滤波/, label: "滤波", fn: "lowpass" },
    { re: /变化率|斜率/, label: "变化率", fn: "slope" },
    { re: /./, label: "均值", fn: "mean" }
  ];

  function createScriptFromPrompt(prompt, options) {
    const opts = options || {};
    const text = String(prompt || "");
    const source = text.toLowerCase();
    const nameText = text.replace(/^(请|帮我|直接)?\s*(生成|创建|写|做一个)?\s*(一个)?\s*/, "").split(/[，,。；;\n]/)[0].trim().slice(0, 24);
    const name = (nameText || "自定义").includes("脚本") ? nameText : (nameText || "自定义") + "脚本";
    // 输入只看对话框勾选 / 描述里点名的通道。以前不管说什么都塞 ch1,ch2,ch3 三个进去，
    // 于是单通道传感器的「均值」永远变成三个通道的均值，写 WED 通道还会直接语法报错。
    const named = Array.isArray(opts.inputs) && opts.inputs.length ? opts.inputs.filter((id) => X.findChannel(id)) : matchChannels(text);
    const fallback = (state.analysis.inputs || []).filter((id) => X.findChannel(id));
    const first = X.allChannels()[0];
    let ids = named.length ? named : (fallback.length ? fallback : (first ? [first.id] : []));
    if (!ids.length) ids = ["ch1"];
    ids = Array.from(new Set(ids));
    const primary = ids[0];
    const args = ids.map((id) => X.formulaAlias(id));
    const op = OP_WORDS.find((item) => item.re.test(source)) || OP_WORDS[OP_WORDS.length - 1];
    const chName = (id) => { const ch = X.findChannel(id); return ch ? ch.name : id; };
    const outputName = opts.outputLabel || (chName(primary) + op.label);
    const outputId = X.uid("out");
    const wantPython = opts.type ? opts.type === "python" : /python|复杂|算法|fft/.test(source);
    const tail = op.fn === "lowpass" ? ", 10" : op.fn === "slope" ? ", 5" : "";
    const formula = op.fn + "(" + args.join(",") + tail + ")";
    const chan = X.findChannel(primary) || {};
    let code = state.analysis.python;
    if (wantPython) {
      const pyOp = { std: "st.pstdev(values)", rms: "(sum(v * v for v in values) / len(values)) ** 0.5", max: "max(values)", min: "min(values)", sum: "sum(values)" }[op.fn] || "st.mean(values)";
      code = "def analyze(ctx):\n" + ids.map((id, n) => "    x" + (n + 1) + " = ctx.get(\"" + id + "\", [])").join("\n") +
        "\n    import statistics as st\n    values = " + ids.map((id, n) => "x" + (n + 1)).join(" + ") +
        "\n    return {\"" + outputId + "\": (" + pyOp + ") if values else 0}\n";
    }
    return {
      id: X.uid("script"),
      name: name,
      type: wantPython ? "python" : "functions",
      formula: formula,
      code: code,
      inputs: ids,
      outputs: [{ id: outputId, label: outputName, unit: chan.unit || "", color: chan.color || "#38bdf8", range: Array.isArray(chan.range) ? chan.range.slice() : [0, 100] }],
      builtin: false,
      description: "由 AI 生成：" + text.slice(0, 120)
    };
  }

  function saveScript(script) {
    // 以前传 falsy 会静默按关键词表造一个新脚本 —— 调用方传错变量时会悄悄多出一条。
    if (!script || typeof script !== 'object') throw new Error('saveScript 需要一个脚本对象');
    state.scripts.push(script);
    X.persist();
    return script;
  }

  function deleteScript(id) {
    state.scripts = state.scripts.filter((script) => script.id !== id);
    state.scriptChannels = state.scriptChannels.filter((ch) => ch.scriptId !== id);
    if (!state.mcp.deletedScripts.includes(id)) state.mcp.deletedScripts.push(id);
    X.persist();
  }

  window.XHGCS_ANALYSIS = {
    math: math,
    computeFormula: computeFormula,
    runFunctionScript: runFunctionScript,
    runPythonScript: runPythonScript,
    runScript: runScript,
    runCurrent: runCurrent,
    runAndAttach: runAndAttach,
    ensureOutputs: ensureOutputs,
    createScriptFromPrompt: createScriptFromPrompt,
    matchChannels: matchChannels,
    saveScript: saveScript,
    deleteScript: deleteScript,
    // 「按 id 找脚本」原来在 bridge.js 和本文件里各内联了一份 .find()；
    // 收成一个入口，别再抄第三份
    findScript: function (id) {
      return state.scripts.find(function (s) { return s && s.id === id; }) || null;
    },
    resultToValues: resultToValues,
    tick: tick
  };
})();
