const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
// 前端版本号散在四个地方（index.html 的 16 个 ?v= + boot/layout 的 VERSION + 启动脚本里的 URL），
// 以前每轮手写一遍替换脚本，容易漏一处导致浏览器吃到旧的 immutable 缓存。
const FILES = ['index.html', 'assets/js/boot.js', 'assets/js/layout.js', 'tools/start.ps1'];
const RE = /20\d{6}[A-Z]/g;

function readAll() {
  return FILES.map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
}
function versionsOf(list) {
  const out = {};
  for (const { f, text } of list) {
    for (const m of text.match(RE) || []) out[m] = (out[m] || 0) + 1;
    if (f.endsWith('.js') && !RE.test(text)) out['(none in ' + f + ')'] = 1;
  }
  return out;
}
function pkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const next = args.find((a) => /^20\d{6}[A-Z]$/.test(a));
const pkgArg = (args.find((a) => a.startsWith('--pkg=')) || '').split('=')[1];

if (check || !next) {
  const found = versionsOf(readAll());
  const names = Object.keys(found).filter((k) => !k.startsWith('('));
  const bad = names.filter((n) => !FILES.every((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(n).length - 1 > 0));
  console.log('前端版本：' + names.map((n) => n + ' ×' + found[n]).join(' / '));
  console.log('package.json：' + pkgVersion());
  if (names.length !== 1 || bad.length) {
    console.log('不一致：' + (bad.join(', ') || '存在多个版本号'));
    process.exit(1);
  }
  if (!check && !next) console.log('用法：node tools/bump-version.cjs 20260915A [--pkg=0.7.6]');
  process.exit(0);
}

const list = readAll();
const before = versionsOf(list);
const names = Object.keys(before).filter((k) => !k.startsWith('('));
if (names.length !== 1) {
  console.log('当前就不是单一版本号，先手动对齐：' + names.join(', '));
  process.exit(1);
}
const old = names[0];
let total = 0;
for (const { f, text } of list) {
  const n = text.split(old).length - 1;
  if (!n) {
    console.log('!! ' + f + ' 里没有 ' + old);
    continue;
  }
  fs.writeFileSync(path.join(ROOT, f), text.split(old).join(next));
  console.log(f + ' -> ' + n + ' 处');
  total += n;
}
if (pkgArg) {
  const p = path.join(ROOT, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.version = pkgArg;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  console.log('package.json -> ' + pkgArg);
}
console.log('前端 ' + old + ' -> ' + next + '（共 ' + total + ' 处）');
