'use strict';
// GitHub 源码包入口：只启动当前目录，不跳转到本机其它安装版本。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dsh = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('依赖安装失败，请检查网络和上方错误。');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('源码启动需要 Node.js 22 或更新版本。');
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error('请先完整解压源码压缩包。');
  let updaterReady = false;
  try { require.resolve('electron-updater', { paths: [root] }); updaterReady = true; } catch (_) {}
  if (!fs.existsSync(electronExe) || !fs.existsSync(dsh) || !updaterReady) {
    if (!fs.existsSync(npmCli)) throw new Error('没有找到 Node.js 配套的 npm，请安装完整 Node.js，或使用发布页的安装包。');
    console.log('首次运行：正在安装 Electron、Harness 和项目依赖，可能需要几分钟……');
    run(process.execPath, [npmCli, 'ci', '--foreground-scripts', '--no-audit', '--no-fund']);
    if (!fs.existsSync(electronExe)) run(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')]);
  }
  if (!fs.existsSync(dsh)) throw new Error('Harness 依赖缺失，请查看 npm 安装错误。');
  if (process.argv.includes('--check')) {
    console.log('源码启动检查通过：Electron、Harness、更新依赖均已就绪。');
    return;
  }
  const env = Object.assign({}, process.env, { XHGCS_DSH_BIN: dsh });
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('启动当前源码目录中的璇玑……');
  const child = spawn(electronExe, [root], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code || 0; });
}
main().catch((error) => { console.error('启动失败：' + error.message); process.exitCode = 1; });
