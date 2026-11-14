#!/usr/bin/env node
// 璇玑 MCP 稳定启动入口。
//
// 外部 Agent（Codex / Claude Code / 通用 MCP 客户端）只依赖这个入口：
//   xuanji-mcp --stdio        标准 MCP stdio，转发到正在运行的璇玑实例
//   xuanji-mcp --doctor       输出不含秘密的诊断（JSON）
//   xuanji-mcp --version      输出版本
//
// 它不启动业务后端，也不自带数据：实例记录由璇玑主进程写入
// %APPDATA%\Xuanji\ai\instance.json，启动器据此找到端口、校验实例身份并取得连接凭据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'xuanji';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SELF_DIR, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch (err) {
    return '0.0.0';
  }
}

function instanceFile() {
  const fromEnv = String(process.env.XHGCS_INSTANCE_FILE || '').trim();
  if (fromEnv) return fromEnv;
  const appData = process.env.APPDATA || os.homedir();
  return path.join(appData, 'Xuanji', 'ai', 'instance.json');
}

function loadInstance() {
  try {
    const file = instanceFile();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    if (!data.bridgePort || !data.instanceId) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

async function requestJson(url, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(opts.timeout) || 2500));
  try {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.token) headers['X-XHGCS-Token'] = opts.token;
    const response = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: null, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function discover() {
  const instance = loadInstance();
  if (!instance) {
    return { ok: false, error: '找不到璇玑实例记录（' + instanceFile() + '）。请先打开璇玑，并确认 设置 → MCP 桥 已启用。' };
  }
  const checks = {
    instanceFile: true,
    process: pidAlive(instance.pid),
    bridge: false,
    identity: false,
    token: Boolean(instance.bridgeToken)
  };
  if (!checks.process) {
    return { ok: false, instance, checks, error: '实例进程已退出（pid ' + instance.pid + '）。请重新打开璇玑。' };
  }
  const base = 'http://127.0.0.1:' + Number(instance.bridgePort);
  const health = await requestJson(base + '/api/health', { timeout: 1800 });
  if (!health.ok || !health.data || health.data.name !== 'xhgcs') {
    return { ok: false, instance, checks, error: '璇玑的本地桥没有响应（端口 ' + instance.bridgePort + '）。请在 设置 → MCP 桥 里点「重启本地服务」。' };
  }
  checks.bridge = true;
  const sameInstance = String(health.data.instanceId || '') === String(instance.instanceId || '');
  const sameSha = !instance.bridgeSha || String(health.data.sha || '') === String(instance.bridgeSha);
  checks.identity = sameInstance && sameSha;
  if (!checks.identity) {
    return { ok: false, instance, checks, health: health.data, error: '端口上的服务不是当前实例（身份校验失败）。请重启璇玑后再试。' };
  }
  if (!checks.token) {
    return { ok: false, instance, checks, health: health.data, error: '实例记录里没有连接凭据。请重启璇玑以重新生成。' };
  }
  return { ok: true, instance, checks, health: health.data, base, token: String(instance.bridgeToken) };
}

async function listTools(info) {
  const response = await requestJson(info.base + '/api/mcp/tools', { token: info.token, timeout: 2500 });
  if (!response.ok || !response.data || response.data.ok !== true) {
    const reason = (response.data && response.data.error) || response.error || ('HTTP ' + response.status);
    throw new Error('读取工具列表失败：' + reason);
  }
  return { tools: response.data.tools || [], write: Boolean(response.data.write) };
}

async function callTool(info, name, args) {
  const response = await requestJson(info.base + '/api/mcp', {
    method: 'POST',
    token: info.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, arguments: args || {} }),
    timeout: 30000
  });
  const data = response.data || {};
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error || response.error || ('主桥 HTTP ' + response.status)));
  }
  return data.result;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function stdioHandle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    return;
  }
  if (!req || typeof req !== 'object') return;
  const id = req.id;
  if (req.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: packageVersion() },
        instructions: '璇玑（Xuanji）地面站的 MCP 入口。读取类工具直接返回数据；写入类工具要等桌面应用执行并回传 applied=true 才算成功，失败时 error 说明原因。应用没打开时工具会返回可读错误，不要当作成功。'
      }
    });
  }
  if (req.method === 'notifications/initialized' || req.method === 'initialized') return;
  if (req.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (req.method === 'tools/list') {
    const info = await discover();
    if (!info.ok) return send({ jsonrpc: '2.0', id, error: { code: -32000, message: info.error } });
    try {
      const listed = await listTools(info);
      return send({ jsonrpc: '2.0', id, result: { tools: listed.tools } });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, error: { code: -32001, message: String((err && err.message) || err) } });
    }
  }
  if (req.method === 'tools/call') {
    const info = await discover();
    if (!info.ok) {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: info.error }], isError: true }
      });
    }
    try {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      const result = await callTool(info, name, args);
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      });
    } catch (err) {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true }
      });
    }
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法：' + req.method } });
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim()) stdioHandle(line.trim()).catch((err) => {
      process.stderr.write('[xuanji-mcp] ' + String((err && err.message) || err) + '\n');
    });
  });
  process.stdin.on('end', () => process.exit(0));
}

async function doctor() {
  const info = await discover();
  const report = {
    ok: Boolean(info.ok),
    launcher: { version: packageVersion(), protocolVersion: PROTOCOL_VERSION },
    app: info.instance ? {
      version: info.instance.appVersion,
      instanceId: info.instance.instanceId,
      workspaceId: info.instance.workspaceId,
      pid: info.instance.pid,
      bridgePort: info.instance.bridgePort,
      startedAt: info.instance.startedAt
    } : null,
    checks: info.checks || null,
    bridge: info.health ? {
      sha: info.health.sha,
      revision: info.health.revision,
      tools: info.health.tools,
      write: info.health.write
    } : null,
    error: info.ok ? '' : info.error
  };
  if (info.ok) {
    try {
      const listed = await listTools(info);
      report.tools = { count: listed.tools.length, write: listed.write, names: listed.tools.map((item) => item.name) };
    } catch (err) {
      report.tools = { error: String((err && err.message) || err) };
      report.ok = false;
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('xuanji-mcp ' + packageVersion() + ' protocol ' + PROTOCOL_VERSION + '\n');
} else if (args.includes('--doctor')) {
  doctor().catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }, null, 2) + '\n');
    process.exitCode = 1;
  });
} else if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    '璇玑 MCP 启动器',
    '',
    '用法：',
    '  xuanji-mcp --stdio     标准 MCP stdio（给 Codex / Claude Code 等客户端）',
    '  xuanji-mcp --doctor    输出诊断 JSON（不含令牌与私密数据）',
    '  xuanji-mcp --version   输出版本',
    '',
    '实例记录：' + instanceFile()
  ].join('\n') + '\n');
} else {
  // 默认 stdio：MCP 客户端的常规用法不要求显式参数
  startStdio();
}
