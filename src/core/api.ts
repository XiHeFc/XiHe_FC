/**
 * 扩展 API 投影。
 *
 * 这里是“权限”唯一生效的地方：不是靠 lint 提示别乱来，而是没有授权时
 * 对应属性在 api 对象上根本不存在。插件写 `api.net.fetch(...)` 会在
 * 声明权限之前就抛 TypeError，比运行时拦截更早、更好排查。
 */
import { registerCommand, executeCommand } from './commands';
import { evaluateWhen } from './when';
import { statusBar } from './statusbar';
import { scopedConfiguration } from './config';
import { CORE_API_VERSION } from './manifest';
import { protocols, operators, pipeline } from '../engine';
import type { ConfigurationService } from './config';
import type { ContributionRegistry } from './registry';
import type { ExtensionHost } from './host';
import type { Disposable, ExtensionManifest, HostEnvironment } from './types';
import type { ExtensionStorage } from './storage';

export interface ExtensionApiDeps {
  host: ExtensionHost;
  registry: ContributionRegistry;
  configuration: ConfigurationService;
  commands: { execute: (id: string, ...args: unknown[]) => Promise<unknown> };
  storage: ExtensionStorage;
  env: HostEnvironment;
  getContext: () => Record<string, unknown>;
  activateOnEvent: (event: string, arg?: string) => Promise<void>;
}

type Permissions = Set<string>;

interface LegacyChannel {
  id: string;
  name: string;
  unit?: string;
  color?: string;
  data?: number[];
}

interface LegacyState {
  channels?: LegacyChannel[];
  scriptChannels?: LegacyChannel[];
  view?: string;
  subview?: string;
  channelTab?: string;
  theme?: string;
  protocol?: { id?: string; protocol?: string };
  mcp?: { enabled?: boolean; connected?: boolean };
  simulation?: { enabled?: boolean };
}

function legacyState(): LegacyState | null {
  const state = (window as unknown as { XHGCS?: { state?: LegacyState } }).XHGCS;
  return state && state.state ? state.state : null;
}

function readChannels(includeScript: boolean): LegacyChannel[] {
  const state = legacyState();
  if (!state) return [];
  const raw = Array.isArray(state.channels) ? state.channels.slice() : [];
  if (includeScript && Array.isArray(state.scriptChannels)) raw.push(...state.scriptChannels);
  return raw;
}

/** 内核里的“当前上下文”，所有 when 表达式都从这里取值。 */
export function buildWhenContext(): Record<string, unknown> {
  const state = legacyState();
  const channels = readChannels(true);
  return {
    view: state?.view || '',
    subview: state?.subview || '',
    channelTab: state?.channelTab || '',
    theme: state?.theme || '',
    protocol: state?.protocol?.protocol || state?.protocol?.id || '',
    channelCount: channels.length,
    mcp: state?.mcp || { enabled: false, connected: false },
    simulation: Boolean(state?.simulation?.enabled),
    playing: Boolean((state as unknown as { playing?: boolean } | null)?.playing),
    raws: true,
    extensionCount: 0
  };
}

export function createExtensionApi(
  deps: ExtensionApiDeps,
  manifest: ExtensionManifest,
  store: { add: <T extends Disposable>(item: T) => T },
  grantedPermissions?: string[]
): Record<string, unknown> {
  // 授权页存在时，能力 = 清单声明 ∩ 用户同意；没有授权页（内置/随包扩展）时沿用清单声明。
  const granted: Permissions = new Set(grantedPermissions || manifest.permissions || []);
  const has = (permission: string): boolean => granted.has(permission);
  const owner = manifest.id;

  const api: Record<string, unknown> = {
    version: CORE_API_VERSION,
    extension: {
      id: owner,
      version: manifest.version,
      path: `plugins/${owner}/`
    },
    env: {
      platform: deps.env ? 'desktop-or-web' : 'web',
      core: CORE_API_VERSION
    },
    log: (message: string, detail?: unknown) => deps.env.log('info', `[${owner}] ${message}`, detail),
    when: (expression: string | undefined, context?: Record<string, unknown>) =>
      evaluateWhen(expression, { ...deps.getContext(), ...(context || {}) })
  };

  // ---- 命令 ----
  api.commands = {
    register(id: string, handler: (...args: unknown[]) => unknown): Disposable {
      const disposable = registerCommand(owner, id, handler);
      store.add(disposable);
      return disposable;
    },
    execute: has('commands:execute')
      ? (id: string, ...args: unknown[]) => deps.commands.execute(id, ...args)
      : undefined
  };

  // ---- 状态栏 ----
  if (has('ui:statusBar')) {
    api.statusBar = {
      add(item: { id: string; text: string; alignment?: 'left' | 'right'; priority?: number; command?: string; tooltip?: string; tone?: 'default' | 'info' | 'warn' | 'error' | 'ok' }): Disposable {
        const disposable = statusBar.add(owner, { tone: 'default', ...item });
        store.add(disposable);
        return disposable;
      },
      update(id: string, patch: Record<string, unknown>): void {
        statusBar.update(owner, id, patch as never);
      },
      remove(id: string): void {
        statusBar.remove(owner, id);
      }
    };
  }

  // ---- 视图 / 控件 / 协议 / 算子 / 数据源 ----
  if (has('ui:view')) {
    api.views = {
      register(id: string, implementation: unknown): Disposable {
        deps.host.runtime.views.set(`${owner}:${id}`, { owner, implementation });
        return {
          dispose: () => {
            deps.host.runtime.views.delete(`${owner}:${id}`);
          }
        };
      },
      get<T = unknown>(id: string): T | undefined {
        const hit = deps.host.runtime.views.get(`${owner}:${id}`);
        return (hit as { implementation?: T } | undefined)?.implementation;
      }
    };
  }

  if (has('ui:panel')) {
    api.widgets = {
      register(id: string, implementation: unknown): void {
        deps.host.runtime.widgets.set(`${owner}:${id}`, { owner, implementation });
      }
    };
  }

  if (has('data:read')) {
    api.data = {
      channels: () => readChannels(false).map((channel) => ({ id: channel.id, name: channel.name, unit: channel.unit || '', color: channel.color || '' })),
      latest(id: string): number | undefined {
        const channel = readChannels(true).find((item) => item.id === id);
        const data = channel?.data;
        return data && data.length ? data[data.length - 1] : undefined;
      },
      series(id: string, limit = 200): number[] {
        const channel = readChannels(true).find((item) => item.id === id);
        const data = channel?.data;
        if (!data) return [];
        const count = Math.max(0, Math.min(limit, data.length));
        return data.slice(data.length - count);
      },
      scriptChannels: () => readChannels(true).filter((channel) => (channel as { isScript?: boolean }).isScript).map((channel) => channel.id)
    };
  }

  if (has('data:write')) {
    api.dataWrite = {
      push(channelId: string, value: number): boolean {
        const legacy = (window as unknown as { XHGCS?: { pushSample?: (ch: unknown, value: number) => void } }).XHGCS;
        const channel = readChannels(true).find((item) => item.id === channelId);
        if (!channel || typeof legacy?.pushSample !== 'function') return false;
        legacy.pushSample(channel, value);
        return true;
      }
    };
  }

  // ---- 配置 ----
  const config = scopedConfiguration(owner);
  if (has('config:read')) {
    api.config = {
      get: config.get,
      all: config.all,
      has: config.has,
      onDidChange: (listener: (key: string, value: unknown, previous: unknown) => void) => {
        const disposable = config.onDidChange(listener);
        store.add(disposable);
        return disposable;
      },
      update: has('config:write') ? config.update : undefined
    };
  }

  // ---- 存储 ----
  if (has('storage:own')) {
    api.storage = {
      get: deps.storage.get,
      set: deps.storage.set,
      remove: deps.storage.remove,
      keys: deps.storage.keys
    };
  }

  // ---- UI ----
  if (has('ui:toast')) {
    api.toast = (message: string) => deps.env.toast(String(message));
  }

  // ---- AI 工具 ----
  api.ai = {
    registerTool(tool: { name: string; description: string; parameters?: Record<string, unknown>; run: (...args: unknown[]) => unknown }): Disposable {
      const key = `${owner}:${tool.name}`;
      deps.host.runtime.aiTools.set(key, { owner, tool });
      return {
        dispose: () => {
          deps.host.runtime.aiTools.delete(key);
        }
      };
    }
  };

  // ---- 数据引擎：协议 / 算子 ----
  if (has('protocols:own')) {
    api.protocols = {
      register(adapter: Parameters<typeof protocols.register>[1]): Disposable {
        const disposable = protocols.register(owner, adapter);
        store.add(disposable);
        return disposable;
      },
      list: () => protocols.list().map((adapter) => ({ id: adapter.id, label: adapter.label }))
    };
  }
  if (has('operators:own')) {
    api.operators = {
      register(impl: Parameters<typeof operators.register>[1]): Disposable {
        const disposable = operators.register(owner, impl);
        store.add(disposable);
        return disposable;
      },
      list: () => operators.list().map((impl) => ({ id: impl.id, label: impl.label }))
    };
  }

  if (has('pipeline:own')) {
    api.pipeline = {
      registerOperator(operator: Parameters<typeof pipeline.registerOperator>[1]): Disposable {
        const disposable = pipeline.registerOperator(owner, operator);
        store.add({ dispose: disposable.dispose });
        return { dispose: disposable.dispose };
      },
      registerSink(sink: Parameters<typeof pipeline.registerSink>[1]): Disposable {
        const disposable = pipeline.registerSink(owner, sink);
        store.add({ dispose: disposable.dispose });
        return { dispose: disposable.dispose };
      },
      metrics: () => pipeline.metrics()
    };
  }

  // ---- 网络：默认不给 ----
  if (has('network')) {
    api.net = {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args)
    };
  }

  // ---- 事件：激活别的扩展 ----
  api.activation = {
    fire: (event: string, arg?: string) => deps.activateOnEvent(event, arg)
  };

  return api;
}

export { executeCommand };
