'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

/**
 * 静态服务。
 *
 * options.mounts：额外挂载点，例如 [{ url: '/ext', dir: 'C:\\...\\extensions' }]。
 * 每个挂载点都单独做 canonical path 检查 —— 用户插件目录与应用目录是两棵树，
 * 不能因为加了一个路由就让 `..` 逃逸到别处。
 */
function createStaticServer(rootDir, options) {
  const root = path.resolve(rootDir);
  const mounts = ((options && options.mounts) || [])
    .filter((mount) => mount && mount.url && mount.dir)
    .map((mount) => ({
      url: '/' + String(mount.url).replace(/^[/\\]+|[/\\]+$/g, ''),
      dir: path.resolve(mount.dir)
    }))
    .sort((a, b) => b.url.length - a.url.length);

  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let pathname = '/';
    let search = '';
    try {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      pathname = decodeURIComponent(parsed.pathname);
      search = parsed.search;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    let base = root;
    let relativePath = pathname;
    for (const mount of mounts) {
      if (pathname === mount.url || pathname.startsWith(mount.url + '/')) {
        base = mount.dir;
        relativePath = pathname.slice(mount.url.length) || '/';
        break;
      }
    }
    if (relativePath === '/' || relativePath === '') relativePath = '/index.html';
    const relative = relativePath.replace(/^[/\\]+/, '');
    const target = path.resolve(base, relative);
    if (target !== base && !target.startsWith(base + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    // 字符串前缀只挡住 ../；junction / symlink 会解析到根外，必须用 realpath 再判一次
    try {
      const realBase = fs.realpathSync(base);
      const realTarget = fs.realpathSync(target);
      if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
    } catch (err) {
      // 目标不存在时交给后面的 stat 走 404，不把路径细节暴露出去
    }

    let stat = null;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      stat = null;
    }

    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const versionedAsset = pathname.startsWith('/assets/') && /[?&]v=/.test(search);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(stat.size),
      'X-Content-Type-Options': 'nosniff'
    };
    if (versionedAsset) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function probeApp(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: '/index.html', timeout: timeoutMs || 1200 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          done(false);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) {
            response.destroy();
            done(body.indexOf('XiHe_GCS') >= 0);
          }
        });
        response.on('end', () => done(body.indexOf('XiHe_GCS') >= 0));
        response.on('error', () => done(false));
      }
    );
    request.on('timeout', () => {
      request.destroy();
      done(false);
    });
    request.on('error', () => done(false));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startStaticServer(rootDir, preferredPort, maxTries, options) {
  const tries = Math.max(1, maxTries || 8);
  // 复用只在开发模式允许：装机版必须自己起服务，否则本机任意进程占住 8123 就能冒充应用 UI
  if (!options || options.allowReuse !== false) {
    if (await probeApp(preferredPort)) {
      return { port: preferredPort, server: null, reused: true };
    }
  }
  for (let i = 0; i < tries; i++) {
    const port = preferredPort + i;
    const server = createStaticServer(rootDir, options);
    try {
      await listen(server, port);
      return { port, server, reused: false };
    } catch (err) {
      try {
        server.close();
      } catch (closeErr) {
        /* ignore */
      }
    }
  }
  throw new Error('无法启动本地静态服务（端口 ' + preferredPort + ' 起连续 ' + tries + ' 个端口均被占用）');
}

module.exports = { createStaticServer, startStaticServer, probeApp };
