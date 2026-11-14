'use strict';
// 把已验证的 DSH 版本复制到 vendor/dsh 并打成 vendor/dsh.zip，供 electron-builder 作为
// extraResources 随包（electron-builder 会过滤掉 extraResources 里的 node_modules，
// 所以安装包里放 zip，首次使用时由主进程解压到用户目录）。
// 源目录默认是全局 npm 安装（@deepseek-ai/dsh），也可以用 XHGCS_DSH_SOURCE 指向别处。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = process.env.XHGCS_DSH_SOURCE
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const DEST_ROOT = path.join(ROOT, 'vendor', 'dsh');
const DEST = path.join(DEST_ROOT, 'node_modules', '@deepseek-ai', 'dsh');
const ZIP = path.join(ROOT, 'vendor', 'dsh.zip');

function fail(message) {
  console.error('prepare:dsh FAIL: ' + message);
  process.exit(1);
}

if (!fs.existsSync(path.join(SOURCE, 'package.json'))) fail('找不到 DSH 源目录：' + SOURCE);

const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
if (pkg.name !== '@deepseek-ai/dsh') fail('源目录不是 @deepseek-ai/dsh：' + pkg.name);
if (!fs.existsSync(path.join(SOURCE, 'lib', 'bin.js'))) fail('源目录缺少 lib/bin.js');
if (!fs.existsSync(path.join(SOURCE, 'LICENSE'))) fail('源目录缺少 LICENSE');

console.log('source:', SOURCE);
console.log('version:', pkg.version, 'license:', pkg.license || 'unknown');

fs.rmSync(DEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
console.log('copying (this can take a minute)…');
fs.cpSync(SOURCE, DEST, { recursive: true, force: true });

const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(path.join(SOURCE, 'package.json')));
const meta = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license || '',
  repository: pkg.repository && pkg.repository.url || '',
  source: SOURCE,
  packageJsonSha256: hash.digest('hex'),
  preparedAt: new Date().toISOString()
};
fs.writeFileSync(path.join(DEST_ROOT, 'VERSION.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

// bsdtar（Windows 10+ 自带）打 zip，能处理长路径；zip 是单个文件，electron-builder 不会过滤。
console.log('zipping to vendor/dsh.zip…');
try { fs.rmSync(ZIP, { force: true }); } catch (err) { /* ignore */ }
const tar = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  : 'tar.exe';
const zip = spawnSync(tar, ['-a', '-cf', ZIP, '-C', DEST_ROOT, '.'], { encoding: 'utf8', timeout: 300000 });
if (zip.status !== 0) fail('打包 zip 失败：' + (zip.stderr || zip.error || ('exit ' + zip.status)));
if (!fs.existsSync(ZIP)) fail('zip 没有生成');

console.log('vendor ready:', DEST_ROOT);
console.log('zip:', ZIP, (fs.statSync(ZIP).size / 1048576).toFixed(1) + ' MB');
console.log('bundled version:', meta.version, 'sha256(package.json)=' + meta.packageJsonSha256.slice(0, 16));
