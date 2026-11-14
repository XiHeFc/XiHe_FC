/**
 * 撤销重做：命令式（inverse patch），不是字符串快照。
 *
 * 理由很实际：UI 文档比图大（嵌套树 + 绑定表），拖拽一次会连续产生几十个中间态；
 * 快照栈在大文档上既费内存又容易把“一次拖拽”拆成 30 步撤销。
 * 这里每条命令自带 do/undo，拖拽用 transaction 合并成一条。
 */
import type { UiBinding, UiDoc, UiNode, GridRect } from './ui-doc';
import { findNode, findParent, isPlainObject } from './ui-doc';

export interface UiCommand {
  label: string;
  do(doc: UiDoc): void;
  undo(doc: UiDoc): void;
}

export class UiHistory {
  private undoStack: UiCommand[] = [];
  private redoStack: UiCommand[] = [];
  private depth = 0;
  private pending: UiCommand[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly limit = 200) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : '';
  }

  /** transaction 内的命令合并成一条，适合拖拽/连续输入。 */
  transaction(fn: () => void, label = '批量修改'): void {
    this.depth += 1;
    try {
      fn();
    } finally {
      this.depth -= 1;
      if (this.depth === 0 && this.pending.length) {
        const batch = this.pending.slice();
        this.pending = [];
        this.push({
          label,
          do: (doc) => batch.forEach((command) => command.do(doc)),
          undo: (doc) => {
            for (let i = batch.length - 1; i >= 0; i--) batch[i].undo(doc);
          }
        });
      }
    }
  }

  push(command: UiCommand): void {
    if (this.depth > 0) {
      this.pending.push(command);
      return;
    }
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
  }

  undo(doc: UiDoc): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo(doc);
    this.redoStack.push(command);
    this.emit();
    return true;
  }

  redo(doc: UiDoc): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.do(doc);
    this.undoStack.push(command);
    this.emit();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending.length = 0;
    this.emit();
  }
}

// ===== 常用命令工厂 =====

export function insertNodeCommand(parentId: string, node: UiNode, label = '添加控件'): UiCommand {
  const snapshot = JSON.parse(JSON.stringify(node)) as UiNode;
  return {
    label,
    do(doc) {
      const parent = findNode(doc.root, parentId);
      if (!parent) return;
      parent.children = parent.children || [];
      parent.children.push(JSON.parse(JSON.stringify(snapshot)) as UiNode);
    },
    undo(doc) {
      const parent = findNode(doc.root, parentId);
      if (!parent || !parent.children) return;
      const index = parent.children.findIndex((child) => child.id === snapshot.id);
      if (index >= 0) parent.children.splice(index, 1);
    }
  };
}

export function removeNodeCommand(nodeId: string, label = '删除控件'): UiCommand {
  let removed: UiNode | null = null;
  let removedIndex = -1;
  let parentId = '';
  return {
    label,
    do(doc) {
      const parent = findParent(doc.root, nodeId);
      if (!parent || !parent.children) return;
      const index = parent.children.findIndex((child) => child.id === nodeId);
      if (index < 0) return;
      parentId = parent.id;
      removedIndex = index;
      removed = JSON.parse(JSON.stringify(parent.children[index])) as UiNode;
      parent.children.splice(index, 1);
    },
    undo(doc) {
      if (!removed) return;
      const parent = findNode(doc.root, parentId);
      if (!parent) return;
      parent.children = parent.children || [];
      parent.children.splice(removedIndex, 0, JSON.parse(JSON.stringify(removed)) as UiNode);
    }
  };
}

export function moveNodeCommand(nodeId: string, next: GridRect, label = '移动控件'): UiCommand {
  let previous: GridRect | null = null;
  return {
    label,
    do(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      previous = { ...node.grid };
      node.grid = { ...next };
    },
    undo(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node || !previous) return;
      node.grid = { ...previous };
    }
  };
}

export function propsCommand(nodeId: string, patch: Record<string, unknown>, label = '修改属性'): UiCommand {
  let before: Record<string, unknown> | null = null;
  return {
    label,
    do(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      before = { ...node.props };
      node.props = { ...node.props, ...patch };
    },
    undo(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node || !before) return;
      node.props = before;
    }
  };
}

/** 改节点绑定：同时更新 node.bind 与文档的 bindings 表，撤销要一起回退。 */
export function bindingsCommand(
  nodeId: string,
  bind: string[],
  bindings: Record<string, UiBinding>,
  label = '修改数据绑定'
): UiCommand {
  let beforeBind: string[] = [];
  let beforeBindings: Record<string, UiBinding> = {};
  return {
    label,
    do(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      beforeBind = Array.isArray(node.bind) ? node.bind.slice() : [];
      beforeBindings = {};
      beforeBind.forEach((key) => {
        if (doc.bindings[key]) beforeBindings[key] = doc.bindings[key];
        delete doc.bindings[key];
      });
      node.bind = bind.slice();
      for (const [key, value] of Object.entries(bindings)) doc.bindings[key] = value;
    },
    undo(doc) {
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      const current = Array.isArray(node.bind) ? node.bind : [];
      current.forEach((key) => delete doc.bindings[key]);
      node.bind = beforeBind.slice();
      for (const [key, value] of Object.entries(beforeBindings)) doc.bindings[key] = value;
    }
  };
}

export function renameCommand(name: string, label = '重命名'): UiCommand {  let before = '';
  return {
    label,
    do(doc) {
      before = doc.name;
      doc.name = name;
    },
    undo(doc) {
      doc.name = before;
    }
  };
}

/** 给“输入框连续输入”用的合并键：同键在窗口期内只记一次。 */
export class Coalescer {
  private key = '';
  private timer: number | null = null;

  constructor(private readonly windowMs = 400) {}

  shouldMerge(key: string): boolean {
    const same = this.key === key && this.timer != null;
    this.key = key;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.key = '';
    }, this.windowMs);
    return same;
  }
}

/** 深拷贝一个节点并换 id（复制粘贴用）。 */
export function duplicateNode(node: UiNode): UiNode {
  const copy = JSON.parse(JSON.stringify(node)) as UiNode;
  const renumber = (target: UiNode) => {
    target.id = `${target.id}_c${Math.random().toString(36).slice(2, 5)}`;
    (target.children || []).forEach(renumber);
  };
  renumber(copy);
  return copy;
}

export { isPlainObject };
