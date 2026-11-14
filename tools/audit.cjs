'use strict';
// 静态体检：不启动浏览器，秒级跑完，专门盯「会长回来的那类债务」。
//   node tools/audit.cjs          只报告
//   node tools/audit.cjs --quiet  只在有问题时输出
// 任何一项不干净就 exit 1，方便挂进 npm test。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const TEXT_EXT = /\.(js|cjs|mjs|html|css|json|md|ps1|bat|py)$/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const readText = (f) => fs.readFileSync(f, 'utf8');
const cache = new Map(files.map((f) => [f, readText(f)]));
const jsModules = files.filter((f) => /^assets[\\/]js[\\/].*\.js$/.test(rel(f)));

const problems = [];
const report = (title, rows) => {
  if (!QUIET || rows.length) console.log(title + '：' + (rows.length ? rows.length + ' 项' : '干净'));
  rows.forEach((r) => console.log('  ' + r));
  if (rows.length) problems.push(title);
};

// 1) 死函数：模块里定义的顶层 function，全仓库（含 html/md/启动脚本）只出现一次
function deadFunctions() {
  const rows = [];
  for (const f of jsModules) {
    const lines = cache.get(f).split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /^\s{0,4}function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (!m) return;
      const name = m[1];
      const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
      let hits = 0;
      for (const [g, text] of cache) hits += (text.match(re) || []).length - (g === f ? 1 : 0);
      if (hits <= 0) rows.push(rel(f) + ':' + (i + 1) + '  ' + name);
    });
  }
  return rows;
}

// 2) 未引用的 CSS 类：只出现在 styles.css 里，html/js 全都不提
function unusedCssClasses() {
  const cssFile = files.find((f) => rel(f) === 'assets/css/styles.css');
  if (!cssFile) return ['找不到 assets/css/styles.css'];
  const css = cache.get(cssFile);
  const consumers = files.filter((f) => f !== cssFile && /\.(html|js|mjs|cjs)$/.test(f)).map((f) => cache.get(f)).join('\n');
  const classes = new Set();
  for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(m[1]);
  return [...classes]
    .filter((c) => !new RegExp('(?<![\\w-])' + c.replace(/[-$]/g, (ch) => '\\' + ch) + '(?![\\w-])').test(consumers))
    .sort();
}

// 3) DOM：重复 id，以及 JS 里 $(\'#id\') 指向了根本不存在的节点
//    存在的判据 = index.html 里的 id，或 JS 自己拼出来的 id="..."
function domRefs() {
  const indexHtml = files.find((f) => rel(f) === 'index.html');
  const html = cache.get(indexHtml);
  const known = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const dup = [];
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) dup.push('index.html 重复 id：' + id + ' ×' + n);

  for (const f of jsModules) {
    for (const m of cache.get(f).matchAll(/\bid="([^"]+)"/g)) known.add(m[1]);
  }
  const missing = [];
  for (const f of jsModules) {
    const lines = cache.get(f).split(/\r?\n/);
    lines.forEach((line, i) => {
      const re = /(?:\$|querySelector)\(\s*'#([A-Za-z][\w-]*)'\s*\)|getElementById\(\s*'([A-Za-z][\w-]*)'\s*\)/g;
      for (const m of line.matchAll(re)) {
        const id = m[1] || m[2];
        if (id === 'x' || known.has(id)) continue;
        missing.push(rel(f) + ':' + (i + 1) + '  找不到 #' + id);
      }
    });
  }
  return dup.concat(missing);
}

// 4) 版本串：交给 bump-version.cjs，别在这儿再写一份
function versionCheck() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'bump-version.cjs'), '--check'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const problems = [];
  if (r.status !== 0) problems.push(...out.map((l) => '版本不一致：' + l));
  if (!QUIET) out.forEach((l) => console.log('  版本：' + l));
  // 内核版本必须与 package.json 一致：双源漂移会让插件 engines 门禁与“关于内核”同时说假话
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const manifest = fs.readFileSync(path.join(ROOT, 'src', 'core', 'manifest.ts'), 'utf8');
    const hit = manifest.match(/CORE_VERSION\s*=\s*'([^']+)'/);
    const core = hit ? hit[1] : '';
    if (!core) problems.push('CORE_VERSION：src/core/manifest.ts 里找不到 CORE_VERSION');
    else if (core !== pkg.version) problems.push('CORE_VERSION ' + core + ' ≠ package.json ' + pkg.version);
    else if (!QUIET) console.log('  版本：CORE_VERSION ' + core + ' = package.json');
  } catch (err) {
    problems.push('版本检查失败：' + (err && err.message ? err.message : err));
  }
  return problems;
}

// 5) CSS 花括号配平：手改样式最常留下的坑
function braceBalance() {
  const cssFile = files.find((f) => rel(f) === 'assets/css/styles.css');
  if (!cssFile) return [];
  const css = cache.get(cssFile);
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  return open === close ? [] : ['styles.css 花括号不配平：{ ' + open + ' / } ' + close];
}

// 6) 记忆文件卫生：默认上下文体量有预算，过时结论不能重新混进自动加载链。
function memoryHygiene() {
  const rows = [];
  const limits = [
    ['AGENTS.md', 15000],
    ['CLAUDE.md', 3000],
    ['.codex/skills/xhgcs/SKILL.md', 8000],
    ['.codex/skills/xhgcs-view/SKILL.md', 20000],
    ['.codex/docs/engineering-history.md', 100000]
  ];
  const required = [
    'AGENTS.md',
    'CLAUDE.md',
    '.codex/skills/xhgcs/SKILL.md',
    '.codex/skills/xhgcs-view/SKILL.md',
    '.codex/docs/engineering-history.md'
  ];
  required.forEach((name) => {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) rows.push('缺少记忆文件：' + name);
  });
  limits.forEach(([name, limit]) => {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size > limit) rows.push(name + ' 超过预算：' + size + ' > ' + limit + ' bytes');
  });

  const auto = ['AGENTS.md', 'CLAUDE.md', '.codex/skills/xhgcs/SKILL.md', '.codex/skills/xhgcs-view/SKILL.md'];
  const stale = [
    /退化为本地意图匹配/,
    /xhgcs\.layout\.v1/,
    /xhgcs\.layout\.v2/,
    /互斥抽屉/,
    /底部串口状态条/,
    /8\s*项检查/,
    /四个?预设/,
    /11\s*个用例/
  ];
  auto.forEach((name) => {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    stale.forEach((re) => {
      if (re.test(text)) rows.push(name + ' 含过期结论：' + re.source);
    });
  });

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const files = pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [];
    ['.codex/skills/**/*', '.codex/docs/**/*'].forEach((name) => {
      if (!files.includes(name)) rows.push('package.json build.files 缺少：' + name);
    });
  } catch (err) {
    rows.push('无法读取 package.json 的 build.files');
  }
  return rows;
}

report('死函数', deadFunctions());
report('CSS 未引用类', unusedCssClasses());
report('DOM 引用', domRefs());
report('CSS 括号', braceBalance());
report('记忆文件', memoryHygiene());
report('版本串', versionCheck());

if (problems.length) {
  console.log('\n体检不通过：' + problems.join('、'));
  process.exit(1);
}
console.log('\n体检通过');
