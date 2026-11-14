/**
 * 极简事件器。内核里所有“通知”都走它，不用 addEventListener 也不用轮询。
 * 监听器异常必须被隔离：一个扩展的 bug 不能打断其他扩展的派发。
 */
import type { Disposable } from './types';

type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners: Array<{ fn: Listener<T>; once: boolean }> = [];
  private muted = false;

  constructor(private readonly onListenerError?: (err: unknown) => void) {}

  on(fn: Listener<T>): Disposable {
    const entry = { fn, once: false };
    this.listeners.push(entry);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(entry);
        if (index >= 0) this.listeners.splice(index, 1);
      }
    };
  }

  once(fn: Listener<T>): Disposable {
    const entry = { fn, once: true };
    this.listeners.push(entry);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(entry);
        if (index >= 0) this.listeners.splice(index, 1);
      }
    };
  }

  emit(event: T): void {
    if (this.muted) return;
    // 先复制再派发：监听器里 dispose 自己不能导致跳过下一个。
    const snapshot = this.listeners.slice();
    for (const entry of snapshot) {
      try {
        entry.fn(event);
      } catch (err) {
        if (this.onListenerError) {
          try {
            this.onListenerError(err);
          } catch {
            /* 上报本身失败也不能中断派发 */
          }
        }
      }
      if (entry.once) {
        const index = this.listeners.indexOf(entry);
        if (index >= 0) this.listeners.splice(index, 1);
      }
    }
  }

  /** 批量注销时用：停止派发并清空。 */
  clear(): void {
    this.listeners.length = 0;
  }

  get size(): number {
    return this.listeners.length;
  }
}

/** 把一组 Disposable 打包，卸载时一次清干净。 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      try {
        item.dispose();
      } catch {
        /* ignore */
      }
      return item;
    }
    this.items.push(item);
    return item;
  }

  get size(): number {
    return this.items.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i].dispose();
      } catch (err) {
        console.warn('[XHGCS_CORE] 释放资源失败', err);
      }
    }
  }
}
