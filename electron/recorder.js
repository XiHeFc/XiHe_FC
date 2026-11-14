'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { rotateMB: 32, capGB: 2, manifestIntervalMs: 5000 };
const FLUSH_BYTES = 256 * 1024;
const SIZE_CACHE_MS = 5000;

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function stampId(date) {
  const d = date || new Date();
  return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
    '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function createRecorder(options) {
  const opts = options || {};
  const baseDir = path.join(opts.userData, 'recordings');
  const config = Object.assign({}, DEFAULTS, opts.config || {});
  let session = null;
  let lastFinished = null;
  const sizeCache = { at: 0, bytes: 0 };

  function ensureBaseDir() {
    fs.mkdirSync(baseDir, { recursive: true });
    return baseDir;
  }

  // 只允许操作 recordings 目录内的路径，避免任何越界删除
  function resolveInsideBase(target) {
    const resolved = path.resolve(baseDir, target);
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  function sessionDirs() {
    if (!fs.existsSync(baseDir)) return [];
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(function (entry) { return entry.isDirectory() && entry.name.indexOf('session-') === 0; })
      .map(function (entry) { return path.join(baseDir, entry.name); });
  }

  function dirSize(dir) {
    let total = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return 0;
    }
    entries.forEach(function (entry) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += dirSize(full);
        else total += fs.statSync(full).size;
      } catch (err) {}
    });
    return total;
  }

  function invalidateSize() {
    sizeCache.at = 0;
    sizeCache.bytes = 0;
  }

  // 目录体积扫描有成本，desktop:status 每 4 秒轮询一次，这里做 5 秒缓存
  function totalSize(force) {
    const now = Date.now();
    if (!force && sizeCache.at && now - sizeCache.at < SIZE_CACHE_MS) return sizeCache.bytes;
    const bytes = sessionDirs().reduce(function (sum, dir) { return sum + dirSize(dir); }, 0);
    sizeCache.at = now;
    sizeCache.bytes = bytes;
    return bytes;
  }

  function limitBytes() {
    return Math.max(64 * 1024 * 1024, Number(config.capGB) * 1024 * 1024 * 1024);
  }

  function prune() {
    const limit = limitBytes();
    let total = totalSize(true);
    if (total <= limit) return { removed: 0, totalBytes: total };
    const activeDir = session ? path.resolve(session.dir) : '';
    const candidates = sessionDirs()
      .filter(function (dir) { return path.resolve(dir) !== activeDir; })
      .map(function (dir) {
        let mtime = 0;
        try { mtime = fs.statSync(dir).mtimeMs; } catch (err) {}
        return { dir: dir, mtime: mtime, size: dirSize(dir) };
      })
      .sort(function (a, b) { return a.mtime - b.mtime; });
    let removed = 0;
    for (let i = 0; i < candidates.length && total > limit; i++) {
      const item = candidates[i];
      const target = resolveInsideBase(item.dir);
      if (!target) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true });
        total -= item.size;
        removed++;
      } catch (err) {}
    }
    total = Math.max(0, total);
    sizeCache.at = Date.now();
    sizeCache.bytes = total;
    return { removed: removed, totalBytes: total };
  }

  function partFile(index) {
    return 'data-' + pad(index, 4) + '.csv';
  }

  function writeManifest() {
    if (!session) return;
    session.lastManifestAt = Date.now();
    try {
      fs.writeFileSync(session.manifestPath, JSON.stringify(session.manifest, null, 2), 'utf8');
    } catch (err) {
      session.lastError = err && err.message ? err.message : String(err);
    }
  }

  // 会话进行中按时间节流补写索引，让 manifest 与 CSV 不至于差得太远。
  // 只在 start/stop 写的话，被 taskkill / 断电打断时就停在初始值（rows:0、endedAt:null）：
  // CSV 里明明有数据而索引说谎，事后按 manifest 找会话会以为那份记录是空的。
  function syncManifest() {
    if (!session) return;
    if (Date.now() - (session.lastManifestAt || 0) < config.manifestIntervalMs) return;
    session.manifest.rows = session.rows;
    const entry = session.manifest.parts[session.manifest.parts.length - 1];
    if (entry && entry.file === session.partFile) {
      entry.rows = session.partRows;
      entry.bytes = session.partBytes;
    }
    writeManifest();
  }

  function headerBlock() {
    const m = session.manifest;
    const lines = [
      '#Xuanji 数据记录 session=' + m.id + ' part=' + session.part,
      '#started=' + m.startedAt + ' intervalMs=' + m.intervalMs + ' source=' + m.source + ' engine=' + m.engine,
      '#channels=' + JSON.stringify(m.channels),
      // 列含义写进文件本身：t 与 wall 的区别、以及中间各列跟 manifest.channels 的对应关系，
      // 否则隔几天回来只能靠猜（老文件的 t 是拿配置间隔凑出来的，已经吃过一次亏）
      '#columns=t 为真实经过秒数（串口按帧到达时刻推进·断线体现为跳变）· 中间各列按上面 channels 的顺序 · wall 为该行的 UTC 墙钟时间 · miss 为本行前向填充过的通道 id（| 分隔·空表示全部实测）'
    ];
    lines.push(['t'].concat(m.channels.map(function (ch) {
      return csvCell(ch.unit ? ch.name + '(' + ch.unit + ')' : ch.name);
    })).concat(['wall', 'miss']).join(','));
    return lines.join('\n') + '\n';
  }

  function rotateBytes() {
    return Math.max(1, Number(config.rotateMB) || DEFAULTS.rotateMB) * 1024 * 1024;
  }

  function openPart(index) {
    closePart();
    session.part = index;
    session.partFile = partFile(index);
    session.partPath = path.join(session.dir, session.partFile);
    session.partBytes = 0;
    session.partRows = 0;
    session.fd = fs.openSync(session.partPath, 'a');
    const header = Buffer.from(headerBlock(), 'utf8');
    fs.writeSync(session.fd, header);
    session.headerBytes = header.length;
    session.partBytes += header.length;
    session.bytes += header.length;
    session.manifest.parts.push({ file: session.partFile, rows: 0, bytes: header.length });
    sizeCache.bytes += header.length;
  }

  function closePart() {
    if (session && session.fd != null) {
      try { fs.closeSync(session.fd); } catch (err) {}
      session.fd = null;
      const entry = session.manifest.parts[session.manifest.parts.length - 1];
      if (entry && entry.file === session.partFile) {
        entry.rows = session.partRows;
        entry.bytes = session.partBytes;
      }
    }
  }

  function status() {
    if (!session) {
      return {
        active: false,
        lastSession: lastFinished,
        dir: ensureBaseDir(),
        totalBytes: totalSize(),
        limitBytes: limitBytes(),
        config: { rotateMB: config.rotateMB, capGB: config.capGB }
      };
    }
    return {
      active: session.active,
      sessionId: session.id,
      dir: session.dir,
      part: session.part,
      rows: session.rows,
      bytes: session.bytes,
      totalBytes: totalSize(),
      limitBytes: limitBytes(),
      startedAt: session.manifest.startedAt,
      source: session.manifest.source,
      channels: session.manifest.channels.length,
      lastError: session.lastError || '',
      config: { rotateMB: config.rotateMB, capGB: config.capGB }
    };
  }

  function start(manifest) {
    stop('restart');
    ensureBaseDir();
    const spec = manifest || {};
    const now = new Date();
    const id = stampId(now);
    let dir = path.join(baseDir, 'session-' + id);
    let suffix = 1;
    while (fs.existsSync(dir)) {
      dir = path.join(baseDir, 'session-' + id + '-' + suffix);
      suffix++;
    }
    fs.mkdirSync(dir, { recursive: true });
    session = {
      id: id,
      dir: dir,
      manifestPath: path.join(dir, 'manifest.json'),
      manifest: {
        id: id,
        app: spec.app || 'Xuanji',
        version: spec.version || '',
        startedAt: now.toISOString(),
        endedAt: null,
        intervalMs: Number(spec.intervalMs) || 0,
        source: spec.source || 'serial',
        engine: spec.engine || '',
        channels: Array.isArray(spec.channels) ? spec.channels : [],
        parts: [],
        rows: 0
      },
      startedAtMs: now.getTime(),
      lastManifestAt: 0,
      rows: 0,
      bytes: 0,
      part: 0,
      partBytes: 0,
      partRows: 0,
      headerBytes: 0,
      fd: null,
      active: true,
      lastError: ''
    };
    writeManifest();
    openPart(1);
    const pruned = prune();
    return { session: status(), pruned: pruned };
  }

  /**
   * 同步追加。按行写入并在分片写满时轮转，单次调用可以跨多个分片。
   */
  function append(text, rowCount) {
    if (!session || !session.active || session.fd == null) return { ok: false, reason: 'inactive' };
    const chunk = typeof text === 'string' ? text : String(text || '');
    const rows = Math.max(0, Number(rowCount) || 0);
    if (!chunk || chunk.indexOf('\n') < 0 && !chunk.trim()) {
      session.rows += rows;
      return { ok: true, bytes: 0, part: session.part, rotated: 0 };
    }
    const limit = rotateBytes();
    const pieces = chunk.split('\n');
    let buffer = '';
    let bufferBytes = 0;
    let rotated = 0;
    let written = 0;

    const flush = function () {
      if (!buffer) return;
      fs.writeSync(session.fd, Buffer.from(buffer, 'utf8'));
      session.partBytes += bufferBytes;
      session.bytes += bufferBytes;
      sizeCache.bytes += bufferBytes;
      written += bufferBytes;
      buffer = '';
      bufferBytes = 0;
    };

    for (let i = 0; i < pieces.length; i++) {
      const isLast = i === pieces.length - 1;
      const piece = pieces[i];
      if (isLast && !piece) break;
      const line = isLast ? piece : piece + '\n';
      if (!line) continue;
      const lineBytes = Buffer.byteLength(line);
      // 当前分片已有数据，且再加一行会超出轮转阈值 -> 收尾并开启下一个分片
      if (session.partBytes + bufferBytes + lineBytes > limit &&
          session.partBytes + bufferBytes > session.headerBytes) {
        flush();
        openPart(session.part + 1);
        rotated++;
      }
      buffer += line;
      bufferBytes += lineBytes;
      if (bufferBytes >= FLUSH_BYTES) flush();
    }
    flush();
    session.partRows += rows;
    session.rows += rows;
    syncManifest();
    return { ok: true, bytes: written, part: session.part, rotated: rotated };
  }

  function stop(reason) {
    if (!session) return null;
    closePart();
    session.active = false;
    session.manifest.endedAt = new Date().toISOString();
    session.manifest.rows = session.rows;
    session.manifest.durationMs = Date.now() - session.startedAtMs;
    session.manifest.stopReason = reason || '';
    writeManifest();
    const finished = {
      sessionId: session.id,
      dir: session.dir,
      rows: session.rows,
      bytes: session.bytes,
      parts: session.manifest.parts.slice()
    };
    lastFinished = finished;
    session = null;
    invalidateSize();
    prune();
    return finished;
  }

  function list() {
    return sessionDirs()
      .map(function (dir) {
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (err) {}
        let mtime = 0;
        try { mtime = fs.statSync(dir).mtimeMs; } catch (err) {}
        return { name: path.basename(dir), dir: dir, sizeBytes: dirSize(dir), mtime: mtime, manifest: manifest };
      })
      .sort(function (a, b) { return b.mtime - a.mtime; });
  }

  function clearAll() {
    stop('clear');
    let removed = 0;
    sessionDirs().forEach(function (dir) {
      const target = resolveInsideBase(dir);
      if (!target) return;
      try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch (err) {}
    });
    invalidateSize();
    return { removed: removed, totalBytes: totalSize(true) };
  }

  function configure(next) {
    if (!next) return { rotateMB: config.rotateMB, capGB: config.capGB };
    if (next.rotateMB != null) config.rotateMB = clampNumber(next.rotateMB, 1, 4096, DEFAULTS.rotateMB);
    if (next.capGB != null) config.capGB = clampNumber(next.capGB, 0.0625, 1024, DEFAULTS.capGB);
    return { rotateMB: config.rotateMB, capGB: config.capGB };
  }

  return {
    dir: baseDir,
    start: start,
    append: append,
    stop: stop,
    status: status,
    list: list,
    clearAll: clearAll,
    configure: configure,
    prune: prune
  };
}

module.exports = { createRecorder: createRecorder };
