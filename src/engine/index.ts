/**
 * 数据引擎扩展面。
 *
 * 四件事，每件都是“插件化”的必要条件：
 *   - 协议可注册：加协议不用改 serial.js；
 *   - 算子可注册：加算子不用改 graph-engine.js；
 *   - 管线可注册：常驻流式引擎的 Source/Operator/Sink 都能被扩展替换；
 *   - 源与回放可注册：仿真/串口/录制回放走同一套 `start(emit)/stop()`。
 *
 * 真正的 DAG 执行器仍在 graph-engine 里（它已经是对的拓扑执行器），
 * 这里提供的是“执行前先问注册表”的缺口 —— 小步替换，行为可回滚。
 */
import { protocols, wedAdapter } from './protocol';
import { operators } from './operators';
import {
  pipeline,
  FrameRecorder,
  passthrough,
  scaleOperator,
  lowpassOperator,
  windowMeanOperator,
  thresholdOperator,
  metricsSink,
  channelSink,
  type PipelineSource
} from './pipeline';
import { attachLegacySampleSource, legacySampleSource, replaySource, type ReplayOptions } from './sources';

/** 全局内存录制器：管线端点往里写，回放源从这里读。 */
export const recorder = new FrameRecorder(6000);

const PIPELINE_PARAMS_KEY = 'xhgcs.pipeline.params.v1';

function readPipelineParams(): Record<string, Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(PIPELINE_PARAMS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

/**
 * 绑定参数持久化：启动时把存过的参数套回算子，之后每次改动写盘。
 * 放在引擎入口而不是面板里，是因为 MCP / 脚本也可能改参数，必须同一处落盘。
 */
export function bindPipelineParamPersistence(): void {
  const stored = readPipelineParams();
  for (const [id, values] of Object.entries(stored)) {
    if (values && typeof values === 'object') pipeline.setOperatorParams(id, values);
  }
  pipeline.onOperatorParamsChange((id, values) => {
    const all = readPipelineParams();
    all[id] = values;
    try {
      localStorage.setItem(PIPELINE_PARAMS_KEY, JSON.stringify(all));
    } catch (err) {
      console.warn('[XHGCS_ENGINE] 管线参数保存失败', err);
    }
  });
}

export { readPipelineParams as pipelineParamsSnapshot };

export function replay(options?: ReplayOptions): PipelineSource {
  return replaySource(recorder, options);
}

export const engine = {
  protocols,
  operators,
  pipeline,
  recorder,
  /** 参考实现：把内置 WED 包装成适配器，插件可以据此写自己的二进制协议 */
  wedAdapter,
  /** 内置阶段工厂：插件也可以照着写自己的 */
  stages: {
    passthrough,
    scale: scaleOperator,
    lowpass: lowpassOperator,
    windowMean: windowMeanOperator,
    threshold: thresholdOperator,
    metricsSink,
    channelSink
  },
  sources: {
    legacySample: legacySampleSource,
    replay,
    attachLegacy: attachLegacySampleSource
  },
  attachLegacySampleSource
};

export { protocols, operators, pipeline, attachLegacySampleSource, legacySampleSource, replaySource, FrameRecorder };
export type { ProtocolAdapter, FrameResult } from './protocol';
export type { OperatorImpl, OperatorContext } from './operators';
export type { Frame, PipelineOperator, PipelineSink, PipelineSource, PipelineMetrics } from './pipeline';
