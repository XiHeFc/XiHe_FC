'use strict';
// 读写随包 DSH Web 实例的配置（~/.xuanji/dsh-web/settings.yaml）。
// 只处理软件设置页会用到的小块；其它内容原样保留。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function webHome(options) {
  const opts = options || {};
  return opts.home || path.join(os.homedir(), '.xuanji', 'dsh-web');
}

function readBlock(text, key) {
  const re = new RegExp('^' + key + ':[ \\t]*\\n((?:[ \\t]+[^\\n]*\\n?)*)', 'm');
  const m = text.match(re);
  const map = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const hit = line.match(/^\s+([\w-]+):\s*(.*)$/);
      if (hit) map[hit[1]] = hit[2].trim();
    }
  }
  return map;
}

function writeBlock(text, key, map) {
  const body = Object.keys(map).map((k) => '  ' + k + ': ' + map[k]).join('\n');
  const block = key + ':\n' + body + '\n';
  const re = new RegExp('^' + key + ':[ \\t]*\\n((?:[ \\t]+[^\\n]*\\n?)*)', 'm');
  if (re.test(text)) return text.replace(re, block);
  const base = text.trimEnd();
  return (base ? base + '\n' : '') + block;
}

function readSettings(options) {
  const file = path.join(webHome(options), 'settings.yaml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { text = ''; }
  const model = readBlock(text, 'agent-default-model');
  const permission = readBlock(text, 'permission');
  const locale = readBlock(text, 'locale');
  return {
    provider: model.provider || 'deepseek-official',
    model: model.model || '',
    reasoningEffort: model.reasoningEffort || 'high',
    permission: permission.defaultPreset || 'workspace-write',
    locale: locale.preference || 'zh'
  };
}

const MODEL_IDS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const EFFORTS = ['off', 'low', 'high', 'max'];
const PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];
const LOCALES = ['zh', 'en'];

function applySettings(options, patch) {
  const p = patch || {};
  const next = readSettings(options);
  if (p.model !== undefined) {
    if (!MODEL_IDS.includes(String(p.model))) throw new Error('未知模型');
    next.model = String(p.model);
  }
  if (p.provider !== undefined) next.provider = String(p.provider);
  if (p.reasoningEffort !== undefined) {
    if (!EFFORTS.includes(String(p.reasoningEffort))) throw new Error('未知推理强度');
    next.reasoningEffort = String(p.reasoningEffort);
  }
  if (p.permission !== undefined) {
    if (!PRESETS.includes(String(p.permission))) throw new Error('未知权限模式');
    next.permission = String(p.permission);
  }
  if (p.locale !== undefined) {
    if (!LOCALES.includes(String(p.locale))) throw new Error('未知语言');
    next.locale = String(p.locale);
  }
  const home = webHome(options);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'settings.yaml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { text = ''; }
  text = writeBlock(text, 'agent-default-model', {
    provider: next.provider,
    model: next.model,
    reasoningEffort: next.reasoningEffort
  });
  text = writeBlock(text, 'permission', { defaultPreset: next.permission });
  text = writeBlock(text, 'locale', { preference: next.locale });
  fs.writeFileSync(file, text, 'utf8');
  return next;
}


const MODEL_CATALOG = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', desc: '上一代通用模型，支持图像输入，响应快' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', desc: '快速、经济，适合常规任务与并行场景' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', desc: '更强的代理编码与复杂推理，质量优先、成本更高' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', desc: '实验性视觉模型，支持图像输入' }
];

function hasCredentials(home) {
  try { return fs.existsSync(path.join(home || webHome(), ".credentials.yaml")); } catch (err) { return false; }
}

function listPlugins(base) {
  const out = [];
  if (!base) return out;
  let names = [];
  try { names = fs.readdirSync(base); } catch (err) { return out; }
  for (const name of names) {
    const file = path.join(base, name, 'package.json');
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j.dsh) continue;
      out.push({ id: name, name: j.name || name, version: j.version || '', ui: Boolean(j.dsh && j.dsh.client) });
    } catch (err) { /* 非插件包 */ }
  }
  out.sort((a, b) => (a.ui === b.ui ? a.id.localeCompare(b.id) : a.ui ? -1 : 1));
  return out;
}

function listPresets(home) {
  const dir = path.join(home || webHome(), '.agent-presets');
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(ya?ml|json)$/i.test(name)) out.push({ id: name.replace(/\.(ya?ml|json)$/i, ''), file: name });
    }
  } catch (err) { /* 没有自定义预设 */ }
  return out;
}

module.exports = { readSettings, applySettings, webHome, hasCredentials, listPlugins, listPresets, MODEL_CATALOG, MODEL_IDS, EFFORTS, PRESETS, LOCALES };
