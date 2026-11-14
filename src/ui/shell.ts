/**
 * 内核自带的两块 UI：命令面板与扩展管理。
 *
 * 它们同时是“能力示范”——插件贡献的命令/状态栏/配置在这里被真实消费，
 * 用户不需要知道任何插件实现细节就能发现并驱动它们。
 * 样式只用 styles.css 已定义的设计令牌，换主题时自动跟随。
 */
import { executeCommand, listCommands } from '../core/commands';
import { RISKY_PERMISSIONS } from '../core/consent';
import { host } from '../core/runtime';
import { pushOverlay } from '../core/overlay-stack';

const STYLE_ID = 'xhgcs-ui-shell-style';
const Z = 9600;

function ensureShellStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* 命令面板 / 扩展管理：统一 L3 浮层。数值全部走 B1a 令牌（字号 6 档、无面板级描边）。 */
.xhgcs-mask{position:fixed;inset:0;z-index:${Z};background:rgba(4,7,11,.55);
  display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
.xhgcs-mask[data-kind="panel"]{align-items:center;padding-top:0}
html[data-theme="light"] .xhgcs-mask{background:rgba(15,23,42,.32)}
html[data-fx="glass"] .xhgcs-mask{backdrop-filter:blur(4px)}
/* 命令面板 */
.xhgcs-palette{width:min(660px,88vw);background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);
  background-size:100% 40%;background-repeat:no-repeat;border:0;border-radius:var(--r-overlay,16px);
  box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));backdrop-filter:var(--surf-blur-strong,none);
  overflow:hidden;display:flex;flex-direction:column;animation:xhgcs-pop .14s ease}
@keyframes xhgcs-pop{from{opacity:0;transform:translateY(-6px) scale(.99)}to{opacity:1;transform:none}}
.xhgcs-palette-search{display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035));
  background:transparent}
.xhgcs-palette-search .xhgcs-search-ico{color:var(--acc,#6da8d2);font-size:var(--fs-13,13px);line-height:1;opacity:.9}
.xhgcs-palette input{flex:1 1 auto;width:100%;height:46px;border:0;background:transparent;
  color:var(--heading,#e6f2ff);font:var(--fs-14,14px)/1.4 inherit;padding:0;outline:none;letter-spacing:.01em}
.xhgcs-palette input::placeholder{color:var(--text-dim,#8b97a5)}
.xhgcs-palette-list{max-height:52vh;overflow:auto;padding:6px 6px 8px}
.xhgcs-palette-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r-ctl,6px);cursor:pointer;
  color:var(--text,#c7d1dc);font-size:var(--fs-13,13px);border:1px solid transparent;position:relative}
.xhgcs-palette-item[data-active="1"]{background:var(--surf-hover,rgba(255,255,255,.045));border-color:var(--edge-soft,rgba(255,255,255,.035));color:var(--heading,#e9f1fa)}
.xhgcs-palette-item[data-active="1"]::before{content:'';position:absolute;left:2px;top:8px;bottom:8px;width:2px;border-radius:2px;
  background:var(--acc,#6da8d2)}
.xhgcs-palette-item b{font-weight:600}
.xhgcs-palette-item small{margin-left:auto;color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px);
  font-family:var(--font-mono,ui-monospace,Consolas,monospace);opacity:.9}
.xhgcs-palette-item[data-active="1"] .xhgcs-palette-cat,.xhgcs-palette-item[data-active="1"] small{color:var(--text,#c7d1dc)}
.xhgcs-palette-cat{color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px);min-width:40px;text-align:center;padding:1px 6px;
  border-radius:999px;border:1px solid var(--edge-soft,rgba(255,255,255,.035));flex:0 0 auto}
.xhgcs-palette-foot{display:flex;align-items:center;gap:12px;padding:7px 12px;border-top:1px solid var(--edge-soft,rgba(255,255,255,.035));
  color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px);background:transparent}
.xhgcs-palette-foot kbd{font:inherit;padding:1px 5px;border-radius:4px;border:1px solid var(--edge-hair,rgba(255,255,255,.06));
  background:var(--surf-inset,#0b0e13);color:var(--text,#c7d1dc);margin-right:3px}
/* 扩展管理 */
.xhgcs-panel{width:min(760px,92vw);max-height:76vh;display:flex;flex-direction:column;
  background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);background-size:100% 40%;background-repeat:no-repeat;
  border:0;border-radius:var(--r-overlay,16px);box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-strong,none);overflow:hidden}
.xhgcs-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:0}
.xhgcs-panel-head h3{margin:0;font-size:var(--fs-14,14px);font-weight:600;color:var(--heading,#e9f1fa)}
.xhgcs-panel-head .xhgcs-close{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#8b97a5);
  font-size:var(--fs-13,13px);cursor:pointer;padding:3px 8px;border-radius:var(--r-ctl,6px)}
.xhgcs-panel-head .xhgcs-close:hover{background:var(--surf-hover,rgba(255,255,255,.045));color:var(--text,#c7d1dc)}
.xhgcs-panel-body{overflow:auto;padding:4px 12px 12px}
.xhgcs-ext{display:flex;gap:10px;align-items:flex-start;padding:10px 2px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035))}
.xhgcs-ext:last-child{border-bottom:0}
.xhgcs-ext-main{flex:1 1 auto;min-width:0}
.xhgcs-ext-title{display:flex;align-items:center;gap:8px;color:var(--heading,#e9f1fa);font-size:var(--fs-13,13px);font-weight:600}
.xhgcs-ext-id{color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px);margin-top:2px;word-break:break-all}
.xhgcs-ext-msg{margin-top:6px;font-size:var(--fs-11,11px);color:var(--warn,#e0a34a);white-space:pre-wrap}
.xhgcs-chip{font-size:var(--fs-10,10px);padding:1px 6px;border-radius:999px;border:1px solid currentColor;line-height:1.6}
.xhgcs-chip[data-s="active"]{color:var(--ok,#58c08a)}
.xhgcs-chip[data-s="resolved"]{color:var(--acc,#6da8d2)}
.xhgcs-chip[data-s="disabled"]{color:var(--text-dim,#8b97a5)}
.xhgcs-chip[data-s="degraded"]{color:var(--warn,#e0a34a)}
.xhgcs-chip[data-s="failed"]{color:var(--danger,#e05c5c)}
.xhgcs-chip[data-s="pending"]{color:var(--warn,#e0a34a)}
.xhgcs-chip[data-s="activating"]{color:var(--acc,#6da8d2)}
.xhgcs-consent{margin-top:8px;padding:8px 10px;border:1px dashed rgba(var(--k-amber),.45);border-radius:var(--r-card,10px);
  background:rgba(var(--k-amber),.07);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.xhgcs-consent-row{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-11,11px);color:var(--text,#c7d1dc);
  font-family:var(--font-mono,ui-monospace,Consolas,monospace);cursor:pointer}
.xhgcs-consent button{border:1px solid rgba(var(--k-amber),.55);background:rgba(var(--k-amber),.16);color:var(--k-amber-t,#e0a34a);
  font-size:var(--fs-11,11px);padding:3px 9px;border-radius:var(--r-ctl,6px);cursor:pointer}
.xhgcs-consent button:hover{background:rgba(var(--k-amber),.26)}
.xhgcs-consent-note{flex:1 1 100%;font-size:var(--fs-10,10px);color:var(--text-dim,#8b97a5);line-height:1.5}
.xhgcs-ext-actions{display:flex;gap:6px;flex:0 0 auto}
.xhgcs-ext-actions button{border:1px solid var(--line,#2a3340);background:var(--surf-inset,#0b0e13);color:var(--text,#c7d1dc);
  font-size:var(--fs-11,11px);padding:3px 9px;border-radius:var(--r-ctl,6px);cursor:pointer}
.xhgcs-ext-actions button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e9f1fa)}
.xhgcs-empty{color:var(--text-dim,#8b97a5);font-size:var(--fs-12,12px);padding:16px 4px;text-align:center}
`;
  document.head.appendChild(style);
}

function mountMask(kind: 'palette' | 'panel', onClose: () => void): { mask: HTMLElement; close: () => void } {
  ensureShellStyles();
  const mask = document.createElement('div');
  mask.className = 'xhgcs-mask';
  mask.dataset.kind = kind;
  document.body.appendChild(mask);
  let closed = false;
  // Esc 交给统一浮层栈处理：层叠时只关最上层，不再各关各的
  let disposeOverlay: () => void = () => undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    disposeOverlay();
    mask.remove();
    onClose();
  };
  disposeOverlay = pushOverlay({ id: kind === 'palette' ? 'palette' : 'extensions', kind: 'panel', close });
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close();
  });
  return { mask, close };
}

let paletteVisible = false;

export function openPalette(): void {
  if (paletteVisible) return;
  paletteVisible = true;
  const { mask, close } = mountMask('palette', () => {
    paletteVisible = false;
  });
  const wrap = document.createElement('div');
  wrap.className = 'xhgcs-palette';
  const input = document.createElement('input');
  input.placeholder = '搜索命令 / 扩展入口…';
  input.autocomplete = 'off';
  const search = document.createElement('div');
  search.className = 'xhgcs-palette-search';
  const ico = document.createElement('span');
  ico.className = 'xhgcs-search-ico';
  ico.textContent = '⌕';
  search.append(ico, input);
  const list = document.createElement('div');
  list.className = 'xhgcs-palette-list';
  const foot = document.createElement('div');
  foot.className = 'xhgcs-palette-foot';
  foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span>';
  wrap.append(search, list, foot);
  mask.appendChild(wrap);

  let filtered = listCommands();
  let cursor = 0;

  const render = () => {
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'xhgcs-empty';
      empty.textContent = '没有匹配的命令';
      list.appendChild(empty);
      return;
    }
    filtered.forEach((command, index) => {
      const row = document.createElement('div');
      row.className = 'xhgcs-palette-item';
      row.dataset.active = index === cursor ? '1' : '0';
      const cat = document.createElement('span');
      cat.className = 'xhgcs-palette-cat';
      cat.textContent = command.category || '命令';
      const title = document.createElement('b');
      title.textContent = command.title;
      const id = document.createElement('small');
      id.textContent = command.id;
      row.append(cat, title, id);
      row.addEventListener('mouseenter', () => {
        cursor = index;
        render();
      });
      row.addEventListener('click', () => {
        cursor = index;
        run();
      });
      list.appendChild(row);
    });
    const active = list.querySelector('[data-active="1"]') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest' });
  };

  const refilter = () => {
    const query = input.value.trim().toLowerCase();
    filtered = listCommands().filter((command) => {
      if (!query) return true;
      return `${command.id} ${command.title} ${command.category}`.toLowerCase().includes(query);
    });
    cursor = 0;
    render();
  };

  const run = () => {
    const target = filtered[cursor];
    if (!target) return;
    close();
    executeCommand(target.id).catch(() => undefined);
  };

  input.addEventListener('input', refilter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(filtered.length - 1, cursor + 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  render();
  window.setTimeout(() => input.focus(), 10);
}

/** 扩展面板同时也是一个“体检视图”：状态、失败原因、重载入口都在这里。 */
export function openExtensions(): void {
  const { mask, close } = mountMask('panel', () => undefined);
  const panel = document.createElement('div');
  panel.className = 'xhgcs-panel';
  const head = document.createElement('div');
  head.className = 'xhgcs-panel-head';
  const title = document.createElement('h3');
  title.textContent = '扩展管理';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'xhgcs-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);
  const body = document.createElement('div');
  body.className = 'xhgcs-panel-body';
  panel.append(head, body);
  mask.appendChild(panel);

  const render = () => {
    body.replaceChildren();
    const records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'xhgcs-empty';
      empty.textContent = '还没有发现任何扩展。把插件放进 plugins/ 目录后刷新即可。';
      body.appendChild(empty);
      return;
    }
    for (const record of records) {
      const row = document.createElement('div');
      row.className = 'xhgcs-ext';
      const main = document.createElement('div');
      main.className = 'xhgcs-ext-main';
      const titleEl = document.createElement('div');
      titleEl.className = 'xhgcs-ext-title';
      const name = document.createElement('span');
      name.textContent = record.manifest.name;
      const chip = document.createElement('span');
      chip.className = 'xhgcs-chip';
      chip.dataset.s = record.status;
      chip.textContent = record.status;
      titleEl.append(name, chip);
      const id = document.createElement('div');
      id.className = 'xhgcs-ext-id';
      id.textContent = `${record.manifest.id} · v${record.manifest.version}`;
      main.append(titleEl, id);
      if (record.message) {
        const msg = document.createElement('div');
        msg.className = 'xhgcs-ext-msg';
        msg.textContent = record.message;
        main.appendChild(msg);
      }
      const actions = document.createElement('div');
      actions.className = 'xhgcs-ext-actions';
      if (record.status === 'pending') {
        // 待授权：把权限逐条列出来，让用户自己勾；高风险默认不勾
        const box = document.createElement('div');
        box.className = 'xhgcs-consent';
        const perms = record.manifest.permissions || [];
        const checks: Array<{ permission: string; input: HTMLInputElement }> = [];
        for (const permission of perms) {
          const row = document.createElement('label');
          row.className = 'xhgcs-consent-row';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !RISKY_PERMISSIONS.has(permission);
          const text = document.createElement('span');
          text.textContent = permission;
          row.append(input, text);
          box.appendChild(row);
          checks.push({ permission, input });
        }
        const trust = document.createElement('div');
        trust.className = 'xhgcs-consent-note';
        trust.textContent = '插件代码以应用权限运行（不是沙箱），只授权你信任的插件。';
        box.appendChild(trust);
        const confirm = document.createElement('button');
        confirm.textContent = '授权并启用';
        confirm.addEventListener('click', async () => {
          const chosen = checks.filter((item) => item.input.checked).map((item) => item.permission);
          host.grantAccess(record.manifest.id, chosen);
          await host.activate(record.manifest.id, 'consent');
          render();
        });
        box.appendChild(confirm);
        main.appendChild(box);
      }
      if (record.status === 'disabled') {
        const enable = document.createElement('button');
        enable.textContent = '启用';
        enable.addEventListener('click', async () => {
          await host.enable(record.manifest.id);
          if ((record.manifest.activationEvents || []).some((event) => event === 'onStartup' || event === '*')) {
            await host.activate(record.manifest.id, 'manual');
          }
          render();
        });
        actions.appendChild(enable);
      } else {
        const reload = document.createElement('button');
        reload.textContent = '重载';
        reload.addEventListener('click', async () => {
          await host.reload(record.manifest.id);
          render();
        });
        const disable = document.createElement('button');
        disable.textContent = '停用';
        disable.addEventListener('click', async () => {
          await host.disable(record.manifest.id);
          render();
        });
        actions.append(reload, disable);
      }
      row.append(main, actions);
      body.appendChild(row);
    }
  };

  host.onDidChange(() => {
    if (document.body.contains(mask)) render();
  });
  render();
}
