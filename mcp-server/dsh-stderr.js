// DSH headless 的 stderr 解析（纯 ESM、无副作用、无 IO，便于单测）。
//
// 真实格式见 tests/fixtures/dsh-headless-stderr.md：首段只写一次「dsh: reasoning:\n」头，
// 之后是裸文本增量（无前缀、通常无换行、含中文多字节与内部换行），末尾补一个换行；
// 非进度行是结构化日志（失败真因形如「dsh: <code>: <message>」）。
// 所以「按整行 ^dsh:\s*reasoning: 识别」是错的：进进度态后任何字节都算进度，
// 直到出现新的结构化行（换行 + dsh:，或行首 dsh:，兼容别的 DSH 版本每行都带前缀的写法）。
import { StringDecoder } from 'node:string_decoder';

export const DSH_STDERR_LINES = 60;
export const DSH_STDERR_BYTES = 16 * 1024;
export const DSH_STDERR_TAIL = 1200;
export const DSH_PROGRESS_BYTES = 32 * 1024;

const REASON_HEADER = /^dsh:\s*reasoning:?\s?(.*)$/i;
const STRUCTURED_LINE = /^dsh:\s*([A-Za-z][\w-]*):\s*(.+)$/;

export function createDshStderrCollector(options) {
  const opts = options || {};
  // StringDecoder 保证「UTF-8 多字节字符被拆到两次 chunk」时不会产出替换字符
  const decoder = new StringDecoder('utf8');
  const maxLines = Math.max(1, Number(opts.maxLines) || DSH_STDERR_LINES);
  const maxBytes = Math.max(64, Number(opts.maxBytes) || DSH_STDERR_BYTES);
  const maxProgressBytes = Math.max(16, Number(opts.maxProgressBytes) || DSH_PROGRESS_BYTES);
  const lines = [];
  let bytes = 0;
  let buffer = '';
  let reasonState = false;
  let progressBytes = 0;
  let progressStopped = false;
  let finished = false;

  const emitProgress = (text) => {
    if (!text || typeof opts.onProgress !== 'function' || progressStopped) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (progressBytes + size > maxProgressBytes) {
      progressStopped = true;
      if (typeof opts.onProgressTruncated === 'function') opts.onProgressTruncated();
      return;
    }
    progressBytes += size;
    opts.onProgress(text);
  };
  const pushLine = (line) => {
    if (!line || !line.trim()) return;
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    lines.push(line);
    while (lines.length > maxLines) bytes -= Buffer.byteLength(lines.shift(), 'utf8') + 1;
    while (bytes > maxBytes && lines.length > 1) bytes -= Buffer.byteLength(lines.shift(), 'utf8') + 1;
  };
  const trimReasonChunk = (text) => String(text || '').replace(/\r+$/, '');
  const processBuffer = () => {
    while (buffer) {
      if (!reasonState) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          // 结构化行还没收全（可能跨 chunk）：留住但别让异常输入撑爆内存
          if (buffer.length > maxBytes) buffer = buffer.slice(-maxBytes);
          return;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const header = REASON_HEADER.exec(line);
        pushLine(line);
        if (header) {
          reasonState = true;
          if (header[1]) emitProgress(header[1]);
        }
        continue;
      }
      // 进度态：行首直接是 dsh:（老格式每段带前缀）→ 退出进度态
      if (buffer.indexOf('dsh:') === 0) {
        reasonState = false;
        continue;
      }
      // 进度态：出现「换行 + dsh:」→ 前面的裸文本是进度，后面的交给结构化解析
      const boundary = buffer.indexOf('\ndsh:');
      if (boundary >= 0) {
        emitProgress(trimReasonChunk(buffer.slice(0, boundary)));
        buffer = buffer.slice(boundary + 1);
        reasonState = false;
        continue;
      }
      // 还没到边界：保留最后 4 个字符（跨 chunk 的 "\ndsh:" 检测），其余增量转发
      if (buffer.length <= 4) return;
      const cut = buffer.length - 4;
      emitProgress(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      return;
    }
  };

  return {
    feed(chunk) {
      if (chunk == null || finished) return;
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (!text) return;
      buffer += text;
      if (buffer.length > maxBytes * 4) buffer = buffer.slice(-maxBytes);
      processBuffer();
    },
    // close / 取消时调用：进度态残留的裸文本作为最后一段进度转发；结构化行残留收尾。
    flush() {
      if (finished) return;
      finished = true;
      const rest = decoder.end();
      if (rest) { buffer += rest; processBuffer(); }
      if (reasonState) {
        emitProgress(trimReasonChunk(buffer));
        buffer = '';
        reasonState = false;
        return;
      }
      if (buffer.trim()) pushLine(buffer);
      buffer = '';
    },
    getLines() { return lines.slice(); },
    getTail() { return lines.join('\n').slice(-DSH_STDERR_TAIL); },
    getProgressBytes() { return progressBytes; },
    getProgressTruncated() { return progressStopped; },
    isInReasonState() { return reasonState; }
  };
}

// 真因优先：最后一条「dsh: <code>: <message>」（reasoning 除外），再退最后一条非空行，
// 最后才用退出码。timedOut 给超时文案。返回 { error, stderrTail }。
export function extractDshFailure(lines, code, options) {
  const opts = options || {};
  const stderrTail = (lines || []).join('\n').slice(-DSH_STDERR_TAIL);
  const rows = (lines || []).slice().reverse();
  for (const row of rows) {
    const hit = STRUCTURED_LINE.exec(String(row).trim());
    if (hit && String(hit[1]).toLowerCase() !== 'reasoning') return { error: hit[2].trim(), stderrTail };
  }
  if (opts.timedOut) {
    return { error: 'DSH 超时（' + Math.round((Number(opts.timeoutMs) || 0) / 1000) + 's）', stderrTail };
  }
  const lastLine = rows.map((row) => String(row).trim()).find(Boolean);
  if (lastLine) return { error: lastLine, stderrTail };
  return { error: 'DSH 退出码 ' + code, stderrTail };
}
