#!/usr/bin/env node
// XiHe_GCS PRO local bridge: HTTP sync + MCP stdio tools.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequestBody, captureStream } from './bytes.mjs';
import { createDshStderrCollector, extractDshFailure, DSH_STDERR_TAIL } from './dsh-stderr.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const HOST = '127.0.0.1';
const PORT = Number(process.env.XHGCS_BRIDGE_PORT || 8787);
// DSH 通过 stdio 挂进应用时，会再起一个本文件。那个实例不能再绑 HTTP（会和主桥抢端口），
// 也不该自己处理工具（它没有浏览器在轮询，写工具会永远排队）。--mcp-stdio 让它只当代理：
// tools/list 用本地这份 TOOLS，tools/call 转发给正在跑的主桥。
const MCP_STDIO_ONLY = process.argv.indexOf('--mcp-stdio') >= 0;
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'xhgcs';
const SERVER_VERSION = '0.1.0';

// 代码指纹：桌面版据此判断 8787 上已有的桥是不是它准备的那份代码，而不是盲目接管
//（「装了新版却跑旧桥」排查过一次，smoke 的 bridgeConnected 看不出来）。桥本身与它
// 导入的本地模块一起算，字节一致才算同一代。
function bridgeFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const name of ['bridge.mjs', 'bytes.mjs']) {
    try {
      hash.update(fs.readFileSync(new URL('./' + name, import.meta.url)));
    } catch (error) {
      return '';
    }
  }
  return hash.digest('hex').slice(0, 16);
}
const BRIDGE_SHA = bridgeFingerprint();

// 写操作令牌。这个口子原来对全网开放（ACAO: * 且带 Access-Control-Allow-Private-Network，
// 后者专门用来允许公网页面访问 localhost），任意网页都能 POST /api/mcp 把一段 JS 推进
// state.views 并执行。光收紧 CORS 还不够：攻击页面可以用 text/plain 发一个不触发预检的
// 「简单请求」，桥不检查 content-type 就 JSON.parse，请求照样执行，只是它读不到响应。
// 所以写操作必须校验令牌。桌面版由主进程通过 XHGCS_BRIDGE_TOKEN 传进来（重启后不变），
// 独立运行时随机生成，浏览器可以从 /api/health 取——跨源读不到它就说明 CORS 已经拦下了。
const TOKEN = String(process.env.XHGCS_BRIDGE_TOKEN || '').trim() || crypto.randomBytes(24).toString('hex');
const TOKEN_BYTES = Buffer.from(TOKEN);

// 排队项的结果回传。浏览器每次同步会把它执行过的队列项的成败带回来（/api/ack），
// 排队的工具调用在这里等那一程。默认等 8 秒：浏览器每 1.5s 同步一次，正常一两秒就有结果。
const QUEUE_WAIT_MS = Math.max(500, Number(process.env.XHGCS_BRIDGE_QUEUE_WAIT_MS) || 8000);
const QUEUE_MAX = 100;
// 一次工具调用期间入队的条目收集在这里。用 AsyncLocalStorage 而不是模块级变量：
// HTTP 和 stdio 两条路都可能并发进来，模块级变量会被另一个调用清掉。
const callScope = new AsyncLocalStorage();

// 只放行本机页面。返回空串表示不回 ACAO，浏览器会自己拦下跨源读取。
const DEFAULT_ALLOWED_ORIGINS = ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123'];
// 精确来源白名单：CORS 放行 + 令牌下发都以此为准。
// 以前放行任意 localhost 端口，等于把写令牌交给本机任何网页（含被诱导打开的 dev server）。
const ALLOWED_ORIGINS = String(process.env.XHGCS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const ALLOW_ANY_LOOPBACK = ALLOWED_ORIGINS.indexOf('*loopback*') >= 0;
function allowedOrigin(req) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  if (!origin) return ''; // curl / MCP stdio 这类非浏览器请求不带 Origin
  // 显式逃生口：只给测试/开发用（静态服务每次起在随机端口），默认不开启
  if (ALLOW_ANY_LOOPBACK) return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin) ? origin : '';
  const list = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;
  return list.includes(origin) ? origin : '';
}

function tokenOk(req) {
  const sent = String((req && req.headers && req.headers['x-xhgcs-token']) || '');
  const bytes = Buffer.from(sent);
  return bytes.length === TOKEN_BYTES.length && crypto.timingSafeEqual(bytes, TOKEN_BYTES);
}

const browserState = {
  timestamp: Date.now(), t: 0, playing: false, raw: [], script: [], series: {},
  serial: {}, logs: [], alarms: [], scripts: [], engines: [], components: [], views: [], activeEngine: '',
  analysis: { canvas: { nodes: [], edges: [], viewport: { x: 70, y: 70, zoom: 1 }, autoRun: false } }
};
const serverState = {
  scripts: [], engines: [], components: [], views: [], activeEngine: '', queue: [], results: {}, revision: 1,
  // 视图自检结果由浏览器定时回传（见 assets/js/bridge.js 的 verifyReports），按 token 存一次
  verifyReports: {}, verifyWaits: 0,
  dropped: 0
};
// 每个 qid 只投递给等待它的调用。完成或超时后不再保留回执数据。
const ackWaiters = new Map();

const PROTOCOL_PRESETS = [
  {
    key: 'json', id: 'json', protocol: 'JSON', name: 'JSON 数据引擎',
    header: '{', tail: '}', terminator: '\n', checksum: 'NONE',
    byteOrder: 'little', hexScale: 10, payloadBytes: 0, channelCount: 0,
    summary: '对象/数组 · 无校验', description: '逐帧 JSON 对象或数组，适合轻量文本遥测',
    sample: '{"t":1.23,"ch":{"voltage":12.4}}'
  },
  {
    key: 'ascii', id: 'ascii', protocol: 'ASCII', name: 'ASCII 字段引擎',
    header: 'XH[', tail: ']', terminator: '\r\n', checksum: 'CRC16',
    byteOrder: 'little', hexScale: 10, payloadBytes: 0, channelCount: 0,
    summary: '字段文本 · CRC16', description: '逗号或分号分隔字段，支持 key:value 与 CRC16',
    sample: 'XH[voltage:12.4,current:1.8]*A1B2\r\n'
  },
  {
    key: 'hex', id: 'hex', protocol: 'HEX', name: 'HEX 二进制引擎',
    header: 'AA55', tail: '55AA', terminator: '', checksum: 'CRC32',
    byteOrder: 'little', hexScale: 10, payloadBytes: 0, channelCount: 0,
    summary: 'AA55…55AA · CRC32', description: '十六进制二进制帧，支持帧头帧尾与 CRC16/CRC32',
    sample: 'AA55 04D2 01F4 55AA 1A2B3C4D'
  },
  {
    key: 'wed', id: 'wed-telemetry', protocol: 'WED', name: 'WED 遥测协议',
    header: '55AA', tail: '', terminator: '', checksum: 'SUM8',
    byteOrder: 'big', hexScale: 1, payloadBytes: 40, channelCount: 20,
    summary: '55AA+40B+SUM8 · 20通道', description: '55 AA + 长度(1) + 40B 负载 + SUM8；20 通道 uint16 大端',
    sample: '55 AA 28 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 0001 6B'
  },
  {
    key: 'wedfc', id: 'wed-fc', protocol: 'WED', protocolId: 'wed-fc', name: 'WED 飞控遥测',
    header: '55AA', tail: '', terminator: '', checksum: 'SUM8',
    byteOrder: 'big', hexScale: 1, payloadBytes: 40, channelCount: 20,
    summary: '55AA+40B+SUM8 · 20通道（飞控）', description: '55 AA + 长度(1) + 40B 负载 + SUM8；20 路飞控姿态闭环（角度/角速度/陀螺/控制量/电机/观测器）',
    sample: '55 AA 28 46 50 46 50 46 50 27 10 27 10 27 10 27 10 27 10 27 10 03 E8 03 E8 03 E8 04 4C 04 4C 04 4C 04 4C 46 50 4E 20 4E 20 0B B8 6A'
  }
];

function protocolPreset(input) {
  const raw = typeof input === 'string'
    ? input
    : input && (input.preset || input.presetId || input.protocolId || input.protocol || input.name || input.id) || '';
  const value = String(raw || '').toLowerCase();
  // 先按 id / protocolId 精确匹配：WED 家族有传感器与飞控两个规格，
  // 光看 'wed' 关键词会一律命中传感器那个，agent 拿到的是错的通道表
  const exact = PROTOCOL_PRESETS.find((item) => String(item.id).toLowerCase() === value || String(item.protocolId || '').toLowerCase() === value);
  if (exact) return exact;
  if (value.indexOf('飞控') >= 0 || value === 'wedfc' || value.indexOf('wed-fc') >= 0) {
    return PROTOCOL_PRESETS.find((item) => item.protocolId === 'wed-fc') || null;
  }
  if (value.indexOf('wed') >= 0 || value.indexOf('55aa') >= 0 || value.indexOf('sum8') >= 0) {
    return PROTOCOL_PRESETS.find((item) => item.id === 'wed-telemetry') || null;
  }
  if (value.indexOf('json') >= 0) return PROTOCOL_PRESETS.find((item) => item.protocol === 'JSON') || null;
  if (value.indexOf('hex') >= 0 || value.indexOf('二进制') >= 0) return PROTOCOL_PRESETS.find((item) => item.protocol === 'HEX') || null;
  if (value.indexOf('ascii') >= 0 || value.indexOf('字段') >= 0) return PROTOCOL_PRESETS.find((item) => item.protocol === 'ASCII') || null;
  return PROTOCOL_PRESETS.find((item) => String(item.id).toLowerCase() === value) || null;
}

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function clamp(v, lo, hi) { return Math.max(Number(lo) || 0, Math.min(Number(hi) || 0, Number(v))); }
function mergeById(base, additions) {
  const result = Array.isArray(base) ? base.slice() : [];
  (Array.isArray(additions) ? additions : []).forEach((item) => {
    if (!item || !item.id) return;
    const idx = result.findIndex((x) => x && x.id === item.id);
    if (idx < 0) result.push(Object.assign({}, item));
    else result[idx] = Object.assign({}, result[idx], item);
  });
  return result;
}
function allScripts() { return mergeById(browserState.scripts || [], serverState.scripts || []); }
function allEngines() { return mergeById(browserState.engines || [], serverState.engines || []); }
function allComponents() { return mergeById(browserState.components || [], serverState.components || []); }
function allViews() { return mergeById(browserState.views || [], serverState.views || []); }
function findScript(idOrName) {
  const id = String(idOrName || '');
  return allScripts().find((x) => x.id === id || x.name === id) || null;
}
function findEngine(idOrName) {
  const id = String(idOrName || '');
  return allEngines().find((x) => x.id === id || x.name === id) || null;
}
function findComponent(idOrName) {
  const id = String(idOrName || '');
  return allComponents().find((x) => x.id === id || x.name === id) || null;
}
function findView(idOrName) {
  const id = String(idOrName || '');
  return allViews().find((x) => x.id === id || x.name === id) || null;
}
function normalizeOutputs(outputs, fallback) {
  return (Array.isArray(outputs) && outputs.length ? outputs : [fallback || { id: 'out1', label: '输出', unit: '', color: '#38bdf8', range: [0, 100] }]).map((out, i) => ({
    id: out && out.id || ('out' + (i + 1)),
    label: out && out.label || ('输出' + (i + 1)),
    unit: out && out.unit || '',
    color: out && out.color || '#38bdf8',
    range: Array.isArray(out && out.range) ? [Number(out.range[0]) || 0, Number(out.range[1]) || 100] : [0, 100]
  }));
}
function normalizeGraph(input) {
  const source = input && typeof input === 'object' ? (input.graph || input) : {};
  const allowed = new Set(['source', 'math', 'filter', 'fft', 'python', 'component', 'output']);
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((raw, index) => {
    const type = allowed.has(String(raw && raw.type)) ? String(raw.type) : 'math';
    const config = raw && raw.config && typeof raw.config === 'object' ? raw.config : {};
    return {
      id: String(raw && raw.id || ('gn' + index + '_' + Date.now().toString(36))),
      type: type,
      label: String(raw && raw.label || type).slice(0, 48),
      x: Number(raw && raw.x) || 80 + index * 40,
      y: Number(raw && raw.y) || 80,
      config: config
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(source.edges) ? source.edges : []).map((raw, index) => ({
    id: String(raw && raw.id || ('ge' + index + '_' + Date.now().toString(36))),
    source: String(raw && raw.source || ''),
    sourceHandle: String(raw && raw.sourceHandle || 'out'),
    target: String(raw && raw.target || ''),
    targetHandle: String(raw && raw.targetHandle || 'in1')
  })).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return {
    nodes: nodes,
    edges: edges,
    viewport: source.viewport || { x: 70, y: 70, zoom: 1 },
    autoRun: Boolean(source.autoRun),
    initialized: true
  };
}
function normalizeScript(input) {
  if (!input || typeof input !== 'object') throw new Error('脚本对象为空');
  const isGraph = String(input.type || '').toLowerCase() === 'graph' || Boolean(input.graph) || (Array.isArray(input.nodes) && Array.isArray(input.edges));
  const graph = isGraph ? normalizeGraph(input) : null;
  const componentSnapshots = Array.isArray(input.componentSnapshots) ? input.componentSnapshots.slice() : (graph ? graph.nodes.filter((node) => node.type === 'component').map((node) => {
    const component = findComponent(node.config && node.config.componentId);
    return component ? JSON.parse(JSON.stringify(component)) : null;
  }).filter(Boolean) : []);
  const graphOutputs = graph ? graph.nodes.filter((node) => node.type === 'output').map((node) => ({
    id: node.id,
    label: node.config && node.config.label || '分析输出',
    unit: node.config && node.config.unit || '',
    color: node.config && node.config.color || '#38bdf8',
    range: Array.isArray(node.config && node.config.range) ? [Number(node.config.range[0]) || 0, Number(node.config.range[1]) || 100] : [0, 100]
  })) : [];
  // 缺字段就如实失败。以前这里会编造 formula='mean(ch1,ch2,ch3)' 和 inputs=['ch1','ch2','ch3']：
  // 模型漏字段照样「创建成功」，脚本却挂着一组不存在的通道，永远跑不出数据。
  const type = isGraph ? 'graph' : String(input.type || 'functions').toLowerCase() === 'python' ? 'python' : 'functions';
  const formula = String(input.formula || '').trim();
  const code = String(input.code || '').trim();
  if (type === 'functions' && !formula) throw new Error('缺少 formula：functions 脚本必须给出公式表达式');
  if (type === 'python' && !code) throw new Error('缺少 code：python 脚本必须给出 def analyze(ctx) 代码');
  const graphInputs = isGraph ? graph.nodes.filter((node) => node.type === 'source').map((node) => node.config && node.config.channelId).filter(Boolean) : [];
  const declaredInputs = Array.isArray(input.inputs) && input.inputs.length ? input.inputs.slice() : (Array.isArray(input.channels) && input.channels.length ? input.channels.slice() : []);
  const inputs = isGraph ? graphInputs : declaredInputs;
  if (!inputs.length) {
    throw new Error(isGraph
      ? '画布里没有 source 节点：至少给一个真实通道作为输入'
      : '缺少 inputs：请给出要分析的通道 id 列表（先用 list_channels 查真实 id）');
  }
  return {
    id: input.id || ('script_mcp_' + uid('x')),
    name: String(input.name || 'MCP 脚本').slice(0, 80),
    type: type,
    formula: formula,
    code: code,
    inputs: inputs,
    outputs: isGraph && graphOutputs.length ? graphOutputs : normalizeOutputs(input.outputs, { id: uid('out'), label: String(input.name || 'MCP 输出'), unit: '', color: '#38bdf8', range: [0, 100] }),
    graph: isGraph ? graph : undefined,
    componentSnapshots: componentSnapshots,
    builtin: false,
    origin: 'mcp',
    description: String(input.description || '由 MCP Agent 创建').slice(0, 200),
    createdAt: Date.now()
  };
}
function normalizeEngine(input) {
  if (!input || typeof input !== 'object') throw new Error('数据引擎对象为空');
  // 认不出来就报错，不再静默按 ASCII 建一个：以前要 JSON 引擎的调用可能变成一个
  // 完全不同的协议，而工具照样回「创建成功」。
  const preset = protocolPreset(input);
  if (!preset) throw new Error('无法识别数据引擎协议：请给出 preset=json|ascii|hex|wed|wedfc，或 protocol=JSON|ASCII|HEX|WED');
  const declared = String(input.protocol || preset.protocol || '').toUpperCase();
  if (['JSON', 'ASCII', 'HEX', 'WED'].indexOf(declared) < 0) {
    throw new Error('protocol 只能是 JSON / ASCII / HEX / WED，实际 ' + String(input.protocol));
  }
  const protocol = declared;
  const isWed = protocol === 'WED';
  return {
    id: input.id || ('engine_mcp_' + uid('x')),
    name: String(input.name || preset.name || 'MCP 数据引擎').slice(0, 80),
    protocol: protocol,
    header: String(input.header == null ? preset.header : input.header),
    tail: String(input.tail == null ? preset.tail : input.tail),
    protocolId: String(input.protocolId || preset.protocolId || (isWed ? 'wed-telemetry' : '')),
    payloadBytes: Number(input.payloadBytes) || Number(preset.payloadBytes) || (isWed ? 40 : 0),
    channelCount: Number(input.channelCount) || Number(preset.channelCount) || (isWed ? 20 : 0),
    byteOrder: String(input.byteOrder || preset.byteOrder || (isWed ? 'big' : 'little')),
    terminator: String(input.terminator == null ? preset.terminator : input.terminator),
    checksum: ['NONE', 'CRC16', 'CRC32', 'SUM8'].includes(String(input.checksum || preset.checksum).toUpperCase()) ? String(input.checksum || preset.checksum).toUpperCase() : (isWed ? 'SUM8' : 'NONE'),
    hexScale: Number(input.hexScale) || Number(preset.hexScale) || 10,
    active: Boolean(input.active),
    origin: 'mcp',
    description: String(input.description || preset.description || '由 MCP Agent 创建').slice(0, 200),
    createdAt: Date.now()
  };
}
function normalizeComponent(input) {
  if (!input || typeof input !== 'object') throw new Error('组件对象为空');
  const kind = String(input.kind || 'formula').toLowerCase() === 'python' ? 'python' : 'formula';
  const now = Date.now();
  // 端口和公式都不再编造：原来缺 inputs 会补一个假的 x1，缺 outputs 会补一个假的 out1，
  // 于是拖进画布的组件永远算不出东西，而创建工具却回了成功。
  const inputs = (Array.isArray(input.inputs) ? input.inputs : []).map((item, index) => ({
    id: String(item && item.id || ('x' + (index + 1))).slice(0, 32),
    label: String(item && item.label || ('输入' + (index + 1))).slice(0, 32)
  }));
  if (!inputs.length) throw new Error('缺少 inputs：组件至少要有一个输入端口（x1/x2…）');
  const outputs = (Array.isArray(input.outputs) ? input.outputs : []).map((item, index) => ({
    id: String(item && item.id || ('out' + (index + 1))).slice(0, 32),
    label: String(item && item.label || ('输出' + (index + 1))).slice(0, 32),
    unit: String(item && item.unit || '').slice(0, 16),
    color: String(item && item.color || ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'][index % 5]),
    range: Array.isArray(item && item.range) ? [Number(item.range[0]) || 0, Number(item.range[1]) || 100] : [0, 100]
  }));
  if (!outputs.length) throw new Error('缺少 outputs：组件至少要有一个输出端口');
  const parameters = (Array.isArray(input.parameters) ? input.parameters : []).map((item, index) => ({
    id: String(item && item.id || ('p' + (index + 1))).slice(0, 32),
    label: String(item && item.label || ('参数' + (index + 1))).slice(0, 32),
    type: String(item && item.type || 'number').slice(0, 16),
    default: item && item.default != null ? item.default : (String(item && item.type || 'number') === 'number' ? 0 : '')
  }));
  const config = Object.assign({}, input.config || {});
  if (kind === 'formula' && !String(config.formula || '').trim()) {
    throw new Error('缺少 config.formula：公式组件必须给出公式表达式');
  }
  if (kind === 'python' && !String(config.code || '').trim()) {
    throw new Error('缺少 config.code：Python 组件必须给出 def analyze(ctx) 代码');
  }
  return {
    id: String(input.id || ('component_mcp_' + uid('x'))).slice(0, 64),
    name: String(input.name || 'MCP 组件').slice(0, 48),
    description: String(input.description || '由 MCP Agent 创建').slice(0, 200),
    kind,
    inputs,
    outputs,
    parameters,
    config: config,
    origin: 'mcp',
    builtin: false,
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now
  };
}
function enqueue(type, payload) {
  // qid 是这条排队项自己的身份。id 保留 payload 里的含义 —— component_deleted / view_deleted /
  // engine_active 的 payload 自带 id，那是实体 id。以前两者共用一个字段，payload 的 id 会把
  // 生成的队列 id 覆盖掉：同一个实体连删两次就撞车，ack 也会连带清掉别人的条目。
  const item = Object.assign({ qid: uid('q'), type, ts: Date.now() }, payload || {});
  if (item.id == null) item.id = item.qid;
  serverState.queue.push(item);
  if (serverState.queue.length > QUEUE_MAX) {
    // 溢出原来静默丢最旧的：调用方永远不知道自己那条没了。至少留个计数，快照里能看到。
    serverState.queue.splice(0, serverState.queue.length - QUEUE_MAX);
    serverState.dropped++;
  }
  serverState.revision++;
  const sink = callScope.getStore();
  if (sink) sink.push(item.qid);
  return item;
}
function seriesFor(id) {
  const series = browserState.series || {};
  return Array.isArray(series[id]) ? series[id].map(Number) : [];
}
function mathContext() {
  const flatten = (...args) => {
    const out = [];
    args.forEach((item) => {
      if (Array.isArray(item)) item.forEach((v) => { if (Number.isFinite(Number(v))) out.push(Number(v)); });
      else if (Number.isFinite(Number(item))) out.push(Number(item));
    });
    return out;
  };
  const mean = (...a) => { const x = flatten(...a); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0; };
  return {
    mean, avg: mean, sum: (...a) => flatten(...a).reduce((s, v) => s + v, 0),
    min: (...a) => { const x = flatten(...a); return x.length ? Math.min(...x) : 0; },
    max: (...a) => { const x = flatten(...a); return x.length ? Math.max(...x) : 0; },
    rms: (...a) => { const x = flatten(...a); return x.length ? Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length) : 0; },
    std: (...a) => { const x = flatten(...a); if (!x.length) return 0; const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) * (v - m), 0) / x.length); },
    last: (...a) => { const x = flatten(...a); return x.length ? x[x.length - 1] : 0; },
    first: (...a) => { const x = flatten(...a); return x.length ? x[0] : 0; },
    diff: (arr, n) => { const x = flatten(arr); const k = Number(n) || 1; return x.length > k ? x[x.length - 1] - x[x.length - 1 - k] : 0; },
    slope: (arr, n) => { const x = flatten(arr); const k = Number(n) || 1; return x.length > k ? (x[x.length - 1] - x[x.length - 1 - k]) / k : 0; },
    lowpass: (arr, n) => { const x = flatten(arr); const k = Math.max(1, Number(n) || 1); return x.length ? x.slice(-k).reduce((s, v) => s + v, 0) / Math.min(k, x.length) : 0; },
    sqrt: Math.sqrt, abs: Math.abs, log: Math.log, exp: Math.exp,
    clamp: (v, lo, hi) => clamp(v, lo, hi)
  };
}
// 和浏览器侧同一套「公式名」：WED 规格的 id 是 wed-fc-01，直接塞进 new Function 的形参表
// 会报 "Arg string terminates parameters early"，统一退化成 c01；中文通道名也是合法标识符。
function identSafe(text) { return /^[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*$/.test(String(text || '')); }
function channelAlias(id) {
  const key = String(id || '');
  if (identSafe(key)) return key;
  const digits = (key.match(/\d+/g) || []).join('');
  return 'c' + (digits || 'x');
}
function formulaScope() {
  const params = {};
  const seed = (key, value) => {
    if (!key || !identSafe(key) || Object.prototype.hasOwnProperty.call(params, key)) return;
    params[key] = value;
  };
  const channels = [].concat(browserState.raw || [], browserState.script || []);
  channels.forEach((ch) => seed(channelAlias(ch.id), seriesFor(ch.id)));
  channels.forEach((ch) => seed(String(ch.name || '').replace(/[^\w$\u4e00-\u9fa5]/g, ''), seriesFor(ch.id)));
  return params;
}
function runFunctionScript(script) {
  const m = mathContext();
  const formula = String(script && script.formula || 'mean(ch1)');
  // 整份通道都进作用域：公式里点到别的通道也能算，单通道的「均值」不再需要凑三个输入
  const params = formulaScope();
  const names = Object.keys(params);
  if (!names.length) throw new Error('还没有通道数据：先在浏览器里连接数据源或打开仿真');
  let result;
  try {
    const fn = new Function('__m', ...names, 'with (__m) { return (' + formula + '); }');
    result = fn(m, ...names.map((name) => params[name]));
  } catch (err) {
    throw new Error('公式执行失败：' + err.message + '；可用通道名 ' + names.slice(0, 12).join('、'));
  }
  const values = {};
  const outputs = normalizeOutputs(script && script.outputs, { id: 'out1', label: '输出', unit: '', color: '#38bdf8', range: [0, 100] });
  outputs.forEach((out, index) => {
    let value;
    if (result && typeof result === 'object' && !Array.isArray(result)) value = result[out.id] != null ? result[out.id] : result['out' + (index + 1)];
    else if (Array.isArray(result)) value = result[index];
    else value = result;
    const n = Array.isArray(value) ? Number(value[value.length - 1] || 0) : Number(value || 0);
    values[out.id] = n;
    values[out.label] = n;
  });
  return { values, result };
}
function toSnapshot(limit, includeSeries, includeLogs) {
  const n = Math.max(0, Math.min(100, Number(limit) || 0));
  const series = {};
  if (includeSeries) {
    Object.keys(browserState.series || {}).forEach((key) => { series[key] = (browserState.series[key] || []).slice(-n || undefined); });
  }
  return {
    timestamp: browserState.timestamp || Date.now(), t: Number(browserState.t || 0), playing: Boolean(browserState.playing),
    raw: browserState.raw || [], script: browserState.script || [], series,
    serial: browserState.serial || {}, alarms: browserState.alarms || [],
    recording: browserState.recording || { active: false, rows: 0, dropped: 0, enabled: true },
    logs: includeLogs && n ? (browserState.logs || []).slice(-n) : [],
    scripts: allScripts(), engines: allEngines(), components: allComponents(), views: allViews(), activeEngine: serverState.activeEngine || browserState.activeEngine || '',
    analysis: browserState.analysis || { canvas: { nodes: [], edges: [] } }, results: serverState.results || {},
    ai: browserState.ai || { tasks: [], tts: {} },
    // UI10 壳的图页摘要（页签、活动页、通道数）：Agent 判断“现在界面上有什么”用
    shell: browserState.shell || null,
    // 还有多少排队项没被浏览器处理、历史上溢出丢过几条 —— 排队工具超时的时候，
    // 这两个数是判断「app 没开」还是「app 太忙」的依据。
    queue: { pending: (serverState.queue || []).length, dropped: serverState.dropped || 0 }
  };
}
// 通道目录：Agent 想按名字找 id、或者想知道某条通道到底有没有设阈值，都先看这个。
// 以前只有 snapshot 的最新值，没有 id→名字的反查，模型只能猜通道名。
function listChannels(input) {
  const kind = String(input.kind || 'all').toLowerCase();
  const wantSeries = Boolean(input.include_series);
  const rows = [];
  const push = (ch, source) => {
    if (!ch || !ch.id) return;
    const row = {
      id: ch.id,
      name: ch.name || '',
      unit: ch.unit || '',
      kind: source,
      range: Array.isArray(ch.range) ? ch.range.slice(0, 2) : null,
      warnLow: ch.warnLow == null ? null : Number(ch.warnLow),
      warnHigh: ch.warnHigh == null ? null : Number(ch.warnHigh),
      value: ch.value == null ? null : Number(ch.value),
      points: Number(ch.points) || 0,
      visible: ch.visible !== false
    };
    if (ch.scriptId) row.scriptId = ch.scriptId;
    if (wantSeries) row.series = seriesFor(ch.id).slice(-100);
    rows.push(row);
  };
  if (kind !== 'script') (browserState.raw || []).forEach((ch) => push(ch, 'raw'));
  if (kind !== 'raw') (browserState.script || []).forEach((ch) => push(ch, 'script'));
  return { count: rows.length, channels: rows };
}

function remotePayload() {  return {
    scripts: serverState.scripts || [],
    engines: serverState.engines || [],
    components: serverState.components || [],
    views: serverState.views || [],
    activeEngine: serverState.activeEngine || browserState.activeEngine || '',
    queue: serverState.queue || []
  };
}
function handleState(body) {
  const incoming = body && body.snapshot ? body.snapshot : (body && body.data ? body.data : body);
  if (incoming && typeof incoming === 'object') {
    Object.assign(browserState, incoming);
    if (incoming.timestamp) browserState.timestamp = incoming.timestamp;
    if (incoming.series) browserState.series = incoming.series;
    if (incoming.activeEngine) serverState.activeEngine = incoming.activeEngine;
    if (Array.isArray(incoming.scripts)) serverState.scripts = mergeById(serverState.scripts, incoming.scripts);
    if (Array.isArray(incoming.engines)) serverState.engines = mergeById(serverState.engines, incoming.engines);
    if (Array.isArray(incoming.components)) serverState.components = mergeById(serverState.components, incoming.components);
    if (Array.isArray(incoming.views)) serverState.views = mergeById(serverState.views, incoming.views);
    if (Array.isArray(incoming.verifyReports) && incoming.verifyReports.length) {
      const now = Date.now();
      incoming.verifyReports.forEach((item) => {
        if (!item || !item.token) return;
        serverState.verifyReports[item.token] = { at: now, report: item.report || {} };
      });
      // 只留最近 20 份，避免长跑之后一直涨。原来按 token 字符串排序淘汰，而 token 是
      // 'verify-<base36 时间>-<随机>'，字符串序和时间序不是一回事，等于随机淘汰。
      const keys = Object.keys(serverState.verifyReports);
      if (keys.length > 20) {
        keys.sort((a, b) => (serverState.verifyReports[a].at || 0) - (serverState.verifyReports[b].at || 0));
        keys.slice(0, keys.length - 20).forEach((k) => { delete serverState.verifyReports[k]; });
      }
    }
    const deletedScripts = new Set(incoming.deletedScripts || []);
    const deletedEngines = new Set(incoming.deletedEngines || []);
    const deletedComponents = new Set(incoming.deletedComponents || []);
    const deletedViews = new Set(incoming.deletedViews || []);
    if (deletedScripts.size) {
      serverState.scripts = serverState.scripts.filter((item) => !deletedScripts.has(item.id));
      browserState.scripts = (browserState.scripts || []).filter((item) => !deletedScripts.has(item.id));
    }
    if (deletedEngines.size) {
      serverState.engines = serverState.engines.filter((item) => !deletedEngines.has(item.id));
      browserState.engines = (browserState.engines || []).filter((item) => !deletedEngines.has(item.id));
    }
    if (deletedComponents.size) {
      serverState.components = serverState.components.filter((item) => !deletedComponents.has(item.id));
      browserState.components = (browserState.components || []).filter((item) => !deletedComponents.has(item.id));
    }
    if (deletedViews.size) {
      serverState.views = serverState.views.filter((item) => !deletedViews.has(item.id));
      browserState.views = (browserState.views || []).filter((item) => !deletedViews.has(item.id));
    }
  }
  return { ok: true, revision: serverState.revision, remote: remotePayload() };
}
function getState() {
  const merged = allScripts();
  return { ok: true, revision: serverState.revision, browserAt: browserState.timestamp, state: toSnapshot(Number(process.env.XHGCS_SNAPSHOT_LIMIT || 0), false, false), remote: remotePayload() };
}
function listScripts() {
  return allScripts().map((s) => ({ id: s.id, name: s.name, type: s.type, inputs: s.inputs || [], outputs: (s.outputs || []).map((o) => ({ id: o.id, label: o.label })), graph: s.type === 'graph' ? { nodes: (s.graph && s.graph.nodes || []).length, edges: (s.graph && s.graph.edges || []).length } : undefined, description: s.description || '', origin: s.origin || 'browser' }));
}
function listEngines() {
  // 以前 `payloadBytes || null` / `channelCount || null` / `hexScale || 10` 会把真实的 0
  // 洗成 null 或 10，agent 看到的配置和界面里不一样。缺就是 null，0 就是 0。
  const numOrNull = (value) => (value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
  return allEngines().map((e) => ({ id: e.id, name: e.name, protocol: e.protocol, protocolId: e.protocolId || '', checksum: e.checksum || 'NONE', byteOrder: e.byteOrder || 'little', hexScale: numOrNull(e.hexScale), payloadBytes: numOrNull(e.payloadBytes), channelCount: numOrNull(e.channelCount), active: Boolean(e.active), description: e.description || '', origin: e.origin || 'browser' }));
}
function listComponents() {
  return allComponents().map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    description: c.description || '',
    inputs: (c.inputs || []).map((p) => ({ id: p.id, label: p.label })),
    outputs: (c.outputs || []).map((p) => ({ id: p.id, label: p.label, unit: p.unit || '', color: p.color || '#38bdf8' })),
    parameters: (c.parameters || []).map((p) => ({ id: p.id, label: p.label, type: p.type || 'number', default: p.default })),
    config: c.config || {},
    builtin: Boolean(c.builtin),
    origin: c.origin || 'browser'
  }));
}
function createComponent(input) {
  const component = normalizeComponent(input || {});
  serverState.components = mergeById(serverState.components, [component]);
  serverState.revision++;
  enqueue('component_created', { component });
  return component;
}
function updateComponent(input) {
  const found = input && (input.id || input.name) ? findComponent(input.id || input.name) : null;
  if (!found) throw new Error('找不到组件：' + (input && (input.id || input.name)));
  // 内置组件是随软件发布的只读模板，改了就等于永久覆盖默认值（渲染层同样拒绝，两边保持一致）。
  if (found.builtin) throw new Error('内置组件只读：请先用 create_component 建一个副本再修改（' + found.name + '）');
  const next = normalizeComponent(Object.assign({}, found, input, { id: found.id }));
  serverState.components = mergeById(serverState.components, [next]);
  serverState.revision++;
  enqueue('component_updated', { component: next });
  return next;
}
function deleteComponent(input) {
  const found = input && (input.id || input.name) ? findComponent(input.id || input.name) : null;
  if (!found || found.builtin) throw new Error('找不到或不能删除组件：' + (input && (input.id || input.name)));
  serverState.components = serverState.components.filter((item) => item.id !== found.id);
  browserState.components = (browserState.components || []).filter((item) => item.id !== found.id);
  serverState.revision++;
  enqueue('component_deleted', { id: found.id, name: found.name });
  return { id: found.id, name: found.name, ok: true };
}
function normalizeView(input) {
  if (!input || typeof input !== 'object') throw new Error('视图对象为空');
  const code = String(input.code || '').trim();
  if (!code) throw new Error('视图缺少 code（插件表达式）');
  if (code.indexOf('mount') < 0) throw new Error('视图 code 必须包含 mount(ctx) 方法');
  return {
    id: String(input.id || ('view_' + uid('x'))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48),
    name: String(input.name || 'MCP 视图').slice(0, 40),
    icon: String(input.icon || '◈').slice(0, 2),
    desc: String(input.desc || input.description || '由 MCP Agent 创建').slice(0, 80),
    code: code,
    origin: 'mcp',
    createdAt: Number(input.createdAt) || Date.now()
  };
}
function listViews(includeCode) {
  return allViews().map((v) => ({
    id: v.id,
    name: v.name,
    icon: v.icon || '◈',
    desc: v.desc || '',
    origin: v.origin || 'browser',
    codeLength: String(v.code || '').length,
    code: includeCode ? String(v.code || '') : undefined
  }));
}
function createView(input) {
  const view = normalizeView(input || {});
  serverState.views = mergeById(serverState.views, [view]);
  serverState.revision++;
  enqueue('view_created', { view });
  return view;
}
function updateView(input) {
  const found = input && (input.id || input.name) ? findView(input.id || input.name) : null;
  if (!found) throw new Error('找不到视图：' + (input && (input.id || input.name)));
  const next = normalizeView(Object.assign({}, found, input, { id: found.id }));
  serverState.views = mergeById(serverState.views, [next]);
  serverState.revision++;
  enqueue('view_updated', { view: next });
  return next;
}
function deleteView(input) {
  const found = input && (input.id || input.name) ? findView(input.id || input.name) : null;
  if (!found) throw new Error('找不到视图：' + (input && (input.id || input.name)));
  serverState.views = serverState.views.filter((item) => item.id !== found.id);
  browserState.views = (browserState.views || []).filter((item) => item.id !== found.id);
  serverState.revision++;
  enqueue('view_deleted', { id: found.id, name: found.name });
  return { id: found.id, name: found.name, ok: true };
}
function updateScript(input) {
  const found = input && (input.id || input.name) ? findScript(input.id || input.name) : null;
  if (!found) throw new Error('找不到脚本：' + (input && (input.id || input.name) || '（空）'));
  // 内置脚本是随软件发布的只读模板，改了下次启动就被覆盖；明确拒绝，别假装成功。
  if (found.builtin) throw new Error('内置脚本只读：请先用 create_script 建一个副本再修改（' + found.name + '）');
  // name 用于定位时改名走 new_name；定位字段不参与覆盖
  const patch = Object.assign({}, input);
  if (patch.new_name != null) { patch.name = String(patch.new_name); }
  delete patch.new_name;
  // 保留 id/builtin/origin/createdAt，其余字段重走 normalizeScript 校验（缺 formula/inputs 会报错，不编造）
  const normalized = normalizeScript(Object.assign({}, found, patch, { id: found.id }));
  const next = Object.assign({}, normalized, {
    id: found.id,
    builtin: Boolean(found.builtin),
    origin: found.origin || 'mcp',
    createdAt: found.createdAt || normalized.createdAt
  });
  serverState.scripts = mergeById(serverState.scripts, [next]);
  serverState.revision++;
  enqueue('script_updated', { script: next });
  return next;
}

function deleteScript(input) {
  const found = input && (input.id || input.name) ? findScript(input.id || input.name) : null;
  if (!found) throw new Error('找不到脚本：' + (input && (input.id || input.name) || '（空）'));
  if (found.builtin) throw new Error('内置脚本不能删除（' + found.name + '）');
  serverState.scripts = serverState.scripts.filter((item) => item.id !== found.id);
  browserState.scripts = (browserState.scripts || []).filter((item) => item.id !== found.id);
  serverState.revision++;
  // 只发实体 id（qid 是队列身份，桥侧单独生成），浏览器据此删产物并写墓碑
  enqueue('script_deleted', { id: found.id, name: found.name });
  return { ok: true, id: found.id, name: found.name };
}

function updateEngine(input) {
  const found = input && (input.id || input.name) ? findEngine(input.id || input.name) : null;
  if (!found) throw new Error('找不到数据引擎：' + (input && (input.id || input.name) || '（空）'));
  const patch = Object.assign({}, input);
  if (patch.new_name != null) { patch.name = String(patch.new_name); }
  delete patch.new_name;
  const normalized = normalizeEngine(Object.assign({}, found, patch, { id: found.id }));
  const active = String(serverState.activeEngine || '') === found.id || Boolean(found.active);
  const next = Object.assign({}, normalized, {
    id: found.id,
    origin: found.origin || 'browser',
    createdAt: found.createdAt || normalized.createdAt,
    active: active || Boolean(normalized.active)
  });
  serverState.engines = mergeById(serverState.engines, [next]);
  if (active) serverState.activeEngine = found.id;
  serverState.revision++;
  // active 标记让浏览器侧对当前活动引擎重新 activateEngine（WED 会重建 20 个通道）
  enqueue('engine_updated', { engine: next, active: active });
  return next;
}

function deleteEngine(input) {
  const found = input && (input.id || input.name) ? findEngine(input.id || input.name) : null;
  if (!found) throw new Error('找不到数据引擎：' + (input && (input.id || input.name) || '（空）'));
  const activeId = String(serverState.activeEngine || '') || String((allEngines().find((item) => item.active) || {}).id || '');
  if (activeId && found.id === activeId) {
    throw new Error('不能删除当前活动引擎：请先 set_active_engine 切到别的引擎（' + found.name + '）');
  }
  serverState.engines = serverState.engines.filter((item) => item.id !== found.id);
  browserState.engines = (browserState.engines || []).filter((item) => item.id !== found.id);
  serverState.revision++;
  enqueue('engine_deleted', { id: found.id, name: found.name });
  return { ok: true, id: found.id, name: found.name };
}

function listProtocols() {
  return PROTOCOL_PRESETS.map((item) => ({
    id: item.id,
    key: item.key,
    name: item.name,
    protocol: item.protocol,
    header: item.header,
    tail: item.tail,
    terminator: item.terminator,
    checksum: item.checksum,
    byteOrder: item.byteOrder,
    hexScale: item.hexScale,
    payloadBytes: item.payloadBytes || null,
    channelCount: item.channelCount || null,
    summary: item.summary,
    description: item.description,
    sample: item.sample
  }));
}
function createScript(input) {
  const script = normalizeScript(input || {});
  serverState.scripts = mergeById(serverState.scripts, [script]);
  serverState.revision++;
  enqueue('script_created', { script, run: input && input.run !== false });
  return script;
}
function createEngine(input) {
  const engine = normalizeEngine(input || {});
  serverState.engines = mergeById(serverState.engines, [engine]);
  serverState.revision++;
  if (input && input.activate !== false) { serverState.activeEngine = engine.id; engine.active = true; }
  enqueue('engine_created', { engine, activate: input && input.activate !== false });
  return engine;
}
function getCanvas(input) {
  const c = browserState.analysis && browserState.analysis.canvas;
  const empty = { nodes: [], edges: [], viewport: { x: 70, y: 70, zoom: 1 }, autoRun: false };
  const graph = c || empty;
  if (input && input.full) return graph;
  return {
    nodeCount: (graph.nodes || []).length,
    edgeCount: (graph.edges || []).length,
    autoRun: Boolean(graph.autoRun),
    nodes: (graph.nodes || []).map((node) => ({ id: node.id, type: node.type, label: node.label })),
    edges: (graph.edges || []).length ? graph.edges.map((edge) => edge.source + '→' + edge.target) : []
  };
}
function createGraph(input) {
  const script = normalizeScript(Object.assign({}, input || {}, { type: 'graph' }));
  if (!script.graph || !script.graph.nodes.length) throw new Error('画布至少需要一个节点');
  serverState.scripts = mergeById(serverState.scripts, [script]);
  serverState.revision++;
  enqueue('script_created', { script, run: input && input.run !== false });
  if (!input || input.load !== false) enqueue('canvas_loaded', { graph: script.graph, scriptId: script.id });
  return script;
}
function setActiveEngine(input) {
  const engine = findEngine(input && input.id);
  if (!engine) throw new Error('找不到数据引擎：' + (input && input.id));
  serverState.activeEngine = engine.id;
  serverState.engines.forEach((item) => { if (item.id === engine.id) item.active = true; });
  serverState.revision++;
  enqueue('engine_active', { id: engine.id });
  return engine;
}
function runAnalysis(input) {
  const script = input && (input.scriptId || input.script_id || input.name) ? findScript(input.scriptId || input.script_id || input.name) : null;
  if (!script && input && input.formula) {
    const temp = normalizeScript({ name: input.name || '临时分析', type: 'functions', formula: input.formula, inputs: input.inputs || ['ch1'], outputs: input.outputs });
    return { accepted: false, ok: true, values: runFunctionScript(temp).values, script: temp, note: '临时函数分析，未写入脚本库' };
  }
  if (!script) throw new Error('找不到脚本。可先调用 create_script，或提供 name/scriptId/formula');
  if (script.type === 'python' || script.type === 'graph') {
    const item = enqueue('run_analysis', { scriptId: script.id });
    return { accepted: true, ok: true, scriptId: script.id, note: '已排队到浏览器执行，浏览器同步后写入脚本通道' };
  }
  const result = runFunctionScript(script);
  serverState.results[script.id] = { at: Date.now(), values: result.values };
  enqueue('run_analysis', { scriptId: script.id });
  serverState.revision++;
  return { accepted: false, ok: true, scriptId: script.id, scriptName: script.name, values: result.values, note: '服务端已计算；浏览器同步后会再次用实时序列计算并写回' };
}
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// 等一批排队项的执行结果。超时不是「成功」，是一件要如实报出去的事：
// 以前这些工具无论浏览器做没做成都回 ok:true，Agent 只能靠事后 snapshot 去猜。
async function waitForQueueBatch(ids, timeoutMs) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return { applied: true, error: '', results: [] };
  const ms = Math.max(1000, Math.min(30000, Number(timeoutMs) || QUEUE_WAIT_MS));
  const received = new Map();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    for (const id of list) {
      ackWaiters.set(id, (row) => {
        ackWaiters.delete(id);
        received.set(id, { id, ok: Boolean(row.ok), error: String(row.error || ''), data: row.data ?? null });
        if (received.size === list.length) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });
  const results = list.map((id) => {
    ackWaiters.delete(id);
    return received.get(id) || { id, ok: false, error: '浏览器没有回传执行结果', data: null };
  });
  const failed = results.filter((item) => !item.ok);
  return {
    applied: failed.length === 0,
    error: failed.length
      ? failed.map((item) => item.error || '浏览器执行失败').join('；')
        + '（确认 XiHe GCS 已打开、设置 → AI 对话里的 MCP 桥是开启状态）'
      : '',
    results: results
  };
}

// 排队 + 等结果。entityKey 是返回体里放实体对象的字段名（script / engine / view …）。
async function boardCall(type, payload) {
  // 看板文档在浏览器 localStorage 里：读也要排队过去取，data 随 ack 回来。
  // 看板 id 走 boardId：Enqueue 会把缺省的 id 填成 qid，两者共用会让浏览器把队列 id 当看板 id。
  const body = Object.assign({}, payload || {});
  if (body.id != null) { body.boardId = body.id; delete body.id; }
  const item = enqueue(type, body);
  const outcome = await waitForQueueBatch([item.qid]);
  const hit = (outcome.results && outcome.results[0]) || {};
  if (!outcome.applied) return { ok: false, applied: false, error: outcome.error };
  const data = hit.data || {};
  // 浏览器执行了，但业务失败（未知 id、补丁被拒、没有可回退的备份）不能报成功
  if (data.result && data.result.ok === false) {
    return { ok: false, applied: false, error: String(data.result.error || '看板操作失败'), data: data };
  }
  if (data.preview && data.preview.ok === false) {
    return { ok: false, applied: false, error: (data.preview.errors || []).join('；') || '补丁校验未通过', data: data };
  }
  return Object.assign({ ok: true, applied: true }, data);
}

async function queued(entityKey, work) {
  const batch = [];
  // work 同步入队；在同一轮事件循环中登记等待者，再交还 HTTP/stdio 控制权。
  const entity = callScope.run(batch, work);
  const outcome = await waitForQueueBatch(batch);
  const out = { ok: outcome.applied, queued: true, applied: outcome.applied };
  if (entityKey) out[entityKey] = entity;
  if (!outcome.applied) out.error = outcome.error;
  return out;
}

// UI10 壳的图页操作：与看板同一条「排队 → 浏览器执行 → ack」链路。
// 页面数据在渲染层，读取也必须排队过去取。
async function pageCall(type, payload) {
  const item = enqueue(type, payload || {});
  const outcome = await waitForQueueBatch([item.qid]);
  const hit = (outcome.results && outcome.results[0]) || {};
  if (!outcome.applied) return { ok: false, applied: false, queued: true, error: outcome.error };
  const data = hit.data || {};
  if (data.ok === false) {
    return { ok: false, applied: false, queued: true, error: String(data.error || '页面操作失败') };
  }
  return Object.assign({ ok: true, applied: true, queued: true }, data);
}
// 让 Agent 自己验证生成的视图：把代码排进浏览器队列，等浏览器真挂载跑几帧后回传检查报告。
async function verifyView(input) {
  const code = String(input.code || '').trim();
  if (!code) return { ok: false, error: '缺少 code：请传入要自检的视图插件代码' };
  const token = 'verify-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  enqueue('view_verify', { token: token, code: code, frames: Math.max(1, Math.min(20, Number(input.frames) || 6)) });
  serverState.verifyWaits++;
  const timeoutMs = Math.max(2000, Math.min(20000, Number(input.timeoutMs) || 9000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = serverState.verifyReports[token];
    if (hit) {
      delete serverState.verifyReports[token];
      return { ok: true, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()), report: hit.report };
    }
    await delay(200);
  }
  return {
    ok: false, queued: true, token: token,
    error: '浏览器 ' + Math.round(timeoutMs / 1000) + ' 秒内没有回传自检结果：确认 XiHe GCS 已打开、设置 → AI 对话里的 MCP 桥是开启状态（队列已发出，可在浏览器同步后重试）'
  };
}
async function callTool(name, args) {
  const input = args || {};
  if (name === 'snapshot') return { state: toSnapshot(input.limit || 1, Boolean(input.include_series), Boolean(input.include_logs)) };
  if (name === 'list_channels') return listChannels(input);
  if (name === 'channel_history') return { channel: input.channel || input.id || '', points: Number(input.points) || 100, series: seriesFor(input.channel || input.id || '').slice(-(Number(input.points) || 100)) };
  if (name === 'list_scripts') return { count: allScripts().length, scripts: listScripts() };
  if (name === 'create_script') return await queued('script', () => createScript(input));
  if (name === 'update_script') return await queued('script', () => updateScript(input));
  if (name === 'delete_script') return await queued('deleted', () => deleteScript(input));
  if (name === 'list_protocols') return { count: listProtocols().length, protocols: listProtocols() };
  if (name === 'list_engines') return { count: allEngines().length, engines: listEngines() };
  if (name === 'create_engine') return await queued('engine', () => createEngine(input));
  if (name === 'update_engine') return await queued('engine', () => updateEngine(input));
  if (name === 'delete_engine') return await queued('deleted', () => deleteEngine(input));
  if (name === 'list_components') return { count: allComponents().length, components: listComponents() };
  if (name === 'create_component') return await queued('component', () => createComponent(input));
  if (name === 'update_component') return await queued('component', () => updateComponent(input));
  if (name === 'delete_component') return await queued('deleted', () => deleteComponent(input));
  if (name === 'verify_view') return await verifyView(input);
  if (name === 'list_views') return { count: allViews().length, views: listViews(Boolean(input.include_code)) };
  if (name === 'create_view') return await queued('view', () => createView(input));
  if (name === 'update_view') return await queued('view', () => updateView(input));
  if (name === 'delete_view') return await queued('deleted', () => deleteView(input));
  if (name === 'set_active_engine') return await queued('engine', () => setActiveEngine(input));
  if (name === 'run_analysis') return runAnalysis(input);
  if (name === 'get_canvas') return { ok: true, canvas: getCanvas(input) };
  if (name === 'list_boards') return await boardCall('board_list', {});
  if (name === 'get_board') return await boardCall('board_get', { id: input.id });
  if (name === 'create_board') return await boardCall('board_create', { name: input.name });
  if (name === 'update_board') return await boardCall('board_patch', { id: input.id, ops: input.ops, dryRun: input.dry_run !== false, baseUpdatedAt: input.base_updated_at });
  if (name === 'open_board') return await boardCall('board_open', { id: input.id });
  if (name === 'undo_board') return await boardCall('board_undo', {});
  // UI10 壳的图页（实际使用的图表系统）
  if (name === 'list_view_components') return pageCall('view_components', {});
  if (name === 'preview_view_spec') return pageCall('view_preview', {spec: input.spec, pageId: input.pageId});
  if (name === 'apply_view_spec') return pageCall('view_apply', {draftId:input.draftId,pageId:input.pageId,version:input.version,requestId:input.requestId,workspaceId:input.workspaceId});
  if (name === 'list_pages') return await pageCall('page_list', {});
  if (name === 'get_page') return await pageCall('page_get', { id: input.id });
  if (name === 'create_page') return await pageCall('page_create', { name: input.name, channels: input.channels, windowSec: input.windowSec });
  if (name === 'delete_page') return await pageCall('page_delete', { id: input.id });
  throw new Error('未知工具：' + name);
}
const TOOLS = [
  {name:'list_view_components',description:'读取 UI10 原生组件、参数、通道 ID 与工作区。生成视图时先调用。',inputSchema:{type:'object',properties:{}}},
  {name:'preview_view_spec',description:'校验并预览声明式 ViewSpec v1，返回 draftId、pageId、workspaceId 和 version。',inputSchema:{type:'object',properties:{spec:{type:'object'},pageId:{type:'string'}},required:['spec']}},
  {name:'apply_view_spec',description:'将已预览的草稿保存到目标图页。重试复用同一个 requestId。',inputSchema:{type:'object',properties:{draftId:{type:'string'},pageId:{type:'string'},workspaceId:{type:'string'},version:{type:'integer'},requestId:{type:'string'}},required:['draftId','pageId','workspaceId','version','requestId']}},
  { name: 'snapshot', description: '获取 XiHe_GCS 当前数据链快照。默认只有最新值，避免大量上下文。通道带量程、报警阈值与样本数；serial 带实测速率；recording 说明是否正在录制。', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '日志/序列条数，默认1' }, include_series: { type: 'boolean', description: '是否包含最近序列' }, include_logs: { type: 'boolean', description: '是否包含串口日志' } } } },
  { name: 'list_channels', description: '列出全部通道（原始 + 脚本），含 id、名称、单位、量程、报警阈值（warnLow/warnHigh，null=未设）、最新值与样本数。要按名字反查通道 id 时先调它。', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['all', 'raw', 'script'], description: '默认 all' }, include_series: { type: 'boolean', description: '是否附带最近 100 点序列，默认 false' } } } },
  { name: 'channel_history', description: '获取指定通道最近序列数据。', inputSchema: { type: 'object', properties: { channel: { type: 'string', description: '通道 id 或名称' }, points: { type: 'number', description: '最近点数，默认100' } }, required: ['channel'] } },
  { name: 'list_scripts', description: '列出浏览器与 MCP 中已有的数据脚本。', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_protocols', description: '列出内置协议预设：JSON、ASCII、HEX、WED（传感器 wed-telemetry）、WED（飞控 wed-fc），含默认帧头/帧尾/校验/示例。', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_script', description: '创建数据脚本并同步到浏览器脚本库；run 默认 true，将自动挂载到脚本数据。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['functions', 'python'] }, formula: { type: 'string', description: '函数表达式，可使用 mean/sum/std/rms/slope/lowpass/ch1' }, code: { type: 'string', description: 'Python analyze(ctx) 代码' }, inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, unit: { type: 'string' }, range: { type: 'array', items: { type: 'number' } } } } }, run: { type: 'boolean' } }, required: ['name', 'inputs'], anyOf: [{ required: ['formula'] }, { required: ['code'] }] } },
  { name: 'update_script', description: '更新已有数据脚本；按 id 或 name 精确定位，失败会报错而不是静默创建。内置脚本只读；改名/改公式/改输入通道/改输出端口都走同一套校验，保留 id 与创建信息。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, new_name: { type: 'string', description: '改名时写这里（name 用于定位）' }, type: { type: 'string', enum: ['functions', 'python', 'graph'] }, formula: { type: 'string' }, code: { type: 'string' }, inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'object' } }, description: { type: 'string' }, run: { type: 'boolean', description: '更新后是否立刻运行一次，默认 false' } }, required: [] } },
  { name: 'delete_script', description: '删除一条自定义数据脚本；按 id 或 name 精确定位。内置脚本不能删除。浏览器侧会同步删除脚本通道并写删除墓碑，避免被轮询同步复活。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: [] } },
  { name: 'list_engines', description: '列出数据引擎（串口协议配置）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_engine', description: '创建数据引擎并同步到串口任务界面；可按 preset 直接生成，也可传入字段覆盖；activate 默认 true。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, preset: { type: 'string', enum: ['json', 'ascii', 'hex', 'wed', 'wedfc'], description: '推荐直接使用协议预设；wed=传感器 20 通道，wedfc=飞控 20 通道（姿态闭环）' }, protocol: { type: 'string', enum: ['JSON', 'ASCII', 'HEX', 'WED'] }, header: { type: 'string' }, tail: { type: 'string' }, terminator: { type: 'string' }, checksum: { type: 'string', enum: ['NONE', 'CRC16', 'CRC32', 'SUM8'] }, payloadBytes: { type: 'number', description: 'WED 负载字节数，默认 40' }, channelCount: { type: 'number', description: 'WED 通道数，默认 20' }, byteOrder: { type: 'string', enum: ['little', 'big'] }, hexScale: { type: 'number', description: 'HEX 缩放，默认 10' }, description: { type: 'string' }, activate: { type: 'boolean' } }, required: ['name'], anyOf: [{ required: ['preset'] }, { required: ['protocol'] }] } },
  { name: 'update_engine', description: '更新已有数据引擎；按 id 或 name 精确定位。协议/preset 变化会重新归一；如果改的是当前活动引擎，会通知浏览器重新激活（WED 会重建通道）。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, new_name: { type: 'string', description: '改名时写这里（name 用于定位）' }, preset: { type: 'string', enum: ['json', 'ascii', 'hex', 'wed', 'wedfc'] }, protocol: { type: 'string', enum: ['JSON', 'ASCII', 'HEX', 'WED'] }, header: { type: 'string' }, tail: { type: 'string' }, terminator: { type: 'string' }, checksum: { type: 'string', enum: ['NONE', 'CRC16', 'CRC32', 'SUM8'] }, payloadBytes: { type: 'number' }, channelCount: { type: 'number' }, byteOrder: { type: 'string', enum: ['little', 'big'] }, hexScale: { type: 'number' }, description: { type: 'string' } }, required: [] } },
  { name: 'delete_engine', description: '删除一条数据引擎；按 id 或 name 精确定位。当前活动引擎不能删除（先 set_active_engine 切走），避免把正在用的解析器删掉。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: [] } },
  { name: 'list_components', description: '列出可复用计算组件（公式组件与 Python 组件）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_component', description: '创建可复用计算组件并同步到画布组件库；公式组件使用 config.formula，Python 组件使用 config.code。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['formula', 'python'], description: 'formula=函数嵌套，python=Python analyze(ctx)' }, description: { type: 'string' }, inputs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } }, outputs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, unit: { type: 'string' }, color: { type: 'string' }, range: { type: 'array', items: { type: 'number' } } } } }, parameters: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' }, default: {} } } }, config: { type: 'object', properties: { formula: { type: 'string' }, code: { type: 'string' } } } }, required: ['name', 'inputs', 'outputs'] } },
  { name: 'update_component', description: '更新已有组件；支持按 id 或 name 定位；内置组件只读（先 create_component 复制再改）。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['formula', 'python'] }, description: { type: 'string' }, inputs: { type: 'array' }, outputs: { type: 'array' }, parameters: { type: 'array' }, config: { type: 'object' } }, required: [] } },
  { name: 'delete_component', description: '删除自定义组件；支持按 id 或 name 定位，不会自动删除画布中已引用的节点。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: [] } },
  { name: 'list_views', description: '列出可视化视图插件（内置波形/柱状/数据表/仪表/地图不在此列）；include_code=true 时返回完整插件代码。', inputSchema: { type: 'object', properties: { include_code: { type: 'boolean', description: '是否返回 code' } } } },
  { name: 'create_view', description: '创建可视化视图插件并同步到左侧仪表视图栏。code 是 JS 表达式，返回 {id,mount(ctx),update(ctx),unmount(ctx)?}；接口与画风规范见 xhgcs-view Skill（颜色/字体必须取 ctx.theme() 令牌，禁止硬编码色值与 fetch/setInterval）。建议先 verify_view 自检再交付。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string' }, desc: { type: 'string' }, code: { type: 'string' } }, required: ['name', 'code'] } },
  { name: 'verify_view', description: '在真实界面里自检一段视图插件代码：离屏真挂载跑若干帧，返回 contract/mount/update/render/style/dom/dpr/fit/teardown 九项检查、评分、墨水率与错误列表。交付视图前先用它验证效果。', inputSchema: { type: 'object', properties: { code: { type: 'string', description: '视图插件代码（JS 表达式）' }, frames: { type: 'number', description: '自检刷新帧数，默认 6，最多 20' }, timeoutMs: { type: 'number', description: '等待浏览器回传的毫秒数，默认 9000' } }, required: ['code'] } },
  { name: 'update_view', description: '更新可视化视图插件；支持按 id 或 name 定位。改完同样建议 verify_view。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, icon: { type: 'string' }, desc: { type: 'string' }, code: { type: 'string' } } } },
  { name: 'delete_view', description: '删除自定义可视化视图插件；支持按 id 或 name 定位。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
  { name: 'set_active_engine', description: '切换当前串口数据引擎。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'run_analysis', description: '运行函数脚本；如果脚本为 python 或需要在浏览器实时数据中执行，会排入浏览器队列。', inputSchema: { type: 'object', properties: { scriptId: { type: 'string' }, script_id: { type: 'string' }, name: { type: 'string' }, formula: { type: 'string' }, inputs: { type: 'array', items: { type: 'string' } } } } },
  { name: 'get_canvas', description: '获取当前浏览器分析画布的节点与连线状态；默认返回摘要，full=true 返回完整画布。', inputSchema: { type: 'object', properties: { full: { type: 'boolean' } } } },
  { name: 'create_graph', description: '创建节点式分析画布并保存为脚本模块；load 默认 true，会将画布同步到浏览器。component 节点需先创建组件或提供 config.componentId。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['source', 'math', 'filter', 'fft', 'python', 'component', 'output'] }, label: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, config: { type: 'object' } } } }, edges: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, sourceHandle: { type: 'string' }, target: { type: 'string' }, targetHandle: { type: 'string' } } } }, load: { type: 'boolean' }, run: { type: 'boolean' } }, required: ['name', 'nodes'] } },
  { name: 'list_boards', description: '列出本机全部看板（设计器文档）：id、名称、控件数、是否为活动板。改看板前先调它。', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_board', description: '读取一块看板的结构（控件 id/类型/栅格/绑定）。修改前必须先调用它拿准 id；省略 id 读当前活动板。', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '看板 id，省略=当前活动板' } } } },
  { name: 'create_board', description: '新建一块空看板并设为活动板。', inputSchema: { type: 'object', properties: { name: { type: 'string', description: '看板名称' } } } },
  { name: 'update_board', description: '对看板做增量修改。ops 只允许 add/remove/update/move/rename，一次最多 50 个；默认 dry_run=true 只校验不落库，把 dry_run 设为 false 才真正应用。应用后可用 undo_board 一步回退。', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '看板 id，省略=当前活动板' }, ops: { type: 'array', items: { type: 'object' }, description: '[{op:add,widget:{type,query}} / {op:update,id,channel} / {op:remove,id} / {op:move,id,grid} / {op:rename,name}]' }, dry_run: { type: 'boolean', description: '默认 true' }, base_updated_at: { type: 'number', description: '乐观并发：看板 updatedAt' } }, required: ['ops'] } },
  { name: 'open_board', description: '把看板切到前台并全屏运行（省略 id 打开当前活动板）。', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'undo_board', description: '回退最近一次看板补丁（AI/MCP 改坏时的安全绳）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_pages', description: '列出当前软件里的图页（实际显示在页签条上的图表页），含页内通道、时间窗与是否为活动页。', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_page', description: '读取一个图页的详情（通道当前值、单位、时间窗）；省略 id 读当前活动页。', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'create_page', description: '新建一个图页并切换到它：channels 接受通道名称或 id（如 "CH1"），会真正出现在页签条与绘图区；返回体 applied=true 才算成功。删除该页即可撤销。', inputSchema: { type: 'object', properties: { name: { type: 'string', description: '图页名称' }, channels: { type: 'array', items: { type: 'string' }, description: '要显示的通道，名称或 id' }, windowSec: { type: 'number', description: '时间窗秒数（1–600）' } }, required: ['channels'] } },
  { name: 'delete_page', description: '删除一个图页（按 id）。至少保留一个图页；用于撤销 create_page。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
];
function text(obj) { return JSON.stringify(obj, null, 2); }
function stdioSend(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// 写工具默认不暴露：桌面版设置里的「允许写操作」通过 XHGCS_MCP_WRITE=1 传给桥，
// 重启桥后生效。tools/list 与 /api/mcp 两条路都必须按同一份名单过滤，
// 否则只靠提示词约束等于没有访问控制。
const WRITE_TOOLS = new Set([
  'create_script', 'update_script', 'delete_script',
  'create_engine', 'update_engine', 'delete_engine', 'set_active_engine',
  'create_component', 'update_component', 'delete_component',
  'create_view', 'update_view', 'delete_view', 'verify_view',
  'create_graph', 'run_analysis',
  'create_board', 'update_board', 'open_board', 'undo_board',
  'create_page', 'delete_page', 'apply_view_spec'
]);
function writeAllowed() { return String(process.env.XHGCS_MCP_WRITE || '') === '1'; }
function visibleTools() {
  return TOOLS.filter(item => shellSupports(item.name) && (writeAllowed() || !WRITE_TOOLS.has(item.name)));
}
const LEGACY_VIEWS = new Set(['list_views','create_view','update_view','delete_view','verify_view']);
const SPEC_TOOLS = new Set(['list_view_components','preview_view_spec','apply_view_spec']);
function shellSupports(name) {
  const supported = browserState.shell?.viewSpecVersion === 1;
  if (SPEC_TOOLS.has(name)) return supported;
  return !supported || !LEGACY_VIEWS.has(name);
}
function assertToolAllowed(name) {
  if (!MCP_STDIO_ONLY && !shellSupports(name)) throw new Error('当前工作区未提供此视图工具');
  if (!writeAllowed() && WRITE_TOOLS.has(name)) {
    throw new Error('写操作未开启：请在 璇玑 设置 → MCP 桥 打开「允许写操作」（重启桥后生效）');
  }
}

// 启动器与 --mcp-stdio 代理都从实例凭据文件取令牌。
// 健康检查不再对外返回令牌（XHGCS_HEALTH_TOKEN=1 仅用于开发时的浏览器直连）。
function instanceToken() {
  const fromEnv = String(process.env.XHGCS_BRIDGE_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const file = String(process.env.XHGCS_INSTANCE_FILE || '').trim()
      || path.join(process.env.APPDATA || process.env.HOME || '', 'Xuanji', 'ai', 'instance.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.bridgeToken) return String(data.bridgeToken);
  } catch (err) { /* 文件不存在或应用未运行 */ }
  return '';
}

// 代理模式下把调用交给正在跑的主桥。令牌优先用实例凭据文件；
// 开发时桥可能没写实例文件，再退回健康检查（仅 dev 会返回 token）。
async function proxyRequest(route, payload) {
  const base = 'http://' + HOST + ':' + PORT;
  let token = instanceToken();
  if (!token) {
    try {
      const res = await fetch(base + '/api/health');
      const health = await res.json();
      if (health && health.token) token = String(health.token);
    } catch (err) {
      token = '';
    }
  }
  if (!token) {
    throw new Error('璇玑的本地桥没有在 ' + PORT + ' 上运行：请先打开应用，确认 设置 → MCP 桥 已启用，再让 Agent 调用工具');
  }
  const res = await fetch(base + route, {
    method: payload ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-XHGCS-Token': token },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(String((data && data.error) || ('主桥 HTTP ' + res.status)));
  return data;
}
async function proxyToolCall(name,args) {
  return (await proxyRequest('/api/mcp', {name,arguments:args||{}})).result;
}

async function stdioHandle(line) {
  let req;
  try { req = JSON.parse(line); } catch (err) { return; }
  if (!req || typeof req !== 'object') return;
  const id = req.id;
  if (req.method === 'initialize') {
    return stdioSend({ jsonrpc: '2.0', id, result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'XiHe GCS 地面站的本地桥。创建 / 更新 / 删除类工具要把改动排给桌面应用执行，'
        + '会等它回传结果（最多约 ' + Math.round(QUEUE_WAIT_MS / 1000) + ' 秒）：返回体里的 applied 才代表浏览器真的应用了，'
        + '失败时 error 说明原因。应用没打开时这些工具返回 ok:false，不要当成成功。'
    } });
  }
  if (req.method === 'notifications/initialized' || req.method === 'initialized') return;
  if (req.method === 'ping') return stdioSend({ jsonrpc: '2.0', id, result: {} });
  if (req.method === 'tools/list') {
    try {
      const tools = MCP_STDIO_ONLY ? (await proxyRequest('/api/mcp/tools')).tools : visibleTools();
      return stdioSend({jsonrpc:'2.0', id, result:{tools}});
    } catch (err) { return stdioSend({jsonrpc:'2.0', id, error:{code:-32000,message:err.message}}); }
  }
  if (req.method === 'tools/call') {
    try {
      const name = req.params && req.params.name;
      const args = req.params && req.params.arguments;
      assertToolAllowed(name);
      const result = MCP_STDIO_ONLY ? await proxyToolCall(name, args) : await callTool(name, args);
      return stdioSend({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text(result) }], isError: false } });
    } catch (err) {
      return stdioSend({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(err && err.message || err) }], isError: true } });
    }
  }
  if (id != null) stdioSend({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法：' + req.method } });
}
function sendJson(res, status, payload) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-XHGCS-Token',
    'Cache-Control': 'no-store'
  };
  // 来源在请求入口算好挂在 res 上，这里只负责按它决定要不要回 ACAO。
  // 不回 Access-Control-Allow-Private-Network：那条是专门用来允许公网页面访问 localhost 的。
  if (res.xhgcsOrigin) {
    headers['Access-Control-Allow-Origin'] = res.xhgcsOrigin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return readRequestBody(req, 5e6);
}
function runPython(code, data) {
  const prelude = 'import json, sys, statistics as st\nctx = json.loads(sys.stdin.read())\nfor _c in (ctx.get("raw") or []) + (ctx.get("script") or []):\n    _id = _c.get("id"); _name = _c.get("name")\n    _series = (ctx.get("series") or {}).get(_id, [])\n    if not _series and _c.get("value") is not None: _series = [_c["value"]]\n    ctx[_id] = _series; ctx[_name] = _series\n' +
    'for _k, _v in (ctx.get("series") or {}).items(): ctx[_k] = _v\n' +
    'def mean(x): return st.mean(x) if x else 0\n' +
    'def rms(x): return (sum(v*v for v in x)/len(x))**0.5 if x else 0\n' +
    'def std(x): return st.pstdev(x) if len(x)>1 else 0\n';
  const script = prelude + String(code || '') + '\nprint(json.dumps(analyze(ctx)))\n';
  const cmd = process.platform === 'win32' ? 'py' : 'python3';
  return new Promise((resolve) => {
    const child = spawn(cmd, ['-c', script], { windowsHide: true, env: process.env });
    const out = captureStream(child.stdout);
    const err = captureStream(child.stderr);
    child.on('error', () => resolve({ success: false, error: '未找到 Python 可执行文件，请安装 Python 或改用函数嵌套模式' }));
    child.on('close', (code) => {
      const text = out.text().trim();
      if (code !== 0) return resolve({ success: false, error: err.text() || ('Python 退出码 ' + code) });
      try { resolve({ success: true, outputs: JSON.parse(text) }); }
      catch (e) { resolve({ success: false, error: 'Python 输出无法解析：' + text }); }
    });
    child.stdin.end(JSON.stringify(data || {}) + '\n');
  });
}

// 只向调用方给的端点要模型列表。不再扫本机进程和常见端口：应用现在面向远程 API，
// 「发现本地模型」那套假设已经不成立了。
async function listUpstreamModels(body) {
  const endpoint = String(body && body.endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!endpoint) return { ok: false, error: '缺少 endpoint', models: [] };
  const headers = { Accept: 'application/json' };
  if (body && body.apiKey) headers.Authorization = 'Bearer ' + body.apiKey;
  try {
    const res = await fetch(endpoint + '/v1/models', { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, models: [] };
    const payload = await res.json().catch(() => ({}));
    return { ok: true, models: modelsFromPayload(payload) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), models: [] };
  }
}

function modelsFromPayload(payload) {
  const list = (payload && (payload.data || payload.models)) || [];
  const out = [];
  list.forEach((item) => {
    const id = item && (item.id || item.name || item.model);
    if (!id) return;
    const text = String(id).split(/[\\/]/).pop().replace(/\.(gguf|bin|safetensors)$/i, '');
    const value = text || String(id);
    if (out.indexOf(value) < 0) out.push(value);
  });
  return out;
}

function modelChatUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const url = new URL(base + '/v1/chat/completions');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https 模型端点');
  return url.href;
}

async function proxyAiChat(req, res, body) {
  if (!body || !body.endpoint || !body.model || !Array.isArray(body.messages)) {
    return sendJson(res, 400, { ok: false, error: '缺少 endpoint/model/messages' });
  }
  const stream = body.stream !== false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (body.apiKey) headers.Authorization = 'Bearer ' + body.apiKey;
    const upstreamPayload = {
      model: body.model,
      messages: body.messages,
      temperature: Number(body.temperature != null ? body.temperature : 0.2) || 0,
      max_tokens: Math.max(16, Math.min(16384, Number(body.max_tokens) || 1024)),
      stream
    };
    ['thinking', 'chat_template_kwargs', 'reasoning_effort', 'top_p', 'stop'].forEach((key) => {
      if (body[key] !== undefined) upstreamPayload[key] = body[key];
    });
    const upstream = await fetch(modelChatUrl(body.endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamPayload),
      signal: controller.signal
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      // 4xx 原样透传：统一包成 502 会让应用分不清「额度用尽 / 被限流 / 鉴权失败」
      // 和真正的网关故障，还会命中客户端的「关思考重跑」分支，白烧一次额度
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return sendJson(res, status, { ok: false, error: '上游 HTTP ' + upstream.status + (detail ? ' · ' + detail.slice(0, 240) : '') });
    }
    const contentType = upstream.headers.get('content-type') || (stream ? 'text/event-stream; charset=utf-8' : 'application/json');
    const streamHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
      'Connection': stream ? 'keep-alive' : 'close',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-XHGCS-Token'
    };
    if (res.xhgcsOrigin) {
      streamHeaders['Access-Control-Allow-Origin'] = res.xhgcsOrigin;
      streamHeaders['Vary'] = 'Origin';
    }
    res.writeHead(200, streamHeaders);
    if (!stream) return res.end(await upstream.text());
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (!res.headersSent) return sendJson(res, 502, { ok: false, error: String(err && err.message || err) });
    res.end();
  } finally {
    req.off('close', abort);
  }
}

// ---- DSH（DeepSeek Harness）AI 后端 ----
// 应用内的「AI 后端 = DSH」就是把生成任务交给官方 agent CLI 跑：
// `dsh --profile headless "<task>"` 跑完一个任务、把最终回答打到 stdout 后退出。
// 浏览器起不了进程，所以由本地桥代跑；用户已经配好的 DSH（模型/密钥/工具）直接复用。
const DSH_PROFILES = ['headless'];
const DSH_MAX_MS = 300000;
const DSH_ANSWER_PREAMBLE = '只回答下面的问题，不要读写任何文件、不要执行命令、不要使用工具。\n\n';
// stderr 有界消费 / 真实格式进度解析 / 失败真因抽取都在 ./dsh-stderr.js（纯函数可单测）；
// 桥这里只负责接线，别再往 runDshProcess 里塞解析细节。
const dshState = { entry: '', version: '', checkedAt: 0, running: 0, lastError: '' };

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

// 直接跑 CLI 入口的 bin.js（用 node 启动）：绕开 Windows 下 .cmd 的引号转义
function resolveDshEntry() {
  // XHGCS_DSH_BIN 是已有提示里就写着的逃生口（也用于自动化打桩），必须真的生效
  const fromEnv = String(process.env.XHGCS_DSH_BIN || '').trim();
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv;
    console.error('[xhgcs-bridge] XHGCS_DSH_BIN 指向的文件不存在：' + fromEnv);
  }
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  roots.push(path.join(dshHome(), 'profiles', 'node_modules'));
  for (const root of roots) {
    const entry = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(entry)) return entry;
  }
  return '';
}

// 杀进程树：Windows 用 taskkill /T /F，POSIX 在独立进程组里 kill(-pid)。
// 只杀父进程不够：headless 可能自己再拉起子进程，残留进程会让 running 计数看起来卡住。
function killDshTree(child) {
  if (!child || child.exitCode != null || child.killed) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { child.kill('SIGKILL'); }
    }
    return true;
  } catch (err) {
    try { child.kill('SIGKILL'); } catch (err2) { /* 进程可能已退出 */ }
    return false;
  }
}

// 跑一次 DSH 子进程。stderr 解析交给 ./dsh-stderr.js 的纯函数收集器（可单测）：
//   - 进度按真实上游格式（一次「dsh: reasoning:」头 + 裸文本增量）走状态机；
//   - 「dsh: <code>: <message>」是失败真因，退出时抽最后一条当 error；
//   - 有界消费只留尾部给调用方定位；超时/取消都杀进程树，不会留下孤儿进程。
function runDshProcess(args, timeoutMs, cwd, extraEnv, hooks) {
  const opts = hooks || {};
  return new Promise((resolve) => {
    const collector = createDshStderrCollector({
      onProgress: (text) => { if (opts.onProgress) opts.onProgress(text); },
      onProgressTruncated: () => { if (opts.onProgressTruncated) opts.onProgressTruncated(); }
    });
    let stdout = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer = null;
    let forceTimer = null;
    let child = null;
    const stderrTail = () => collector.getTail();
    const stopTimers = () => { clearTimeout(timer); clearTimeout(forceTimer); };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      stopTimers();
      if (opts.signal) opts.signal.removeEventListener('abort', onCancel);
      resolve(result);
    };
    // 真因优先：最后一条 dsh: code: message（reasoning 除外），再退最后一条非空行，最后才用退出码
    const failure = (code) => extractDshFailure(collector.getLines(), code, { timedOut: timedOut, timeoutMs: timeoutMs });
    const cancel = () => {
      if (settled || cancelled) return;
      cancelled = true;
      // 取消时也把残留在进度态的文本转发掉，别让界面停在半句
      collector.flush();
      killDshTree(child);
      // 不等 close：taskkill /T 可能还要几百毫秒，这里立刻回结果让 dshState.running 复位，
      // 用户点停止后能马上再问；close 到达时因 settled 守卫不会重复 resolve。
      finish({ ok: false, code: -1, timedOut: false, cancelled: true, error: '已取消 DSH 任务', stdout: stdout, stderrTail: stderrTail() });
    };
    const onCancel = () => cancel();
    try {
      child = spawn(process.execPath, args, {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 下起独立进程组，取消时能整组打掉；Windows 走 taskkill /T
        detached: process.platform !== 'win32',
        env: Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' }, extraEnv || {})
      });
    } catch (err) {
      resolve({ ok: false, code: -1, cancelled: false, timedOut: false, error: String((err && err.message) || err), stdout: '', stderrTail: '' });
      return;
    }
    if (opts.signal) {
      if (opts.signal.aborted) { cancel(); return; }
      opts.signal.addEventListener('abort', onCancel, { once: true });
    }
    child.stdout.on('data', (chunk) => { if (stdout.length < 400000) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => collector.feed(chunk));
    child.on('error', (err) => finish({
      ok: false, code: -1, timedOut: timedOut, cancelled: cancelled,
      error: String((err && err.message) || err), stdout: stdout, stderrTail: stderrTail()
    }));
    child.on('close', (code) => {
      collector.flush();
      if (cancelled) return;
      const problem = (!timedOut && code === 0) ? null : failure(code);
      finish({
        ok: !problem,
        code: code,
        timedOut: timedOut,
        cancelled: false,
        stdout: stdout,
        stderrTail: problem ? problem.stderrTail : stderrTail(),
        error: problem ? problem.error : ''
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killDshTree(child);
      // 兜底：kill 后 3 秒还没等到 close 就自己收尾，别让调用方挂到 HTTP 超时
      forceTimer = setTimeout(() => {
        finish({ ok: false, code: -1, timedOut: true, cancelled: false, error: 'DSH 超时（' + Math.round(timeoutMs / 1000) + 's）', stdout: stdout, stderrTail: stderrTail() });
      }, 3000);
    }, timeoutMs);
  });
}

async function dshStatus(force) {
  const now = Date.now();
  if (!force && dshState.checkedAt && now - dshState.checkedAt < 30000) return dshState;
  dshState.entry = resolveDshEntry();
  dshState.checkedAt = now;
  dshState.version = '';
  dshState.lastError = dshState.entry
    ? ''
    : '未找到 @deepseek-ai/dsh：先 npm i -g @deepseek-ai/dsh，或用 XHGCS_DSH_BIN 指向 .../@deepseek-ai/dsh/lib/bin.js';
  if (dshState.entry) {
    const out = await runDshProcess([dshState.entry, '--version'], 20000);
    const match = String(out.stdout || '').match(/\d+\.\d+\.\d+[\w.-]*/);
    if (match) dshState.version = match[0];
    else if (!out.ok) dshState.lastError = out.error || 'dsh --version 失败';
  }
  return dshState;
}

// 把 xhgcs 桥挂进 DSH 的 profile：overlay 写在系统临时目录、跑完就删，绝不改用户的
// ~/.dsh 配置。DSH 侧通过 --mcp-stdio 起一个代理实例，工具调用再由它转给正在跑的主桥。
function dshPatchOverlay() {
  const bridge = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(bridge), '..');
  const overlay = [{
    insert: [{
      id: 'mcp-xhgcs',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'xhgcs',
        transport: 'stdio',
        // process.execPath 在桌面版里是 Electron 可执行文件，靠 ELECTRON_RUN_AS_NODE
        // 以 Node 方式跑；命令行版里它本来就是 node。
        command: process.execPath,
        args: [bridge, '--mcp-stdio'],
        cwd: root,
        env: { ELECTRON_RUN_AS_NODE: '1', XHGCS_BRIDGE_PORT: String(PORT) },
        // 写工具要等浏览器回传，超时不能比队列等待还短。
        toolCallTimeoutMs: Math.max(15000, QUEUE_WAIT_MS + 10000)
      }
    }]
  }];
  const file = path.join(os.tmpdir(), 'xhgcs-dsh-mcp-' + process.pid + '-' + Date.now().toString(36) + '.json');
  fs.writeFileSync(file, JSON.stringify(overlay, null, 2), 'utf8');
  return file;
}

async function runDshTask(body, options) {
  const opts = options || {};
  const task = String((body && body.task) || '').trim();
  if (!task) return { ok: false, error: '缺少 task' };
  const status = await dshStatus(false);
  if (!status.entry) return { ok: false, error: status.lastError || 'DSH 不可用' };
  const wanted = String((body && body.profile) || 'headless');
  const profile = DSH_PROFILES.indexOf(wanted) >= 0 ? wanted : 'headless';
  const mode = String((body && body.mode) || 'answer') === 'agent' ? 'agent' : 'answer';
  const timeoutMs = Math.max(10000, Math.min(DSH_MAX_MS, Number(body && body.timeoutMs) || (mode === 'agent' ? DSH_MAX_MS : 180000)));
  if (dshState.running >= 2) return { ok: false, error: 'DSH 正在执行其它任务，稍后再试' };
  // answer 模式明确禁止用工具（结构化生成要的是纯 JSON）；agent 模式才让它真正接管。
  const prompt = mode === 'agent' ? task : DSH_ANSWER_PREAMBLE + task;
  const cwd = String((body && body.cwd) || '') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = [status.entry, '--profile', profile];
  const extraEnv = {};
  let patchFile = '';
  if (mode === 'agent') {
    patchFile = dshPatchOverlay();
    args.push('--patch', patchFile);
    // 用户明确要求让 DSH 真实接管：放开沙箱与逐次审批。这不是默认值，
    // 只有 agent 模式（聊天路径）会走到这里。
    extraEnv.DSH_PERMISSION_MODE = 'danger-full-access';
  }
  args.push(prompt);
  dshState.running += 1;
  const started = Date.now();
  try {
    const out = await runDshProcess(args, timeoutMs, cwd, extraEnv, {
      signal: opts.signal,
      onProgress: opts.onProgress,
      onProgressTruncated: opts.onProgressTruncated
    });
    if (out.cancelled) {
      return { ok: false, cancelled: true, error: out.error || '已取消 DSH 任务', ms: Date.now() - started, stderrTail: out.stderrTail || '' };
    }
    const content = String(out.stdout || '').trim();
    if (!out.ok) {
      // 真因来自 stderr 解析；stderrTail 只给尾部 1200 字符用于定位，不回传整段
      return {
        ok: false,
        error: out.error || ('DSH 退出码 ' + out.code),
        stderrTail: String(out.stderrTail || '').slice(-DSH_STDERR_TAIL),
        ms: Date.now() - started,
        timedOut: Boolean(out.timedOut)
      };
    }
    return {
      ok: true, content, ms: Date.now() - started, code: out.code, timedOut: false,
      chars: content.length, mode: mode,
      stderrTail: String(out.stderrTail || '').slice(-400)
    };
  } finally {
    if (patchFile) { try { fs.unlinkSync(patchFile); } catch (err) { /* 临时文件清不掉不影响结果 */ } }
    // 幂等：无论成功/失败/取消/异常，计数都必须回到 0，否则用户点停止后再问会被「正在执行」挡住
    dshState.running = Math.max(0, dshState.running - 1);
  }
}

// SSE 进度通道：复用 /api/ai/chat 的事件风格，不新开协议。
// 事件：{type:"reason",text} / {type:"reason",truncated:true} / {type:"final",content,ms} /
//       {type:"error",error,stderrTail,cancelled?} / 结束标记 data: [DONE]
async function runDshStream(res, body, signal) {
  const started = Date.now();
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-XHGCS-Token'
  };
  if (res.xhgcsOrigin) {
    headers['Access-Control-Allow-Origin'] = res.xhgcsOrigin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(200, headers);
  const write = (payload) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch (err) { /* 客户端已断开 */ }
  };
  try {
    const result = await runDshTask(body, {
      signal: signal,
      onProgress: (text) => write({ type: 'reason', text: text }),
      onProgressTruncated: () => write({ type: 'reason', truncated: true })
    });
    if (result.cancelled) {
      write({ type: 'error', error: result.error || '已取消 DSH 任务', cancelled: true, stderrTail: result.stderrTail || '' });
    } else if (!result.ok) {
      write({ type: 'error', error: result.error || 'DSH 执行失败', stderrTail: result.stderrTail || '' });
    } else {
      write({ type: 'final', content: result.content || '', ms: result.ms || (Date.now() - started) });
    }
  } catch (err) {
    write({ type: 'error', error: String((err && err.message) || err) });
  } finally {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write('data: [DONE]\n\n'); } catch (err) { /* 客户端已断开 */ }
      try { res.end(); } catch (err) { /* 客户端已断开 */ }
    }
  }
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    res.xhgcsOrigin = allowedOrigin(req);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    let url;
    try {
      url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);
    } catch {
      return sendJson(res, 400, { ok: false, error: '无效的请求地址' });
    }
    try {
      // 写操作一律要令牌，任何路径都不例外（预检已经在上面的 OPTIONS 里放掉了）
      if (req.method === 'POST' && !tokenOk(req)) {
        return sendJson(res, 403, { ok: false, error: '缺少或错误的 X-XHGCS-Token' });
      }
      // 健康检查只返回状态与实例标识，不返回令牌。浏览器/开发工具需要令牌时：
      // 桌面版走受限 IPC（preload 的 XHGCS_DESKTOP.ai.token），开发时由 services
      // 注入 XHGCS_HEALTH_TOKEN=1 才在健康响应里附带。
      if (url.pathname === '/api/health') {
        // 令牌只可能回给「开发模式下、来源在白名单里的应用页面」。
        // 无 Origin 的本机进程一律只拿到状态（实例文件才是启动器的凭据来源）。
        const exposeToken = String(process.env.XHGCS_HEALTH_TOKEN || '') === '1'
          && Boolean(allowedOrigin(req));
        return sendJson(res, 200, {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          sha: BRIDGE_SHA,
          pid: process.pid,
          instanceId: String(process.env.XHGCS_INSTANCE_ID || ''),
          workspaceId: String(process.env.XHGCS_WORKSPACE_ID || ''),
          revision: serverState.revision,
          tools: visibleTools().length,
          write: writeAllowed(),
          token: exposeToken ? TOKEN : ''
        });
      }
      if (url.pathname === '/api/state' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, 200, handleState(body));
      }
      if (url.pathname === '/api/state' && req.method === 'GET') {
        if (!tokenOk(req)) return sendJson(res, 403, { ok: false, error: '缺少或错误的 X-XHGCS-Token' });
        return sendJson(res, 200, getState());
      }
      if (url.pathname === '/api/ack' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const ids = new Set((body && body.ids) || []);
        // 每条的执行结果一并带回来。以前这里只收 ids、只回一个 remaining 数字，
        // 于是「浏览器执行失败」和「执行成功」在调用方眼里完全一样。
        ((body && body.results) || []).forEach((row) => {
          const deliver = row && ackWaiters.get(row.id);
          if (deliver) deliver(row);
        });
        serverState.queue = serverState.queue.filter((item) => !ids.has(item.qid || item.id));
        return sendJson(res, 200, { ok: true, remaining: serverState.queue.length });
      }
      if (url.pathname === '/api/mcp/tools' && req.method === 'GET') {
        if (!tokenOk(req)) return sendJson(res, 403, { ok: false, error: '缺少或错误的 X-XHGCS-Token' });
        return sendJson(res, 200, { ok: true, tools: visibleTools(), write: writeAllowed() });
      }
      if (url.pathname === '/api/mcp' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        assertToolAllowed(body.name || '');
        const result = await callTool(body.name || '', body.arguments || {});
        return sendJson(res, 200, { ok: true, result: result });
      }
      if (url.pathname === '/api/analyze' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await runPython(body.code || '', body.data || {});
        return sendJson(res, 200, result);
      }
      if (url.pathname === '/api/ai/models' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, 200, await listUpstreamModels(body));
      }
      if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return await proxyAiChat(req, res, body);
      }
      if (url.pathname === '/api/ai/dsh' && req.method === 'GET') {
        const status = await dshStatus(url.searchParams.get('refresh') === '1');
        return sendJson(res, 200, { ok: Boolean(status.entry), entry: status.entry, version: status.version, running: status.running, error: status.lastError || '' });
      }
      if (url.pathname === '/api/ai/dsh' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const client = new AbortController();
        // 浏览器停止/关页 → 连接断开 → 取消整个 DSH 任务并杀进程树。
        // 正常响应结束时 writableEnded 为 true，不会误杀。
        res.on('close', () => { if (!res.writableEnded) client.abort(); });
        if (body.stream === true) return await runDshStream(res, body, client.signal);
        const result = await runDshTask(body, { signal: client.signal });
        if (res.writableEnded || res.destroyed) return;
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
    }
  });
  server.on('error', (err) => { console.error('[xhgcs-bridge] HTTP:', err.message); });
  server.listen(PORT, HOST, () => console.error('[xhgcs-bridge] HTTP http://' + HOST + ':' + PORT));
}
function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => { if (line.trim()) stdioHandle(line.trim()); });
  process.stdin.on('end', () => { process.exit(0); });
}
// 代理模式只走 stdio，不绑 HTTP：端口留给正在运行的主桥。
if (!MCP_STDIO_ONLY) startHttp();
startStdio();
