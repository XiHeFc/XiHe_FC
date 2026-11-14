/**
 * 可视化设计器的文档模型（UiDoc）。
 *
 * 三条硬规则，缺一条用户就会丢布局：
 *   1. 纯数据：没有函数、没有 DOM 引用，能 JSON.stringify 往返；
 *   2. 只用 id 引用：节点/绑定/通道都靠 id，改名字不改引用；
 *   3. 未知类型保留节点：老版本存下来的控件，新版本不认识了也要留着并显示占位，
 *      绝不静默丢用户搭的东西。
 */

export type GridRect = { x: number; y: number; w: number; h: number };

export interface UiNode {
  id: string;
  /** 'layout.grid' 是唯一的内核容器；其余是 widget.* 或插件贡献的控件 id */
  type: string;
  props: Record<string, unknown>;
  /** 绑定 key 列表，指向 Doc.bindings */
  bind?: string[];
  grid: GridRect;
  children?: UiNode[];
}

export type BindingSource = 'channel' | 'channels' | 'query' | 'state' | 'expr';

export interface UiBinding {
  source: BindingSource;
  /** channel = 通道 id；channels = id 数组；query = 名字子串；state = 状态路径；expr = 受限表达式 */
  ref: string | string[];
  transform?: { fn: 'window' | 'scale' | 'normalize'; args?: Record<string, unknown> };
}

export interface UiDoc {
  format: 'xhgcs.ui';
  version: 2;
  id: string;
  name: string;
  cols: number;
  rowHeight: number;
  root: UiNode;
  bindings: Record<string, UiBinding>;
  createdAt: number;
  updatedAt: number;
}

export const DOC_FORMAT = 'xhgcs.ui';
export const DOC_VERSION = 2;
export const GRID_COLS = 12;
export const ROW_HEIGHT = 44;

let seq = 0;
export function nextNodeId(prefix = 'n'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq.toString(36)}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function clampGrid(rect: GridRect, cols = GRID_COLS): GridRect {
  const w = Math.max(1, Math.min(cols, Math.round(rect.w) || 1));
  const h = Math.max(1, Math.round(rect.h) || 1);
  const x = Math.max(0, Math.min(cols - w, Math.round(rect.x) || 0));
  const y = Math.max(0, Math.round(rect.y) || 0);
  return { x, y, w, h };
}

export function createDoc(name = '新建看板'): UiDoc {
  const now = Date.now();
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    id: `ui.${now.toString(36)}`,
    name,
    cols: GRID_COLS,
    rowHeight: ROW_HEIGHT,
    root: { id: 'root', type: 'layout.grid', props: { gap: 10 }, grid: { x: 0, y: 0, w: GRID_COLS, h: 12 }, children: [] },
    bindings: {},
    createdAt: now,
    updatedAt: now
  };
}

function normalizeNode(raw: unknown, fallbackType = 'widget.unknown'): UiNode | null {
  if (!isPlainObject(raw)) return null;
  const id = String(raw.id || '').trim() || nextNodeId();
  const type = String(raw.type || fallbackType).trim() || fallbackType;
  const gridRaw = isPlainObject(raw.grid) ? raw.grid : {};
  const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
  const children = childrenRaw.map((child) => normalizeNode(child)).filter((child): child is UiNode => Boolean(child));
  const node: UiNode = {
    id,
    type,
    props: isPlainObject(raw.props) ? { ...raw.props } : {},
    grid: clampGrid({
      x: Number(gridRaw.x) || 0,
      y: Number(gridRaw.y) || 0,
      w: Number(gridRaw.w) || 4,
      h: Number(gridRaw.h) || 3
    }),
    bind: Array.isArray(raw.bind) ? raw.bind.map(String) : undefined
  };
  if (children.length) node.children = children;
  return node;
}

function normalizeBindings(raw: unknown): Record<string, UiBinding> {
  const out: Record<string, UiBinding> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const source = String(value.source || 'channel') as BindingSource;
    if (!['channel', 'channels', 'query', 'state', 'expr'].includes(source)) continue;
    out[key] = {
      source,
      ref: Array.isArray(value.ref) ? value.ref.map(String) : String(value.ref ?? ''),
      transform: isPlainObject(value.transform) ? (value.transform as UiBinding['transform']) : undefined
    };
  }
  return out;
}

/** 读盘/导入统一走这里：坏字段就地修补，而不是整份丢弃。 */
export function normalizeDoc(raw: unknown): UiDoc | null {
  if (!isPlainObject(raw)) return null;
  if (raw.format != null && raw.format !== DOC_FORMAT) return null;
  const root = normalizeNode(raw.root, 'layout.grid');
  if (!root) return null;
  const now = Date.now();
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    id: String(raw.id || `ui.${now.toString(36)}`),
    name: String(raw.name || '未命名看板').slice(0, 40),
    cols: Math.max(4, Math.min(24, Number(raw.cols) || GRID_COLS)),
    rowHeight: Math.max(24, Math.min(120, Number(raw.rowHeight) || ROW_HEIGHT)),
    root,
    bindings: normalizeBindings(raw.bindings),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now
  };
}

export function serializeDoc(doc: UiDoc): string {
  return JSON.stringify({ ...doc, updatedAt: Date.now() }, null, 2);
}

export function parseDoc(text: string): UiDoc | null {
  try {
    return normalizeDoc(JSON.parse(text));
  } catch {
    return null;
  }
}

export function cloneDoc(doc: UiDoc): UiDoc {
  return JSON.parse(JSON.stringify(doc)) as UiDoc;
}

export function forEachNode(root: UiNode, visit: (node: UiNode, parent: UiNode | null) => void): void {
  const walk = (node: UiNode, parent: UiNode | null) => {
    visit(node, parent);
    for (const child of node.children || []) walk(child, node);
  };
  walk(root, null);
}

export function findNode(root: UiNode, id: string): UiNode | null {
  let hit: UiNode | null = null;
  forEachNode(root, (node) => {
    if (node.id === id) hit = node;
  });
  return hit;
}

export function findParent(root: UiNode, id: string): UiNode | null {
  let hit: UiNode | null = null;
  forEachNode(root, (node, parent) => {
    if (node.id === id) hit = parent;
  });
  return hit;
}

export function allWidgets(root: UiNode): UiNode[] {
  const out: UiNode[] = [];
  forEachNode(root, (node) => {
    if (node.type !== 'layout.grid' && node.type !== 'layout.row' && node.type !== 'layout.col') out.push(node);
  });
  return out;
}

/** 找一个不重叠的落点：从顶到底逐行扫，找不到就追加到末尾。 */
export function findFreeSlot(root: UiNode, w: number, h: number, cols = GRID_COLS): GridRect {
  const taken = allWidgets(root).map((node) => node.grid);
  const overflows = (rect: GridRect): boolean =>
    taken.some((r) => !(rect.x + rect.w <= r.x || rect.x >= r.x + r.w || rect.y + rect.h <= r.y || rect.y >= r.y + r.h));
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const rect = { x, y, w, h };
      if (!overflows(rect)) return rect;
    }
  }
  const bottom = taken.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return { x: 0, y: bottom, w, h };
}

export function docStats(doc: UiDoc): { widgets: number; bindings: number } {
  return { widgets: allWidgets(doc.root).length, bindings: Object.keys(doc.bindings).length };
}
