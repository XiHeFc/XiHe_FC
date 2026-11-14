/**
 * 数据管线监视面板。
 *
 * 它只做三件事：把管线指标摊开、把阶段开关交给用户、把最近错误留在眼前。
 * 这一块是“引擎到底有没有在跑”的唯一可信证据 —— 不看它，就只能靠猜。
 */
import { pipeline, type PipelineMetrics } from '../engine/pipeline';
import { recorder } from '../engine';
import { pushOverlay } from '../core/overlay-stack';

const STYLE_ID = 'xhgcs-pipeline-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.pipe-mask{position:fixed;inset:0;z-index:9680;background:rgba(6,10,16,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
.pipe-shell{width:min(820px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--bg,#0d1117);
  border:1px solid var(--line,#2d333b);border-radius:14px;overflow:hidden;box-shadow:0 28px 70px rgba(0,0,0,.55)}
.pipe-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#2d333b);background:var(--bg2,#161b22)}
.pipe-head h3{margin:0;font-size:14px;color:var(--heading,#e6f2ff)}
.pipe-head .pipe-dot{width:7px;height:7px;border-radius:50%;background:var(--ok,#34d399);box-shadow:0 0 8px currentColor}
.pipe-head .pipe-dot[data-on="0"]{background:var(--text-dim,#7d8896);box-shadow:none}
.pipe-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#7d8896);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}
.pipe-head button:hover{background:var(--bg3,#1f2731);color:var(--text,#c9d4e0)}
.pipe-body{overflow:auto;padding:14px 16px 18px}
.pipe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
.pipe-card{border:1px solid var(--line,#2d333b);border-radius:10px;padding:10px 12px;background:var(--bg2,#161b22)}
.pipe-card b{display:block;font-size:19px;color:var(--heading,#e6f2ff);font-variant-numeric:tabular-nums;line-height:1.2}
.pipe-card small{display:block;color:var(--text-dim,#7d8896);font-size:11px;margin-top:4px}
.pipe-card[data-tone="warn"] b{color:var(--warn,#fbbf24)}
.pipe-card[data-tone="error"] b{color:var(--danger,#f87171)}
.pipe-card[data-tone="ok"] b{color:var(--ok,#34d399)}
.pipe-sec{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#7d8896);margin:16px 0 8px}
.pipe-list{display:flex;flex-wrap:wrap;gap:8px}
.pipe-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line,#2d333b);border-radius:999px;
  padding:5px 11px;font-size:12px;color:var(--text,#c9d4e0);background:var(--bg3,#1f2731);cursor:pointer;user-select:none}
.pipe-chip[data-on="0"]{opacity:.5}
.pipe-chip i{width:7px;height:7px;border-radius:50%;background:var(--acc,#6da8d2);font-style:normal}
.pipe-chip[data-on="0"] i{background:var(--text-dim,#7d8896)}
.pipe-err{margin-top:6px;font-size:11.5px;color:var(--warn,#fbbf24);font-family:ui-monospace,Consolas,monospace}
.pipe-foot{padding:10px 16px;border-top:1px solid var(--line,#2d333b);display:flex;gap:8px;align-items:center;background:var(--bg2,#161b22)}
.pipe-foot span{color:var(--text-dim,#7d8896);font-size:11px;margin-right:auto}
.pipe-foot button{border:1px solid var(--line,#2d333b);background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.pipe-foot button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.pipe-empty{color:var(--text-dim,#7d8896);font-size:12px}
.pipe-params{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.pipe-param-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 11px;border:1px solid rgba(255,255,255,.08);
  border-radius:9px;background:rgba(255,255,255,.02)}
.pipe-param-name{font-size:11.5px;color:var(--acc,#6da8d2);min-width:74px}
.pipe-param-field{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#7d8896)}
.pipe-param-field input[type="number"],.pipe-param-field input[type="text"]{width:92px;height:26px;border-radius:7px;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--text,#c9d4e0);
  font:11.5px/1 inherit;padding:0 7px;outline:none}
.pipe-param-field input:focus{border-color:var(--acc,#6da8d2);box-shadow:0 0 0 2px rgba(var(--acc-rgb), .18)}
.pipe-param-field input[type="checkbox"]{accent-color:var(--acc,#6da8d2)}
`;
  document.head.appendChild(style);
}

export function openPipelinePanel(): void {
  ensureStyles();
  let unsubscribe: (() => void) | null = null;
  let timer: number | null = null;
  const mask = document.createElement('div');
  mask.className = 'pipe-mask';
  const shell = document.createElement('div');
  shell.className = 'pipe-shell';

  const head = document.createElement('div');
  head.className = 'pipe-head';
  const dot = document.createElement('span');
  dot.className = 'pipe-dot';
  const title = document.createElement('h3');
  title.textContent = '数据管线';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  head.append(dot, title, closeBtn);

  const body = document.createElement('div');
  body.className = 'pipe-body';
  const grid = document.createElement('div');
  grid.className = 'pipe-grid';
  const opSection = document.createElement('div');
  const sourceSection = document.createElement('div');
  const sinkSection = document.createElement('div');
  const errSection = document.createElement('div');
  body.append(grid, sourceSection, opSection, sinkSection, errSection);

  const foot = document.createElement('div');
  foot.className = 'pipe-foot';
  const hint = document.createElement('span');
  hint.textContent = 'Source → Operator → Sink · 每帧带时间戳 · 入口有界，满了丢最旧';
  const reset = document.createElement('button');
  reset.textContent = '重置计数';
  const done = document.createElement('button');
  done.textContent = '完成';
  foot.append(hint, reset, done);

  shell.append(head, body, foot);
  mask.appendChild(shell);
  document.body.appendChild(mask);

  let disposeOverlay: () => void = () => undefined;
  const close = () => {
    disposeOverlay();
    if (unsubscribe) unsubscribe();
    if (timer != null) window.clearInterval(timer);
    mask.remove();
  };
  disposeOverlay = pushOverlay({ id: 'pipeline', kind: 'modal', close });
  closeBtn.addEventListener('click', close);
  done.addEventListener('click', close);
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close();
  });

  const card = (label: string, value: string, tone?: 'ok' | 'warn' | 'error') => {
    const el = document.createElement('div');
    el.className = 'pipe-card';
    if (tone) el.dataset.tone = tone;
    const b = document.createElement('b');
    b.textContent = value;
    const small = document.createElement('small');
    small.textContent = label;
    el.append(b, small);
    return el;
  };

  const renderMetrics = (metrics: PipelineMetrics) => {
    dot.dataset.on = metrics.running ? '1' : '0';
    grid.replaceChildren(
      card('已处理帧', String(metrics.processed), 'ok'),
      card('积压队列', `${metrics.queued} / ${metrics.capacity}`, metrics.queued > metrics.capacity * 0.8 ? 'warn' : undefined),
      card('丢弃帧', String(metrics.dropped), metrics.dropped ? 'warn' : undefined),
      card('阶段错误', String(metrics.errors), metrics.errors ? 'error' : undefined),
      card('平均处理耗时', metrics.avgLatencyMs ? metrics.avgLatencyMs.toFixed(2) + ' ms' : '—'),
      card('峰值队列', String(metrics.peakQueue)),
      card('最后帧 t', metrics.lastT ? metrics.lastT.toFixed(2) + ' s' : '—'),
      card('最近一帧', metrics.lastFrameAt ? new Date(metrics.lastFrameAt).toLocaleTimeString() : '—')
    );
  };

  const renderSources = () => {
    sourceSection.replaceChildren();
    const head = document.createElement('div');
    head.className = 'pipe-sec';
    head.textContent = '数据源（点击启停）';
    sourceSection.appendChild(head);
    const list = document.createElement('div');
    list.className = 'pipe-list';
    const metrics = pipeline.metrics();
    if (!metrics.sources.length) {
      const empty = document.createElement('span');
      empty.className = 'pipe-empty';
      empty.textContent = '没有注册任何数据源';
      list.appendChild(empty);
    }
    for (const source of metrics.sources) {
      const chip = document.createElement('button');
      chip.className = 'pipe-chip';
      chip.dataset.on = source.running ? '1' : '0';
      const mark = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = source.label;
      chip.title = source.id;
      chip.append(mark, label);
      chip.addEventListener('click', () => {
        if (pipeline.isSourceRunning(source.id)) pipeline.stopSource(source.id);
        else pipeline.startSource(source.id);
        renderSources();
        renderMetrics(pipeline.metrics());
      });
      list.appendChild(chip);
    }
    sourceSection.appendChild(list);

    const tools = document.createElement('div');
    tools.className = 'pipe-list';
    tools.style.marginTop = '8px';
    const recording = pipeline.metrics().sinks.includes('builtin.record');
    const rec = document.createElement('button');
    rec.className = 'pipe-chip';
    rec.dataset.on = recording ? '1' : '0';
    rec.append(Object.assign(document.createElement('i'), {}), Object.assign(document.createElement('span'), { textContent: `内存录制 · ${recorder.size} 帧` }));
    rec.addEventListener('click', () => {
      pipeline.setSinkEnabled('builtin.record', !pipeline.metrics().sinks.includes('builtin.record'));
      renderSources();
    });

    const replayBtn = document.createElement('button');
    replayBtn.className = 'pipe-chip';
    replayBtn.append(Object.assign(document.createElement('i'), {}), Object.assign(document.createElement('span'), { textContent: '回放 ×4' }));
    replayBtn.addEventListener('click', () => {
      pipeline.stopSource('builtin.replay');
      pipeline.startSource('builtin.replay');
      renderSources();
    });

    const stopReplay = document.createElement('button');
    stopReplay.className = 'pipe-chip';
    stopReplay.dataset.on = '0';
    stopReplay.append(Object.assign(document.createElement('i'), {}), Object.assign(document.createElement('span'), { textContent: '停止回放' }));
    stopReplay.addEventListener('click', () => {
      pipeline.stopSource('builtin.replay');
      renderSources();
    });

    const clear = document.createElement('button');
    clear.className = 'pipe-chip';
    clear.dataset.on = '0';
    clear.append(Object.assign(document.createElement('i'), {}), Object.assign(document.createElement('span'), { textContent: '清空录制' }));
    clear.addEventListener('click', () => {
      recorder.clear();
      renderSources();
    });

    tools.append(rec, replayBtn, stopReplay, clear);
    sourceSection.appendChild(tools);
  };

  const renderStages = () => {
    opSection.replaceChildren();
    const opHead = document.createElement('div');
    opHead.className = 'pipe-sec';
    opHead.textContent = '处理阶段（点击启停）';
    opSection.appendChild(opHead);
    const opList = document.createElement('div');
    opList.className = 'pipe-list';
    const operators = pipeline.operatorList();
    if (!operators.length) {
      const empty = document.createElement('span');
      empty.className = 'pipe-empty';
      empty.textContent = '没有注册任何阶段';
      opList.appendChild(empty);
    }
    for (const operator of operators) {
      const on = pipeline.isOperatorEnabled(operator.id);
      const chip = document.createElement('button');
      chip.className = 'pipe-chip';
      chip.dataset.on = on ? '1' : '0';
      chip.textContent = '';
      const mark = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = operator.label;
      chip.title = operator.id;
      chip.append(mark, label);
      chip.addEventListener('click', () => {
        pipeline.setOperatorEnabled(operator.id, !on);
        renderStages();
      });
      opList.appendChild(chip);
    }
    opSection.appendChild(opList);

    // 参数编辑器：只给声明了 params 的阶段生成，改动即时生效并落盘
    const paramRows = document.createElement('div');
    paramRows.className = 'pipe-params';
    for (const operator of operators) {
      if (!operator.params || !operator.params.length) continue;
      const values = pipeline.operatorParamValues(operator.id);
      const row = document.createElement('div');
      row.className = 'pipe-param-row';
      const name = document.createElement('span');
      name.className = 'pipe-param-name';
      name.textContent = operator.label;
      row.appendChild(name);
      for (const spec of operator.params) {
        const fieldLabel = document.createElement('label');
        fieldLabel.className = 'pipe-param-field';
        const text = document.createElement('span');
        text.textContent = spec.label;
        const input = document.createElement('input');
        if (spec.type === 'boolean') {
          input.type = 'checkbox';
          input.checked = Boolean(values[spec.key] ?? spec.default);
          input.addEventListener('change', () => {
            pipeline.setOperatorParams(operator.id, { [spec.key]: input.checked });
            renderStages();
          });
        } else {
          input.type = spec.type === 'number' ? 'number' : 'text';
          if (spec.min != null) input.min = String(spec.min);
          if (spec.max != null) input.max = String(spec.max);
          if (spec.step != null) input.step = String(spec.step);
          input.value = values[spec.key] == null ? String(spec.default) : String(values[spec.key]);
          input.addEventListener('change', () => {
            const raw = spec.type === 'number' ? Number(input.value) : input.value;
            pipeline.setOperatorParams(operator.id, { [spec.key]: raw });
            renderStages();
          });
        }
        fieldLabel.append(text, input);
        row.appendChild(fieldLabel);
      }
      paramRows.appendChild(row);
    }
    if (paramRows.childElementCount) opSection.appendChild(paramRows);

    sinkSection.replaceChildren();
    const sinkHead = document.createElement('div');
    sinkHead.className = 'pipe-sec';
    sinkHead.textContent = '端点（点击启停）';
    sinkSection.appendChild(sinkHead);
    const sinkList = document.createElement('div');
    sinkList.className = 'pipe-list';
    const sinks = pipeline.sinkList();
    if (!sinks.length) {
      const empty = document.createElement('span');
      empty.className = 'pipe-empty';
      empty.textContent = '没有注册任何端点';
      sinkList.appendChild(empty);
    }
    for (const sink of sinks) {
      const chip = document.createElement('button');
      chip.className = 'pipe-chip';
      const mark = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = sink.label;
      chip.title = sink.id;
      chip.append(mark, label);
      chip.dataset.on = pipeline.metrics().sinks.includes(sink.id) ? '1' : '0';
      chip.addEventListener('click', () => {
        const enabled = chip.dataset.on === '1';
        pipeline.setSinkEnabled(sink.id, !enabled);
        chip.dataset.on = enabled ? '0' : '1';
      });
      sinkList.appendChild(chip);
    }
    sinkSection.appendChild(sinkList);

    errSection.replaceChildren();
    const errors = pipeline.recentErrorList();
    if (errors.length) {
      const errHead = document.createElement('div');
      errHead.className = 'pipe-sec';
      errHead.textContent = '最近错误';
      errSection.appendChild(errHead);
      for (const error of errors) {
        const line = document.createElement('div');
        line.className = 'pipe-err';
        line.textContent = `${new Date(error.at).toLocaleTimeString()} · ${error.id} · ${error.message}`;
        errSection.appendChild(line);
      }
    }
  };

  unsubscribe = pipeline.onMetricsChange(renderMetrics);
  timer = window.setInterval(() => {
    renderMetrics(pipeline.metrics());
  }, 500);
  renderMetrics(pipeline.metrics());
  renderSources();
  renderStages();

  reset.addEventListener('click', () => {
    pipeline.resetCounters();
    renderMetrics(pipeline.metrics());
  });
}
