#!/usr/bin/env node
'use strict';
/**
 * 性能基准（只测纯内存行为，不依赖浏览器）。
 *
 *   npm run bench
 *
 * 目前只有一项：通道历史的分块裁剪。
 * 原来每来一个采样点就 splice 一次，窗口 180k 点时每点要搬 18 万次引用；
 * 改成「超过窗口 + 2048 才裁一次」后，搬运次数摊薄 2048 倍。
 * 结果写进 .codex/docs/perf-baseline.md，作为以后改这块的对照。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHANNELS = 20;
const POINTS = 180000;
const SAMPLES = 200000;
const SLACK = 2048;

function perSample(channels, points, samples) {
  const data = new Array(CHANNELS);
  for (let i = 0; i < CHANNELS; i++) data[i] = [];
  const started = process.hrtime.bigint();
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < CHANNELS; c++) {
      const arr = data[c];
      arr.push(i);
      if (arr.length > points) arr.splice(0, arr.length - points);
    }
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function chunked(channels, points, samples) {
  const data = new Array(CHANNELS);
  for (let i = 0; i < CHANNELS; i++) data[i] = [];
  const started = process.hrtime.bigint();
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < CHANNELS; c++) {
      const arr = data[c];
      arr.push(i);
      if (arr.length > points + SLACK) arr.splice(0, arr.length - points);
    }
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function main() {
  // 预热：让 JIT 与被测路径都走到稳定状态
  perSample(CHANNELS, 5000, 2000);
  chunked(CHANNELS, 5000, 2000);

  const slow = perSample(CHANNELS, POINTS, SAMPLES);
  const fast = chunked(CHANNELS, POINTS, SAMPLES);
  const ratio = slow / fast;
  const rows = [
    '# 性能基线',
    '',
    '由 `npm run bench` 生成，机器相关，只用于同机对照。',
    '',
    '| 场景 | 耗时 |',
    '| --- | --- |',
    `| ${CHANNELS} 通道 × ${SAMPLES} 点，每点裁剪（旧行为） | ${slow.toFixed(1)} ms |`,
    `| 同上，分块裁剪（窗口 ${POINTS} + 余量 ${SLACK}） | ${fast.toFixed(1)} ms |`,
    '',
    `分块裁剪快 **${ratio.toFixed(1)}×**。代价：数组最多比逻辑窗口多 ${SLACK} 点，读路径按窗口取末尾不受影响。`,
    ''
  ];
  const out = path.join(ROOT, '.codex', 'docs', 'perf-baseline.md');
  fs.writeFileSync(out, rows.join('\n'), 'utf8');
  console.log(rows.join('\n'));
  console.log('已写入 ' + path.relative(ROOT, out));
}

main();
