/**
 * 模态/浮层统一栈。
 *
 * 背景：以前每个面板自己往 document 上挂一个 capture keydown 处理 Escape，
 * 结果层叠时一次 Esc 会关掉两层（看板叠设计器、扩展管理叠设置）。
 * 根因不是监听写错，而是**没有"谁是最上层"这个概念**。
 *
 * 规则：
 *   1. 全局只有一个 Escape 监听，永远只问栈顶；
 *   2. 栈顶可以返回「我处理了」（例如设计器先把输入框失焦、再取消选中），
 *      只有返回 false 才会真正关闭自己；
 *   3. 打开即入栈、关闭即出栈；栈空时老代码（assets/js）继续按老逻辑处理。
 *
 * 老代码兼容：`window.XHGCS_OVERLAY.depth()`，>0 时说明有新式浮层在上面，
 * 老监听（设置/通道配置/画视图）应当主动让位。
 */
export interface OverlayLayer {
  id: string;
  kind?: 'modal' | 'panel' | 'popover';
  /** 返回 true 表示自己处理掉了这次 Esc（不要关闭） */
  onEscape?: () => boolean;
  close: () => void;
}

const stack: OverlayLayer[] = [];
let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const top = stack[stack.length - 1];
      if (!top) return;
      // 只要栈非空，Esc 就是我们的：禁止老监听同时处理
      event.preventDefault();
      event.stopPropagation();
      let handled = false;
      try {
        handled = top.onEscape ? top.onEscape() === true : false;
      } catch (err) {
        console.warn('[XHGCS_OVERLAY] onEscape 抛错', err);
      }
      if (!handled) top.close();
    },
    true
  );
  (window as unknown as { XHGCS_OVERLAY?: unknown }).XHGCS_OVERLAY = {
    depth: () => stack.length,
    top: () => (stack.length ? stack[stack.length - 1].id : null),
    ids: () => stack.map((layer) => layer.id)
  };
}

export function pushOverlay(layer: OverlayLayer): () => void {
  install();
  // 同 id 重复打开（面板单例）时先把旧的摘掉，避免栈里留幽灵层
  const existing = stack.findIndex((item) => item.id === layer.id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(layer);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = stack.findIndex((item) => item === layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function overlayDepth(): number {
  return stack.length;
}

export function topOverlayId(): string | null {
  return stack.length ? stack[stack.length - 1].id : null;
}

/** 老代码（assets/js）用：判断是否该让位给新式浮层 */
export function legacyShouldSkipEscape(): boolean {
  return stack.length > 0;
}
