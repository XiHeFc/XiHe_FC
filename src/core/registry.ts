/**
 * 贡献点注册表：整个框架的唯一真相。
 *
 * 规则只有三条，但每条都关系到“卸载/热重载/失败隔离”能不能一次清干净：
 *   1. 每个贡献都记住 ownerExtId，卸载 = unregisterAll(owner)；
 *   2. 同一个点内 id 唯一；同 owner 重复注册视为覆盖，不同 owner 冲突则拒绝；
 *   3. 变更必须派发事件，UI 订阅事件重绘，禁止各处轮询 registry。
 */
import { Emitter } from './events';
import type { ContributionPoint, Disposable } from './types';

export interface ContributionEntry<T = unknown> {
  point: ContributionPoint;
  id: string;
  value: T;
  owner: string;
  registeredAt: number;
}

export interface RegistryChange {
  kind: 'register' | 'unregister' | 'clear';
  point: ContributionPoint | '*';
  id: string;
  owner: string;
}

export class ContributionRegistry {
  private readonly points = new Map<ContributionPoint, Map<string, ContributionEntry>>();
  private readonly onChange = new Emitter<RegistryChange>();

  onDidChange(listener: (change: RegistryChange) => void): Disposable {
    return this.onChange.on(listener);
  }

  register<T>(point: ContributionPoint, id: string, value: T, owner: string): Disposable {
    const key = String(id || '').trim();
    if (!key) throw new Error(`贡献点 ${point} 的 id 不能为空`);
    let bucket = this.points.get(point);
    if (!bucket) {
      bucket = new Map();
      this.points.set(point, bucket);
    }
    const existing = bucket.get(key);
    if (existing && existing.owner !== owner) {
      throw new Error(`贡献点 ${point} 的 id "${key}" 已被扩展 ${existing.owner} 占用`);
    }
    const entry: ContributionEntry<T> = { point, id: key, value, owner, registeredAt: Date.now() };
    bucket.set(key, entry);
    this.onChange.emit({ kind: 'register', point, id: key, owner });
    let done = false;
    return {
      dispose: () => {
        if (done) return;
        done = true;
        const current = this.points.get(point);
        if (!current) return;
        const now = current.get(key);
        if (!now || now.owner !== owner) return;
        current.delete(key);
        this.onChange.emit({ kind: 'unregister', point, id: key, owner });
      }
    };
  }

  get<T>(point: ContributionPoint, id: string): T | undefined {
    return this.points.get(point)?.get(String(id))?.value as T | undefined;
  }

  entry(point: ContributionPoint, id: string): ContributionEntry | undefined {
    return this.points.get(point)?.get(String(id));
  }

  all<T>(point: ContributionPoint): Array<ContributionEntry<T>> {
    const bucket = this.points.get(point);
    if (!bucket) return [];
    return Array.from(bucket.values()) as Array<ContributionEntry<T>>;
  }

  values<T>(point: ContributionPoint): T[] {
    return this.all<T>(point).map((entry) => entry.value);
  }

  has(point: ContributionPoint, id: string): boolean {
    return Boolean(this.points.get(point)?.has(String(id)));
  }

  owners(point: ContributionPoint): string[] {
    return Array.from(new Set(this.all(point).map((entry) => entry.owner)));
  }

  /** 卸载/热重载的唯一入口：一次清掉某个扩展的全部贡献。 */
  unregisterAll(owner: string): number {
    let removed = 0;
    for (const [point, bucket] of this.points) {
      for (const [id, entry] of Array.from(bucket.entries())) {
        if (entry.owner !== owner) continue;
        bucket.delete(id);
        removed += 1;
        this.onChange.emit({ kind: 'unregister', point, id, owner });
      }
    }
    return removed;
  }

  clear(): void {
    this.points.clear();
    this.onChange.emit({ kind: 'clear', point: '*', id: '*', owner: '*' });
  }

  /** 扩展面板用：按贡献点统计条数。 */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [point, bucket] of this.points) out[point] = bucket.size;
    return out;
  }
}

export const registry = new ContributionRegistry();
