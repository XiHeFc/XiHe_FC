'use strict';
// 打桩 DSH：桥用 process.execPath 启动 XHGCS_DSH_BIN 指向的脚本，所以它就是个普通 node 脚本。
// 用途：让「失败真因 / 取消杀进程树 / SSE 进度」三条验收不依赖真模型、真密钥和真 @deepseek-ai/dsh。
// 触发方式：任务文本里带 fake:<mode>（桥把任务作为最后一个参数传进来）。
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.indexOf('--version') >= 0) {
  process.stdout.write('0.1.5\n');
  process.exit(0);
}

const task = String(args[args.length - 1] || '');
// agent 模式的 task 会带上历史消息：旧轮次的 fake:sleep 也会出现在里面，
// 所以按「最后出现的标记」选模式，保证当前这一轮说了算。
// 注意：'stream-real' 必须排在 'stream' 前面——lastIndexOf('fake:stream') 会在
// 'fake:stream-real' 里命中同一个位置，先匹配到更具体的模式才不会被抢走。
const MODES = ['fail', 'sleep', 'stream-real', 'stream', 'quick'];
let mode = '';
let modeAt = -1;
MODES.forEach((name) => {
  const at = task.lastIndexOf('fake:' + name);
  if (at > modeAt) { modeAt = at; mode = name; }
});
const pick = (name) => mode === name;

// A：失败时把真因写进 stderr（模拟 headless 的 dsh: <code>: <message>），退出码只有 1
if (pick('fail')) {
  process.stderr.write('dsh: reasoning: 正在思考这个问题\n');
  process.stderr.write('dsh: model-error: 模型不可用\n');
  process.exit(1);
}

// B：长跑，把 pid 写出来给测试断言「进程树真的被杀掉」
if (pick('sleep')) {
  const pidFile = String(process.env.XHGCS_FAKE_DSH_PIDFILE || '');
  if (pidFile) {
    try { fs.writeFileSync(pidFile, String(process.pid), 'utf8'); } catch (err) { /* 测试没给文件就不写 */ }
  }
  process.stderr.write('dsh: reasoning: 长任务开始\n');
  setInterval(() => {}, 1000);
  return;
}

// C-real：回放真实抓包（tests/fixtures/dsh-headless-stderr-real.log + 对应 stdout）。
// 出处与格式说明见同目录 dsh-headless-stderr.md；这里只读字节，不手写进度内容，
// 按非换行边界切片 + 间隔写，模拟上游「一次头 + 裸文本增量」的真实到达方式。
if (pick('stream-real')) {
  const dir = __dirname;
  const stderrBytes = fs.readFileSync(path.join(dir, 'dsh-headless-stderr-real.log'));
  const stdoutBytes = fs.readFileSync(path.join(dir, 'dsh-headless-stdout-real.log'));
  const chunks = [];
  const SLICE = 37; // 故意不落在换行边界，覆盖跨行/跨多字节切片
  for (let at = 0; at < stderrBytes.length; at += SLICE) chunks.push(stderrBytes.subarray(at, at + SLICE));
  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      process.stderr.write(chunks[index]);
      index += 1;
      return;
    }
    clearInterval(timer);
    process.stdout.write(stdoutBytes);
    process.exit(0);
  }, 45);
  return;
}

// C-line：旧的行格式（每段都带 dsh: reasoning: 前缀）——两种格式都要兼容
if (pick('stream')) {
  const chunks = ['读取通道数据', '计算均值', '整理结论'];
  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      process.stderr.write('dsh: reasoning: ' + chunks[index] + '\n');
      index += 1;
      return;
    }
    clearInterval(timer);
    process.stdout.write('最终答案：均值 3.21\n');
    process.exit(0);
  }, 120);
  return;
}

// 默认：快速回显，用来验证「取消后 2 秒内还能再问」
process.stdout.write('echo: ' + task + '\n');
process.exit(0);