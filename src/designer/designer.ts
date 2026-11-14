/**
 * 可视化设计器。
 *
 * 目标不是“做个拖拽 demo”，而是让界面本身变成可编辑的产物：
 *   - 控件库来自贡献点（内置 7 个 + 插件贡献的任意控件）；
 *   - 属性面板由控件的 propSchema 生成，加控件不用改设计器；
 *   - 每次改动都进命令历史，Ctrl+Z 能一步步退回去；
 *   - 文档是纯 JSON，能存、能导出、能导入、能被 AI 生成。
 *
 * 交互刻意用 Pointer Events 而不是 HTML5 拖放：后者在 Electron 与浏览器之间语义不一致，
 * 也没法优雅表达“插入位置”和实时预览。
 */
import {
  GRID_COLS,
  ROW_HEIGHT,
  createDoc,
  findNode,
  findParent,
  findFreeSlot,
  nextNodeId,
  serializeDoc,
  type UiBinding,
  type UiDoc,
  type UiNode
} from './ui-doc';
import {
  Coalescer,
  UiHistory,
  bindingsCommand,
  duplicateNode,
  insertNodeCommand,
  moveNodeCommand,
  propsCommand,
  removeNodeCommand
} from './history';
import { DocRuntime, gridAreaOf } from './renderer';
import { pushOverlay } from '../core/overlay-stack';
import { openBoard } from './board';
import {
  BOARD_STORAGE_KEYS,
  activeBoard,
  activeDoc,
  createBoard,
  deleteBoard,
  duplicateBoard,
  importDoc,
  listBoards,
  saveDoc,
  switchTo
} from './board-store';
import { BUILTIN_WIDGETS, widgetDef, type PropSpec, type WidgetDef } from './widgets';
import { currentChannels } from './data-access';
import {
  bindingsForChannels,
  bindingsForQuery,
  bindingTransformOf,
  bindingsOf,
  describeBinding,
  resolveNode
} from './bindings';
import { host, env } from '../core/runtime';
import { registry } from '../core/registry';

const STYLE_ID = 'xhgcs-designer-style';

interface DesignerState {
  mask: HTMLElement;
  doc: UiDoc;
  runtime: DocRuntime;
  history: UiHistory;
  selected: string;
  preview: boolean;
  canvas: HTMLElement;
  props: HTMLElement;
  palette: HTMLElement;
  close: () => void;
}

let active: DesignerState | null = null;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ---- 外壳 ---- */
.dsg-mask{position:fixed;inset:0;z-index:9700;background:radial-gradient(1200px 600px at 50% -10%,rgba(56,120,180,.10),transparent 60%),rgba(4,7,12,.66);
  backdrop-filter:blur(6px) saturate(1.05);display:flex;align-items:center;justify-content:center;animation:dsg-fade .16s ease;
  /* 窗口按钮已改为渲染层自绘，系统不再往页面上层画，这里只留一点呼吸边距 */
  padding:12px;box-sizing:border-box}
@keyframes dsg-fade{from{opacity:0}to{opacity:1}}
.dsg-shell{width:min(1520px,96vw);height:min(940px,calc(100vh - 24px));display:flex;flex-direction:column;overflow:hidden;
  background:var(--surf-3,#242c36);border:1px solid var(--edge-hair,rgba(255,255,255,.10));
  border-radius:var(--r-overlay,16px);box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-top,blur(24px) saturate(150%))}
.dsg-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035));
  background:linear-gradient(180deg,rgba(255,255,255,.035),transparent)}
.dsg-title{width:156px;height:28px;box-sizing:border-box;border:1px solid transparent!important;border-radius:8px;background:transparent!important;color:var(--text-dim,#7d8896)!important;
  font-size:12px!important;font-weight:500!important;line-height:1;font-family:inherit;padding:0 9px;outline:none;transition:background .14s,border-color .14s,color .14s}
.dsg-title:hover{border-color:var(--line,#2d333b)!important;background:var(--bg3,#1f2731)!important;color:var(--text,#c9d4e0)!important}
.dsg-title:focus{border-color:var(--acc,#6da8d2)!important;background:rgba(var(--acc-rgb), .08)!important;color:var(--heading,#e6f2ff)!important;box-shadow:0 0 0 3px rgba(var(--acc-rgb), .14)}
.dsg-board-select{height:30px;max-width:170px;border-radius:9px;border:1px solid var(--edge-hair,rgba(255,255,255,.10));
  background:var(--surf-2,rgba(255,255,255,.04));color:var(--heading,#e6f2ff)!important;font-size:12px!important;font-weight:600!important;line-height:1;font-family:inherit;padding:0 8px;outline:none;cursor:pointer;
  transition:border-color .13s,background .13s}
.dsg-board-select:hover{border-color:rgba(var(--acc-rgb), .5);background:rgba(var(--acc-rgb), .10)}
.dsg-board-select:focus{border-color:var(--acc,#6da8d2)}
.dsg-btn-icon{width:30px;padding:0;justify-content:center;font-size:14px;line-height:1}
.dsg-head .dsg-spacer{flex:1 1 auto}
.dsg-btn{height:30px;padding:0 12px;border-radius:9px;border:1px solid var(--edge-hair,rgba(255,255,255,.10));background:var(--surf-2,rgba(30,37,45,.86));
  color:var(--text,#c9d4e0);font:12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  transition:background .14s,border-color .14s,color .14s,transform .1s}
.dsg-btn:hover:not(:disabled){border-color:var(--edge-soft,var(--edge-hair,rgba(255,255,255,.14)));color:var(--heading,#e6f2ff);background:var(--surf-3,rgba(52,44,37,.93))}
.dsg-btn:active:not(:disabled){transform:translateY(1px)}
.dsg-btn:focus-visible{outline:2px solid var(--acc,#6da8d2);outline-offset:1px}
.dsg-btn:disabled{opacity:.38;cursor:not-allowed}
.dsg-btn[data-primary="1"]{background:var(--acc,#6da8d2);border-color:var(--acc-line,rgba(209,142,92,.42));color:var(--on-acc,#04141f);font-weight:600;
  box-shadow:none}
.dsg-btn[data-primary="1"]:hover{background:var(--acc-solid,var(--acc,#6da8d2));color:var(--on-acc,#04141f);filter:brightness(1.04)}
.dsg-btn[data-on="1"]{border-color:var(--acc,#6da8d2);color:var(--acc,#6da8d2);background:rgba(var(--acc-rgb), .16)}
.dsg-body{flex:1 1 auto;display:flex;min-height:0}

/* ---- 控件库 ---- */
.dsg-palette{width:208px;flex:0 0 208px;border-right:0;box-shadow:var(--seam-x,inset -1px 0 0 rgba(255,255,255,.055));overflow:auto;padding:8px 10px 24px;
  background:rgba(255,255,255,.012)}
.dsg-group-head{position:sticky;top:0;z-index:1;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim,#7d8896);
  margin:10px -10px 4px;padding:8px 14px 4px;background:var(--bg2,#161b22)}
.dsg-pal-item{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:9px;cursor:grab;color:var(--text,#c9d4e0);
  font-size:12px;border:1px solid transparent;user-select:none;transition:background .13s,border-color .13s,transform .1s}
.dsg-pal-item:hover{background:rgba(var(--acc-rgb), .12);border-color:rgba(var(--acc-rgb), .35);color:var(--heading,#e6f2ff)}
.dsg-pal-item:active{transform:scale(.985);cursor:grabbing}
.dsg-pal-ico{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;
  background:rgba(var(--acc-rgb), .14);color:var(--acc,#6da8d2);font-size:12px;flex:0 0 auto}

/* ---- 画布 ---- */
.dsg-canvas-wrap{flex:1 1 auto;min-width:0;overflow:auto;padding:18px;background:
  linear-gradient(180deg,rgba(255,255,255,.014),transparent 120px),
  radial-gradient(circle at 1px 1px, rgba(255,255,255,.05) 1px, transparent 0) 0 0/24px 24px, var(--bg,#0d1117)}
.dsg-canvas{position:relative;display:grid;grid-template-columns:repeat(var(--dsg-cols,12),minmax(0,1fr));
  grid-auto-rows:var(--dsg-row,44px);gap:10px;min-height:640px;
  border:0;border-radius:var(--r-panel,12px);padding:12px;background:var(--surf-inset,rgba(2,5,9,.55));
  box-shadow:var(--elev-inset,inset 0 1px 3px rgba(0,0,0,.55));transition:background .15s}
.dsg-canvas:hover{background:var(--surf-inset,rgba(2,5,9,.55))}
.dsg-canvas[data-empty="1"]::after{content:'空画布';position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;color:var(--text-dim,#7d8896);font-size:13px;letter-spacing:.02em;pointer-events:none}

/* ---- 控件格 ---- */
.dsg-cell{position:relative;border:1px solid var(--edge-hair,rgba(255,255,255,.055));border-radius:var(--r-card,10px);overflow:hidden;
  background:var(--surf-2,rgba(30,37,45,.86));box-shadow:var(--elev-1,0 1px 2px rgba(0,0,0,.26));
  display:flex;flex-direction:column;min-width:0;min-height:0;transition:border-color .14s,box-shadow .14s,transform .14s}
.dsg-cell:hover{border-color:rgba(var(--acc-rgb), .42);box-shadow:var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.dsg-cell.is-selected{border-color:transparent;box-shadow:0 0 0 1.5px var(--acc,#6da8d2),var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.dsg-cell-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 8px;height:22px;cursor:grab;
  background:rgba(255,255,255,.06);border-bottom:1px solid var(--edge-hair,rgba(255,255,255,.05));font-size:10px;color:var(--text-dim,#7d8896);
  opacity:0;transition:opacity .14s;flex:0 0 auto}
.dsg-cell:hover .dsg-cell-head,.dsg-cell.is-selected .dsg-cell-head{opacity:1}
.dsg-cell.is-selected .dsg-cell-head{background:rgba(var(--acc-rgb), .20);color:var(--acc,#6da8d2)}
.dsg-cell-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsg-cell-actions button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0 3px;opacity:.65;
  border-radius:5px}
.dsg-cell-actions button:hover{opacity:1;color:var(--danger,#f87171);background:rgba(248,113,113,.14)}
.dsg-cell-content{flex:1 1 auto;min-height:0;position:relative}
.dsg-canvas[data-interactive="0"] .dsg-cell-content{pointer-events:none}
.dsg-cell-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;opacity:0;transition:opacity .14s;
  background:linear-gradient(135deg,transparent 42%,rgba(var(--acc-rgb), .75) 42%);border-bottom-right-radius:12px}
.dsg-cell:hover .dsg-cell-resize,.dsg-cell.is-selected .dsg-cell-resize{opacity:.9}
.dsg-missing{padding:12px;font-size:12px;color:var(--warn,#fbbf24);text-align:center;line-height:1.6}

/* ---- 属性面板 ---- */
.dsg-props{width:286px;flex:0 0 286px;border-left:0;box-shadow:var(--seam-x-r,inset 1px 0 0 rgba(255,255,255,.055));overflow:auto;padding:0 14px 28px;
  background:rgba(255,255,255,.012)}
.dsg-props-title{position:sticky;top:0;z-index:1;font-size:13px;font-weight:600;color:var(--heading,#e6f2ff);
  margin:0 -14px 10px;padding:13px 14px 9px;display:flex;align-items:center;gap:6px;
  background:var(--bg2,#161b22);backdrop-filter:blur(6px);
  border-bottom:1px solid rgba(255,255,255,.05)}
.dsg-props-title small{font-weight:400;color:var(--text-dim,#7d8896);font-size:10px}
.dsg-field{margin:0 0 12px}
.dsg-field label{display:block;font-size:11px;color:var(--text-dim,#7d8896);margin-bottom:5px;letter-spacing:.02em}
.dsg-field input[type="text"],.dsg-field input[type="number"],.dsg-field select{width:100%;height:30px;border-radius:8px;
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg2,#161b22);color:var(--text,#c9d4e0);font:12px/1 inherit;padding:0 9px;outline:none;
  transition:border-color .13s,background .13s,box-shadow .13s}
.dsg-field input:focus,.dsg-field select:focus{border-color:var(--acc,#6da8d2);background:rgba(var(--acc-rgb), .08);
  box-shadow:0 0 0 3px rgba(var(--acc-rgb), .14)}
.dsg-check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text,#c9d4e0);cursor:pointer}
.dsg-chlist{max-height:196px;overflow:auto;border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:9px;padding:5px;
  background:var(--well,rgba(0,0,0,.16))}
.dsg-chrow{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text,#c9d4e0);padding:4px 5px;cursor:pointer;border-radius:6px}
.dsg-chrow:hover{background:var(--bg3,#1f2731)}
.dsg-chdot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}
.dsg-help{font-size:10px;color:var(--text-dim,#7d8896);margin-top:4px;line-height:1.5}
.dsg-grid-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsg-grid-fields .dsg-field{margin:0}
.dsg-ghost{position:fixed;z-index:9800;pointer-events:none;padding:7px 11px;border-radius:9px;font-size:12px;
  background:rgba(var(--acc-rgb), .24);border:1px solid var(--acc,#6da8d2);color:var(--heading,#e6f2ff);backdrop-filter:blur(6px);
  box-shadow:0 10px 28px rgba(0,0,0,.4)}
.dsg-empty-note{color:var(--text-dim,#7d8896);font-size:12px;line-height:1.7;margin-top:14px;padding:12px;
  border:1px dashed var(--edge-soft,var(--edge-hair,rgba(255,255,255,.08)));border-radius:10px;background:var(--bg3,#1f2731)}
.dsg-stat{height:100%;display:flex;flex-direction:column;justify-content:center;padding:10px 14px;gap:3px}
.dsg-stat-title{font-size:11px;color:var(--text-dim,#7d8896);letter-spacing:.03em}
.dsg-stat-value{font-size:16px;font-weight:600;color:var(--text,#c9d4e0);font-variant-numeric:tabular-nums;line-height:1.1;
  letter-spacing:-.01em}
.dsg-stat-unit{font-size:12px;font-weight:400;color:var(--text-dim,#7d8896);margin-left:2px}
.dsg-stat-value[data-tone="ok"]{color:var(--ok,#34d399)}
.dsg-stat-value[data-tone="warn"]{color:var(--warn,#fbbf24)}
.dsg-stat-value[data-tone="danger"]{color:var(--danger,#f87171)}
.dsg-label{height:100%;display:flex;align-items:center;padding:0 10px;color:var(--text,#c9d4e0);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dsg-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9900;padding:9px 15px;border-radius:9px;
  background:var(--bg2,#161b22);border:1px solid var(--line,#2d333b);color:var(--heading,#e6f2ff);font-size:12px}
`;
  document.head.appendChild(style);
}

function loadDoc(): UiDoc {
  // 先看有没有 v2 库：没有就说明是首次运行或从 v1 迁移，迁移后若是空板就换成样板。
  // 注意顺序 —— activeDoc() 内部会把库建出来，所以“是否已有库”必须提前读。
  const hadStore = Boolean(localStorage.getItem(BOARD_STORAGE_KEYS.store));
  const doc = activeDoc();
  if (!hadStore) {
    const empty = !doc.root.children || doc.root.children.length === 0;
    if (empty) {
      const demo = demoDoc();
      saveDoc(demo);
      return demo;
    }
  }
  return doc;
}

/** 首次打开给一份能立刻看懂的样板，而不是空白画布。 */
function demoDoc(): UiDoc {
  const doc = createDoc('主看板');
  const channels = currentChannels().slice(0, 3).map((channel) => channel.id);
  const stats: Array<{ type: string; grid: UiNode['grid']; props: Record<string, unknown>; bind?: string[] }> = [
    { type: 'widget.stat', grid: { x: 0, y: 0, w: 3, h: 3 }, props: { title: '实时值' }, bind: channels.slice(0, 1) },
    { type: 'widget.gauge', grid: { x: 3, y: 0, w: 3, h: 4 }, props: {}, bind: channels.slice(0, 1) },
    { type: 'widget.scope', grid: { x: 6, y: 0, w: 6, h: 9 }, props: {}, bind: channels },
    { type: 'widget.table', grid: { x: 0, y: 4, w: 6, h: 5 }, props: {}, bind: channels }
  ];
  for (const item of stats) {
    const def = widgetDef(item.type);
    const id = nextNodeId();
    const node: UiNode = {
      id,
      type: item.type,
      props: { ...(def ? def.defaults : {}), ...item.props },
      grid: item.grid
    };
    if (item.bind && item.bind.length) {
      const generated = bindingsForChannels(item.bind);
      node.bind = generated.bind.map((key) => `${id}:${key}`);
      node.bind.forEach((scoped, index) => {
        doc.bindings[scoped] = generated.bindings[generated.bind[index]];
      });
    }
    doc.root.children?.push(node);
  }
  return doc;
}

function persistDoc(doc: UiDoc): void {
  try {
    if (!saveDoc(doc)) toast('保存失败：本机存储不可用或已满');
  } catch (err) {
    env.log('warn', '保存设计器文档失败', err);
    toast('保存失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/** 插件贡献的控件：清单里的 propSchema 转成设计器的 PropSpec。 */
function pluginWidgets(): WidgetDef[] {
  const out: WidgetDef[] = [];
  for (const entry of registry.all<Record<string, unknown>>('designerWidgets')) {
    const contribution = entry.value as {
      id: string;
      label: string;
      icon?: string;
      group?: string;
      defaultSize?: { w: number; h: number };
      minSize?: { w: number; h: number };
      propSchema?: Record<string, { type?: string; description?: string; minimum?: number; maximum?: number; step?: number; enum?: unknown[] }>;
      defaults?: Record<string, unknown>;
      exportName?: string;
    };
    const runtime = host.runtime.widgets.get(`${entry.owner}:${contribution.id}`) as
      | { implementation?: unknown }
      | undefined;
    const impl = runtime?.implementation as
      | ((ctx: { el: HTMLElement; props: Record<string, unknown> }) => unknown)
      | { create?: (ctx: { el: HTMLElement; props: Record<string, unknown> }) => unknown }
      | undefined;
    if (!impl) continue;
    const schema: PropSpec[] = [];
    for (const [key, spec] of Object.entries(contribution.propSchema || {})) {
      const type = String(spec.type || 'string');
      if (type === 'boolean') schema.push({ key, label: key, type: 'boolean' });
      else if (type === 'number' || type === 'integer')
        schema.push({ key, label: key, type: 'number', min: spec.minimum, max: spec.maximum, step: spec.step });
      else if (type === 'enum' && Array.isArray(spec.enum))
        schema.push({ key, label: key, type: 'select', options: spec.enum.map((value) => ({ value: String(value), label: String(value) })) });
      else schema.push({ key, label: key, type: 'text', help: spec.description });
    }
    out.push({
      type: `plugin:${contribution.id}`,
      label: contribution.label || contribution.id,
      icon: contribution.icon || '◈',
      group: contribution.group || '插件控件',
      defaultSize: contribution.defaultSize || { w: 4, h: 3 },
      minSize: contribution.minSize || { w: 2, h: 2 },
      defaults: contribution.defaults || {},
      propSchema: schema,
      create({ el, props }) {
        const factory = typeof impl === 'function' ? impl : impl.create;
        const instance = (factory ? factory({ el, props }) : null) as
          | { render?: () => void; resize?: () => void; setProps?: (next: Record<string, unknown>) => void; dispose?: () => void }
          | null;
        return {
          render: () => instance?.render?.(),
          resize: () => instance?.resize?.(),
          setProps: (next) => instance?.setProps?.(next),
          dispose: () => {
            instance?.dispose?.();
            el.replaceChildren();
          }
        };
      }
    });
  }
  return out;
}

function allWidgetDefs(): WidgetDef[] {
  return BUILTIN_WIDGETS.concat(pluginWidgets());
}

function toast(message: string): void {
  const el = document.createElement('div');
  el.className = 'dsg-toast';
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2200);
}

export function openDesigner(): void {
  if (active) return;
  ensureStyles();

  const doc = loadDoc();
  const history = new UiHistory();
  const extra = pluginWidgets();

  const mask = document.createElement('div');
  mask.className = 'dsg-mask';
  const shell = document.createElement('div');
  shell.className = 'dsg-shell';

  // ---- 头部 ----
  const head = document.createElement('div');
  head.className = 'dsg-head';
  const titleInput = document.createElement('input');
  titleInput.className = 'dsg-title';
  titleInput.value = doc.name;
  titleInput.title = '看板名称';

  // ---- 看板库切换器 ----
  const boardSelect = document.createElement('select');
  boardSelect.className = 'dsg-board-select';
  boardSelect.title = '切换看板';
  const fillBoardSelect = () => {
    boardSelect.replaceChildren();
    for (const board of listBoards()) {
      const option = document.createElement('option');
      option.value = board.id;
      option.textContent = board.name;
      option.selected = board.active;
      boardSelect.appendChild(option);
    }
  };
  fillBoardSelect();

  const btnNewBoard = document.createElement('button');
  btnNewBoard.className = 'dsg-btn dsg-btn-icon';
  btnNewBoard.textContent = '＋';
  btnNewBoard.title = '新建看板';
  const btnDupBoard = document.createElement('button');
  btnDupBoard.className = 'dsg-btn dsg-btn-icon';
  btnDupBoard.textContent = '⧉';
  btnDupBoard.title = '复制当前看板';
  const btnDelBoard = document.createElement('button');
  btnDelBoard.className = 'dsg-btn dsg-btn-icon';
  btnDelBoard.textContent = '🗑';
  btnDelBoard.title = '删除当前看板';

  const spacer = document.createElement('div');
  spacer.className = 'dsg-spacer';

  const btnUndo = document.createElement('button');
  btnUndo.className = 'dsg-btn';
  btnUndo.textContent = '↶ 撤销';
  btnUndo.title = 'Ctrl+Z';
  const btnRedo = document.createElement('button');
  btnRedo.className = 'dsg-btn';
  btnRedo.textContent = '↷ 重做';
  btnRedo.title = 'Ctrl+Shift+Z / Ctrl+Y';
  const btnPreview = document.createElement('button');
  btnPreview.className = 'dsg-btn';
  btnPreview.textContent = '▶ 预览';
  btnPreview.title = '切换到可交互预览，控件可以响应鼠标';
  const btnRun = document.createElement('button');
  btnRun.className = 'dsg-btn';
  btnRun.textContent = '⤢ 运行看板';
  btnRun.title = '用同一份文档进入全屏看板（Esc 退出）';
  const btnSave = document.createElement('button');
  btnSave.className = 'dsg-btn';
  btnSave.dataset.primary = '1';
  btnSave.textContent = '保存';
  const btnExport = document.createElement('button');
  btnExport.className = 'dsg-btn';
  btnExport.textContent = '导出';
  const btnImport = document.createElement('button');
  btnImport.className = 'dsg-btn';
  btnImport.textContent = '导入';
  const btnClose = document.createElement('button');
  btnClose.className = 'dsg-btn';
  btnClose.textContent = '✕';
  btnClose.title = '关闭（Esc）';

  head.append(titleInput, boardSelect, btnNewBoard, btnDupBoard, btnDelBoard, spacer, btnUndo, btnRedo, btnPreview, btnRun, btnSave, btnExport, btnImport, btnClose);

  // ---- 主体 ----
  const body = document.createElement('div');
  body.className = 'dsg-body';
  const palette = document.createElement('div');
  palette.className = 'dsg-palette';
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'dsg-canvas-wrap';
  const canvas = document.createElement('div');
  canvas.className = 'dsg-canvas';
  canvas.dataset.interactive = '0';
  canvasWrap.appendChild(canvas);
  const props = document.createElement('div');
  props.className = 'dsg-props';
  body.append(palette, canvasWrap, props);
  shell.append(head, body);
  mask.appendChild(shell);
  document.body.appendChild(mask);

  const runtime = new DocRuntime({
    container: canvas,
    extraWidgets: extra,
    tickMs: 250,
    onSelect: (id) => select(id)
  });

  const state: DesignerState = {
    mask,
    doc,
    runtime,
    history,
    selected: '',
    preview: false,
    canvas,
    props,
    palette,
    close: () => undefined
  };
  active = state;

  const refreshToolbar = () => {
    btnUndo.disabled = !history.canUndo;
    btnRedo.disabled = !history.canRedo;
    btnUndo.title = history.canUndo ? '撤销：' + history.undoLabel : '没有可撤销的操作';
  };

  const redraw = () => {
    doc.updatedAt = Date.now();
    runtime.sync(doc);
    refreshToolbar();
  };

  const commit = (command: Parameters<UiHistory['push']>[0]) => {
    command.do(doc);
    history.push(command);
    redraw();
  };

  let detachBoardListener: () => void = () => undefined;
  let disposeOverlayRef: () => void = () => undefined;
  // 关闭语义：默认「关闭即保存」（与切换看板一致），避免搭了半天按 Esc 就丢。
  // 外部补丁触发的重开用 save:false —— 那份文档已经被 store 里的新版本取代，不能再写回旧内容。
  const close = (options: { save?: boolean } = {}) => {
    if (options.save !== false) {
      try {
        if (!saveDoc(doc)) toast('关闭前保存失败：本机存储不可用或已满');
      } catch (err) {
        env.log('warn', '关闭前保存失败', err);
      }
    }
    window.removeEventListener('pagehide', onPageHide);
    detachBoardListener();
    disposeOverlayRef();
    window.removeEventListener('keydown', onKey, true);
    runtime.dispose();
    mask.remove();
    active = null;
  };
  state.close = close;

  // 刷新/关窗时再兜一次：pagehide 里 localStorage 写入是同步的，来得及
  const onPageHide = () => {
    try {
      saveDoc(doc);
    } catch (err) {
      /* 页面正在销毁，只能尽力 */
    }
  };
  window.addEventListener('pagehide', onPageHide);

  // 外部（AI 补丁 / MCP / 回退）改了当前看板：直接重开设计器，保证看到的是磁盘上的真身。
  // 自己保存不派发这个事件，所以不会自触发。
  const onBoardChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: string }>).detail || {};
    const current = activeBoard();
    if (detail.id && detail.id !== current.id) return;
    close({ save: false });
    openDesigner();
  };
  document.addEventListener('xhgcs:board-changed', onBoardChanged);
  detachBoardListener = () => document.removeEventListener('xhgcs:board-changed', onBoardChanged);

  // 设计器自己是浮层栈的一层：Esc 先让输入框失焦、再取消选中，最后才关；
  // 上面叠了看板时，栈顶是看板，设计器完全不会被波及。
  disposeOverlayRef = pushOverlay({
    id: 'designer',
    kind: 'modal',
    onEscape: () => {
      const activeEl = document.activeElement as HTMLElement | null;
      const tag = activeEl ? activeEl.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        activeEl?.blur();
        return true;
      }
      if (state.selected) {
        select('');
        return true;
      }
      return false;
    },
    close
  });

  // ---- 控件库 ----
  const buildPalette = () => {
    palette.replaceChildren();
    const defs = allWidgetDefs();
    const groups = new Map<string, WidgetDef[]>();
    for (const def of defs) {
      const list = groups.get(def.group) || [];
      list.push(def);
      groups.set(def.group, list);
    }
    for (const [group, list] of groups) {
      const headEl = document.createElement('div');
      headEl.className = 'dsg-group-head';
      headEl.textContent = group;
      palette.appendChild(headEl);
      for (const def of list) {
        const item = document.createElement('div');
        item.className = 'dsg-pal-item';
        item.dataset.widgetType = def.type;
        const icon = document.createElement('span');
        icon.className = 'dsg-pal-ico';
        icon.textContent = def.icon;
        const label = document.createElement('span');
        label.textContent = def.label;
        item.append(icon, label);
        item.addEventListener('pointerdown', (event) => beginPaletteDrag(event, def));
        palette.appendChild(item);
      }
    }
  };

  const addWidget = (def: WidgetDef, rect?: { x: number; y: number; w: number; h: number }) => {
    const slot = rect || findFreeSlot(doc.root, def.defaultSize.w, def.defaultSize.h, doc.cols);
    const node: UiNode = {
      id: nextNodeId(),
      type: def.type,
      props: { ...def.defaults },
      grid: { x: slot.x, y: slot.y, w: Math.max(def.minSize.w, def.defaultSize.w), h: Math.max(def.minSize.h, def.defaultSize.h) }
    };
    commit(insertNodeCommand(doc.root.id, node));
    select(node.id);
  };

  // ---- 从控件库拖入 ----
  let ghost: HTMLElement | null = null;
  const beginPaletteDrag = (event: PointerEvent, def: WidgetDef) => {
    event.preventDefault();
    ghost = document.createElement('div');
    ghost.className = 'dsg-ghost';
    ghost.textContent = def.icon + ' ' + def.label;
    document.body.appendChild(ghost);
    ghost.style.left = event.clientX + 12 + 'px';
    ghost.style.top = event.clientY + 10 + 'px';
    const move = (e: PointerEvent) => {
      if (!ghost) return;
      ghost.style.left = e.clientX + 12 + 'px';
      ghost.style.top = e.clientY + 10 + 'px';
    };
    const up = (e: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      ghost?.remove();
      ghost = null;
      const rect = canvas.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (inside) {
        const cell = cellFromPoint(e.clientX, e.clientY);
        addWidget(def, { x: cell.x, y: cell.y, w: def.defaultSize.w, h: def.defaultSize.h });
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const metrics = () => {
    const rect = canvas.getBoundingClientRect();
    const gap = 10;
    const cellW = (rect.width - gap * (doc.cols - 1) - 20) / doc.cols;
    return { rect, gap, cellW, cellH: doc.rowHeight, stepX: cellW + gap, stepY: doc.rowHeight + gap };
  };

  const cellFromPoint = (clientX: number, clientY: number) => {
    const m = metrics();
    const x = clientX - m.rect.left - 10;
    const y = clientY - m.rect.top - 10;
    return {
      x: Math.max(0, Math.min(doc.cols - 1, Math.floor(x / m.stepX))),
      y: Math.max(0, Math.floor(y / m.stepY))
    };
  };

  // ---- 拖动 / 缩放 ----
  const beginMove = (event: PointerEvent, node: UiNode, cellEl: HTMLElement) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const m = metrics();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...node.grid };
    let next = { ...origin };
    let moved = false;
    select(node.id);
    const move = (e: PointerEvent) => {
      const dx = Math.round((e.clientX - startX) / m.stepX);
      const dy = Math.round((e.clientY - startY) / m.stepY);
      next = {
        x: Math.max(0, Math.min(doc.cols - origin.w, origin.x + dx)),
        y: Math.max(0, origin.y + dy),
        w: origin.w,
        h: origin.h
      };
      if (next.x !== origin.x || next.y !== origin.y) moved = true;
      cellEl.style.gridArea = gridAreaOf(next);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!moved) return;
      commit(moveNodeCommand(node.id, next, '移动控件'));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const beginResize = (event: PointerEvent, node: UiNode, cellEl: HTMLElement) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const def = widgetDef(node.type, extra);
    const min = def ? def.minSize : { w: 1, h: 1 };
    const m = metrics();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...node.grid };
    let next = { ...origin };
    let resized = false;
    const move = (e: PointerEvent) => {
      const dw = Math.round((e.clientX - startX) / m.stepX);
      const dh = Math.round((e.clientY - startY) / m.stepY);
      next = {
        x: origin.x,
        y: origin.y,
        w: Math.max(min.w, Math.min(doc.cols - origin.x, origin.w + dw)),
        h: Math.max(min.h, origin.h + dh)
      };
      if (next.w !== origin.w || next.h !== origin.h) resized = true;
      cellEl.style.gridArea = gridAreaOf(next);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!resized) return;
      commit(moveNodeCommand(node.id, next, '调整控件大小'));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // 事件委托：格子头拖动、右下角缩放、删除按钮
  canvas.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const cellEl = target.closest('.dsg-cell') as HTMLElement | null;
    if (!cellEl) return;
    const nodeId = cellEl.dataset.nodeId || '';
    const node = findNode(doc.root, nodeId);
    if (!node) return;
    if (target.dataset.role === 'delete') {
      event.stopPropagation();
      commit(removeNodeCommand(nodeId));
      select('');
      return;
    }
    if (state.preview) return;
    select(nodeId);
    if (target.dataset.role === 'resize') beginResize(event, node, cellEl);
    else if (target.dataset.role === 'drag' || target === cellEl) beginMove(event, node, cellEl);
  });

  // ---- 选中与属性面板 ----
  const select = (nodeId: string) => {
    state.selected = nodeId;
    runtime.setSelected(nodeId);
    renderProps();
  };

  const updateNodeProps = (nodeId: string, patch: Record<string, unknown>, coalesceKey = '') => {
    const node = findNode(doc.root, nodeId);
    if (!node) return;
    if (coalesceKey) {
      const merges = coalescer.shouldMerge(nodeId + ':' + coalesceKey);
      if (merges) {
        node.props = { ...node.props, ...patch };
        runtime.sync(doc);
        return;
      }
    }
    commit(propsCommand(nodeId, patch));
  };

  const coalescer = new Coalescer(500);

  const field = (labelText: string, control: HTMLElement, help?: string): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'dsg-field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, control);
    if (help) {
      const hint = document.createElement('div');
      hint.className = 'dsg-help';
      hint.textContent = help;
      wrap.appendChild(hint);
    }
    return wrap;
  };

  const renderProps = () => {
    props.replaceChildren();
    const title = document.createElement('div');
    title.className = 'dsg-props-title';
    const node = state.selected ? findNode(doc.root, state.selected) : null;
    if (!node) {
      title.append(document.createTextNode('看板设置'));
      props.appendChild(title);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = doc.name;
      nameInput.addEventListener('change', () => {
        doc.name = nameInput.value.trim() || doc.name;
        titleInput.value = doc.name;
        redraw();
      });
      props.appendChild(field('名称', nameInput));

      const colsInput = document.createElement('input');
      colsInput.type = 'number';
      colsInput.min = '4';
      colsInput.max = '24';
      colsInput.value = String(doc.cols);
      colsInput.addEventListener('change', () => {
        doc.cols = Math.max(4, Math.min(24, Number(colsInput.value) || GRID_COLS));
        redraw();
      });
      props.appendChild(field('栅格列数', colsInput));

      const rowInput = document.createElement('input');
      rowInput.type = 'number';
      rowInput.min = '24';
      rowInput.max = '120';
      rowInput.step = '4';
      rowInput.value = String(doc.rowHeight);
      rowInput.addEventListener('change', () => {
        doc.rowHeight = Math.max(24, Math.min(120, Number(rowInput.value) || ROW_HEIGHT));
        redraw();
      });
      props.appendChild(field('行高（px）', rowInput));

      const note = document.createElement('div');
      note.className = 'dsg-empty-note';
      note.textContent = '未选中控件';
      props.appendChild(note);
      return;
    }

    const def = widgetDef(node.type, extra);
    // 节点 id 来自导入的 JSON，不能拼进 innerHTML（存储型 XSS）；一律用 textContent 组装
    title.append(
      document.createTextNode((def ? def.label : node.type) + ' '),
      Object.assign(document.createElement('small'), { textContent: node.id })
    );
    props.appendChild(title);

    if (!def) {
      const note = document.createElement('div');
      note.className = 'dsg-empty-note';
      note.textContent = '未知控件类型，节点已保留但无法编辑属性。';
      props.appendChild(note);
      return;
    }

    for (const spec of def.propSchema) {
      props.appendChild(buildPropField(node, spec));
    }
    props.appendChild(buildBindingEditor(node));

    const gridTitle = document.createElement('div');
    gridTitle.className = 'dsg-group-head';
    gridTitle.textContent = '位置与尺寸';
    props.appendChild(gridTitle);
    const gridWrap = document.createElement('div');
    gridWrap.className = 'dsg-grid-fields';
    (['x', 'y', 'w', 'h'] as const).forEach((key) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = key === 'w' || key === 'h' ? '1' : '0';
      input.value = String(node.grid[key]);
      const wrap = document.createElement('div');
      wrap.className = 'dsg-field';
      const label = document.createElement('label');
      label.textContent = { x: '列', y: '行', w: '宽', h: '高' }[key];
      wrap.append(label, input);
      input.addEventListener('change', () => {
        const next = { ...node.grid, [key]: Number(input.value) || 0 };
        commit(moveNodeCommand(node.id, next, '修改位置'));
      });
      gridWrap.appendChild(wrap);
    });
    props.appendChild(gridWrap);
  };

  const applyBindings = (node: UiNode, next: { bind: string[]; bindings: Record<string, UiBinding> }): void => {
    // 绑定 key 必须带节点前缀：两个控件各自用 b1 会互相覆盖
    const scopedBindings: Record<string, UiBinding> = {};
    const scopedBind = next.bind.map((key) => {
      const scoped = `${node.id}:${key}`;
      scopedBindings[scoped] = next.bindings[key];
      return scoped;
    });
    commit(bindingsCommand(node.id, scopedBind, scopedBindings));
  };

  const transformFromInputs = (fn: string, amount: number): UiBinding['transform'] | undefined => {
    if (!fn) return undefined;
    if (fn === 'window') return { fn: 'window', args: { limit: Math.max(10, Math.min(2000, amount || 120)) } };
    if (fn === 'normalize') return { fn: 'normalize' };
    if (fn === 'scale') return { fn: 'scale', args: { factor: Number.isFinite(amount) ? amount : 1 } };
    return undefined;
  };

  /** 数据绑定编辑器：选通道/名字匹配 + 变换，写进 doc.bindings 而不是控件 props。 */
  const buildBindingEditor = (node: UiNode): HTMLElement => {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'dsg-group-head';
    head.textContent = '数据绑定';
    wrap.appendChild(head);

    const current = bindingsOf(doc, node);
    const summary = document.createElement('div');
    summary.className = 'dsg-help';
    summary.style.whiteSpace = 'pre-line';
    summary.textContent = current.length ? current.map(describeBinding).join('\n') : '未绑定 · 默认取前三条通道';
    wrap.appendChild(summary);

    const currentTransform = bindingTransformOf(doc, node);
    const transformFn = currentTransform ? currentTransform.fn : '';
    const transformAmount =
      currentTransform && currentTransform.args
        ? Number(currentTransform.fn === 'scale' ? currentTransform.args.factor : currentTransform.args.limit) || 0
        : 0;

    const transformSelect = document.createElement('select');
    [
      { value: '', label: '原始值' },
      { value: 'window', label: '最近 N 点' },
      { value: 'normalize', label: '归一化 0-1' },
      { value: 'scale', label: '线性缩放' }
    ].forEach((option) => {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      transformSelect.appendChild(el);
    });
    transformSelect.value = transformFn;
    wrap.appendChild(field('变换', transformSelect));

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.value = String(transformAmount || (transformFn === 'scale' ? 1 : 120));
    const amountField = field(transformFn === 'scale' ? '缩放系数' : '点数', amountInput);
    amountField.hidden = transformFn !== 'window' && transformFn !== 'scale';
    wrap.appendChild(amountField);

    const readTransform = (): UiBinding['transform'] | undefined =>
      transformFromInputs(transformSelect.value, Number(amountInput.value));

    transformSelect.addEventListener('change', () => {
      amountField.hidden = transformSelect.value !== 'window' && transformSelect.value !== 'scale';
      const transform = readTransform();
      const existing = bindingsOf(doc, node);
      const channelIds = existing.filter((item) => item.source === 'channel' && typeof item.ref === 'string').map((item) => String(item.ref));
      if (channelIds.length) applyBindings(node, bindingsForChannels(channelIds, transform));
      else renderProps();
    });
    amountInput.addEventListener('change', () => {
      const transform = readTransform();
      const existing = bindingsOf(doc, node);
      const channelIds = existing.filter((item) => item.source === 'channel' && typeof item.ref === 'string').map((item) => String(item.ref));
      if (channelIds.length) applyBindings(node, bindingsForChannels(channelIds, transform));
    });

    const sourceSelect = document.createElement('select');
    [
      { value: 'channel', label: '按通道选择' },
      { value: 'query', label: '按名字匹配' }
    ].forEach((option) => {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      sourceSelect.appendChild(el);
    });
    const usingQuery = current.length > 0 && current.every((item) => item.source === 'query');
    sourceSelect.value = usingQuery ? 'query' : 'channel';
    wrap.appendChild(field('来源', sourceSelect));

    const channelBox = document.createElement('div');
    channelBox.className = 'dsg-field';
    const channelLabel = document.createElement('label');
    channelLabel.textContent = '绑定通道';
    const list = document.createElement('div');
    list.className = 'dsg-chlist';
    channelBox.append(channelLabel, list);
    wrap.appendChild(channelBox);

    const queryBox = document.createElement('div');
    queryBox.className = 'dsg-field';
    const queryInput = document.createElement('input');
    queryInput.type = 'text';
    queryInput.placeholder = '名字/ID 子串，* 表示全部';
    queryInput.value = usingQuery && current[0] ? String(current[0].ref) : '';
    const applyQuery = document.createElement('button');
    applyQuery.className = 'dsg-btn';
    applyQuery.textContent = '应用匹配';
    applyQuery.style.marginTop = '6px';
    applyQuery.addEventListener('click', () => {
      const text = queryInput.value.trim();
      if (!text) return;
      applyBindings(node, bindingsForQuery(text, readTransform()));
    });
    queryBox.append(field('匹配规则', queryInput), applyQuery);
    queryBox.hidden = sourceSelect.value !== 'query';
    wrap.appendChild(queryBox);

    const selectedIds = new Set(
      current.filter((item) => item.source === 'channel' && typeof item.ref === 'string').map((item) => String(item.ref))
    );
    const channels = currentChannels();
    if (!channels.length) {
      const empty = document.createElement('div');
      empty.className = 'dsg-help';
      empty.textContent = '当前没有通道';
      list.appendChild(empty);
    }
    channels.forEach((channel) => {
      const row = document.createElement('label');
      row.className = 'dsg-chrow';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selectedIds.has(channel.id);
      const dot = document.createElement('span');
      dot.className = 'dsg-chdot';
      dot.style.background = channel.color || '#6da8d2';
      const text = document.createElement('span');
      text.textContent = (channel.name || channel.id) + (channel.unit ? ' (' + channel.unit + ')' : '');
      box.addEventListener('change', () => {
        if (box.checked) selectedIds.add(channel.id);
        else selectedIds.delete(channel.id);
        applyBindings(node, bindingsForChannels(Array.from(selectedIds), readTransform()));
      });
      row.append(box, dot, text);
      list.appendChild(row);
    });

    sourceSelect.addEventListener('change', () => {
      const queryMode = sourceSelect.value === 'query';
      channelBox.hidden = queryMode;
      queryBox.hidden = !queryMode;
    });
    channelBox.hidden = sourceSelect.value === 'query';

    const clear = document.createElement('button');
    clear.className = 'dsg-btn';
    clear.textContent = '清除绑定';
    clear.style.marginTop = '8px';
    clear.addEventListener('click', () => {
      commit(bindingsCommand(node.id, [], {}));
    });
    wrap.appendChild(clear);

    const issues = doc ? resolveIssues(node) : [];
    if (issues.length) {
      const warn = document.createElement('div');
      warn.className = 'dsg-help';
      warn.style.color = 'var(--warn, #fbbf24)';
      warn.textContent = issues.join('\n');
      warn.style.whiteSpace = 'pre-line';
      wrap.appendChild(warn);
    }

    return wrap;
  };

  const resolveIssues = (node: UiNode): string[] => {
    try {
      return resolveNode(doc, node).issues.map((issue) => issue.message);
    } catch {
      return [];
    }
  };

  const buildPropField = (node: UiNode, spec: PropSpec): HTMLElement => {
    const value = node.props[spec.key];
    if (spec.type === 'boolean') {
      const wrap = document.createElement('div');
      wrap.className = 'dsg-field';
      const label = document.createElement('label');
      label.className = 'dsg-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value !== false && value !== undefined ? Boolean(value) : Boolean(value);
      input.checked = Boolean(value);
      input.addEventListener('change', () => updateNodeProps(node.id, { [spec.key]: input.checked }));
      const text = document.createElement('span');
      text.textContent = spec.label;
      label.append(input, text);
      wrap.appendChild(label);
      if (spec.help) {
        const hint = document.createElement('div');
        hint.className = 'dsg-help';
        hint.textContent = spec.help;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    if (spec.type === 'select') {
      const selectEl = document.createElement('select');
      for (const option of spec.options || []) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        selectEl.appendChild(optionEl);
      }
      selectEl.value = String(value ?? '');
      selectEl.addEventListener('change', () => updateNodeProps(node.id, { [spec.key]: selectEl.value }));
      return field(spec.label, selectEl, spec.help);
    }

    if (spec.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      if (spec.min != null) input.min = String(spec.min);
      if (spec.max != null) input.max = String(spec.max);
      if (spec.step != null) input.step = String(spec.step);
      input.value = value == null ? '' : String(value);
      input.addEventListener('input', () => updateNodeProps(node.id, { [spec.key]: Number(input.value) || 0 }, spec.key));
      return field(spec.label, input, spec.help);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value == null ? '' : String(value);
    input.addEventListener('change', () => updateNodeProps(node.id, { [spec.key]: input.value }));
    return field(spec.label, input, spec.help);
  };

  // ---- 工具栏动作 ----
  titleInput.addEventListener('change', () => {
    doc.name = titleInput.value.trim() || doc.name;
    titleInput.value = doc.name;
  });
  btnUndo.addEventListener('click', () => {
    if (history.undo(doc)) redraw();
  });
  btnRedo.addEventListener('click', () => {
    if (history.redo(doc)) redraw();
  });
  btnPreview.addEventListener('click', () => {
    state.preview = !state.preview;
    runtime.setInteractive(state.preview);
    canvas.dataset.interactive = state.preview ? '1' : '0';
    btnPreview.dataset.on = state.preview ? '1' : '0';
    btnPreview.textContent = state.preview ? '✎ 编辑' : '▶ 预览';
    canvas.classList.toggle('is-preview', state.preview);
  });
  btnSave.addEventListener('click', () => {
    persistDoc(doc);
    toast('已保存到本机：' + doc.name);
  });
  btnRun.addEventListener('click', () => {
    persistDoc(doc);
    close();
    if (!openBoard({ doc, widgets: extra })) toast('看板启动失败：没有文档');
  });
  btnExport.addEventListener('click', () => {
    const blob = new Blob([serializeDoc(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = doc.name.replace(/[\\/:*?"<>|]/g, '_') + '.xhgcs.ui.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  btnImport.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const text = await file.text();
      // 导入 = 在库里新建一块板并切过去（不再覆盖当前板，避免手滑毁掉正在编辑的内容）
      const result = importDoc(text);
      if (!result.ok) {
        toast('导入失败：' + (result.error || '不是合法的 XHGCS UI 文档'));
        return;
      }
      close();
      openDesigner();
    });
    input.click();
  });

  // ---- 看板库操作 ----
  boardSelect.addEventListener('change', () => {
    persistDoc(doc);
    const next = switchTo(boardSelect.value);
    if (!next) {
      toast('切换失败：看板不存在');
      fillBoardSelect();
      return;
    }
    close();
    openDesigner();
  });
  btnNewBoard.addEventListener('click', () => {
    persistDoc(doc);
    try {
      createBoard('看板 ' + (listBoards().length + 1));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return;
    }
    close();
    openDesigner();
  });
  btnDupBoard.addEventListener('click', () => {
    persistDoc(doc);
    try {
      duplicateBoard(activeBoard().id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return;
    }
    close();
    openDesigner();
  });
  btnDelBoard.addEventListener('click', () => {
    const current = activeBoard();
    if (!window.confirm(`删除看板「${current.name}」？此操作不可撤销。`)) return;
    const result = deleteBoard(current.id);
    if (!result.ok) {
      toast(result.error || '删除失败');
      return;
    }
    close();
    openDesigner();
  });

  btnClose.addEventListener('click', () => close());

  // ---- 键盘 ----
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    // 文本输入才算“正在编辑”；复选框/下拉不该吞掉 Ctrl+Z —— 否则勾完一个通道再撤销就没反应了
    const inputType = target instanceof HTMLInputElement ? String(target.type || 'text') : '';
    const textEditing = Boolean(
      target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(inputType)))
    );
    // Esc 交给统一浮层栈（见下方的 pushOverlay）：这里不再自己关，避免叠层时一次退两层
    if (textEditing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) history.redo(doc) && redraw();
      else history.undo(doc) && redraw();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (history.redo(doc)) redraw();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      persistDoc(doc);
      toast('已保存');
      return;
    }
    if (mod && event.key.toLowerCase() === 'd' && state.selected) {
      event.preventDefault();
      const node = findNode(doc.root, state.selected);
      const parent = findParent(doc.root, state.selected);
      if (node && parent) {
        const copy = duplicateNode(node);
        copy.grid = { ...node.grid, y: node.grid.y + node.grid.h };
        commit(insertNodeCommand(parent.id, copy, '复制控件'));
        select(copy.id);
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected) {
      event.preventDefault();
      commit(removeNodeCommand(state.selected));
      select('');
      return;
    }
    // 方向键微调：选中控件后一格格挪，Shift+方向键一格格改大小。
    // 拖拽适合粗调，键盘适合「就差一格」的精调 —— 现场盯着大屏改布局时特别有用。
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    };
    const delta = arrows[event.key];
    if (delta && state.selected && !mod && !textEditing) {
      const node = findNode(doc.root, state.selected);
      if (node) {
        event.preventDefault();
        if (event.shiftKey) {
          const next = {
            ...node.grid,
            w: Math.max(1, Math.min(doc.cols - node.grid.x, node.grid.w + delta[0])),
            h: Math.max(1, node.grid.h + delta[1])
          };
          commit(moveNodeCommand(node.id, next, '调整控件大小'));
        } else {
          const next = {
            ...node.grid,
            x: Math.max(0, Math.min(doc.cols - node.grid.w, node.grid.x + delta[0])),
            y: Math.max(0, node.grid.y + delta[1])
          };
          commit(moveNodeCommand(node.id, next, '移动控件'));
        }
        return;
      }
    }
  };
  window.addEventListener('keydown', onKey, true);

  history.onChange(refreshToolbar);
  buildPalette();
  runtime.setInteractive(false);
  runtime.sync(doc);
  refreshToolbar();
  renderProps();
  // 不自动聚焦标题输入框：焦点落在文本框里会吞掉 Ctrl+Z / Delete 等画布快捷键，
  // 打开设计器就先选中名字也很容易误改。要点重命名就点它。
  const shellEl = mask.querySelector('.dsg-shell') as HTMLElement | null;
  if (shellEl) {
    shellEl.tabIndex = -1;
    shellEl.focus({ preventScroll: true });
  }
}

export function closeDesigner(): void {
  active?.close();
}

export function isDesignerOpen(): boolean {
  return Boolean(active);
}

