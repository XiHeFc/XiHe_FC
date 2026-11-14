'use strict';
// P1 AI 连接冒烟：启动器版本 / 诊断 / MCP stdio（initialize、tools/list、snapshot）
// 与应用没打开时如实跳过（退出码 0，但输出 SKIP），方便随时手动跑。
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'mcp-server', 'launcher.mjs');

function run(args) {
  return execFileSync(process.execPath, [LAUNCHER].concat(args || []), { cwd: ROOT, encoding: 'utf8' });
}

async function stdioProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, '--stdio'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const pending = new Map();
    let seq = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('stdio 超时（应用未运行或桥未启动）'));
    }, 12000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const waiter = pending.get(message.id);
          if (waiter) {
            pending.delete(message.id);
            waiter(message);
          }
        } catch (err) { /* 非协议输出忽略 */ }
      }
    });
    child.stderr.on('data', () => {});
    const call = (method, params) => new Promise((res) => {
      seq += 1;
      pending.set(seq, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: seq, method, params }) + '\n');
    });
    (async () => {
      const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xuanji-smoke', version: '0' } });
      const tools = await call('tools/list', {});
      let snapshot = null;
      if (tools.result && Array.isArray(tools.result.tools)) {
        snapshot = await call('tools/call', { name: 'snapshot', arguments: {} });
      }
      clearTimeout(timer);
      child.kill();
      resolve({ init, tools, snapshot });
    })().catch((err) => {
      clearTimeout(timer);
      child.kill();
      reject(err);
    });
  });
}

(async () => {
  const version = run(['--version']).trim();
  console.log('version:', version);
  if (!/^xuanji-mcp \d+\.\d+\.\d+/.test(version)) throw new Error('版本输出不符合预期');

  let doctor = null;
  try {
    doctor = JSON.parse(run(['--doctor']));
  } catch (err) {
    doctor = null;
  }
  if (!doctor || !doctor.ok) {
    console.log('SKIP: 应用未运行或实例未就绪 —— ' + ((doctor && doctor.error) || 'doctor 无输出'));
    console.log('doctor:', JSON.stringify(doctor));
    return;
  }
  console.log('doctor: ok', 'instance=' + doctor.app.instanceId.slice(0, 8), 'tools=' + doctor.tools.count, 'write=' + doctor.tools.write);

  const probe = await stdioProbe();
  if (!probe.init || !probe.init.result || !probe.init.result.serverInfo) throw new Error('initialize 无响应');
  const toolNames = (probe.tools.result && probe.tools.result.tools || []).map((item) => item.name);
  if (!toolNames.length) throw new Error('tools/list 为空');
  const snapshotText = probe.snapshot && probe.snapshot.result && probe.snapshot.result.content && probe.snapshot.result.content[0]
    ? String(probe.snapshot.result.content[0].text) : '';
  if (!snapshotText) throw new Error('snapshot 无返回');
  const parsed = JSON.parse(snapshotText);
  const raw = (parsed && parsed.state && parsed.state.raw) || [];
  console.log('stdio: server=' + probe.init.result.serverInfo.name, 'tools=' + toolNames.length, 'channels=' + raw.length);
  console.log('PASS');
})().catch((err) => {
  console.error('FAIL: ' + String((err && err.message) || err));
  process.exit(1);
});
