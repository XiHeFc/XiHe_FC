'use strict';
/**
 * 内核纯函数单测（不依赖 DOM / 浏览器）。
 *
 * 跑法：npm run test:unit
 *   = tsc -p tools/tsconfig.unit.json 编译到 .tmp/unit，再 node --test tests/unit
 *
 * 覆盖范围刻意只挑「错了不会报错、只会静默算错」的部分：
 * 版本区间、when 表达式、清单校验。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '..', '.tmp', 'unit', 'core');
const semver = require(path.join(OUT, 'semver.js'));
const when = require(path.join(OUT, 'when.js'));
const manifest = require(path.join(OUT, 'manifest.js'));

test('semver：解析版本号', () => {
  const parsed = semver.parseVersion('0.19.0');
  assert.equal(parsed.major, 0);
  assert.equal(parsed.minor, 19);
  assert.equal(parsed.patch, 0);
  assert.equal(parsed.prerelease, '');
  assert.equal(semver.parseVersion('v1.2.3').major, 1);
  assert.equal(semver.parseVersion('1.2.3-beta.1').prerelease, 'beta.1');
  assert.equal(semver.parseVersion('1.2'), null);
  assert.equal(semver.parseVersion('abc'), null);
});

test('semver：比较与预发布', () => {
  assert.equal(semver.compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(semver.compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(semver.compareVersions('1.2.3-beta.1', '1.2.3'), -1);
  assert.equal(semver.compareVersions('1.10.0', '1.9.0'), 1);
});

test('semver：区间匹配（含 0.x 的 caret 陷阱）', () => {
  assert.equal(semver.satisfies('0.19.0', '>=0.10.0 <1.0.0'), true);
  assert.equal(semver.satisfies('1.0.0', '>=0.10.0 <1.0.0'), false);
  assert.equal(semver.satisfies('0.9.9', '>=0.10.0 <1.0.0'), false);
  // ^0.2 只匹配 0.2.x，这正是清单里必须写显式区间的原因
  assert.equal(semver.satisfies('0.3.0', '^0.2.0'), false);
  assert.equal(semver.satisfies('0.2.9', '^0.2.0'), true);
  assert.equal(semver.satisfies('2.0.0', '*'), true);
  assert.equal(semver.satisfies('2.0.0', undefined), true);
});

test('when：变量与比较', () => {
  assert.equal(when.evaluateWhen('xhgcs && editorFocus', { xhgcs: true, editorFocus: true }), true);
  assert.equal(when.evaluateWhen('!editorFocus', { editorFocus: false }), true);
  assert.equal(when.evaluateWhen("platform == 'win32'", { platform: 'win32' }), true);
  assert.equal(when.evaluateWhen("platform != 'win32'", { platform: 'win32' }), false);
});

test('when：无效表达式不抛异常，按 false 处理', () => {
  assert.equal(when.evaluateWhen('a &&', { a: true }), false);
  assert.equal(when.evaluateWhen('(a || b', { a: true }), false);
  assert.equal(when.evaluateWhen('', {}), true);
  const check = when.validateWhen('a &&');
  assert.equal(check.ok, false);
});

function baseManifest(patch) {
  return Object.assign(
    {
      id: 'test.plugin',
      name: '测试插件',
      version: '0.1.0',
      apiVersion: '1',
      engines: { xhgcs: '>=0.10.0 <1.0.0' },
      main: 'main.js',
      activationEvents: ['onCommand:test.ping'],
      permissions: ['ui:toast'],
      contributes: { commands: [{ id: 'test.ping', title: 'Ping' }] }
    },
    patch
  );
}

test('manifest：合法清单通过并规范化', () => {
  const result = manifest.validateManifest(baseManifest());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.manifest.id, 'test.plugin');
  assert.equal(result.manifest.main, 'main.js');
});

test('manifest：拒绝非法 id / 缺字段 / 错引擎区间', () => {
  assert.equal(manifest.validateManifest(baseManifest({ id: 'Bad Id' })).ok, false);
  assert.equal(manifest.validateManifest(baseManifest({ version: 'x' })).ok, false);
  assert.equal(manifest.validateManifest(baseManifest({ main: '' })).ok, false);
  assert.equal(manifest.validateManifest(baseManifest({ main: 'main.txt' })).ok, false);
  assert.equal(manifest.validateManifest(baseManifest({ engines: { xhgcs: 'not-a-range' } })).ok, false);
  assert.equal(manifest.validateManifest(null).ok, false);
});

test('manifest：拒绝上级目录入口与未知权限', () => {
  const traversal = manifest.validateManifest(baseManifest({ main: '../evil.js' }));
  assert.equal(traversal.ok, false);
  assert.ok(traversal.issues.some((issue) => issue.path === '$.main'));
  const unknownPermission = manifest.validateManifest(baseManifest({ permissions: ['root:everything'] }));
  assert.equal(unknownPermission.ok, false);
});
