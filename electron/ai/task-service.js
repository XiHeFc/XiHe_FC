'use strict';
// 软件内 AI 会话服务（主进程）：默认 Agent = 随包 DSH（ACP）。
// 负责：进程与会话生命周期、消息持久化、流式事件、取消、MCP 注入。
// 渲染层只通过受限 IPC 调用，不接触 child_process / 凭据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { AcpClient } = require('./acp-client');

const MAX_MESSAGES = 200;

// 打包版把 DSH 以 zip 随包（electron-builder 会过滤 extraResources 里的 node_modules），
// 第一次用到时解压到用户目录；解压后直接返回 bin.js。
function resolveDshEntry(options, extract) {
  const candidates = [];
  const fromEnv = String(process.env.XHGCS_DSH_BIN || '').trim();
  if (fromEnv) candidates.push(fromEnv);
  if (options.packaged) {
    const runtime = path.join(options.userData, 'ai', 'dsh-runtime');
    const bundled = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(bundled)) return bundled;
    const zipFile = path.join(options.resourcesPath || '', 'dsh.zip');
    if (extract && fs.existsSync(zipFile)) {
      try {
        fs.mkdirSync(runtime, { recursive: true });
        const tar = process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
          : 'tar.exe';
        const result = spawnSync(tar, ['-xf', zipFile, '-C', runtime], { windowsHide: true, timeout: 180000 });
        if (result.status === 0 && fs.existsSync(bundled)) {
          if (options.log) options.log('ai: extracted bundled DSH -> ' + runtime);
          return bundled;
        }
        if (options.log) options.log('ai: DSH extract failed: ' + String(result.stderr || ('exit ' + result.status)));
      } catch (err) {
        if (options.log) options.log('ai: DSH extract error: ' + err.message);
      }
    }
    if (fs.existsSync(bundled)) return bundled;
  }
  const appData = process.env.APPDATA || '';
  if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  candidates.push(path.join(options.rootDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  return candidates.find((item) => item && fs.existsSync(item)) || '';
}

// Web 启动专用异步解包：tar 和磁盘 I/O 不阻塞 Electron 主进程。
const extractingRuntimes = new Map();
async function resolveDshEntryAsync(options, signal) {
  const existing = resolveDshEntry(options, false);
  if (!options.packaged) return existing;
  const runtime = path.join(options.userData, 'ai', 'dsh-runtime');
  const bundled = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const zipFile = path.join(options.resourcesPath || '', 'dsh.zip');
  if (existing === bundled || !fs.existsSync(zipFile)) return existing;
  if (extractingRuntimes.has(runtime)) return extractingRuntimes.get(runtime);
  const task = (async () => {
    if (!fs.existsSync(zipFile)) return '';
    const aiDir = path.resolve(options.userData, 'ai');
    await fs.promises.mkdir(aiDir, { recursive: true });
    const staging = await fs.promises.mkdtemp(path.join(aiDir, 'dsh-runtime.extract-'));
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
    await new Promise((resolve, reject) => {
      const unpack = spawn(tar, ['-xf', zipFile, '-C', staging], { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      let failure = null;
      const timer = setTimeout(() => { failure = new Error('DSH 解包超时'); unpack.kill(); }, 180000);
      unpack.stderr.on('data', chunk => { tail = (tail + chunk).slice(-1500); });
      unpack.once('error', err => { failure = err; });
      unpack.once('close', code => { clearTimeout(timer); failure ? reject(failure) : code === 0 ? resolve() : reject(new Error('DSH 解包失败：' + tail)); });
    });
    if (signal && signal.aborted) throw new Error('DSH 解包已取消');
    const stagedEntry = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    await fs.promises.access(stagedEntry);
    if (path.dirname(runtime) !== aiDir) throw new Error('DSH 运行时路径无效');
    if (fs.existsSync(runtime)) await fs.promises.rename(runtime, runtime + '.incomplete-' + Date.now());
    await fs.promises.rename(staging, runtime);
    return resolveDshEntry(options, false);
    } finally {
      // 只清理由本次 mkdtemp 创建、且位于 AI 数据目录内的暂存目录。
      if (path.dirname(staging) === aiDir && path.basename(staging).startsWith('dsh-runtime.extract-')) {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    }
  })();
  extractingRuntimes.set(runtime, task);
  try { return await task; } finally { extractingRuntimes.delete(runtime); }
}

function dshAvailable(options) {
  if (resolveDshEntry(options, false)) return true;
  if (!options.packaged) return false;
  try {
    return fs.existsSync(path.join(options.resourcesPath || '', 'dsh.zip'));
  } catch (err) {
    return false;
  }
}

function createAiTaskService(options) {
  const opts = options || {};
  const log = opts.log || function () {};
  const send = opts.send || function () {};
  const userData = opts.userData;
  const aiDir = path.join(userData, 'ai');
  const homeDir = path.join(aiDir, 'dsh');
  const workspaceDir = path.join(aiDir, 'workspace');
  const chatFile = path.join(aiDir, 'chat.json');

  const state = {
    messages: [],
    running: false,
    taskId: '',
    sessionId: '',
    model: '',
    modelLabel: '',
    version: '',
    status: 'idle',
    error: '',
    usage: null
  };
  let client = null;
  let assistantBuffer = '';
  let currentTools = [];
  let cancelRequested = false;
  let starting = null;

  function ensureDirs() {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    // 首次使用：如果用户已经有全局 DSH 凭据，复制一份到专用目录（不修改全局配置）。
    const local = path.join(homeDir, '.credentials.yaml');
    const globalHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const source = path.join(globalHome, '.credentials.yaml');
    try {
      if (!fs.existsSync(local) && globalHome !== homeDir && fs.existsSync(source)) {
        fs.copyFileSync(source, local);
        log('ai: copied existing DSH credentials into the app profile');
      }
    } catch (err) {
      log('ai: credential copy failed: ' + err.message);
    }
  }

  function loadMessages() {
    try {
      const raw = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
      if (Array.isArray(raw && raw.messages)) state.messages = raw.messages.slice(-MAX_MESSAGES);
    } catch (err) { /* 首次运行 */ }
  }

  function saveMessages() {
    try {
      fs.mkdirSync(aiDir, { recursive: true });
      fs.writeFileSync(chatFile, JSON.stringify({ messages: state.messages.slice(-MAX_MESSAGES) }, null, 2), 'utf8');
    } catch (err) {
      log('ai: save messages failed: ' + err.message);
    }
  }

  function pushMessage(message) {
    const item = Object.assign({ id: 'm-' + crypto.randomUUID(), at: new Date().toISOString() }, message);
    state.messages.push(item);
    if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES);
    saveMessages();
    emit({ type: 'message.added', message: item });
    return item;
  }

  function emit(event) {
    try {
      send(Object.assign({ at: Date.now(), sessionId: state.sessionId, taskId: state.taskId }, event));
    } catch (err) { /* 窗口已关闭 */ }
  }

  function mcpServerConfig() {
    const bridge = path.join(opts.rootDir, 'mcp-server', 'bridge.mjs');
    const write = typeof opts.writeEnabled === 'function' ? opts.writeEnabled() : false;
    const env = [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'XHGCS_BRIDGE_PORT', value: String(opts.bridgePort()) },
      { name: 'XHGCS_INSTANCE_FILE', value: opts.instanceFile },
      // 代理进程自己也按这个开关过滤 tools/list；只靠主桥的 env 不够。
      { name: 'XHGCS_MCP_WRITE', value: write ? '1' : '0' }
    ];
    return {
      name: 'xhgcs',
      command: opts.execPath,
      args: [bridge, '--mcp-stdio'],
      env: env
    };
  }

  function ensureClient() {
    if (client) return client;
    const entry = resolveDshEntry(opts, true);
    if (!entry) throw new Error('找不到内置 DSH：安装包缺少 resources/dsh（或开发环境未安装 @deepseek-ai/dsh）');
    ensureDirs();
    client = new AcpClient({
      execPath: opts.execPath,
      entry: entry,
      cwd: workspaceDir,
      env: { DSH_HOME: homeDir },
      log: log,
      onPermission: (params) => {
        // DSH 自带的 shell / 文件工具默认拒绝；只放行 xhgcs 的 MCP 工具。
        const title = String((params && params.toolCall && params.toolCall.title) || '');
        const allow = title.indexOf('mcp__xhgcs') === 0;
        return allow ? 'allow_once' : 'reject_once';
      },
      onNotification: (method, params) => onNotification(method, params)
    });
    return client;
  }

  function diffModelOptions(configOptions) {
    const list = Array.isArray(configOptions) ? configOptions : [];
    const model = list.find((item) => item && item.id === 'model');
    if (!model) return;
    state.model = String(model.currentValue || '');
    state.modelLabel = '';
    const groups = Array.isArray(model.options) ? model.options : [];
    for (const group of groups) {
      const items = Array.isArray(group.options) ? group.options : [];
      const hit = items.find((item) => String(item.value) === String(model.currentValue));
      if (hit) {
        state.modelLabel = String(hit.name || '');
        break;
      }
    }
  }

  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    if (starting) return await starting;
    starting = (async () => {
      state.status = 'starting';
      emit({ type: 'status', status: 'starting', text: '正在启动内置助手…' });
      const c = ensureClient();
      const init = await c.initialize('xuanji-ui');
      state.version = String((init && init.agentInfo && init.agentInfo.version) || '');
      const session = await c.newSession({ cwd: workspaceDir, mcpServers: [mcpServerConfig()] });
      state.sessionId = String(session.sessionId || '');
      diffModelOptions(session.configOptions);
      state.status = 'idle';
      emit({ type: 'status', status: 'idle', text: '已连接', model: state.modelLabel || state.model, version: state.version });
      return state.sessionId;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function onNotification(method, params) {
    if (method !== 'session/update') return;
    if (String(params.sessionId || '') !== state.sessionId) return;
    const update = params.update || {};
    const kind = String(update.sessionUpdate || '');
    if (kind === 'agent_message_chunk') {
      const text = String((update.content && update.content.text) || '');
      if (!text) return;
      assistantBuffer += text;
      emit({ type: 'message.delta', text: text });
      return;
    }
    if (kind === 'tool_call') {
      currentTools.push({
        id: String(update.toolCallId || ''),
        title: String(update.title || ''),
        status: String(update.status || 'in_progress'),
        text: ''
      });
      emit({
        type: 'tool',
        phase: 'started',
        toolCallId: update.toolCallId,
        title: String(update.title || ''),
        toolKind: String(update.kind || ''),
        status: String(update.status || '')
      });
      return;
    }
    if (kind === 'tool_call_update') {
      let text = '';
      try {
        const content = Array.isArray(update.content) ? update.content : [];
        text = content.map((item) => {
          const inner = item && item.content;
          return inner && inner.type === 'text' ? String(inner.text || '') : '';
        }).filter(Boolean).join('\n').slice(0, 1200);
      } catch (err) { /* 内容不可读 */ }
      const record = currentTools.find((item) => item.id === String(update.toolCallId || ''));
      if (record) {
        record.status = String(update.status || record.status);
        if (text) record.text = text;
      }
      emit({
        type: 'tool',
        phase: 'update',
        toolCallId: update.toolCallId,
        status: String(update.status || ''),
        text: text
      });
      return;
    }
    if (kind === 'usage_update') {
      state.usage = { used: Number(update.used) || 0, size: Number(update.size) || 0 };
      emit({ type: 'usage', usage: state.usage });
    }
  }

  async function sendMessage(text) {
    const message = String(text || '').trim();
    if (!message) return { ok: false, error: '消息为空' };
    if (state.running) return { ok: false, error: '助手正在回答，请先停止或等待完成' };
    pushMessage({ role: 'user', text: message });
    state.running = true;
    cancelRequested = false;
    state.taskId = 't-' + crypto.randomUUID();
    state.error = '';
    assistantBuffer = '';
    currentTools = [];
    emit({ type: 'task.started', taskId: state.taskId });
    emit({ type: 'assistant.open', taskId: state.taskId });

    (async () => {
      const taskId = state.taskId;
      try {
        const sessionId = await ensureSession();
        if (cancelRequested) {
          // 启动阶段就被取消：不发 prompt，直接按取消收尾
          state.running = false;
          state.status = 'idle';
          cancelRequested = false;
          state.taskId = '';
          emit({ type: 'task.cancelled', taskId: taskId, message: null });
          return;
        }
        const result = await client.prompt(sessionId, message);
        const assistant = pushMessage({ role: 'assistant', text: assistantBuffer || '（没有返回文本）', tools: currentTools.slice() });
        assistantBuffer = '';
        state.running = false;
        state.status = 'idle';
        const stopReason = String((result && result.stopReason) || 'end_turn');
        if (cancelRequested || stopReason === 'cancelled') {
          emit({ type: 'task.cancelled', taskId: state.taskId, message: assistant });
        } else {
          emit({ type: 'task.completed', taskId: state.taskId, message: assistant, stopReason: stopReason });
        }
      } catch (error) {
        state.running = false;
        state.status = 'error';
        state.error = String((error && error.message) || error);
        log('ai: prompt failed: ' + state.error);
        // 已经流出来的半截回答也留档，用户能看到停在哪里
        if (assistantBuffer) pushMessage({ role: 'assistant', text: assistantBuffer, tools: currentTools.slice() });
        assistantBuffer = '';
        emit({ type: 'task.failed', taskId: state.taskId, error: state.error });
      } finally {
        cancelRequested = false;
      }
    })();
    return { ok: true, taskId: state.taskId };
  }

  async function cancel() {
    if (!state.running) return { ok: false, error: '当前没有正在执行的回答' };
    cancelRequested = true;
    // 会话还在启动、prompt 请求还没发出去时也要能取消：标记后由 send 流程在发请求前退出。
    const sent = client ? client.cancelPrompt() : false;
    emit({ type: 'status', status: 'cancelling', text: sent ? '正在停止…' : '正在启动时取消…' });
    return { ok: true, sent: sent };
  }

  async function resetSession(reason) {
    // 桥的写权限/端口变化后，Agent 会话里缓存的工具列表就过期了：关掉旧会话，
    // 下一条消息会按新权限重新协商（历史消息保留）。
    if (!client || !state.sessionId) return { ok: true };
    const sid = state.sessionId;
    state.sessionId = '';
    try {
      await client.closeSession(sid);
    } catch (err) {
      log('ai: reset session failed: ' + err.message);
    }
    emit({ type: 'status', status: 'idle', text: reason || '连接配置已更新' });
    return { ok: true };
  }

  async function clear() {
    if (state.running) return { ok: false, error: '助手正在回答，请先停止再清空' };
    state.messages = [];
    saveMessages();
    emit({ type: 'messages.cleared' });
    // 清空记录同时结束模型上下文：下一条消息重新建立会话，不会带着旧记忆。
    await resetSession('已清空对话');
    return { ok: true };
  }

  function status() {
    return {
      ok: true,
      available: dshAvailable(opts),
      running: state.running,
      status: state.status,
      error: state.error,
      sessionId: state.sessionId,
      model: state.model,
      modelLabel: state.modelLabel,
      version: state.version,
      usage: state.usage,
      messages: state.messages
    };
  }

  let viewClient = null;
  async function generateView(prompt) {
    if (viewClient) throw new Error('正在生成另一个视图');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65000) throw new Error('视图提示过长或为空');
    const entry = resolveDshEntry(opts, true);
    if (!entry) throw new Error('内置 DSH 不可用');
    let text = '', sessionId = '';
    const draftClient = new AcpClient({
      execPath: opts.execPath, entry, cwd: workspaceDir, env: {DSH_HOME:homeDir},
      onPermission: () => 'reject_once',
      onNotification(method, params) {
        const u = params.update;
        if (method === 'session/update' && params.sessionId === sessionId &&
            u?.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string')
          text = (text + u.content.text).slice(0, 65537);
      }
    });
    viewClient = draftClient;
    try {
      await draftClient.initialize('xuanji-view');
      sessionId = (await draftClient.newSession({cwd:workspaceDir, mcpServers:[]})).sessionId;
      await draftClient.prompt(sessionId, prompt, 120000);
      if (text.length > 65536) throw new Error('视图回复超过 64K');
      if (!text.trim()) throw new Error('助手未返回视图规格');
      return text;
    } finally {
      draftClient.dispose();
      if (viewClient === draftClient) viewClient = null;
    }
  }
  function dispose() {
    if (viewClient) { viewClient.dispose(); viewClient = null; }
    if (client) {
      const sid = state.sessionId;
      if (sid) {
        try { client.closeSession(sid).catch(() => {}); } catch (err) { /* 忽略 */ }
      }
      client.dispose();
      client = null;
    }
  }

  loadMessages();
  ensureDirs();

  return { status: status, send: sendMessage, generateView, cancel: cancel, clear: clear, dispose: dispose, ensureSession: ensureSession, resetSession: resetSession };
}

module.exports = { createAiTaskService, resolveDshEntry, resolveDshEntryAsync, dshAvailable };
