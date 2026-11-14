/**
 * 命令与快捷键。
 *
 * 命令是插件最便宜的能力出口：一条 id + 一个函数，就能挂到活动栏、菜单、
 * 状态栏、快捷键和 AI 工具循环上。所以这里必须先立住，别让每个面板自己写 click。
 */
import { Emitter } from './events';
import { registry } from './registry';
import { evaluateWhen } from './when';
import type { CommandContribution, Disposable, KeybindingContribution } from './types';

export type CommandHandler = (...args: unknown[]) => unknown;

export interface CommandInfo {
  id: string;
  title: string;
  category: string;
  owner: string;
  handler: CommandHandler;
}

const handlers = new Map<string, CommandInfo>();
const onExecute = new Emitter<{ id: string; args: unknown[]; ok: boolean; error: string }>();

export function onDidExecuteCommand(listener: (event: { id: string; args: unknown[]; ok: boolean; error: string }) => void): Disposable {
  return onExecute.on(listener);
}

/** 注册贡献（清单里的 commands 段）与实现分离：清单可以先到，代码等激活。 */
export function registerCommandContribution(owner: string, contribution: CommandContribution): Disposable {
  return registry.register('commands', contribution.id, contribution, owner);
}

export function registerCommand(owner: string, id: string, handler: CommandHandler): Disposable {
  if (handlers.has(id)) {
    const existing = handlers.get(id) as CommandInfo;
    if (existing.owner !== owner) throw new Error(`命令 ${id} 已被扩展 ${existing.owner} 注册`);
  }
  const contribution = registry.get<CommandContribution>('commands', id);
  handlers.set(id, {
    id,
    title: contribution?.title || id,
    category: contribution?.category || '',
    owner,
    handler
  });
  return {
    dispose: () => {
      const current = handlers.get(id);
      if (current && current.owner === owner) handlers.delete(id);
    }
  };
}

export function hasCommand(id: string): boolean {
  return handlers.has(id);
}

export function listCommands(): CommandInfo[] {
  return Array.from(handlers.values()).sort((a, b) => `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`));
}

export function isCommandEnabled(id: string, context: Record<string, unknown> = {}): boolean {
  const contribution = registry.get<CommandContribution>('commands', id);
  if (!contribution) return false;
  if (handlers.has(id) === false) return false;
  return evaluateWhen(contribution.when, context);
}

let activationHook: ((id: string) => Promise<void>) | null = null;

/** 宿主注入：命令未注册时按 onCommand:<id> 拉起对应扩展，再重试一次。 */
export function setCommandActivationHook(hook: ((id: string) => Promise<void>) | null): void {
  activationHook = hook;
}

export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  let info = handlers.get(id);
  if (!info && activationHook) {
    // 命令已声明但扩展还没激活：先按 onCommand:<id> 拉起插件，再执行一次。
    try {
      await activationHook(id);
    } catch {
      /* 激活失败继续走下面对话，报错信息更具体 */
    }
    info = handlers.get(id);
  }
  if (!info) {
    const contribution = registry.get<CommandContribution>('commands', id);
    const detail = contribution
      ? `命令 ${id} 已声明但尚未激活（缺少激活事件 onCommand:${id}？）`
      : `未注册的命令 ${id}`;
    onExecute.emit({ id, args, ok: false, error: detail });
    throw new Error(detail);
  }
  try {
    const result = await info.handler(...args);
    onExecute.emit({ id, args, ok: true, error: '' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onExecute.emit({ id, args, ok: false, error: message });
    console.warn(`[XHGCS_CORE] 命令 ${id} 执行失败`, err);
    throw err;
  }
}

// ===== 快捷键 =====

export interface KeybindingInfo {
  key: string;
  command: string;
  when: string;
  owner: string;
}

const bindings: KeybindingInfo[] = [];
let keyListenerInstalled = false;

export function normalizeKey(input: string): string {
  const parts = String(input || '')
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') mods.add('ctrl');
    else if (part === 'shift') mods.add('shift');
    else if (part === 'alt' || part === 'option') mods.add('alt');
    else if (part === 'meta' || part === 'cmd' || part === 'win') mods.add('meta');
    else key = part;
  }
  const ordered: string[] = [];
  if (mods.has('ctrl')) ordered.push('ctrl');
  if (mods.has('alt')) ordered.push('alt');
  if (mods.has('shift')) ordered.push('shift');
  if (mods.has('meta')) ordered.push('meta');
  ordered.push(key);
  return ordered.join('+');
}

function eventToKey(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  const key = String(event.key || '').toLowerCase();
  const named: Record<string, string> = {
    ' ': 'space',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    escape: 'escape',
    enter: 'enter',
    tab: 'tab',
    backspace: 'backspace',
    delete: 'delete'
  };
  parts.push(named[key] || key);
  return parts.join('+');
}

export function registerKeybinding(owner: string, contribution: KeybindingContribution): Disposable {
  const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
  const key = normalizeKey((isMac && contribution.mac) || contribution.key);
  const info: KeybindingInfo = {
    key,
    command: contribution.command,
    when: contribution.when || '',
    owner
  };
  bindings.push(info);
  return {
    dispose: () => {
      const index = bindings.indexOf(info);
      if (index >= 0) bindings.splice(index, 1);
    }
  };
}

export function listKeybindings(): KeybindingInfo[] {
  return bindings.slice();
}

/**
 * 安装全局 keydown。刻意挂在 window 的捕获阶段之后（bubble），
 * 让输入框优先吃掉普通按键；只有带修饰键或功能键才在 bubble 里处理。
 */
export function installKeybindingListener(getContext: () => Record<string, unknown>): Disposable {
  if (keyListenerInstalled) return { dispose: () => undefined };
  keyListenerInstalled = true;
  const listener = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    const tag = (target?.tagName || '').toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
    const key = eventToKey(event);
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (editing && plain) return;
    const context = getContext();
    const hit = bindings
      .filter((binding) => binding.key === key)
      .filter((binding) => evaluateWhen(binding.when, context))
      .sort((a, b) => b.when.length - a.when.length)[0];
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    executeCommand(hit.command).catch((err) => console.warn('[XHGCS_CORE] 快捷键命令失败', hit.command, err));
  };
  window.addEventListener('keydown', listener);
  return {
    dispose: () => {
      window.removeEventListener('keydown', listener);
      keyListenerInstalled = false;
    }
  };
}
