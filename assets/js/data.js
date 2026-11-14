(function () {
  'use strict';

  const STORAGE_KEY = 'xhgcs.pro.config.v1';
  const LOG_LIMIT = 300;
  // 单条 AI 消息的存储上限。原来写死 4000，而流式输出是每收到一个 delta 就整条回写一次，
  // 于是「生成的视图 / 脚本体」这类长回复会在第 4000 个字无声断掉——界面看着像模型自己
  // 没写完。上限也不能开太大：整份配置（持久化 40 条消息）要塞进 localStorage。
  const AI_MESSAGE_LIMIT = 20000;
  const AI_STORAGE_MESSAGE_LIMIT = 40;
  const AI_STORAGE_TASK_LIMIT = 80;
  const DELETED_ID_LIMIT = 200;
  const CHANNEL_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#a3e635', '#60a5fa', '#f87171', '#c084fc', '#4ade80', '#facc15', '#fb7185', '#2dd4bf', '#fdba74'];
  // 波形代号到中文名的唯一来源：通道配置弹窗与模拟页的「通道信号一览」都读它，
  // 免得同一份映射在界面上两个地方各写一遍、改一处漏一处
  const WAVE_LABELS = { sine: '正弦', triangle: '三角', square: '方波', pulse: '脉冲', noise: '噪声' };
  // 图种到中文名：图页标签用它。views-core.js 注册内置视图时是同一批名字，
  // 改名字时两处要一起看（没有第二份映射，别在别处再写一遍）。
  const VIEW_LABELS = { wave: '波形图', bar: '柱状图', table: '数据表', gauge: '仪表', map: '地图' };
  let channelColorCursor = 0;
  // 真实串口的时间轴锚点。原来每收到一帧就 state.t += intervalMs/1000，等于把「界面里配的
  // 采样间隔」当成「设备实际的采样间隔」：设备按 1Hz 送数会被记成 10Hz，中途断线 50 分钟
  // 在 CSV 里也是首尾相接、完全看不出来。改成用真实时钟推进，断线就体现为 t 的跳变。
  let serialClock = null;

  function usedChannelColors() {
    const ref = window.XHGCS && window.XHGCS.state;
    if (!ref) return null;
    return new Set(ref.channels.concat(ref.scriptChannels).map((ch) => ch.color).filter(Boolean));
  }

  function pickChannelColor(used) {
    const start = channelColorCursor % CHANNEL_COLORS.length;
    for (let i = 0; i < CHANNEL_COLORS.length; i++) {
      const index = (start + i) % CHANNEL_COLORS.length;
      const color = CHANNEL_COLORS[index];
      if (!used || !used.has(color)) {
        channelColorCursor = (index + 1) % CHANNEL_COLORS.length;
        return color;
      }
    }
    const color = CHANNEL_COLORS[start];
    channelColorCursor = (start + 1) % CHANNEL_COLORS.length;
    return color;
  }

  function nextChannelColor() {
    return pickChannelColor(usedChannelColors());
  }

  function peekChannelColor() {
    const used = usedChannelColors();
    const start = channelColorCursor % CHANNEL_COLORS.length;
    for (let i = 0; i < CHANNEL_COLORS.length; i++) {
      const color = CHANNEL_COLORS[(start + i) % CHANNEL_COLORS.length];
      if (!used || !used.has(color)) return color;
    }
    return CHANNEL_COLORS[start];
  }

  const channelTemplate = {
    scale: 1,
    offset: 0,
    range: [0, 100],
    base: 50,
    amp: 26,
    freq: 0.9,
    noise: 1.5,
    waveform: 'sine',
    visible: true,
    data: []
  };

  const defaults = [
    { id: 'ch1', name: '电压', unit: 'V', color: '#38bdf8', range: [0, 30], base: 24, amp: 2.2, freq: 0.36, noise: 0.18, waveform: 'sine' },
    { id: 'ch2', name: '电流', unit: 'A', color: '#34d399', range: [0, 50], base: 18, amp: 9, freq: 0.72, noise: 0.6, waveform: 'sine' },
    { id: 'ch3', name: '高度', unit: 'm', color: '#fbbf24', range: [0, 300], base: 132, amp: 46, freq: 0.12, noise: 1.2, waveform: 'sine' },
    { id: 'ch4', name: '速度', unit: 'm/s', color: '#f472b6', range: [0, 60], base: 24, amp: 12, freq: 0.46, noise: 0.45, waveform: 'sine' },
    { id: 'ch5', name: '机舱温度', unit: '°C', color: '#a78bfa', range: [0, 120], base: 48, amp: 9, freq: 0.06, noise: 0.25, waveform: 'sine' }
  ];

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }
  function fmt(v, digits) {
    const d = digits == null ? 1 : digits;
    return Number(v).toFixed(d);
  }
  // 统计卡片里的长数字压缩显示（22089 -> 22.1K），防止把卡片撑破；
  // 只有真的压缩过（显示和精确值数字不同）才在 title 里挂精确值，见 setCounter
  function compactCount(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    if (abs < 10000) return String(Math.round(n));
    const suffixes = ['', 'K', 'M', 'G', 'T'];
    let index = 0;
    let text = '';
    for (;;) {
      const scaled = abs / Math.pow(1000, index);
      text = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
      if (Number(text) < 1000 || index >= suffixes.length - 1) break;
      index++;
    }
    return (n < 0 ? '-' : '') + String(Number(text)) + suffixes[index];
  }
  // 写入统计卡片：短文本用于显示，精确值放进 tooltip
  function setCounter(el, value) {
    if (!el) return;
    const exact = Number(value) || 0;
    const text = compactCount(exact);
    if (el.textContent !== text) el.textContent = text;
    const len = String(text.length);
    if (el.dataset.len !== len) el.dataset.len = len;
    // 0 值打标：样式上退成次要色，别让「0 待处理 / 0 错误」也用警示色抢注意力
    if (exact === 0) {
      if (el.dataset.zero !== '1') el.dataset.zero = '1';
    } else if (el.dataset.zero) {
      delete el.dataset.zero;
    }
    // tooltip 只在显示被压缩过（12345 → 12.3K）时才给精确值：
    // 短数字上挂一个同样的 tooltip（29 上挂 title="29"、4324 上挂 "4,324"）等于同一句话说两遍。
    const title = exact.toLocaleString('en-US');
    if (title.replace(/[^\d]/g, '') === String(text).replace(/[^\d]/g, '')) {
      if (el.title) el.removeAttribute('title');
    } else if (el.title !== title) {
      el.title = title;
    }
  }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // MCP 桥接地址：state.mcp.endpoint 是用户可改的，统一在这里拼接，
  // 免得 bridge / ai / analysis / graph 各写一份（末尾斜杠、空值各处理一次）
  function mcpUrl(path) {
    return String(state.mcp.endpoint || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '') + path;
  }

  // 本地桥的写操作令牌。装机版从 preload 的受限 IPC 取（/api/health 不再返回令牌）；
  // 浏览器直开时退回健康检查（开发模式由 services 注入 XHGCS_HEALTH_TOKEN=1）。
  // 桥重启后会换令牌，mcpFetch 遇到 403 会重取。
  let mcpToken = '';

  async function ensureMcpToken() {
    if (mcpToken) return mcpToken;
    try {
      const desktop = window.XHGCS_DESKTOP;
      if (desktop && desktop.ai && desktop.ai.token) {
        const token = await desktop.ai.token();
        if (token) mcpToken = String(token);
      }
    } catch (err) {
      // 桌面通道不可用时继续走健康检查
    }
    if (mcpToken) return mcpToken;
    try {
      const response = await fetch(mcpUrl('/api/health'), { cache: 'no-store' });
      const data = await response.json();
      if (data && data.token) mcpToken = String(data.token);
    } catch (err) {
      // 桥没起时拿不到令牌，属于正常情况（后面每次调用还会再试）
    }
    return mcpToken;
  }

  function mcpHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    if (mcpToken) headers['X-XHGCS-Token'] = mcpToken;
    return headers;
  }

  // 调用本地桥的唯一入口：自动带令牌，令牌过期（桥重启）就重取一次再试
  async function mcpFetch(path, options) {
    const opts = Object.assign({}, options || {});
    const attempt = () => fetch(mcpUrl(path), Object.assign({}, opts, { headers: mcpHeaders(opts.headers) }));
    await ensureMcpToken();
    let response = await attempt();
    if (response.status === 403) {
      mcpToken = '';
      await ensureMcpToken();
      response = await attempt();
    }
    return response;
  }

  // 带超时的桥调用并直接拿 JSON。凡是要走桥的请求都该用它而不是裸 fetch/requestJson：
  // 后者不会在 403 时重取令牌，桥一重启（独立运行时每次都是新令牌）那条路就会一直 403
  // ——「重启本地服务之后所有 AI 生成都报 403」就是这么来的。
  async function mcpJson(path, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
    try {
      const response = await mcpFetch(path, Object.assign({}, options || {}, { signal: controller.signal }));
      if (!response.ok) {
        // 桥代理路径（useProxy=true）的上游 4xx body 里才有关键词（context_length_exceeded /
        // insufficient_quota…）。只抛「HTTP 400」会让 P2 的诊断退化成 upstream，读出来带上。
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

  // 把「只有一句 return 的 Python」降级成函数表达式，桥没起时脚本也能跑
  function pythonOneLine(code) {
    const clean = String(code || '').replace(/#.*$/gm, '').replace(/import\s+[\w.]+\s*/g, '').replace(/np\./g, '').replace(/math\./g, '').trim();
    if (/def\s|for\s|while\s|if\s/.test(clean)) return '';
    const match = clean.match(/return\s+(.+)$/m);
    return match ? match[1].trim() : '';
  }

  function makeChannel(partial) {
    const ch = Object.assign({}, channelTemplate, { id: uid('ch'), name: '新通道', unit: '', color: '' }, partial || {});
    if (!ch.color || ch.color === 'auto') ch.color = nextChannelColor();
    ch.range = Array.isArray(ch.range) ? [Number(ch.range[0]), Number(ch.range[1])] : [0, 100];
    ch.data = [];
    ch.alertState = null;
    ch.faultUntil = 0;
    ch.faultKind = '';
    // 阈值默认不设。原来这里凭 range/base/amp/noise 猜一对上下限，而真实信号的范围在
    // 接上设备之前谁也不知道：原始 ADC 通道的量程被 65535（传感器无数据）撑开之后，
    // 按量程比例推出来的线会把所有正常值都判成越限 —— 一开机满屏告警就是这么来的。
    // null = 这一侧不报警，用户在「告警」页填了才生效。
    const numOrNull = (value) => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    ch.warnHigh = numOrNull(ch.warnHigh);
    ch.warnLow = numOrNull(ch.warnLow);
    return ch;
  }

  function defaultWaypoints() {
    return [
      { id: 'wp1', x: 0, y: 0, name: '基地' },
      { id: 'wp2', x: 90, y: 45, name: 'WP-2' },
      { id: 'wp3', x: 155, y: 130, name: 'WP-3' },
      { id: 'wp4', x: 70, y: 205, name: 'WP-4' },
      { id: 'wp5', x: -70, y: 165, name: 'WP-5' },
      { id: 'wp6', x: -150, y: 60, name: 'WP-6' }
    ];
  }

  function defaultEngines() {
    return [
      { id: 'engine-json', name: 'JSON 数据引擎', protocol: 'JSON', header: '{', tail: '}', terminator: '\n', checksum: 'NONE', byteOrder: 'little', hexScale: 10, active: true, description: '标准 JSON 遥测帧' },
      { id: 'engine-ascii', name: 'ASCII 字段引擎', protocol: 'ASCII', header: 'XH[', tail: ']', terminator: '\r\n', checksum: 'CRC16', byteOrder: 'little', hexScale: 10, active: false, description: '逗号分隔键值字段' },
      { id: 'engine-hex', name: 'HEX 二进制引擎', protocol: 'HEX', header: 'AA55', tail: '55AA', terminator: '', checksum: 'CRC32', byteOrder: 'little', hexScale: 10, active: false, description: '十六进制遥测帧' },
      { id: 'engine-wed', name: 'WED 遥测协议', protocol: 'WED', protocolId: 'wed-telemetry', header: '55AA', tail: '', terminator: '', checksum: 'SUM8', byteOrder: 'big', hexScale: 1, payloadBytes: 40, channelCount: 20, active: false, description: '55AA+40B+SUM8，20 通道 uint16 大端遥测' },
      { id: 'engine-wed-fc', name: 'WED 飞控遥测', protocol: 'WED', protocolId: 'wed-fc', header: '55AA', tail: '', terminator: '', checksum: 'SUM8', byteOrder: 'big', hexScale: 1, payloadBytes: 40, channelCount: 20, active: false, description: '55AA+40B+SUM8，20 通道飞控姿态闭环（XiHe_F4_FC_2）' }
    ];
  }

  // 老配置里只有传感器那台 WED 引擎；新加的飞控规格要补进列表，否则下拉框里看不到它
  // （预设卡片还能用，但用户得先想到去点卡片）。按 id 逐个补，已存在的原样不动。
  function ensureWedDefaults(engines) {
    const list = Array.isArray(engines) ? engines : [];
    defaultEngines().forEach((def) => {
      if (def.protocol !== 'WED') return;
      if (!list.some((engine) => engine && engine.id === def.id)) list.push(Object.assign({}, def));
    });
    return list;
  }

  function defaultScripts() {
    return [
      {
        id: 'script-basic-avg',
        name: '三通道均值',
        type: 'functions',
        formula: 'mean(ch1,ch2,ch3)',
        code: '',
        outputs: [{ id: 'out1', label: '平均', unit: '', color: '#34d399', range: [0, 100] }],
        builtin: true,
        description: '计算电压、电流、高度的平均值'
      },
      {
        id: 'script-delta',
        name: '高度变化率',
        type: 'functions',
        formula: 'slope(ch3, 5)',
        code: '',
        outputs: [{ id: 'out1', label: '高度变化率', unit: 'm/s', color: '#fbbf24', range: [-100, 100] }],
        builtin: true,
        description: '基于最近样本计算变化率'
      }
    ];
  }

  function componentPorts(raw, fallback, prefix) {
    const source = Array.isArray(raw) && raw.length ? raw : fallback;
    return source.map((item, index) => ({
      id: String(item && item.id || prefix + (index + 1)).slice(0, 32),
      label: String(item && item.label || ('输入' + (index + 1))).slice(0, 32)
    }));
  }

  function defaultComponents() {
    return [
      {
        id: 'component-mean',
        name: '双通道均值',
        description: '计算两路输入序列的均值',
        kind: 'formula',
        inputs: [{ id: 'x1', label: '输入 1' }, { id: 'x2', label: '输入 2' }],
        outputs: [{ id: 'out1', label: '均值', unit: '', color: '#38bdf8', range: [0, 100] }],
        parameters: [],
        config: { formula: 'mean(x1,x2)' },
        origin: 'builtin',
        builtin: true,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'component-rms',
        name: 'RMS 有效值',
        description: '计算单路输入序列的均方根',
        kind: 'formula',
        inputs: [{ id: 'x1', label: '输入 1' }],
        outputs: [{ id: 'out1', label: 'RMS', unit: '', color: '#34d399', range: [0, 100] }],
        parameters: [],
        config: { formula: 'rms(x1)' },
        origin: 'builtin',
        builtin: true,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'component-slope',
        name: '变化率',
        description: '计算最近 window 个点的平均变化率',
        kind: 'formula',
        inputs: [{ id: 'x1', label: '输入 1' }],
        outputs: [{ id: 'out1', label: '变化率', unit: '', color: '#fbbf24', range: [-100, 100] }],
        parameters: [{ id: 'window', label: '窗口', type: 'number', default: 5 }],
        config: { formula: 'slope(x1, p_window)' },
        origin: 'builtin',
        builtin: true,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'component-lowpass',
        name: '滑动低通',
        description: '对输入序列做移动平均低通滤波',
        kind: 'formula',
        inputs: [{ id: 'x1', label: '输入 1' }],
        outputs: [{ id: 'out1', label: '低通', unit: '', color: '#a78bfa', range: [0, 100] }],
        parameters: [{ id: 'window', label: '窗口', type: 'number', default: 10 }],
        config: { formula: 'lowpass(x1, p_window)' },
        origin: 'builtin',
        builtin: true,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'component-python-rms',
        name: 'Python RMS',
        description: '通过 Python 分析两路输入并输出 RMS',
        kind: 'python',
        inputs: [{ id: 'x1', label: '输入 1' }, { id: 'x2', label: '输入 2' }],
        outputs: [{ id: 'out1', label: 'Python RMS', unit: '', color: '#f472b6', range: [0, 100] }],
        parameters: [],
        config: {
          code: 'def analyze(ctx):\n    import statistics as st\n    x1 = ctx.get("x1", [])\n    x2 = ctx.get("x2", [])\n    values = list(x1) + list(x2)\n    return {"out1": st.pstdev(values) if len(values) > 1 else 0}'
        },
        origin: 'builtin',
        builtin: true,
        createdAt: 0,
        updatedAt: 0
      }
    ];
  }

  function normalizeComponent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const item = normalizeComponentFields(raw);
    // 内置组件的文案有出厂版本可比对：字段里出现替换字符就按默认值填回去
    return healComponentText(item);
  }

  // 乱码自愈：桥过去把 POST body 按 TCP 分块逐块解码，汉字被切在分块边界上就会解成
  // U+FFFD（已改成一次性解码，见 mcp-server/bytes.mjs）。坏值一旦被 persist() 写进
  // localStorage 就会一直粘着 —— 而内置组件有出厂文案，名字/描述/端口能按 id 原样填回。
  // 只比对这几项、不动 config：公式和 Python 代码是用户能改的，宁可留着让人自己看。
  const MOJIBAKE = /\uFFFD/;

  function healBrokenText(value, fallback) {
    if (typeof fallback === 'string') return typeof value === 'string' && MOJIBAKE.test(value) ? fallback : value;
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) return value;
      return value.map((entry, index) => (fallback[index] === undefined ? entry : healBrokenText(entry, fallback[index])));
    }
    if (fallback && typeof fallback === 'object') {
      if (!value || typeof value !== 'object') return value;
      const merged = Object.assign({}, value);
      Object.keys(fallback).forEach(key => { merged[key] = healBrokenText(value[key], fallback[key]); });
      return merged;
    }
    return value;
  }

  function healComponentText(item) {
    if (!item || typeof item !== 'object') return item;
    const template = defaultComponents().find(entry => entry.id === item.id);
    if (!template) return item;
    return healBrokenText(item, { name: template.name, description: template.description, inputs: template.inputs, outputs: template.outputs, parameters: template.parameters });
  }

  function normalizeComponentFields(raw) {
    const kind = String(raw.kind || 'formula').toLowerCase() === 'python' ? 'python' : 'formula';
    const now = Date.now();
    const inputs = componentPorts(raw.inputs, [{ id: 'x1', label: '输入 1' }], 'x');
    const outputs = (Array.isArray(raw.outputs) && raw.outputs.length ? raw.outputs : [{ id: 'out1', label: '输出' }]).map((item, index) => ({
      id: String(item && item.id || ('out' + (index + 1))).slice(0, 32),
      label: String(item && item.label || ('输出' + (index + 1))).slice(0, 32),
      unit: String(item && item.unit || '').slice(0, 16),
      color: String(item && item.color || ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'][index % 5]),
      range: Array.isArray(item && item.range) ? [Number(item.range[0]) || 0, Number(item.range[1]) || 100] : [0, 100]
    }));
    const parameters = (Array.isArray(raw.parameters) ? raw.parameters : []).map((item, index) => ({
      id: String(item && item.id || ('p' + (index + 1))).slice(0, 32),
      label: String(item && item.label || ('参数' + (index + 1))).slice(0, 32),
      type: String(item && item.type || 'number').slice(0, 16),
      default: item && item.default != null ? item.default : (String(item && item.type || 'number') === 'number' ? 0 : '')
    }));
    return {
      id: String(raw.id || uid('comp')).slice(0, 64),
      name: String(raw.name || '自定义组件').slice(0, 48),
      description: String(raw.description || '').slice(0, 200),
      kind: kind,
      inputs: inputs,
      outputs: outputs,
      parameters: parameters,
      config: Object.assign({}, raw.config || {}),
      origin: String(raw.origin || 'user').slice(0, 20),
      builtin: Boolean(raw.builtin),
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now
    };
  }

  function mergeComponents(base, additions) {
    const result = (Array.isArray(base) ? base : defaultComponents()).map(normalizeComponent).filter(Boolean);
    (Array.isArray(additions) ? additions : []).forEach((raw) => {
      const item = normalizeComponent(raw);
      if (!item) return;
      const index = result.findIndex((old) => old.id === item.id);
      if (index < 0) result.push(item);
      else {
        const old = result[index];
        result[index] = normalizeComponent(Object.assign({}, item, { builtin: old.builtin, origin: old.builtin ? 'builtin' : item.origin }));
      }
    });
    return result;
  }

  function normalizeView(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    const code = String(raw.code || '').trim();
    if (!id || !code) return null;
    return {
      id: id,
      name: String(raw.name || '自定义视图').slice(0, 40),
      icon: String(raw.icon || '◈').slice(0, 2),
      desc: String(raw.desc || raw.description || '').slice(0, 80),
      code: code,
      origin: String(raw.origin || 'user').slice(0, 20),
      createdAt: Number(raw.createdAt) || Date.now()
    };
  }

  function createState() {
    return {
      channels: defaults.map(makeChannel),
      intervalMs: 100,
      historyHours: 5,
      historyPoints: 180000,
      windowSec: 20,
      recordings: { enabled: true, autoStart: true, recordSimulation: false, rotateMB: 32, capGB: 2 },
      t: 0,
      playing: true,
      simulation: { enabled: false },
      showStake: true,
      showGrid: true,
      chartScaleMode: 'auto',
      chartFocusId: '',
      zoomMode: 'fit',
      cruise: true,
      homeMode: false,
      waypoints: defaultWaypoints(),
      scriptChannels: [],
      scripts: defaultScripts(),
      components: defaultComponents(),
      views: [],
      engines: defaultEngines(),
      activeEngine: 'engine-json',
      track: [],
      alarms: [],
      logs: [],
      view: 'wave',
      subview: 'wave',
      // 可视化区的图页。每个图页是一份独立的视图实例：自己的图种、自己的通道子集、
      // 自己的视口 —— 这是「像 vofa 那样开多个界面、各自放不同的图」的载体。
      // channels 为 null 表示「跟随全局通道显隐」，所以默认只有一个图页时观感与以前一致；
      // 用户在图上右键勾过通道之后才固化成一份独立清单。
      plots: [{ id: 'p1', name: '波形图', view: 'wave', channels: null }],
      activePlot: 'p1',
      // 一次性迁移的标记：早期版本给每个通道凭空算过一对预警阈值，载入时清一次就够了
      thresholdsMigrated: false,
      // 迁移清掉过东西时置位，应用启动后提示一次（提示完就清掉，不重复打扰）
      thresholdsNotice: false,
      // 第二轮对齐（协议没声明阈值的通道一律清空）的版本标记。它要等 protocol.js 加载完
      // 才拿得到协议表，所以不在 loadState 里跑，见 alignThresholdsToProtocol。
      thresholdsAligned: 0,
      // 被清掉的历史阈值留个档：用户要是确实想找回某个值，还能从这里翻出来
      thresholdsArchived: [],
      selectedChannel: 'ch1',
      channelTab: 'raw',
      theme: 'dark',
      fx: 'codex',
      protocol: { id: '', name: '', protocol: '', channelCount: 0, updatedAt: 0 },
      // 输入页「保存」：协议规则 + 通道名字/颜色的快照（v43 移植）
      inputSaves: [],
      analysis: {
        open: true,
        mode: 'functions',
        inputs: ['ch1'],
        formula: 'mean(ch1)',
        python: 'def analyze(ctx):\n    x = ctx.get("ch1", [])\n    return {"out1": mean(x)}',
        outputs: [{ id: 'out1', label: '均值', unit: '', color: '#34d399', range: [0, 100] }],
        canvas: {
          nodes: [],
          edges: [],
          viewport: { x: 70, y: 70, zoom: 1 },
          autoRun: false,
          initialized: false
        },
        // 画布上现在载入的是脚本库里的哪个模块（空串 = 没载入任何模块，是临时画布）。
        // 脚本库靠它标出「当前画布」—— 没有这个，「点卡片切换画布」就没有锚点
        canvasScriptId: '',        windowPoints: 2000,
        lastRun: null,
        lastError: ''
      },
      ai: {
        messages: [],
        // 串口上下文帧数。原来 10 帧对排查够用，但用户想「看看这段时间的趋势」时就太薄了
        contextFrames: 50,
        // 对话上下文预算（字符数）。chatMessages 用它决定保留多少历史：超预算按轮边界裁剪；
        // 4k~120k 之外的值在读取/导入时 clamp，配置可改、行为跟着变。
        contextBudgetChars: 24000,
        // 'local' = OpenAI 兼容 API 端点（可指向远程服务）；'dsh' = 官方 DSH agent。
        // 默认走 DSH：它能直接调用地面站工具接管数据链。内置的本地意图匹配已经删掉，
        // 没配后端时不会再假装回答。
        backend: 'dsh',
        dshProfile: 'headless',
        // agent：允许 DSH 读写文件、执行命令并调用 xhgcs MCP 工具（用户明确要求让它接管）；
        // answer：只做纯问答，禁止工具。
        dshMode: 'agent',
        dshTimeoutMs: 180000,
        endpoint: '',
        model: '',
        apiKey: '',
        systemPrompt: '你是 XiHe_GCS 地面站的本地数据分析助手。回答简洁，优先完成脚本、画布或数据引擎任务；不要猜测未提供的通道。',
        temperature: 0.2,
        // 1024 生成一个视图插件或节点画布很容易打满：JSON 一被截断就解析失败、
        // 悄悄回退本地模板，用户只看到「代码不合规（…），已改用本地模板」
        maxTokens: 4096,
        stream: true,
        useProxy: true,
        disableThinking: true,
        // 允许模型在回答前调用只读工具（查通道 / 脚本 / 引擎 / 画布）。
        // 创建类动作仍走文本动作协议 + 确认卡片，不进工具循环。
        tools: true,
        models: [],
        discovered: [],
        lastModel: '',
        lastError: '',
        lastOk: 0,
        streaming: false,
        tasks: [],
        tts: {
          enabled: true,
          engine: 'browser',
          endpoint: 'http://127.0.0.1:8770',
          apiKey: '',
          voice: 'default',
          speed: 1,
          autoSpeak: true,
          mode: 'chat',
          alarmLevel: 'warn',
          alarmCooldown: 5,
          alarmTemplate: '注意，{channel}{label}，当前值 {value}{unit}。'
        }
      },
      mcp: {
        enabled: false,
        endpoint: 'http://127.0.0.1:8787',
        connected: false,
        deletedScripts: [],
        deletedEngines: [],
        deletedComponents: [],
        deletedViews: []
      },
      serial: {
        port: 'COM3',
        baud: 115200,
        dataBits: 8,
        parity: 'None',
        stopBits: 1,
        connected: false,
        running: false,
        autoScroll: true,
        frames: 0,
        rxBytes: 0,
        txBytes: 0,
        errors: 0,
        breaks: 0,
        receiving: false,
        lastError: '',
        rate: 0
      }
    };
  }

  function sanitizeChannel(raw) {
    const ch = makeChannel(raw);
    ch.name = String(raw.name || '通道').slice(0, 24);
    if (raw.isScript) ch.isScript = true;
    return ch;
  }

  // ===== 主题 =====
  const THEME_MODES = ['dark', 'light', 'auto'];
  // 界面风格：codex=扁平简洁（VS Code / Codex 观感），glass=苹果液态玻璃
  const FX_MODES = ['codex', 'glass'];

  function normalizeTheme(value) {
    const mode = String(value == null ? '' : value).toLowerCase();
    return THEME_MODES.indexOf(mode) >= 0 ? mode : 'dark';
  }

  function normalizeFx(value) {
    const mode = String(value == null ? '' : value).toLowerCase();
    return FX_MODES.indexOf(mode) >= 0 ? mode : 'codex';
  }

  // 实际生效的主题名（auto 跟随系统）
  function themeName() {
    const mode = normalizeTheme(state.theme);
    if (mode === 'auto') {
      const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      return light ? 'light' : 'dark';
    }
    return mode;
  }

  function applyTheme() {
    const name = themeName();
    document.documentElement.setAttribute('data-theme', name);
    document.documentElement.setAttribute('data-fx', normalizeFx(state.fx));
    if (window.XHGCS_DESKTOP && typeof window.XHGCS_DESKTOP.setTheme === 'function') {
      window.XHGCS_DESKTOP.setTheme(name);
    }
    if (window.XHGCS_DESKTOP && typeof window.XHGCS_DESKTOP.setTitleBar === 'function') {
      window.XHGCS_DESKTOP.setTitleBar(titleBarColors());
    }
    return name;
  }

  // 顶栏当标题栏用：右上角那三个系统按钮（Electron 的 titleBarOverlay）底色必须跟顶栏一致，
  // 否则浅色主题下按钮条是一条白杠、深色下是一条深灰，跟顶栏对不上。
  // 顶栏是半透明的（玻璃风格还叠了两层渐变），没法直接取一个 CSS 颜色当底色：
  // 这里把那一层的颜色和平均透明度算出来，再叠到页面底色 --bg 上，得到的才是屏幕上那个颜色。
  function parseColor(raw) {
    if (String(raw == null ? '' : raw).trim().toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const fn = String(raw == null ? '' : raw).match(/^rgba?\(([^)]+)\)$/);
    if (fn) {
      const parts = fn[1].split(',').map((v) => Number(v.trim()));
      if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 && isFinite(parts[3]) ? parts[3] : 1 };
    }
    const hex = String(raw == null ? '' : raw).trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
    if (!hex) return null;
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }

  function firstLayer(css) {
    const list = String(css == null ? '' : css).match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|transparent/gi) || [];
    const stops = [];
    for (let i = 0; i < list.length; i++) {
      const c = parseColor(list[i]);
      if (c) stops.push(c);
    }
    return stops;
  }

  // 顶栏真正画出来的颜色 = 页面底色 + 背景色层 + 各条渐变层（CSS 里排在前的在上），
  // 逐层用平均透明度叠一遍就够了：玻璃风格下顶栏是半透明的，只取「第一个不透明色标」
  // 会得到一条跟顶栏对不上的亮/暗杠（深色顶栏实测差 25 级）。
  function layerAverage(stops) {
    let a = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < stops.length; i++) {
      a += stops[i].a;
      r += stops[i].r;
      g += stops[i].g;
      b += stops[i].b;
    }
    return { a: a / stops.length, r: r / stops.length, g: g / stops.length, b: b / stops.length };
  }

  function gradientLayers(css) {
    const list = String(css == null ? '' : css).split(/,(?=\s*(?:linear-gradient|radial-gradient|conic-gradient)\()/i);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const stops = firstLayer(list[i]);
      if (stops.length) out.push(layerAverage(stops));
    }
    return out;
  }

  function titleBarColors() {
    const light = themeName() === 'light';
    const fallback = { color: light ? '#F1E9DC' : '#191411', symbolColor: light ? '#231D17' : '#F5EDE1' };
    const bar = document.querySelector('.topbar');
    if (!bar) return fallback;
    const cs = getComputedStyle(bar);
    const root = getComputedStyle(document.documentElement);
    const base = parseColor(root.getPropertyValue('--bg').trim()) || { r: 13, g: 17, b: 23, a: 1 };
    const layers = [];
    const own = firstLayer(cs.backgroundColor);
    if (own.length) layers.push(layerAverage(own));
    const grads = gradientLayers(cs.backgroundImage);
    for (let i = grads.length - 1; i >= 0; i--) layers.push(grads[i]);
    let r = base.r;
    let g = base.g;
    let b = base.b;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      r = L.r * L.a + r * (1 - L.a);
      g = L.g * L.a + g * (1 - L.a);
      b = L.b * L.a + b * (1 - L.a);
    }
    const color = 'rgb(' + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) + ')';
    return { color, symbolColor: getComputedStyle(document.body).color || fallback.symbolColor };
  }

  function setTheme(value, options) {
    state.theme = normalizeTheme(value);
    applyTheme();
    if (!options || options.persist !== false) persist();
    window.dispatchEvent(new CustomEvent('xhgcs:theme-changed', { detail: { mode: state.theme, name: themeName() } }));
    return state.theme;
  }

  function setFx(value, options) {
    state.fx = normalizeFx(value);
    applyTheme();
    if (!options || options.persist !== false) persist();
    window.dispatchEvent(new CustomEvent('xhgcs:fx-changed', { detail: { mode: state.fx } }));
    return state.fx;
  }

  // 视图/画布插件共用的字体令牌：与界面同一套字栈，插件不要再自己拼 font 字符串
  const VIEW_FONT = {
    body: '12px "Segoe UI","Microsoft YaHei",sans-serif',
    strong: '600 12px "Segoe UI","Microsoft YaHei",sans-serif',
    title: '600 13px "Segoe UI","Microsoft YaHei",sans-serif',
    mono: '11px Consolas,"Cascadia Mono",monospace'
  };

  // 画布里的颜色不走 CSS 变量，按主题 + 界面风格返回对应色板。
  // P1 暖柔主题（v4）：井底/网格/轴/强调全部改为暖系；glass 与 codex 共用底色（画布无模糊），
  // 只差发丝强度。井底必须和 --surf-well 一致：#120F0C（暗）/ #F0E8DB（亮；v4 #F0E6D7 微调 2 阶，见交付说明）。
  function canvasColors() {
    const lightTheme = themeName() === 'light';
    const flat = normalizeFx(state.fx) === 'codex';
    if (lightTheme) {
      return {
        bg: '#F0E8DB',
        grid: 'rgba(74, 60, 44, .10)',
        frame: 'rgba(74, 60, 44, .16)',
        track: 'rgba(74, 60, 44, .06)',
        trackLine: 'rgba(74, 60, 44, .12)',
        trackRing: 'rgba(74, 60, 44, .10)',
        axisText: '#6D6153',
        axisLabelBg: 'transparent',
        tagBg: flat ? '#FFFCF5' : 'rgba(255, 252, 245, .94)',
        strongText: '#231D17',
        dimText: '#6D6153',
        acc: '#9A4B1E',
        accRgb: '154, 75, 30',
        font: VIEW_FONT,
        glow: false
      };
    }
    return {
      bg: '#120F0C',
      grid: 'rgba(245, 229, 206, .055)',
      frame: 'rgba(245, 229, 206, .10)',
      track: 'rgba(245, 229, 206, .045)',
      trackLine: 'rgba(245, 229, 206, .07)',
      trackRing: 'rgba(245, 229, 206, .09)',
      axisText: '#B0A18E',
      axisLabelBg: 'transparent',
      tagBg: flat ? '#342C25' : 'rgba(52, 44, 37, .92)',
      strongText: '#F5EDE1',
      dimText: '#B0A18E',
      acc: '#D18E5C',
      accRgb: '209, 142, 92',
      font: VIEW_FONT,
      glow: false
    };
  }

  // viewColor 契约：入参是通道「存储色」（CHANNEL_COLORS 原值），返回当前主题下的显示色。
  // 纯查表、确定性：同色恒同输出、跨视图/刷新一致；P1 起按色相归到 v4 暖柔六序列色，
  // 深浅各一套；未知色原样返回。别处不得再发明第二套主题映射。
  const WARM_DARK = {
    '#38bdf8': '#A6C1E4', '#60a5fa': '#A6C1E4', '#22d3ee': '#A6C1E4',
    '#34d399': '#A7DCC9', '#4ade80': '#A7DCC9', '#2dd4bf': '#A7DCC9', '#a3e635': '#A7DCC9',
    '#fbbf24': '#E7B45F', '#facc15': '#E7B45F',
    '#f472b6': '#D996A9', '#fb7185': '#D996A9', '#f87171': '#D996A9',
    '#a78bfa': '#BAC27A', '#c084fc': '#BAC27A',
    '#fb923c': '#A99B86', '#fdba74': '#A99B86'
  };
  const WARM_LIGHT = {
    '#38bdf8': '#3D5578', '#60a5fa': '#3D5578', '#22d3ee': '#3D5578',
    '#34d399': '#245C50', '#4ade80': '#245C50', '#2dd4bf': '#245C50', '#a3e635': '#245C50',
    '#fbbf24': '#8A5A12', '#facc15': '#8A5A12',
    '#f472b6': '#7A3A2A', '#fb7185': '#7A3A2A', '#f87171': '#7A3A2A',
    '#a78bfa': '#5E6626', '#c084fc': '#5E6626',
    '#fb923c': '#6F6558', '#fdba74': '#6F6558'
  };
  function viewColor(color) {
    if (!color) return color;
    const key = String(color).toLowerCase();
    return (themeName() === 'light' ? WARM_LIGHT : WARM_DARK)[key] || color;
  }

  function loadState() {
    const state = createState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return state;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.channels) && saved.channels.length) {
        state.channels = saved.channels.map(sanitizeChannel);
      }
      if (Array.isArray(saved.scriptChannels)) {
        state.scriptChannels = saved.scriptChannels.map(sanitizeChannel);
      }
      if (Array.isArray(saved.scripts)) state.scripts = saved.scripts;
      if (Array.isArray(saved.components)) state.components = mergeComponents(defaultComponents(), saved.components);
      if (Array.isArray(saved.views)) state.views = saved.views.map(normalizeView).filter(Boolean);
      if (Array.isArray(saved.plots) && saved.plots.length) {
        const plots = saved.plots.map(normalizePlot).filter(Boolean);
        if (plots.length) {
          state.plots = plots;
          state.activePlot = plots.some((p) => p.id === saved.activePlot) ? saved.activePlot : plots[0].id;
          state.subview = state.plots.find((p) => p.id === state.activePlot).view;
        }
      }
      if (Array.isArray(saved.engines)) {
        state.engines = ensureWedDefaults(saved.engines.slice());
      }
      if (saved.activeEngine) state.activeEngine = saved.activeEngine;
      if (saved.channelTab) state.channelTab = saved.channelTab;
      if (saved.theme) state.theme = normalizeTheme(saved.theme);
      if (saved.fx) state.fx = normalizeFx(saved.fx);
      if (saved.analysis) state.analysis = Object.assign(state.analysis, saved.analysis);
      if (saved.ai) state.ai = Object.assign(state.ai, saved.ai);
      state.ai.contextBudgetChars = Math.max(4000, Math.min(120000, Number(state.ai.contextBudgetChars) || 24000));
      if (typeof state.ai.disableThinking !== 'boolean') state.ai.disableThinking = true;
      if (typeof state.ai.tools !== 'boolean') state.ai.tools = true;
      if (state.ai.backend !== 'dsh') state.ai.backend = 'local';
      if (!state.ai.dshProfile) state.ai.dshProfile = 'headless';
      if (state.ai.dshMode !== 'answer') state.ai.dshMode = 'agent';
      const dshTimeout = Number(state.ai.dshTimeoutMs);
      state.ai.dshTimeoutMs = dshTimeout >= 10000 && dshTimeout <= 300000 ? dshTimeout : 180000;
      state.ai.tasks = Array.isArray(state.ai.tasks) ? state.ai.tasks.slice(0, 80) : [];
      interruptStaleAiTasks(state.ai.tasks);
      state.ai.tts = Object.assign({
        enabled: true,
        engine: 'browser',
        endpoint: 'http://127.0.0.1:8770',
        apiKey: '',
        voice: 'default',
        speed: 1,
        autoSpeak: true,
        mode: 'chat',
        alarmLevel: 'warn',
        alarmCooldown: 5,
        alarmTemplate: '注意，{channel}{label}，当前值 {value}{unit}。'
      }, state.ai.tts || {});
      if (saved.mcp) state.mcp = Object.assign(state.mcp, saved.mcp);
      if (saved.protocol && typeof saved.protocol === 'object') state.protocol = Object.assign(state.protocol, saved.protocol);
      // 阈值迁移/对齐的版本标记必须跟着存档走：漏了的话每次启动都会重跑一遍，
      // 用户在告警页手填的阈值会被当成历史垃圾再清一次。
      state.thresholdsMigrated = Number(saved.thresholdsMigrated) || 0;
      state.thresholdsAligned = Number(saved.thresholdsAligned) || 0;
      if (Array.isArray(saved.thresholdsArchived)) state.thresholdsArchived = saved.thresholdsArchived;
      if (saved.recordings && typeof saved.recordings === 'object') state.recordings = Object.assign(state.recordings, saved.recordings);
      const nums = ['intervalMs', 'windowSec'];
      nums.forEach(key => {
        if (Number.isFinite(Number(saved[key])) && Number(saved[key]) > 0) state[key] = Number(saved[key]);
      });
      if (Number.isFinite(Number(saved.historyHours)) && Number(saved.historyHours) > 0) {
        state.historyHours = Math.max(1, Math.min(24, Number(saved.historyHours)));
      }
      state.historyPoints = historyPointsFor(state.historyHours, state.intervalMs);
      ['showStake', 'showGrid', 'cruise'].forEach(key => {
        if (typeof saved[key] === 'boolean') state[key] = saved[key];
      });
      if (['auto', 'overlay', 'normalize'].includes(saved.chartScaleMode)) state.chartScaleMode = saved.chartScaleMode;
      if (saved.serial) {
        Object.assign(state.serial, saved.serial);
        state.serial.frames = 0;
        state.serial.rxBytes = 0;
        state.serial.txBytes = 0;
        state.serial.errors = 0;
        state.serial.connected = false;
        state.serial.running = false;
      }
      if (Array.isArray(saved.inputSaves)) state.inputSaves = saved.inputSaves.slice(0, 50);
      if (Array.isArray(saved.waypoints) && saved.waypoints.length) state.waypoints = saved.waypoints;
    } catch (err) {
      console.warn('XiHe_GCS: 读取本地配置失败', err);
    }
    return state;
  }

  const state = loadState();
  // 放到这一行之后：此刻模块级 state 才刚初始化完，在 loadState 内部调会撞上暂时性死区。
  // 迁移只改内存里的状态，不在这里 persist —— 下一次正常的保存会把它落盘，
  // 就算没落盘，下次启动重跑一遍也是幂等的（已经没有可清的值了）
  migrateFabricatedThresholds(state);
  state.track = [];
  state.logs = [];
  applyTheme();
  if (window.matchMedia) {
    const schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
    const onSchemeChange = () => { if (normalizeTheme(state.theme) === 'auto') applyTheme(); };
    if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', onSchemeChange);
    else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange);
  }
  state.mcp.connected = false;
  state.mcp.deletedScripts = Array.isArray(state.mcp.deletedScripts) ? state.mcp.deletedScripts : [];
  state.mcp.deletedEngines = Array.isArray(state.mcp.deletedEngines) ? state.mcp.deletedEngines : [];
  state.mcp.deletedComponents = Array.isArray(state.mcp.deletedComponents) ? state.mcp.deletedComponents : [];
  state.mcp.deletedViews = Array.isArray(state.mcp.deletedViews) ? state.mcp.deletedViews : [];

  // 上一次真正写进 localStorage 的字符串。补写前比对一次：
  // 如果存储已被别人改过（另一个标签页、外部工具），就放弃这次补写，
  // 绝不拿“过期的内存状态”覆盖更新的存储。
  let lastWrittenText = null;

  function persistNow() {
    try {
      const data = {
        version: 1,
        channels: state.channels.map(ch => {
          const copy = Object.assign({}, ch);
          delete copy.data;
          delete copy.alertState;
          delete copy.faultUntil;
          delete copy.faultKind;
          return copy;
        }),
        intervalMs: state.intervalMs,
        historyHours: state.historyHours,
        windowSec: state.windowSec,
        recordings: state.recordings,
        showStake: state.showStake,
        showGrid: state.showGrid,
        chartScaleMode: state.chartScaleMode,
        // 图页：每页的图种与通道清单都要跟着存档走，否则重启一次就退回单页
        plots: (state.plots || []).map((p) => ({
          id: p.id, name: p.name, view: p.view,
          channels: Array.isArray(p.channels) ? p.channels.slice() : null
        })),
        activePlot: state.activePlot,
        cruise: state.cruise,
        simulation: state.simulation,
        waypoints: state.waypoints,
        scriptChannels: state.scriptChannels.map(ch => {
          const copy = Object.assign({}, ch);
          delete copy.data;
          delete copy.alertState;
          delete copy.faultUntil;
          delete copy.faultKind;
          return copy;
        }),
        scripts: state.scripts,
        components: state.components,
        views: state.views,
        engines: state.engines,
        activeEngine: state.activeEngine,
        channelTab: state.channelTab,
        theme: state.theme,
        fx: normalizeFx(state.fx),
        protocol: state.protocol,
        // 阈值迁移的标记：见 loadState 里的注释 —— 不落盘就会每次启动重跑
        thresholdsMigrated: Number(state.thresholdsMigrated) || 0,
        thresholdsAligned: Number(state.thresholdsAligned) || 0,
        thresholdsArchived: state.thresholdsArchived || [],
        analysis: state.analysis,
        ai: {
          messages: aiMessagesForStorage(),
          contextFrames: state.ai.contextFrames,
          contextBudgetChars: state.ai.contextBudgetChars,
          backend: state.ai.backend,
          dshProfile: state.ai.dshProfile,
          dshMode: state.ai.dshMode,
          dshTimeoutMs: state.ai.dshTimeoutMs,
          endpoint: state.ai.endpoint,
          model: state.ai.model,
          apiKey: state.ai.apiKey,
          systemPrompt: state.ai.systemPrompt,
          temperature: state.ai.temperature,
          maxTokens: state.ai.maxTokens,
          stream: state.ai.stream,
          useProxy: state.ai.useProxy,
          disableThinking: state.ai.disableThinking !== false,
          tools: state.ai.tools !== false,
          tasks: state.ai.tasks.slice(0, AI_STORAGE_TASK_LIMIT),
          tts: state.ai.tts
        },
        mcp: mcpStateForStorage(),
        serial: {
          port: state.serial.port,
          baud: state.serial.baud,
          dataBits: state.serial.dataBits,
          parity: state.serial.parity,
          stopBits: state.serial.stopBits,
          autoScroll: state.serial.autoScroll
        },
        inputSaves: (Array.isArray(state.inputSaves) ? state.inputSaves : []).slice(0, 50)
      };
      const text = JSON.stringify(data);
      // 内容与上次写入完全一致、且存储没被外部改过 → 这次 persist 是空操作，不碰 localStorage
      if (text === lastWrittenText && !storageDrifted()) return;
      try {
        localStorage.setItem(STORAGE_KEY, text);
        lastWrittenText = text;
      } catch (err) {
        // 长对话/大量任务可能挤爆 localStorage。先保配置骨架和最近上下文，
        // 再重试一次；失败时明确告诉用户，而不是让这一轮修改无声丢失。
        data.ai.messages = data.ai.messages.slice(-12);
        data.ai.tasks = data.ai.tasks.slice(0, 20);
        data.thresholdsArchived = (data.thresholdsArchived || []).slice(-50);
        lastWrittenText = JSON.stringify(data);
        try {
          localStorage.setItem(STORAGE_KEY, lastWrittenText);
          if (state.app && state.app.toast) state.app.toast('本机存储紧张：已压缩 AI 历史后保存');
        } catch (second) {
          lastWrittenText = '';
          console.warn('XiHe_GCS: 压缩后仍无法保存配置', second);
          if (state.app && state.app.toast) state.app.toast('保存失败：本机存储已满，本次修改可能丢失');
        }
        console.warn('XiHe_GCS: 配置超过存储上限，已压缩 AI 历史后保存', err);
      }
    } catch (err) {
      lastWrittenText = '';
      console.warn('XiHe_GCS: 保存配置失败', err);
      if (state.app && state.app.toast) state.app.toast('保存失败：' + ((err && err.message) || '本机存储不可用'));
    }
  }

  // ---- 保存去重 ----
  // 语义保持「persist() 立即落盘」：调用方写完马上读 localStorage 必须读得到（这是回归用例钉住的契约）。
  // 优化点在另一头：把序列化结果与上一次真正写进去的字符串比对，完全一致就不碰 localStorage。
  // 界面里有大量「点了但状态没变」的 persist（切页签、点按钮），这一层能把它们全挡掉，
  // 而连续拖滑块仍然次次落盘 —— 正确性优先，性能来自跳过无效写。
  function persist() {
    persistNow();
  }

  function storageDrifted() {
    if (lastWrittenText == null) return false;
    try {
      return localStorage.getItem(STORAGE_KEY) !== lastWrittenText;
    } catch (err) {
      return false;
    }
  }

  function exportConfig() {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      channels: state.channels.map(ch => {
        const copy = Object.assign({}, ch);
        delete copy.data;
        delete copy.alertState;
        delete copy.faultUntil;
        delete copy.faultKind;
        return copy;
      }),
      intervalMs: state.intervalMs,
      historyHours: state.historyHours,
      windowSec: state.windowSec,
      recordings: state.recordings,
      showStake: state.showStake,
      showGrid: state.showGrid,
      chartScaleMode: state.chartScaleMode,
      cruise: state.cruise,
      simulation: state.simulation,
      waypoints: state.waypoints,
      scriptChannels: state.scriptChannels.map(ch => {
        const copy = Object.assign({}, ch);
        delete copy.data;
        delete copy.alertState;
        delete copy.faultUntil;
        delete copy.faultKind;
        return copy;
      }),
      scripts: state.scripts,
      components: state.components,
      views: state.views,
      engines: state.engines,
      activeEngine: state.activeEngine,
      inputSaves: state.inputSaves,
      channelTab: state.channelTab,
      // 图页（每个图页自己的图种与通道清单）随配置一起走，换台机器不用重搭一遍
      plots: (state.plots || []).map((p) => ({
        id: p.id, name: p.name, view: p.view,
        channels: Array.isArray(p.channels) ? p.channels.slice() : null
      })),
      activePlot: state.activePlot,
      theme: state.theme,
      fx: normalizeFx(state.fx),
      protocol: state.protocol,
      analysis: state.analysis,
      ai: {
        messages: aiMessagesForStorage(),
        contextFrames: state.ai.contextFrames,
        contextBudgetChars: state.ai.contextBudgetChars,
        backend: state.ai.backend,
        dshProfile: state.ai.dshProfile,
        dshTimeoutMs: state.ai.dshTimeoutMs,
        endpoint: state.ai.endpoint,
        model: state.ai.model,
        // 密钥不随配置走：导出的 json 经常被拷给别人或存进网盘，带上等于把 key 一起送出去
        apiKey: '',
        systemPrompt: state.ai.systemPrompt,
        temperature: state.ai.temperature,
        maxTokens: state.ai.maxTokens,
        stream: state.ai.stream,
        useProxy: state.ai.useProxy,
        disableThinking: state.ai.disableThinking !== false,
        tasks: state.ai.tasks.slice(0, AI_STORAGE_TASK_LIMIT),
        tts: Object.assign({}, state.ai.tts, { apiKey: '' })
      },
      mcp: mcpStateForStorage(),
      serial: {
        port: state.serial.port,
        baud: state.serial.baud,
        dataBits: state.serial.dataBits,
        parity: state.serial.parity,
        // 导出也带停止位：否则换机导入会静默回落 1（import 端 Object.assign 自动接住）
        stopBits: state.serial.stopBits
      }
    };
    return data;
  }

  function importConfig(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || !Array.isArray(data.channels) || !data.channels.length) {
      throw new Error('配置文件缺少 channels');
    }
    const fresh = createState();
    fresh.channels = data.channels.map(sanitizeChannel);
    Object.assign(fresh, {
      intervalMs: Number(data.intervalMs) || fresh.intervalMs,
      historyHours: Math.max(1, Math.min(24, Number(data.historyHours) || fresh.historyHours)),
      windowSec: Number(data.windowSec) || fresh.windowSec,
      showStake: data.showStake !== false,
      showGrid: data.showGrid !== false,
      chartScaleMode: ['auto', 'overlay', 'normalize'].includes(data.chartScaleMode) ? data.chartScaleMode : 'auto',
      cruise: data.cruise !== false
    });
    if (Array.isArray(data.waypoints) && data.waypoints.length) fresh.waypoints = data.waypoints;
    if (data.serial) Object.assign(fresh.serial, data.serial);
    if (Array.isArray(data.scriptChannels)) fresh.scriptChannels = data.scriptChannels.map(sanitizeChannel);
    if (Array.isArray(data.scripts)) fresh.scripts = data.scripts;
    if (Array.isArray(data.components)) fresh.components = mergeComponents(defaultComponents(), data.components);
    if (Array.isArray(data.views)) fresh.views = data.views.map(normalizeView).filter(Boolean);
    if (Array.isArray(data.engines)) {
      fresh.engines = ensureWedDefaults(data.engines.slice());
    }
    if (data.activeEngine) fresh.activeEngine = data.activeEngine;
    if (Array.isArray(data.inputSaves)) fresh.inputSaves = data.inputSaves.slice(0, 50);
    if (data.channelTab) fresh.channelTab = data.channelTab;
    if (Array.isArray(data.plots) && data.plots.length) {
      const plots = data.plots.map(normalizePlot).filter(Boolean);
      if (plots.length) {
        fresh.plots = plots;
        fresh.activePlot = plots.some((p) => p.id === data.activePlot) ? data.activePlot : plots[0].id;
        fresh.subview = plots.find((p) => p.id === fresh.activePlot).view;
      }
    }
    if (data.theme) fresh.theme = normalizeTheme(data.theme);
    if (data.fx) fresh.fx = normalizeFx(data.fx);
    if (data.protocol && typeof data.protocol === 'object') fresh.protocol = Object.assign(fresh.protocol, data.protocol);
    if (data.analysis) fresh.analysis = Object.assign(fresh.analysis, data.analysis);
    if (data.ai) {
      const incoming = Object.assign({}, data.ai);
      // 导出的配置里 apiKey 是空的（密钥不随文件走）。导入时若照搬空值，
      // 本机已经配好的 key 会被这份「干净」的配置抹掉，用户下次对话才发现连不上
      if (!incoming.apiKey && state.ai.apiKey) incoming.apiKey = state.ai.apiKey;
      if (incoming.tts) {
        incoming.tts = Object.assign({}, incoming.tts);
        if (!incoming.tts.apiKey && state.ai.tts.apiKey) incoming.tts.apiKey = state.ai.tts.apiKey;
      }
      fresh.ai = Object.assign(fresh.ai, incoming);
    }
    fresh.ai.contextBudgetChars = Math.max(4000, Math.min(120000, Number(fresh.ai.contextBudgetChars) || 24000));
    fresh.ai.tasks = Array.isArray(fresh.ai.tasks) ? fresh.ai.tasks.slice(0, 80) : [];
    interruptStaleAiTasks(fresh.ai.tasks);
    fresh.ai.tts = Object.assign({
      enabled: true,
      engine: 'browser',
      endpoint: 'http://127.0.0.1:8770',
      apiKey: '',
      voice: 'default',
      speed: 1,
      autoSpeak: true,
      mode: 'chat',
      alarmLevel: 'warn',
      alarmCooldown: 5,
      alarmTemplate: '注意，{channel}{label}，当前值 {value}{unit}。'
    }, fresh.ai.tts || {});
    if (data.mcp) fresh.mcp = Object.assign(fresh.mcp, data.mcp);
    if (data.recordings && typeof data.recordings === 'object') fresh.recordings = Object.assign(fresh.recordings, data.recordings);
    Object.assign(state, fresh, {
      track: [],
      logs: [],
      alarms: [],
      protocol: fresh.protocol,
      serial: fresh.serial
    });
    state.serial.frames = 0;
    state.serial.rxBytes = 0;
    state.serial.txBytes = 0;
    state.serial.errors = 0;
    state.serial.connected = false;
    state.serial.running = false;
    state.historyPoints = historyPointsFor(state.historyHours, state.intervalMs);
    // 导入的可能是旧版本存下来的配置，同样清掉凭空算出来的阈值（紧接着的 persist 会落盘）
    migrateFabricatedThresholds(state);
    // 再按协议表对一遍：导入的也可能是「量程被撑大之后」那批对不上公式的残留
    alignThresholdsToProtocol(window.XHGCS_PROTOCOL && window.XHGCS_PROTOCOL.WED_PROFILES);
    persist();
    return state;
  }

  function resetAll() {
    const fresh = createState();
    Object.assign(state, fresh, { track: [], logs: [], alarms: [] });
    persist();
    return state;
  }

  function addComponent(config) {
    const item = normalizeComponent(Object.assign({}, config || {}, {
      id: String(config && config.id || uid('comp')),
      origin: String(config && config.origin || 'user'),
      builtin: Boolean(config && config.builtin)
    }));
    state.components.push(item);
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:components-changed', { detail: { action: 'add', component: item } }));
    return item;
  }

  function updateComponent(id, patch) {
    const index = state.components.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const old = state.components[index];
    // 内置组件是只读模板：放行会把随软件发布的默认值永久改掉，且没有恢复入口。
    // 需要改动就先 addComponent 复制一份（UI 的「复制为新组件」、MCP 的 create_component 同理）。
    if (old.builtin) return null;
    const next = normalizeComponent(Object.assign({}, old, patch || {}, {
      id: old.id,
      builtin: old.builtin,
      origin: old.builtin ? 'builtin' : String(patch && patch.origin || old.origin || 'user'),
      updatedAt: Date.now()
    }));
    state.components[index] = next;
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:components-changed', { detail: { action: 'update', component: next } }));
    return next;
  }

  function removeComponent(id) {
    const item = state.components.find((entry) => entry.id === id);
    if (!item || item.builtin) return false;
    state.components = state.components.filter((entry) => entry.id !== id);
    if (state.analysis && state.analysis.canvas && Array.isArray(state.analysis.canvas.nodes)) {
      state.analysis.canvas.nodes.forEach((node) => {
        if (node && node.type === 'component' && node.config && node.config.componentId === id) {
          node.config.componentSnapshot = null;
          node.config.missing = true;
          node.config.parameters = {};
        }
      });
    }
    if (state.mcp.deletedComponents && !state.mcp.deletedComponents.includes(id)) state.mcp.deletedComponents.push(id);
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:components-changed', { detail: { action: 'delete', id: id } }));
    return true;
  }

  function getComponent(id) {
    return state.components.find((item) => item.id === id) || null;
  }

  function resetData() {
    state.t = 0;
    serialClock = null;
    state.channels.forEach(ch => { ch.data = []; sampleTimelines.delete(ch); });
    state.scriptChannels.forEach(ch => { ch.data = []; sampleTimelines.delete(ch); });
    state.analysis.lastRun = null;
    state.analysis.lastError = '';
    state.track = [];
    state.alarms = [];
    state.serial.frames = 0;
    state.serial.errors = 0;
    state.waypoints.forEach(wp => { if (wp.id === 'wp1') Object.assign(wp, { x: 0, y: 0 }); });
    pushLog('sys', '数据已清空，重新开始采集');
    window.dispatchEvent(new CustomEvent('xhgcs:data-reset'));
  }

  function activeChannels() {
    return state.channelTab === 'script' ? state.scriptChannels : state.channels;
  }

  function allChannels() {
    return state.channels.concat(state.scriptChannels);
  }

  function findChannel(id) {
    return allChannels().find(ch => ch.id === id);
  }

  // ---- 可视化图页 ----
  // 取通道的唯一入口：所有内置视图（波形/柱状/数据表/仪表）都从这里拿自己要画的通道。
  // plot.channels 为 null 时跟随全局显隐（老行为），一旦被右键勾选过就按那份清单来。
  function activePlot() {
    const list = state.plots || [];
    return list.find((p) => p.id === state.activePlot) || list[0] || null;
  }

  function plotChannels(plot) {
    const target = plot || activePlot();
    const ids = target && Array.isArray(target.channels) ? target.channels : null;
    return allChannels().filter((ch) => (ids ? ids.indexOf(ch.id) >= 0 : ch.visible !== false));
  }

  function plotById(id) {
    return (state.plots || []).find((p) => p.id === id) || null;
  }

  // 一个图页的可读名字：没起名就按图种自动叫「波形图 / 柱状图 …」
  function plotLabel(plot) {
    if (!plot) return '图页';
    const custom = String(plot.name || '').trim();
    return custom || VIEW_LABELS[plot.view] || '图页';
  }

  function addPlot(view, patch) {
    const kind = String(view || state.subview || 'wave');
    const plot = { id: uid('plot'), name: '', view: kind, channels: null };
    if (patch) Object.assign(plot, patch);
    state.plots.push(plot);
    state.activePlot = plot.id;
    persist();
    return plot;
  }

  function removePlot(id) {
    const list = state.plots || [];
    if (list.length <= 1) return false; // 至少留一个图页，删空了可视化区就没东西可画
    const index = list.findIndex((p) => p.id === id);
    if (index < 0) return false;
    list.splice(index, 1);
    if (state.activePlot === id) {
      const next = list[Math.min(index, list.length - 1)];
      state.activePlot = next.id;
      state.subview = next.view;
    }
    persist();
    return true;
  }

  function updatePlot(id, patch) {
    const plot = plotById(id);
    if (!plot) return null;
    Object.assign(plot, patch || {});
    persist();
    return plot;
  }

  // 勾选通道：第一次动就把当前可见集合固化成独立清单，之后这个图页只画清单里的通道
  function togglePlotChannel(id, channelId) {
    const plot = plotById(id);
    if (!plot) return null;
    const current = Array.isArray(plot.channels)
      ? plot.channels.slice()
      : plotChannels(plot).map((ch) => ch.id);
    const at = current.indexOf(channelId);
    if (at >= 0) current.splice(at, 1);
    else current.push(channelId);
    plot.channels = current;
    persist();
    return plot;
  }

  function setPlotChannels(id, channelIds, options) {
    const plot = plotById(id);
    if (!plot) return null;
    plot.channels = (Array.isArray(channelIds) ? channelIds : []).slice();
    // 「跟随全局」是一个显式选项，不然用户没法从这个图页的独立清单退回全局
    if (options && options.follow) plot.channels = null;
    persist();
    return plot;
  }

  // 存档里的图页要过一遍：图种必须是认识的，通道清单必须是字符串数组，
  // 否则一个坏字段会让整个可视化区渲染不出来
  function normalizePlot(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: String(raw.id || ('p' + (index + 1))),
      name: String(raw.name || '').slice(0, 20),
      view: VIEW_LABELS[raw.view] ? String(raw.view) : 'wave',
      channels: Array.isArray(raw.channels) ? raw.channels.map(String) : null
    };
  }

  // 公式名：通道 id 在 WED 规格下是 wed-fc-01 这种带横杠的串，直接当 new Function 的形参名会语法报错，
  // 所以给每个通道算一个安全的「公式名」（ch1 保持 ch1，wed-fc-01 退化成 c01）；中文通道名本身也是合法标识符，一并绑上。
  // 中文通道名（横滚角）本身也是合法标识符，允许当公式名用；只有空格、减号、点号这些才要换掉
  function identSafe(text) { return /^[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*$/.test(String(text || "")); }

  function formulaNameOf(id) {
    const key = String(id || "");
    if (identSafe(key)) return key;
    const digits = (key.match(/\d+/g) || []).join("");
    return "c" + (digits || "x");
  }

  function formulaAlias(id) { return formulaNameOf(id); }

  // 分析窗口点数（设置 → 采集与窗口）。快速公式模式原来写死 slice(-100)，用户在设置里
  // 把它改成 2000 也照样只算最近 100 点，而节点画布读的正是这个设置——同一份设置两套行为，
  // 界面上没有任何地方说明，用户只会觉得「写了 mean(ch1) 结果不对」。
  function analysisWindowPoints() {
    return Math.max(16, Math.min(200000, Number(state.analysis.windowPoints) || 2000));
  }

  // 公式的作用域：所有通道（含脚本通道）按公式名和中文名各绑一份最近 N 点（N = 分析窗口点数），
  // 这样公式里写别的通道不会再报 "xxx is not defined"，单通道脚本也就只需要它自己。
  function formulaScope() {
    const params = {};
    const labels = {};
    const seed = (key, value, label) => {
      if (!key || !identSafe(key) || Object.prototype.hasOwnProperty.call(params, key)) return;
      params[key] = value;
      labels[key] = label;
    };
    const take = analysisWindowPoints();
    const channels = allChannels();
    channels.forEach((ch) => {
      seed(formulaNameOf(ch.id), Array.isArray(ch.data) ? ch.data.slice(-take) : [], ch.name);
    });
    channels.forEach((ch) => {
      seed(String(ch.name || "").replace(/[^\w$\u4e00-\u9fa5]/g, ""), Array.isArray(ch.data) ? ch.data.slice(-take) : [], ch.name);
    });
    return { params: params, labels: labels };
  }

  function addScriptChannel(output) {
    const range = Array.isArray(output.range) ? output.range : [0, 100];
    const ch = makeChannel({
      id: uid('sc'),
      name: output.label || ('脚本输出' + (state.scriptChannels.length + 1)),
      unit: output.unit || '',
      color: output.color || 'auto',
      range: range,
      base: 0,
      amp: 0,
      freq: 0,
      noise: 0,
      waveform: 'sine',
      visible: true,
      isScript: true,
      scriptId: output.scriptId || '',
      outputId: output.id || '',
      sourceType: output.sourceType || 'analysis'
    });
    state.scriptChannels.push(ch);
    return ch;
  }

  function removeScriptChannel(id) {
    state.scriptChannels = state.scriptChannels.filter(ch => ch.id !== id);
  }

  function clearScriptChannels() {
    state.scriptChannels = [];
  }

  // 内存历史：按“小时”配置，采样间隔变化时重算点数
  function historyPointsFor(hours, intervalMs) {
    const dtSec = Math.max(0.001, (Number(intervalMs) || 100) / 1000);
    const h = Math.max(1, Math.min(24, Number(hours) || 5));
    return Math.max(2, Math.round(h * 3600 / dtSec));
  }

  function historyPointLimit() {
    return Math.max(2, Math.round(Number(state.historyPoints) || 2));
  }

  // 所有通道写入都必须走这里，保证窗口裁剪只有一处实现
  // 分块裁剪的余量：数组超过「窗口 + 余量」才裁一次。
  // 原来每来一个点就 splice 一次，180k 点的窗口等于每点搬 18 万次内存（实测 68× 开销）；
  // 现在每 2048 点才搬一次，代价是数组最多比逻辑窗口多 2048 点 —— 所有读路径都按窗口取末尾，不受影响。
  const HISTORY_TRIM_SLACK = 2048;

  // 采样元数据只驻内存，不进入配置快照。数组被重置时自动失效。
  const sampleTimelines = new WeakMap();

  function sampleTimeline(ch) {
    const m = ch && sampleTimelines.get(ch);
    return m && m.data === ch.data && m.times.length === ch.data.length ? m : null;
  }

  function sampleTime(ch, index) {
    const m = sampleTimeline(ch);
    const t = m && m.times[index];
    return Number.isFinite(t) ? t : state.t - (ch.data.length - 1 - index) * state.intervalMs / 1000;
  }

  function sampleValid(ch, index) {
    const m = sampleTimeline(ch);
    return !m || m.valid[index] !== false;
  }

  // 二分定位，支持不同采样率的通道；floor/ceil 用于窗口边缘，nearest 用于游标。
  function sampleIndex(ch, time, mode) {
    const n = ch.data.length;
    if (!n) return -1;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sampleTime(ch, mid) < time) lo = mid + 1;
      else hi = mid;
    }
    if (mode === 'ceil') return Math.min(n - 1, lo);
    if (mode === 'floor') return Math.max(0, lo < n && sampleTime(ch, lo) === time ? lo : lo - 1);
    if (lo === 0 || lo === n) return Math.min(n - 1, lo);
    return time - sampleTime(ch, lo - 1) <= sampleTime(ch, lo) - time ? lo - 1 : lo;
  }

  function sampleGapLimit(ch) {
    const m = sampleTimeline(ch);
    return Math.max(0.25, 5 * (m && m.step || state.intervalMs / 1000));
  }

  function trimSamples(ch, count) {
    const m = sampleTimeline(ch);
    ch.data.splice(0, count);
    if (m) {
      m.times.splice(0, count);
      m.walls.splice(0, count);
      m.valid.splice(0, count);
      m.outOfRange.splice(0, count);
    }
  }

  function pushSample(ch, value, meta) {
    let m = sampleTimeline(ch);
    if (!m) {
      const n = ch.data.length;
      m = { data: ch.data, times: new Array(n).fill(null), walls: new Array(n).fill(null), valid: new Array(n).fill(true), outOfRange: new Array(n).fill(false), step: 0 };
      sampleTimelines.set(ch, m);
    }
    const t = meta && Number.isFinite(meta.t) ? meta.t : state.t;
    const wall = meta && Number.isFinite(meta.wall) ? meta.wall : Date.now();
    const prev = m.times[m.times.length - 1];
    const delta = Number.isFinite(prev) ? t - prev : 0;
    if (delta > 0 && (!m.step || delta <= m.step * 5)) m.step = m.step ? m.step * .9 + delta * .1 : delta;
    ch.data.push(value);
    m.times.push(t);
    m.walls.push(wall);
    m.valid.push(!meta || meta.valid !== false);
    m.outOfRange.push(value < ch.range[0] || value > ch.range[1]);
    const limit = historyPointLimit();
    if (ch.data.length > limit + HISTORY_TRIM_SLACK) {
      trimSamples(ch, ch.data.length - limit);
    }
  }

  // 只裁不扩：缩短窗口或提高采样率后立即生效
  function applyHistoryWindow() {
    const limit = historyPointLimit();
    allChannels().forEach(ch => {
      if (ch.data.length > limit) trimSamples(ch, ch.data.length - limit);
    });
    return limit;
  }

  function setHistoryHours(hours) {
    state.historyHours = Math.max(1, Math.min(24, Number(hours) || 5));
    state.historyPoints = historyPointsFor(state.historyHours, state.intervalMs);
    applyHistoryWindow();
    persist();
    return state.historyHours;
  }

  function setIntervalMs(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return state.intervalMs;
    state.intervalMs = next;
    state.historyPoints = historyPointsFor(state.historyHours, state.intervalMs);
    applyHistoryWindow();
    persist();
    return state.intervalMs;
  }

  function updateScriptChannels(values, scriptId) {
    state.scriptChannels.forEach(ch => {
      if (scriptId && ch.scriptId !== scriptId) return;
      const raw = values[ch.outputId] != null ? values[ch.outputId] : values[ch.name] != null ? values[ch.name] : values[ch.id];
      if (raw == null || !Number.isFinite(Number(raw))) return;
      pushSample(ch, Number(raw));
    });
  }

  function getActiveEngine() {
    return state.engines.find(engine => engine.active) || state.engines.find(engine => engine.id === state.activeEngine) || state.engines[0] || null;
  }

  function setActiveEngine(id) {
    state.engines.forEach(engine => { engine.active = engine.id === id; });
    state.activeEngine = id;
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:engine-active-changed', { detail: { id: id } }));
  }

  function addEngine(engine) {
    const item = Object.assign({
      id: uid('engine'),
      name: '自定义数据引擎',
      protocol: 'ASCII',
      header: '',
      tail: '',
      terminator: '\n',
      checksum: 'NONE',
      byteOrder: 'little',
      hexScale: 10,
      payloadBytes: 40,
      channelCount: 20,
      protocolId: '',
      active: false,
      description: ''
    }, engine);
    if (!item.id) item.id = uid('engine');
    state.engines.push(item);
    persist();
    return item;
  }

  function removeEngine(id) {
    state.engines = state.engines.filter(engine => engine.id !== id);
    if (!state.engines.some(engine => engine.active) && state.engines.length) state.engines[0].active = true;
    if (state.activeEngine === id) state.activeEngine = state.engines[0] ? state.engines[0].id : '';
    persist();
  }

  function crc16(text) {
    let crc = 0xFFFF;
    for (let i = 0; i < text.length; i++) {
      crc ^= text.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
      }
    }
    return crc.toString(16).padStart(4, '0').toUpperCase();
  }

  function encodeEngineFrame(values) {
    const engine = getActiveEngine();
    if (!engine) return '';
    if (engine.protocol === 'JSON') {
      return JSON.stringify({ t: Number(state.t.toFixed(2)), ch: values });
    }
    if (engine.protocol === 'HEX') {
      const body = values.map(value => {
        const n = Math.round(Math.abs(Number(value)) * 10) & 0xFFFF;
        return n.toString(16).padStart(4, '0').toUpperCase();
      }).join('');
      const prefix = String(engine.header || '').replace(/[^0-9a-fA-F]/g, '');
      const suffix = String(engine.tail || '').replace(/[^0-9a-fA-F]/g, '');
      return prefix + body + suffix;
    }
    if (engine.protocol === 'WED' && window.XHGCS_PROTOCOL && window.XHGCS_PROTOCOL.encodeHex) return window.XHGCS_PROTOCOL.encodeHex(values, engine);
    const body = Object.entries(values).map(([key, value]) => key + ':' + value.toFixed(2)).join(',');
    let frame = String(engine.header || '') + body + String(engine.tail || '');
    if (engine.checksum === 'CRC16') frame += '*' + crc16(frame);
    return frame + String(engine.terminator || '');
  }

  function applyProtocolChannels(engine) {
    const P = window.XHGCS_PROTOCOL;
    if (!P || !P.isWed || !P.isWed(engine)) return 0;
    const templates = P.channelTemplates(engine);
    if (!templates.length) return 0;
    state.channels = templates.map(makeChannel);
    state.selectedChannel = state.channels[0] ? state.channels[0].id : '';
    state.protocol = {
      id: engine.id || '',
      name: engine.name || '',
      protocol: engine.protocol || 'WED',
      channelCount: state.channels.length,
      updatedAt: Date.now()
    };
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:protocol-changed', { detail: { protocol: state.protocol } }));
    if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderChannelCards === 'function') window.XHGCS_VIEWS.renderChannelCards();
    if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderGaugeCards === 'function') window.XHGCS_VIEWS.renderGaugeCards();
    if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderSimControls === 'function') window.XHGCS_VIEWS.renderSimControls();
    if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderThresholdRows === 'function') window.XHGCS_VIEWS.renderThresholdRows();
    return state.channels.length;
  }

  // 非 WED 协议（CSV/ASCII/JSON/HEX）：通道由设备的数据流决定，应用协议时先清空旧通道，
  // 首帧到达后注入端按通道名/个数自动建通道；图页里的旧通道引用一并清掉，等发现后自动补齐。
  function prepareDiscovery(engine) {
    state.channels = [];
    state.selectedChannel = '';
    state.protocol = {
      id: (engine && engine.id) || '',
      name: (engine && engine.name) || '',
      protocol: (engine && engine.protocol) || 'CSV',
      channelCount: 0,
      updatedAt: Date.now()
    };
    (Array.isArray(state.plots) ? state.plots : []).forEach((plot) => { plot.channels = []; });
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:protocol-changed', { detail: { protocol: state.protocol } }));
  }

  // ---- 输入页保存（v43）：协议字段 + 通道名字/颜色/单位快照 ----
  function addInputSave(item) {
    const save = {
      id: uid('insave'),
      name: String((item && item.name) || '未命名保存').slice(0, 48),
      savedAt: new Date().toISOString(),
      fields: Object.assign({}, (item && item.fields) || {}),
      channels: ((item && item.channels) || []).map((ch) => ({
        id: String(ch.id || ''),
        name: String(ch.name || ''),
        unit: String(ch.unit || ''),
        color: String(ch.color || '')
      }))
    };
    state.inputSaves = Array.isArray(state.inputSaves) ? state.inputSaves : [];
    state.inputSaves.unshift(save);
    if (state.inputSaves.length > 50) state.inputSaves.length = 50;
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:input-saves-changed'));
    return save;
  }

  function removeInputSave(id) {
    if (!Array.isArray(state.inputSaves)) return false;
    const index = state.inputSaves.findIndex((save) => save.id === id);
    if (index < 0) return false;
    state.inputSaves.splice(index, 1);
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:input-saves-changed'));
    return true;
  }

  function applyInputSave(id) {
    const save = (Array.isArray(state.inputSaves) ? state.inputSaves : []).find((item) => item.id === id);
    if (!save) return null;
    const fields = save.fields || {};
    const protocol = String(fields.protocol || '').toUpperCase();
    const protocolId = String(fields.protocolId || '');
    let engine = state.engines.find((item) => {
      if (String(item.protocol || '').toUpperCase() !== protocol) return false;
      if (protocolId) return String(item.protocolId || '') === protocolId;
      return !String(item.protocolId || '');
    }) || null;
    if (engine) Object.assign(engine, fields);
    else engine = addEngine(fields);
    setActiveEngine(engine.id);
    if (engine.protocol === 'WED') applyProtocolChannels(engine);
    else if (String(engine.protocol || '').toUpperCase() === 'CSV') prepareDiscovery(engine);
    // WED 重建后通道 id 不变：按 id 回填名字/颜色/单位（数据不动）。
    // 自动发现的通道（CSV/ASCII）id 每次会话重生成，id 找不到时按保存时记下的名字找。
    (save.channels || []).forEach((saved) => {
      let ch = state.channels.find((item) => String(item.id) === saved.id);
      if (!ch && saved.name) ch = state.channels.find((item) => item.name === saved.name);
      if (!ch) return;
      if (saved.name) ch.name = saved.name;
      ch.unit = saved.unit;
      if (saved.color) ch.color = saved.color;
    });
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:engines-changed'));
    return engine;
  }

  // 截断必须留下痕迹：以前砍到 4000 是无声的，用户分不清「模型没写完」和「软件吞了」
  function clipAiContent(content) {
    const value = String(content == null ? '' : content);
    if (value.length <= AI_MESSAGE_LIMIT) return value;
    return value.slice(0, AI_MESSAGE_LIMIT) + '\n\n…（已超出 ' + AI_MESSAGE_LIMIT + ' 字符上限，后续内容被截断）';
  }

  function addAiMessage(role, content, meta) {
    const message = { id: uid('ai'), role: role, content: clipAiContent(content), time: Date.now(), meta: meta || null };
    state.ai.messages.push(message);
    if (state.ai.messages.length > 60) state.ai.messages.shift();
    persist();
    return message;
  }

  function clearAiMessages() {
    state.ai.messages = [];
    persist();
  }

  function updateAiMessage(id, patch, save) {
    const message = state.ai.messages.find((item) => item.id === id);
    if (!message) return null;
    Object.assign(message, patch || {});
    message.content = clipAiContent(message.content);
    if (save !== false) persist();
    return message;
  }

  function addAiTask(payload) {
    const task = {
      id: uid('task'),
      type: payload.type || 'ai',
      name: String(payload.name || 'AI 子任务').slice(0, 80),
      status: payload.status || 'running',
      message: String(payload.message || '').slice(0, 900),
      speech: String(payload.speech || payload.message || '').slice(0, 900),
      details: payload.details || null,
      source: payload.source || 'local',
      createdAt: Date.now(),
      finishedAt: (payload.status === 'success' || payload.status === 'error') ? Date.now() : 0
    };
    state.ai.tasks.unshift(task);
    if (state.ai.tasks.length > 80) state.ai.tasks.length = 80;
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:ai-tasks-changed', { detail: { task: task, action: 'add' } }));
    return task;
  }

  // 任务状态跟着配置进了 localStorage，可请求活不过一次重载：上次没跑完的任务恢复出来
  // 还是「运行中」，还被统计行算进「运行 N」，看着像永远在跑。启动与导入时统一标成
  // 「已中断」——它既没成功也没失败，写「失败」是假话；finishedAt 保持 0，别编个假时长。
  function interruptStaleAiTasks(tasks) {
    if (!Array.isArray(tasks)) return 0;
    let changed = 0;
    tasks.forEach((task) => {
      if (!task || (task.status !== 'running' && task.status !== 'pending')) return;
      task.status = 'interrupted';
      task.message = '重载前的请求未完成';
      changed += 1;
    });
    return changed;
  }

  function updateAiTask(id, patch) {
    const task = state.ai.tasks.find((item) => item.id === id);
    if (!task) return null;
    Object.assign(task, patch || {});
    if (task.status === 'success' || task.status === 'error') task.finishedAt = Date.now();
    task.message = String(task.message || '').slice(0, 900);
    task.speech = String(task.speech || task.message || '').slice(0, 900);
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:ai-tasks-changed', { detail: { task: task, action: 'update' } }));
    return task;
  }

  function aiMessagesForStorage() {
    return state.ai.messages.slice(-AI_STORAGE_MESSAGE_LIMIT).map((message) => {
      const copy = Object.assign({}, message);
      if (copy.raw === copy.content) delete copy.raw;
      else if (copy.raw) copy.raw = clipAiContent(copy.raw);
      if (copy.meta && typeof copy.meta === 'object') {
        copy.meta = Object.assign({}, copy.meta);
        delete copy.meta.streaming;
      }
      return copy;
    });
  }

  function mcpStateForStorage() {
    const copy = Object.assign({}, state.mcp);
    ['deletedScripts', 'deletedEngines', 'deletedComponents', 'deletedViews'].forEach((key) => {
      copy[key] = Array.isArray(copy[key]) ? copy[key].slice(-DELETED_ID_LIMIT) : [];
    });
    return copy;
  }

  function removeAiTask(id) {
    const index = state.ai.tasks.findIndex((item) => item.id === id);
    if (index < 0) return false;
    state.ai.tasks.splice(index, 1);
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:ai-tasks-changed', { detail: { id: id, action: 'remove' } }));
    return true;
  }

  function clearAiTasks() {
    state.ai.tasks = [];
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:ai-tasks-changed', { detail: { action: 'clear' } }));
  }

  function getDataSnapshot(frameCount) {
    const count = Math.max(0, Math.min(100, Number(frameCount) || 0));
    // range 一并带上：AI 提示词要给模型量程，MCP 快照那边也缺这个字段
    const channelRange = ch => Array.isArray(ch.range) ? ch.range.slice(0, 2) : null;
    // 阈值一并带上：AI 和 MCP 以前只看得到最新值，问「为什么这条一直在报警」无从回答。
    // null 表示这一侧不报警（makeChannel 的约定）。
    const channelThresholds = ch => ({
      warnLow: ch.warnLow == null ? null : Number(ch.warnLow),
      warnHigh: ch.warnHigh == null ? null : Number(ch.warnHigh)
    });
    const raw = state.channels.map(ch => Object.assign({ id: ch.id, name: ch.name, unit: ch.unit, value: ch.data.length ? ch.data[ch.data.length - 1] : null, points: ch.data.length, color: ch.color, visible: ch.visible, range: channelRange(ch) }, channelThresholds(ch)));
    const script = state.scriptChannels.map(ch => Object.assign({ id: ch.id, name: ch.name, unit: ch.unit, value: ch.data.length ? ch.data[ch.data.length - 1] : null, points: ch.data.length, color: ch.color, scriptId: ch.scriptId, range: channelRange(ch) }, channelThresholds(ch)));
    const series = {};
    allChannels().forEach(ch => { series[ch.id] = ch.data.slice(-100).map(Number); });
    return {
      timestamp: Date.now(),
      t: Number(state.t.toFixed(2)),
      playing: state.playing,
      raw: raw,
      script: script,
      series: series,
      serial: { source: state.simulation.enabled ? 'simulation' : 'realserial', simulation: state.simulation.enabled, connected: state.serial.connected, running: state.serial.running, frames: state.serial.frames, rxBytes: state.serial.rxBytes, txBytes: state.serial.txBytes, errors: state.serial.errors, breaks: state.serial.breaks, receiving: state.serial.receiving, lastError: state.serial.lastError || '', port: state.serial.port, baud: state.serial.baud, rate: Number(state.serial.rate) || 0 },
      // 录制状态：MCP 的快照以前只有串口计数，Agent 无法判断「现在是不是在录」。
      recording: (() => {
        const r = window.XHGCS_RECORDER;
        return {
          active: Boolean(r && r.recording),
          rows: r ? Number(r.sessionRows) || 0 : 0,
          dropped: r ? Number(r.droppedRows) || 0 : 0,
          enabled: (state.recordings || {}).enabled !== false
        };
      })(),
      logs: state.logs.slice(-count).map(log => ({ time: log.time, kind: log.kind, text: log.text })),
      alarms: state.alarms.slice(0, 30).map(alarm => ({ id: alarm.id, name: alarm.name, value: alarm.value, unit: alarm.unit, level: alarm.level, ack: alarm.ack, time: alarm.time })),
      scripts: state.scripts.map(script => ({ id: script.id, name: script.name, type: script.type, description: script.description || '', outputs: script.outputs || [] })),
      components: state.components.map(component => ({ id: component.id, name: component.name, kind: component.kind, description: component.description || '', inputs: (component.inputs || []).length, outputs: (component.outputs || []).length, parameters: (component.parameters || []).length, builtin: Boolean(component.builtin), origin: component.origin || '' })),
      engines: state.engines.map(engine => ({ id: engine.id, name: engine.name, protocol: engine.protocol, protocolId: engine.protocolId || '', checksum: engine.checksum || 'NONE', payloadBytes: engine.payloadBytes || null, channelCount: engine.channelCount || null, active: engine.active, description: engine.description || '' })),
      activeEngine: state.activeEngine,
      protocol: state.protocol,
      analysis: { mode: state.analysis.mode, lastRun: state.analysis.lastRun, lastError: state.analysis.lastError, outputs: state.analysis.outputs || [], canvas: state.analysis.canvas || { nodes: [], edges: [] } },
      ai: {
        tasks: (state.ai.tasks || []).slice(0, 20).map((task) => ({ id: task.id, type: task.type, name: task.name, status: task.status, message: String(task.message || '').slice(0, 140), source: task.source, createdAt: task.createdAt, finishedAt: task.finishedAt })),
        tts: {
          enabled: (state.ai.tts || {}).enabled !== false,
          engine: (state.ai.tts || {}).engine || 'browser',
          voice: (state.ai.tts || {}).voice || 'default',
          autoSpeak: (state.ai.tts || {}).autoSpeak !== false,
          mode: (state.ai.tts || {}).mode || ((state.ai.tts || {}).autoSpeak === false ? 'alarm' : 'chat'),
          worker: window.XHGCS_TTS_WORKER && typeof window.XHGCS_TTS_WORKER.status === 'function' ? window.XHGCS_TTS_WORKER.status() : {}
        }
      }
    };
  }

  function formatChannelValue(ch, value, fallback) {
    const num = Number(value);
    const P = window.XHGCS_PROTOCOL;
    const display = ch && (ch.protocolDisplay || (ch.protocol ? 'raw' : ''));
    if (P && P.formatChannelValue && display) {
      const text = P.formatChannelValue({
        display: display,
        byteNames: ch.byteNames,
        bitLabels: ch.bitLabels,
        decimals: ch.decimals,
        unit: ch.unit
      }, num);
      if (text !== '--') return text;
    }
    if (!Number.isFinite(num)) return '--';
    const decimals = Math.max(0, Math.min(6, Number(ch && ch.decimals != null ? ch.decimals : fallback != null ? fallback : 1) || 0));
    return num.toFixed(decimals);
  }

  function sampleValue(ch) {
    const now = Date.now();
    if (ch.faultUntil > now) {
      if (ch.faultKind === 'high') return clamp(ch.range[1], ch.range[0], ch.range[1]);
      if (ch.faultKind === 'drop') return clamp(ch.range[0], ch.range[0], ch.range[1]);
      if (ch.faultKind === 'jump') return ch.base + (Math.random() - 0.5) * (ch.range[1] - ch.range[0]) * 0.8;
    }
    const phase = state.t * ch.freq * Math.PI * 2;
    let wave = 0;
    if (ch.waveform === 'triangle') wave = (2 / Math.PI) * Math.asin(Math.sin(phase));
    else if (ch.waveform === 'square') wave = Math.sin(phase) >= 0 ? 1 : -1;
    else if (ch.waveform === 'pulse') wave = Math.sin(phase) > 0.72 ? 1 : -0.45;
    else if (ch.waveform === 'noise') wave = (Math.random() - 0.5) * 2;
    else wave = Math.sin(phase);
    const noisy = (Math.random() - 0.5) * 2 * ch.noise;
    const raw = (ch.base + ch.amp * wave + noisy) * ch.scale + ch.offset;
    return clamp(raw, ch.range[0], ch.range[1]);
  }

  function trackPoint(time) {
    return {
      x: 125 * Math.sin(time * 0.32) + 45 * Math.sin(time * 0.86 + 1.4),
      y: 105 * Math.cos(time * 0.24) + 38 * Math.sin(time * 0.9 + 2.7)
    };
  }

  function updateTrack() {
    if (state.homeMode) {
      const last = state.track.length ? state.track[state.track.length - 1] : { x: 0, y: 0 };
      const nx = last.x * 0.91;
      const ny = last.y * 0.91;
      state.track.push({ x: nx, y: ny });
      if (Math.hypot(nx, ny) < 1.5) {
        state.homeMode = false;
        state.cruise = true;
        pushLog('sys', '返航完成，已恢复自动巡航');
      }
    } else if (state.cruise) {
      state.track.push(trackPoint(state.t));
    }
    if (state.track.length > 700) state.track.shift();
  }

  // 预警/严重阈值的唯一来源：告警引擎、阈值面板与告警可视化都用它，避免三处各算一套。
  // 阈值默认是 null（这一侧不报警）：真实信号的范围在接上设备之前谁也不知道，
  // 从量程猜出来的线只会让一开机满屏告警。用户在「告警」页填了哪一侧，哪一侧才生效。
  // 严重线由预警带推（预警带再往外 50%），且只有两侧都设了才存在 —— 单侧设阈值时不猜严重线。
  function alarmThresholds(ch) {
    const num = (value) => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const hi = num(ch.warnHigh);
    const lo = num(ch.warnLow);
    const band = hi != null && lo != null && hi > lo ? hi - lo : 0;
    return {
      warnHigh: hi,
      warnLow: lo,
      dangerHigh: band ? hi + band * 0.5 : null,
      dangerLow: band ? lo - band * 0.5 : null
    };
  }

  function getAlarm(ch) {
    const t = alarmThresholds(ch);
    const last = ch.data[ch.data.length - 1];
    if (last == null) return { level: 'ok', label: '正常', value: last };
    const value = Number(last);
    if (!Number.isFinite(value)) return { level: 'ok', label: '正常', value: last };
    // 两侧都没设 = 这个通道不参与告警
    if (t.warnHigh == null && t.warnLow == null) return { level: 'ok', label: '未设阈值', value: last };
    if (t.dangerHigh != null && value >= t.dangerHigh) return { level: 'high', label: '严重高值', value: last };
    if (t.dangerLow != null && value <= t.dangerLow) return { level: 'high', label: '严重低值', value: last };
    if (t.warnHigh != null && value >= t.warnHigh) return { level: 'warn', label: '预警高值', value: last };
    if (t.warnLow != null && value <= t.warnLow) return { level: 'warn', label: '预警低值', value: last };
    return { level: 'ok', label: '正常', value: last };
  }

  // 一次性迁移：早期版本会给每个通道凭空算一对阈值 —— 协议通道按量程 ±2%
  // （`range[1] - span*0.02`），其余按 `base ± |amp|*1.6 ± noise`。接上真设备之后
  // 这些线几乎没有一条是对的（传感器规格量程 0..65535，±2% 就是 1310.7 / 64224.3，
  // 正常读数全被判成越限），所以要把它们清成「没设」。
  // 只清「精确等于旧公式算出来的值」的那些：用户自己填过的数字不会等于公式值。
  //
  // 必须传入要迁移的那份状态、且不在这里 persist：它在 loadState 里被调用时，
  // 模块级的 `state` 还在暂时性死区里（`const state = loadState()` 正是它自己），
  // 直接读模块级 state 会让 loadState 抛 ReferenceError，整个 data.js 中断、
  // 应用静默变白 —— 而且只有「本地存过配置」的机器才走得到这条路。
  function migrateFabricatedThresholds(target) {
    const st = target || state;
    if (!st) return 0;
    // 用版本号而不是布尔：第一版迁移只认「精确等于旧公式」的值，装机验证时发现
    // 高阈值还残着 65535（那是旧补丁 `warnHigh = range[1]` 留下的），补了边界规则。
    // 用版本号才能保证已经跑过第一版的机器也会重跑一遍。
    const MIGRATION_VERSION = 2;
    if ((Number(st.thresholdsMigrated) || 0) >= MIGRATION_VERSION) return 0;
    st.thresholdsMigrated = MIGRATION_VERSION;
    const channels = (st.channels || []).concat(st.scriptChannels || []);
    const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
    let cleared = 0;
    channels.forEach((ch) => {
      const span = ch.range[1] - ch.range[0];
      if (!Number.isFinite(span) || span <= 0) return;
      const high = [
        ch.range[1] - span * 0.02,
        Math.min(ch.range[1] - span * 0.02, Math.max(ch.range[0] + span * 0.05, ch.base + Math.abs(ch.amp) * 1.6 + ch.noise))
      ];
      const low = [
        ch.range[0] + span * 0.02,
        Math.max(ch.range[0] + span * 0.02, Math.min(ch.range[1] - span * 0.05, ch.base - Math.abs(ch.amp) * 1.6 - ch.noise))
      ];
      // 还有一类残留：旧代码在阈值串位时会把 warnHigh 直接补成量程上限
      // （`ch.warnHigh = ch.range[1]`），原始 ADC 通道上就是 65535 = 0xFFFF 那个
      // 「传感器无数据」哨兵值。卡在量程边界上的阈值等于永不触发，一并清掉。
      // 用精确相等而不是「超出量程」：用户可能故意先设一个比当前量程大的阈值
      // （知道信号以后会涨上去），那种不该被清。
      if (ch.warnHigh != null && (high.some((v) => same(ch.warnHigh, v)) || ch.warnHigh === ch.range[1])) {
        ch.warnHigh = null;
        cleared += 1;
      }
      if (ch.warnLow != null && (low.some((v) => same(ch.warnLow, v)) || ch.warnLow === ch.range[0])) {
        ch.warnLow = null;
        cleared += 1;
      }
    });
    // 清掉过东西，就说明这份存档里确实有旧版本自动生成的阈值。剩下那些对不上公式的
    // （旧公式按创建时的量程算，量程后来被输入数据撑大/收窄过就再也对不上）也可能是
    // 垃圾，但没法自动判定 —— 交给下面的 alignThresholdsToProtocol 按协议判，
    // 判不了的（用户自己建的通道）留一个一次性提示，把用户引到告警页的「全部清空」。
    if (cleared) st.thresholdsNotice = true;
    return cleared;
  }

  // 第二轮：阈值以「协议声明」为准 —— 协议在某一侧没给阈值的通道，那一侧一律清成「未设」。
  //
  // 为什么不能只靠上一轮的公式匹配：旧代码是在每次 normalize 时按 *当时的量程* 补值的
  // （`if (!hasOwnProperty(ch,'warnLow')) ch.warnLow = range[0] + span*0.02`），而量程会被
  // 输入数据撑大（data.js 里 `range[1] = max(range[1], |next|*1.2)`）。实测的存档里就同时
  // 躺着三批对不上的值：1310.7 / 64224.3（[0,65535] 的 ±2%，可这两条通道的量程已经被
  // 撑到 [0,78642]）、4000（= 0.02×200000）、900（= 0.02×45000）、3999.7（= 0.02×199985）。
  // 也就是说：值本身已经不带来源信息了，再往公式表里加候选只是打地鼠。
  //
  // 换判据：通道能对上协议表某条声明时，协议没给的那一侧就是「本来就不该报警」。
  // WED 传感器/计数通道（协议表里没有 warnLow/warnHigh 字段）由此全部清干净；
  // 协议给了阈值的（电机 1040/1480、姿态角 ±150 那些飞控工况线）原样保留；
  // 用户自己建的通道 protocolId 对不上协议表，一律不碰 —— 那种没法判断。
  //
  // 必须由 protocol.js 加载完之后调用：data.js 自己的脚本排在 protocol.js 前面，
  // 那时候 window.XHGCS_PROTOCOL 还不存在（本函数要协议表才能判）。
  function alignThresholdsToProtocol(profiles) {
    if (!profiles || typeof profiles !== 'object') return 0;
    // 版本标记：清完就落盘。否则用户之后在告警页手填的阈值会在下次启动被再清一遍。
    if ((Number(state.thresholdsAligned) || 0) >= 1) return 0;
    // protocolId → 槽位号 → 协议声明（传进来的是 protocol.js 的 WED_PROFILES）
    const byProfile = {};
    Object.keys(profiles || {}).forEach((id) => {
      const profile = profiles[id];
      if (!profile || !Array.isArray(profile.channels)) return;
      const slots = byProfile[id] || (byProfile[id] = {});
      profile.channels.forEach((def, index) => { if (def) slots[index] = def; });
    });
    const archived = [];
    let cleared = 0;
    allChannels().forEach((ch) => {
      const slots = byProfile[ch.protocolId];
      const def = slots && slots[ch.protocolIndex];
      if (!def) return;
      [['warnHigh', def.warnHigh], ['warnLow', def.warnLow]].forEach((pair) => {
        const key = pair[0];
        if (Number.isFinite(pair[1]) || ch[key] == null) return;
        archived.push({ name: ch.name, key: key, value: ch[key], at: Date.now() });
        ch[key] = null;
        cleared += 1;
      });
    });
    state.thresholdsAligned = 1;
    if (archived.length) {
      state.thresholdsArchived = (Array.isArray(state.thresholdsArchived) ? state.thresholdsArchived : []).concat(archived);
      state.thresholdsNotice = true;
    }
    persist();
    return cleared;
  }

  function updateAlarms() {
    // 快路径：没有阈值、也没有历史告警态的通道不可能产生任何变化。
    // 这一层把最常见的情况（纯仿真 / 没配阈值的现场）从「每通道构造告警对象」
    // 降成一次布尔扫描，减少每帧的临时对象分配；语义与原来完全一致。
    const list = allChannels();
    let armed = false;
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (ch.alertState || ch.warnLow != null || ch.warnHigh != null) { armed = true; break; }
    }
    if (!armed) return;
    list.forEach(ch => {
      const info = getAlarm(ch);
      if (info.level !== 'ok' && info.level !== ch.alertState) {
        state.alarms.unshift({
          id: uid('al'),
          time: Date.now(),
          channelId: ch.id,
          name: ch.name,
          unit: ch.unit,
          value: info.value,
          level: info.level,
          label: info.label,
          ack: false
        });
        ch.alertState = info.level;
      } else if (info.level === 'ok') {
        ch.alertState = null;
      }
    });
    if (state.alarms.length > 250) state.alarms.length = 250;
  }

  function ackAlarm(id) {
    const found = state.alarms.find(item => item.id === id);
    if (found) found.ack = true;
  }
  function ackAlarms() {
    state.alarms.forEach(item => { item.ack = true; });
  }
  function clearAlarms() {
    state.alarms = [];
    allChannels().forEach(ch => { ch.alertState = null; });
  }

  function pushLog(kind, text, bytes) {
    const entry = {
      id: uid('log'),
      time: Date.now(),
      kind: kind || 'rx',
      text: String(text).slice(0, 420)
    };
    state.logs.push(entry);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
    if (bytes) {
      if (kind === 'tx') state.serial.txBytes += bytes;
      if (kind === 'rx') state.serial.rxBytes += bytes;
    }
    return entry;
  }

  function clearLogs() {
    state.logs = [];
  }

  function pushSerialFrame() {
    if (!state.simulation.enabled && (!state.serial.connected || !state.serial.running)) return;
    state.serial.frames++;
    const values = {};
    state.channels.forEach(ch => {
      values[ch.name] = ch.data.length ? ch.data[ch.data.length - 1] : 0;
    });
    const engine = getActiveEngine();
    const frame = encodeEngineFrame(values);
    const text = '#' + String(state.serial.frames).padStart(5, '0') + ' [' + (engine ? engine.protocol : 'RAW') + '] ' + frame;
    const malformed = Math.random() < 0.003;
    if (malformed) {
      state.serial.errors++;
      pushLog('err', text + ' [CRC ERROR]', text.length + 13);
    } else {
      pushLog('rx', text, text.length);
    }
  }

  function handleCommand(raw) {
    const cmd = String(raw || '').trim();
    if (!cmd) return { response: '', type: 'empty' };
    const tx = pushLog('tx', 'TX> ' + cmd, cmd.length + 4);
    if (!state.serial.connected && !state.simulation.enabled) return { response: 'ERR: 链路未连接', type: 'error', log: tx };
    const upper = cmd.toUpperCase();
    let response = '';
    let type = 'ack';
    if (upper.startsWith('AT')) {
      response = '+OK: XiHe_GCS v2.0 · 固件在线 · 通道数=' + state.channels.length;
      type = 'at';
    } else if (upper.startsWith('PING')) {
      const ms = Math.round(2 + Math.random() * 8);
      response = 'PONG: ' + ms + 'ms';
      type = 'pong';
    } else if (upper.startsWith('ARM')) {
      response = 'ARM_OK: motor_arms=1 · mode=STABILIZE';
      type = 'arm';
    } else if (upper.startsWith('RTL')) {
      state.homeMode = true;
      state.cruise = false;
      response = 'RTL_CMD: home_mode=1 · cruise=0';
      type = 'rtl';
    } else if (upper.startsWith('WAYPOINT')) {
      const current = state.track.length ? state.track[state.track.length - 1] : { x: 0, y: 0 };
      state.waypoints.push({ id: uid('wp'), x: Math.round(current.x), y: Math.round(current.y), name: 'WP-' + (state.waypoints.length + 1) });
      response = 'WAYPOINT_OK: count=' + state.waypoints.length;
      type = 'waypoint';
    } else {
      response = 'ACK: ' + cmd;
    }
    const rx = pushLog('rx', 'RX< ' + response, response.length + 4);
    return { response: response, type: type, log: rx, tx: tx };
  }

  function stepData() {
    if (!state.playing || !state.simulation.enabled) return;
    state.t += state.intervalMs / 1000;
    const wall = Date.now();
    state.channels.forEach(ch => {
      pushSample(ch, sampleValue(ch), { t: state.t, wall: wall });
    });
    updateTrack();
    updateAlarms();
    pushSerialFrame();
    // 落盘与外部模块的统一采样钩子（每个采样点一次）
    window.dispatchEvent(new CustomEvent('xhgcs:sample', { detail: { t: state.t, wall: wall, source: 'simulation' } }));
  }

  function setSimulationEnabled(enabled) {
    state.simulation.enabled = Boolean(enabled);
    if (!state.simulation.enabled) {
      state.channels.forEach((ch) => { ch.faultUntil = 0; ch.faultKind = ''; });
    }
    persist();
    window.dispatchEvent(new CustomEvent('xhgcs:simulation-changed', { detail: { enabled: state.simulation.enabled } }));
    return state.simulation.enabled;
  }

  function channelAlias(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
  }

  function ensureRealChannel(name, value) {
    let base = String(name || '').trim().slice(0, 24) || ('串口通道' + (state.channels.length + 1));
    let candidate = base;
    let index = 2;
    while (state.channels.some((ch) => ch.name === candidate)) candidate = base + '#' + index++;
    const valueNum = Number(value) || 0;
    const low = Math.min(0, valueNum);
    const high = Math.max(10, Math.abs(valueNum) * 1.2);
    const ch = makeChannel({
      id: uid('rx'),
      name: candidate,
      unit: '',
      color: 'auto',
      range: [low, high],
      base: 0,
      amp: 0,
      freq: 0,
      noise: 0,
      waveform: 'sine',
      visible: true,
      remote: true
    });
    state.channels.push(ch);
    return ch;
  }

  function injectRealValues(values, meta) {
    const entries = Object.entries(values || {}).filter(([, value]) => value != null && Number.isFinite(Number(value)));
    if (!entries.length) return false;
    const map = {};
    const used = new Set();
    const unmatched = [];
    let added = false;
    entries.forEach(([key, value]) => {
      const ch = state.channels.find((item) => item.id === key || item.name === key || channelAlias(item.name) === channelAlias(key));
      if (ch && !used.has(ch.id)) {
        map[ch.id] = Number(value);
        used.add(ch.id);
      } else {
        unmatched.push([key, value]);
      }
    });
    const stillUnmatched = [];
    unmatched.forEach(([key, value]) => {
      const match = String(key).match(/^ch(\d+)$/i);
      const ch = match ? state.channels[Number(match[1]) - 1] || null : null;
      if (ch && !used.has(ch.id)) {
        map[ch.id] = Number(value);
        used.add(ch.id);
      } else {
        stillUnmatched.push([key, value]);
      }
    });
    const positional = stillUnmatched.filter(([key]) => /^(ch\d+|新通道|\d+)$/i.test(String(key).trim()));
    const createList = stillUnmatched.filter(([key]) => !/^(ch\d+|新通道|\d+)$/i.test(String(key).trim()));
    if (positional.length) {
      const free = state.channels.filter((ch) => !used.has(ch.id));
      positional.forEach(([key, value], index) => {
        const ch = free[index] || null;
        if (ch) {
          map[ch.id] = Number(value);
          used.add(ch.id);
        } else {
          createList.push([key, value]);
        }
      });
    }
    createList.forEach(([key, value]) => {
      const ch = ensureRealChannel(key, value);
      map[ch.id] = Number(value);
      added = true;
    });
    if (meta && meta.t != null && Number.isFinite(Number(meta.t))) {
      // 设备时钟复位后开启新的内存时间段，避免二分定位跨越倒序时间。
      if (serialClock && Number(meta.t) < serialClock.t) {
        allChannels().forEach(ch => { ch.data = []; sampleTimelines.delete(ch); });
        pushLog('sys', '设备时间戳回退，图表开启新时间段；已落盘记录保留');
      }
      // 帧自己带了时间戳（JSON 帧的 t/ts/time/timestamp）就以它为准，并顺势重设锚点
      state.t = Number(meta.t);
      serialClock = { perfMs: performance.now(), t: state.t };
    } else {
      // 按「距上一帧的真实间隔」推进，而不是从锚点绝对推算：锚点一旦变旧
      // （中间跑过仿真、或上一次串口会话残留），绝对推算会让 t 跳过去甚至倒退。
      // Math.max 再兜一层：期间若被别的来源推进过，时间轴只许前进。
      const perfMs = performance.now();
      if (!serialClock) serialClock = { perfMs: perfMs, t: state.t };
      const next = Math.max(state.t, serialClock.t + (perfMs - serialClock.perfMs) / 1000);
      serialClock = { perfMs: perfMs, t: next };
      state.t = next;
    }
    // 本帧没带到的通道会沿用上一帧的值（前向填充）。填充值必须能被认出来：
    // 20 通道的 WED 帧只携带部分通道时，落盘 CSV 里「测到的」和「抄来的」原本完全一样，
    // 事后做统计会把同一批数字算两遍。这里把填充过的通道 id 一并交给落盘一侧。
    const missing = [];
    const wall = Date.now();
    state.channels.forEach((ch) => {
      const forward = map[ch.id] == null;
      if (forward) missing.push(ch.id);
      const last = ch.data.length ? ch.data[ch.data.length - 1] : ch.base;
      // last 已经是工程值；缺帧保持时禁止再次施加倍率与偏移。
      const next = forward ? last : map[ch.id] * ch.scale + ch.offset;
      if (ch.remote && !ch.freezeRange) {
        ch.range[0] = Math.min(ch.range[0], next);
        ch.range[1] = Math.max(ch.range[1], Math.max(10, Math.abs(next) * 1.2));
      }
      // 量程仅用于显示，越界峰值必须完整留给录制与分析。
      pushSample(ch, next, { t: state.t, wall: wall, valid: !forward });
    });
    updateAlarms();
    if (added) {
      persist();
      if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderChannelCards === 'function') window.XHGCS_VIEWS.renderChannelCards();
      if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderGaugeCards === 'function') window.XHGCS_VIEWS.renderGaugeCards();
      if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderSimControls === 'function') window.XHGCS_VIEWS.renderSimControls();
      if (window.XHGCS_VIEWS && typeof window.XHGCS_VIEWS.renderThresholdRows === 'function') window.XHGCS_VIEWS.renderThresholdRows();
    }
    window.dispatchEvent(new CustomEvent('xhgcs:real-values', { detail: { values: map, t: state.t } }));
    window.dispatchEvent(new CustomEvent('xhgcs:sample', { detail: { t: state.t, wall: wall, filled: missing, source: 'serial' } }));
    return true;
  }

  window.XHGCS = {
    state: state,
    persist: persist,
    setTheme: setTheme,
    setFx: setFx,
    normalizeFx: normalizeFx,
    themeName: themeName,
    applyTheme: applyTheme,
    canvasColors: canvasColors,
  viewColor: viewColor,
    viewFont: VIEW_FONT,
    WAVE_LABELS: WAVE_LABELS,
    VIEW_LABELS: VIEW_LABELS,
    activePlot: activePlot,
    plotById: plotById,
    plotChannels: plotChannels,
    plotLabel: plotLabel,
    addPlot: addPlot,
    removePlot: removePlot,
    updatePlot: updatePlot,
    togglePlotChannel: togglePlotChannel,
    setPlotChannels: setPlotChannels,
    exportConfig: exportConfig,
    importConfig: importConfig,
    resetAll: resetAll,
    resetData: resetData,
    sampleValue: sampleValue,
    getAlarm: getAlarm,
    alarmThresholds: alarmThresholds,
    // 一次性迁移单独导出：回归用例要直接钉住「旧公式算出来的阈值会被清掉、手填的不会」
    migrateFabricatedThresholds: migrateFabricatedThresholds,
    // 第二轮对齐也单独导出：它由 protocol.js 在加载完成后调用，回归用例直接喂协议表就能验
    alignThresholdsToProtocol: alignThresholdsToProtocol,
    updateAlarms: updateAlarms,
    ackAlarm: ackAlarm,
    ackAlarms: ackAlarms,
    clearAlarms: clearAlarms,
    setSimulationEnabled: setSimulationEnabled,
    injectRealValues: injectRealValues,
    pushLog: pushLog,
    clearLogs: clearLogs,
    pushSerialFrame: pushSerialFrame,
    handleCommand: handleCommand,
    stepData: stepData,
    activeChannels: activeChannels,
    allChannels: allChannels,
    findChannel: findChannel,
    formulaScope: formulaScope,
    formulaAlias: formulaAlias,
    addScriptChannel: addScriptChannel,
    removeScriptChannel: removeScriptChannel,
    clearScriptChannels: clearScriptChannels,
    updateScriptChannels: updateScriptChannels,
    pushSample: pushSample,
    sampleTimeline: sampleTimeline,
    sampleTime: sampleTime,
    sampleValid: sampleValid,
    sampleIndex: sampleIndex,
    sampleGapLimit: sampleGapLimit,
    applyHistoryWindow: applyHistoryWindow,
    setHistoryHours: setHistoryHours,
    setIntervalMs: setIntervalMs,
    historyPointsFor: historyPointsFor,
    getActiveEngine: getActiveEngine,
    setActiveEngine: setActiveEngine,
    addEngine: addEngine,
    removeEngine: removeEngine,
    addComponent: addComponent,
    updateComponent: updateComponent,
    removeComponent: removeComponent,
    getComponent: getComponent,
    healComponentText: healComponentText,
    defaultComponents: defaultComponents,
    normalizeComponent: normalizeComponent,
    applyProtocolChannels: applyProtocolChannels,
    prepareDiscovery: prepareDiscovery,
    addInputSave: addInputSave,
    removeInputSave: removeInputSave,
    applyInputSave: applyInputSave,
    encodeEngineFrame: encodeEngineFrame,
    addAiMessage: addAiMessage,
    updateAiMessage: updateAiMessage,
    clearAiMessages: clearAiMessages,
    getDataSnapshot: getDataSnapshot,
    formatChannelValue: formatChannelValue,
    crc16: crc16,
    clamp: clamp,
    fmt: fmt,
    compactCount: compactCount,
    setCounter: setCounter,
    esc: esc,
    mcpUrl: mcpUrl,
    mcpFetch: mcpFetch,
    mcpJson: mcpJson,
    mcpHeaders: mcpHeaders,
    ensureMcpToken: ensureMcpToken,
    pythonOneLine: pythonOneLine,
    uid: uid,
    makeChannel: makeChannel,
    nextChannelColor: nextChannelColor,
    peekChannelColor: peekChannelColor,
    addAiTask: addAiTask,
    updateAiTask: updateAiTask,
    removeAiTask: removeAiTask,
    clearAiTasks: clearAiTasks
  };
})();

