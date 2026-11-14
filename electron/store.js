'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 极简 JSON 配置存储（窗口状态 / 桌面偏好）。
 * 不引入第三方依赖，写入采用 250ms 防抖，退出时可调用 flush()。
 */
function createStore(filePath, defaults) {
  const data = Object.assign({}, defaults || {});
  let timer = null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') Object.assign(data, parsed);
  } catch (err) {
    /* 首次运行或文件损坏，使用默认值 */
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 先写临时文件再 rename：断电/崩溃时不会留下被截断的配置
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      /* 写入失败不阻塞主流程，但保留日志便于排查 */
      console.warn('[XHGCS_STORE] 写入失败', err && err.message ? err.message : err);
    }
  }

  function save() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    if (timer.unref) timer.unref();
  }

  return {
    path: filePath,
    get(key) {
      return key === undefined ? data : data[key];
    },
    set(key, value) {
      data[key] = value;
      save();
      return value;
    },
    patch(values) {
      Object.assign(data, values || {});
      save();
      return data;
    },
    save,
    flush
  };
}

module.exports = { createStore };
