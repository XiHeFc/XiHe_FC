/**
 * 文档渲染器：把 UiDoc 画成真实界面。
 *
 * 设计器与全屏看板共用这一个渲染器 —— 保证“编辑态看到什么，运行态就是什么”。
 * sync() 做按 id 的差量更新：拖动时只改一个格子的 position，不整树重建，
 * 否则每次指针移动都会重挂载所有 canvas，手感会碎。
 */
import { allWidgets, findNode, type UiDoc, type UiNode } from './ui-doc';
import { createMissingWidget, widgetDef, type WidgetInstance, type WidgetDef } from './widgets';
import { resolveNode } from './bindings';

/**
 * 把栅格坐标翻译成 CSS `grid-area`。
 * 简写顺序是 row-start / column-start / row-end / column-end —— 写反了的表现是
 * 所有控件挤到左上角互相盖住，而不是报错，所以这条规则只允许存在这一处实现。
 */
export function gridAreaOf(rect: { x: number; y: number; w: number; h: number }): string {
  return `${rect.y + 1} / ${rect.x + 1} / span ${rect.h} / span ${rect.w}`;
}

interface Cell {
  el: HTMLElement;
  content: HTMLElement;
  instance: WidgetInstance;
  propsKey: string;
  gridKey: string;
  bindKey: string;
  type: string;
}

export interface DocRuntimeOptions {  container: HTMLElement;
  extraWidgets?: WidgetDef[];
  /** 数据刷新节拍；0 = 只在 sync 时画一次 */
  tickMs?: number;
  onSelect?: (nodeId: string) => void;
}

export class DocRuntime {
  private readonly cells = new Map<string, Cell>();
  private readonly container: HTMLElement;
  private readonly extraWidgets: WidgetDef[];
  private readonly tickMs: number;
  private timer: number | null = null;
  private doc: UiDoc | null = null;
  private selected = '';
  private onSelect?: (nodeId: string) => void;
  private interactive = false;

  constructor(options: DocRuntimeOptions) {
    this.container = options.container;
    this.extraWidgets = options.extraWidgets || [];
    this.tickMs = options.tickMs == null ? 250 : options.tickMs;
    this.onSelect = options.onSelect;
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    this.container.dataset.interactive = interactive ? '1' : '0';
  }

  setSelected(nodeId: string): void {
    if (this.selected === nodeId) return;
    this.selected = nodeId;
    for (const [id, cell] of this.cells) cell.el.classList.toggle('is-selected', id === nodeId);
  }

  get nodeCount(): number {
    return this.cells.size;
  }

  sync(doc: UiDoc): void {
    this.doc = doc;
    this.container.style.setProperty('--dsg-cols', String(doc.cols));
    this.container.style.setProperty('--dsg-row', doc.rowHeight + 'px');
    const widgets = allWidgets(doc.root);
    const seen = new Set<string>();

    for (const node of widgets) {
      seen.add(node.id);
      const existing = this.cells.get(node.id);
      if (existing && existing.type === node.type) {
        this.updateCell(existing, node);
      } else {
        if (existing) this.dropCell(node.id);
        this.createCell(node);
      }
    }
    for (const id of Array.from(this.cells.keys())) {
      if (!seen.has(id)) this.dropCell(id);
    }
    this.container.dataset.empty = widgets.length ? '0' : '1';
    // 画布高度跟着内容走：固定 640px 会让两行控件的看板下方空出一大片。
    // 留两行余量给拖入，避免刚好贴着底边。
    const maxRow = widgets.reduce((max, node) => Math.max(max, node.grid.y + node.grid.h), 0);
    const rows = Math.max(5, maxRow + 2);
    this.container.style.minHeight = `${rows * (doc.rowHeight + 10) + 12}px`;
    this.setSelected(this.selected);
    this.restartTicker();
  }

  private gridStyle(node: UiNode): string {
    return gridAreaOf(node.grid);
  }

  private createCell(node: UiNode): void {
    const el = document.createElement('div');
    el.className = 'dsg-cell';
    el.dataset.nodeId = node.id;
    el.style.gridArea = this.gridStyle(node);
    const head = document.createElement('div');
    head.className = 'dsg-cell-head';
    head.dataset.role = 'drag';
    const label = document.createElement('span');
    label.className = 'dsg-cell-label';
    const def = widgetDef(node.type, this.extraWidgets);
    label.textContent = def ? def.label : node.type.replace('widget.', '');
    head.appendChild(label);
    const actions = document.createElement('div');
    actions.className = 'dsg-cell-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.dataset.role = 'delete';
    del.title = '删除控件';
    actions.appendChild(del);
    head.appendChild(actions);

    const content = document.createElement('div');
    content.className = 'dsg-cell-content';
    const resize = document.createElement('div');
    resize.className = 'dsg-cell-resize';
    resize.dataset.role = 'resize';

    el.append(head, content, resize);
    el.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).dataset.role !== 'drag') {
        this.onSelect?.(node.id);
      }
    });

    const instance = def
      ? def.create({
          el: content,
          props: { ...def.defaults, ...node.props },
          // 每次取数都回查当前文档：导入/撤销会换掉节点对象，闭包不能抓着旧的那份
          series: () => {
            const current = this.doc ? findNode(this.doc.root, node.id) : null;
            return current ? resolveNode(this.doc as UiDoc, current).series : [];
          }
        })
      : createMissingWidget(content, node.type);
    this.cells.set(node.id, {
      el,
      content,
      instance,
      propsKey: JSON.stringify(node.props),
      gridKey: this.gridStyle(node),
      bindKey: Array.isArray(node.bind) ? node.bind.join('|') : '',
      type: node.type
    });
    this.container.appendChild(el);
  }

  private updateCell(cell: Cell, node: UiNode): void {
    const gridKey = this.gridStyle(node);
    if (gridKey !== cell.gridKey) {
      cell.el.style.gridArea = gridKey;
      cell.gridKey = gridKey;
      // 尺寸变了必须重画，canvas 的像素尺寸是跟容器绑的
      cell.instance.resize();
    }
    const propsKey = JSON.stringify(node.props);
    if (propsKey !== cell.propsKey) {
      cell.propsKey = propsKey;
      cell.instance.setProps(node.props);
    }
    // 绑定表变了不会体现在 props 上，但必须立刻重画
    const bindKey = Array.isArray(node.bind) ? node.bind.join('|') : '';
    if (bindKey !== cell.bindKey) {
      cell.bindKey = bindKey;
      cell.instance.render();
    }
  }

  private dropCell(nodeId: string): void {
    const cell = this.cells.get(nodeId);
    if (!cell) return;
    try {
      cell.instance.dispose();
    } catch (err) {
      console.warn('[XHGCS_CORE] 释放控件失败', err);
    }
    cell.el.remove();
    this.cells.delete(nodeId);
    if (this.selected === nodeId) this.selected = '';
  }

  private restartTicker(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.tickMs) return;
    this.timer = window.setInterval(() => {
      for (const cell of this.cells.values()) {
        try {
          cell.instance.render();
        } catch (err) {
          console.warn('[XHGCS_CORE] 控件渲染失败', err);
        }
      }
    }, this.tickMs);
  }

  /** 兼容旧调用：整份重画。 */
  refresh(): void {
    if (this.doc) this.sync(this.doc);
  }

  get isInteractive(): boolean {
    return this.interactive;
  }

  dispose(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    for (const id of Array.from(this.cells.keys())) this.dropCell(id);
  }
}
