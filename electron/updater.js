'use strict';

const RELEASES = 'https://github.com/XiHeFc/XiHe_FC/releases/latest';

function createUpdater(options) {
  const { app, dialog, shell, window: getWindow, recording } = options;
  let running = false;
  let ready = false;
  let updater;
  let available = false;
  function notify(text) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', text);
  }
  async function ask(message, detail, buttons) {
    return (await dialog.showMessageBox(getWindow(), {
      type: 'info', title: '璇玑更新', message, detail, buttons,
      defaultId: 0, cancelId: buttons.length - 1, noLink: true
    })).response;
  }
  return async function check() {
    if (running) return { ok: false, busy: true };
    running = true;
    try {
      if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) {
        if (await ask('请下载安装版以使用自动更新', '压缩包和便携版可从 GitHub 下载新版。安装版支持下载后重启安装，并保留用户配置。', ['打开下载页面', '取消']) === 0) await shell.openExternal(RELEASES);
        return { ok: true, manual: true };
      }
      if (!updater) {
        updater = options.updater || require('electron-updater').autoUpdater;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        // 不记录更新服务器的原始异常内容、请求头或令牌。
        updater.logger = null;
        updater.on('error', () => {});
        updater.on('update-available', () => { available = true; });
        updater.on('update-not-available', () => { available = false; });
        updater.on('download-progress', (p) => {
          notify('下载 ' + Math.floor(p.percent) + '%');
          const win = getWindow();
          if (win && !win.isDestroyed()) win.setProgressBar(p.percent / 100);
        });
      }
      if (!ready) {
        notify('检查中');
        available = false;
        const result = await updater.checkForUpdates();
        if (!result) throw new Error('更新服务没有返回结果');
        if (!available) {
          await ask('当前已是最新版本', '当前版本：' + app.getVersion(), ['确定']);
          return { ok: true, latest: true };
        }
        const info = result.updateInfo;
        const notes = typeof info.releaseNotes === 'string'
          ? info.releaseNotes.replace(/<[^>]*>/g, '').slice(0, 5000) : '';
        if (await ask('发现新版本 ' + info.version, '当前版本：' + app.getVersion() + '\n\n' + notes, ['下载更新', '稍后']) !== 0) return { ok: true, cancelled: true };
        notify('下载中');
        await updater.downloadUpdate();
        ready = true;
      }
      if (recording && recording()) {
        await ask('更新已下载，请先停止数据录制', '结束录制后再次点击“更新”，即可重启安装。', ['确定']);
        return { ok: true, downloaded: true };
      }
      if (await ask('更新已下载', '是否退出璇玑并安装更新？用户配置将保留。', ['重启安装', '稍后']) === 0) {
        if (recording && recording()) throw new Error('请先停止数据录制');
        setImmediate(() => updater.quitAndInstall(false, true));
      }
      return { ok: true, downloaded: true };
    } catch (error) {
      const message = error && error.message === '请先停止数据录制'
        ? error.message : '无法完成更新，请检查网络连接或稍后重试。也可以从 GitHub Releases 手动下载安装包。';
      await ask('更新未完成', message, ['确定']);
      return { ok: false };
    } finally {
      running = false;
      notify(ready ? '待安装' : '更新');
      const win = getWindow();
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
    }
  };
}

module.exports = { createUpdater };
