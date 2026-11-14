/**
 * 设计器控件的绘图原语。
 *
 * 只依赖 Canvas 2D 与 CSS 变量，不碰任何全局状态 —— 这样同一套代码既能画在
 * 设计器画布里，也能画在 Kiosk 全屏看板和导出图里。
 */

export interface Theme {
  fg: string;
  dim: string;
  line: string;
  acc: string;
  warn: string;
  ok: string;
  danger: string;
  bg: string;
}

const FALLBACK: Theme = {
  fg: '#c9d4e0',
  dim: '#7d8896',
  line: '#2d333b',
  acc: '#6da8d2',
  warn: '#fbbf24',
  ok: '#34d399',
  danger: '#f87171',
  bg: '#161b22'
};

export function readTheme(el: HTMLElement | null): Theme {
  const base = el || document.body;
  const read = (name: string, fallback: string): string => {
    try {
      const value = getComputedStyle(base).getPropertyValue(name).trim();
      return value || fallback;
    } catch {
      return fallback;
    }
  };
  return {
    fg: read('--text', FALLBACK.fg),
    dim: read('--text-dim', FALLBACK.dim),
    line: read('--line', FALLBACK.line),
    acc: read('--acc', FALLBACK.acc),
    warn: read('--warn', FALLBACK.warn),
    ok: read('--ok', FALLBACK.ok),
    danger: read('--danger', FALLBACK.danger),
    bg: read('--bg2', FALLBACK.bg)
  };
}

export interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
}

/** 按容器尺寸与设备像素比重建画布，返回逻辑坐标系。 */
export function fitCanvas(canvas: HTMLCanvasElement, host: HTMLElement): Frame | null {
  const width = Math.max(1, Math.floor(host.clientWidth));
  const height = Math.max(1, Math.floor(host.clientHeight));
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height, dpr };
}

export interface Series {
  label: string;
  color: string;
  unit?: string;
  values: number[];
}

const INSET = { left: 34, right: 10, top: 12, bottom: 18 };

interface LaneKit {
  laneDomain: (channels: Array<{ data: number[] }>, opts?: { targetTicks?: number }) => { yMin: number; yMax: number; ticks: number[]; step: number } | null;
  laneYOf: (value: number, geo: { top: number; h: number; yMin: number; yMax: number }) => number;
  laneGapFor: (laneCount: number, plotH: number) => number;
  niceTicks: (min: number, max: number, target: number) => number[];
  tickStep: (span: number, target: number) => number;
}

function laneKit(): LaneKit | null {
  // P1 lane kit 的唯一实现放在 views-chart.js，运行时取；拿不到就回退原单轴逻辑
  const views = (window as unknown as { XHGCS_VIEWS?: { chartLaneKit?: LaneKit } }).XHGCS_VIEWS;
  const kit = views && views.chartLaneKit;
  if (!kit) return null;
  if (typeof kit.laneDomain !== 'function' || typeof kit.laneYOf !== 'function' || typeof kit.laneGapFor !== 'function') return null;
  return kit;
}

function drawLaneChart(
  frame: Frame,
  list: Series[],
  theme: Theme,
  opts: { normalize?: boolean; grid?: boolean; fill?: boolean },
  plot: { x: number; y: number; w: number; h: number },
  kit: LaneKit
): void {
  const { ctx } = frame;
  const count = list.length;
  const gap = Math.max(0, Number(kit.laneGapFor(count, plot.h)) || 0);
  const laneH = (plot.h - gap * (count - 1)) / count;
  if (!(laneH > 4)) {
    // 极端小图：lane 高度不够可读时退回单轴，保证内容不消失
    drawSingleAxis(frame, list, theme, opts, plot);
    return;
  }
  const lanes = list.map((item, index) => {
    const values = opts.normalize ? normalizeValues(item.values) : item.values;
    const fallback = (() => {
      const range = valueRange([{ ...item, values }], false);
      const ticks = niceTicks(range.min, range.max, 4);
      return { yMin: range.min, yMax: range.max, ticks, step: ticks.length > 1 ? ticks[1] - ticks[0] : 1 };
    })();
    const domain: { yMin: number; yMax: number; ticks: number[]; step: number } = kit.laneDomain([{ data: values }], { targetTicks: 4 }) || fallback;
    const top = plot.y + index * (laneH + gap);
    return { item, values, domain, top, bot: top + laneH };
  });
  lanes.forEach((lane) => {
    const yOf = (value: number) => kit.laneYOf(value, { top: lane.top, h: laneH, yMin: lane.domain.yMin, yMax: lane.domain.yMax });
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, lane.top, plot.w, laneH);
    ctx.clip();

    // 网格只画在本 lane 内
    if (opts.grid !== false) {
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      lane.domain.ticks.forEach((tick) => {
        const y = Math.round(yOf(tick)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    // 曲线沿用现有颜色与 1.6px；填充限制在本 lane 底部
    if (lane.values.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < lane.values.length; i++) {
        const x = plot.x + (i / (lane.values.length - 1)) * plot.w;
        const y = yOf(lane.values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = lane.item.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (opts.fill !== false) {
        ctx.lineTo(plot.x + plot.w, lane.bot);
        ctx.lineTo(plot.x, lane.bot);
        ctx.closePath();
        const alpha = count > 1 ? 0.1 : 0.22;
        const gradient = ctx.createLinearGradient(0, lane.top, 0, lane.bot);
        gradient.addColorStop(0, hexToRgba(lane.item.color, alpha));
        gradient.addColorStop(1, hexToRgba(lane.item.color, 0));
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    }
    ctx.restore();

    // 刻度数字在 clip 之外绘制（左侧槽，右对齐贴 lane 左边），每 lane 都有
    ctx.fillStyle = theme.dim;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    lane.domain.ticks.forEach((tick) => {
      // 中线对齐的 10px 文字必须 clamp 在 lane 内，避免顶/底刻度伸进 gap
      const ty = Math.max(lane.top + 7, Math.min(lane.bot - 7, yOf(tick)));
      ctx.fillText(fmtTick(tick), plot.x - 6, ty);
    });

    // 每 lane 顶部：通道名 + 单位（11px），不另画图例
    const label = lane.item.unit ? lane.item.label + ' ' + lane.item.unit : lane.item.label;
    const text = label.length > 18 ? label.slice(0, 17) + '…' : label;
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = lane.item.color;
    ctx.fillRect(plot.x + 2, lane.top + 4, 6, 3);
    ctx.fillStyle = theme.dim;
    ctx.fillText(text, plot.x + 12, lane.top + 1);
  });
}

function drawSingleAxis(
  frame: Frame,
  list: Series[],
  theme: Theme,
  opts: { normalize?: boolean; grid?: boolean; fill?: boolean },
  plot: { x: number; y: number; w: number; h: number }
): void {
  const { ctx, width } = frame;
  const range = valueRange(list, Boolean(opts.normalize));
  const span = range.max - range.min || 1;
  const project = (value: number) => plot.y + plot.h - ((value - range.min) / span) * plot.h;
  if (opts.grid !== false) {
    ctx.strokeStyle = theme.line;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    const ticks = niceTicks(range.min, range.max, 4);
    ticks.forEach((tick) => {
      const y = Math.round(project(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.dim;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach((tick) => ctx.fillText(fmtTick(tick), plot.x - 6, project(tick)));
  }
  list.forEach((item) => {
    const values = opts.normalize ? normalizeValues(item.values) : item.values;
    const n = values.length;
    if (n < 2) return;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = plot.x + (i / (n - 1)) * plot.w;
      const y = project(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (opts.fill !== false) {
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
      ctx.lineTo(plot.x, plot.y + plot.h);
      ctx.closePath();
      const alpha = list.length > 1 ? 0.1 : 0.22;
      const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
      gradient.addColorStop(0, hexToRgba(item.color, alpha));
      gradient.addColorStop(1, hexToRgba(item.color, 0));
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  });
  if (list.length > 1) {
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let x = plot.x + 2;
    const y = 2;
    for (const item of list) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y + 3, 6, 3);
      x += 9;
      ctx.fillStyle = theme.dim;
      const label = item.label.length > 10 ? item.label.slice(0, 9) + '…' : item.label;
      ctx.fillText(label, x, y);
      x += ctx.measureText(label).width + 10;
      if (x > width - 40) break;
    }
  }
}


function valueRange(series: Series[], normalize: boolean): { min: number; max: number } {
  if (normalize) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const value of item.values) {
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max - min < 1e-9) {
    const pad = Math.abs(max) * 0.1 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const step = (max - min) / Math.max(1, count);
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

function fmtTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return (value / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  if (abs === 0) return '0';
  return value.toFixed(2);
}

export function drawEmpty(frame: Frame, theme: Theme, message: string): void {
  const { ctx, width, height } = frame;
  ctx.fillStyle = theme.dim;
  ctx.font = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

export function drawLineChart(frame: Frame, series: Series[], theme: Theme, opts: { normalize?: boolean; grid?: boolean; fill?: boolean } = {}): void {
  const { ctx, width, height } = frame;
  const list = series.filter((item) => item.values.length);
  if (!list.length) {
    drawEmpty(frame, theme, '未绑定通道');
    return;
  }
  const plot = {
    x: INSET.left,
    y: INSET.top,
    w: Math.max(10, width - INSET.left - INSET.right),
    h: Math.max(10, height - INSET.top - INSET.bottom)
  };
  const kit = list.length > 1 ? laneKit() : null;
  if (kit) {
    drawLaneChart(frame, list, theme, opts, plot, kit);
    return;
  }
  const range = valueRange(list, Boolean(opts.normalize));
  const span = range.max - range.min || 1;
  const project = (value: number) => plot.y + plot.h - ((value - range.min) / span) * plot.h;

  // 网格与刻度
  if (opts.grid !== false) {
    ctx.strokeStyle = theme.line;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    const ticks = niceTicks(range.min, range.max, 4);
    ticks.forEach((tick) => {
      const y = Math.round(project(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.dim;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach((tick) => ctx.fillText(fmtTick(tick), plot.x - 6, project(tick)));
  }

  // 曲线
  list.forEach((item) => {
    const values = opts.normalize ? normalizeValues(item.values) : item.values;
    const count = values.length;
    if (count < 2) return;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = plot.x + (i / (count - 1)) * plot.w;
      const y = project(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (opts.fill !== false) {
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
      ctx.lineTo(plot.x, plot.y + plot.h);
      ctx.closePath();
      // 多序列时叠三层 22% 的填充会糊成一片，按序列数衰减
      const alpha = list.length > 1 ? 0.1 : 0.22;
      const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
      gradient.addColorStop(0, hexToRgba(item.color, alpha));
      gradient.addColorStop(1, hexToRgba(item.color, 0));
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  });

  // 图例
  if (list.length > 1) {
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let x = plot.x + 2;
    const y = 2;
    for (const item of list) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y + 3, 6, 3);
      x += 9;
      ctx.fillStyle = theme.dim;
      const label = item.label.length > 10 ? item.label.slice(0, 9) + '…' : item.label;
      ctx.fillText(label, x, y);
      x += ctx.measureText(label).width + 10;
      if (x > width - 40) break;
    }
  }
}

function normalizeValues(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((value) => (value - min) / span);
}

export function hexToRgba(color: string, alpha: number): string {
  const text = String(color || '').trim();
  if (text.startsWith('#')) {
    const hex = text.length === 4 ? text.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : text;
    const value = Number.parseInt(hex.slice(1), 16);
    if (Number.isFinite(value)) {
      const r = (value >> 16) & 255;
      const g = (value >> 8) & 255;
      const b = value & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return text;
}

export function drawGauge(frame: Frame, value: number, opts: { min?: number; max?: number; unit?: string; label?: string }, theme: Theme): void {
  const { ctx, width, height } = frame;
  if (!Number.isFinite(value)) {
    drawEmpty(frame, theme, '未绑定通道');
    return;
  }
  const min = Number(opts.min ?? 0);
  const max = Number(opts.max ?? 100) || 1;
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  const cx = width / 2;
  const cy = height * 0.62;
  const radius = Math.max(18, Math.min(width, height * 1.6) * 0.34);
  const start = Math.PI * 0.75;
  const end = Math.PI * 2.25;

  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(6, radius * 0.16);
  ctx.strokeStyle = theme.line;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end);
  ctx.stroke();

  const tone = ratio > 0.85 ? theme.danger : ratio > 0.65 ? theme.warn : theme.ok;
  ctx.strokeStyle = tone;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, start + (end - start) * ratio);
  ctx.stroke();

  ctx.fillStyle = theme.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.min(32, Math.max(14, Math.round(radius * 0.52)))}px "Segoe UI", system-ui, sans-serif`;
  const text = Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(3);
  ctx.fillText(text + (opts.unit ? ' ' + opts.unit : ''), cx, cy);

  ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = theme.dim;
  ctx.fillText(opts.label || '', cx, cy + radius * 0.5);
}

export function drawBars(frame: Frame, items: Array<{ label: string; value: number; color: string }>, theme: Theme, opts: { min?: number; max?: number } = {}): void {
  const { ctx, width, height } = frame;
  if (!items.length) {
    drawEmpty(frame, theme, '未绑定通道');
    return;
  }
  const left = 8;
  const right = 8;
  const bottom = 20;
  const top = 10;
  const slot = (width - left - right) / items.length;
  const barWidth = Math.max(6, Math.min(34, slot * 0.55));
  const min = Number(opts.min ?? 0);
  const max = Number(opts.max ?? Math.max(...items.map((item) => Math.abs(item.value)), 1));
  const span = max - min || 1;
  const baseY = height - bottom;
  const usable = Math.max(10, baseY - top);

  ctx.font = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  items.forEach((item, index) => {
    const ratio = Math.max(0, Math.min(1, (item.value - min) / span));
    const barHeight = Math.max(2, ratio * usable);
    const cx = left + slot * index + slot / 2;
    const x = cx - barWidth / 2;
    ctx.fillStyle = hexToRgba(item.color, 0.85);
    roundRect(ctx, x, baseY - barHeight, barWidth, barHeight, Math.min(4, barWidth / 2));
    ctx.fill();

    ctx.fillStyle = theme.dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = item.label.length > 6 ? item.label.slice(0, 5) + '…' : item.label;
    ctx.fillText(label, cx, baseY + 4);
  });
}

export function drawDonut(frame: Frame, items: Array<{ label: string; value: number; color: string }>, theme: Theme): void {
  const { ctx, width, height } = frame;
  const list = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  if (!list.length) {
    drawEmpty(frame, theme, '未绑定通道');
    return;
  }
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(16, Math.min(width, height) * 0.34);
  const inner = radius * 0.62;
  const total = list.reduce((sum, item) => sum + item.value, 0);
  let angle = -Math.PI / 2;
  list.forEach((item) => {
    const slice = (item.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    angle += slice;
  });
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = theme.bg;
  ctx.fill();
  ctx.fillStyle = theme.dim;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(list.length + ' 项', cx, cy);
}

export function drawTable(
  frame: Frame,
  rows: Array<{ name: string; value: string; unit?: string; color: string }>,
  theme: Theme
): void {
  const { ctx, width, height } = frame;
  if (!rows.length) {
    drawEmpty(frame, theme, '未绑定通道');
    return;
  }
  const header = 16;
  // 行高跟容器走：大屏看板上固定 20px 会让表格缩在顶部一小条
  const rowHeight = Math.max(18, (height - header - 6) / rows.length);
  const maxRows = Math.max(1, Math.floor((height - header) / rowHeight));
  const visible = rows.slice(0, maxRows);
  const fontSize = Math.max(11, Math.min(15, rowHeight * 0.58));
  ctx.font = `${fontSize}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  visible.forEach((row, index) => {
    const y = header + index * rowHeight;
    if (index % 2 === 0) {
      ctx.fillStyle = hexToRgba(theme.fg, 0.04);
      ctx.fillRect(4, y, width - 8, rowHeight);
    }
    ctx.fillStyle = row.color;
    ctx.fillRect(8, y + rowHeight / 2 - 3, 6, 6);
    ctx.fillStyle = theme.fg;
    ctx.textAlign = 'left';
    ctx.fillText(row.name.length > 14 ? row.name.slice(0, 13) + '…' : row.name, 20, y + rowHeight / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.dim;
    ctx.fillText(row.value + (row.unit ? ' ' + row.unit : ''), width - 10, y + rowHeight / 2);
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export { niceTicks, fmtTick };
