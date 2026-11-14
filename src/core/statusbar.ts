/**
 * 状态栏贡献点的运行时。
 *
 * 渲染目标不写死 DOM id：宿主注入一个容器，左/右两组各自排序。
 * 这样桌面版可以把状态栏放进顶栏，网页版可以放到底部条，
 * 插件不需要知道自己被画在哪里。
 */
import { Emitter } from './events';
import { executeCommand } from './commands';
import { evaluateWhen } from './when';
import type { Disposable, StatusBarContribution } from './types';

export interface StatusBarItem extends StatusBarContribution {
  owner: string;
  visible: boolean;
}

const TONES: Record<string, string> = {
  default: 'var(--fg-2, #9aa4b2)',
  info: 'var(--accent, #4c9aff)',
  warn: 'var(--warn, #f5a623)',
  error: 'var(--danger, #ff5c5c)',
  ok: 'var(--ok, #34d399)'
};

const STYLE_ID = 'xhgcs-core-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.xhgcs-sb{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border:0;border-radius:6px;
  background:transparent;color:var(--fg-2,var(--text-dim));font:inherit;font-size:11px;line-height:1;font-variant-numeric:tabular-nums;
  cursor:default;white-space:nowrap;opacity:1;transition:background .12s ease,color .12s ease}
.xhgcs-sb[data-clickable="1"]{cursor:pointer}
.xhgcs-sb[data-clickable="1"]:hover{background:var(--hover,rgba(255,255,255,.08));color:var(--fg,#e8eef7)}
.xhgcs-sb[data-tone="info"]{color:var(--accent,#4c9aff)}
.xhgcs-sb[data-tone="warn"]{color:var(--warn,#f5a623)}
.xhgcs-sb[data-tone="error"]{color:var(--danger,#ff5c5c)}
.xhgcs-sb[data-tone="ok"]{color:var(--ok,#34d399)}
.xhgcs-sb-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.6}
.xhgcs-sb-wrap{display:flex;align-items:center;gap:2px;min-width:0}
.xhgcs-sb-spacer{flex:1 1 auto;min-width:8px}
`;
  document.head.appendChild(style);
}

export class StatusBarService {
  private readonly items = new Map<string, StatusBarItem>();
  private readonly onChange = new Emitter<void>();
  private container: HTMLElement | null = null;
  private left: HTMLElement | null = null;
  private right: HTMLElement | null = null;
  private getContext: () => Record<string, unknown> = () => ({});

  setContextProvider(provider: () => Record<string, unknown>): void {
    this.getContext = provider;
  }

  onDidChange(listener: () => void): Disposable {
    return this.onChange.on(listener);
  }

  add(owner: string, contribution: StatusBarContribution): Disposable {
    const key = `${owner}:${contribution.id}`;
    this.items.set(key, { ...contribution, owner, visible: true });
    this.render();
    return {
      dispose: () => {
        this.items.delete(key);
        this.render();
      }
    };
  }

  update(owner: string, id: string, patch: Partial<StatusBarContribution> & { visible?: boolean }): void {
    const key = `${owner}:${id}`;
    const current = this.items.get(key);
    if (!current) return;
    this.items.set(key, { ...current, ...patch });
    this.render();
  }

  remove(owner: string, id: string): void {
    this.items.delete(`${owner}:${id}`);
    this.render();
  }

  /** 挂到一个宿主元素上（core 启动时调用一次）。 */
  attach(host: HTMLElement): void {
    if (this.container) return;
    ensureStyles();
    const wrap = document.createElement('div');
    wrap.className = 'xhgcs-sb-wrap';
    wrap.dataset.role = 'xhgcs-statusbar';
    const left = document.createElement('div');
    left.className = 'xhgcs-sb-wrap';
    left.dataset.align = 'left';
    const spacer = document.createElement('div');
    spacer.className = 'xhgcs-sb-spacer';
    const right = document.createElement('div');
    right.className = 'xhgcs-sb-wrap';
    right.dataset.align = 'right';
    wrap.append(left, spacer, right);
    host.appendChild(wrap);
    this.container = wrap;
    this.left = left;
    this.right = right;
    this.render();
  }

  detach(): void {
    this.container?.remove();
    this.container = null;
    this.left = null;
    this.right = null;
  }

  private render(): void {
    if (!this.container || !this.left || !this.right) return;
    const context = this.getContext();
    const visible = Array.from(this.items.values())
      .filter((item) => evaluateWhen((item as StatusBarItem & { when?: string }).when, context))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.left.replaceChildren(...visible.filter((item) => item.alignment === 'left').map((item) => this.build(item)));
    this.right.replaceChildren(...visible.filter((item) => item.alignment !== 'left').map((item) => this.build(item)));
    this.container.hidden = visible.length === 0;
    this.onChange.emit();
  }

  private build(item: StatusBarItem): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'xhgcs-sb';
    el.dataset.tone = item.tone || 'default';
    el.dataset.clickable = item.command ? '1' : '0';
    el.title = item.tooltip || (item.command ? `执行 ${item.command}` : item.text);
    if (item.command) {
      el.addEventListener('click', () => {
        executeCommand(item.command as string).catch((err) => console.warn('[XHGCS_CORE] 状态栏命令失败', err));
      });
    }
    const dot = document.createElement('span');
    dot.className = 'xhgcs-sb-dot';
    const text = document.createElement('span');
    text.textContent = item.text || '';
    el.append(dot, text);
    return el;
  }

  /** 暴露给测试：当前可见项 */
  snapshot(): Array<{ id: string; text: string; owner: string }> {
    return Array.from(this.items.values()).map((item) => ({ id: item.id, text: item.text, owner: item.owner }));
  }

  get tones(): Record<string, string> {
    return TONES;
  }
}

export const statusBar = new StatusBarService();
