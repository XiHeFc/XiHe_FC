/**
 * 看板增量补丁：AI / MCP / 外部脚本改看板的唯一受控入口。
 *
 * 为什么不是「让模型重新生成整块看板」：整块重建会丢掉用户的布局微调、绑定变换和自定义顺序，
 * 而且没法只撤销它改的那一处。补丁只允许 5 种操作，**先全量校验、再原子应用** ——
 * 任何一处非法就整体拒绝，绝不出现「改了一半」。
 */
import {
  GRID_COLS,
  cloneDoc,
  findFreeSlot,
  findNode,
  normalizeDoc,
  type GridRect,
  type UiBinding,
  type UiDoc,
  type UiNode
} from './ui-doc';
import { channelById } from './data-access';
import { composeBoard, BOARD_WIDGET_TYPES } from './board-spec';
import { widgetDef } from './widgets';

export type BoardPatchOp =
  | {
      op: 'add';
      widget: {
        type: string;
        title?: string;
        channel?: string;
        channels?: string[];
        query?: string;
        points?: number;
        normalize?: boolean;
        text?: string;
        w?: number;
        h?: number;
      };
      grid?: Partial<GridRect>;
    }
  | { op: 'remove'; id: string }
  | { op: 'update'; id: string; props?: Record<string, unknown>; channel?: string; channels?: string[]; query?: string; title?: string }
  | { op: 'move'; id: string; grid: Partial<GridRect> }
  | { op: 'rename'; name: string };

export interface BoardPatch {
  boardId?: string;
  /** 乐观并发：提交时若活动看板 updatedAt 已变，拒绝应用 */
  baseUpdatedAt?: number;
  ops: BoardPatchOp[];
}

export interface PatchDiff {
  added: number;
  removed: number;
  updated: number;
  moved: number;
  renamed: number;
}

export interface PatchResult {
  ok: boolean;
  errors: string[];
  doc?: UiDoc;
  diff: PatchDiff;
}

export const MAX_PATCH_OPS = 50;

const CONTROL_PROPS = new Set(['title', 'text', 'digits', 'tone', 'points', 'normalize', 'grid', 'fill', 'min', 'max', 'align', 'size', 'columns']);

function emptyDiff(): PatchDiff {
  return { added: 0, removed: 0, updated: 0, moved: 0, renamed: 0 };
}

function allowedProps(type: string): Set<string> {
  const def = widgetDef(type);
  const keys = new Set<string>(CONTROL_PROPS);
  for (const spec of def ? def.propSchema : []) keys.add(spec.key);
  return keys;
}

function gridOf(raw: Partial<GridRect> | undefined, fallbackW: number, fallbackH: number, cols: number): GridRect {
  const w = Math.max(1, Math.min(cols, Math.round(Number(raw?.w) || fallbackW)));
  const h = Math.max(1, Math.round(Number(raw?.h) || fallbackH));
  const x = Math.max(0, Math.min(cols - w, Math.round(Number(raw?.x) || 0)));
  const y = Math.max(0, Math.round(Number(raw?.y) || 0));
  return { x, y, w, h };
}

function validateWidgetData(widget: Record<string, unknown>, where: string): string[] {
  const errors: string[] = [];
  const type = String(widget.type || '');
  if (!type) errors.push(`${where} 缺少 type`);
  else if (!(BOARD_WIDGET_TYPES as readonly string[]).includes(type)) {
    errors.push(`${where} 的 type 不支持：${type}（只能是 ${BOARD_WIDGET_TYPES.join('/')}）`);
  }
  if (widget.channel && !channelById(String(widget.channel))) {
    errors.push(`${where} 的 channel 不存在：${widget.channel}`);
  }
  if (Array.isArray(widget.channels)) {
    const bad = widget.channels.map(String).filter((id) => !channelById(id));
    if (bad.length) errors.push(`${where} 的 channels 有未知通道：${bad.join(',')}`);
  }
  return errors;
}

function validateNodeId(doc: UiDoc, id: string, where: string): string[] {
  if (!id) return [`${where} 缺少 id`];
  return findNode(doc.root, id) ? [] : [`${where} 的控件不存在：${id}`];
}

/** 只校验，不改文档。返回可读错误列表（空数组 = 通过）。 */
export function validatePatch(doc: UiDoc, patch: BoardPatch): string[] {
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object') return ['补丁不是对象'];
  const ops = Array.isArray(patch.ops) ? patch.ops : [];
  if (!ops.length) errors.push('补丁没有任何操作（ops 为空）');
  if (ops.length > MAX_PATCH_OPS) errors.push(`一次最多 ${MAX_PATCH_OPS} 个操作，实际 ${ops.length}`);
  if (patch.baseUpdatedAt && Number(patch.baseUpdatedAt) !== Number(doc.updatedAt)) {
    errors.push('看板已被修改（updatedAt 不一致），请重新读取后再提交');
  }
  const removed = new Set<string>();
  ops.forEach((raw, index) => {
    const where = `ops[${index}]`;
    const op = String((raw as { op?: string }).op || '');
    if (!['add', 'remove', 'update', 'move', 'rename'].includes(op)) {
      errors.push(`${where} 的 op 不支持：${op || '(空)'}`);
      return;
    }
    if (op === 'add') {
      const widget = (raw as { widget?: Record<string, unknown> }).widget;
      if (!widget || typeof widget !== 'object') {
        errors.push(`${where} 缺少 widget`);
        return;
      }
      errors.push(...validateWidgetData(widget, `${where}.widget`));
      return;
    }
    if (op === 'rename') {
      const name = String((raw as { name?: string }).name || '').trim();
      if (!name) errors.push(`${where} 缺少 name`);
      if (name.length > 40) errors.push(`${where} 的 name 超过 40 字`);
      return;
    }
    const id = String((raw as { id?: string }).id || '');
    const idErrors = validateNodeId(doc, id, where);
    if (idErrors.length) {
      errors.push(...idErrors);
      return;
    }
    if (removed.has(id)) errors.push(`${where} 重复操作同一个控件：${id}`);
    if (op === 'remove') {
      removed.add(id);
      const node = findNode(doc.root, id);
      if (node && node.type === 'layout.grid') errors.push(`${where} 不能删除根容器`);
      return;
    }
    if (op === 'update') {
      const node = findNode(doc.root, id);
      const allowed = allowedProps(node ? node.type : '');
      const props = (raw as { props?: Record<string, unknown> }).props;
      if (props) {
        for (const key of Object.keys(props)) {
          if (!allowed.has(key)) errors.push(`${where}.props 不允许修改字段：${key}`);
        }
      }
      const patchData: Record<string, unknown> = {};
      const update = raw as { channel?: string; channels?: string[]; query?: string };
      if (update.channel) patchData.channel = update.channel;
      if (Array.isArray(update.channels)) patchData.channels = update.channels;
      if (update.query) patchData.query = update.query;
      errors.push(...validateWidgetData({ type: 'scope', ...patchData }, `${where}`));
      return;
    }
    if (op === 'move') {
      const grid = (raw as { grid?: Partial<GridRect> }).grid;
      if (!grid || typeof grid !== 'object') errors.push(`${where} 缺少 grid`);
      else if (Number(grid.w) < 0 || Number(grid.h) < 0) errors.push(`${where} 的宽高不能为负`);
    }
  });
  return errors;
}

/** 应用补丁：返回新文档（深拷贝），输入文档保持不变。 */
export function applyPatch(doc: UiDoc, patch: BoardPatch): PatchResult {
  const errors = validatePatch(doc, patch);
  if (errors.length) return { ok: false, errors, diff: emptyDiff() };

  const next = cloneDoc(doc);
  const diff = emptyDiff();
  const cols = next.cols || GRID_COLS;

  for (const raw of patch.ops) {
    const op = (raw as { op: string }).op;
    if (op === 'add') {
      const widget = (raw as Extract<BoardPatchOp, { op: 'add' }>).widget;
      const explicitGrid = (raw as Extract<BoardPatchOp, { op: 'add' }>).grid;
      const built = composeBoard({ name: next.name, widgets: [widget] });
      if (!built.ok || !built.doc) {
        // 理论上 validate 已挡住；这里兜底，保持原子性
        return { ok: false, errors: [built.error || '控件生成失败'], diff: emptyDiff() };
      }
      const source = built.doc.root.children && built.doc.root.children[0];
      if (!source) return { ok: false, errors: ['控件生成失败：没有节点'], diff: emptyDiff() };
      const def = widgetDef(source.type);
      const fallback = def ? def.defaultSize : { w: 4, h: 3 };
      const slot = explicitGrid
        ? gridOf(explicitGrid, fallback.w, fallback.h, cols)
        : findFreeSlot(next.root, fallback.w, fallback.h, cols);
      const node: UiNode = {
        id: source.id,
        type: source.type,
        props: { ...source.props },
        grid: slot
      };
      if (source.bind && source.bind.length) {
        // composeBoard 生成的绑定 key 已带节点前缀，直接搬过来
        node.bind = source.bind.slice();
        for (const key of node.bind) {
          const binding = built.doc.bindings[key];
          if (binding) next.bindings[key] = binding as UiBinding;
        }
      }
      next.root.children = next.root.children || [];
      next.root.children.push(node);
      diff.added += 1;
      continue;
    }

    if (op === 'rename') {
      const name = String((raw as Extract<BoardPatchOp, { op: 'rename' }>).name).trim().slice(0, 40);
      next.name = name;
      diff.renamed += 1;
      continue;
    }

    const node = findNode(next.root, String((raw as { id: string }).id));
    if (!node) continue; // validate 已保证存在；防御性跳过

    if (op === 'remove') {
      const parent = findParentOf(next.root, node.id);
      if (parent && parent.children) {
        parent.children = parent.children.filter((child) => child.id !== node.id);
        diff.removed += 1;
      }
      continue;
    }

    if (op === 'move') {
      const grid = (raw as Extract<BoardPatchOp, { op: 'move' }>).grid;
      node.grid = gridOf({ ...node.grid, ...grid }, node.grid.w, node.grid.h, cols);
      diff.moved += 1;
      continue;
    }

    if (op === 'update') {
      const update = raw as Extract<BoardPatchOp, { op: 'update' }>;
      if (update.props) {
        const allowed = allowedProps(node.type);
        for (const [key, value] of Object.entries(update.props)) {
          if (!allowed.has(key)) continue;
          node.props[key] = value;
        }
      }
      if (update.title != null) node.props.title = String(update.title).slice(0, 24);
      // 通道类更新 = 重写绑定（保持 bindings 是唯一真相）
      const channelRef = update.channel
        ? { source: 'channel' as const, ref: update.channel }
        : Array.isArray(update.channels) && update.channels.length
          ? { source: 'channels' as const, ref: update.channels.map(String) }
          : update.query
            ? { source: 'query' as const, ref: update.query }
            : null;
      if (channelRef) {
        if (node.bind) node.bind.forEach((key) => delete next.bindings[key]);
        const bindKey = `${node.id}:b1`;
        next.bindings[bindKey] = channelRef as UiBinding;
        node.bind = [bindKey];
      }
      diff.updated += 1;
    }
  }

  next.updatedAt = Date.now();
  return { ok: true, errors: [], doc: normalizeDoc(next) || next, diff };
}

function findParentOf(root: UiNode, id: string): UiNode | null {
  let found: UiNode | null = null;
  const walk = (node: UiNode) => {
    for (const child of node.children || []) {
      if (child.id === id) {
        found = node;
        return;
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** 给确认卡片用的一行摘要。 */
export function describePatch(diff: PatchDiff): string {
  const parts: string[] = [];
  if (diff.added) parts.push(`+${diff.added}`);
  if (diff.removed) parts.push(`-${diff.removed}`);
  if (diff.updated) parts.push(`~${diff.updated}`);
  if (diff.moved) parts.push(`↔${diff.moved}`);
  if (diff.renamed) parts.push('改名');
  return parts.length ? parts.join(' ') : '无变化';
}
