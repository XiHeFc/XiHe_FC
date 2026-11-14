/**
 * 常驻数据引擎：Source → Operator* → Sink。
 *
 * 与画布（分析用 DAG）分开：这里是“同一个采样点流经所有阶段”的流式管线，
 * 面向的是采集后的实时处理（滤波、对齐、缓存、录制、告警、外发）。
 *
 * 三条设计约束（照抄 VSCode 的经验：内核只提供机制，策略交给贡献）：
 *  1. 每帧带时间戳。没有时间戳的流没法回放、没法多源对齐，也没法解释“这个点是什么时候到的”。
 *  2. 入口有界 + 帧预算。订阅方再慢也不能把内存吃满或拖垮 UI 帧率。
 *  3. 任何阶段抛错只影响它自己：计数 + 最近错误，绝不中断管线。
 */

export interface Frame {
  /** 采样时间（秒，与通道 t 同一语义） */
  t: number;
  /** 墙钟毫秒，用于跨源对齐与回放 */
  wall: number;
  source: string;
  /** 通道 id → 值 */
  values: Record<string, number>;
  /** 本帧被前向填充的通道（与老代码 filled 语义一致） */
  filled?: string[];
}

export type OperatorResult = Frame | null | undefined;

export interface OperatorParamSpec {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select' | 'text';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

export interface PipelineOperator {
  id: string;
  label: string;
  /** 越小越先执行 */
  order?: number;
  /** 可在引擎面板里调的参数；没有就是纯固定行为 */
  params?: OperatorParamSpec[];
  process(frame: Frame): OperatorResult;
  /** 参数变化时被调用；实现负责把值落到自己的闭包/状态里 */
  configure?(values: Record<string, unknown>): void;
  reset?(): void;
}

export interface PipelineSink {
  id: string;
  label: string;
  write(frame: Frame): void;
  flush?(): void;
}

/**
 * 数据源：任何能“产帧”的东西都能接进来（仿真、串口、录制回放、外部脚本）。
 * 源只负责 emit，背压/调度由管线统一处理。
 */
export interface PipelineSource {
  id: string;
  label: string;
  start(emit: (frame: Frame) => void): void;
  stop(): void;
}

/** 内存录制器：既当 Sink 又当回放素材，容量按帧数限额。 */
export class FrameRecorder {
  readonly frames: Frame[] = [];
  constructor(public capacity = 6000) {}

  push(frame: Frame): void {
    this.frames.push(frame);
    if (this.frames.length > this.capacity) {
      this.frames.splice(0, this.frames.length - this.capacity);
    }
  }

  clear(): void {
    this.frames.length = 0;
  }

  get size(): number {
    return this.frames.length;
  }

  snapshot(): Frame[] {
    return this.frames.map((frame) => ({ ...frame, values: { ...frame.values } }));
  }

  sink(id = 'builtin.record', label = '内存录制'): PipelineSink {
    return { id, label, write: (frame) => this.push(frame) };
  }
}

export interface PipelineMetrics {
  queued: number;
  capacity: number;
  processed: number;
  dropped: number;
  errors: number;
  lastFrameAt: number;
  lastT: number;
  avgLatencyMs: number;
  peakQueue: number;
  operators: string[];
  sinks: string[];
  sources: Array<{ id: string; label: string; running: boolean }>;
  running: boolean;
}

interface Entry<T> {
  owner: string;
  value: T;
}

const DEFAULT_CAPACITY = 4096;
const DEFAULT_BUDGET_MS = 8;

export class PipelineRuntime {
  private readonly queue: Frame[] = [];
  private readonly operators = new Map<string, Entry<PipelineOperator>>();
  private readonly sinks = new Map<string, Entry<PipelineSink>>();
  private readonly sources = new Map<string, Entry<PipelineSource>>();
  private readonly runningSources = new Set<string>();
  private readonly enabledOperators = new Set<string>();
  private readonly enabledSinks = new Set<string>();
  private frameHandle: number | null = null;
  private running = false;
  private capacity = DEFAULT_CAPACITY;
  private budgetMs = DEFAULT_BUDGET_MS;
  private processed = 0;
  private dropped = 0;
  private errors = 0;
  private lastFrameAt = 0;
  private lastT = 0;
  private peakQueue = 0;
  private latencyAccum = 0;
  private latencyCount = 0;
  private readonly onMetrics = new Set<(metrics: PipelineMetrics) => void>();
  private readonly recentErrors: Array<{ id: string; message: string; at: number }> = [];

  // ===== 注册 =====

  registerOperator(owner: string, operator: PipelineOperator): { dispose: () => void } {
    if (!operator || !operator.id) throw new Error('管线算子缺少 id');
    const existing = this.operators.get(operator.id);
    if (existing && existing.owner !== owner) throw new Error(`管线算子 ${operator.id} 已被 ${existing.owner} 占用`);
    this.operators.set(operator.id, { owner, value: operator });
    this.enabledOperators.add(operator.id);
    // 注册时把已有参数套上去：面板改过的值在热重载后仍然生效
    if (operator.params && operator.params.length && operator.configure) {
      try {
        operator.configure(this.operatorParamValues(operator.id));
      } catch (err) {
        this.recordError(operator.id, err);
      }
    }
    return {
      dispose: () => {
        const current = this.operators.get(operator.id);
        if (current && current.owner === owner) {
          this.operators.delete(operator.id);
          this.enabledOperators.delete(operator.id);
        }
      }
    };
  }

  registerSink(owner: string, sink: PipelineSink): { dispose: () => void } {
    if (!sink || !sink.id) throw new Error('管线端点缺少 id');
    const existing = this.sinks.get(sink.id);
    if (existing && existing.owner !== owner) throw new Error(`管线端点 ${sink.id} 已被 ${existing.owner} 占用`);
    this.sinks.set(sink.id, { owner, value: sink });
    this.enabledSinks.add(sink.id);
    return {
      dispose: () => {
        const current = this.sinks.get(sink.id);
        if (current && current.owner === owner) {
          this.sinks.delete(sink.id);
          this.enabledSinks.delete(sink.id);
        }
      }
    };
  }

  registerSource(owner: string, source: PipelineSource): { dispose: () => void } {
    if (!source || !source.id) throw new Error('数据源缺少 id');
    const existing = this.sources.get(source.id);
    if (existing && existing.owner !== owner) throw new Error(`数据源 ${source.id} 已被 ${existing.owner} 占用`);
    this.sources.set(source.id, { owner, value: source });
    return {
      dispose: () => {
        const current = this.sources.get(source.id);
        if (!current || current.owner !== owner) return;
        this.stopSource(source.id);
        this.sources.delete(source.id);
      }
    };
  }

  sourceList(): PipelineSource[] {
    return Array.from(this.sources.values()).map((entry) => entry.value);
  }

  isSourceRunning(id: string): boolean {
    return this.runningSources.has(id);
  }

  startSource(id: string): boolean {
    const entry = this.sources.get(id);
    if (!entry) return false;
    if (this.runningSources.has(id)) return true;
    try {
      entry.value.start((frame) => this.ingest(frame));
      this.runningSources.add(id);
      this.start();
      return true;
    } catch (err) {
      this.recordError(id, err);
      return false;
    }
  }

  stopSource(id: string): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    try {
      entry.value.stop();
    } catch (err) {
      this.recordError(id, err);
    }
    this.runningSources.delete(id);
  }

  removeOwner(owner: string): void {
    for (const [id, entry] of Array.from(this.sources)) {
      if (entry.owner === owner) {
        this.stopSource(id);
        this.sources.delete(id);
      }
    }
    for (const [id, entry] of Array.from(this.operators)) if (entry.owner === owner) this.operators.delete(id);
    for (const [id, entry] of Array.from(this.sinks)) if (entry.owner === owner) this.sinks.delete(id);
  }

  setOperatorEnabled(id: string, enabled: boolean): void {
    if (!this.operators.has(id)) return;
    if (enabled) this.enabledOperators.add(id);
    else this.enabledOperators.delete(id);
  }

  isOperatorEnabled(id: string): boolean {
    return this.enabledOperators.has(id);
  }

  setSinkEnabled(id: string, enabled: boolean): void {
    if (!this.sinks.has(id)) return;
    if (enabled) this.enabledSinks.add(id);
    else this.enabledSinks.delete(id);
  }

  operatorList(): PipelineOperator[] {
    return Array.from(this.operators.values())
      .map((entry) => entry.value)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  sinkList(): PipelineSink[] {
    return Array.from(this.sinks.values()).map((entry) => entry.value);
  }

  // ===== 运行 =====

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle != null) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** 入队。满了就丢最老的 —— 实时数据里“旧帧”永远比“新帧”廉价。 */
  ingest(frame: Frame): void {
    if (!frame || !frame.values) return;
    if (this.queue.length >= this.capacity) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(frame);
    if (this.queue.length > this.peakQueue) this.peakQueue = this.queue.length;
    if (!this.running) this.start();
  }

  private schedule(): void {
    if (!this.running || this.frameHandle != null) return;
    this.frameHandle = window.requestAnimationFrame(() => {
      this.frameHandle = null;
      this.drain();
      this.schedule();
    });
  }

  private drain(): void {
    if (!this.queue.length) return;
    const started = performance.now();
    const operators = this.operatorList().filter((operator) => this.enabledOperators.has(operator.id));
    const sinks = this.sinkList().filter((sink) => this.enabledSinks.has(sink.id));
    let guard = 0;
    while (this.queue.length && performance.now() - started < this.budgetMs) {
      const frame = this.queue.shift() as Frame;
      const frameStart = performance.now();
      let current: OperatorResult = frame;
      for (const operator of operators) {
        if (!current) break;
        const before = current;
        try {
          current = operator.process(current);
        } catch (err) {
          this.recordError(operator.id, err);
          current = before;
        }
      }
      if (current) {
        for (const sink of sinks) {
          try {
            sink.write(current);
          } catch (err) {
            this.recordError(sink.id, err);
          }
        }
        this.processed += 1;
        this.lastT = current.t;
        this.lastFrameAt = Date.now();
        this.latencyAccum += performance.now() - frameStart;
        this.latencyCount += 1;
      }
      guard += 1;
      if (guard > 20000) break;
    }
    this.onMetrics.forEach((listener) => {
      try {
        listener(this.metrics());
      } catch {
        /* 观察者失败不影响管线 */
      }
    });
  }

  private recordError(id: string, err: unknown): void {
    this.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    this.recentErrors.push({ id, message, at: Date.now() });
    if (this.recentErrors.length > 20) this.recentErrors.shift();
    console.warn(`[XHGCS_ENGINE] ${id} 处理失败`, err);
  }

  metrics(): PipelineMetrics {
    return {
      queued: this.queue.length,
      capacity: this.capacity,
      processed: this.processed,
      dropped: this.dropped,
      errors: this.errors,
      lastFrameAt: this.lastFrameAt,
      lastT: this.lastT,
      avgLatencyMs: this.latencyCount ? this.latencyAvg() : 0,
      peakQueue: this.peakQueue,
      operators: this.operatorList().filter((operator) => this.enabledOperators.has(operator.id)).map((operator) => operator.id),
      sinks: this.sinkList().filter((sink) => this.enabledSinks.has(sink.id)).map((sink) => sink.id),
      sources: this.sourceList().map((source) => ({
        id: source.id,
        label: source.label,
        running: this.runningSources.has(source.id)
      })),
      running: this.running
    };
  }

  private latencyAvg(): number {
    const avg = this.latencyAccum / Math.max(1, this.latencyCount);
    // 指数衰减：只关心近期抖动，不要被启动阶段的极端值拖住
    this.latencyAccum = this.latencyAccum * 0.9;
    this.latencyCount = Math.max(1, this.latencyCount * 0.9);
    return avg;
  }

  recentErrorList(): Array<{ id: string; message: string; at: number }> {
    return this.recentErrors.slice(-5).reverse();
  }

  onMetricsChange(listener: (metrics: PipelineMetrics) => void): () => void {
    this.onMetrics.add(listener);
    return () => this.onMetrics.delete(listener);
  }

  resetCounters(): void {
    this.processed = 0;
    this.dropped = 0;
    this.errors = 0;
    this.peakQueue = this.queue.length;
    this.latencyAccum = 0;
    this.latencyCount = 0;
  }

  setCapacity(bytes: number): void {
    this.capacity = Math.max(16, Math.min(1 << 20, Math.round(bytes) || DEFAULT_CAPACITY));
  }

  setBudget(ms: number): void {
    this.budgetMs = Math.max(1, Math.min(64, Number(ms) || DEFAULT_BUDGET_MS));
  }

  // ===== 参数 =====

  private readonly operatorParams = new Map<string, Record<string, unknown>>();
  private readonly onParamsChange = new Set<(id: string, values: Record<string, unknown>) => void>();

  /** 当前生效的参数值（默认值 + 用户改过的）。 */
  operatorParamValues(id: string): Record<string, unknown> {
    const operator = this.operators.get(id)?.value;
    const out: Record<string, unknown> = {};
    for (const spec of operator?.params || []) out[spec.key] = spec.default;
    return { ...out, ...(this.operatorParams.get(id) || {}) };
  }

  /** 改参数：立即 configure 生效，并通知订阅者（持久化/面板刷新走这条）。 */
  setOperatorParams(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const entry = this.operators.get(id);
    if (!entry) return {};
    const next = { ...this.operatorParamValues(id), ...patch };
    this.operatorParams.set(id, next);
    try {
      entry.value.configure?.(next);
    } catch (err) {
      this.recordError(id, err);
    }
    this.onParamsChange.forEach((listener) => {
      try {
        listener(id, next);
      } catch {
        /* 观察者失败不影响参数生效 */
      }
    });
    return next;
  }

  onOperatorParamsChange(listener: (id: string, values: Record<string, unknown>) => void): () => void {
    this.onParamsChange.add(listener);
    return () => this.onParamsChange.delete(listener);
  }

  get queueDepth(): number {
    return this.queue.length;
  }
}

export const pipeline = new PipelineRuntime();

// ===== 内置阶段 =====

/** 原样透传：链为空时的默认阶段，也是“暂停处理”的开关。 */
export function passthrough(): PipelineOperator {
  return { id: 'builtin.pass', label: '直通', order: 0, process: (frame) => frame };
}

/** 单通道线性缩放：y = x * k + b，参数可在引擎面板里改。 */
export function scaleOperator(): PipelineOperator {
  let channel = '';
  let k = 1;
  let b = 0;
  return {
    id: 'builtin.scale',
    label: '线性缩放',
    order: 10,
    params: [
      { key: 'channel', label: '通道 id', type: 'text', default: '', help: '留空则直接跳过' },
      { key: 'k', label: '系数 k', type: 'number', default: 1, step: 0.1 },
      { key: 'b', label: '偏移 b', type: 'number', default: 0, step: 0.1 }
    ],
    configure(values) {
      channel = String(values.channel || '').trim();
      const nextK = Number(values.k);
      const nextB = Number(values.b);
      k = Number.isFinite(nextK) ? nextK : 1;
      b = Number.isFinite(nextB) ? nextB : 0;
    },
    process(frame) {
      if (!channel) return frame;
      const value = frame.values[channel];
      if (typeof value !== 'number') return frame;
      return { ...frame, values: { ...frame.values, [channel]: value * k + b } };
    }
  };
}

/** 一阶低通：y += alpha * (x - y)，按通道独立；α 可调。 */
export function lowpassOperator(): PipelineOperator {
  const state = new Map<string, number>();
  let alpha = 0.25;
  return {
    id: 'builtin.lowpass',
    label: '一阶低通',
    order: 20,
    params: [{ key: 'alpha', label: 'α（越小越平滑）', type: 'number', default: 0.25, min: 0.001, max: 1, step: 0.01 }],
    configure(values) {
      const next = Number(values.alpha);
      if (Number.isFinite(next)) alpha = Math.max(0.001, Math.min(1, next));
    },
    process(frame) {
      const values = { ...frame.values };
      for (const key of Object.keys(values)) {
        const raw = values[key];
        if (typeof raw !== 'number') continue;
        const prev = state.get(key);
        const next = prev == null ? raw : prev + alpha * (raw - prev);
        state.set(key, next);
        values[key] = next;
      }
      return { ...frame, values };
    },
    reset: () => state.clear()
  };
}

/** 滑动窗口均值：只对指定通道算，窗口点数可调。 */
export function windowMeanOperator(): PipelineOperator {
  const buffers = new Map<string, number[]>();
  let channel = '';
  let size = 10;
  return {
    id: 'builtin.mean',
    label: '滑动均值',
    order: 30,
    params: [
      { key: 'channel', label: '通道 id', type: 'text', default: '', help: '留空则直接跳过' },
      { key: 'size', label: '窗口点数', type: 'number', default: 10, min: 2, max: 2000, step: 1 }
    ],
    configure(values) {
      channel = String(values.channel || '').trim();
      const next = Number(values.size);
      size = Number.isFinite(next) ? Math.max(2, Math.min(2000, Math.round(next))) : 10;
    },
    process(frame) {
      if (!channel) return frame;
      const raw = frame.values[channel];
      if (typeof raw !== 'number') return frame;
      let buffer = buffers.get(channel);
      if (!buffer) {
        buffer = [];
        buffers.set(channel, buffer);
      }
      buffer.push(raw);
      while (buffer.length > size) buffer.shift();
      const sum = buffer.reduce((acc, value) => acc + value, 0);
      return { ...frame, values: { ...frame.values, [channel]: sum / buffer.length } };
    },
    reset: () => buffers.clear()
  };
}

/** 阈值：超过即给本帧打标签，交给 Sink 决定怎么处理（记录/外发/告警）。 */
export function thresholdOperator(): PipelineOperator {
  let channel = '';
  let min = 0;
  let max = 0;
  return {
    id: 'builtin.threshold',
    label: '阈值标记',
    order: 40,
    params: [
      { key: 'channel', label: '通道 id', type: 'text', default: '' },
      { key: 'min', label: '下限', type: 'number', default: 0, step: 1 },
      { key: 'max', label: '上限', type: 'number', default: 100, step: 1 }
    ],
    configure(values) {
      channel = String(values.channel || '').trim();
      min = Number.isFinite(Number(values.min)) ? Number(values.min) : 0;
      max = Number.isFinite(Number(values.max)) ? Number(values.max) : 100;
    },
    process(frame) {
      if (!channel) return frame;
      const value = frame.values[channel];
      if (typeof value !== 'number') return frame;
      if (value < min || value > max) {
        const frames = frame as Frame & { flags?: string[] };
        frames.flags = (frames.flags || []).concat(`${channel}:${value}`);
      }
      return frame;
    }
  };
}

/** 指标端点：只统计，不写任何地方。默认启用，用来证明管线在跑。 */
export function metricsSink(onWrite?: (frame: Frame) => void): PipelineSink {
  let count = 0;
  return {
    id: 'builtin.metrics',
    label: '指标',
    write(frame) {
      count += 1;
      onWrite?.(frame);
    }
  };
}

/** 通道端点：把处理后的值写回老通道（默认关闭，避免双写）。 */
export function channelSink(mapping?: Record<string, string>): PipelineSink {
  return {
    id: 'builtin.channels',
    label: '写回通道',
    write(frame) {
      const legacy = (window as unknown as { XHGCS?: { state?: { channels?: Array<{ id: string; data?: number[] }> }; pushSample?: (channel: unknown, value: number) => void } }).XHGCS;
      if (!legacy || !legacy.state || typeof legacy.pushSample !== 'function') return;
      for (const [key, value] of Object.entries(frame.values)) {
        const targetId = mapping?.[key] || key;
        const channel = (legacy.state.channels || []).find((item) => item.id === targetId);
        if (channel) legacy.pushSample(channel, value);
      }
    }
  };
}
