/**
 * 内置控件库。
 *
 * 每个控件 = 一份属性 schema + 一个创建函数。控件**不认识通道**：
 * 它只向 `series()` 要数据，由绑定解析器决定“这一格画谁”。
 * 这样同一份控件既能被设计器用，也能被 Kiosk 看板用，还能被插件替换。
 */
import {
  drawBars,
  drawDonut,
  drawEmpty,
  drawGauge,
  drawLineChart,
  drawTable,
  fitCanvas,
  readTheme,
  type Frame,
  type Theme
} from './plot';
import { latestValue, tail, type SeriesPoint } from './data-access';

export interface PropSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  group?: string;
  help?: string;
}

export interface WidgetInstance {
  render(): void;
  resize(): void;
  setProps(props: Record<string, unknown>): void;
  dispose(): void;
}

export type SeriesResolver = () => SeriesPoint[];

export interface WidgetCreateContext {
  el: HTMLElement;
  props: Record<string, unknown>;
  series: SeriesResolver;
}

export interface WidgetDef {
  type: string;
  label: string;
  icon: string;
  group: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaults: Record<string, unknown>;
  propSchema: PropSpec[];
  create(ctx: WidgetCreateContext): WidgetInstance;
}

/** 所有画布控件共用的脚手架：对齐 dpr、按需重画、释放监听。 */
function createCanvasWidget(
  el: HTMLElement,
  draw: (frame: Frame, theme: Theme, props: Record<string, unknown>, series: SeriesPoint[]) => void,
  series: SeriesResolver
): WidgetInstance {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  el.appendChild(canvas);
  let props: Record<string, unknown> = {};
  let observer: ResizeObserver | null = null;

  const paint = () => {
    if (!el.clientWidth || !el.clientHeight) return;
    const frame = fitCanvas(canvas, el);
    if (!frame) return;
    const theme = readTheme(el);
    if (frame.width < 12 || frame.height < 12) {
      drawEmpty(frame, theme, '空间太小');
      return;
    }
    let data: SeriesPoint[] = [];
    try {
      data = series() || [];
    } catch (err) {
      console.warn('[XHGCS_CORE] 绑定解析失败', err);
    }
    draw(frame, theme, props, data);
  };

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => paint());
    observer.observe(el);
  }
  window.setTimeout(paint, 0);

  return {
    render: paint,
    resize: paint,
    setProps(next) {
      props = next || {};
      paint();
    },
    dispose() {
      observer?.disconnect();
      observer = null;
      el.replaceChildren();
    }
  };
}

export const BUILTIN_WIDGETS: WidgetDef[] = [
  {
    type: 'widget.scope',
    label: '折线示波',
    icon: '≋',
    group: '图表',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    defaults: { points: 160, normalize: false, grid: true, fill: true },
    propSchema: [
      { key: 'points', label: '采样点数', type: 'number', min: 10, max: 2000, step: 10, group: '数据' },
      { key: 'normalize', label: '归一化 Y 轴', type: 'boolean', group: '坐标' },
      { key: 'grid', label: '显示网格', type: 'boolean', group: '坐标' },
      { key: 'fill', label: '曲线填充', type: 'boolean', group: '样式' }
    ],
    create({ el, props, series }) {
      const instance = createCanvasWidget(
        el,
        (frame, theme, current, data) => {
          const count = Number(current.points) || 160;
          const list = data.map((item) => ({ label: item.label, color: item.color, unit: item.unit, values: tail(item.values, count) }));
          drawLineChart(frame, list, theme, {
            normalize: Boolean(current.normalize),
            grid: current.grid !== false,
            fill: current.fill !== false
          });
        },
        series
      );
      instance.setProps(props);
      return instance;
    }
  },
  {
    type: 'widget.gauge',
    label: '仪表盘',
    icon: '◔',
    group: '图表',
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 2 },
    defaults: { min: 0, max: 100 },
    propSchema: [
      { key: 'min', label: '量程下限', type: 'number', step: 1, group: '量程' },
      { key: 'max', label: '量程上限', type: 'number', step: 1, group: '量程' }
    ],
    create({ el, props, series }) {
      const instance = createCanvasWidget(
        el,
        (frame, theme, current, data) => {
          const first = data[0];
          if (!first) {
            drawEmpty(frame, theme, '未绑定通道');
            return;
          }
          drawGauge(
            frame,
            latestValue(first.values),
            { min: Number(current.min) || 0, max: Number(current.max) || 100, unit: first.unit, label: first.label },
            theme
          );
        },
        series
      );
      instance.setProps(props);
      return instance;
    }
  },
  {
    type: 'widget.bars',
    label: '柱状对比',
    icon: '▥',
    group: '图表',
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 2 },
    defaults: { max: 0 },
    propSchema: [{ key: 'max', label: 'Y 轴上限', type: 'number', step: 1, help: '0 表示自动取当前最大值', group: '坐标' }],
    create({ el, props, series }) {
      const instance = createCanvasWidget(
        el,
        (frame, theme, current, data) => {
          const items = data.map((item) => ({ label: item.label, value: latestValue(item.values), color: item.color }));
          drawBars(frame, items, theme, { max: Number(current.max) || undefined });
        },
        series
      );
      instance.setProps(props);
      return instance;
    }
  },
  {
    type: 'widget.donut',
    label: '环形占比',
    icon: '◍',
    group: '图表',
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 2 },
    defaults: {},
    propSchema: [],
    create({ el, props, series }) {
      const instance = createCanvasWidget(
        el,
        (frame, theme, _current, data) => {
          const items = data.map((item) => ({
            label: item.label,
            value: Math.abs(latestValue(item.values)),
            color: item.color
          }));
          drawDonut(frame, items, theme);
        },
        series
      );
      instance.setProps(props);
      return instance;
    }
  },
  {
    type: 'widget.table',
    label: '数据表',
    icon: '▤',
    group: '数据',
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 2 },
    defaults: { digits: 2 },
    propSchema: [{ key: 'digits', label: '小数位', type: 'number', min: 0, max: 6, step: 1, group: '样式' }],
    create({ el, props, series }) {
      const instance = createCanvasWidget(
        el,
        (frame, theme, current, data) => {
          const digits = Number(current.digits);
          const rows = data.map((item) => ({
            name: item.label,
            value: latestValue(item.values).toFixed(Number.isFinite(digits) ? digits : 2),
            unit: item.unit,
            color: item.color
          }));
          drawTable(frame, rows, theme);
        },
        series
      );
      instance.setProps(props);
      return instance;
    }
  },
  {
    type: 'widget.stat',
    label: '数值卡',
    icon: '◈',
    group: '数据',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 1 },
    defaults: { title: '当前值', digits: 2, tone: 'default' },
    propSchema: [
      { key: 'title', label: '标题', type: 'text', group: '样式' },
      { key: 'digits', label: '小数位', type: 'number', min: 0, max: 6, step: 1, group: '样式' },
      {
        key: 'tone',
        label: '配色',
        type: 'select',
        options: [
          { value: 'default', label: '默认' },
          { value: 'ok', label: '正常' },
          { value: 'warn', label: '警告' },
          { value: 'danger', label: '危险' }
        ],
        group: '样式'
      }
    ],
    create({ el, props, series }) {
      const box = document.createElement('div');
      box.className = 'dsg-stat';
      const title = document.createElement('div');
      title.className = 'dsg-stat-title';
      const value = document.createElement('div');
      value.className = 'dsg-stat-value';
      const unit = document.createElement('span');
      unit.className = 'dsg-stat-unit';
      box.append(title, value);
      el.appendChild(box);
      let current: Record<string, unknown> = {};

      const paint = () => {
        const first = series()[0];
        title.textContent = String(current.title || '当前值');
        const digits = Number(current.digits);
        const number = first ? latestValue(first.values) : NaN;
        value.className = 'dsg-stat-value';
        if (current.tone && current.tone !== 'default') value.dataset.tone = String(current.tone);
        else delete value.dataset.tone;
        value.textContent = Number.isFinite(number) ? number.toFixed(Number.isFinite(digits) ? digits : 2) : '--';
        unit.textContent = first && first.unit ? ' ' + first.unit : '';
        value.appendChild(unit);
      };

      paint();
      return {
        render: paint,
        resize: paint,
        setProps(next) {
          current = next || {};
          paint();
        },
        dispose() {
          el.replaceChildren();
        }
      };
    }
  },
  {
    type: 'widget.label',
    label: '文本',
    icon: 'T',
    group: '基础',
    defaultSize: { w: 4, h: 1 },
    minSize: { w: 1, h: 1 },
    defaults: { text: '标题文本', align: 'left', size: 14 },
    propSchema: [
      { key: 'text', label: '内容', type: 'text', group: '内容' },
      {
        key: 'align',
        label: '对齐',
        type: 'select',
        options: [
          { value: 'left', label: '左' },
          { value: 'center', label: '中' },
          { value: 'right', label: '右' }
        ],
        group: '样式'
      },
      { key: 'size', label: '字号', type: 'number', min: 10, max: 48, step: 1, group: '样式' }
    ],
    create({ el, props }) {
      const text = document.createElement('div');
      text.className = 'dsg-label';
      el.appendChild(text);
      let current: Record<string, unknown> = {};
      const paint = () => {
        text.textContent = String(current.text ?? '');
        text.style.textAlign = String(current.align || 'left');
        text.style.fontSize = (Number(current.size) || 14) + 'px';
      };
      paint();
      return {
        render: paint,
        resize: paint,
        setProps(next) {
          current = next || {};
          paint();
        },
        dispose() {
          el.replaceChildren();
        }
      };
    }
  }
];

export function widgetDef(type: string, extra: WidgetDef[] = []): WidgetDef | undefined {
  return extra.find((def) => def.type === type) || BUILTIN_WIDGETS.find((def) => def.type === type);
}

/** 未知控件（老版本/插件缺失）也要能画出来，告诉用户“这里原来有东西”。 */
export function createMissingWidget(el: HTMLElement, type: string): WidgetInstance {
  const box = document.createElement('div');
  box.className = 'dsg-missing';
  box.textContent = '缺少控件：' + type;
  el.appendChild(box);
  return {
    render: () => undefined,
    resize: () => undefined,
    setProps: () => undefined,
    dispose: () => el.replaceChildren()
  };
}
