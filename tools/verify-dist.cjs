#!/usr/bin/env node
'use strict';
/**
 * 打包验收：确认装出来的 app.asar 里真的有「运行 + 插件生态 + 文档」这几类东西。
 *
 *   node tools/verify-dist.cjs                 # 检查 dist/win-unpacked/resources/app.asar
 *   node tools/verify-dist.cjs --asar=<path>   # 检查指定 asar
 *   node tools/verify-dist.cjs --self-test     # 用合成清单验证检查器本身（不需要打包）
 *
 * 为什么要有这个：插件目录、类型声明这些东西不进包，源码跑得好好的，装机版就是缺文件。
 * 这种缺陷没法靠「打开应用看一眼」发现，只能靠清单比对。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 装机版必须有的文件（相对 asar 根的路径） */
const REQUIRED = [
  { file: 'index.html', why: '入口页面' },
  { file: 'assets/js/core.bundle.js', why: '插件内核产物' },
  { file: 'assets/js/boot.js', why: '模块加载器' },
  { file: 'electron/main.js', why: '主进程' },
  { file: 'electron/preload.js', why: '预加载桥' },
  { file: 'electron/static-server.js', why: '静态服务（含 /ext 挂载）' },
  { file: 'electron/store.js', why: '主进程配置存储' },
  { file: 'electron/services.js', why: '桥/TTS 服务管理' },
  { file: 'electron/recorder.js', why: '录制落盘' },
  { file: 'mcp-server/bridge.mjs', why: 'MCP 桥' },
  { file: 'mcp-server/bytes.mjs', why: '桥的字节工具' },
  { file: 'plugins/index.json', why: '内置插件索引' },
  { file: 'plugins/xihe.demo.hello/xhgcs.extension.json', why: '随包示例插件' },
  { file: 'plugins/xhgcs.user.fixture/xhgcs.extension.json', why: '用户目录样例插件' },
  { file: 'AGENTS.md', why: '项目约定' },
  { file: '.codex/docs/plugin-architecture.md', why: '插件架构文档' }
];

/**
 * 必须随包但**不能**放进 asar 的文件：electron-builder 默认排除 `.d.ts`
 * （fileMatcher 的 excludedExts 里写死了），所以类型声明只能走 extraResources。
 * 这个坑值得留在这里：直观看 files 里加上 types 目录就够了，实际打出来就是没有。
 */
const REQUIRED_RESOURCES = [{ file: 'types/xhgcs.d.ts', why: '插件作者类型声明（extraResources）' }];

function pickAsar(argv) {
  const arg = argv.find((item) => item.startsWith('--asar='));
  if (arg) return path.resolve(arg.slice('--asar='.length));
  const candidates = [
    path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, 'dist', 'win-arm64-unpacked', 'resources', 'app.asar')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function listAsar(asarPath) {
  const asar = require('@electron/asar');
  return asar.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]+/, '').split(path.sep).join('/'));
}

function checkEntries(entries) {
  const set = new Set(entries);
  const missing = REQUIRED.filter((item) => !set.has(item.file));
  return { ok: missing.length === 0, missing, total: entries.length };
}

/** 沿 require / 入口清单走一遍闭包：缺一个文件就是装机版的运行时错误 */
function closureFiles() {
  const out = new Set();
  const walkRequires = (base, file) => {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch (err) { return; }
    const re = /require\(['"]\.\/([^'"]+)['"]\)/g;
    let hit;
    while ((hit = re.exec(text))) {
      const target = hit[1];
      out.add(base + (/\.m?js$/.test(target) ? target : target + '.js'));
    }
  };
  walkRequires('electron/', 'electron/main.js');
  walkRequires('mcp-server/', 'mcp-server/bridge.mjs');
  try {
    const boot = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'boot.js'), 'utf8');
    const groups = boot.match(/files:\s*\[[^\]]*\]/g) || [];
    for (const group of groups) {
      const names = group.match(/'([^']+\.js)'/g) || [];
      for (const name of names) out.add('assets/js/' + name.replace(/'/g, ''));
    }
  } catch (err) { /* boot.js 不在仓库时跳过 */ }
  return Array.from(out);
}

/** extraResources 在 asar 外面：resources/<file> */
function checkResources(asarPath) {
  const resourcesDir = path.dirname(asarPath);
  const missing = REQUIRED_RESOURCES.filter((item) => !fs.existsSync(path.join(resourcesDir, item.file)));
  return { ok: missing.length === 0, missing, dir: resourcesDir };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const good = checkEntries(REQUIRED.map((item) => item.file));
    const bad = checkEntries(REQUIRED.filter((item) => item.file !== 'plugins/index.json').map((item) => item.file));
    const pass =
      good.ok === true &&
      bad.ok === false &&
      bad.missing.some((item) => item.file === 'plugins/index.json') &&
      REQUIRED_RESOURCES.length > 0;
    console.log(pass ? '✔ 检查器自检通过（缺文件时会报错）' : '✖ 检查器自检失败');
    process.exit(pass ? 0 : 1);
  }

  const asarPath = pickAsar(argv);
  if (!fs.existsSync(asarPath)) {
    console.error('✖ 找不到安装包：' + asarPath);
    console.error('  先跑 npm run pack，或用 --asar=<path> 指定。');
    process.exit(1);
  }

  let entries;
  try {
    entries = listAsar(asarPath);
  } catch (err) {
    console.error('✖ 读取 asar 失败：' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  const result = checkEntries(entries);
  const resources = checkResources(asarPath);
  // must-have 是白名单，闭包才是“真跑得起来”的那部分
  const closure = closureFiles();
  const entrySet = new Set(entries);
  const missingClosure = closure.filter((file) => !entrySet.has(file));
  if (!result.ok || !resources.ok || missingClosure.length) {
    const missing = result.missing.concat(resources.missing, missingClosure.map((file) => ({ file, why: 'require/入口闭包' })));
    console.error('✖ 安装包缺少 ' + missing.length + ' 个必备文件：');
    for (const item of missing) {
      console.error('  - ' + item.file + '（' + item.why + '）');
    }
    console.error('\n检查 package.json 的 build.files（asar 内）与 build.extraResources（asar 外）是否覆盖了这些路径。');
    process.exit(1);
  }
  console.log(
    '✔ 安装包验收通过：asar ' + result.total + ' 个文件、' + REQUIRED.length + ' 项必备齐全；extraResources ' +
      REQUIRED_RESOURCES.length + ' 项齐全'
  );
  console.log('  ' + asarPath);
}

main();
