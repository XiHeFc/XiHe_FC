/**
 * 内置数据源与回放。
 *
 * 源只是“能产帧的东西”：主数据链采样、内存录制回放、以后的仿真/串口/外部脚本
 * 都实现同一个 `start(emit) / stop()`，背压与调度都在管线里，源不需要关心。
 */
import type { Frame, FrameRecorder, PipelineSource, PipelineRuntime } from './pipeline';

interface ChannelLike {
  id: string;
  data?: number[];
}

interface LegacyEnv {
  XHGCS?: {
    state?: {
      channels?: ChannelLike[];
      scriptChannels?: ChannelLike[];
    };
  };
}

function collect(values: Record<string, number>, list: ChannelLike[] | undefined): number {
  if (!Array.isArray(list)) return 0;
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const channel = list[i];
    const data = channel && channel.data;
    if (!data || !data.length) continue;
    const last = data[data.length - 1];
    if (typeof last === 'number' && Number.isFinite(last)) {
      values[channel.id] = last;
      count += 1;
    }
  }
  return count;
}

function frameFromSample(event: Event): Frame | null {
  const detail = (event as CustomEvent<{ t?: number; wall?: number; source?: string; filled?: string[] }>).detail || {};
  const state = (window as unknown as LegacyEnv).XHGCS?.state;
  if (!state) return null;
  const values: Record<string, number> = {};
  const raw = collect(values, state.channels);
  const scripts = collect(values, state.scriptChannels);
  if (!raw && !scripts) return null;
  const frame: Frame = {
    t: Number(detail.t) || 0,
    wall: Number(detail.wall) || Date.now(),
    source: String(detail.source || 'sample'),
    values
  };
  if (Array.isArray(detail.filled) && detail.filled.length) frame.filled = detail.filled.slice();
  return frame;
}

/** 主数据链：老界面每采到一个点就派发 xhgcs:sample，这里把最新值快照成一帧。 */
export function legacySampleSource(): PipelineSource {
  let handler: ((event: Event) => void) | null = null;
  return {
    id: 'builtin.legacy-sample',
    label: '主数据链采样',
    start(emit) {
      if (handler) return;
      handler = (event) => {
        const frame = frameFromSample(event);
        if (frame) emit(frame);
      };
      window.addEventListener('xhgcs:sample', handler);
    },
    stop() {
      if (!handler) return;
      window.removeEventListener('xhgcs:sample', handler);
      handler = null;
    }
  };
}

export interface ReplayOptions {
  /** 相对原始间隔的倍速，1 = 原速 */
  speed?: number;
  loop?: boolean;
  /** 相邻帧最短间隔，避免高速回放把 UI 打爆 */
  minGapMs?: number;
}

/**
 * 内存录制回放：按原始 wall 间隔（除以倍速）重放录到的帧。
 * 回放的帧保留原始 t，只把 wall 换成当前时间 —— 数据时间与到达时间分离，这正是三时钟模型的第一层。
 */
export function replaySource(recorder: FrameRecorder, options: ReplayOptions = {}): PipelineSource {
  let timer: number | null = null;
  let stopped = false;
  const speed = Math.max(0.1, Math.min(32, Number(options.speed) || 4));

  const clear = () => {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  return {
    id: 'builtin.replay',
    label: `回放（内存 ×${speed}）`,
    start(emit) {
      const frames = recorder.snapshot();
      if (!frames.length) throw new Error('没有可回放的帧：先打开「内存录制」端点');
      stopped = false;
      let index = 0;
      const tick = () => {
        if (stopped) return;
        if (index >= frames.length) {
          if (!options.loop) {
            stopped = true;
            return;
          }
          index = 0;
        }
        const frame = frames[index];
        index += 1;
        emit({ ...frame, wall: Date.now(), source: 'replay' });
        const next = frames[index];
        const rawGap = next ? Math.max(8, next.wall - frame.wall) : 120;
        const gap = Math.max(options.minGapMs == null ? 16 : options.minGapMs, Math.round(rawGap / speed));
        timer = window.setTimeout(tick, Math.min(1000, gap));
      };
      tick();
    },
    stop() {
      stopped = true;
      clear();
    }
  };
}

/** 兼容旧入口：直接把主数据链接到管线上（内部就是 legacySampleSource）。 */
export function attachLegacySampleSource(target: PipelineRuntime): () => void {
  const source = legacySampleSource();
  const handle = target.registerSource('xihe.core', source);
  target.startSource(source.id);
  return () => handle.dispose();
}
