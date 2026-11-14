(function () {
  'use strict';

  const VERSION = '20261115A';
  window.XHGCS_ASSET_VERSION = VERSION;
  const BASE = 'assets/js/';
  const GROUPS = {
    analysis: { files: ['analysis.js'] },
    graph: { deps: ['analysis'], files: ['graph-engine.js'] },
    tts: { files: ['tts.js'] },
    ttsWorker: { deps: ['tts'], files: ['tts-worker.js'] },
    aiSpec: { files: ['ai-spec.js'] },
    aiTools: { deps: ['aiSpec'], files: ['ai-tools.js'] },
    ai: { deps: ['analysis', 'graph', 'tts', 'ttsWorker', 'aiSpec', 'aiTools'], files: ['ai.js'] },
    aiUi: { deps: ['ai'], files: ['ai-ui.js'] },
    analysisUi: { deps: ['analysis', 'graph'], files: ['analysis-ui.js'] },
    graphUi: { deps: ['analysisUi', 'graph'], files: ['graph-ui.js'] },
    engineUi: { files: ['engine-ui.js'] },
    bridge: { deps: ['analysis'], files: ['bridge.js'] }
  };
  const loaded = Object.create(null);
  const pending = Object.create(null);
  const failed = Object.create(null);

  function loadFile(file) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = BASE + file + '?v=' + VERSION;
      script.async = false;
      script.onload = () => resolve(true);
      script.onerror = () => {
        console.warn('[XiHe_GCS] 模块加载失败：' + file);
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  // 加载失败必须在界面上说出来。原来失败路径一律 .catch(() => {})，用户看到的是
  // 「点了没反应」——比如 ai-ui.js 没加载上，AI 面板的输入框和发送键全都没有监听器。
  function reportLoadFailure(what) {
    const message = what + '所需模块加载失败，请刷新页面重试。若反复失败，检查 assets/js 下的文件是否齐全。';
    if (window.XHGCS_APP && window.XHGCS_APP.toast) window.XHGCS_APP.toast(message);
    else console.error('[XiHe_GCS] ' + message);
  }

  // 返回 true/false 表示这一组是否真的可用。失败不再永久缓存：原来无论成败都写
  // loaded[name] = true，一次瞬时 404 就让对应功能整场会话都起不来，重试也进不去。
  async function ensure(name) {
    if (loaded[name]) return true;
    if (pending[name]) return pending[name];
    const group = GROUPS[name];
    if (!group) return false;
    pending[name] = (async () => {
      const deps = group.deps || [];
      for (let i = 0; i < deps.length; i++) {
        if (!(await ensure(deps[i]))) return false;
      }
      const files = group.files || [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (loaded[file]) continue;
        if (!(await loadFile(file))) return false;
        loaded[file] = true;
      }
      loaded[name] = true;
      return true;
    })().then(
      (ok) => {
        delete pending[name];
        if (ok) delete failed[name];
        else failed[name] = true;
        return ok;
      },
      () => {
        delete pending[name];
        failed[name] = true;
        return false;
      }
    );
    return pending[name];
  }

  function afterFirstPaint(callback) {
    const run = () => {
      document.documentElement.classList.remove('boot-no-glass');
      callback();
    };
    requestAnimationFrame(() => setTimeout(run, 30));
  }

  function loadAfterPaint() {
    const state = window.XHGCS && window.XHGCS.state;
    const initial = [ensure('analysis'), ensure('tts')];
    if (state && state.mcp && state.mcp.enabled) initial.push(ensure('bridge'));
    // ensure 只有 resolve（true/false）。启动阶段这两组也得报：AI 面板的控件就在 index.html 里，
    // ai-ui.js 没加载上时表现是「点了没反应」，一句话都不说用户根本想不到要刷新页面。
    Promise.all(initial).then(() => Promise.all([ensure('aiUi'), ensure('graphUi')]).then((oks) => {
      if (!oks[0]) reportLoadFailure('AI 面板');
      if (!oks[1]) reportLoadFailure('数据分析画布');
    }));
  }

  function bindOnDemand() {
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target : null;
      if (!target) return;

      const analysisButton = target.closest('#btnOpenAnalysis');
      if (analysisButton) {
        if (window.XHGCS_ANALYSIS_UI) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        ensure('graphUi').then((ok) => {
          if (ok && window.XHGCS_ANALYSIS_UI && window.XHGCS_ANALYSIS_UI.open) window.XHGCS_ANALYSIS_UI.open();
          else if (!ok) reportLoadFailure('数据分析画布');
        });
        return;
      }

      if (target.closest('[data-nav="input"], [data-empty-action="protocol"], #btnToggleEngineAdvanced, #btnEngineApply, #btnEngineDelete, #btnAiGenerateEngine')) {
        ensure('engineUi').then((ok) => { if (!ok) reportLoadFailure('数据引擎'); });
      }

      if (target.closest('[data-action="settings"], #btnAiTasks')) {
        ensure('aiUi').then((ok) => {
          if (!ok) { reportLoadFailure('设置面板'); return; }
          if (window.XHGCS_APP && window.XHGCS_APP.renderTtsStatus) window.XHGCS_APP.renderTtsStatus();
          if (window.XHGCS_APP && window.XHGCS_APP.renderAiTaskList) window.XHGCS_APP.renderAiTaskList();
        });
      }

      if (target.closest('#btnSaveSettings')) {
        const enabled = document.getElementById('setMcpEnabled');
        if (enabled && enabled.value === '1') ensure('bridge').then((ok) => { if (ok) startBridgeIfNeeded(); });
      }
    }, true);

    document.addEventListener('change', (event) => {
      if (!event.target || event.target.id !== 'aiBridgeToggle') return;
      if (!event.target.checked) return;
      ensure('bridge').then((ok) => { if (ok) startBridgeIfNeeded(); });
    }, true);
  }

  function startBridgeIfNeeded() {
    if (!window.XHGCS_BRIDGE) return;
    const state = window.XHGCS && window.XHGCS.state;
    if (state && state.mcp) state.mcp.enabled = true;
    window.XHGCS_BRIDGE.start();
  }

  function boot() {
    bindOnDemand();
    afterFirstPaint(loadAfterPaint);
  }

  window.XHGCS_LOADER = { ensure: ensure, loaded: loaded, failed: failed, groups: GROUPS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
