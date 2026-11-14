(function () {
  'use strict';
  const X = window.XHGCS;
  const A = window.XHGCS_ANALYSIS;
  const SPEC = window.XHGCS_AI_SPEC;
  const state = X.state;

  // 最近一轮工具调用的轨迹：[{name, ok, ms, bytes}]。空态返回 []，读取绝不抛异常 ——
  // 界面/排障面板可以直接展示，不用各自解析消息 meta。
  let lastToolTrace = [];

  function toolTrace() {
    try {
      return lastToolTrace.map((item) => Object.assign({}, item));
    } catch (err) {
      return [];
    }
  }

  // ---- 生成质量轻量统计 ----
  // 只存内存环形缓冲（不写 localStorage、不做任何远程上报）：界面/控制台可以看最近
  // N 次生成与对话的成功率、失败 kind 分布、平均耗时，帮用户判断「是模型不行还是配置错了」。
  const QUALITY_RING_LIMIT = 100;
  const qualityRing = [];

  function recordQuality(type, name, ok, kind, ms) {
    try {
      qualityRing.push({
        at: Date.now(),
        type: String(type || 'ai'),
        name: String(name || '').slice(0, 80),
        ok: Boolean(ok),
        kind: String(kind || ''),
        ms: Math.max(0, Math.round(Number(ms) || 0))
      });
      while (qualityRing.length > QUALITY_RING_LIMIT) qualityRing.shift();
    } catch (err) { /* 统计失败不影响主流程 */ }
  }

  // 最近 N 条结果摘要；默认 20，最多 100；空态 []。
  function lastN(n) {
    try {
      const count = Math.max(1, Math.min(QUALITY_RING_LIMIT, Number(n) || 20));
      return qualityRing.slice(-count).map((item) => Object.assign({}, item));
    } catch (err) {
      return [];
    }
  }

  function qualityStats() {
    try {
      const total = qualityRing.length;
      const failedRows = qualityRing.filter((item) => !item.ok);
      const failureKinds = {};
      failedRows.forEach((item) => {
        const kind = item.kind || 'unknown';
        failureKinds[kind] = (failureKinds[kind] || 0) + 1;
      });
      const avgMs = total ? Math.round(qualityRing.reduce((sum, item) => sum + item.ms, 0) / total) : 0;
      return {
        total: total,
        ok: total - failedRows.length,
        failed: failedRows.length,
        successRate: total ? Number(((total - failedRows.length) / total).toFixed(3)) : 0,
        failureKinds: failureKinds,
        avgMs: avgMs
      };
    } catch (err) {
      return { total: 0, ok: 0, failed: 0, successRate: 0, failureKinds: {}, avgMs: 0 };
    }
  }

  // ---- 错误诊断 ----
  // 聊天与生成入口以前只抛一句原始报错（ECONNREFUSED / HTTP 403 / …），界面和任务面板
  // 都分不清「改 Key」还是「起桥」。这里把错误压成统一结构，所有消费方只认 kind。
  // 纯函数、不碰网络与状态，便于按打桩端点逐类回归。
  const DIAGNOSE_RULES = [
    ['aborted', '已停止生成', '已手动停止本次生成，可以重新发起。', false,
      (c) => c.aborted],
    ['truncated', '输出被截断', '回复达到 Max Tokens 上限被截断：到「设置 → AI 对话」调大 Max Tokens 后重试。', false,
      (c) => c.truncated],
    ['not_configured', '未配置 AI 后端', '到「设置 → AI 对话」选择 DSH Agent，或填写 API Endpoint 与模型名；本地桥没起时先启动桥。', false,
      (c) => /没有配置 ai 后端|未配置 ai 后端|请先.*配置 api|请先填写 endpoint|dsh 不可用|未找到 @deepseek-ai\/dsh|缺少 endpoint|需要启动 mcp 桥接服务/.test(c.text)],
    ['auth', '鉴权失败', '检查 API Key 是否正确、是否过期，以及 Endpoint 是否要求鉴权。', false,
      (c) => c.status === 401 || c.status === 403 || /invalid api key|incorrect api key|unauthorized|authentication|鉴权|令牌无效/.test(c.text)],
    ['quota', '额度不足', '账户额度或余额不足：检查用量与余额，或换一个可用 Key。', false,
      (c) => c.status === 402 || /insufficient_quota|quota|额度|欠费|余额不足/.test(c.text)],
    ['rate_limit', '请求过于频繁', '触发限流：稍等几秒再试，并降低并发或请求频率。', true,
      (c) => c.status === 429 || /rate[ _-]?limit|too many requests|限流|请求过于频繁/.test(c.text)],
    ['model_not_found', '模型不存在', '模型名或路径不对：在设置里刷新模型列表并重新选择，或检查 Endpoint。', false,
      (c) => c.status === 404 || /model[_ -]?not[_ -]?found|模型不存在|模型未找到|no such model/.test(c.text)],
    ['context_length', '上下文超长', '上下文超过模型上限：减少历史轮数或调小上下文帧数后重试。', false,
      (c) => /context_length_exceeded|maximum context length|context length|too many tokens|上下文.{0,6}(超|长)/.test(c.text)],
    ['timeout', '生成超时', '模型输出超时：检查网络与服务状态，服务端慢时稍后重试。', true,
      (c) => /超时|timeout|timed out|etimedout/.test(c.text)],
    ['network', '网络连接失败', '检查本地桥是否在运行、Endpoint 是否可达、网络是否正常。', true,
      (c) => /fetch failed|failed to fetch|econnrefused|econnreset|enotfound|eai_again|network|无法连接|连接被拒绝|connection refused/.test(c.text)],
    ['validation', '产物校验失败', '模型给出的结果没通过校验：换个说法重试，或把需求拆小。', true,
      (c) => /试运行失败|不合格|不合规|两次都没给出|没有解析|没有返回可用的/.test(c.text)],
    ['empty_response', '模型返回空内容', '模型返回了空内容：检查模型是否支持关闭思考、换一个模型，或重试。', true,
      (c) => Boolean(c.err.emptyResponse) || /空内容|没有返回任何内容|模型没有返回内容|empty response|只返回了思考/.test(c.text)],
    ['upstream', '上游服务异常', '模型服务端返回错误：稍后重试；持续失败时检查 Endpoint 与服务状态。', true,
      (c) => c.status >= 500 || c.status === 400 || c.status === 422 || /upstream|bad gateway|服务端错误|服务器内部|internal server/.test(c.text)]
  ];

  function diagnoseError(input) {
    const err = input && typeof input === 'object' ? input : {};
    if (err.info && err.info.kind) return err.info;
    const message = String((err && err.message) || (typeof input === 'string' ? input : '') || '');
    const body = String(err.detail || err.body || err.responseText || '');
    const text = (message + ' ' + body).toLowerCase();
    let status = Number(err.status || err.statusCode || 0) || 0;
    if (!status) {
      const hit = message.match(/http\s*(\d{3})/i);
      status = hit ? Number(hit[1]) : 0;
    }
    const finish = String(err.finish || '');
    const ctx = {
      text: text,
      status: status,
      err: err,
      aborted: Boolean(err.aborted) || String(err.name || '') === 'AbortError' || /已停止生成|aborted/.test(text),
      // finish_reason=length 是「被截断」而不是失败：UI 要提示调大 Max Tokens
      truncated: finish === 'length' || Boolean(err.truncated) || /max tokens|被截断|truncated/.test(text)
    };
    const hit = DIAGNOSE_RULES.find((rule) => rule[4](ctx))
      || ['unknown', '未知错误', '展开详情查看原始信息；反复出现请反馈。', false];
    return {
      kind: hit[0],
      title: hit[1],
      hint: hit[2],
      retryable: Boolean(hit[3]),
      status: status,
      detail: (message + (body && body !== message ? ' · ' + body : '')).slice(0, 600)
    };
  }

  // 幂等补诊断信息：错误对象只要带过 err.info，后续调用方直接读 kind。
  function attachErrorInfo(err) {
    if (err && typeof err === 'object' && !err.info) err.info = diagnoseError(err);
    return err;
  }

  // ---- 对外事件 ----
  // 界面/插件订阅这两个事件就能显示运行态与错误，不必再读气泡 DOM 或解析中文文案。
  function emitAiBusy(busy, phase, task) {
    try {
      window.dispatchEvent(new CustomEvent('xhgcs:ai-busy', {
        detail: { busy: Boolean(busy), phase: phase || 'chat', task: task ? String(task).slice(0, 80) : '' }
      }));
    } catch (err) { /* 订阅方异常不该影响 AI 主流程 */ }
  }

  function emitAiError(info) {
    if (!info || !info.kind) return;
    try {
      window.dispatchEvent(new CustomEvent('xhgcs:ai-error', {
        detail: {
          kind: info.kind, title: info.title || '', hint: info.hint || '',
          raw: String(info.detail || ''), model: aiBackendLabel(), at: Date.now()
        }
      }));
    } catch (err) { /* 同上 */ }
  }

  async function runAiTask(type, name, prompt, work) {
    const qualityStartedAt = Date.now();
    emitAiBusy(true, 'generate', name);
    const task = X.addAiTask({
      type: type,
      name: name,
      source: 'local',
      details: { prompt: String(prompt || '').slice(0, 240) },
      message: '正在执行…'
    });
    try {
      const result = await work();
      X.updateAiTask(task.id, {
        status: 'success',
        message: result && result.message ? result.message : '执行完成',
        details: {
          result: result ? { type: result.type, id: result.id, name: result.name } : null,
          prompt: String(prompt || '').slice(0, 240)
        }
      });
      recordQuality(type, name, true, '', Date.now() - qualityStartedAt);
      return result;
    } catch (err) {
      const info = err && err.info && err.info.kind ? err.info : diagnoseError(err);
      if (err && typeof err === 'object' && !err.info) err.info = info;
      const message = err && err.message ? err.message : String(err);
      X.updateAiTask(task.id, {
        status: 'error',
        message: message,
        // errorKind 让任务面板/桥调用方不必再解析中文错误文案
        details: { error: message, errorKind: info.kind, hint: info.hint, prompt: String(prompt || '').slice(0, 240) }
      });
      recordQuality(type, name, false, info.kind, Date.now() - qualityStartedAt);
      emitAiError(info);
      throw err;
    } finally {
      emitAiBusy(false, 'generate', name);
    }
  }

  function aiSpeechText(text) {
    const content = String(text || '').trim();
    const head = content.split(/最近\s*\d+\s*轮串口帧/)[0];
    return head
      .replace(/```[\s\S]*?```/g, '代码已生成')
      .replace(/[#*`>]/g, ' ')
      .replace(/[\r\n]+/g, '，')
      .replace(/\s+/g, ' ')
      .replace(/，+/g, '，')
      .slice(0, 240);
  }

  function publishSpeechTask(text, source, name) {
    const content = String(text || '').trim();
    if (!content) return null;
    const speech = aiSpeechText(content) || content.slice(0, 120);
    if (window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.enqueue === 'function') {
      return window.XHGCS_TTS_WORKER.enqueue(speech, {
        source: source === 'alarm' ? 'alarm' : 'chat',
        origin: source === 'alarm' ? 'alarm' : (source || 'local'),
        name: name || 'AI 回复语音',
        message: content
      });
    }
    const task = X.addAiTask({
      type: 'speech',
      name: name || 'AI 回复语音',
      status: (state.ai.tts || {}).enabled === false ? 'error' : 'running',
      source: source || 'local',
      message: content,
      speech: speech,
      details: { source: source || 'local' }
    });
    if ((state.ai.tts || {}).enabled !== false && window.XHGCS_TTS) {
      window.XHGCS_TTS.speak(speech, { source: source || 'local' });
    }
    return task;
  }

  // 时序摘要。原来 AI 只看得到「此刻每个通道一个数」，问「电压为什么在抖」完全没有依据；
  // 而 series（每通道最近 100 点）其实已经在 getDataSnapshot 里算好了，被整个丢掉。
  // 这里取统计量而不是把 100 个原始点塞进提示词 —— 省 token，也够回答趋势类问题。
  function seriesStats(values) {
    const nums = (values || []).map(Number).filter((v) => Number.isFinite(v));
    if (nums.length < 2) return '';
    let mean = 0, min = nums[0], max = nums[0];
    for (const v of nums) {
      mean += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    mean /= nums.length;
    let sq = 0;
    for (const v of nums) sq += (v - mean) * (v - mean);
    return '均' + mean.toFixed(2) + ' 峰峰' + (max - min).toFixed(2) + ' 波动' + Math.sqrt(sq / nums.length).toFixed(2);
  }

  // 通道标签统一成 id(名字:单位 量程)。
  // 以前上下文里只印 ch.name，而动作协议示例和 checkScriptSpec / findChannel 都要求模型
  // 输出真实通道 id —— 模型被要求写 id、却只见过名字，只能靠猜，猜错还会被 save*Action
  // 静默接受。这是「AI 生成的东西接不上数据链」的根源，所以清单必须带 id。
  function channelTag(ch) {
    const unit = ch && ch.unit ? ':' + ch.unit : '';
    const range = ch && Array.isArray(ch.range) && ch.range.length === 2 ? ' ' + ch.range[0] + '~' + ch.range[1] : '';
    return String((ch && ch.id) || '') + '(' + String((ch && ch.name) || '') + unit + range + ')';
  }

  // 上下文里的通道清单要有上限：通道一多，每轮提示词都会线性变长，而模型只需要知道 id。
  // 超出的部分显式说明，别把「没列出来的通道」伪装成不存在。
  const CONTEXT_CHANNEL_LIMIT = 60;

  // 工具循环的轮数上限。模型反复查数据却不收敛时，停下来如实说明，而不是无限烧 token。
  const MAX_TOOL_ROUNDS = 6;

  function contextChannelList(list, limit) {
    const cap = Math.max(1, Number(limit) || CONTEXT_CHANNEL_LIMIT);
    const head = list.slice(0, cap)
      .map((ch) => channelTag(ch) + '=' + (ch.value == null ? '--' : Number(ch.value).toFixed(2)))
      .join(', ');
    if (list.length <= cap) return head;
    return head + ' …另有 ' + (list.length - cap) + ' 个通道未列出';
  }

  // options.compact=true 是「上下文预算不够」时先裁的那部分：只留通道名/数量、
  // 引擎与脚本摘要，丢掉趋势统计、日志与视图清单。默认调用（不传参）保持原样。
  function contextText(options) {
    const compact = Boolean(options && options.compact);
    const limit = compact ? 12 : CONTEXT_CHANNEL_LIMIT;
    const snapshot = X.getDataSnapshot(state.ai.contextFrames);
    const raw = contextChannelList(snapshot.raw, limit);
    const script = contextChannelList(snapshot.script, limit);
    if (compact) {
      const engines = snapshot.engines.slice(0, 6).map((e) => e.name + (e.active ? '*' : '') + '(' + e.protocol + ')').join(', ');
      const scripts = snapshot.scripts.slice(0, 8).map((s) => s.name + '(' + s.type + ')').join(', ');
      return [
        '# XiHe_GCS 数据链快照（精简）',
        '- 时间: ' + snapshot.t + 's  播放: ' + snapshot.playing,
        '- 原始通道: ' + raw,
        '- 脚本通道: ' + (script || '无'),
        '- 数据源: ' + (snapshot.serial.simulation ? '仿真' : '真实串口') + ' · ' + snapshot.serial.port + ' ' + snapshot.serial.baud + ' 帧=' + snapshot.serial.frames + ' 错误=' + snapshot.serial.errors,
        '- 告警: ' + (snapshot.alarms.length ? snapshot.alarms.map((a) => a.name + ':' + a.level).join(',') : '无'),
        '- 可用脚本: ' + (scripts || '无'),
        '- 数据引擎: ' + (engines || '无')
      ].join('\n');
    }
    const logs = snapshot.logs.map((log) => log.kind.toUpperCase() + ': ' + log.text).join('\n');
    const ttsWork = window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.status === 'function' ? window.XHGCS_TTS_WORKER.status() : null;
    // 有起伏可言的通道才值得列：全零/单点的通道只会把提示词撑长
    const trend = (list) => list.slice(0, CONTEXT_CHANNEL_LIMIT).map((ch) => {
      const stats = seriesStats((snapshot.series || {})[ch.id]);
      return stats ? channelTag(ch) + ' ' + stats : '';
    }).filter(Boolean).join(' · ');
    const trendText = trend(snapshot.raw.concat(snapshot.script));
    return [
      '# XiHe_GCS 数据链快照',
      '- 时间: ' + snapshot.t + 's  播放: ' + snapshot.playing,
      '- 原始通道: ' + raw,
      '- 脚本通道: ' + (script || '无'),
      '- 通道起伏: ' + (trendText || '样本不足'),
      '- 数据源: ' + (snapshot.serial.simulation ? '仿真' : '真实串口') + ' · ' + snapshot.serial.port + ' ' + snapshot.serial.baud + ' 帧=' + snapshot.serial.frames + ' 错误=' + snapshot.serial.errors + ' RX=' + snapshot.serial.rxBytes + ' 实测速率=' + (Number(state.serial.rate) || 0) + 'Hz',
      '- 最近串口帧 (' + snapshot.logs.length + '轮): ' + (logs || '无'),
      '- 告警: ' + (snapshot.alarms.length ? snapshot.alarms.map((a) => a.name + ':' + a.level).join(',') : '无'),
      '- 可用脚本: ' + (snapshot.scripts.length ? snapshot.scripts.map((s) => s.name + '(' + s.type + ')').join(',') : '无'),
      '- 可用组件: ' + (snapshot.components && snapshot.components.length ? snapshot.components.map((c) => c.name + '(' + c.kind + ')').join(',') : '无'),
      '- 可用视图: ' + (state.views && state.views.length ? state.views.map((v) => v.name).join(',') : '内置波形/柱状/数据表/仪表/地图'),
      '- 数据引擎: ' + (snapshot.engines.length ? snapshot.engines.map((e) => e.name + (e.active ? '*' : '')).join(',') : '无'),
      '- 分析画布: ' + (state.analysis.canvas ? state.analysis.canvas.nodes.length + ' 节点 / ' + state.analysis.canvas.edges.length + ' 连线，自动运行=' + state.analysis.canvas.autoRun : '未使用'),
      '- 分析结果: ' + (snapshot.analysis.lastError ? snapshot.analysis.lastError : snapshot.analysis.lastRun ? '最近运行 ' + new Date(snapshot.analysis.lastRun).toLocaleTimeString() : '未运行'),
      '- AI 子任务: ' + (state.ai.tasks && state.ai.tasks.length ? state.ai.tasks.length + ' 条，最近 ' + state.ai.tasks[0].type + ':' + state.ai.tasks[0].status : '无'),
      '- TTS: ' + ((state.ai.tts || {}).enabled === false ? '关闭' : (state.ai.tts || {}).engine || 'browser') + (ttsWork ? ' · 队列 ' + (ttsWork.queue || 0) + (ttsWork.running ? ' · 播报中' : ' · 空闲') : '')
    ].join('\n');
  }

  function snapshotSummary() {
    const snapshot = X.getDataSnapshot(state.ai.contextFrames);
    const latest = snapshot.raw.filter((ch) => ch.value != null).map((ch) => ch.name + '=' + Number(ch.value).toFixed(2) + ch.unit).join(', ');
    const script = snapshot.script.length ? '脚本通道 ' + snapshot.script.length + ' 条：' + snapshot.script.map((ch) => ch.name + '=' + Number(ch.value || 0).toFixed(2)).join(',') : '暂无可运行结果';
    const engine = snapshot.engines.find((e) => e.active) || snapshot.engines[0];
    const logs = snapshot.logs.map((log) => log.kind.toUpperCase() + ' ' + log.text).join('\n');
    const canvas = state.analysis.canvas || {};
    return '当前数据链：' + latest + '\n' + script + '\n数据源：' + (snapshot.serial.simulation ? '仿真' : '真实串口') + '\n串口：' + snapshot.serial.frames + ' 帧，' + snapshot.serial.errors + ' 错误；告警 ' + snapshot.alarms.length + ' 条。\n脚本库 ' + snapshot.scripts.length + ' 个：' + (snapshot.scripts.length ? snapshot.scripts.map((s) => s.name).join('、') : '无') + '\n数据引擎：' + (engine ? engine.name + ' · ' + engine.protocol : '未配置') + '\nMCP：' + (state.mcp.enabled ? (state.mcp.connected ? '已连接' : '连接中') : '未启用') + '\n分析画布：' + (canvas.nodes ? canvas.nodes.length + ' 节点 / ' + canvas.edges.length + ' 连线' : '无') + '\nAI 子任务：' + (state.ai.tasks && state.ai.tasks.length ? state.ai.tasks.length + ' 条' : '无') + '\nTTS：' + ((state.ai.tts || {}).engine || 'browser') + ((state.ai.tts || {}).enabled === false ? '（关闭）' : '') + '\n最近 ' + snapshot.logs.length + ' 轮串口帧：\n' + (logs || '无');
  }

  // 校验 / 归一 / 预览的实现在 ai-spec.js 的产物注册表里，这里只取引用。
  // 生成入口、聊天动作、确认卡片、桥的合并路径共用同一份判定 —— 以前同一个产物有
  // 三到四套实现，只有生成入口那套有校验。
  const checkGraphSpec = SPEC.checkGraphSpec;
  const graphFromSpec = SPEC.graphFromSpec;
  const checkComponentSpec = SPEC.checkComponentSpec;
  const componentFromSpec = SPEC.componentFromSpec;
  const checkEngineSpec = SPEC.checkEngineSpec;
  const engineConfigFromSpec = SPEC.engineConfigFromSpec;
  const checkScriptSpec = SPEC.checkScriptSpec;
  const scriptFromSpec = SPEC.scriptFromSpec;
  const normalizeScriptSpec = SPEC.normalizeScriptSpec;
  const engineProbeSpec = SPEC.engineProbeSpec;
  const actionOutputs = SPEC.actionOutputs;

  // ---- 生成即试运行 ----
  // 「产物建好了」和「产物算得出数」是两件事：模型给的公式可能引用不存在的通道、画布连线
  // 可能接不上、Python 可能跑不起来。analysis.js 的 runScript 契约是失败时把原因写进
  // state.analysis.lastError 并返回 null（很多调用方依赖这个契约，这里不改它），所以调用后
  // 同时看返回值和 lastError 判定；失败就回滚掉刚写的产物，不留一张「已生成但没数据」的卡片。
  const TRIAL_OUTPUT_LIMIT = 4;

  function trialNumberText(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    if (Math.abs(num) >= 1000) return String(Math.round(num));
    if (Math.abs(num) >= 10) return String(Math.round(num * 10) / 10);
    return String(Math.round(num * 100) / 100);
  }

  function trialOutputText(script, values) {
    const outputs = (script && script.outputs) || [];
    // 节点画布的 runGraphScript 返回 {values,...}，公式/脚本返回的就是 values 本身
    const map = values && values.values && typeof values.values === 'object' ? values.values : values;
    const parts = [];
    outputs.slice(0, TRIAL_OUTPUT_LIMIT).forEach((out, index) => {
      if (!out) return;
      let value = map && map[out.id] != null ? map[out.id] : undefined;
      if (value == null && map && out.label != null) value = map[out.label];
      if (value == null && map) value = map['out' + (index + 1)];
      const num = trialNumberText(value);
      if (!num) return;
      parts.push(String(out.label || ('输出 ' + (index + 1))) + '=' + num + (out.unit ? ' ' + out.unit : ''));
    });
    return parts.join('、');
  }

  async function trialRunArtifact(script, inputs) {
    // lastError 是分析面板的共享状态，不是试运行的私有变量：调用前已有值就先记下来，
    // 试运行结束后恢复，别让一次后台试跑把用户正看着的错误清掉。
    const previousError = String(state.analysis.lastError || '').trim();
    state.analysis.lastError = '';
    let values = null;
    try {
      values = await A.runAndAttach(script, inputs || script.inputs || []);
    } catch (err) {
      // runScript 自己会吞异常写 lastError；这里兜住 runAndAttach 自身抛错
      if (!state.analysis.lastError) state.analysis.lastError = String((err && err.message) || err);
    }
    const reason = String(state.analysis.lastError || '').trim();
    if (previousError) state.analysis.lastError = previousError;
    if (reason) return { ok: false, error: reason };
    if (!values) return { ok: false, error: '试运行没有返回任何输出值' };
    const text = trialOutputText(script, values);
    if (!text) return { ok: false, error: '试运行没有产出有效数值（输出为空或不是数字）' };
    return { ok: true, text: text };
  }

  // 公式里引用带横杠的通道 id（WED 的 wed-fc-01）会被当成减法：模型照上下文写的是真实 id，
  // 但公式作用域里只绑定公式名（c01）。生成前做一次确定性的 id→公式名替换，不然试运行闸门
  // 会把「模型写的真实 id 是对的」误判成算错。只替换完整 token，不碰字符串和子串。
  function normalizeFormulaIds(formula) {
    let text = String(formula || '');
    if (!text) return text;
    X.allChannels().forEach((ch) => {
      const id = String((ch && ch.id) || '');
      const alias = X.formulaAlias(id);
      if (!id || !alias || id === alias || text.indexOf(id) < 0) return;
      const escaped = id.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp('(^|[^\\w$.-])' + escaped + '(?![\\w$.-])', 'g'), '$1' + alias);
    });
    return text;
  }

  // Python 试运行失败要分两类：环境不具备（桥没起 / 没装 Python）只是「没能验证」，
  // 产物该保留；脚本自身算错（引用不存在通道 / 异常 / 输出不是数字）才必须回滚。
  function trialEnvMissing(reason) {
    const text = String(reason || '');
    if (!text) return '';
    return /需要启动 MCP 桥接服务|未找到 Python 可执行文件|Python 桥返回/.test(text) ? text : '';
  }

  // 落库 → 建输出通道 → 试运行；失败时回滚到落库前的快照。
  // 前置条件：只回滚本次调用新建/覆盖的那一份，绝不动既有产物 —— 所以用快照还原而不是
  // filter(script.id)：saveScript 以后若改成「有 id 则更新」（或聊天动作的 spec 带 id），
  // 按 id 删除会把用户原来的脚本一起删掉，那比「假成功」严重得多。
  async function commitScriptArtifact(script, inputs) {
    const scriptsSnapshot = (state.scripts || []).slice();
    const channelsSnapshot = (state.scriptChannels || []).slice();
    A.saveScript(script);
    A.ensureOutputs(script);
    const trial = await trialRunArtifact(script, inputs || script.inputs || []);
    if (trial.ok) return trial;
    // 环境缺失不是算错：保留产物，调用方按「已生成但无法试运行」如实说明。
    if (String(script.type) === 'python' && trialEnvMissing(trial.error)) {
      return Object.assign({}, trial, { cannotVerify: true });
    }
    state.scripts = scriptsSnapshot;
    state.scriptChannels = channelsSnapshot;
    X.persist();
    return trial;
  }

  // 试运行失败统一从这里抛：调用方（生成入口 / 聊天动作）拿到的都是带具体原因的错误。
  function trialFailure(trial) {
    return new Error('试运行失败：' + (trial && trial.error ? trial.error : '未知原因'));
  }

  // 环境缺失时不抛「试运行失败」：产物已保留，消息要说清是「没验证」而不是「没生成」。
  function unverifiedScriptMessage(name, error) {
    return '已生成脚本「' + name + '」，但当前环境无法试运行（原因：' + (error || '未知原因')
      + '），请启动 MCP 桥接服务后在分析页手动运行。';
  }

  async function generateGraph(prompt, options) {
    return runAiTask('graph', '生成节点画布', prompt, async () => {
      if (!window.XHGCS_GRAPH) throw new Error('节点画布引擎未加载');
      const G = window.XHGCS_GRAPH;
      const picked = ((options && options.inputs) || []).filter((id) => X.findChannel(id));
      // 没有本地模板兜底：模型没配或生成失败就如实报错，不再用关键词表造一个假画布。
      const result = await requestJsonSpec({
        system: GRAPH_SYSTEM_PROMPT,
        user: '# 需求\n' + prompt
          + (picked.length ? '\n\n# 用户已勾选的输入通道（优先用这些）\n' + picked.join(', ') : '')
          + '\n\n# 可用通道\n' + (channelDigestForModel() || '（暂无）'),
        check: checkGraphSpec
      });
      const graph = graphFromSpec(result.spec);
      const script = G.graphToScript(graph, String(result.spec.name).slice(0, 24));
      // 画布"画出数"才算生成成功：以前只 save + setCanvas，连线接错 / 组件不存在 /
      // 通道没数据都要等用户自己点运行时才发现，而这一刻已经报过「已生成」。
      const trial = await commitScriptArtifact(script, script.inputs);
      if (!trial.ok) throw trialFailure(trial);
      G.setCanvas(graph);
      if (window.XHGCS_GRAPH_UI) window.XHGCS_GRAPH_UI.render();
      window.dispatchEvent(new CustomEvent('xhgcs:scripts-changed'));
      return {
        ok: true,
        type: 'graph',
        id: script.id,
        name: script.name,
        message: '已生成并运行节点画布「' + script.name + '」：'
          + graph.nodes.length + ' 个节点 / ' + graph.edges.length + ' 条连线，试运行输出：' + trial.text + '。' + result.note
      };
    });
  }

  async function generateComponent(prompt) {
    return runAiTask('component', '生成可复用组件', prompt, async () => {
      // 没有本地关键词模板兜底：模型没配或生成不合格就如实报错。
      const result = await requestJsonSpec({
        system: COMPONENT_SYSTEM_PROMPT,
        user: '# 需求\n' + prompt + '\n\n# 现有通道（供参考，不一定要用）\n' + (channelDigestForModel() || '（暂无）'),
        check: checkComponentSpec
      });
      const component = X.addComponent(componentFromSpec(result.spec, prompt));
      window.dispatchEvent(new CustomEvent('xhgcs:components-changed', { detail: { action: 'add', component: component } }));
      return {
        ok: true,
        type: 'component',
        id: component.id,
        name: component.name,
        message: '已生成「' + component.name + '」可复用组件（' + (component.kind === 'python' ? 'Python' : '公式') + '），可从画布左侧「组件库」拖入，也可继续让我用组件搭建画布。' + result.note
      };
    });
  }

  const VIEW_SYSTEM_PROMPT = SPEC.get('view').systemPrompt;

  // 视图代码评估：lint 过不了直接判死；lint 能过就真挂载跑几帧看效果。
  // 以前只做 lint 门就交付，「能编译但画歪/画空/溢出」全被当成"已生成"，这才是"AI 生成好差"的直接来源。
  async function evaluateViewCode(code) {
    const V = window.XHGCS_VIEWS;
    const lint = V && V.lintViewCode ? V.lintViewCode(code) : { errors: [], warnings: [] };
    if (lint.errors.length) return { lint: lint, report: null, fix: 'lint 错误：' + lint.errors.join('；') };
    const verify = window.XHGCS_VIEW_VERIFY;
    if (!verify || typeof verify.verify !== 'function') return { lint: lint, report: null, fix: null, skipped: '自检模块未加载' };
    let report = null;
    try {
      report = await verify.verify(code, { frames: 4 });
    } catch (err) {
      // 自检器自己崩了不等于代码合格。以前这里同样返回 fix:null，坏代码会被当成通过交付。
      return { lint: lint, report: null, fix: null, skipped: '自检执行出错：' + ((err && err.message) || err) };
    }
    if (report.ok) return { lint: lint, report: report, fix: null };
    const problems = report.errors
      .concat(report.checks.filter((c) => !c.ok).map((c) => c.label + '：' + c.detail))
      .slice(0, 4);
    return { lint: lint, report: report, fix: problems.join('\n') || '自检未通过' };
  }

  async function retryViewCode(messages, reply, fix) {
    try {
      const retryReply = await chatOnce(messages.concat([
        { role: 'assistant', content: String(reply || '').slice(0, 4000) },
        { role: 'user', content: '上面这份代码真挂载自检没通过：\n' + fix + '\n\n请修正后重新只输出一个 JSON 对象（不要解释）。优先用 ctx.draw.plot() 建画布槽，再用 ctx.draw.scope(ctx.plot.canvas, { series:"名字子串", limit:4 }) / ctx.draw.bars(...) / ctx.draw.donut(...) 出图，不要自己手写坐标轴与图例位置。' }
      ]), { maxTokens: 4096, temperature: 0.2 });
      return parseViewSpec(retryReply);
    } catch (err) {
      return null;
    }
  }

  async function generateView(prompt, apiDoc, options) {
    const text = String(prompt || '').trim();
    if (!text) throw new Error('请先描述你想要的视图');
    const opts = options || {};
    return runAiTask('view', '生成可视化视图', text, async () => {
      const V = window.XHGCS_VIEWS;
      const B = window.XHGCS_VIEW_BLUEPRINT;
      const doc = String(apiDoc || (V && V.viewApiDoc) || '');
      // 把真实通道清单塞进提示词：模型不用猜字段名，能直接把 series 写成名字子串
      const digest = V && V.channelDigest ? V.channelDigest() : '';
      const messages = [
        { role: 'system', content: VIEW_SYSTEM_PROMPT },
        { role: 'user', content: doc + (digest ? '\n\n' + digest : '') + '\n\n# 需求\n' + text + '\n\n按上面的「输出格式」只返回一个 JSON 对象。' }
      ];
      let spec = null;
      let source = 'ai-model';
      let state = null;
      let note = '';
      let why = '';
      let reply = '';
      if (opts.localFirst && B && B.compile) {
        // 构图板本身已经是结构化输入：直接编译成受控绘图原语，
        // 不让一次“画视图”卡在 180 秒的 Agent 会话上。
        spec = B.compile(opts.blueprint || {}, text);
        state = await evaluateViewCode(spec.code);
        source = 'local-blueprint';
        why = state.fix;
        note = '（构图板直接编译）';
      } else {
        try {
          reply = await chatOnce(messages, { maxTokens: 4096, temperature: 0.2 });
          spec = parseViewSpec(reply);
          state = await evaluateViewCode(spec.code);
          why = state.fix;

          // 首次不合格：带着错误清单让模型改一次（只重试一次，避免烧 token）
          if (why) {
            const retried = await retryViewCode(messages, reply, why);
            if (retried) {
              const after = await evaluateViewCode(retried.code);
              spec = retried;
              state = after;
              why = after.fix;
              if (!why) note = '（首版未通过自检，已自动修正 1 次）';
            }
          }
        } catch (err) {
          // 一句话生成不能因为后端没配、网络抖一下就彻底失效。
          // 构图板/句式先编译成受控的 ctx.draw 代码，再走同一套真挂载自检。
          spec = null;
          state = null;
          why = '模型生成失败：' + ((err && err.message) || err);
        }
      }

      // 模型不可用或代码不达标：退回本地构图编译器，绝不把坏代码交给用户。
      if (!spec || why) {
        const fallback = B && B.compile
          ? B.compile(opts.blueprint || {}, text)
          : (V && V.fallbackTemplate ? V.fallbackTemplate(text) : null);
        if (fallback) {
          spec = {
            name: (spec && spec.name) || fallback.name,
            icon: (spec && spec.icon) || fallback.icon,
            desc: (spec && spec.desc) || fallback.desc,
            code: fallback.code
          };
          state = await evaluateViewCode(spec.code);
          source = 'local-blueprint';
          note = '（' + (why || '模型未返回可用代码') + '，已用本地构图编译器生成）';
        }
      }

      if (!spec || !state) throw new Error('没有生成可用的视图代码');
      // 自检没跑成（模块缺失 / 自检器报错）也必须说出来，不能默认当合格
      if (!note && state.skipped) note = '（' + state.skipped + '，未做真挂载自检）';
      if (state.fix) throw new Error('生成视图未通过自检：' + state.fix);
      let def = null;
      if (opts.save && V && V.saveViewSpec) {
        def = V.saveViewSpec({
          name: spec.name || 'AI 构图视图',
          icon: spec.icon || '◈',
          desc: spec.desc || '一句话与构图板生成的数据视图',
          code: spec.code,
          origin: source
        });
        if (opts.activate !== false) {
          if (V.switchSubView) V.switchSubView(def.id);
          else if (V.activateView) V.activateView(def.id);
        }
      }
      return {
        ok: true,
        type: 'view',
        spec: spec,
        def: def,
        source: source,
        lint: state.lint,
        verify: state.report,
        message: (def ? '已生成并启用视图' : '已生成视图代码') + (spec.name ? '：' + spec.name : '')
          + note + (state.lint && state.lint.warnings.length ? '（' + state.lint.warnings.length + ' 条画风提醒）' : '')
      };
    });
  }

  async function composeView(prompt, options) {
    const opts = Object.assign({ save: true, activate: true }, options || {});
    if (typeof opts.localFirst !== 'boolean') opts.localFirst = true;
    return generateView(prompt, window.XHGCS_VIEWS && window.XHGCS_VIEWS.viewApiDoc, opts);
  }

  async function generateEngine(prompt) {
    return runAiTask('engine', '生成数据引擎', prompt, async () => {
      const result = await requestJsonSpec({
        system: ENGINE_SYSTEM_PROMPT,
        user: '# 需求\n' + prompt,
        check: checkEngineSpec
      });
      const engine = X.addEngine(engineConfigFromSpec(result.spec, prompt));
      // 切换数据引擎会清空串口缓冲。正在收真实数据时不要静默抢掉当前引擎，
      // 否则一次普通聊天就会把这一轮采集丢掉。
      const busy = Boolean(state.serial.connected && state.serial.running && !state.simulation.enabled);
      let switched = '并设为当前引擎。';
      if (busy) {
        switched = '。当前正在接收真实串口数据，没有替你切换（切引擎会清空串口缓冲），去「串口」页手动应用即可。';
      } else {
        X.setActiveEngine(engine.id);
        if (engine.protocol === 'WED') X.applyProtocolChannels(engine);
      }
      window.dispatchEvent(new CustomEvent('xhgcs:engines-changed'));
      return {
        ok: true,
        type: 'engine',
        id: engine.id,
        name: engine.name,
        message: '已生成数据引擎「' + engine.name + '」' + switched + '协议：' + engine.protocol + (engine.protocol === 'WED' ? '；已自动建立 ' + (engine.channelCount || 20) + ' 个 WED 遥测通道。' : '。') + result.note
      };
    });
  }

  async function generateScript(prompt, options) {
    return runAiTask('script', '生成数据脚本', prompt, async () => {
      const picked = ((options && options.inputs) || []).filter((id) => X.findChannel(id));
      const result = await requestJsonSpec({
        system: SCRIPT_SYSTEM_PROMPT,
        user: '# 需求\n' + prompt
          + (picked.length ? '\n\n# 用户已勾选的输入通道（优先用这些）\n' + picked.join(', ') : '')
          + '\n\n# 可用通道\n' + (channelDigestForModel() || '（暂无）'),
        check: checkScriptSpec
      });
      const script = scriptFromSpec(result.spec, prompt, options);
      // 模型照上下文写真实 id，但带横杠的 id（wed-fc-01）在公式里会被当减法：先换公式名
      if (script.type === 'functions') script.formula = normalizeFormulaIds(script.formula);
      // functions 和 python 都要真跑一遍再宣布成功：以前只跑 functions，
      // 而且拿到 null（runScript 的失败返回值）照样报「已生成并保存」。
      const trial = await commitScriptArtifact(script, script.inputs);
      if (!trial.ok && !trial.cannotVerify) throw trialFailure(trial);
      window.dispatchEvent(new CustomEvent('xhgcs:scripts-changed'));
      return {
        ok: true,
        type: 'script',
        id: script.id,
        name: script.name,
        verified: Boolean(trial.ok),
        message: trial.ok
          ? '已生成并运行脚本「' + script.name + '」，试运行输出：' + trial.text
            + '；已创建 ' + script.outputs.length + ' 个脚本输出通道。' + result.note
          : unverifiedScriptMessage(script.name, trial.error)
      };
    });
  }

  // 动作协议的 few-shot 由注册表拼出来：示例和校验器同源，不会再出现
  // 「示例里缺字段、校验器却要求它」这种漂移。
  const ACTION_PROTOCOL = [
    '',
    '# 工具动作协议',
    '当用户要求创建数据脚本、可复用计算组件、节点画布、数据引擎或可视化视图时，最终只输出一个 JSON 代码块，不要重复解释：'
  ].concat(SPEC.protocolExamples()).concat([
    '普通提问直接回答，不要输出动作块。'
  ]).join('\n');

  // 生成路径统一成：真实清单 → 模型 → 校验 → 带错误清单再要一次。没有本地模板兜底了：
  // 模型没配或两次都不合格就如实报错，不再拿关键词表造一个看起来成功的产物。

  // 只认「一个 JSON 对象」：模型偶尔会套一层 spec / result，这里都认
  function specFromReply(reply) {
    const obj = parseJsonObject(reply);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    for (const key of ['spec', 'result', 'data']) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) return obj[key];
    }
    return obj;
  }

  // 给模型的通道清单（脚本 / 组件 / 画布生成入口用）。以前静默截到 40 个，
  // 通道多的时候模型永远看不见后面的；现在复用同一套 id 标签并显式说明截断。
  function channelDigestForModel() {
    const all = X.allChannels();
    const head = all.slice(0, CONTEXT_CHANNEL_LIMIT).map(channelTag).join(' · ');
    if (all.length <= CONTEXT_CHANNEL_LIMIT) return head;
    return head + ' · …另有 ' + (all.length - CONTEXT_CHANNEL_LIMIT) + ' 个通道未列出';
  }

  // 不合格就带着错误清单再要一次，仍不合格抛错 —— 由调用方退回本地正则模板。
  // 与 generateView 的四段式一致，只是这些产物没有「离屏真挂载」那一步自检。
  async function requestJsonSpec(opts) {
    const messages = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user }
    ];
    const reply = await chatOnce(messages, { maxTokens: 4096, temperature: 0.2 });
    const first = specFromReply(reply);
    const problem = first ? opts.check(first) : '回复里没有可解析的 JSON 对象';
    if (!problem) return { spec: first, note: '' };
    const retry = messages.concat([
      { role: 'assistant', content: String(reply || '').slice(0, 4000) },
      { role: 'user', content: '上面这份不合格：' + problem + '\n请修正后重新只输出一个 JSON 对象，不要解释。' }
    ]);
    const second = specFromReply(await chatOnce(retry, { maxTokens: 4096, temperature: 0.2 }));
    const still = second ? opts.check(second) : '回复里没有可解析的 JSON 对象';
    if (still) throw attachErrorInfo(new Error('模型两次都没给出合规的产物：' + still));
    return { spec: second, note: '（首版未通过校验，已自动修正 1 次）' };
  }

  // 系统提示由注册表提供，生成入口不再各自维护一份字段说明。
  const SCRIPT_SYSTEM_PROMPT = SPEC.get('script').systemPrompt;
  const ENGINE_SYSTEM_PROMPT = SPEC.get('engine').systemPrompt;
  const COMPONENT_SYSTEM_PROMPT = SPEC.get('component').systemPrompt;
  const GRAPH_SYSTEM_PROMPT = SPEC.get('graph').systemPrompt;

  let activeController = null;

  function normUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function chatUrl(endpoint) {
    const base = normUrl(endpoint).replace(/\/v1$/i, '');
    return base + '/v1/chat/completions';
  }

  // 视图相关的请求要把真实 API 规范带上：ACTION_PROTOCOL 里那条 view 示例只是形状示意，
  // 模型照着它写出来的是空壳。规范有 3.5 KB，只在确实要生成视图时才注入，别每轮都背。
  function classifyViewPrompt(prompt) {
    const text = String(prompt || '');
    const action = /^\s*(请|帮我|麻烦|给我|我想|我要|能否|能不能)?\s*(画|生成|做|创建|来|搭)/.test(text);
    const target = /(视图|可视化|看板|仪表盘|仪表|示波器|趋势图|曲线图|曲线|波形|柱状图|占比图|雷达图|瀑布图|散点图|热力图|桑基图|箱线图)/.test(text);
    const compose = /^\s*(把|将)/.test(text)
      && /(画|叠|叠加|显示|对比|合成)/.test(text)
      && /(通道|路|曲线|波形|图)/.test(text);
    const complex = /雷达|瀑布|散点|热力|地图|桑基|箱线|自定义图形/.test(text);
    return {
      direct: (action && target) || compose,
      complex: complex,
      localFirst: !complex,
      reason: (action && target) || compose ? (complex ? '复杂图形走模型' : '结构化快速生成') : '普通对话'
    };
  }

  function needsViewDoc(prompt) {
    return classifyViewPrompt(prompt).direct
      || /视图|可视化|看板|仪表盘|仪表|图面|曲线图|曲线|波形|示波器|柱状图|占比图|构图板|画一个|多图/.test(String(prompt || ''));
  }

  function systemPromptText(prompt, options) {
    const compact = Boolean(options && options.compact);
    const custom = String(state.ai.systemPrompt || '').trim();
    const parts = [
      custom || '你是 XiHe_GCS 地面站的本地数据分析助手。回答简洁，优先完成脚本、画布或数据引擎任务；不要猜测未提供的通道。',
      '',
      '# 当前数据链上下文',
      contextText(compact ? { compact: true } : undefined)
    ];
    if (needsViewDoc(prompt)) {
      const V = window.XHGCS_VIEWS;
      if (V && V.viewApiDoc) {
        parts.push('', '# 可视化视图插件规范（生成视图的 code 时必须严格遵守）', String(V.viewApiDoc));
      }
    }
    return parts.concat(ACTION_PROTOCOL.split('\n')).join('\n');
  }

  // ---- 上下文预算 ----
  // 以前是「固定 20 轮 × 4000 字符」硬截断：没预算概念，超了就是上游报错/内容被砍半。
  // 现在预算来自 state.ai.contextBudgetChars（默认 24000；读取/导入时 clamp 4000~120000，
  // 改配置行为就变）。超阈值后先精简 system 里的数据链快照，再按「轮」边界裁历史，
  // 当前问题永远完整保留。
  const AI_CONTEXT_BUDGET_MIN = 4000;
  const AI_CONTEXT_BUDGET_MAX = 120000;
  const AI_CONTEXT_BUDGET_DEFAULT = 24000;
  const AI_CONTEXT_TRIM_RATIO = 0.8;
  const AI_CONTEXT_KEEP_RATIO = 0.16;
  let lastContextUsage = { chars: 0, estTokens: 0, turns: 0, trimmed: false };

  function contextBudgetChars() {
    const raw = Number(state.ai && state.ai.contextBudgetChars);
    const value = Number.isFinite(raw) && raw > 0 ? raw : AI_CONTEXT_BUDGET_DEFAULT;
    return Math.max(AI_CONTEXT_BUDGET_MIN, Math.min(AI_CONTEXT_BUDGET_MAX, value));
  }

  // 粗估 token：中文约 1 字/token、英文约 4 字符/token，这里取折中 2 字符/token，
  // 只用于给界面一个量级，不参与精确计费。
  function estimateTokens(chars) {
    return Math.max(0, Math.ceil(Number(chars || 0) / 2));
  }

  function messagesChars(list) {
    return (list || []).reduce((sum, item) => sum + String((item && item.content) || '').length, 0);
  }

  function countTurns(list) {
    return (list || []).filter((item) => item && item.role === 'user').length;
  }

  // 最近一次构造的上下文用量；空态返回零值，绝不抛异常（界面/排障面板可直接渲染）。
  function contextUsage() {
    try {
      return {
        chars: Number(lastContextUsage.chars) || 0,
        estTokens: Number(lastContextUsage.estTokens) || 0,
        turns: Number(lastContextUsage.turns) || 0,
        trimmed: Boolean(lastContextUsage.trimmed),
        budget: contextBudgetChars()
      };
    } catch (err) {
      return { chars: 0, estTokens: 0, turns: 0, trimmed: false, budget: AI_CONTEXT_BUDGET_DEFAULT };
    }
  }

  function historyMessages() {
    return (state.ai.messages || []).slice(-20)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.raw || m.content || '').trim())
      .map((m) => ({ role: m.role, content: String(m.raw || m.content || '').slice(0, 4000) }));
  }

  // 按轮边界裁剪：一轮 = user 消息 + 其后的 assistant 消息，绝不把一轮拆半。
  function trimHistoryAtTurnBoundary(history, keepChars) {
    const turns = [];
    history.forEach((msg) => {
      if (!turns.length || msg.role === 'user') turns.push([msg]);
      else turns[turns.length - 1].push(msg);
    });
    const kept = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const size = turns[i].reduce((sum, msg) => sum + String(msg.content || '').length, 0);
      // 最近一轮无论多大都保留：当前问题永远完整，上一轮回答要能接着改
      if (kept.length && used + size > keepChars) break;
      kept.unshift.apply(kept, turns[i]);
      used += size;
    }
    return kept;
  }

  function chatMessages(prompt, options) {
    const opts = options || {};
    const budget = Math.max(AI_CONTEXT_BUDGET_MIN, Math.min(AI_CONTEXT_BUDGET_MAX, Number(opts.budget) || contextBudgetChars()));
    const threshold = Math.floor(budget * AI_CONTEXT_TRIM_RATIO);
    const current = String(prompt || '').trim();
    const fullHistory = historyMessages();
    if (current && fullHistory.length && fullHistory[fullHistory.length - 1].role === 'user'
      && fullHistory[fullHistory.length - 1].content === current) fullHistory.pop();
    let system = systemPromptText(current);
    let history = fullHistory.slice();
    let trimmed = false;
    let messages = [{ role: 'system', content: system }].concat(history, [{ role: 'user', content: current }]);
    if (messagesChars(messages) > threshold && history.length) {
      // 第一步：先裁 system 里可裁的部分（通道清单/趋势统计/日志/视图清单）
      system = systemPromptText(current, { compact: true });
      messages[0] = { role: 'system', content: system };
      trimmed = true;
    }
    if (messagesChars(messages) > threshold && history.length) {
      // 第二步：历史按轮边界裁到最近约 16% 预算，当前问题不动
      history = trimHistoryAtTurnBoundary(history, Math.floor(budget * AI_CONTEXT_KEEP_RATIO));
      messages = [{ role: 'system', content: system }].concat(history, [{ role: 'user', content: current }]);
    }
    const chars = messagesChars(messages);
    if (chars > budget) {
      const err = attachErrorInfo(new Error('上下文超长：系统提示与当前问题已超过 contextBudgetChars 预算（'
        + budget + ' 字符）。请减少上下文帧数，或在设置 → AI 对话里调大上下文预算'));
      err.contextBudget = budget;
      throw err;
    }
    lastContextUsage = { chars: chars, estTokens: estimateTokens(chars), turns: countTurns(messages), trimmed: trimmed };
    return messages;
  }

  function chatPayloadFrom(messages, stream, disableThinking) {
    const payload = {
      model: state.ai.model,
      messages: messages,
      temperature: Number(state.ai.temperature != null ? state.ai.temperature : 0.2) || 0,
      max_tokens: Math.max(16, Math.min(8192, Number(state.ai.maxTokens) || 1024)),
      stream: stream !== false && state.ai.stream !== false
    };
    if (disableThinking !== false) payload.thinking = { type: 'disabled' };
    return payload;
  }

  function chatPayload(prompt, stream, disableThinking) {
    return chatPayloadFrom(chatMessages(prompt), stream, disableThinking);
  }

  function headersWithKey(extra) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (state.ai.apiKey) headers.Authorization = 'Bearer ' + state.ai.apiKey;
    return headers;
  }

  async function requestJson(url, options, timeoutMs) {
    const controller = (options && options.signal) || new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
    try {
      const response = await fetch(url, Object.assign({ signal: controller.signal }, options || {}));
      if (!response.ok) {
        // HTTP 状态和响应体一起带出来：上游 400 的 body 里常写 context_length_exceeded /
        // invalid api key，只报「HTTP 400」会让错误诊断退化成 upstream/unknown。
        const detail = await response.text().catch(() => '');
        const error = new Error('HTTP ' + response.status + (detail ? ' · ' + detail.slice(0, 240) : ''));
        error.status = response.status;
        error.detail = detail.slice(0, 600);
        throw error;
      }
      return await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
  }

  function openaiResponseText(payload) {
    return payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content || '';
  }

  async function readEventStream(response, onDelta, finishCallback) {
    const type = String(response.headers.get('content-type') || '');
    if (type.indexOf('event-stream') < 0) {
      const payload = await response.json().catch(() => ({}));
      const content = openaiResponseText(payload) || '';
      if (content && onDelta) onDelta(content, 'content');
      const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message || {};
      return {
        content: content,
        finish: payload.choices && payload.choices[0] && payload.choices[0].finish_reason || '',
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : []
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finish = '';
    // 流式下 tool_calls 是按 index 分片到达的：id/name 先到，arguments 逐段拼接。
    // 每片都当完整 JSON 解析必然失败，必须攒到流结束再交给调用方。
    const toolCalls = [];
    const consume = (block) => {
      String(block || '').split(/\r?\n/).forEach((line) => {
        const text = line.trim();
        if (text.indexOf('data:') !== 0) return;
        const data = text.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const payload = JSON.parse(data);
          if (payload.error) throw new Error(payload.error.message || payload.error);
          const choice = payload.choices && payload.choices[0];
          if (choice) {
            const delta = choice.delta || {};
            if (delta.content) {
              content += String(delta.content);
              onDelta(String(delta.content), 'content');
            }
            else if (delta.reasoning_content) onDelta(String(delta.reasoning_content), 'reasoning');
            if (Array.isArray(delta.tool_calls)) {
              delta.tool_calls.forEach((part) => {
                const at = Number(part && part.index) || 0;
                if (!toolCalls[at]) toolCalls[at] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                const slot = toolCalls[at];
                if (part && part.id) slot.id = String(part.id);
                const fn = part && part.function || {};
                if (fn.name) slot.function.name += String(fn.name);
                if (fn.arguments) slot.function.arguments += String(fn.arguments);
              });
            }
            if (choice.finish_reason) finish = String(choice.finish_reason);
          }
        } catch (err) {
          if (err && err.message && err.message !== 'Unexpected end of JSON input') throw err;
        }
      });
    };
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        consume(block);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (finishCallback) finishCallback(finish);
    return { content: content, finish: finish, toolCalls: toolCalls.filter(Boolean) };
  }

  // ---- DSH 后端（@deepseek-ai/dsh）----
  // 浏览器起不了进程，所以经本地桥的 /api/ai/dsh 代跑 `dsh --profile headless "<task>"`：
  // 应用内的生成任务直接复用用户已经配好的 DSH（模型、密钥、agent 循环），
  // 而不是再去猜一个本地 OpenAI 兼容端点。
  function dshBackendOn() {
    return String(state.ai.backend || 'local') === 'dsh';
  }

  function aiBackendLabel() {
    return dshBackendOn() ? 'DSH ' + (state.ai.dshProfile || 'headless') : (state.ai.model || '');
  }

  function messagesToDshTask(messages) {
    return (messages || []).map((m) => {
      if (m.role === 'system') return '# 系统指令\n' + String(m.content || '');
      if (m.role === 'assistant') return '# 上一轮回复\n' + String(m.content || '');
      return '# 需求\n' + String(m.content || '');
    }).join('\n\n');
  }

  // agent 模式：让 DSH 直接用地面的 MCP 工具干活，而不是吐 JSON 动作块。
  // 这时不能再把 ACTION_PROTOCOL 塞给它——那会把它引回「输出 JSON」的老路。
  function messagesToDshAgentTask(messages) {
    const history = (messages || []).filter((m) => m.role !== 'system');
    const custom = String(state.ai.systemPrompt || '').trim();
    return [
      '# 角色',
      '你是 XiHe GCS 地面站的 AI 助手，正在直接操作这套地面站。',
      '你可以调用 xhgcs MCP 工具：',
      '- 读数据：snapshot / channel_history / list_channels',
      '- 看配置：list_scripts / list_engines / list_components / list_views / get_canvas',
      '- 创建产物：create_script / create_engine / create_component / create_view / create_graph',
      '- 运行与自检：run_analysis / verify_view',
      '优先直接调用工具完成任务，不要输出 JSON 动作块，也不要只描述计划。',
      '创建前先用 list_channels 确认真实通道 id，不要编造。完成后用中文简短说明做了什么。',
      custom ? '\n# 用户自定义指令\n' + custom : '',
      '',
      messagesToDshTask(history)
    ].join('\n');
  }

  function dshErrorFrom(data, status) {
    const error = new Error(String((data && data.error) || ('HTTP ' + status)));
    if (data && data.stderrTail) error.detail = String(data.stderrTail).slice(0, 1200);
    return error;
  }

  // 读 DSH 进度流：桥用 SSE 把 reasoning 增量、最终正文、错误真因送回来，事件格式与
  // /api/ai/chat 同风格。旧桥没有 stream 支持时返回 JSON，这里同样兼容。
  async function readDshStream(response, onReason) {
    const type = String(response.headers.get('content-type') || '');
    if (type.indexOf('event-stream') < 0) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw dshErrorFrom(data, response.status);
      return String(data.content || '');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let failure = null;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event = null;
        try { event = JSON.parse(payload); } catch (err) { continue; }
        if (!event) continue;
        if (event.type === 'reason') {
          // truncated 只是「进度太长不转了」的标记，没有正文增量
          if (!event.truncated && event.text && onReason) onReason(String(event.text));
        } else if (event.type === 'final') {
          content = String(event.content || '');
        } else if (event.type === 'error') {
          const error = new Error(String(event.error || 'DSH 执行失败'));
          if (event.stderrTail) error.detail = String(event.stderrTail).slice(0, 1200);
          if (event.cancelled) error.name = 'AbortError';
          failure = error;
        }
      }
    }
    if (failure) throw failure;
    return content;
  }

  async function dshRun(messages, options) {
    const opts = options || {};
    const mode = opts.mode || state.ai.dshMode || 'agent';
    const stream = Boolean(opts.stream);
    const response = await X.mcpFetch('/api/ai/dsh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: mode === 'agent' ? messagesToDshAgentTask(messages) : messagesToDshTask(messages),
        profile: state.ai.dshProfile || 'headless',
        timeoutMs: Math.max(10000, Math.min(300000, Number(state.ai.dshTimeoutMs) || 180000)),
        mode: mode,
        // 聊天路径走 SSE 拿 reasoning 进度；生成路径（chatOnce）仍要一次性的纯 JSON
        stream: stream
      }),
      signal: opts.signal
    });
    if (stream) return await readDshStream(response, opts.onReason);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw dshErrorFrom(data, response.status);
    return String(data.content || '');
  }

  async function dshStatus(refresh) {
    try {
      return await X.mcpJson('/api/ai/dsh' + (refresh ? '?refresh=1' : ''), { method: 'GET' }, 60000);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  async function requestChat(prompt, stream, onDelta, signal, options) {
    const opts = options || {};
    const useTools = Boolean(opts.tools && opts.tools.length);
    if (dshBackendOn()) {
      const content = await dshRun(opts.messages || chatMessages(prompt), {
        signal: signal,
        mode: opts.dshMode,
        stream: typeof onDelta === 'function',
        onReason: typeof onDelta === 'function' ? (delta) => onDelta(delta, 'reasoning') : null
      });
      return { content: content, finish: 'stop', via: 'dsh', toolCalls: [] };
    }
    const viaProxy = state.ai.useProxy !== false;
    const IDLE_TIMEOUT_MS = 45000;
    const attempt = async (proxy, disableThinking, toolsEnabled) => {
      const payload = opts.messages
        ? chatPayloadFrom(opts.messages, stream, disableThinking)
        : chatPayload(prompt, stream, disableThinking);
      if (toolsEnabled && useTools) payload.tools = opts.tools;
      // 空闲超时。模型假死（推理服务卡住、流式吐一半断连）时原来会永远停在
      // 「AI 正在思考…」，唯一的出路是用户手点停止。只要还在吐字就一直续期，
      // 静默太久才中断，而且中断理由要说清楚是「超时」而不是「已停止」。
      const local = new AbortController();
      let idleTimer = 0;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          local.abort(new Error('模型输出超时：超过 ' + Math.round(IDLE_TIMEOUT_MS / 1000) + ' 秒没有任何内容，已中断'));
        }, IDLE_TIMEOUT_MS);
      };
      const forwardAbort = () => local.abort();
      if (signal) {
        if (signal.aborted) local.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      armIdle();
      try {
        const options = {
          method: 'POST',
          body: JSON.stringify(proxy ? Object.assign({
            endpoint: state.ai.endpoint,
            apiKey: state.ai.apiKey || ''
          }, payload) : payload),
          signal: local.signal
        };
        let response;
        if (proxy) {
          response = await X.mcpFetch('/api/ai/chat', Object.assign({}, options, { headers: { 'Content-Type': 'application/json' } }));
        } else {
          response = await fetch(chatUrl(state.ai.endpoint), Object.assign({}, options, { headers: headersWithKey() }));
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const error = new Error('HTTP ' + response.status + (detail ? ' · ' + detail.slice(0, 180) : ''));
          error.status = response.status;
          error.detail = detail;
          throw error;
        }
        if (payload.stream) {
          const streamed = await readEventStream(response, (delta) => {
            armIdle();
            if (onDelta) onDelta(delta);
          });
          return { content: streamed.content || '', finish: streamed.finish || '', streamed: true, toolCalls: streamed.toolCalls || [] };
        }
        const data = await response.json().catch(() => ({}));
        const message = data && data.choices && data.choices[0] && data.choices[0].message || {};
        return {
          content: openaiResponseText(data) || '',
          finish: data.choices && data.choices[0] && data.choices[0].finish_reason || '',
          data: data,
          toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : []
        };
      } finally {
        clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }
    };
    const run = async (proxy, toolsEnabled) => {
      const disabledThinking = state.ai.disableThinking !== false;
      try {
        return await attempt(proxy, disabledThinking, toolsEnabled);
      } catch (err) {
        // 有些 OpenAI 兼容服务不认识 tools 字段，会直接 400/422。去掉工具重试一次，
        // 别让一次工具调用把整轮对话打挂。
        if (toolsEnabled && err && (err.status === 400 || err.status === 422)) return run(proxy, false);
        if (disabledThinking && err && (err.status === 400 || err.status === 502)) return attempt(proxy, false, toolsEnabled);
        throw err;
      }
    };
    if (!viaProxy) return run(false, useTools);
    try {
      return await run(true, useTools);
    } catch (err) {
      const message = String(err && err.message || err);
      if (signal && signal.aborted) throw err;
      if (/fetch failed|failed to fetch|ECONNREFUSED|network|HTTP 404|not found|无法连接/i.test(message)) return attempt(false, state.ai.disableThinking !== false, useTools);
      throw err;
    }
  }

  async function remoteReply(prompt, callbacks) {
    if (!dshBackendOn() && (!state.ai.endpoint || !state.ai.model)) throw new Error('请先在「设置 → AI 对话」里配置 API：选择 DSH Agent，或填写 Endpoint 与模型名');
    const started = Date.now();
    const controller = new AbortController();
    activeController = controller;
    let text = '';
    let reason = '';
    const onDelta = (delta, kind) => {
      if (kind === 'reasoning') {
        reason += delta;
        if (callbacks && callbacks.onReason) callbacks.onReason(delta);
        return;
      }
      text += delta;
      if (callbacks && callbacks.onDelta) callbacks.onDelta(delta);
    };
    try {
      state.ai.streaming = true;
      state.ai.lastError = '';
      state.ai.lastModel = dshBackendOn() ? 'DSH ' + (state.ai.dshProfile || 'headless') : state.ai.model;
      const toolDefs = !dshBackendOn() && window.XHGCS_AI_TOOLS && window.XHGCS_AI_TOOLS.enabled()
        ? window.XHGCS_AI_TOOLS.definitions()
        : null;
      // 工具往返只在本地 messages 里进行，不写进 state.ai.messages：对话记录里只留
      // 用户看得到的正文，工具调用过程通过 onTool 反馈给状态条。
      let messages = chatMessages(prompt);
      let result = null;
      let rounds = 0;
      let note = '';
      let contextRetried = false;
      // 每轮工具调用都记 {name,ok,ms,bytes}，随 meta.tools 交给界面/排障用
      const toolTrace = [];
      while (true) {
        try {
          result = await requestChat(prompt, state.ai.stream !== false, onDelta, controller.signal, {
            messages: messages,
            tools: toolDefs,
            dshMode: callbacks && callbacks.dshMode
          });
        } catch (err) {
          const info = err && err.info && err.info.kind ? err.info : diagnoseError(err);
          // 上游明确说上下文超长：用 0.6x 预算重建 messages 自动重试一次，仍超才抛给用户
          if (!contextRetried && info && info.kind === 'context_length') {
            contextRetried = true;
            messages = chatMessages(prompt, {
              budget: Math.max(AI_CONTEXT_BUDGET_MIN, Math.floor(contextBudgetChars() * 0.6))
            });
            text = '';
            reason = '';
            continue;
          }
          throw err;
        }
        const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
        if (!calls.length || !toolDefs) break;
        if (rounds >= MAX_TOOL_ROUNDS) {
          // 不静默吞掉：模型一直要工具却不收敛时，如实告诉用户为什么停。
          note = '（工具调用超过 ' + MAX_TOOL_ROUNDS + ' 轮仍未收敛，已停止）';
          break;
        }
        rounds += 1;
        messages.push({ role: 'assistant', content: result.content || '', tool_calls: calls });
        for (const call of calls) {
          const toolName = String((call && call.function && call.function.name) || (call && call.name) || 'tool');
          emitAiBusy(true, 'tool', toolName);
          const output = await window.XHGCS_AI_TOOLS.execute(call);
          toolTrace.push({
            name: String(output.name || toolName),
            ok: Boolean(output.ok),
            ms: Number(output.ms) || 0,
            bytes: Number(output.bytes) || 0
          });
          if (callbacks && callbacks.onTool) callbacks.onTool(output);
          messages.push({ role: 'tool', tool_call_id: output.id, content: output.content });
        }
        // 工具轮结束，回到聊天阶段（busy 仍为 true，界面上不用闪一下空闲）
        emitAiBusy(true, 'chat', prompt);
      }
      const content = text || result.content || '';
      // 空回复不能当成功返回：以前会留下一个空气泡，用户分不清是模型没答还是内容被吞了。
      if (!String(content || '').trim() && !String(reason || '').trim() && !note) {
        const empty = new Error('模型返回了空内容（HTTP 200 但没有正文）');
        empty.emptyResponse = true;
        throw empty;
      }
      state.ai.streaming = false;
      state.ai.lastOk = Date.now();
      lastToolTrace = toolTrace.slice();
      return {
        content: content, reasoning: reason || '', finish: result.finish || '', ms: Date.now() - started,
        model: state.ai.model, toolsUsed: rounds, note: note, toolTrace: lastToolTrace
      };
    } catch (err) {
      state.ai.streaming = false;
      const message = err && err.name === 'AbortError' ? '已停止生成' : (err && err.message ? err.message : String(err));
      state.ai.lastError = message;
      throw err;
    } finally {
      activeController = null;
    }
  }

  // 只向用户配置的那个端点要模型列表。不再扫描本机 1234/11434/… 这些端口：
  // 应用现在面向远程 API，那套「发现本地模型」的假设已经不成立了。
  async function refreshModels() {
    const endpoint = normUrl(state.ai.endpoint);
    if (!endpoint) throw new Error('请先填写 Endpoint');
    const payload = await X.mcpJson('/api/ai/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: endpoint, apiKey: state.ai.apiKey || '' })
    }, 20000);
    if (!payload || payload.ok === false) throw new Error(String((payload && payload.error) || '模型列表获取失败'));
    const models = Array.isArray(payload.models) ? payload.models : [];
    state.ai.models = models;
    state.ai.discovered = [{ endpoint: endpoint, models: models, label: endpoint.replace(/^https?:\/\//, '') }];
    if (!state.ai.model && models.length) state.ai.model = models[0];
    X.persist();
    return models;
  }

  async function testConnection(options) {
    options = options || {};
    const endpoint = normUrl(options.endpoint || state.ai.endpoint);
    const model = String(options.model || state.ai.model || '').trim();
    if (!endpoint || !model) return { ok: false, error: '请先填写 Endpoint 和模型名称' };
    const saved = {
      endpoint: state.ai.endpoint, model: state.ai.model, apiKey: state.ai.apiKey,
      useProxy: state.ai.useProxy, stream: state.ai.stream
    };
    state.ai.endpoint = endpoint;
    state.ai.model = model;
    state.ai.apiKey = String(options.apiKey || '');
    state.ai.useProxy = options.useProxy !== undefined ? options.useProxy : state.ai.useProxy;
    state.ai.stream = false;
    try {
      const result = await remoteReply('只回复 OK', { dshMode: 'answer' });
      const ok = Boolean(result.content || result.finish);
      state.ai.lastModel = model;
      state.ai.lastOk = Date.now();
      state.ai.lastError = ok ? '' : '模型没有返回内容';
      return { ok: ok, model: model, content: result.content || '', ms: result.ms || 0, error: state.ai.lastError || '' };
    } catch (err) {
      state.ai.lastError = err && err.message ? err.message : String(err);
      return { ok: false, error: state.ai.lastError };
    } finally {
      Object.assign(state.ai, saved);
      state.ai.streaming = false;
    }
  }

  function abort() {
    if (activeController) activeController.abort();
    state.ai.streaming = false;
  }

  async function chatOnceRaw(messages, options) {
    if (dshBackendOn()) return dshRun(messages, { mode: 'answer' });
    if (!state.ai.endpoint || !state.ai.model) throw new Error('请先在「设置 → AI 对话」里配置 API：选择 DSH Agent，或填写 Endpoint 与模型名');
    const opts = options || {};
    const payload = {
      model: state.ai.model,
      messages: messages,
      temperature: Number(opts.temperature != null ? opts.temperature : state.ai.temperature != null ? state.ai.temperature : 0.2) || 0,
      max_tokens: Math.max(64, Math.min(8192, Number(opts.maxTokens) || Number(state.ai.maxTokens) || 1024)),
      stream: false
    };
    if (state.ai.disableThinking !== false) payload.thinking = { type: 'disabled' };
    const attempt = async (proxy) => {
      const headers = proxy ? { 'Content-Type': 'application/json' } : headersWithKey();
      const body = proxy ? Object.assign({ endpoint: state.ai.endpoint, apiKey: state.ai.apiKey || '' }, payload) : payload;
      // 走桥就必须用 mcpJson：它会在 403 时重取令牌。桥每次重启都换令牌，
      // 用 requestJson 的话生成类调用会一直 403 到应用重启为止
      const data = proxy
        ? await X.mcpJson('/api/ai/chat', { method: 'POST', headers: headers, body: JSON.stringify(body) }, 180000)
        : await requestJson(chatUrl(state.ai.endpoint), { method: 'POST', headers: headers, body: JSON.stringify(body) }, 180000);
      const message = data && data.choices && data.choices[0] && data.choices[0].message || {};
      const text = String(message.content || message.reasoning_content || '');
      if (!text.trim()) {
        // 生成请求拿到 200 空正文：这不是「不合格」而是「空回复」，单独归类便于诊断。
        const empty = new Error('模型返回了空内容（HTTP 200 但没有正文）');
        empty.emptyResponse = true;
        throw empty;
      }
      return text;
    };
    if (state.ai.useProxy === false) return attempt(false);
    try {
      return await attempt(true);
    } catch (err) {
      const message = String(err && err.message || err);
      if (/fetch failed|failed to fetch|ECONNREFUSED|network|HTTP 404|not found|无法连接/i.test(message)) return attempt(false);
      throw err;
    }
  }

  // chatOnce 的所有失败都补上 err.info：生成入口与桥调用方靠它分类，不必再解析中文文案。
  async function chatOnce(messages, options) {
    try {
      return await chatOnceRaw(messages, options);
    } catch (err) {
      throw attachErrorInfo(err);
    }
  }

  function parseJsonObject(text) {
    const src = String(text || '');
    const fenced = src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
    for (const match of fenced) {
      const raw = match[1].replace(/,\s*([}\]])/g, '$1').trim();
      try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') return parsed; } catch (err) { /* try next */ }
    }
    const start = src.indexOf('{');
    const end = src.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const raw = src.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(raw); } catch (err) { /* ignore */ }
    }
    return null;
  }

  // 字符串感知地找出从 src[at] 起配平的大括号区间。不能只数 '{' 和 '}'：模型生成的
  // 代码里常有字符串或注释里的花括号，纯计数会把整块切错，动作随之丢失，
  // 而模型回复里明明写着「已生成」——用户只会觉得 AI 说了不算数。
  function balancedObject(src, at) {
    if (at < 0 || src[at] !== '{') return '';
    let depth = 0, inStr = '', esc = false;
    for (let i = at; i < src.length; i++) {
      const ch = src[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') { esc = true; continue; }
        if (ch === inStr) inStr = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return src.slice(at, i + 1);
      }
    }
    return '';
  }

  function extractViewCode(text) {
    const src = String(text || '');
    const at = src.indexOf('({');
    if (at < 0) return '';
    const body = balancedObject(src, at + 1);
    if (!body) return '';
    const end = at + 1 + body.length;
    // 视图代码是一个表达式 `({...})`，收尾的 ')' 要一起带上
    const close = src.slice(end).match(/^\s*\)/);
    return close ? src.slice(at, end + close[0].length) : '';
  }

  function parseViewSpec(reply) {
    const obj = parseJsonObject(reply);
    const payload = obj && (obj.view || obj);
    if (payload && payload.code) return { name: payload.name, icon: payload.icon, desc: payload.desc || payload.description, code: String(payload.code) };
    const codeMatch = String(reply || '').match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
    if (codeMatch && /mount/.test(codeMatch[1])) return { code: codeMatch[1].trim() };
    const extracted = extractViewCode(reply);
    if (extracted && /mount/.test(extracted)) return { code: extracted };
    throw new Error('模型没有返回可用的视图插件代码');
  }

  function jsonBlocks(text) {
    const blocks = [];
    const fenced = String(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
    for (const match of fenced) blocks.push(match[1].trim());
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf('"action"', cursor);
      if (start < 0) break;
      const open = text.lastIndexOf('{', start);
      if (open < 0) break;
      const block = balancedObject(text, open);
      if (block) blocks.push(block);
      cursor = block ? open + block.length : start + 8;
    }
    const actions = [];
    const seen = new Set();
    blocks.forEach((raw) => {
      const key = raw.trim();
      if (seen.has(key)) return;
      seen.add(key);
      const normalized = raw.replace(/,\s*([}\]])/g, '$1').trim();
      try {
        const parsed = JSON.parse(normalized);
        if (parsed && parsed.action) actions.push(parsed);
      } catch (err) {}
    });
    return actions;
  }

  async function saveComponentAction(action) {
    const spec = action.component || action;
    return runAiTask('component', 'AI 生成组件', action.description || action.name, async () => {
      // 聊天路径以前是零校验：字段缺失就地编造（formula 兜底 mean(x1,x2)、code 兜底一段
      // 罐头 Python），模型出错会被洗成「已生成」。现在先过生成入口那套校验器，不合格明确失败。
      const problem = checkComponentSpec(spec);
      if (problem) throw new Error('组件不合格：' + problem);
      const kind = String(spec.kind).toLowerCase() === 'python' ? 'python' : 'formula';
      const config = Object.assign({}, spec.config || {}, kind === 'python'
        ? { code: String(spec.config.code) }
        : { formula: String(spec.config.formula).trim() });
      const component = X.addComponent({
        id: spec.id,
        name: String(spec.name).slice(0, 48),
        description: String(spec.description || 'AI 生成：可复用计算组件').slice(0, 200),
        kind: kind,
        inputs: spec.inputs,
        outputs: spec.outputs,
        parameters: Array.isArray(spec.parameters) ? spec.parameters : [],
        config: config,
        origin: 'ai-model'
      });
      window.dispatchEvent(new CustomEvent('xhgcs:components-changed', { detail: { action: 'add', component: component } }));
      return { type: 'component', id: component.id, name: component.name, message: '已生成可复用组件「' + component.name + '」并写入组件库。' };
    });
  }

  async function saveScriptAction(action) {
    const spec = action.script || action;
    return runAiTask('script', 'AI 生成脚本', action.description || action.name, async () => {
      // 同上：以前 inputs 缺失就硬塞 ['ch1']、formula 缺失就编一个 mean(...)、code 缺失就拿
      // 「分析」编辑器里现存的 Python 顶上 —— 三处都把模型的错误洗成了成功。
      const normalized = normalizeScriptSpec(spec);
      const problem = checkScriptSpec(normalized);
      if (problem) throw new Error('脚本不合格：' + problem);
      const type = normalized.type === 'python' ? 'python' : 'functions';
      const inputs = Array.from(new Set(normalized.inputs.filter((id) => X.findChannel(id)))).slice(0, 12);
      const script = {
        id: X.uid('script'),
        name: String(normalized.name).slice(0, 40),
        type: type,
        formula: type === 'functions' ? normalizeFormulaIds(String(normalized.formula).trim()) : '',
        code: type === 'python' ? String(normalized.code) : '',
        inputs: inputs,
        outputs: actionOutputs(normalized.outputs),
        builtin: false,
        origin: 'ai-model',
        description: 'AI 生成：' + String(action.description || action.name || '').slice(0, 120)
      };
      // run:false 以前让聊天动作完全跳过执行，于是坏公式也被标成「已应用」；试运行是
      // 校验（算一次）而不是交付状态，一律要过，不然确认卡片的 ✔ 就还是谎话。
      const trial = await commitScriptArtifact(script, inputs);
      if (!trial.ok && !trial.cannotVerify) throw trialFailure(trial);
      window.dispatchEvent(new CustomEvent('xhgcs:scripts-changed'));
      return {
        type: 'script', id: script.id, name: script.name, verified: Boolean(trial.ok),
        message: trial.ok
          ? '已生成并运行脚本「' + script.name + '」，试运行输出：' + trial.text + '；已建立 ' + script.outputs.length + ' 个脚本通道。'
          : unverifiedScriptMessage(script.name, trial.error)
      };
    });
  }

  async function saveEngineAction(action) {
    const spec = action.engine || action.config || action;
    return runAiTask('engine', 'AI 生成引擎', action.description || action.name, async () => {
      const P = window.XHGCS_PROTOCOL || {};
      // 以前 preset 缺失就静默当成 json：用户要的 ASCII 引擎会变成 JSON 引擎，还照样显示成功。
      const probe = engineProbeSpec(action, spec);
      const presetKey = probe.preset;
      const problem = checkEngineSpec(probe);
      if (problem) throw new Error('数据引擎不合格：' + problem);
      const preset = P.presetByKey && P.presetByKey(presetKey);
      const base = P.presetEngine && preset ? P.presetEngine(preset, {}) : {};
      const config = Object.assign({}, base, spec, {
        name: String(action.name || spec.name || base.name || 'AI 数据引擎').slice(0, 40),
        description: 'AI 生成：' + String(action.description || spec.description || '').slice(0, 140)
      });
      delete config.preset;
      delete config.presetId;
      if (String(config.protocol || '').toUpperCase() === 'WED') config.protocolId = String(config.protocolId || 'wed-telemetry');
      const engine = X.addEngine(config);
      // 和「AI 生成引擎」那条走同一道守卫：切引擎会清空串口缓冲，正收着真实数据时别静默抢掉
      const busy = Boolean(state.serial.connected && state.serial.running && !state.simulation.enabled);
      let message = '已生成数据引擎「' + engine.name + '」并设为当前引擎。';
      if (busy) {
        message = '已生成数据引擎「' + engine.name + '」。当前正在接收真实串口数据，没有替你切换（切引擎会清空串口缓冲），去「串口」页手动应用即可。';
      } else {
        X.setActiveEngine(engine.id);
        if (String(engine.protocol || '').toUpperCase() === 'WED') X.applyProtocolChannels(engine);
      }
      window.dispatchEvent(new CustomEvent('xhgcs:engines-changed'));
      return { type: 'engine', id: engine.id, name: engine.name, message: message };
    });
  }

  async function saveGraphAction(action) {
    const spec = action.graph || action;
    const G = window.XHGCS_GRAPH;
    if (!G) throw new Error('节点画布模块未加载');
    return runAiTask('graph', 'AI 生成画布', action.description || action.name, async () => {
      // 以前 nodes 缺失就静默退回本地罐头模板，回复里还照样写「已生成节点画布」。
      // checkGraphSpec 是现成的（生成入口一直在用），聊天路径接上就行。
      const problem = checkGraphSpec(spec);
      if (problem) throw new Error('画布不合格：' + problem);
      const graph = {
        nodes: spec.nodes,
        edges: Array.isArray(spec.edges) ? spec.edges : [],
        viewport: spec.viewport || { x: 70, y: 70, zoom: 1 },
        autoRun: Boolean(spec.autoRun),
        initialized: true
      };
      const script = G.graphToScript(graph, String(action.name || spec.name || 'AI 节点画布').slice(0, 40));
      // 和生成入口同一道试运行闸门：画布画不出数就先别切画布，也别报已生成。
      const trial = await commitScriptArtifact(script, script.inputs);
      if (!trial.ok) throw trialFailure(trial);
      G.setCanvas(graph);
      if (window.XHGCS_GRAPH_UI) window.XHGCS_GRAPH_UI.render();
      window.dispatchEvent(new CustomEvent('xhgcs:scripts-changed'));
      return { type: 'graph', id: script.id, name: script.name, message: '已生成并运行节点画布「' + script.name + '」，试运行输出：' + trial.text + '；已保存到自定义模块。' };
    });
  }

  async function saveViewAction(action) {
    const spec = action.view || action;
    return runAiTask('view', 'AI 生成视图', action.description || action.name, async () => {
      const V = window.XHGCS_VIEWS;
      const B = window.XHGCS_VIEW_BLUEPRINT;
      if (!V || !V.saveViewSpec) throw new Error('视图插件模块未加载');
      const label = spec.name || action.description || action.name || 'AI 可视化视图';
      let code = String(spec.code || '');
      let origin = 'ai-model';
      let note = '';
      // 先自检再落库：画歪/画空/溢出宿主这类"能编译但难看"的代码不再进脚本库
      if (code) {
        const state = await evaluateViewCode(code);
        if (state.fix) {
          const fallbackCode = B && B.compile
            ? B.compile({}, label)
            : (V.fallbackTemplate ? V.fallbackTemplate(label) : null);
          if (fallbackCode) {
            code = fallbackCode.code;
            origin = 'ai-model-fallback';
            note = '首版未通过自检（' + state.fix + '），已改用本地模板。';
          }
        }
      }
      let def;
      try {
        def = V.saveViewSpec({
          name: label,
          icon: spec.icon || '◈',
          desc: spec.desc || spec.description || 'AI 生成的可视化视图',
          code: code,
          origin: origin
        });
      } catch (err) {
        const fallback = B && B.compile
          ? B.compile({}, label)
          : (V.fallbackTemplate ? V.fallbackTemplate(label) : null);
        if (!fallback) throw err;
        def = V.saveViewSpec(Object.assign({ origin: 'ai-model-fallback' }, fallback));
        note = '代码不合规（' + ((err && err.message) || err) + '），已改用本地模板。';
      }
      if (V.switchSubView) V.switchSubView(def.id);
      else if (V.activateView) V.activateView(def.id);
      // 自检：真挂载跑几帧，把「画没画出东西 / 画风是否走令牌」如实告诉用户，而不是只说"已生成"
      const verify = window.XHGCS_VIEW_VERIFY;
      const report = verify && verify.verify ? await verify.verify(def.code, { frames: 5 }) : null;
      return {
        type: 'view',
        id: def.id,
        name: def.name,
        checked: Boolean(report),
        message: '已生成可视化视图「' + def.name + '」并切换到该视图。' + note + (report ? verify.summarize(report) : '（自检模块未加载）')
      };
    });
  }

  /**
   * 看板动作：模型只给窄规格，布局与绑定由内核 composeBoard 生成。
   * 落库走 XHGCS_CORE.ui.applyBoard（它会写 xhgcs.ui.doc.v1 并打开全屏看板）。
   */
  async function saveBoardAction(action) {
    const spec = action.board || action;
    return runAiTask('board', 'AI 生成看板', spec.name || action.description, async () => {
      const core = window.XHGCS_CORE;
      if (!core || !core.ui || typeof core.ui.applyBoard !== 'function') {
        throw new Error('插件内核未加载（assets/js/core.bundle.js），无法生成看板');
      }
      const result = core.ui.applyBoard(spec);
      if (!result || !result.ok) throw new Error((result && result.error) || '看板生成失败');
      const warn = result.warnings && result.warnings.length ? '；' + result.warnings.join('；') : '';
      return {
        type: 'board',
        id: result.id,
        name: result.name,
        message: '已生成看板「' + result.name + '」并全屏运行（' + result.widgets + ' 个控件）' + warn
      };
    });
  }

  /**
   * 看板增量补丁：只改用户点名的那几处，失败不改文档。
   * 落库走 XHGCS_CORE.boards.applyPatch（校验 + 原子应用 + 备份槽）。
   */
  async function saveBoardPatchAction(action) {
    const spec = action.board_patch || action.patch || action;
    return runAiTask('board_patch', 'AI 修改看板', (spec.ops || []).length + ' 个操作', async () => {
      const core = window.XHGCS_CORE;
      if (!core || !core.boards || typeof core.boards.applyPatch !== 'function') {
        throw new Error('插件内核未加载（assets/js/core.bundle.js），无法修改看板');
      }
      const result = core.boards.applyPatch({ ops: spec.ops });
      if (!result || !result.ok) throw new Error((result && (result.error || result.errors && result.errors.join('；'))) || '补丁被拒绝');
      return {
        type: 'board_patch',
        id: result.active && result.active.id,
        name: result.active && result.active.name,
        message: '已修改看板「' + (result.active && result.active.name) + '」：' + (result.summary || '') +
          '（可用命令面板「回退看板补丁」还原）'
      };
    });
  }

  async function executeAction(action) {
    const type = String(action.action || '').toLowerCase();
    if (type === 'script' || type === 'function' || type === 'python') return saveScriptAction(action);
    if (type === 'engine' || type === 'protocol') return saveEngineAction(action);
    if (type === 'component') return saveComponentAction(action);
    if (type === 'view' || type === 'visual' || type === 'widget') return saveViewAction(action);
    if (type === 'graph' || type === 'canvas') return saveGraphAction(action);
    if (type === 'board' || type === 'dashboard') return saveBoardAction(action);
    if (type === 'board_patch' || type === 'patch_board') return saveBoardPatchAction(action);
    if (type === 'status' || type === 'snapshot' || type === 'query') return { type: 'status', ok: true, message: snapshotSummary() };
    return { type: type || 'ai', ok: false, message: '未知动作：' + type };
  }

  async function runActions(list) {
    const results = [];
    for (const action of list) {
      try {
        const result = await executeAction(action);
        results.push({ action: action.action, ok: true, message: result && result.message || '执行完成' });
      } catch (err) {
        results.push({ action: action.action || 'ai', ok: false, message: err && err.message ? err.message : String(err) });
      }
    }
    return results;
  }

  async function executeReplyActions(reply) {
    return runActions(jsonBlocks(reply));
  }

  // ---- 动作确认 ----
  // 动作块原来在回复到达时就执行，没有预览也没有撤销：模型只要在正文里写一个
  // {"action":"..."}，脚本 / 视图 / 引擎就直接落库，用户连它会做什么都没看到。
  // 现在「会创建东西」的动作先只做校验、出一张卡片，等用户点「应用」再落库。
  // status / snapshot / query 是只读的，不进这道门。
  // 门禁来自注册表：新增一类产物不用再同步三张表。
  const GATED_ACTIONS = SPEC.gated;

  // 「本次会话总是允许」只活在内存里、不落盘：下次打开应用仍然要确认。
  let sessionAutoApply = false;
  function autoApplyThisSession() { return sessionAutoApply; }
  function setAutoApply(value) { sessionAutoApply = Boolean(value); }

  function actionType(action) {
    return String((action && action.action) || '').toLowerCase();
  }

  // 只校验、不落库：把一个动作变成卡片上那几行。预览与真正执行共用注册表里的同一套
  // check，不然会出现「卡片说没问题、点应用却失败」。
  function previewAction(action) {
    const type = actionType(action);
    const descriptor = SPEC.get(type);
    if (!descriptor) return { type: type || 'ai', ok: false, title: '动作', error: '未知动作：' + (type || '(空)') };
    return Object.assign({ type: type }, descriptor.preview(descriptor.pick(action), action));
  }

  function buildPendingActions(reply) {
    const immediate = [];
    const pending = [];
    jsonBlocks(reply).forEach((action, index) => {
      if (GATED_ACTIONS.indexOf(actionType(action)) < 0) { immediate.push(action); return; }
      pending.push({ id: 'pa' + index, action: action, preview: previewAction(action), status: 'pending', result: '' });
    });
    return { immediate: immediate, pending: pending };
  }

  function actionLine(item) {
    if (item && item.status) {
      if (item.status === 'applied') return '✔ ' + (item.result || '已应用');
      if (item.status === 'failed') return '✘ ' + (item.result || '应用失败');
      return '';                       // pending / discarded 不写进正文
    }
    return (item && item.ok ? '✔ ' : '✘ ') + ((item && item.message) || '');
  }

  // 正文 = 模型原话 + 已执行动作的结果 + 待确认提示。应用 / 丢弃之后按同一套重算，
  // 免得正文里永远挂着「有 N 个动作等你确认」。
  function composeAssistantText(base, meta) {
    const info = meta || {};
    const parts = [];
    const text = String(base || '');
    const lines = (info.actions || []).concat(info.pending || []).map(actionLine).filter(Boolean);
    if (text.trim()) parts.push(text);
    if (lines.length) parts.push(lines.join('\n'));
    const waiting = (info.pending || []).filter((item) => item.status === 'pending').length;
    if (waiting) parts.push('有 ' + waiting + ' 个动作等你确认，见下方卡片。');
    if (info.truncated) parts.push('（回复达到 Max Tokens 上限被截断，动作块可能不完整。可在「设置 → AI 对话」调大 Max Tokens 后重试。）');
    return parts.join('\n\n');
  }

  function rerenderAiMessages() {
    if (window.XHGCS_AI_UI && window.XHGCS_AI_UI.renderMessages) window.XHGCS_AI_UI.renderMessages();
  }

  function findAiMessage(messageId) {
    return (state.ai.messages || []).find((item) => item.id === messageId) || null;
  }

  async function applyPendingActions(messageId) {
    const message = findAiMessage(messageId);
    if (!message || !message.meta || !Array.isArray(message.meta.pending)) return [];
    const waiting = message.meta.pending.filter((item) => item.status === 'pending');
    if (!waiting.length) return [];
    const runnable = waiting.filter((item) => item.preview && item.preview.ok);
    const results = runnable.length ? await runActions(runnable.map((item) => item.action)) : [];
    let cursor = 0;
    waiting.forEach((item) => {
      if (item.preview && item.preview.ok) {
        const result = results[cursor];
        cursor += 1;
        item.status = result && result.ok ? 'applied' : 'failed';
        item.result = result ? result.message : '';
      } else {
        item.status = 'failed';
        item.result = (item.preview && item.preview.error) || '未通过校验';
      }
    });
    X.updateAiMessage(messageId, { content: composeAssistantText(message.raw, message.meta), meta: message.meta });
    rerenderAiMessages();
    return results;
  }

  function discardPendingActions(messageId) {
    const message = findAiMessage(messageId);
    if (!message || !message.meta || !Array.isArray(message.meta.pending)) return;
    message.meta.pending.forEach((item) => {
      if (item.status === 'pending') { item.status = 'discarded'; item.result = '已丢弃'; }
    });
    X.updateAiMessage(messageId, { content: composeAssistantText(message.raw, message.meta), meta: message.meta });
    rerenderAiMessages();
  }

  async function send(text, callbacks) {
    const prompt = String(text || '').trim();
    if (!prompt) return { ok: true, content: '' };
    if (!dshBackendOn() && (!state.ai.endpoint || !state.ai.model)) {
      // 内置意图匹配已经删掉了：没配 API 就如实告诉用户，不再用关键词表假装回答。
      const reply = '还没有配置 AI 后端。请在「设置 → AI 对话」里选择 DSH Agent，或填写 API 的 Endpoint 与模型名。';
      const ncInfo = diagnoseError(new Error('未配置 AI 后端'));
      state.ai.lastErrorDetail = Object.assign({}, ncInfo, {
        at: Date.now(), endpoint: String(state.ai.endpoint || ''), model: String(state.ai.model || ''), ms: 0
      });
      emitAiError(ncInfo);
      X.addAiMessage('user', prompt);
      X.addAiMessage('assistant', reply, { source: 'local' });
      publishSpeechTask(reply, 'local', '本地 AI 回复语音');
      recordQuality('chat', 'AI 对话', false, ncInfo.kind, 0);
      if (callbacks && callbacks.onDone) callbacks.onDone(reply);
      return { ok: false, content: reply, error: '未配置 AI 后端' };
    }
    X.addAiMessage('user', prompt);
    const assistant = X.addAiMessage('assistant', '', { source: 'remote', streaming: true, model: aiBackendLabel() });
    const controller = new AbortController();
    activeController = controller;
    state.ai.streaming = true;
    state.ai.lastModel = aiBackendLabel();
    state.ai.lastError = '';
    state.ai.lastErrorDetail = null;
    const startedAt = Date.now();
    let content = '';
    let reason = '';
    if (callbacks && callbacks.onStart) callbacks.onStart(assistant);
    emitAiBusy(true, 'chat', prompt);
    try {
      const result = await remoteReply(prompt, {
        signal: controller.signal,
        onDelta: (delta) => {
          content += delta;
          X.updateAiMessage(assistant.id, { content: content }, false);
          if (callbacks && callbacks.onDelta) callbacks.onDelta(delta);
        },
        onReason: (delta) => {
          reason += delta;
          if (callbacks && callbacks.onReason) callbacks.onReason(delta, reason);
        },
        onTool: (output) => {
          if (callbacks && callbacks.onTool) callbacks.onTool(output);
        }
      });
      // 非流式后端（DSH、或关掉「流式输出」的本地模型）没有 onDelta，正文只在 result.content 里。
      if (!content && result.content) content = result.content;
      // 工具循环没收敛时如实说出来，别让回复看起来是完整答案。
      if (result.note) content = content ? content + '\n\n' + result.note : result.note;
      // 会创建东西的动作先只出预告，等用户点「应用」；只读动作（状态查询）照旧立刻执行。
      const built = buildPendingActions(content);
      const auto = autoApplyThisSession();
      const pending = auto ? [] : built.pending;
      const ran = built.immediate.concat(auto ? built.pending.map((item) => item.action) : []);
      const actions = ran.length ? await runActions(ran) : [];
      let shown = content;
      if (!shown.trim() && result.reasoning) {
        const tail = String(result.reasoning).replace(/\s+/g, ' ').trim().slice(-240);
        shown = '模型只返回了思考过程，没有输出最终内容。请在“设置 → AI 对话”关闭模型思考后重试。' + (tail ? '\n\n推理片段：' + tail : '');
      }
      // finish_reason 以前抓了却从不比较：被 max_tokens 截断的回复会连半截 JSON 动作块一起
      // 当完整答案交付，而动作块在 jsonBlocks 里解析失败后无声消失，用户只看到模型说「已生成」。
      const meta = {
        source: 'remote', model: aiBackendLabel(), streaming: false, ms: result.ms,
        finish: result.finish, truncated: String(result.finish || '') === 'length',
        actions: actions, pending: pending,
        // 工具循环可观测：这一轮调了哪些工具、各自耗时/回传大小
        tools: Array.isArray(result.toolTrace) ? result.toolTrace : []
      };
      const final = composeAssistantText(shown, meta);
      state.ai.lastErrorDetail = null;
      X.updateAiMessage(assistant.id, { content: final, raw: content, meta: meta });
      X.persist();
      publishSpeechTask(final, 'remote', aiBackendLabel() + ' 回复语音');
      recordQuality('chat', 'AI 对话', true, '', Date.now() - startedAt);
      if (callbacks && callbacks.onDone) callbacks.onDone(final);
      return { ok: true, content: final, actions: actions };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /已停止/.test(String(err && err.message || '')));
      const error = aborted ? '已停止生成' : (err && err.message ? err.message : String(err));
      const info = diagnoseError(err);
      // lastError 保持兼容（原始字符串给现有界面压条），结构化信息另存一份供面板/MCP 用
      state.ai.lastErrorDetail = Object.assign({}, info, {
        at: Date.now(),
        endpoint: dshBackendOn() ? 'dsh:' + (state.ai.dshProfile || 'headless') : String(state.ai.endpoint || ''),
        model: aiBackendLabel(),
        ms: Date.now() - startedAt
      });
      // 原始报错交给界面压成一条提示，不再铺进气泡正文（整段 ECONNREFUSED 很割裂）
      const final = content || (aborted ? '（已停止）' : '');
      state.ai.lastError = aborted ? '' : error;
      // 停止不算错误（不弹报错事件）；真失败才向订阅方广播可读分类
      if (!aborted) {
        recordQuality('chat', 'AI 对话', false, info.kind, Date.now() - startedAt);
        emitAiError(info);
      }
      X.updateAiMessage(assistant.id, {
        content: final,
        meta: { source: 'remote', model: state.ai.model, streaming: false, error: aborted ? '' : error, errorInfo: info }
      });
      X.persist();
      if (callbacks && callbacks.onDone) callbacks.onDone(final, error);
      return { ok: false, content: final, error: error, errorInfo: info };
    } finally {
      state.ai.streaming = false;
      activeController = null;
      emitAiBusy(false, 'chat', prompt);
    }
  }

  function clearHistory() {
    X.clearAiMessages();
  }

  window.XHGCS_AI = {
    send: send,
    generateScript: generateScript,
    generateEngine: generateEngine,
    generateGraph: generateGraph,
    generateComponent: generateComponent,
    generateView: generateView,
    composeView: composeView,
    classifyViewPrompt: classifyViewPrompt,
    contextText: contextText,
    snapshotSummary: snapshotSummary,
    clearHistory: clearHistory,
    // 最近一轮工具轨迹（空态 []，绝不抛异常）
    toolTrace: toolTrace,
    // 最近一次构造的上下文用量 {chars,estTokens,turns,trimmed,budget}，空态零值
    contextUsage: contextUsage,
    // 生成质量轻量统计（内存环形缓冲，不落盘不上报）：lastN(n) 摘要 / qualityStats() 汇总
    lastN: lastN,
    qualityStats: qualityStats,
    refreshModels: refreshModels,
    testConnection: testConnection,
    dshStatus: dshStatus,
    runDsh: (task, options) => dshRun([{ role: 'user', content: String(task || '') }], options),
    dshBackend: dshBackendOn,
    abort: abort,
    // 错误诊断（纯函数）：界面/MCP 调用方不必各自解析中文错误文案
    diagnose: diagnoseError,
    executeReplyActions: executeReplyActions,
    previewAction: previewAction,
    buildPendingActions: buildPendingActions,
    composeAssistantText: composeAssistantText,
    applyPendingActions: applyPendingActions,
    discardPendingActions: discardPendingActions,
    setAutoApply: setAutoApply,
    autoApplyThisSession: autoApplyThisSession
  };
})();
