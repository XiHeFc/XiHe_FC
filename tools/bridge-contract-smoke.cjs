#!/usr/bin/env node
'use strict';
/**
 * 本地桥 wire 层契约测试。
 *
 *   npm run test:bridge
 *
 * 为什么需要它：core-smoke 里的「MCP 看板」用例直接调浏览器执行体，绕过了 HTTP 与 ack，
 * 于是「ack 丢 data / 把 qid 当看板 id / 业务失败仍回 ok:true」这三类缺陷可以全绿地漏过去。
 * 这里起一个真 bridge 子进程，模拟浏览器应答，按 MCP 工具的返回体验收。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : ' → ' + detail));
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function call(port, method, target, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: target,
        method,
        headers: Object.assign({}, headers || {}, payload ? { 'Content-Length': payload.length } : {})
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { out += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const port = 18800 + Math.floor(Math.random() * 120);
  const token = 'contract-' + Date.now().toString(36);
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'bridge.mjs')], {
    env: Object.assign({}, process.env, {
      XHGCS_BRIDGE_PORT: String(port),
      XHGCS_BRIDGE_TOKEN: token,
      XHGCS_BRIDGE_QUEUE_WAIT_MS: '2500',
      // 契约测试覆盖写工具（看板补丁/回退）；默认只读会让写工具不出现在 tools/list 里。
      XHGCS_MCP_WRITE: '1'
    }),
    stdio: ['pipe', 'pipe', 'ignore']
  });
  // MCP stdio 也在同一个进程上跑：用 JSON-RPC 拿 tools/list（HTTP 的 /api/mcp 只有 callTool，没有列表）
  const stdioMessages = [];
  let stdioBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdioBuffer += chunk;
    let cut = stdioBuffer.indexOf('\n');
    while (cut >= 0) {
      const line = stdioBuffer.slice(0, cut).trim();
      stdioBuffer = stdioBuffer.slice(cut + 1);
      if (line) {
        try { stdioMessages.push(JSON.parse(line)); } catch (err) { /* 非 JSON 行忽略 */ }
      }
      cut = stdioBuffer.indexOf('\n');
    }
  });
  const H = { 'Content-Type': 'application/json', 'X-XHGCS-Token': token };
  const mcp = (name, args) => call(port, 'POST', '/api/mcp', H, JSON.stringify({ name, arguments: args || {} }));

  const findQueued = async (type) => {
    for (let i = 0; i < 40; i += 1) {
      const state = JSON.parse((await call(port, 'POST', '/api/state', H, '{}')).body);
      const queue = (state && state.remote && state.remote.queue) || [];
      const hit = queue.find((row) => row.type === type);
      if (hit) return hit;
      await pause(80);
    }
    return null;
  };

  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await call(port, 'GET', '/api/health')).status === 200; } catch (err) { /* 还没起来 */ }
      if (!ready) await pause(100);
    }
    check('桥能在超时内启动', ready, 'port ' + port);
    if (!ready) throw new Error('bridge not ready');

    const malformed = await call(port, 'GET', '//[');
    const afterMalformed = await call(port, 'GET', '/api/health');
    check('畸形 URL 返回 400，同一进程继续服务',
      malformed.status === 400 && JSON.parse(afterMalformed.body).pid === child.pid);
    const wrongBytes = await call(port, 'GET', '/api/state', {
      'X-XHGCS-Token': 'é' + token.slice(1)
    });
    check('等字符数、不同字节数的错误令牌返回 403', wrongBytes.status === 403);

    // 两个并发工具调用。先回第二个，重复和过期回执都不能覆盖第一份结果。
    const first = mcp('get_board', { id: 'first' });
    const firstItem = await findQueued('board_get');
    const second = mcp('list_boards', {});
    const secondItem = await findQueued('board_list');
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [secondItem.qid],
      results: [
        { id: '__proto__', ok: true },
        { id: secondItem.qid, ok: true, data: { marker: 'second' } },
        { id: secondItem.qid, ok: false, error: 'duplicate' }
      ]
    }));
    const secondResult = JSON.parse((await second).body).result;
    check('并发请求按 qid 接收首份回执', secondResult.applied && secondResult.marker === 'second');
    const timedOut = JSON.parse((await first).body).result;
    check('另一条未确认的请求超时后仍报告未应用', timedOut.applied === false && /没有回传/.test(timedOut.error));
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [firstItem.qid], results: [{ id: firstItem.qid, ok: true }]
    }));

    // 1) ack 的 data 必须原样回到工具结果里
    const listFlight = mcp('list_boards', {});
    const listItem = await findQueued('board_list');
    check('看板读操作进入队列', Boolean(listItem && listItem.qid), JSON.stringify(listItem || null));
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [listItem.qid],
      results: [{ id: listItem.qid, ok: true, error: '', data: { list: [{ id: 'b1', name: '主看板' }], active: { id: 'b1' } } }]
    }));
    const listed = JSON.parse((await listFlight).body).result;
    check(
      'ack 的 data 透传到工具返回（list_boards）',
      listed && listed.ok === true && Array.isArray(listed.list) && listed.list.length === 1,
      JSON.stringify(listed)
    );

    // 2) 看板 id 不能和队列 qid 混用
    const getFlight = mcp('get_board', { id: 'b1' });
    const getItem = await findQueued('board_get');
    check(
      '看板 id 走 boardId、与 qid 分离',
      Boolean(getItem && getItem.qid && getItem.boardId === 'b1' && getItem.qid !== getItem.boardId),
      JSON.stringify(getItem || null)
    );
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [getItem.qid],
      results: [{ id: getItem.qid, ok: true, error: '', data: { board: { id: 'b1', name: '主看板', widgets: [] } } }]
    }));
    const gotBoard = JSON.parse((await getFlight).body).result;
    check('get_board 返回真实看板结构', Boolean(gotBoard && gotBoard.board && gotBoard.board.id === 'b1'), JSON.stringify(gotBoard));

    // 3) 浏览器执行了但业务失败：不能报 ok:true
    const patchFlight = mcp('update_board', { ops: [{ op: 'remove', id: 'ghost' }], dry_run: false });
    const patchItem = await findQueued('board_patch');
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [patchItem.qid],
      results: [{ id: patchItem.qid, ok: true, error: '', data: { result: { ok: false, error: 'ops[0] 的控件不存在：ghost' } } }]
    }));
    const patched = JSON.parse((await patchFlight).body).result;
    check(
      '业务失败必须回报 ok:false',
      patched && patched.ok === false && /不存在/.test(String(patched.error || '')),
      JSON.stringify(patched)
    );

    // 4) dry_run 校验失败同样不能报成功
    const dryFlight = mcp('update_board', { ops: [{ op: 'remove', id: 'ghost' }] });
    const dryItem = await findQueued('board_patch');
    await call(port, 'POST', '/api/ack', H, JSON.stringify({
      ids: [dryItem.qid],
      results: [{ id: dryItem.qid, ok: true, error: '', data: { dryRun: true, preview: { ok: false, errors: ['ops[0] 的控件不存在：ghost'] } } }]
    }));
    const dry = JSON.parse((await dryFlight).body).result;
    check('dry_run 预检失败回报 ok:false', dry && dry.ok === false && /不存在/.test(String(dry.error || '')), JSON.stringify(dry));

    // 5) CORS/令牌：只认精确来源
    const fromDev = await call(port, 'GET', '/api/health', { Origin: 'http://localhost:5173' }, null);
    const devBody = JSON.parse(fromDev.body || '{}');
    check(
      '非白名单 localhost 端口既无 ACAO 也拿不到令牌',
      !fromDev.headers['access-control-allow-origin'] && !devBody.token,
      JSON.stringify({ acao: fromDev.headers['access-control-allow-origin'] || '', token: devBody.token || '' })
    );
    const fromApp = await call(port, 'GET', '/api/health', { Origin: 'http://127.0.0.1:8123' }, null);
    const appBody = JSON.parse(fromApp.body || '{}');
    check(
      '健康检查只回状态、不回令牌（应用来源同样）',
      fromApp.headers['access-control-allow-origin'] === 'http://127.0.0.1:8123'
        && appBody.ok === true && appBody.name === 'xhgcs' && !appBody.token,
      JSON.stringify({ acao: fromApp.headers['access-control-allow-origin'] || '', token: appBody.token ? 'present' : '', name: appBody.name || '' })
    );

    // 6) GET /api/state 不再匿名可读
    const anonymous = await call(port, 'GET', '/api/state', {}, null);
    check('GET /api/state 需要令牌', anonymous.status === 403, 'status ' + anonymous.status);

    // 7) dsh-stderr 状态机单测（P3'-补）。解析逻辑抽在 mcp-server/dsh-stderr.js，纯函数直接测。
    // fixture 是真实抓包：tests/fixtures/dsh-headless-stderr-real.log（出处/格式见同名 .md），
    // 回归只读字节、不改内容；上游格式变了改 fixture，不改解析器。
    // Windows 下 import() 只认 file:// URL，不能直接塞盘符绝对路径
    const dshStderr = await import(pathToFileURL(path.join(ROOT, 'mcp-server', 'dsh-stderr.js')).href);
    const stderrRealPath = path.join(ROOT, 'tests', 'fixtures', 'dsh-headless-stderr-real.log');
    const stderrReal = fs.readFileSync(stderrRealPath);
    const realText = stderrReal.toString('utf8');
    // 真实抓包去掉首行 header 和结尾空白后，就是应该被逐字节还原的进度正文
    const realExpected = realText.split('\n').slice(1).join('\n').replace(/\s+$/, '');
    const runChunks = (chunks, options) => {
      const progress = [];
      let truncatedCount = 0;
      const collector = dshStderr.createDshStderrCollector(Object.assign({
        onProgress: (text) => progress.push(text),
        onProgressTruncated: () => { truncatedCount += 1; }
      }, options || {}));
      chunks.forEach((chunk) => collector.feed(chunk));
      collector.flush();
      return {
        text: progress.join(''),
        truncated: truncatedCount,
        lines: collector.getLines(),
        tail: collector.getTail(),
        bytes: collector.getProgressBytes(),
        inReason: collector.isInReasonState()
      };
    };

    // a) header 只在首段出现一次；之后全是裸文本，整块喂也要全转发
    const whole = runChunks([stderrReal]);
    const headerLines = whole.lines.filter((line) => /^dsh:\s*reasoning:/i.test(line));
    const realFailure = dshStderr.extractDshFailure(whole.lines, 0, {});
    check(
      'dsh-stderr：真实抓包整块喂，header 只出现一次且裸文本全部转发',
      headerLines.length === 1
        && whole.text.indexOf('dsh: reasoning:') < 0
        && whole.text.indexOf('The user asks in Chinese') >= 0
        && whole.text.replace(/\s+$/, '') === realExpected
        && !/^reasoning$/.test(realFailure.error),
      JSON.stringify({ headers: headerLines.length, textLen: whole.text.length, expectedLen: realExpected.length, failure: realFailure.error.slice(0, 40) })
    );

    // b) 裸文本增量：无前缀、无换行，也要在 flush 之前就吐出进度
    const bareProgress = [];
    const bareCollector = dshStderr.createDshStderrCollector({ onProgress: (text) => bareProgress.push(text) });
    bareCollector.feed('dsh: reasoning:\n');
    bareCollector.feed('无前缀无换行的裸文本');
    const bareBeforeFlush = bareProgress.join('');
    bareCollector.flush();
    check(
      'dsh-stderr：裸文本无前缀无换行也能增量吐进度',
      bareBeforeFlush.length > 0 && bareProgress.join('') === '无前缀无换行的裸文本',
      JSON.stringify({ beforeFlush: bareBeforeFlush, afterFlush: bareProgress.join('') })
    );

    // c) 跨 chunk 截断：真实抓包按 1 字节切（覆盖 UTF-8 多字节被拆），
    //    再单独构造「\ndsh: 边界被拆到两次 chunk」的场景
    const oneByteChunks = [];
    for (let at = 0; at < stderrReal.length; at += 1) oneByteChunks.push(stderrReal.subarray(at, at + 1));
    const bytewise = runChunks(oneByteChunks);
    const edgeBytes = Buffer.from('dsh: reasoning:\n裸文本\n' + 'dsh: model-error: 模型不可用\n', 'utf8');
    const edgeChunks = [];
    for (let at = 0; at < edgeBytes.length; at += 1) edgeChunks.push(edgeBytes.subarray(at, at + 1));
    const edge = runChunks(edgeChunks);
    const edgeFailure = dshStderr.extractDshFailure(edge.lines, 1, {});
    check(
      'dsh-stderr：UTF-8 多字节与换行边界被拆到多次 chunk 也不丢',
      bytewise.text.replace(/\s+$/, '') === realExpected
        && edge.text.indexOf('裸文本') >= 0
        && edgeFailure.error === '模型不可用',
      JSON.stringify({ bytewiseLen: bytewise.text.length, edgeText: edge.text, edgeFailure: edgeFailure.error })
    );

    // d) 新旧格式混用：同一段 stderr 里既有带前缀行又有裸文本
    const mixed = runChunks([Buffer.from('dsh: reasoning: 第一段\n裸文本第二段\n' + 'dsh: reasoning: 第三段\n' + 'dsh: model-error: 模型不可用\n', 'utf8')]);
    check(
      'dsh-stderr：新旧格式混用（前缀行 + 裸文本）不串不乱',
      mixed.text.indexOf('第一段') >= 0
        && mixed.text.indexOf('裸文本第二段') >= 0
        && mixed.text.indexOf('第三段') >= 0
        && mixed.text.indexOf('reasoning') < 0,
      JSON.stringify({ text: mixed.text })
    );

    // e) 空行：进度态里的空行当进度；非进度态空行直接丢弃，不崩
    const emptyLines = runChunks([Buffer.from('dsh: reasoning:\n\n\n', 'utf8')]);
    check(
      'dsh-stderr：空行不崩、不产生伪进度',
      emptyLines.lines.length === 1 && emptyLines.text.trim() === '',
      JSON.stringify({ lines: emptyLines.lines.length, text: emptyLines.text })
    );

    // f) 超长单行：非进度行被 16KB 上限截断、进度被 32KB 上限截断（只发一次 truncated），都不挂
    const longLine = runChunks([Buffer.from('x'.repeat(40000) + '\n', 'utf8')]);
    const longProgress = runChunks([Buffer.from('dsh: reasoning:\n', 'utf8'), Buffer.from('y'.repeat(40000), 'utf8')]);
    check(
      'dsh-stderr：>16KB 单行与 >32KB 进度都被上限截断且只截断一次',
      longLine.lines.length === 1
        && longLine.tail.length <= 1200
        && longProgress.truncated === 1
        && longProgress.bytes <= 32 * 1024,
      JSON.stringify({ lineTail: longLine.tail.length, progressBytes: longProgress.bytes, truncated: longProgress.truncated })
    );

    // g) 反向兼容：旧格式每行都带「dsh: reasoning:」前缀（用户可能装别的 DSH 版本）
    const oldFormat = runChunks([Buffer.from('dsh: reasoning: 甲\n' + 'dsh: reasoning: 乙\n' + 'dsh: reasoning: 丙\n', 'utf8')]);
    check(
      'dsh-stderr：旧格式（每行都带前缀）反向兼容',
      oldFormat.text.indexOf('甲') >= 0 && oldFormat.text.indexOf('乙') >= 0 && oldFormat.text.indexOf('丙') >= 0,
      JSON.stringify({ text: oldFormat.text })
    );

    // h) 真实抓包按「非换行边界」7 字节切片回放（端到端切片策略与页面侧 fixture 同类）
    const sevenChunks = [];
    for (let at = 0; at < stderrReal.length; at += 7) sevenChunks.push(stderrReal.subarray(at, at + 7));
    const sliced = runChunks(sevenChunks);
    check(
      'dsh-stderr：真实抓包按 7 字节非换行切片回放，进度逐字节还原',
      sliced.text.replace(/\s+$/, '') === realExpected,
      JSON.stringify({ got: sliced.text.length, want: realExpected.length })
    );

    // 9) MCP 脚本 / 引擎的 update + delete（P3）：tools/list 暴露 + 全链路 + 安全边界
    const ackQueue = async (type) => {
      const item = await findQueued(type);
      if (!item) return null;
      await call(port, 'POST', '/api/ack', H, JSON.stringify({
        ids: [item.qid],
        results: [{ id: item.qid, ok: true, error: '', data: null }]
      }));
      return item;
    };

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    let toolNames = [];
    for (let i = 0; i < 50; i += 1) {
      const hit = stdioMessages.find((msg) => msg && msg.id === 2 && msg.result && Array.isArray(msg.result.tools));
      if (hit) { toolNames = hit.result.tools.map((tool) => tool.name); break; }
      await pause(100);
    }
    check(
      'tools/list 暴露 update_script / delete_script / update_engine / delete_engine',
      ['update_script', 'delete_script', 'update_engine', 'delete_engine'].every((name) => toolNames.indexOf(name) >= 0),
      JSON.stringify(toolNames)
    );

    // 全链路：create → update（id 不变、公式变、队列类型 script_updated）→ delete（script_deleted + 墓碑）
    const createdFlight = mcp('create_script', { name: '契约更新脚本', type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'] });
    const createItem = await ackQueue('script_created');
    const created = JSON.parse((await createdFlight).body).result || {};
    const scriptId = String((created.script || {}).id || '');
    check(
      'create_script 生成脚本并进入 script_created 队列',
      Boolean(createItem && createItem.script && createItem.script.id === scriptId && scriptId),
      JSON.stringify({ queueScriptId: createItem && createItem.script && createItem.script.id, createdScriptId: scriptId })
    );

    const updatedFlight = mcp('update_script', { id: scriptId, formula: 'rms(ch1)' });
    const updateItem = await ackQueue('script_updated');
    const updated = JSON.parse((await updatedFlight).body).result || {};
    check(
      'update_script 复用 id、改公式，并且走 script_updated 队列',
      Boolean(updateItem)
        && updateItem.script.id === scriptId
        && updateItem.script.formula === 'rms(ch1)'
        && (updated.script || {}).id === scriptId
        && (updated.script || {}).formula === 'rms(ch1)',
      JSON.stringify({ queue: updateItem && { id: updateItem.script && updateItem.script.id, formula: updateItem.script && updateItem.script.formula }, result: updated.script || updated })
    );

    const deletedFlight = mcp('delete_script', { id: scriptId });
    const deleteItem = await ackQueue('script_deleted');
    const deleted = JSON.parse((await deletedFlight).body).result || {};
    await call(port, 'POST', '/api/state', H, JSON.stringify({ snapshot: { deletedScripts: [scriptId] } }));
    const afterDelete = JSON.parse((await mcp('list_scripts', {})).body).result || {};
    const stillThere = (afterDelete.scripts || []).some((item) => item.id === scriptId);
    check(
      'delete_script 走 script_deleted 队列，带墓碑同步后 list_scripts 查不到',
      Boolean(deleteItem) && deleteItem.id === scriptId && deleted.ok === true && !stillThere,
      JSON.stringify({ queueId: deleteItem && deleteItem.id, deletedOk: deleted.ok, stillThere: stillThere })
    );

    // 浏览器侧推一条内置脚本上来：update / delete 都必须明确拒绝（不能假装成功）
    await call(port, 'POST', '/api/state', H, JSON.stringify({
      snapshot: { scripts: [{ id: 'builtin-probe', name: '内置探针脚本', builtin: true, type: 'functions', formula: 'mean(ch1)', inputs: ['ch1'], outputs: [{ id: 'out1', label: '均值' }] }] }
    }));
    // 工具层抛错时 HTTP 返回 {ok:false,error}（桥的错误通道），不是 result
    const builtinUpdate = JSON.parse((await mcp('update_script', { id: 'builtin-probe', formula: 'rms(ch1)' })).body);
    const builtinDelete = JSON.parse((await mcp('delete_script', { id: 'builtin-probe' })).body);
    check(
      '内置脚本 update / delete 都返回 ok:false 且原因可照做',
      builtinUpdate.ok === false && /内置/.test(String(builtinUpdate.error || ''))
        && builtinDelete.ok === false && /内置/.test(String(builtinDelete.error || '')),
      JSON.stringify({ update: builtinUpdate, delete: builtinDelete })
    );

    // 引擎：create → update（活动引擎带 active 标记）→ 活动引擎 delete 被拒
    const engineFlight = mcp('create_engine', { name: '契约活动引擎', preset: 'json', activate: true });
    const engineItem = await ackQueue('engine_created');
    const engineResult = JSON.parse((await engineFlight).body).result || {};
    const engineId = String((engineResult.engine || {}).id || (engineItem && engineItem.engine && engineItem.engine.id) || '');
    check(
      'create_engine 生成引擎并进入 engine_created 队列',
      Boolean(engineId && engineItem && engineItem.engine && engineItem.engine.id === engineId),
      JSON.stringify({ engineId: engineId })
    );

    const engineUpdateFlight = mcp('update_engine', { id: engineId, new_name: '契约活动引擎改', channelCount: 12 });
    const engineUpdateItem = await ackQueue('engine_updated');
    const engineUpdated = JSON.parse((await engineUpdateFlight).body).result || {};
    check(
      'update_engine 保留 id、可改名，活动引擎更新带 active 标记',
      Boolean(engineUpdateItem)
        && engineUpdateItem.engine.id === engineId
        && engineUpdateItem.engine.name === '契约活动引擎改'
        && engineUpdateItem.active === true
        && (engineUpdated.engine || {}).id === engineId,
      JSON.stringify({ queue: engineUpdateItem && { id: engineUpdateItem.engine.id, name: engineUpdateItem.engine.name, active: engineUpdateItem.active }, result: engineUpdated.engine || engineUpdated })
    );

    const activeDelete = JSON.parse((await mcp('delete_engine', { id: engineId })).body);
    check(
      '活动引擎 delete 被拒并提示先 set_active_engine',
      activeDelete.ok === false && /活动引擎/.test(String(activeDelete.error || '')) && /set_active_engine/.test(String(activeDelete.error || '')),
      JSON.stringify(activeDelete)
    );
  } finally {
    try { child.kill(); } catch (err) { /* ignore */ }
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  if (failed.length) {
    console.log(failed.length + ' 项未通过');
    process.exit(1);
  }
  console.log(results.length + ' 项全部通过');
}

main().catch((err) => {
  console.error('契约测试异常：' + (err && err.message ? err.message : err));
  process.exit(1);
});
