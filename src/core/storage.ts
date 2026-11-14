/**
 * 扩展私有存储。
 *
 * 与主应用快照（`xhgcs.pro.config.v1`）刻意分开：
 *   - 主快照由 data.js 全量序列化，插件往里塞东西会拖慢每一次 persist()；
 *   - 插件被卸载/重装时只需要清 `xhgcs.ext.<id>.*`，不需要动用户配置。
 * 写入做了 200ms 合并，逐键输入不会打爆 localStorage。
 */

const PREFIX = 'xhgcs.ext.';

export interface ExtensionStorage {
  get<T>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  keys(): string[];
  clear(): void;
  /** 立刻落盘（卸载扩展、页面隐藏时调用） */
  flush(): void;
}

const pendingWrites = new Map<string, string>();
let flushTimer: number | null = null;

function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, 200);
}

function flushPending(): void {
  for (const [key, value] of pendingWrites) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[XHGCS_CORE] 扩展存储写入失败', key, err);
    }
  }
  pendingWrites.clear();
}

if (typeof window !== 'undefined') {
  // 页面隐藏/关闭时不能丢最后一次编辑
  window.addEventListener('pagehide', flushPending);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending();
  });
}

export function createStorage(owner: string): ExtensionStorage {
  const scope = `${PREFIX}${owner}.`;
  const read = (key: string): string | null => {
    const full = scope + key;
    const queued = pendingWrites.get(full);
    if (queued != null) return queued;
    try {
      return localStorage.getItem(full);
    } catch {
      return null;
    }
  };

  return {
    get<T>(key: string, fallback?: T): T {
      const raw = read(key);
      if (raw == null) return fallback as T;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback as T;
      }
    },
    set(key: string, value: unknown): void {
      try {
        pendingWrites.set(scope + key, JSON.stringify(value));
      } catch (err) {
        console.warn('[XHGCS_CORE] 扩展存储序列化失败', key, err);
        return;
      }
      scheduleFlush();
    },
    remove(key: string): void {
      const full = scope + key;
      pendingWrites.delete(full);
      try {
        localStorage.removeItem(full);
      } catch {
        /* ignore */
      }
    },
    keys(): string[] {
      const out: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(scope)) out.push(key.slice(scope.length));
        }
      } catch {
        /* ignore */
      }
      for (const key of pendingWrites.keys()) {
        if (key.startsWith(scope)) {
          const short = key.slice(scope.length);
          if (!out.includes(short)) out.push(short);
        }
      }
      return out;
    },
    clear(): void {
      for (const key of this.keys()) this.remove(key);
    },
    flush: flushPending
  };
}

/** 卸载扩展时把它的存储一起清掉（扩展面板的“彻底移除”用）。 */
export function clearStorageOf(owner: string): void {
  const scope = `${PREFIX}${owner}.`;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(scope)) doomed.push(key);
    }
  } catch {
    /* ignore */
  }
  doomed.forEach((key) => {
    pendingWrites.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
}
