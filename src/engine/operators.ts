/**
 * 算子注册表。
 *
 * 分析画布的节点原来是一串写死在 graph-engine.js 里的 if/else：
 * 加一种算子 = 改核心文件 + 改 UI + 改 AI 提示词。现在换成注册表，
 * 插件（和内置能力）统一用 `run(ctx)` 说话。
 *
 * 返回值的形状与老代码保持一致（`{ out: { value, series } }`），
 * 这样切换过去不会改变任何已有画布的行为。
 */
import type { Disposable } from '../core/types';

export interface OperatorContext {
  /** 画布节点（graph-engine 的 node 对象） */
  node: Record<string, unknown>;
  /** 上游输入，按端口顺序 */
  inputs: unknown[];
  /** 分析窗口点数，算子取历史时不要超过它 */
  windowPoints: number;
  findChannel?: (id: string) => unknown;
  state?: unknown;
}

export interface OperatorImpl {
  /** 与画布节点的 type 一致，例如 math / filter / fft / 自定义 id */
  id: string;
  label: string;
  /** 是否异步（Python / 组件这类） */
  async?: boolean;
  run(ctx: OperatorContext): unknown;
}

interface Entry {
  owner: string;
  impl: OperatorImpl;
}

export class OperatorRegistry {
  private readonly entries = new Map<string, Entry>();

  register(owner: string, impl: OperatorImpl): Disposable {
    if (!impl || !impl.id) throw new Error('算子缺少 id');
    const existing = this.entries.get(impl.id);
    if (existing && existing.owner !== owner) throw new Error(`算子 ${impl.id} 已被扩展 ${existing.owner} 注册`);
    this.entries.set(impl.id, { owner, impl });
    return {
      dispose: () => {
        const current = this.entries.get(impl.id);
        if (current && current.owner === owner) this.entries.delete(impl.id);
      }
    };
  }

  removeOwner(owner: string): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === owner) this.entries.delete(id);
    }
  }

  get(id: string): OperatorImpl | undefined {
    return this.entries.get(id)?.impl;
  }

  list(): OperatorImpl[] {
    return Array.from(this.entries.values()).map((entry) => entry.impl);
  }

  /** 命中插件算子就执行并返回结果，否则 null 让老代码继续。 */
  async run(node: Record<string, unknown>, context: Omit<OperatorContext, 'node'>): Promise<unknown> {
    const type = String(node.type || '');
    const impl = this.entries.get(type)?.impl;
    if (!impl) return null;
    try {
      return await impl.run({ ...context, node });
    } catch (err) {
      throw new Error(`算子 ${type} 执行失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const operators = new OperatorRegistry();
