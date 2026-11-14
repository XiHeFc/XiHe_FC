'use strict';
// 把 dsh-ui/ 里改过的 DSH Web 界面覆盖到随包 DSH 的对应位置。
// dsh-ui/frontend      -> <dsh>/node_modules/@deepseek-ai/dsh-web-frontend/dist
// dsh-ui/plugins/<pkg> -> <dsh>/node_modules/@deepseek-ai/<pkg>/lib/client.js
// 用内容签名做戳记：没改过就跳过，改过则整批覆盖（文件量 ~16 MB）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STAMP = '.xuanji-ui-overlay.json';

function resolveUiRoot(options) {
  const opts = options || {};
  const candidates = [
    String(process.env.XHGCS_DSH_UI || '').trim(),
    opts.packaged && opts.resourcesPath ? path.join(opts.resourcesPath, 'dsh-ui') : '',
    opts.rootDir ? path.join(opts.rootDir, 'dsh-ui') : ''
  ].filter(Boolean);
  return candidates.find((dir) => {
    try {
      return fs.existsSync(path.join(dir, 'frontend', 'index.html')) && fs.existsSync(path.join(dir, 'VERSION.json'));
    } catch (err) {
      return false;
    }
  }) || '';
}

function findTargetBase(entry) {
  // entry = <...>/@deepseek-ai/dsh/lib/bin.js
  const dshPkg = path.dirname(path.dirname(entry));
  const bases = [
    path.join(dshPkg, 'node_modules', '@deepseek-ai'),
    path.dirname(dshPkg)
  ];
  for (const base of bases) {
    if (fs.existsSync(path.join(base, 'dsh-web-frontend'))) return base;
  }
  return '';
}

async function walkFiles(dir, base, rows) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, base, rows);
    else {
      const stat = await fs.promises.stat(full);
      rows.push(path.relative(base, full).split(path.sep).join('/') + '|' + stat.size + '|' + Math.floor(stat.mtimeMs));
    }
  }
  return rows;
}

async function signature(uiRoot) {
  const rows = [];
  for (const name of ['frontend', 'plugins']) {
    const folder = path.join(uiRoot, name);
    if (fs.existsSync(folder)) await walkFiles(folder, uiRoot, rows);
  }
  rows.sort();
  return crypto.createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 16);
}

async function applyUiOverlay(entry, uiRoot, log) {
  const logger = log || function () {};
  if (!uiRoot) return { ok: false, reason: 'no-ui-root' };
  const base = findTargetBase(entry);
  if (!base) return { ok: false, reason: 'no-target' };

  const rev = await signature(uiRoot);
  const stampFile = path.join(base, STAMP);
  try {
    const stamp = JSON.parse(await fs.promises.readFile(stampFile, 'utf8'));
    if (stamp && stamp.rev === rev && fs.existsSync(path.join(base, 'dsh-web-frontend', 'dist', 'index.html'))) {
      return { ok: true, applied: false, rev: rev };
    }
  } catch (err) { /* 没有戳记或损坏：照常覆盖 */ }

  const dist = path.join(base, 'dsh-web-frontend', 'dist');
  await fs.promises.cp(path.join(uiRoot, 'frontend'), dist, { recursive: true });

  const pluginsDir = path.join(uiRoot, 'plugins');
  let copied = 0;
  const skipped = [];
  for (const pkg of await fs.promises.readdir(pluginsDir)) {
    const from = path.join(pluginsDir, pkg, 'client.js');
    if (!fs.existsSync(from)) continue;
    const targetPkg = path.join(base, pkg, 'lib');
    if (!fs.existsSync(targetPkg)) { skipped.push(pkg); continue; }
    await fs.promises.copyFile(from, path.join(targetPkg, 'client.js'));
    copied += 1;
  }
  await fs.promises.writeFile(stampFile, JSON.stringify({ rev: rev, appliedAt: new Date().toISOString(), plugins: copied }, null, 2) + '\n');
  logger('dsh web: ui overlay rev ' + rev + ' (plugins ' + copied + (skipped.length ? ', skipped ' + skipped.join(',') : '') + ')');
  return { ok: true, applied: true, rev: rev, plugins: copied, skipped: skipped };
}

module.exports = { resolveUiRoot, applyUiOverlay, findTargetBase };
