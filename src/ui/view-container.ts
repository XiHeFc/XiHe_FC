/**
 * 插件视图容器。
 *
 * 这是 `views` 贡献点真正“活起来”的地方：清单里声明一个视图，插件在激活时
 * 注册它的实现，容器负责挂载、喂数据、自适应、失败隔离和销毁。
 *
 * 契约刻意做成“可选钩子”而不是抽象类：
 *   { mount(ctx), update?(ctx), resize?(ctx), unmount?(ctx) }
 * 只会画一次的实现可以不写 update；只画 canvas 的实现不必关心 DOM 结构。
 */
import { registry } from '../core/registry';
import { pushOverlay } from '../core/overlay-stack';
import { host, env } from '../core/runtime';
import { buildWhenContext } from '../core/api';
import { evaluateWhen } from '../core/when';
import { readTheme, fitCanvas, type Theme, type Frame } from '../designer/plot';
import type { ViewContribution } from '../core/types';

const STYLE_ID = 'xhgcs-view-container-style';

export interface ViewContext {
  id: string;
  host: HTMLElement;
  width: number;
  height: number;
  theme(): Theme;
  /** 当前通道快照（原始 + 脚本） */
  channels(): Array<{ id: string; name: string; unit: string; color: string; data: number[] }>;
  latest(channelId: string): number;
  series(channelId: string, limit?: number): number[];
  /** 自适应 dpr 的画布；每次拿到的是同一块，内容由调用方重画 */
  canvas(): Frame | null;
  toast(message: string): void;
  esc(text: string): string;
  /** 订阅数据到达（会被合并到每帧一次） */
  onSample(listener: () => void): () => void;
  /** 订阅容器尺寸变化 */
  onResize(listener: () => void): () => void;
  /** 手动请求一次重绘窗口（用于动画） */
  requestRender(): void;
}

interface ViewImplementation {
  mount?(ctx: ViewContext): void;
  update?(ctx: ViewContext): void;
  resize?(ctx: ViewContext): void;
  unmount?(ctx: ViewContext): void;
}

interface LegacyChannel {
  id: string;
  name?: string;
  unit?: string;
  color?: string;
  data?: number[];
}

function legacyChannels(): LegacyChannel[] {
  const state = (window as unknown as { XHGCS?: { state?: { channels?: LegacyChannel[]; scriptChannels?: LegacyChannel[] } } }).XHGCS?.state;
  if (!state) return [];
  const list: LegacyChannel[] = [];
  if (Array.isArray(state.channels)) list.push(...state.channels);
  if (Array.isArray(state.scriptChannels)) list.push(...state.scriptChannels);
  return list;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* 插件视图容器：统一 L3 浮层（B6 第二批）。只换令牌与材质，不改行为。 */
.vc-mask{position:fixed;inset:0;z-index:9620;background:rgba(4,7,11,.55);display:flex;align-items:center;justify-content:center}
html[data-theme="light"] .vc-mask{background:rgba(15,23,42,.32)}
html[data-fx="glass"] .vc-mask{backdrop-filter:blur(4px)}
.vc-shell{width:min(1080px,94vw);height:min(760px,88vh);display:flex;flex-direction:column;
  background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);background-size:100% 40%;background-repeat:no-repeat;
  border:0;border-radius:var(--r-overlay,16px);overflow:hidden;box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-strong,none)}
.vc-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:0;background:transparent}
.vc-head h3{margin:0;font-size:var(--fs-14,14px);font-weight:600;color:var(--heading,#e9f1fa)}
.vc-head .vc-tag{font-size:var(--fs-10,10px);color:var(--text-dim,#8b97a5);border:1px solid var(--edge-soft,rgba(255,255,255,.035));border-radius:999px;padding:1px 8px}
.vc-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#8b97a5);font-size:var(--fs-13,13px);cursor:pointer;padding:3px 8px;border-radius:var(--r-ctl,6px)}
.vc-head button:hover{background:var(--surf-hover,rgba(255,255,255,.045));color:var(--text,#c7d1dc)}
.vc-body{flex:1 1 auto;display:flex;min-height:0}
.vc-nav{width:210px;flex:0 0 210px;overflow:auto;padding:8px;background:var(--surf-inset,#0b0e13)}
.vc-nav-item{width:100%;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--text,#c7d1dc);
  font-size:var(--fs-12,12px);line-height:1.4;font-family:inherit;padding:8px 10px;border-radius:var(--r-ctl,6px);cursor:pointer;text-align:left}
.vc-nav-item:hover{background:var(--surf-hover,rgba(255,255,255,.045))}
.vc-nav-item[data-active="1"]{background:var(--acc-soft,rgba(109,168,210,.14));color:var(--acc-text,#a9d4ef)}
.vc-nav-item i{font-style:normal;color:var(--acc,#6da8d2);width:16px;text-align:center}
.vc-nav-item[data-active="1"] i{color:inherit}
.vc-nav-item small{margin-left:auto;color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px)}
.vc-sec{font-size:var(--fs-10,10px);letter-spacing:.08em;color:var(--text-dim,#8b97a5);margin:12px 6px 5px}
.vc-stage{flex:1 1 auto;min-width:0;position:relative;overflow:hidden;background:var(--surf-inset,#0b0e13)}
.vc-host{position:absolute;inset:0;padding:12px;overflow:hidden}
.vc-host canvas{display:block}
.vc-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  color:var(--text-dim,#8b97a5);font-size:var(--fs-12,12px);line-height:1.7;text-align:center;padding:0 24px}
.vc-empty b{color:var(--warn,#e0a34a);font-weight:600;font-size:var(--fs-13,13px)}
.vc-foot{padding:8px 14px;border-top:0;display:flex;gap:10px;align-items:center;
  background:transparent;color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px)}
.vc-foot .vc-err{color:var(--danger-text,#f28c8c)}
`;
  document.head.appendChild(style);
}

function findImplementation(viewId: string): { owner: string; impl: ViewImplementation } | null {
  for (const entry of registry.all<ViewContribution>('views')) {
    if (entry.value.id !== viewId) continue;
    const runtime = host.runtime.views.get(`${entry.owner}:${viewId}`) as { implementation?: ViewImplementation } | undefined;
    if (runtime?.implementation) return { owner: entry.owner, impl: runtime.implementation };
  }
  return null;
}

interface LegacyViewRecord {
  id: string;
  name: string;
  icon?: string;
  desc?: string;
  code: string;
}

/** 老的表达式视图（AI 生成/用户手写）仍然存在 state.views 里，这里把它们也纳入同一个容器。 */
function legacyViews(): LegacyViewRecord[] {
  const list = (window as unknown as { XHGCS?: { state?: { views?: LegacyViewRecord[] } } }).XHGCS?.state?.views;
  return Array.isArray(list) ? list.filter((item) => item && item.id && typeof item.code === 'string') : [];
}

export function openViewContainer(preferredId?: string): void {
  if (document.querySelector('.vc-mask')) return;
  ensureStyles();

  const mask = document.createElement('div');
  mask.className = 'vc-mask';
  const shell = document.createElement('div');
  shell.className = 'vc-shell';

  const head = document.createElement('div');
  head.className = 'vc-head';
  const title = document.createElement('h3');
  title.textContent = '插件视图';
  const tag = document.createElement('span');
  tag.className = 'vc-tag';
  tag.textContent = 'views 贡献点';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  head.append(title, tag, closeBtn);

  const body = document.createElement('div');
  body.className = 'vc-body';
  const nav = document.createElement('div');
  nav.className = 'vc-nav';
  const stage = document.createElement('div');
  stage.className = 'vc-stage';
  const hostEl = document.createElement('div');
  hostEl.className = 'vc-host';
  const empty = document.createElement('div');
  empty.className = 'vc-empty';
  stage.append(hostEl, empty);
  body.append(nav, stage);

  const foot = document.createElement('div');
  foot.className = 'vc-foot';
  const footText = document.createElement('span');
  footText.textContent = '插件视图只拿到 ctx，不接触 window 内部状态';
  foot.appendChild(footText);

  shell.append(head, body, foot);
  mask.appendChild(shell);
  document.body.appendChild(mask);

  let activeId = '';
  let activeCtx: ViewContext | null = null;
  let activeImpl: ViewImplementation | null = null;
  let legacyRuntime: { def: { unmount?: (ctx: unknown) => void; update?: (ctx: unknown) => void }; ctx: { dispose?: () => void } } | null = null;
  let legacyTimer: number | null = null;
  let rafHandle: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const sampleListeners = new Set<() => void>();
  const resizeListeners = new Set<() => void>();

  const requestUpdate = () => {
    if (rafHandle != null) return;
    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = null;
      if (!activeImpl || !activeCtx) return;
      try {
        activeImpl.update?.(activeCtx);
      } catch (err) {
        footText.className = 'vc-err';
        footText.textContent = '视图更新失败：' + (err instanceof Error ? err.message : String(err));
        env.log('warn', '视图更新失败', err);
      }
      sampleListeners.forEach((listener) => {
        try {
          listener();
        } catch {
          /* 订阅者失败不影响别人 */
        }
      });
    });
  };

  const onSample = () => requestUpdate();
  window.addEventListener('xhgcs:sample', onSample);

  const teardown = () => {
    if (legacyTimer != null) {
      window.clearInterval(legacyTimer);
      legacyTimer = null;
    }
    if (legacyRuntime) {
      try {
        legacyRuntime.def.unmount?.(legacyRuntime.ctx);
      } catch (err) {
        console.warn('[XHGCS_CORE] 旧版视图卸载失败', err);
      }
      try {
        legacyRuntime.ctx.dispose?.();
      } catch (err) {
        console.warn('[XHGCS_CORE] 旧版视图上下文释放失败', err);
      }
      legacyRuntime = null;
    }
    if (activeImpl && activeCtx) {
      try {
        activeImpl.unmount?.(activeCtx);
      } catch (err) {
        console.warn('[XHGCS_CORE] 视图卸载失败', err);
      }
    }
    activeImpl = null;
    activeCtx = null;
    hostEl.replaceChildren();
    resizeObserver?.disconnect();
    resizeObserver = null;
    sampleListeners.clear();
    resizeListeners.clear();
  };

  const buildContext = (id: string): ViewContext => {
    let canvasEl: HTMLCanvasElement | null = null;
    const ctx: ViewContext = {
      id,
      host: hostEl,
      get width() {
        return hostEl.clientWidth;
      },
      get height() {
        return hostEl.clientHeight;
      },
      theme: () => readTheme(hostEl),
      channels: () =>
        legacyChannels().map((channel) => ({
          id: channel.id,
          name: channel.name || channel.id,
          unit: channel.unit || '',
          color: channel.color || '#6da8d2',
          data: Array.isArray(channel.data) ? channel.data : []
        })),
      latest(channelId) {
        const channel = legacyChannels().find((item) => item.id === channelId);
        const data = channel?.data;
        return data && data.length ? Number(data[data.length - 1]) || 0 : 0;
      },
      series(channelId, limit = 200) {
        const channel = legacyChannels().find((item) => item.id === channelId);
        const data = channel?.data;
        if (!data) return [];
        const count = Math.max(0, Math.min(limit, data.length));
        return data.slice(data.length - count);
      },
      canvas() {
        if (!canvasEl) {
          canvasEl = document.createElement('canvas');
          canvasEl.style.display = 'block';
          hostEl.appendChild(canvasEl);
        }
        return fitCanvas(canvasEl, hostEl);
      },
      toast: (message: string) => env.toast(message),
      esc(text: string) {
        return String(text == null ? '' : text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
      onSample(listener) {
        sampleListeners.add(listener);
        return () => sampleListeners.delete(listener);
      },
      onResize(listener) {
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
      requestRender: requestUpdate
    };
    return ctx;
  };

  const showEmpty = (message: string, hint?: string) => {
    empty.replaceChildren();
    const bold = document.createElement('b');
    bold.textContent = message;
    empty.appendChild(bold);
    if (hint) {
      const text = document.createElement('span');
      text.textContent = hint;
      empty.appendChild(text);
    }
    empty.style.display = 'flex';
  };

  const mountView = async (viewId: string) => {
    teardown();
    activeId = viewId;
    renderNav();
    empty.style.display = 'none';
    footText.className = '';
    footText.textContent = '激活中…';
    try {
      // 命中 onView:<id> 才会去加载插件代码
      await host.fireEvent('onView', viewId);
    } catch (err) {
      env.log('warn', `激活视图 ${viewId} 失败`, err);
    }
    const found = findImplementation(viewId);
    if (!found) {
      showEmpty(
        '这个视图还没有实现',
        '清单里声明了 views，但插件没有调用 api.views.register()。检查它是否已激活、id 是否一致。'
      );
      footText.textContent = '未找到实现';
      return;
    }
    activeImpl = found.impl;
    activeCtx = buildContext(viewId);
    try {
      found.impl.mount?.(activeCtx);
      footText.textContent = `${found.owner} · ${viewId} · ${activeCtx.width}×${activeCtx.height}`;
    } catch (err) {
      showEmpty('视图挂载失败', err instanceof Error ? err.message : String(err));
      footText.className = 'vc-err';
      footText.textContent = '挂载失败';
      return;
    }
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (!activeImpl || !activeCtx) return;
        try {
          activeImpl.resize?.(activeCtx);
        } catch (err) {
          env.log('warn', '视图 resize 失败', err);
        }
        resizeListeners.forEach((listener) => {
          try {
            listener();
          } catch {
            /* ignore */
          }
        });
      });
      resizeObserver.observe(hostEl);
    }
    requestUpdate();
  };

  /**
   * 旧版表达式视图：复用老运行时（XHGCS_VIEWS.createViewContext）挂载，
   * ctx 是老的那一套（draw/theme/series…），保证 AI 生成过的视图不用重写就能看。
   */
  const mountLegacyView = (viewId: string): void => {
    teardown();
    activeId = `legacy:${viewId}`;
    renderNav();
    empty.style.display = 'none';
    footText.className = '';
    const record = legacyViews().find((item) => item.id === viewId);
    if (!record) {
      showEmpty('找不到这个旧版视图', 'state.views 里已经没有它了');
      return;
    }
    const runtime = (window as unknown as {
      XHGCS_VIEWS?: {
        compileSource?: (code: string) => unknown;
        createViewContext?: (def: unknown, host: HTMLElement) => { dispose?: () => void };
      };
    }).XHGCS_VIEWS;
    if (!runtime || typeof runtime.compileSource !== 'function' || typeof runtime.createViewContext !== 'function') {
      showEmpty('旧版视图运行时未加载', '需要 assets/js/views-plugins.js');
      return;
    }
    let def: { mount?: (ctx: unknown) => void; update?: (ctx: unknown) => void; unmount?: (ctx: unknown) => void };
    try {
      def = runtime.compileSource(record.code) as typeof def;
    } catch (err) {
      showEmpty('视图代码编译失败', err instanceof Error ? err.message : String(err));
      footText.className = 'vc-err';
      footText.textContent = '编译失败';
      return;
    }
    try {
      const ctx = runtime.createViewContext(def, hostEl);
      def.mount?.(ctx);
      legacyRuntime = { def, ctx };
      footText.textContent = `旧版表达式视图 · ${record.name || record.id}`;
      legacyTimer = window.setInterval(() => {
        if (!legacyRuntime) return;
        try {
          legacyRuntime.def.update?.(legacyRuntime.ctx);
        } catch (err) {
          footText.className = 'vc-err';
          footText.textContent = '更新失败：' + (err instanceof Error ? err.message : String(err));
        }
      }, 250);
    } catch (err) {
      showEmpty('视图挂载失败', err instanceof Error ? err.message : String(err));
      footText.className = 'vc-err';
      footText.textContent = '挂载失败';
    }
  };

  const viewItems = () =>
    registry
      .all<ViewContribution>('views')
      .filter((entry) => evaluateWhen(entry.value.when, buildWhenContext()))
      .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));

  const renderNav = () => {
    nav.replaceChildren();
    const items = viewItems();
    if (!items.length && !legacyViews().length) {
      const emptyNav = document.createElement('div');
      emptyNav.className = 'vc-empty';
      emptyNav.textContent = '还没有任何视图贡献';
      nav.appendChild(emptyNav);
      return;
    }
    for (const entry of items) {
      const view = entry.value;
      const item = document.createElement('button');
      item.className = 'vc-nav-item';
      item.dataset.active = view.id === activeId ? '1' : '0';
      const icon = document.createElement('i');
      icon.textContent = view.icon || '◈';
      const label = document.createElement('span');
      label.textContent = view.name;
      const owner = document.createElement('small');
      owner.textContent = entry.owner;
      item.append(icon, label, owner);
      item.addEventListener('click', () => {
        if (view.id === activeId) return;
        mountView(view.id).catch((err) => env.log('warn', '挂载视图失败', err));
      });
      nav.appendChild(item);
    }

    const legacy = legacyViews();
    if (legacy.length) {
      const head = document.createElement('div');
      head.className = 'vc-sec';
      head.textContent = '自定义视图（旧版）';
      nav.appendChild(head);
      for (const record of legacy) {
        const item = document.createElement('button');
        item.className = 'vc-nav-item';
        item.dataset.legacy = '1';
        item.dataset.active = `legacy:${record.id}` === activeId ? '1' : '0';
        const icon = document.createElement('i');
        icon.textContent = record.icon || '◇';
        const label = document.createElement('span');
        label.textContent = record.name || record.id;
        const tag = document.createElement('small');
        tag.textContent = 'legacy';
        item.append(icon, label, tag);
        item.addEventListener('click', () => mountLegacyView(record.id));
        nav.appendChild(item);
      }
    }
  };

  let disposeOverlay: () => void = () => undefined;
  const close = () => {
    window.removeEventListener('xhgcs:sample', onSample);
    disposeOverlay();
    if (rafHandle != null) window.cancelAnimationFrame(rafHandle);
    teardown();
    mask.remove();
  };
  disposeOverlay = pushOverlay({ id: 'view-container', kind: 'modal', close });
  closeBtn.addEventListener('click', close);
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close();
  });

  renderNav();
  const items = viewItems();
  const target = (preferredId && items.find((entry) => entry.value.id === preferredId)?.value.id) || (items[0] && items[0].value.id);
  if (target) {
    mountView(target).catch((err) => env.log('warn', '挂载视图失败', err));
  } else {
    showEmpty('还没有插件贡献视图', '在清单的 contributes.views 里声明，并在 activate 里调用 api.views.register()。');
  }
}
