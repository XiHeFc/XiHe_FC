const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../../electron/updater');

function setup({ available = true, answers = [], recording = false, fail = false } = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => {
    if (fail) throw new Error('secret server error');
    updater.emit(available ? 'update-available' : 'update-not-available');
    return { updateInfo: { version: '0.31.2', releaseNotes: '<b>说明</b>' } };
  };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 50 }); };
  updater.quitAndInstall = () => calls.push('install');
  const check = createUpdater({
    app: { isPackaged: true, getVersion: () => '0.31.1' }, updater,
    dialog: { showMessageBox: async (_, message) => { calls.push(message); return { response: answers.shift() || 0 }; } },
    shell: {}, window: () => ({ isDestroyed: () => false, setProgressBar() {}, webContents: { send() {} } }),
    recording: () => recording
  });
  return { check, calls, updater };
}

test('最新版本不下载', async () => {
  const { check, calls } = setup({ available: false });
  assert.equal((await check()).latest, true);
  assert.ok(!calls.includes('download'));
});
test('用户取消后不下载', async () => {
  const { check, calls } = setup({ answers: [1] });
  assert.equal((await check()).cancelled, true);
  assert.ok(!calls.includes('download'));
});
test('下载后选择稍后安装，不在退出时自动安装', async () => {
  const { check, calls, updater } = setup({ answers: [0, 1] });
  await check();
  assert.ok(calls.includes('download'));
  assert.ok(!calls.includes('install'));
  assert.equal(updater.autoInstallOnAppQuit, false);
});
test('录制时阻止安装，重复点击复用已下载文件', async () => {
  const { check, calls } = setup({ recording: true });
  await check(); await check();
  assert.equal(calls.filter(c => c === 'download').length, 1);
  assert.ok(!calls.includes('install'));
});
test('确认后才重启安装', async () => {
  const { check, calls } = setup();
  await check(); await new Promise(setImmediate);
  assert.ok(calls.includes('install'));
});
test('网络异常不会把原始异常带到界面', async () => {
  const { check, calls } = setup({ fail: true });
  assert.equal((await check()).ok, false);
  assert.ok(!JSON.stringify(calls).includes('secret server error'));
});
