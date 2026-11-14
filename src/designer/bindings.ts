/**
 * 绑定解析：把文档里的 `bindings` 表变成“控件真正能画的东西”。
 *
 * 为什么需要这一层：控件不该知道通道叫什么、有多少点、要不要归一化。
 * 它只声明“我要几条序列”，解析器负责把 channel / channels / query 变成序列，
 * 并在解析失败时给出空数组 + 可读原因，而不是让控件抛错。
 *
 * 兼容：节点没有 `bind` 时回退到 `props.channels`（设计器早期版本存的形态）。
 */
import { channelsByQuery, channelById, currentChannels, latestValue, toSeries, type SeriesPoint } from './data-access';
import type { UiBinding, UiDoc, UiNode } from './ui-doc';

export interface BindingIssue {
  nodeId: string;
  bindingKey: string;
  message: string;
}

const DEFAULT_WINDOW = 120;

function applyTransform(series: SeriesPoint, binding: UiBinding): SeriesPoint {
  const transform = binding.transform;
  if (!transform) return series;
  const values = series.values;
  if (transform.fn === 'window') {
    const limit = Number(transform.args?.limit) || DEFAULT_WINDOW;
    return { ...series, values: values.length > limit ? values.slice(values.length - limit) : values.slice() };
  }
  if (transform.fn === 'scale') {
    const factor = Number(transform.args?.factor);
    const k = Number.isFinite(factor) ? factor : 1;
    return { ...series, values: values.map((value) => value * k) };
  }
  if (transform.fn === 'normalize') {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
      return { ...series, values: values.map(() => 0.5) };
    }
    const span = max - min;
    return { ...series, values: values.map((value) => (value - min) / span) };
  }
  return series;
}

export interface ResolvedBinding {
  series: SeriesPoint[];
  issues: BindingIssue[];
}

/** 解析单个节点，返回它要画的序列列表。 */
export function resolveNode(doc: UiDoc, target: UiNode): ResolvedBinding {
  const out: SeriesPoint[] = [];
  const issues: BindingIssue[] = [];
  const keys = Array.isArray(target.bind) ? target.bind : [];
  const started = performance.now();

  if (keys.length) {
    keys.forEach((key) => {
      const binding = doc.bindings[key];
      if (!binding) {
        issues.push({ nodeId: target.id, bindingKey: key, message: `绑定 ${key} 不存在` });
        return;
      }
      try {
        pushBinding(out, binding, key, target, issues);
      } catch (err) {
        issues.push({ nodeId: target.id, bindingKey: key, message: err instanceof Error ? err.message : String(err) });
      }
    });
  } else {
    // 兼容早期文档：props.channels 直接当绑定用
    const legacy = target.props?.channels;
    const ids = Array.isArray(legacy) ? legacy.map(String) : typeof legacy === 'string' && legacy ? [legacy] : [];
    ids.forEach((id, index) => {
      const channel = channelById(id);
      if (!channel) {
        issues.push({ nodeId: target.id, bindingKey: 'props.channels', message: `通道 ${id} 不存在` });
        return;
      }
      out.push(toSeries(channel, index));
    });
  }

  // 兜底：一个都没解析出来时给前三条，避免“新拖进来的控件是空白”
  if (!out.length && !keys.length) {
    currentChannels().slice(0, 3).forEach((channel, index) => out.push(toSeries(channel, index)));
  }

  const elapsed = performance.now() - started;
  if (elapsed > 8) console.warn(`[XHGCS_CORE] 绑定解析耗时 ${elapsed.toFixed(1)}ms（节点 ${target.id}）`);
  return { series: out, issues };
}

function pushBinding(
  out: SeriesPoint[],
  binding: UiBinding,
  key: string,
  target: UiNode,
  issues: BindingIssue[]
): void {
  if (binding.source === 'channel') {
    const id = String(binding.ref || '');
    const channel = channelById(id);
    if (!channel) {
      issues.push({ nodeId: target.id, bindingKey: key, message: `通道 ${id} 不存在` });
      return;
    }
    out.push(applyTransform(toSeries(channel, out.length), binding));
    return;
  }
  if (binding.source === 'channels') {
    const ids = Array.isArray(binding.ref) ? binding.ref.map(String) : [String(binding.ref || '')];
    ids.forEach((id) => {
      const channel = channelById(id);
      if (!channel) {
        issues.push({ nodeId: target.id, bindingKey: key, message: `通道 ${id} 不存在` });
        return;
      }
      out.push(applyTransform(toSeries(channel, out.length), binding));
    });
    return;
  }
  if (binding.source === 'query') {
    const query = String(binding.ref || '');
    const hits = channelsByQuery(query);
    if (!hits.length) {
      issues.push({ nodeId: target.id, bindingKey: key, message: `没有通道匹配「${query}」` });
      return;
    }
    hits.forEach((channel) => out.push(applyTransform(toSeries(channel, out.length), binding)));
    return;
  }
  if (binding.source === 'state') {
    // 状态类绑定不是序列，留给控件自己按 props 处理
    issues.push({ nodeId: target.id, bindingKey: key, message: 'state 绑定暂不作为序列' });
    return;
  }
  issues.push({ nodeId: target.id, bindingKey: key, message: `不支持的绑定类型 ${binding.source}` });
}

/** 单值便捷入口（仪表/数值卡用）。 */
export function resolveFirst(doc: UiDoc, node: UiNode): SeriesPoint | null {
  const resolved = resolveNode(doc, node);
  return resolved.series.length ? resolved.series[0] : null;
}

export function seriesLatest(series: SeriesPoint | null): number {
  return series ? latestValue(series.values) : 0;
}

/** 给属性面板用的摘要文案。 */
export function describeBinding(binding: UiBinding): string {
  const ref = Array.isArray(binding.ref) ? binding.ref.join(', ') : String(binding.ref || '');
  const map: Record<string, string> = {
    channel: '通道',
    channels: '多通道',
    query: '名字匹配',
    state: '状态',
    expr: '表达式'
  };
  const suffix = binding.transform ? ` · ${binding.transform.fn}` : '';
  return `${map[binding.source] || binding.source}：${ref || '（空）'}${suffix}`;
}

/** 把“选了哪些通道”写成一组合成绑定，返回新的 bind 列表与绑定表。 */
export function bindingsForChannels(ids: string[], transform?: UiBinding['transform']): { bind: string[]; bindings: Record<string, UiBinding> } {
  const bind: string[] = [];
  const bindings: Record<string, UiBinding> = {};
  ids.forEach((id, index) => {
    const key = `b${index + 1}`;
    bind.push(key);
    bindings[key] = { source: 'channel', ref: id, transform };
  });
  return { bind, bindings };
}

export function bindingsForQuery(query: string, transform?: UiBinding['transform']): { bind: string[]; bindings: Record<string, UiBinding> } {
  return { bind: ['b1'], bindings: { b1: { source: 'query', ref: query, transform } } };
}

export function bindingTransformOf(doc: UiDoc, node: UiNode): UiBinding['transform'] | undefined {
  const keys = Array.isArray(node.bind) ? node.bind : [];
  for (const key of keys) {
    const binding = doc.bindings[key];
    if (binding && binding.transform) return binding.transform;
  }
  return undefined;
}

export function bindingsOf(doc: UiDoc, node: UiNode): UiBinding[] {
  const keys = Array.isArray(node.bind) ? node.bind : [];
  return keys.map((key) => doc.bindings[key]).filter((binding): binding is UiBinding => Boolean(binding));
}
