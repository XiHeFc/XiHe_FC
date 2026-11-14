'use strict';
// 外部 Agent 的 MCP 接入状态（只读）。
// 这里只检测客户端配置文件里有没有 xhgcs 这一项，并生成可直接复制的配置；
// 不在未获用户明确授权时改写用户主目录下的客户端配置。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function clientPaths(home) {
  const base = home || os.homedir();
  return {
    claude: path.join(base, '.claude.json'),
    codex: path.join(base, '.codex', 'config.toml')
  };
}

function readText(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), text: '' };
  }
}

function claudeStatus(paths) {
  const read = readText(paths.claude);
  if (!read.ok) return { installed: false, configured: false, path: paths.claude };
  let data = null;
  try { data = JSON.parse(read.text); } catch (err) { return { installed: false, configured: false, path: paths.claude, error: '配置不是合法 JSON' }; }
  const current = data && data.mcpServers && data.mcpServers.xhgcs;
  return {
    installed: Boolean(current),
    configured: Boolean(current),
    path: paths.claude,
    command: current ? String(current.command || '') : ''
  };
}

function codexStatus(entry, paths) {
  const read = readText(paths.codex);
  const text = read.ok ? read.text : '';
  const header = '[mcp_servers.xhgcs]';
  const start = text.indexOf(header);
  const installed = start >= 0;
  let matches = false;
  if (installed) {
    const rest = text.slice(start + header.length);
    const next = rest.search(/^\s*\[[^\]]+\]\s*$/m);
    const section = next >= 0 ? rest.slice(0, next) : rest;
    // 只读比对：现有条目的 command/args 是否就是当前版本生成的入口
    matches = section.indexOf(tomlString(entry.command)) >= 0
      && entry.args.every((arg) => section.indexOf(tomlString(arg)) >= 0);
  }
  return { installed: installed, configured: installed, matches: matches, path: paths.codex };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexConfig(entry) {
  return [
    '[mcp_servers.xhgcs]',
    'command = ' + tomlString(entry.command),
    'args = [' + entry.args.map(tomlString).join(', ') + ']',
    'startup_timeout_sec = 30',
    ''
  ].join('\n');
}

function claudeJson(entry) {
  return JSON.stringify({ mcpServers: { xhgcs: { command: entry.command, args: entry.args.slice() } } }, null, 2);
}

function claudeCommand(entry) {
  const tail = [entry.command].concat(entry.args).map((part) => {
    return /\s/.test(part) ? '"' + part + '"' : part;
  }).join(' ');
  return 'claude mcp add xhgcs -- ' + tail;
}

function createClientIntegrations(options) {
  const opts = options || {};
  const home = opts.home || os.homedir();
  const entry = opts.entry; // { command, args }
  const paths = clientPaths(home);
  function status() {
    return {
      ok: true,
      entry: entry,
      paths: paths,
      clients: {
        claude: Object.assign({ id: 'claude', name: 'Claude Code', level: '工具接入' }, claudeStatus(paths)),
        codex: Object.assign({ id: 'codex', name: 'Codex', level: '工具接入' }, codexStatus(entry, paths)),
        generic: { id: 'generic', name: '通用 MCP', level: '工具接入', path: '' }
      },
      configs: {
        codex: codexConfig(entry),
        claudeJson: claudeJson(entry),
        claudeCommand: claudeCommand(entry)
      }
    };
  }
  return { status: status, paths: paths };
}

module.exports = { createClientIntegrations, clientPaths, codexConfig, claudeJson, claudeCommand };
