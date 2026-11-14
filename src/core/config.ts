/**
 * 配置服务：贡献点 `configuration` 的落地。
 *
 * 这是整套架构的枢纽 —— 它同时解决三件事：
 *   1. 插件可以自助声明持久化键，不用改 data.js 的 createState/loadState/persist；
 *   2. 设置界面可以由 schema 生成，而不是每个设置项手写 DOM；
 *   3. 配置变更可订阅，视图/DAG 节点能按需响应而不是全量重画。
 *
 * 值统一存 `xhgcs.ext.config.v1`，与主快照分离，卸载插件时可整段移除。
 */
import { Emitter } from './events';
import type { ConfigurationContribution, ConfigurationProperty, Disposable } from './types';

const STORAGE_KEY = 'xhgcs.ext.config.v1';

export interface ConfigChange {
  owner: string;
  key: string;
  value: unknown;
  previous: unknown;
}

export interface ConfigurationSchema {
  owner: string;
  title: string;
  properties: Record<string, ConfigurationProperty>;
}

type FlatConfig = Record<string, unknown>;

function readAll(): FlatConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as FlatConfig) : {};
  } catch {
    return {};
  }
}

export class ConfigurationService {
  private readonly schemas = new Map<string, ConfigurationSchema>();
  private readonly values = new Map<string, unknown>();
  private readonly onChange = new Emitter<ConfigChange>();
  private writeTimer: number | null = null;
  private dirty = false;

  constructor() {
    const stored = readAll();
    for (const [key, value] of Object.entries(stored)) this.values.set(key, value);
  }

  schemaKey(owner: string, key: string): string {
    return `${owner}/${key}`;
  }

  register(owner: string, contribution: ConfigurationContribution): Disposable {
    this.schemas.set(owner, {
      owner,
      title: contribution.title || owner,
      properties: contribution.properties || {}
    });
    // 首次注册时把默认值补进内存，但只在读取时生效（不写盘，避免污染快照）
    return {
      dispose: () => {
        this.schemas.delete(owner);
      }
    };
  }

  schema(owner: string): ConfigurationSchema | undefined {
    return this.schemas.get(owner);
  }

  schemas_(): ConfigurationSchema[] {
    return Array.from(this.schemas.values());
  }

  private propertyOf(owner: string, key: string): ConfigurationProperty | undefined {
    return this.schemas.get(owner)?.properties[key];
  }

  /** 带 schema 校验与默认值的读取。 */
  get(owner: string, key: string): unknown {
    const storageKey = this.schemaKey(owner, key);
    const property = this.propertyOf(owner, key);
    if (this.values.has(storageKey)) {
      return this.coerce(this.values.get(storageKey), property);
    }
    return property ? property.default : undefined;
  }

  update(owner: string, key: string, value: unknown): void {
    const property = this.propertyOf(owner, key);
    const next = this.coerce(value, property);
    const storageKey = this.schemaKey(owner, key);
    const previous = this.get(owner, key);
    if (Object.is(previous, next)) return;
    this.values.set(storageKey, next);
    this.dirty = true;
    this.scheduleWrite();
    this.onChange.emit({ owner, key, value: next, previous });
  }

  onDidChange(listener: (change: ConfigChange) => void): Disposable {
    return this.onChange.on(listener);
  }

  /** 导出给快照/备份用：只包含显式设过的值。 */
  snapshot(): FlatConfig {
    const out: FlatConfig = {};
    for (const [key, value] of this.values) out[key] = value;
    return out;
  }

  dropOwner(owner: string): void {
    const prefix = `${owner}/`;
    for (const key of Array.from(this.values.keys())) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
    this.schemas.delete(owner);
    this.dirty = true;
    this.scheduleWrite();
  }

  /** 只清掉用户设过的值，保留 schema —— 设置页上的「恢复默认」用它。 */
  reset(owner: string): void {
    const prefix = `${owner}/`;
    for (const key of Array.from(this.values.keys())) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
    this.dirty = true;
    this.scheduleWrite();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot()));
    } catch (err) {
      console.warn('[XHGCS_CORE] 配置写入失败', err);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer != null) return;
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 300);
  }

  private coerce(value: unknown, property: ConfigurationProperty | undefined): unknown {
    if (!property) return value;
    switch (property.type) {
      case 'number':
      case 'integer': {
        let num = Number(value);
        if (!Number.isFinite(num)) num = Number(property.default) || 0;
        if (property.type === 'integer') num = Math.round(num);
        if (typeof property.minimum === 'number') num = Math.max(property.minimum, num);
        if (typeof property.maximum === 'number') num = Math.min(property.maximum, num);
        return num;
      }
      case 'boolean':
        return value === true || value === 'true' || value === 1 || value === '1';
      case 'enum': {
        const allowed = property.enum || [];
        const hit = allowed.find((item) => String(item) === String(value));
        return hit === undefined ? property.default : hit;
      }
      case 'array':
        return Array.isArray(value) ? value : Array.isArray(property.default) ? property.default : [];
      case 'object':
        return value && typeof value === 'object' && !Array.isArray(value)
          ? value
          : property.default && typeof property.default === 'object'
            ? property.default
            : {};
      case 'string':
      default:
        return value == null ? property.default : String(value);
    }
  }
}

export const configuration = new ConfigurationService();

/** 给插件用的 scoped 门面。 */
export interface ScopedConfiguration {
  get<T = unknown>(key: string): T;
  update(key: string, value: unknown): void;
  has(key: string): boolean;
  all(): Record<string, unknown>;
  onDidChange(listener: (key: string, value: unknown, previous: unknown) => void): Disposable;
}

export function scopedConfiguration(owner: string): ScopedConfiguration {
  return {
    get<T = unknown>(key: string): T {
      return configuration.get(owner, key) as T;
    },
    update(key: string, value: unknown): void {
      configuration.update(owner, key, value);
    },
    has(key: string): boolean {
      return Boolean(configuration.schema(owner)?.properties[key]);
    },
    all(): Record<string, unknown> {
      const schema = configuration.schema(owner);
      const out: Record<string, unknown> = {};
      if (!schema) return out;
      for (const key of Object.keys(schema.properties)) out[key] = configuration.get(owner, key);
      return out;
    },
    onDidChange(listener) {
      return configuration.onDidChange((change) => {
        if (change.owner !== owner) return;
        listener(change.key, change.value, change.previous);
      });
    }
  };
}
