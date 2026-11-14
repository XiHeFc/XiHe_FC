'use strict';
// DSH 的 ACP 客户端（主进程）：JSON-RPC over stdio，负责会话、流式更新与取消。
// 协议来自 @deepseek-ai/dsh 的 acp profile（ACP v1：initialize / session/new / prompt / cancel / close）。
const { spawn } = require('node:child_process');
const readline = require('node:readline');

class AcpClient {
  constructor(options) {
    const opts = options || {};
    this.execPath = opts.execPath;
    this.entry = opts.entry;
    this.cwd = opts.cwd;
    this.env = opts.env || {};
    this.log = opts.log || function () {};
    this.onNotification = opts.onNotification || function () {};
    this.onPermission = opts.onPermission || function () { return 'reject'; };
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.buffer = '';
    this.stderrTail = '';
    this.activePromptId = 0;
  }

  start() {
    if (this.child && this.child.exitCode == null) return;
    this.child = spawn(this.execPath, [this.entry, '--profile', 'acp'], {
      cwd: this.cwd,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0'
      }, this.env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      if (String(chunk).trim()) this.log('[dsh] ' + String(chunk).trim().slice(0, 600));
    });
    this.child.on('exit', (code) => {
      this.log('dsh acp exited: ' + code);
      const error = new Error('DSH 已退出（code ' + code + '）' + (this.stderrTail ? '：' + this.stderrTail.slice(-300) : ''));
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
    });
    this.child.on('error', (err) => {
      this.log('dsh acp spawn error: ' + err.message);
    });
  }

  _onLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (err) {
      this.log('[dsh] non-protocol stdout: ' + text.slice(0, 200));
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'session/request_permission') {
      const params = message.params || {};
      let outcome;
      try {
        outcome = this.onPermission(params);
      } catch (err) {
        outcome = 'reject';
      }
      const options = Array.isArray(params.options) ? params.options : [];
      const pick = options.find((opt) => String(opt.optionId || '') === outcome)
        || options.find((opt) => String(opt.kind || '') === outcome)
        || options.find((opt) => String(opt.kind || '') === (outcome === 'allow' ? 'allow_once' : 'reject_once'));
      this._send({
        jsonrpc: '2.0',
        id: message.id,
        result: pick
          ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      });
      return;
    }
    if (message.method) {
      this.onNotification(message.method, message.params || {});
    }
  }

  _send(payload) {
    if (!this.child || this.child.exitCode != null) throw new Error('DSH 未运行');
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  request(method, params, timeoutMs) {
    this.start();
    this.seq += 1;
    const id = this.seq;
    if (method === 'session/prompt') this.activePromptId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.activePromptId === id) this.activePromptId = 0;
        reject(new Error('DSH 请求超时：' + method));
      }, Math.max(5000, Number(timeoutMs) || 60000));
      this.pending.set(id, {
        resolve: (value) => {
          if (this.activePromptId === id) this.activePromptId = 0;
          resolve(value);
        },
        reject: (error) => {
          if (this.activePromptId === id) this.activePromptId = 0;
          reject(error);
        },
        timer
      });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try {
      this._send({ jsonrpc: '2.0', method, params });
    } catch (err) { /* 连接已断开 */ }
  }

  async initialize(clientName) {
    return await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName || 'xuanji', version: '0.31.0' }
    }, 30000);
  }

  async newSession(options) {
    const opts = options || {};
    return await this.request('session/new', {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers || []
    }, 60000);
  }

  async prompt(sessionId, text, timeoutMs) {
    return await this.request('session/prompt', {
      sessionId: sessionId,
      prompt: [{ type: 'text', text: String(text || '') }]
    }, timeoutMs || 600000);
  }

  // ACP 的取消是 JSON-RPC 通知：$/cancel_request { requestId }（对进行中的 session/prompt）。
  // 0.1.5-rc.2 不接受 session/cancel 请求方法，必须走这条标准取消路径。
  cancelPrompt() {
    if (!this.activePromptId) return false;
    this.notify('$/cancel_request', { requestId: this.activePromptId });
    return true;
  }

  async closeSession(sessionId) {
    return await this.request('session/close', { sessionId: sessionId }, 15000);
  }

  dispose() {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('DSH 连接已关闭'));
    }
    this.pending.clear();
    if (this.child) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          this.child.kill('SIGKILL');
        }
      } catch (err) {
        try { this.child.kill(); } catch (err2) { /* 已退出 */ }
      }
      this.child = null;
    }
  }
}

module.exports = { AcpClient };
