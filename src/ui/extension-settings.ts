/**
 * 扩展配置表单：由 `configuration` 贡献点的 schema 生成。
 *
 * 两种用法共用同一个渲染函数：
 *   - 设置页里的「扩展」分区（内嵌）；
 *   - Ctrl+Shift+, 打开的独立面板。
 * 这样“加一个设置项不用改设置页”这件事只维护一份实现。
 */
import { configuration } from '../core/config';
import { host } from '../core/runtime';
import type { ConfigurationProperty } from '../core/types';

const STYLE_ID = 'xhgcs-ext-settings-style';

export function ensureConfigStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.xst-body{display:flex;min-height:0;height:100%}
.xst-nav{width:220px;flex:0 0 220px;border-right:1px solid var(--edge-hair,rgba(255,255,255,.08));overflow:auto;padding:8px;background:var(--bg2,#161b22)}
.xst-nav-item{width:100%;text-align:left;border:0;background:transparent;color:var(--text,#c9d4e0);font:12px/1.4 inherit;
  padding:8px 10px;border-radius:8px;cursor:pointer;display:block}
.xst-nav-item:hover{background:var(--bg3,#1f2731)}
.xst-nav-item[data-active="1"]{background:rgba(var(--acc-rgb), .16);color:var(--heading,#e6f2ff)}
.xst-nav-item small{display:block;color:var(--text-dim,#7d8896);font-size:10px;margin-top:2px}
.xst-sec{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim,#7d8896);margin:10px 4px 6px}
.xst-open-dir{width:100%;margin-top:10px;border:1px dashed rgba(255,255,255,.16);background:rgba(var(--acc-rgb), .08);
  color:var(--acc,#6da8d2);font:12px/1 inherit;padding:8px 10px;border-radius:9px;cursor:pointer;transition:background .13s,border-color .13s}
.xst-open-dir:hover{background:rgba(var(--acc-rgb), .16);border-color:rgba(var(--acc-rgb), .5)}
.xst-help{font-size:10px;color:var(--text-dim,#7d8896);margin:6px 4px 0;line-height:1.6;word-break:break-all}
.xst-detail{flex:1 1 auto;overflow:auto;padding:4px 18px 18px;min-width:0}
.xst-row{display:flex;gap:14px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.xst-row:last-child{border-bottom:0}
.xst-copy{flex:1 1 auto;min-width:0}
.xst-key{font-size:12px;color:var(--text,#c9d4e0);font-family:ui-monospace,Consolas,monospace}
.xst-desc{font-size:11px;color:var(--text-dim,#7d8896);margin-top:3px;line-height:1.45}
.xst-control{flex:0 0 220px;display:flex;justify-content:flex-end}
.xst-control input[type="text"],.xst-control input[type="number"],.xst-control select{width:200px;height:28px;border-radius:7px;
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);font:12px/1 inherit;padding:0 8px;outline:none}
.xst-control input:focus,.xst-control select:focus{border-color:var(--acc,#6da8d2)}
.xst-empty{color:var(--text-dim,#7d8896);font-size:12px;padding:22px 4px;text-align:center;line-height:1.7;white-space:pre-line}
.xst-actions{display:flex;gap:8px;margin:6px 0 14px}
.xst-actions button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.xst-actions button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.xst-ext{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.xst-ext:last-child{border-bottom:0}
.xst-ext-main{flex:1 1 auto;min-width:0}
.xst-ext-title{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text,#c9d4e0);font-weight:600}
.xst-ext-id{font-size:11px;color:var(--text-dim,#7d8896);margin-top:2px}
.xst-ext-msg{font-size:11px;color:var(--warn,#fbbf24);margin-top:4px}
.xst-chip{font-size:10px;padding:0 7px;border-radius:999px;border:1px solid currentColor;line-height:1.7}
.xst-chip[data-s="active"]{color:var(--ok,#34d399)}
.xst-chip[data-s="resolved"]{color:var(--acc,#6da8d2)}
.xst-chip[data-s="disabled"]{color:var(--text-dim,#7d8896)}
.xst-chip[data-s="degraded"]{color:var(--warn,#fbbf24)}
.xst-chip[data-s="failed"]{color:var(--danger,#f87171)}
.xst-ext-actions{display:flex;gap:6px}
.xst-ext-actions button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:11px;padding:3px 9px;border-radius:6px;cursor:pointer}
.xst-ext-actions button:hover{border-color:var(--acc,#6da8d2)}
.xst-mask{position:fixed;inset:0;z-index:9650;background:rgba(6,10,16,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
.xst-shell{width:min(880px,92vw);height:min(620px,84vh);display:flex;flex-direction:column;background:var(--surface-1,var(--bg,#0d1117));
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:14px;overflow:hidden;box-shadow:0 28px 70px rgba(0,0,0,.55)}
.xst-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#2d333b);background:var(--bg2,#161b22)}
.xst-head h3{margin:0;font-size:13px;color:var(--heading,#e6f2ff)}
.xst-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#7d8896);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}
.xst-head button:hover{background:var(--bg3,#1f2731);color:var(--text,#c9d4e0)}
.xst-foot{padding:10px 16px;border-top:1px solid var(--line,#2d333b);display:flex;gap:8px;align-items:center;background:var(--bg2,#161b22)}
.xst-foot .xst-hint{color:var(--text-dim,#7d8896);font-size:11px;margin-right:auto}
.xst-foot button{border:1px solid var(--line,#2d333b);background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.xst-foot button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.xst-nav{width:260px;flex:0 0 260px}
.xst-ext{display:flex;gap:10px;align-items:center;padding:8px;border-bottom:1px solid rgba(255,255,255,.05);border-radius:8px}
.xst-ext[data-selectable="1"]{cursor:pointer}
.xst-ext[data-selectable="1"]:hover{background:var(--bg3,#1f2731)}
.xst-ext[data-selectable="1"]:focus-visible{outline:2px solid var(--acc,#6da8d2);outline-offset:-2px}
.xst-ext[data-active="1"]{background:rgba(var(--acc-rgb), .16)}
.xst-ext[data-active="1"] .xst-ext-title{color:var(--heading,#e6f2ff)}
.xst-ext-actions{display:flex;flex:0 0 auto;gap:6px;align-items:center}
.xst-ext-actions button{min-width:44px;height:26px;padding:0 8px;white-space:nowrap;flex:0 0 auto}
.xst-chip[data-s="none"]{color:var(--text-dim,#7d8896);opacity:.8}
.xst-nav{width:310px;flex:0 0 310px}
.xst-ext-title{flex-wrap:nowrap;min-width:0}
.xst-ext-title>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xst-chip{white-space:nowrap;flex:0 0 auto}
.xst-ext-id{display:flex;align-items:center;gap:6px;min-width:0}
.xst-ext-id>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xst-ext-actions{gap:4px}
.xst-control{flex:0 0 200px}
.xst-control input[type="text"],.xst-control input[type="number"],.xst-control select{width:180px}
`;
  document.head.appendChild(style);
}

function buildControl(owner: string, key: string, spec: ConfigurationProperty): HTMLElement {
  const wrap = document.createElement('div');
  const current = configuration.get(owner, key);

  if (spec.type === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = current === true;
    input.addEventListener('change', () => configuration.update(owner, key, input.checked));
    wrap.appendChild(input);
    return wrap;
  }

  if (spec.type === 'enum') {
    const select = document.createElement('select');
    (spec.enum || []).forEach((value, index) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = spec.enumLabels?.[index] || String(value);
      select.appendChild(option);
    });
    select.value = String(current);
    select.addEventListener('change', () => configuration.update(owner, key, select.value));
    wrap.appendChild(select);
    return wrap;
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    const input = document.createElement('input');
    input.type = 'number';
    if (spec.minimum != null) input.min = String(spec.minimum);
    if (spec.maximum != null) input.max = String(spec.maximum);
    if (spec.step != null) input.step = String(spec.step);
    input.value = current == null ? '' : String(current);
    input.addEventListener('change', () => {
      configuration.update(owner, key, Number(input.value));
      input.value = String(configuration.get(owner, key));
    });
    wrap.appendChild(input);
    return wrap;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current == null ? '' : String(current);
  input.addEventListener('change', () => configuration.update(owner, key, input.value));
  wrap.appendChild(input);
  return wrap;
}

/**
 * 把「扩展列表 + 配置表单」渲染进任意容器。
 * 设置页与独立面板都调它，保证两处永远一致。
 */
export function renderExtensionPane(root: HTMLElement, options: { showList?: boolean } = {}): void {
  ensureConfigStyles();
  root.replaceChildren();

  const body = document.createElement('div');
  body.className = 'xst-body';
  const nav = document.createElement('div');
  nav.className = 'xst-nav';
  const detail = document.createElement('div');
  detail.className = 'xst-detail';
  body.append(nav, detail);
  root.appendChild(body);

  let recordsEl: HTMLElement | null = null;
  if (options.showList !== false) {
    const listTitle = document.createElement('div');
    listTitle.className = 'xst-sec';
    listTitle.textContent = '已发现扩展';
    nav.appendChild(listTitle);
    recordsEl = document.createElement('div');
    nav.appendChild(recordsEl);

    // 装机版：用户插件目录是唯一可写的扩展位置，给一个直达入口
    const desktop = (window as unknown as {
      XHGCS_DESKTOP?: { extensions?: { openDir?: () => Promise<unknown>; dir?: () => Promise<string> } };
    }).XHGCS_DESKTOP;
    if (desktop && desktop.extensions && typeof desktop.extensions.openDir === 'function') {
      const openBtn = document.createElement('button');
      openBtn.className = 'xst-open-dir';
      openBtn.textContent = '打开用户插件目录';
      openBtn.title = '把插件文件夹放进去后，点扩展面板的「刷新」或重启应用';
      openBtn.addEventListener('click', () => {
        desktop.extensions?.openDir?.();
      });
      nav.appendChild(openBtn);
      const hint = document.createElement('div');
      hint.className = 'xst-help';
      hint.textContent = '目录：%APPDATA%\\Xuanji\\extensions\\<插件id>\\';
      nav.appendChild(hint);
    }
  }

  const hasSchema = (id: string): boolean => Boolean(configuration.schema(id));
  let records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  let activeId = '';

  const pickActive = () => {
    if (activeId && hasSchema(activeId) && records.some((r) => r.manifest.id === activeId)) return;
    const first = records.find((r) => hasSchema(r.manifest.id));
    if (first) { activeId = first.manifest.id; return; }
    const schemas = configuration.schemas_();
    activeId = schemas.length ? schemas[0].owner : '';
  };

  const renderRows = () => {
    if (!recordsEl) return;
    recordsEl.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'xst-empty';
      empty.textContent = '还没有发现任何扩展';
      recordsEl.appendChild(empty);
      return;
    }
    for (const record of records) {
      const id = record.manifest.id;
      const selectable = hasSchema(id);
      const row = document.createElement('div');
      row.className = 'xst-ext';
      row.dataset.selectable = selectable ? '1' : '0';
      row.dataset.active = selectable && id === activeId ? '1' : '0';
      if (selectable) {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-pressed', id === activeId ? 'true' : 'false');
        row.addEventListener('click', () => {
          if (activeId === id) return;
          activeId = id;
          renderRows();
          renderDetail();
        });
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activeId = id;
          renderRows();
          renderDetail();
        });
      } else {
        row.setAttribute('aria-disabled', 'true');
      }
      const main = document.createElement('div');
      main.className = 'xst-ext-main';
      const title = document.createElement('div');
      title.className = 'xst-ext-title';
      const name = document.createElement('span');
      name.textContent = record.manifest.name;
      const chip = document.createElement('span');
      chip.className = 'xst-chip';
      chip.dataset.s = record.status;
      chip.textContent = record.status;
      title.append(name, chip);
      const idEl = document.createElement('div');
      idEl.className = 'xst-ext-id';
      const idText = document.createElement('span');
      idText.textContent = id;
      idEl.appendChild(idText);
      if (!selectable) {
        const quiet = document.createElement('span');
        quiet.className = 'xst-chip';
        quiet.dataset.s = 'none';
        quiet.textContent = '无配置';
        idEl.appendChild(quiet);
      }
      main.append(title, idEl);
      if (record.message) {
        const msg = document.createElement('div');
        msg.className = 'xst-ext-msg';
        msg.textContent = record.message;
        main.appendChild(msg);
      }
      const actions = document.createElement('div');
      actions.className = 'xst-ext-actions';
      const stop = (event: Event) => event.stopPropagation();
      const toggle = document.createElement('button');
      if (record.status === 'pending') {
        toggle.textContent = '授权';
        toggle.title = '按清单授予权限（高风险能力需要到扩展管理里逐项勾选）';
        toggle.addEventListener('click', async (event) => {
          stop(event);
          host.grantAccess(id);
          await host.activate(id, 'consent');
          refresh();
        });
      } else if (record.status === 'disabled') {
        toggle.textContent = '启用';
        toggle.addEventListener('click', async (event) => {
          stop(event);
          await host.enable(id);
          refresh();
        });
      } else {
        toggle.textContent = '停用';
        toggle.addEventListener('click', async (event) => {
          stop(event);
          await host.disable(id);
          refresh();
        });
      }
      const reload = document.createElement('button');
      reload.textContent = '重载';
      reload.addEventListener('click', async (event) => {
        stop(event);
        await host.reload(id);
        refresh();
      });
      actions.append(toggle, reload);
      row.append(main, actions);
      recordsEl.appendChild(row);
    }
  };

  const renderDetail = () => {
    detail.replaceChildren();
    const schema = activeId ? configuration.schema(activeId) : undefined;
    if (!schema) {
      const empty = document.createElement('div');
      empty.className = 'xst-empty';
      empty.textContent = '当前没有任何扩展声明配置项。';
      detail.appendChild(empty);
      return;
    }
    const entries = Object.entries(schema.properties).sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100));
    for (const [key, spec] of entries) {
      const row = document.createElement('div');
      row.className = 'xst-row';
      const copy = document.createElement('div');
      copy.className = 'xst-copy';
      const keyEl = document.createElement('div');
      keyEl.className = 'xst-key';
      keyEl.textContent = key;
      const desc = document.createElement('div');
      desc.className = 'xst-desc';
      desc.textContent = spec.description || (spec.type + ' · 默认 ' + JSON.stringify(spec.default));
      copy.append(keyEl, desc);
      const control = document.createElement('div');
      control.className = 'xst-control';
      control.appendChild(buildControl(activeId, key, spec));
      row.append(copy, control);
      detail.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'xst-actions';
    const reset = document.createElement('button');
    reset.textContent = '恢复默认';
    reset.addEventListener('click', () => {
      configuration.reset(activeId);
      renderDetail();
    });
    actions.appendChild(reset);
    detail.appendChild(actions);
  };

  const refresh = () => {
    records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    pickActive();
    renderRows();
    renderDetail();
  };

  pickActive();
  renderRows();
  renderDetail();
}

/** Ctrl+Shift+, 打开的独立面板。 */
export function openExtensionSettings(): void {
  ensureConfigStyles();
  const mask = document.createElement('div');
  mask.className = 'xst-mask';
  const shell = document.createElement('div');
  shell.className = 'xst-shell';

  const head = document.createElement('div');
  head.className = 'xst-head';
  const title = document.createElement('h3');
  title.textContent = '扩展配置';
  head.append(title);

  const pane = document.createElement('div');
  pane.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;';
  renderExtensionPane(pane);

  const foot = document.createElement('div');
  foot.className = 'xst-foot';
  const hint = document.createElement('span');
  hint.className = 'xst-hint';
  hint.textContent = '所有值按 schema 校验后写入 xhgcs.ext.config.v1';
  const done = document.createElement('button');
  done.textContent = '完成';
  foot.append(hint, done);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    mask.remove();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  done.addEventListener('click', close);
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close();
  });

  shell.append(head, pane, foot);
  mask.appendChild(shell);
  document.body.appendChild(mask);
}
