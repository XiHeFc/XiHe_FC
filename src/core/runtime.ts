/**
 * 内核单例持有者。
 *
 * 单独一个文件是为了打断循环依赖：UI 需要 host、host 需要 api、api 需要配置，
 * 谁都不应该 import index.ts。
 */
import { ExtensionHost } from './host';
import { registry } from './registry';
import { buildWhenContext } from './api';
import { statusBar } from './statusbar';
import type { HostEnvironment } from './types';

export const env: HostEnvironment = {
  now: () => Date.now(),
  log(level, message, detail) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    if (detail === undefined) fn.call(console, `[XHGCS_CORE] ${message}`);
    else fn.call(console, `[XHGCS_CORE] ${message}`, detail);
  },
  toast(message) {
    const legacy = (window as unknown as { XHGCS_APP?: { toast?: (text: string) => void } }).XHGCS_APP;
    if (legacy && typeof legacy.toast === 'function') {
      legacy.toast(message);
      return;
    }
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;' +
      'background:rgba(20,26,34,.94);color:#e8eef7;border:1px solid rgba(255,255,255,.14);font:13px/1.4 system-ui;' +
      'box-shadow:0 12px 32px rgba(0,0,0,.42)';
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 2600);
  }
};

export const host = new ExtensionHost(env, { registry });
host.setContextProvider(buildWhenContext);
statusBar.setContextProvider(buildWhenContext);
