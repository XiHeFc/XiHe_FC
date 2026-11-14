/**
 * 看板“意图规格”→ UiDoc。
 *
 * AI 不应该直接吐完整 UiDoc（嵌套树 + 绑定表，模型很容易写坏且难校验）。
 * 这里定义一层更窄的规格：控件类型 + 通道/查询 + 少量样式，模型只要写对这几项，
 * 布局、绑定 key、props 默认值全部由这里生成，并且逐项给出可读错误让模型自己改。
 */
import { createDoc, nextNodeId, type UiBinding, type UiDoc, type UiNode } from './ui-doc';
import { bindingsForChannels, bindingsForQuery } from './bindings';
import { channelById, currentChannels } from './data-access';
import { widgetDef } from './widgets';

type Generated = { bind: string[]; bindings: Record<string, UiBinding> };

export const BOARD_WIDGET_TYPES = ['scope', 'gauge', 'stat', 'table', 'donut', 'bars', 'label'] as const;
export type BoardWidgetType = (typeof BOARD_WIDGET_TYPES)[number];

export interface BoardWidgetSpec {
  type: string;
  title?: string;
  /** 单通道 id */
  channel?: string;
  /** 多通道 id 列表 */
  channels?: string[];
  /** 通道名字/ID 子串，`*` 表示全部 */
  query?: string;
  /** 采样点数（window 变换） */
  points?: number;
  /** 折线是否归一化 */
  normalize?: boolean;
  /** 文本控件的正文 */
  text?: string;
  w?: number;
  h?: number;
}

export interface BoardSpec {
  name?: string;
  widgets?: BoardWidgetSpec[];
  cols?: number;
  rowHeight?: number;
}

export interface ComposeResult {
  ok: boolean;
  doc?: UiDoc;
  error?: string;
  warnings: string[];
}

const DEFAULT_SIZE: Record<BoardWidgetType, { w: number; h: number }> = {
  scope: { w: 6, h: 4 },
  gauge: { w: 3, h: 4 },
  stat: { w: 3, h: 2 },
  table: { w: 6, h: 4 },
  donut: { w: 3, h: 4 },
  bars: { w: 6, h: 4 },
  label: { w: 12, h: 1 }
};

const MAX_WIDGETS = 12;

function isType(value: string): value is BoardWidgetType {
  return (BOARD_WIDGET_TYPES as readonly string[]).includes(value);
}

export function composeBoard(spec: BoardSpec | null | undefined): ComposeResult {
  const warnings: string[] = [];
  if (!spec || typeof spec !== 'object') return { ok: false, error: '规格不是对象', warnings };
  const widgets = Array.isArray(spec.widgets) ? spec.widgets : [];
  if (!widgets.length) return { ok: false, error: '缺少 widgets（至少一个控件）', warnings };

  const names = currentChannels().map((channel) => channel.id);
  const accepted: BoardWidgetSpec[] = [];
  for (const raw of widgets) {
    const item = raw || ({} as BoardWidgetSpec);
    const type = String(item.type || '').toLowerCase();
    if (!isType(type)) {
      return {
        ok: false,
        error: `不支持的控件类型「${type}」，只能是 ${BOARD_WIDGET_TYPES.join(' / ')}`,
        warnings
      };
    }
    if (item.channel && !channelById(String(item.channel))) {
      return {
        ok: false,
        error: `通道「${item.channel}」不存在。可用通道：${names.slice(0, 12).join(', ') || '（暂无）'}`,
        warnings
      };
    }
    if (Array.isArray(item.channels)) {
      const missing = item.channels.map(String).filter((id) => !channelById(id));
      if (missing.length) {
        return { ok: false, error: `通道「${missing.join(', ')}」不存在`, warnings };
      }
    }
    if (item.query) {
      const needle = String(item.query);
      const hits = currentChannels().filter((channel) => `${channel.id} ${channel.name || ''}`.includes(needle));
      if (!hits.length) warnings.push(`「${needle}」当前没有匹配通道（有数据后会自动绑定）`);
    }
    if ((type === 'gauge' || type === 'stat') && !item.channel && !item.channels && !item.query) {
      warnings.push(`${type} 控件没有指定通道，将默认取第一个通道`);
    }
    accepted.push(item);
    if (accepted.length >= MAX_WIDGETS) {
      warnings.push(`控件超过 ${MAX_WIDGETS} 个，已截断`);
      break;
    }
  }

  const doc = createDoc(String(spec.name || 'AI 看板').slice(0, 40));
  if (spec.cols) doc.cols = Math.max(6, Math.min(24, Math.round(Number(spec.cols)) || doc.cols));
  if (spec.rowHeight) doc.rowHeight = Math.max(28, Math.min(96, Math.round(Number(spec.rowHeight)) || doc.rowHeight));

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const item of accepted) {
    const type = String(item.type || '').toLowerCase() as BoardWidgetType;
    const def = widgetDef(`widget.${type}`);
    const size = {
      w: clamp(Number(item.w) || (def ? def.defaultSize.w : DEFAULT_SIZE[type].w), 1, doc.cols),
      h: clamp(Number(item.h) || (def ? def.defaultSize.h : DEFAULT_SIZE[type].h), 1, 24)
    };
    if (cursorX + size.w > doc.cols) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    const nodeId = nextNodeId();
    const node: UiNode = {
      id: nodeId,
      type: `widget.${type}`,
      props: { ...(def ? def.defaults : {}) },
      grid: { x: cursorX, y: cursorY, w: size.w, h: size.h }
    };
    applyProps(node, item);
    applyBinding(doc, node, item);
    doc.root.children?.push(node);
    cursorX += size.w;
    rowHeight = Math.max(rowHeight, size.h);
  }

  if (!doc.root.children || !doc.root.children.length) return { ok: false, error: '没有生成任何控件', warnings };
  return { ok: true, doc, warnings };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value) || min));
}

function applyProps(node: UiNode, item: BoardWidgetSpec): void {
  if (item.title) {
    node.props.title = String(item.title).slice(0, 24);
    if (node.type === 'widget.label') node.props.text = String(item.title).slice(0, 80);
  }
  if (item.type === 'label' && item.text) node.props.text = String(item.text).slice(0, 80);
  if (item.type === 'scope') {
    if (item.points) node.props.points = clamp(Number(item.points) || 160, 20, 2000);
    node.props.normalize = Boolean(item.normalize);
  }
  if (item.type === 'table') node.props.digits = 2;
}

function applyBinding(doc: UiDoc, node: UiNode, item: BoardWidgetSpec): void {
  const transform: UiBinding['transform'] | undefined = item.points
    ? { fn: 'window', args: { limit: clamp(Number(item.points) || 120, 10, 2000) } }
    : undefined;
  let generated: Generated | null = null;
  if (item.query) {
    generated = toScoped(node.id, bindingsForQuery(String(item.query), transform));
  } else if (Array.isArray(item.channels) && item.channels.length) {
    generated = toScoped(node.id, bindingsForChannels(item.channels.map(String), transform));
  } else if (item.channel) {
    generated = toScoped(node.id, bindingsForChannels([String(item.channel)], transform));
  }
  if (!generated) return;
  node.bind = generated.bind;
  for (const [key, value] of Object.entries(generated.bindings)) {
    doc.bindings[key] = value;
  }
}

function toScoped(nodeId: string, generated: Generated): Generated {
  const bindings: Record<string, UiBinding> = {};
  const bind = generated.bind.map((key) => {
    const next = `${nodeId}:${key}`;
    bindings[next] = generated.bindings[key];
    return next;
  });
  return { bind, bindings };
}
