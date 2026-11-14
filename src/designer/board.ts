/**
 * 看板运行态（Kiosk）。
 *
 * 设计器里看到的是“编辑态”，这里跑的是同一份文档 + 同一个渲染器：
 * 没有网格线、没有手柄、没有属性面板，只有数据在流。
 * 全屏、Esc 退出、F 切换全屏 —— 现场投屏和值班大屏直接用这个。
 */
import type { UiDoc } from './ui-doc';
import { DocRuntime } from './renderer';
import type { WidgetDef } from './widgets';
import { activeDoc } from './board-store';
import { pushOverlay } from '../core/overlay-stack';

const STYLE_ID = 'xhgcs-board-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.board-mask{position:fixed;inset:0;z-index:9760;background:var(--surf-0,#0d1117);display:flex;flex-direction:column;overflow:hidden}
.board-head{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 18px;
  background:var(--surf-1,rgba(24,30,37,.72));box-shadow:var(--seam-y,inset 0 -1px 0 rgba(255,255,255,.055));color:var(--text-dim,#8b97a5);font-size:12px;
  opacity:0;transition:opacity .22s ease;z-index:2;pointer-events:none}
.board-mask[data-chrome="1"] .board-head{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 18px;
  background:var(--surf-1,rgba(24,30,37,.72));box-shadow:var(--seam-y,inset 0 -1px 0 rgba(255,255,255,.055));color:var(--text-dim,#8b97a5);font-size:12px;
  opacity:1;transition:opacity .22s ease;z-index:2;pointer-events:auto}
.board-head b{color:var(--heading,#e6f2ff);font-size:13px;font-weight:600;letter-spacing:.02em}
.board-head .board-spacer{flex:1 1 auto}
.board-head button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--surf-2,rgba(30,37,45,.86));color:var(--text,#c9d4e0);
  font-size:11px;padding:5px 11px;border-radius:8px;cursor:pointer;transition:border-color .14s,color .14s,background .14s}
.board-head button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff);background:rgba(var(--acc-rgb), .16)}
.board-stage{position:absolute;inset:0;padding:52px 22px 22px;overflow:hidden;
  background:radial-gradient(1400px 700px at 50% -12%,rgba(var(--acc-rgb), .05),transparent 62%)}
.board-canvas{position:relative;display:grid;grid-template-columns:repeat(var(--dsg-cols,12),minmax(0,1fr));
  gap:12px;height:100%;width:100%}
.board-canvas .dsg-cell{border:1px solid var(--edge-hair,rgba(255,255,255,.055));border-radius:var(--r-card,10px);
  background:var(--surf-2,rgba(30,37,45,.86));
  overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:0;
  box-shadow:var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.board-canvas .dsg-cell:hover{border-color:var(--edge-hair,rgba(255,255,255,.055))}
.board-canvas .dsg-cell-head{display:none}
.board-canvas .dsg-cell-resize{display:none}
.board-canvas .dsg-cell-content{flex:1 1 auto;min-height:0;position:relative}
.board-canvas .dsg-stat{padding:14px 20px;gap:6px}
.board-canvas .dsg-stat-title{font-size:clamp(11px, 1.5vh, 13px);letter-spacing:.04em}
.board-canvas .dsg-stat-value{font-size:clamp(24px, 7vh, 32px)}
.board-canvas .dsg-stat-unit{font-size:12px}
.board-canvas .dsg-label{font-size:clamp(12px, 2vh, 13px);padding:0 16px}
.board-canvas .dsg-missing{padding:10px;font-size:12px;color:var(--warn,#fbbf24);text-align:center}
.board-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim,#7d8896);font-size:13px}
.board-tip{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);font-size:11px;color:var(--text-dim,#7d8896);
  background:var(--surf-2,rgba(30,37,45,.86));border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:999px;padding:4px 12px;
  opacity:0;transition:opacity .2s ease;pointer-events:none}
.board-mask[data-chrome="1"] .board-tip{opacity:1}
`;
  document.head.appendChild(style);
}

export function loadSavedDoc(): UiDoc | null {
  try {
    // 统一走看板库：迁移、活动板、缓存都在 board-store 里
    return activeDoc();
  } catch {
    return null;
  }
}

export interface BoardOptions {
  doc?: UiDoc;
  widgets?: WidgetDef[];
  /** 自动隐藏顶部条的毫秒数 */
  idleMs?: number;
}

export function openBoard(options: BoardOptions = {}): boolean {
  if (document.querySelector('.board-mask')) return false;
  ensureStyles();
  const doc = options.doc || loadSavedDoc();
  if (!doc) return false;

  const mask = document.createElement('div');
  mask.className = 'board-mask';
  mask.dataset.chrome = '0';

  const head = document.createElement('div');
  head.className = 'board-head';
  const name = document.createElement('b');
  name.textContent = doc.name;
  const count = document.createElement('span');
  count.textContent = `${doc.root.children ? doc.root.children.length : 0} 个控件`;
  const spacer = document.createElement('div');
  spacer.className = 'board-spacer';
  const fullscreen = document.createElement('button');
  fullscreen.textContent = '全屏';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '退出 (Esc)';
  head.append(name, count, spacer, fullscreen, closeBtn);

  const stage = document.createElement('div');
  stage.className = 'board-stage';
  const canvas = document.createElement('div');
  canvas.className = 'board-canvas';
  stage.appendChild(canvas);

  const tip = document.createElement('div');
  tip.className = 'board-tip';
  tip.textContent = 'Esc 退出 · F 全屏';

  mask.append(head, stage, tip);
  document.body.appendChild(mask);

  const runtime = new DocRuntime({ container: canvas, extraWidgets: options.widgets || [], tickMs: 250 });
  runtime.setInteractive(true);
  runtime.sync(doc);
  // 看板要铺满视口：按文档实际用到的行数均分高度，而不是沿用编辑器的固定 44px 行高。
  // renderer.sync() 会写 minHeight，所以每次 refresh 之后都要再覆盖一次。
  const usedRows = (doc.root.children || []).reduce((max, node) => Math.max(max, node.grid.y + node.grid.h), 0);
  const applyBoardGrid = () => {
    canvas.style.gridTemplateRows = `repeat(${Math.max(1, usedRows)}, minmax(0, 1fr))`;
    canvas.style.minHeight = '0';
  };
  applyBoardGrid();
  // 首帧之后按实际容器尺寸重算一次（grid 高度依赖视口）
  window.requestAnimationFrame(() => {
    runtime.refresh();
    applyBoardGrid();
  });

  // 看板遮罩必须是实色 surface：底层主界面文字/曲线一律不许透出。
  // 不再用半透明 theme.bg 覆盖；glass 质感只留在内容面板，遮罩本身不透明。
  mask.style.background = 'var(--surf-0, #191411)';

  let idleTimer: number | null = null;
  const showChrome = () => {
    mask.dataset.chrome = '1';
    if (idleTimer != null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      mask.dataset.chrome = '0';
    }, options.idleMs == null ? 2600 : options.idleMs);
  };
  showChrome();

  const resize = () => {
    runtime.refresh();
    applyBoardGrid();
  };

  const close = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    disposeOverlay();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', resize);
    mask.removeEventListener('pointermove', showChrome);
    if (idleTimer != null) window.clearTimeout(idleTimer);
    runtime.dispose();
    mask.remove();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    mask.requestFullscreen?.().catch(() => undefined);
  };

  // Esc 走统一浮层栈：看板叠在设计器上时只关看板，不会连带把设计器一起关掉
  let disposeOverlay: () => void = () => undefined;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'f' || event.key === 'F') {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
      event.preventDefault();
      toggleFullscreen();
    }
  };

  disposeOverlay = pushOverlay({ id: 'board', kind: 'modal', close });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', resize);
  mask.addEventListener('pointermove', showChrome);
  closeBtn.addEventListener('click', close);
  fullscreen.addEventListener('click', toggleFullscreen);
  // 双击画布也切全屏，现场操作更像大屏
  canvas.addEventListener('dblclick', (event) => {
    if (event.target === canvas) toggleFullscreen();
  });
  return true;
}

export function isBoardOpen(): boolean {
  return Boolean(document.querySelector('.board-mask'));
}
