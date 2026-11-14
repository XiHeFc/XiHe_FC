// 字节安全解码：`text += chunk` 会让每个 TCP 分块各自解一次 UTF-8，
// 汉字正好被切在分块边界上时就会解成 U+FFFD（三个字节 → 一到三个替换字符）。
// 桥的 POST body 里装的是整份浏览器配置，一旦中标，乱码会经 /api/state 回灌、
// 被 persist() 写进 localStorage，从此粘在组件名/描述/端口名上（实测复现过）。
// 所以这里统一「先收字节、最后一次性解码」。

const DEFAULT_LIMIT = 5e6;

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
}

// 读 HTTP 请求体：超过上限直接 reject 并断开，和旧行为一致（旧代码用字符数近似字节数）
export function readRequestBody(req, limitBytes) {
  const max = Number(limitBytes) > 0 ? Number(limitBytes) : DEFAULT_LIMIT;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      const buf = toBuffer(chunk);
      size += buf.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!over) reject(err); });
  });
}

// 收子进程的 stdout/stderr：Python 统计结果、PowerShell 端点列表里也有中文，
// 同样不能逐块 toString()。超限只截断不报错，调用方按 text() 取结果。
export function captureStream(stream, limitBytes) {
  const max = Number(limitBytes) > 0 ? Number(limitBytes) : DEFAULT_LIMIT;
  const chunks = [];
  let size = 0;
  stream.on('data', (chunk) => {
    if (size >= max) return;
    const buf = toBuffer(chunk);
    const room = max - size;
    chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
    size += Math.min(buf.length, room);
  });
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    size: () => size,
    truncated: () => size >= max
  };
}
