'use strict';
// 从 vendor/dsh.zip 提取 DSH Web 界面的全部可改文件到 dsh-ui/。
// 只提取界面相关部分：前端 shell 的 dist 目录 + 每个包的 lib/client.js。
// 这两个部分就是 `dsh web` 实际发给浏览器的全部内容；主进程/工具代码不在这里。
//
// 用法：node dsh-ui/sync-dsh-ui.cjs [--zip <dsh.zip>] [--out <dsh-ui 目录>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const scriptDir = __dirname;
const repoRoot = path.dirname(scriptDir);

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const zipFile = path.resolve(argValue('--zip', path.join(repoRoot, 'vendor', 'dsh.zip')));
const outDir = path.resolve(argValue('--out', path.join(repoRoot, 'dsh-ui')));

if (!fs.existsSync(zipFile)) {
  console.error('找不到 dsh.zip: ' + zipFile);
  process.exit(1);
}

const PKG_ROOT = './node_modules/@deepseek-ai/dsh';
const NESTED = PKG_ROOT + '/node_modules/@deepseek-ai';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base, rows) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, base, rows);
    else rows.push({ path: path.relative(base, full).split(path.sep).join('/'), bytes: stat.size, sha256: sha256File(full) });
  }
  return rows;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const tar = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  : 'tar.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhgcs-dsh-ui-'));
try {
  const members = [
    PKG_ROOT + '/package.json',
    NESTED + '/dsh-web-frontend/dist',
    NESTED + '/*/lib/client.js'
  ];
  const result = spawnSync(tar, ['-xf', zipFile, '-C', temp].concat(members), { windowsHide: true, timeout: 180000 });
  if (result.status !== 0) {
    console.error('解包失败：' + String(result.stderr || ('exit ' + result.status)));
    process.exit(1);
  }
  const upstream = JSON.parse(fs.readFileSync(path.join(temp, PKG_ROOT, 'package.json'), 'utf8'));
  const nestedDir = path.join(temp, NESTED);
  const distDir = path.join(nestedDir, 'dsh-web-frontend', 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('解包里没有 dsh-web-frontend/dist/index.html');
    process.exit(1);
  }

  // 1) 前端 shell
  rmrf(path.join(outDir, 'frontend'));
  copyDir(distDir, path.join(outDir, 'frontend'));

  // 2) 客户端插件 bundle
  rmrf(path.join(outDir, 'plugins'));
  const pluginHashes = {};
  for (const name of fs.readdirSync(nestedDir)) {
    const file = path.join(nestedDir, name, 'lib', 'client.js');
    if (!fs.existsSync(file)) continue;
    const dst = path.join(outDir, 'plugins', name, 'client.js');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    pluginHashes[name] = sha256File(file);
  }

  // 3) 重新应用定制件（custom/*.css 与 custom/*.js）：拷进 assets 并在 index.html 引入
  const customDir = path.join(outDir, 'custom');
  if (fs.existsSync(customDir)) {
    const names = fs.readdirSync(customDir).filter((name) => /\.(css|js)$/.test(name));
    const assetsDir = path.join(outDir, 'frontend', 'assets');
    const indexFile = path.join(outDir, 'frontend', 'index.html');
    let html = fs.readFileSync(indexFile, 'utf8');
    for (const name of names) {
      fs.copyFileSync(path.join(customDir, name), path.join(assetsDir, name));
      if (name.endsWith('.css') && !html.includes('./assets/' + name)) {
        html = html.replace('  </head>', '    <link rel="stylesheet" href="./assets/' + name + '">\n  </head>');
      }
      if (name.endsWith('.js') && !html.includes('./assets/' + name)) {
        html = html.replace('  </head>', '    <script src="./assets/' + name + '"></script>\n  </head>');
      }
    }
    fs.writeFileSync(indexFile, html);
    console.log('  定制件  ' + names.length + ' 个 (' + names.join(', ') + ')');
  }

  // 4) 版本清单
  const frontendFiles = walk(path.join(outDir, 'frontend'), path.join(outDir, 'frontend'), []);
  const manifest = {
    note: 'DSH Web 界面提取件：frontend 是页面 shell，plugins/*/client.js 是各界面插件的客户端 bundle。改这里，应用启动 DSH 时覆盖到随包 DSH 的对应文件。',
    upstream: { name: upstream.name, version: upstream.version },
    sourceZip: { path: path.relative(repoRoot, zipFile).split(path.sep).join('/'), bytes: fs.statSync(zipFile).size, sha256: sha256File(zipFile) },
    extractedAt: new Date().toISOString(),
    frontend: { files: frontendFiles },
    plugins: { count: Object.keys(pluginHashes).length, packages: pluginHashes }
  };
  fs.writeFileSync(path.join(outDir, 'VERSION.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('提取完成: ' + outDir);
  console.log('  upstream ' + upstream.name + '@' + upstream.version);
  console.log('  frontend ' + frontendFiles.length + ' 个文件');
  console.log('  plugins  ' + manifest.plugins.count + ' 个客户端 bundle');
} finally {
  rmrf(temp);
}
