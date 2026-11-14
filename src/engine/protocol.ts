/**
 * 协议注册表。
 *
 * 这是「加一种协议要改 serial.js 五处」的解法：协议变成一个可注册的适配器，
 * serial.js 只保留“字节进来了，谁能解”的分派。
 *
 * 内置的 WED/JSON/ASCII/HEX 暂时仍由老代码处理（它们是 v0 的既有行为，不能动）；
 * 注册表里内置的 WED 适配器是给插件作者看的样板，同时保证“第六种协议”真的只改一个文件。
 */
import type { Disposable } from '../core/types';

export interface FrameResult {
  ok: boolean;
  values: Record<string, number>;
  t?: number | null;
  error?: string;
}

export interface ProtocolDefinition {
  name: string;
  label?: string;
  unit?: string;
  scale?: number;
  bias?: number;
}

export interface ProtocolAdapter {
  /** 稳定 id，进清单的 protocols[].id */
  id: string;
  label: string;
  /** 该适配器负责哪些 engine.protocol 值（大写）；留空表示自己判断 */
  protocols?: string[];
  /** 单帧解码；返回 null 表示“不归我管”，让老代码继续 */
  decode(engine: Record<string, unknown>, raw: unknown): FrameResult | null;
  /** 字节流分帧；返回 null 表示用老代码的分帧器 */
  ingest?(engine: Record<string, unknown>, bytes: Uint8Array): { frames: unknown[] } | null;
  encode?(engine: Record<string, unknown>, values: Record<string, number>): Uint8Array | null;
  definitions?(engine: Record<string, unknown>): ProtocolDefinition[];
}

interface Entry {
  owner: string;
  adapter: ProtocolAdapter;
}

export class ProtocolRegistry {
  private readonly entries = new Map<string, Entry>();

  register(owner: string, adapter: ProtocolAdapter): Disposable {
    if (!adapter || !adapter.id) throw new Error('协议适配器缺少 id');
    const existing = this.entries.get(adapter.id);
    if (existing && existing.owner !== owner) {
      throw new Error(`协议 ${adapter.id} 已被扩展 ${existing.owner} 注册`);
    }
    this.entries.set(adapter.id, { owner, adapter });
    return {
      dispose: () => {
        const current = this.entries.get(adapter.id);
        if (current && current.owner === owner) this.entries.delete(adapter.id);
      }
    };
  }

  removeOwner(owner: string): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === owner) this.entries.delete(id);
    }
  }

  list(): ProtocolAdapter[] {
    return Array.from(this.entries.values()).map((entry) => entry.adapter);
  }

  get(id: string): ProtocolAdapter | undefined {
    return this.entries.get(id)?.adapter;
  }

  private claim(engine: Record<string, unknown> | null | undefined): ProtocolAdapter[] {
    const protocol = String((engine && (engine as Record<string, unknown>).protocol) || '').toUpperCase();
    return this.list().filter((adapter) => {
      const owned = adapter.protocols;
      return Array.isArray(owned) && owned.length ? owned.map((value) => String(value).toUpperCase()).includes(protocol) : false;
    });
  }

  /** 单帧解码：命中插件协议返回结果，否则返回 null 交给老代码。 */
  decode(engine: Record<string, unknown>, raw: unknown): FrameResult | null {
    for (const adapter of this.claim(engine)) {
      try {
        const result = adapter.decode(engine, raw);
        if (result) return result;
      } catch (err) {
        console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 解码失败`, err);
        return { ok: false, values: {}, error: String(err instanceof Error ? err.message : err) };
      }
    }
    return null;
  }

  /** 字节流分帧：只有声明了 protocols 的插件协议才会走到这里。 */
  ingest(engine: Record<string, unknown>, bytes: Uint8Array): { frames: unknown[] } | null {
    for (const adapter of this.claim(engine)) {
      if (!adapter.ingest) continue;
      try {
        const result = adapter.ingest(engine, bytes);
        if (result) return result;
      } catch (err) {
        console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 分帧失败`, err);
        return { frames: [] };
      }
    }
    return null;
  }

  encode(engine: Record<string, unknown>, values: Record<string, number>): Uint8Array | null {
    for (const adapter of this.claim(engine)) {
      if (!adapter.encode) continue;
      try {
        const result = adapter.encode(engine, values);
        if (result) return result;
      } catch (err) {
        console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 编码失败`, err);
      }
    }
    return null;
  }

  definitions(engine: Record<string, unknown>): ProtocolDefinition[] {
    for (const adapter of this.claim(engine)) {
      if (!adapter.definitions) continue;
      const result = adapter.definitions(engine);
      if (result && result.length) return result;
    }
    return [];
  }
}

export const protocols = new ProtocolRegistry();

/** 内置 WED 适配器：把老的 XHGCS_PROTOCOL 包一层，给插件作者当参考实现。 */
export function wedAdapter(): ProtocolAdapter {
  const legacy = () =>
    (window as unknown as { XHGCS_PROTOCOL?: { decodeFrame?: (raw: unknown, engine: unknown) => FrameResult; encode?: (values: Record<string, number>, engine: unknown) => Uint8Array; definitions?: (engine: unknown) => ProtocolDefinition[] } })
      .XHGCS_PROTOCOL;
  return {
    id: 'builtin.wed',
    label: 'WED 飞控帧',
    protocols: ['WED'],
    decode(engine, raw) {
      const api = legacy();
      if (!api || typeof api.decodeFrame !== 'function') return null;
      return api.decodeFrame(raw, engine) as FrameResult;
    },
    encode(engine, values) {
      const api = legacy();
      if (!api || typeof api.encode !== 'function') return null;
      return api.encode(values, engine) as Uint8Array;
    },
    definitions(engine) {
      const api = legacy();
      if (!api || typeof api.definitions !== 'function') return [];
      return api.definitions(engine) as ProtocolDefinition[];
    }
  };
}
