(function () {
  'use strict';
  const X = window.XHGCS;
  const G = window.XHGCS_GRAPH;
  const A = window.XHGCS_ANALYSIS;
  const V = window.XHGCS_VIEWS;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const NODE_ICONS = { source: '◆', math: 'ƒ', filter: '≋', fft: '⇄', python: 'PY', component: '⚙', output: '▣' };
  const NODE_NAMES = { source: '输入通道', math: '函数计算', filter: '滤波', fft: 'FFT', python: 'Python', component: '可复用组件', output: '输出通道' };
  // 每条都带一句「它产出什么」。说明只放进 title，不铺成第二行：
  // 调色板竖着正好占满一屏（见 styles.css 里 .graph-palette 的注释），
  // 6 条各多一行就会把最后两行组件挤出可见区，重新踩回「按钮被切成半截」那个坑。
  const PALETTE = [
    ['数据源', [{ type: 'source', label: '输入通道', desc: '从一条原始/脚本通道取数据' }]],
    ['计算', [
      { type: 'math', label: '函数计算', desc: '均值 / 求和 / 变化率等' },
      { type: 'python', label: 'Python', desc: '自定义脚本，需要本地桥' }
    ]],
    ['信号处理', [
      { type: 'filter', label: '滤波器', desc: '移动平均 / 中值 / 低通等' },
      { type: 'fft', label: 'FFT 频谱', desc: '出主频 / 幅值 / 功率三路' }
    ]],
    ['输出', [{ type: 'output', label: '输出通道', desc: '变成「脚本数据」里的一条通道' }]]
  ];
  const MATH_OPS = [['mean', '平均'], ['sum', '求和'], ['min', '最小'], ['max', '最大'], ['rms', 'RMS'], ['std', '标准差'], ['last', '末值'], ['abs', '绝对值'], ['sqrt', '开方'], ['slope', '变化率'], ['lowpass', '移动平均'], ['add', '相加'], ['sub', '相减'], ['mul', '相乘'], ['div', '相除'], ['custom', '自定义表达式']];
  const FILTER_KINDS = [['movingAverage', '移动平均'], ['median', '中值滤波'], ['onePole', '一阶低通'], ['highpass', '高通'], ['derivative', '差分'], ['rms', '滑动 RMS']];
  const FFT_FUNCS = { source: 'src', math: 'math', filter: 'filter', fft: 'fft', python: 'python', component: 'component', output: 'output' };

  let selectedNodeId = '';
  let selectedEdgeId = '';
  // 没选中时把右侧配置栏收成窄栏；用户从窄栏点开后先展开着，等选中一次再交回自动收起。
  // 初值给 true：首屏（示例图没有任何选中）就收成 30px 竖缝的话，连面板里那句
  // 「选中节点或连线后在此配置。」也一起被隐藏，新用户根本看不出改参数的地方在哪。
  let inspForceOpen = true;
  let componentDraftId = '';
  let dragging = null;
  let connecting = null;
  let panning = null;
  let tempPath = null;
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = '';
  let persistTimer = 0;

  function canvasData() { return G.canvas(); }
  function persist() { X.persist(); }
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 240);
  }
  function toast(text) { if (window.XHGCS_APP) window.XHGCS_APP.toast(text); }
  function setStatus(text, kind) {
    const el = $('#graphStatus');
    el.textContent = text || '等待运行';
    el.className = 'graph-status' + (kind ? ' ' + kind : '');
  }
  function snapshotString() {
    return JSON.stringify({ nodes: canvasData().nodes, edges: canvasData().edges });
  }
  function markHistory() {
    if (!canvasData().nodes.length && !canvasData().edges.length) { syncToolbar(); return; }
    const now = snapshotString();
    if (!lastSnapshot) { lastSnapshot = now; return; }
    if (now === lastSnapshot) return;
    undoStack.push(lastSnapshot);
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    lastSnapshot = now;
    syncToolbar();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotString());
    const previous = undoStack.pop();
    const data = JSON.parse(previous);
    canvasData().nodes = data.nodes || [];
    canvasData().edges = data.edges || [];
    lastSnapshot = previous;
    G.ensureCanvas();
    persist();
    render();
    setStatus('已撤销');
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotString());
    const next = redoStack.pop();
    const data = JSON.parse(next);
    canvasData().nodes = data.nodes || [];
    canvasData().edges = data.edges || [];
    lastSnapshot = next;
    G.ensureCanvas();
    persist();
    render();
    setStatus('已重做');
  }

  function viewportSize() {
    const el = $('#graphViewport');
    return { w: el.clientWidth || 600, h: el.clientHeight || 400 };
  }
  // 节点尺寸用于摆放避让，和 .graph-node 的 CSS 宽度保持一致
  const NODE_BOX = { w: 190, h: 128 };
  function boxesOverlap(a, b) {
    return a.x < b.x + NODE_BOX.w && b.x < a.x + NODE_BOX.w && a.y < b.y + NODE_BOX.h && b.y < a.y + NODE_BOX.h;
  }
  // 从视口中心向外环形搜索空位，避免连续新增的节点叠在一起
  function freeSpotNear(origin) {
    const nodes = canvasData().nodes;
    if (!nodes.length) return origin;
    const stepX = 228, stepY = 148;
    for (let ring = 0; ring <= 12; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const cand = { x: origin.x + i * stepX, y: origin.y + j * stepY };
          if (!nodes.some((n) => boxesOverlap(cand, n))) return cand;
        }
      }
    }
    return { x: origin.x + nodes.length * 26, y: origin.y + nodes.length * 22 };
  }
  function nodePositionAtCenter() {
    const vp = $('#graphViewport');
    const point = screenToGraph(vp.getBoundingClientRect().left + vp.clientWidth / 2, vp.getBoundingClientRect().top + vp.clientHeight / 2);
    return freeSpotNear({ x: point.x - NODE_BOX.w / 2, y: point.y - NODE_BOX.h / 2 });
  }
  function screenToGraph(x, y) {
    const vp = $('#graphViewport');
    const rect = vp.getBoundingClientRect();
    const c = canvasData().viewport || {};
    const zoom = Number(c.zoom) || 1;
    const px = Number(c.x) || 0;
    const py = Number(c.y) || 0;
    return { x: (x - rect.left - px) / zoom, y: (y - rect.top - py) / zoom };
  }
  function applyViewport() {
    const c = canvasData().viewport || {};
    const zoom = Number(c.zoom) || 1;
    $('#graphContent').style.transform = 'translate(' + (Number(c.x) || 0) + 'px,' + (Number(c.y) || 0) + 'px) scale(' + zoom + ')';
    $('#graphZoomLabel').textContent = Math.round(zoom * 100) + '%';
  }
  function zoomBy(factor) {
    const c = canvasData();
    const vp = $('#graphViewport');
    const old = Number(c.viewport.zoom) || 1;
    const zoom = Math.max(.25, Math.min(2.5, old * factor));
    const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
    c.viewport.x = cx - (cx - (c.viewport.x || 0)) * zoom / old;
    c.viewport.y = cy - (cy - (c.viewport.y || 0)) * zoom / old;
    c.viewport.zoom = zoom;
    applyViewport();
    persist();
  }
  function fitView() {
    const nodes = canvasData().nodes;
    if (!nodes.length) { canvasData().viewport = { x: 70, y: 70, zoom: 1 }; applyViewport(); return; }
    const minX = Math.min.apply(null, nodes.map((n) => n.x)) - 40;
    const minY = Math.min.apply(null, nodes.map((n) => n.y)) - 40;
    const maxX = Math.max.apply(null, nodes.map((n) => n.x + 210)) + 40;
    const maxY = Math.max.apply(null, nodes.map((n) => n.y + 125)) + 40;
    const vp = viewportSize();
    const zoom = Math.max(.25, Math.min(1.25, Math.min(vp.w / (maxX - minX), vp.h / (maxY - minY))));
    canvasData().viewport = { x: (vp.w - (maxX - minX) * zoom) / 2 - minX * zoom, y: (vp.h - (maxY - minY) * zoom) / 2 - minY * zoom, zoom: zoom };
    applyViewport();
    persist();
    setStatus('已适应视图');
  }

  function nodeSummary(node) {
    const c = node.config || {};
    if (node.type === 'source') {
      const ch = X.findChannel(c.channelId);
      return '<b>' + X.esc(ch ? ch.name + ' · ' + ch.unit : c.channelId || '未选择') + '</b>输出实时通道数据';
    }
    if (node.type === 'math') return '<b>' + X.esc((MATH_OPS.find(([k]) => k === c.op) || ['', '计算'])[1]) + '</b>' + (c.op === 'custom' ? X.esc(c.formula || '') : '输入 ' + (c.inputCount || 1) + ' 路');
    if (node.type === 'filter') return '<b>' + X.esc((FILTER_KINDS.find(([k]) => k === c.kind) || ['', '滤波'])[1]) + '</b>窗口 ' + (c.windowSize || 10) + ' · ' + (c.sampleRate || 100) + ' Hz';
    if (node.type === 'fft') return '<b>FFT · ' + X.esc(c.windowType || 'hann') + '</b>窗口 ' + (c.windowSize || 128) + ' · 输出 ' + X.esc(c.output || 'freq');
    if (node.type === 'python') return '<b>Python 节点</b>' + (c.inputCount || 1) + ' 路输入 · 本地桥执行';
    if (node.type === 'component') {
      const def = G.componentDef(node);
      if (!def) return '<b class="missing">组件不存在</b>' + X.esc(c.componentId || '') + ' · 无法运行';
      return '<b>' + X.esc(def.kind === 'python' ? 'Python 组件' : '公式组件') + '</b>' + X.esc(def.description || '') + ' · ' + (def.inputs || []).length + ' 入 / ' + (def.outputs || []).length + ' 出';
    }
    if (node.type === 'output') {
      // 「自动附加」没说附加到哪去。这里直接说清它变成什么，顺带把 attach 开关的效果
      // 摆在卡片上 —— 取消勾选后节点照样参与计算但不建通道，原来界面上没有任何解释
      return '<b>' + X.esc(c.label || '分析输出') + '</b>' + X.esc(c.unit || '无单位')
        + (c.attach !== false ? ' · 写入「脚本数据」' : ' · 不写入通道（只参与计算）');
    }
    return '';
  }

  function makePort(node, port, kind) {
    const p = document.createElement('span');
    p.className = 'gn-port ' + kind;
    p.dataset.portKind = kind;
    p.dataset.nodeId = node.id;
    p.dataset.portId = port.id;
    p.title = (kind === 'in' ? '输入 · ' : '输出 · ') + (port.label || port.id);
    return p;
  }

  // 端口按行布局：输入在左、输出在右，节点高度随端口数量自然增长
  function buildPortRows(node) {
    const inputs = node.inputs || [];
    const outputs = node.outputs || [];
    const rows = Math.max(inputs.length, outputs.length);
    if (!rows) return null;
    const box = document.createElement('div');
    box.className = 'gn-ports';
    for (let i = 0; i < rows; i++) {
      const row = document.createElement('div');
      row.className = 'gn-row';
      if (inputs[i]) {
        row.appendChild(makePort(node, inputs[i], 'in'));
        const label = document.createElement('span');
        label.className = 'gn-row-label in';
        label.textContent = inputs[i].label || inputs[i].id;
        row.appendChild(label);
      }
      if (outputs[i]) {
        const label = document.createElement('span');
        label.className = 'gn-row-label out';
        label.textContent = outputs[i].label || outputs[i].id;
        row.appendChild(label);
        row.appendChild(makePort(node, outputs[i], 'out'));
      }
      box.appendChild(row);
    }
    return box;
  }

  function renderNode(node) {
    const el = document.createElement('div');
    el.className = 'graph-node' + (selectedNodeId === node.id ? ' selected' : '');
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    const icon = NODE_ICONS[node.type] || '?';
    el.innerHTML = '<div class="gn-head"><span class="gn-kind ' + (FFT_FUNCS[node.type] || '') + '">' + icon + '</span><span class="gn-title">' + X.esc(node.label || NODE_NAMES[node.type]) + '</span><button class="gn-del" title="删除节点" data-node-del="' + node.id + '">✕</button></div><div class="gn-body">' + nodeSummary(node) + '</div>';
    const rows = buildPortRows(node);
    if (rows) el.appendChild(rows);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.gn-port') || e.target.closest('.gn-del')) return;
      selectedNodeId = node.id;
      selectedEdgeId = '';
      $$('.graph-node').forEach((item) => item.classList.toggle('selected', item.dataset.nodeId === node.id));
      renderInspector();
    });
    const del = el.querySelector('.gn-del');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedNodeId = node.id;
      selectedEdgeId = '';
      deleteSelected();
    });
    return el;
  }
  function portPoint(node, handleId, kind) {
    if (!node) return { x: 0, y: 0 };
    const nodeEl = $('#graphNodes [data-node-id="' + node.id + '"]');
    if (nodeEl) {
      const portEl = nodeEl.querySelector('.gn-port[data-port-kind="' + kind + '"][data-port-id="' + handleId + '"]');
      if (portEl) {
        const nr = nodeEl.getBoundingClientRect();
        const pr = portEl.getBoundingClientRect();
        const zoom = (canvasData().viewport && canvasData().viewport.zoom) || 1;
        return {
          x: node.x + (pr.left + pr.width / 2 - nr.left) / zoom,
          y: node.y + (pr.top + pr.height / 2 - nr.top) / zoom
        };
      }
    }
    const index = (kind === 'out' ? node.outputs : node.inputs).findIndex((p) => p.id === handleId);
    return { x: node.x + (kind === 'out' ? 190 : 0), y: node.y + 62 + Math.max(0, index) * 20 };
  }
  function nearestPort(kind, x, y, maxDist) {
    let best = null;
    document.querySelectorAll('.gn-port.' + kind).forEach((port) => {
      const rect = port.getBoundingClientRect();
      const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      if (distance <= maxDist && (!best || distance < best.d)) best = { el: port, d: distance };
    });
    return best ? best.el : null;
  }
  function clearPortHot() {
    document.querySelectorAll('.gn-port.port-hot').forEach((port) => port.classList.remove('port-hot'));
  }
  function updatePortHot(x, y) {
    clearPortHot();
    const target = nearestPort('in', x, y, 28);
    if (target) target.classList.add('port-hot');
  }
  function bezierPath(a, b) {
    const dist = Math.abs(b.x - a.x);
    const back = b.x < a.x - 12;
    const dx = Math.max(42, Math.min(220, dist * (back ? .82 : .55)));
    const k = back ? 1.5 : 1;
    return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx * k) + ' ' + a.y + ', ' + (b.x - dx * k) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
  }

  function edgePath(edge) {
    const src = canvasData().nodes.find((n) => n.id === edge.source);
    const dst = canvasData().nodes.find((n) => n.id === edge.target);
    if (!src || !dst) return '';
    const a = portPoint(src, edge.sourceHandle, 'out');
    const b = portPoint(dst, edge.targetHandle, 'in');
    return bezierPath(a, b);
  }
  function edgeMidpoint(d) {
    const nums = String(d || '').match(/-?\d+(?:\.\d+)?/g) || [];
    const [ax, ay, c1x, c1y, c2x, c2y, bx, by] = nums.map(Number);
    if ([ax, ay, c1x, c1y, c2x, c2y, bx, by].every(Number.isFinite)) {
      const t = .5, u = 1 - t;
      return {
        x: u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx,
        y: u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by
      };
    }
    return { x: (ax + bx) / 2 || 0, y: (ay + by) / 2 || 0 };
  }
  function renderEdges() {
    const svg = $('#graphEdges');
    svg.innerHTML = '';
    canvasData().edges.forEach((edge) => {
      const d = edgePath(edge);
      if (!d) return;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'gn-edge-group' + (selectedEdgeId === edge.id ? ' selected' : ''));
      group.dataset.edgeId = edge.id;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('class', 'gn-edge-hit');
      hit.setAttribute('d', d);
      hit.dataset.edgeId = edge.id;
      const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      visible.setAttribute('class', 'gn-edge-visible');
      visible.setAttribute('d', d);
      visible.dataset.edgeId = edge.id;
      group.appendChild(hit);
      group.appendChild(visible);
      if (selectedEdgeId === edge.id) {
        const mid = edgeMidpoint(d);
        const del = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        del.setAttribute('class', 'gn-edge-delete');
        del.setAttribute('cx', mid.x);
        del.setAttribute('cy', mid.y);
        del.setAttribute('r', 10);
        del.dataset.edgeId = edge.id;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('class', 'gn-edge-delete-label');
        label.setAttribute('x', mid.x);
        label.setAttribute('y', mid.y + 4);
        label.textContent = '×';
        group.appendChild(del);
        group.appendChild(label);
      }
      svg.appendChild(group);
    });
    if (connecting && tempPath) {
      const node = canvasData().nodes.find((n) => n.id === connecting.sourceId);
      if (node) {
        const a = portPoint(node, connecting.sourceHandle, 'out');
        const b = screenToGraph(connecting.x, connecting.y);
        tempPath.setAttribute('d', bezierPath(a, b));
      } else {
        tempPath.removeAttribute('d');
      }
    }
  }
  function renderNodes() {
    const box = $('#graphNodes');
    box.innerHTML = '';
    canvasData().nodes.forEach((node) => box.appendChild(renderNode(node)));
    $('#graphEmpty').classList.toggle('hidden', canvasData().nodes.length > 0);
  }
  function refreshNodeCard(node) {
    const el = $('#graphNodes [data-node-id="' + node.id + '"]');
    if (!el) return;
    el.querySelector('.gn-title').textContent = node.label || NODE_NAMES[node.type];
    el.querySelector('.gn-body').innerHTML = nodeSummary(node);
  }
  function field(labelText, control) {
    return '<div class="field"><span>' + X.esc(labelText) + '</span>' + control + '</div>';
  }
  function fieldGrid(controls) {
    return '<div class="field-grid">' + controls + '</div>';
  }
  function section(titleText, content) {
    return '<section class="insp-section"><div class="insp-section-title">' + X.esc(titleText) + '</div>' + content + '</section>';
  }
  function optionHtml(items, current) {
    return items.map((item) => {
      const id = Array.isArray(item) ? item[0] : item;
      const name = Array.isArray(item) ? item[1] : item;
      return '<option value="' + X.esc(id) + '"' + (String(id) === String(current) ? ' selected' : '') + '>' + X.esc(name) + '</option>';
    }).join('');
  }
  function codeCard(titleText, fieldName, code) {
    return '<div class="insp-code"><div class="insp-code-head"><span class="dots"><i></i><i></i><i></i></span><span>' + X.esc(titleText) + '</span></div><textarea data-field="' + fieldName + '" spellcheck="false">' + code + '</textarea></div>';
  }
  // 摘要卡：节点名 + 「类型 · N 入 / M 出」。标题取的是节点名，而新节点的默认名恰好等于类型名
  // （输入通道 / 分析输出），这时再前缀一遍类型就读成「输入通道 · 输入通道 · 0 入 / 1 出」，
  // 只有改过名才补类型。抽成函数是为了改名时能只换这张卡 —— 整块 renderInspector()
  // 会重建名称输入框，光标会被顶掉
  function nodeSummaryCard(node) {
    const c = node.config || {};
    const value = (v) => X.esc(v == null ? '' : String(v));
    const inCount = (node.inputs || []).length;
    const outCount = (node.outputs || []).length;
    const label = node.type === 'output' ? (c.label || '分析输出') : node.label;
    const typeName = NODE_NAMES[node.type];
    const meta = (String(label || '') !== typeName ? value(typeName) + ' · ' : '') + inCount + ' 入 / ' + outCount + ' 出';
    return '<div class="insp-summary"><span class="insp-kind ' + (FFT_FUNCS[node.type] || '') + '">' + (NODE_ICONS[node.type] || '·') + '</span><div class="insp-summary-title"><b>' + value(label) + '</b><small>' + meta + '</small></div><div class="insp-stat"><b>配置</b><span>实时编辑</span></div></div>';
  }
  function refreshInspectorSummary(node) {
    const body = $('#graphInspectorBody');
    const card = body && node ? body.querySelector('.insp-summary') : null;
    if (!card) return;
    card.outerHTML = nodeSummaryCard(node);
  }
  // 收起态只改栅格列宽 + 显示那条窄栏：面板本身不销毁，展开时不用重建 DOM
  function syncInspectorCollapse(collapsed) {
    const insp = $('#graphInspector');
    const work = document.querySelector('.analysis-graph-workspace');
    if (insp) insp.classList.toggle('collapsed', collapsed);
    if (work) work.classList.toggle('insp-collapsed', collapsed);
  }

  function renderInspector() {
    // 放在最前面：下面「没选中」「选中连线」两个分支都会提前 return，末尾那句会被跳过
    syncToolbar();
    const body = $('#graphInspectorBody');
    const node = canvasData().nodes.find((n) => n.id === selectedNodeId);
    const edge = selectedEdgeId ? canvasData().edges.find((e) => e.id === selectedEdgeId) : null;
    // 空着的 308px 配置栏等于把画布白送出去四分之一：没选中就收成一条窄栏，
    // 只留「节点配置」竖排按钮，点它可展开看那句提示
    if (node || edge) inspForceOpen = false;
    syncInspectorCollapse(!(node || edge) && !inspForceOpen);
    if (edge && !node) {
      const src = canvasData().nodes.find((n) => n.id === edge.source);
      const dst = canvasData().nodes.find((n) => n.id === edge.target);
      const srcPort = src && (src.outputs || []).find((p) => p.id === edge.sourceHandle);
      const dstPort = dst && (dst.inputs || []).find((p) => p.id === edge.targetHandle);
      body.innerHTML = '<div class="insp-summary"><span class="insp-kind edge">↗</span><div class="insp-summary-title"><b>连线</b><small>数据流向</small></div><div class="insp-stat"><b>已选中</b><span>可删除</span></div></div>' +
        section('连线信息', '<div class="edge-inspector-flow">' +
          '<div><b>' + X.esc(src ? src.label || NODE_NAMES[src.type] : '?') + '</b><small>' + X.esc(srcPort ? srcPort.label : edge.sourceHandle) + '</small></div>' +
          '<span>→</span>' +
          '<div><b>' + X.esc(dst ? dst.label || NODE_NAMES[dst.type] : '?') + '</b><small>' + X.esc(dstPort ? dstPort.label : edge.targetHandle) + '</small></div>' +
          '</div>') +
        '<button class="btn danger insp-delete" id="btnInspectorDelete">删除连线</button>' +
        '<div class="mini-hint">也可点击连线中点 ×、右键连线或按 Delete / Backspace 删除。</div>';
      return;
    }
    if (!node) {
      // 拖动/连线那两句操作提示归画布中央的空状态（鼠标就在那儿），这里只说这块面板自己的用途
      body.innerHTML = '<div class="empty">未选中</div>';
      return;
    }
    const c = node.config || {};
    const value = (v) => X.esc(v == null ? '' : String(v));
    let html = nodeSummaryCard(node);
    if (node.type !== 'output') {
      html += section('基础', field('名称', '<input data-field="label" value="' + value(node.label) + '" />'));
    }
    if (node.type === 'source') {
      html += section('信号配置', field('输入通道', '<select data-field="channelId">' + X.allChannels().map((ch) => '<option value="' + X.esc(ch.id) + '"' + (ch.id === c.channelId ? ' selected' : '') + '>' + X.esc(ch.name) + ' (' + X.esc(ch.unit) + ')</option>').join('') + '</select>'));
    } else if (node.type === 'math') {
      html += section('计算规则', field('函数', '<select data-field="op">' + optionHtml(MATH_OPS, c.op) + '</select>') + fieldGrid(field('输入路数', '<input type="number" min="1" max="6" data-field="inputCount" value="' + (c.inputCount || 1) + '" />') + field('窗口', '<input type="number" min="1" data-field="windowSize" value="' + (c.windowSize || 10) + '" />')));
      html += section('表达式', codeCard('自定义表达式', 'formula', value(c.formula || 'mean(x1,x2)')));
      html += '<div class="mini-hint">变量使用 x1、x2、x3；可用 mean(x1,x2)、rms(x1)、slope(x1,5) 等。</div>';
    } else if (node.type === 'filter') {
      html += section('滤波配置', field('类型', '<select data-field="kind">' + optionHtml(FILTER_KINDS, c.kind) + '</select>') + fieldGrid(field('窗口', '<input type="number" min="1" max="512" data-field="windowSize" value="' + (c.windowSize || 10) + '" />') + field('采样率', '<input type="number" min="1" data-field="sampleRate" value="' + (c.sampleRate || 100) + '" />')));
    } else if (node.type === 'fft') {
      html += section('频谱配置', fieldGrid(field('窗口大小', '<select data-field="windowSize">' + optionHtml([64, 128, 256, 512, 1024], c.windowSize) + '</select>') + field('窗函数', '<select data-field="windowType">' + optionHtml([['hann', 'Hann'], ['hamming', 'Hamming'], ['blackman', 'Blackman'], ['rect', '矩形']], c.windowType) + '</select>')) + fieldGrid(field('输出', '<select data-field="output">' + optionHtml([['freq', '主频'], ['magnitude', '幅值'], ['power', '功率'], ['db', 'dB']], c.output) + '</select>') + field('采样率', '<input type="number" min="1" data-field="sampleRate" value="' + (c.sampleRate || 100) + '" />')));
      html += '<div class="mini-hint">FFT 节点会同时输出 freq、magnitude、power 三个端口。</div>';
    } else if (node.type === 'python') {
      html += section('信号输入', field('输入路数', '<input type="number" min="1" max="6" data-field="inputCount" value="' + (c.inputCount || 1) + '" />'));
      html += section('Python 脚本', codeCard('Python 代码', 'code', value(c.code || 'def analyze(ctx):\n    return {"out": mean(ctx.get("x1", []))}')));
      html += '<div class="mini-hint">ctx 中提供 x1、x2、x3 序列；需要启动 MCP 桥。</div>';
    } else if (node.type === 'component') {
      const def = G.componentDef(node);
      if (!def) {
        html += '<div class="empty">组件不存在：' + value(c.componentId || node.label) + '<br /><br />请先在组件库中重新创建同名组件。</div>';
      } else {
        html += section('组件信息', '<div class="mini-hint">' + value(def.description || '可复用计算组件') + '</div>' + field('类型', '<input value="' + value(def.kind === 'python' ? 'Python（使用 MCP 桥）' : '公式 / 函数嵌套') + '" disabled />') + fieldGrid(field('输入端口', '<input value="' + value((def.inputs || []).map((p) => p.label).join(', ')) + '" disabled />') + field('输出端口', '<input value="' + value((def.outputs || []).map((p) => p.label).join(', ')) + '" disabled />')));
        const params = (def.parameters || []).map((item) => field(item.label, '<input type="' + (item.type === 'number' ? 'number' : 'text') + '" step="any" data-field="param_' + X.esc(item.id) + '" value="' + value((c.parameters && c.parameters[item.id] != null ? c.parameters[item.id] : item.default)) + '" />')).join('');
        if (params) html += section('组件参数', params);
      }
    } else if (node.type === 'output') {
      html += section('输出映射', fieldGrid(field('输出标签', '<input data-field="outLabel" value="' + value(c.label || '分析输出') + '" />') + field('单位', '<input data-field="unit" value="' + value(c.unit) + '" />')) + field('曲线颜色', '<input type="color" data-field="color" value="' + value(c.color || '#34d399') + '" />') + fieldGrid(field('最小值', '<input type="number" data-field="range0" value="' + (Number(c.range && c.range[0]) || 0) + '" />') + field('最大值', '<input type="number" data-field="range1" value="' + (Number(c.range && c.range[1]) || 100) + '" />')) + '<label class="chk"><input type="checkbox" data-field="attach" ' + (c.attach !== false ? 'checked' : '') + ' />写入脚本数据通道</label>');
    }
    html += '<button class="btn danger insp-delete" id="btnInspectorDelete">删除节点</button>';
    body.innerHTML = html;
  }

  // 工具条按钮的可执行性：不能执行就直接 disabled + 写明原因，别让用户按下去只换回一句提示。
  // 结果做了记忆化，renderInspector / markHistory 里可以随手调。
  let toolbarSig = '';
  function syncToolbar() {
    const nodes = canvasData().nodes;
    const edges = canvasData().edges;
    const hasGraph = nodes.length > 0 || edges.length > 0;
    const hasSelection = !!(selectedNodeId || selectedEdgeId);
    const canUndo = undoStack.length > 0;
    const canRedo = redoStack.length > 0;
    const sig = [hasGraph, hasSelection, canUndo, canRedo].join('|');
    if (sig === toolbarSig) return;
    toolbarSig = sig;
    const set = (selector, enabled, title) => {
      const btn = $(selector);
      if (!btn) return;
      btn.disabled = !enabled;
      btn.title = title;
    };
    const empty = '画布为空：先从左侧添加节点';
    set('#btnGraphRun', hasGraph, hasGraph ? '执行一次画布；输出节点会变成「脚本数据」里的一条通道' : empty);
    set('#btnGraphUndo', canUndo, canUndo ? 'Ctrl+Z' : '没有可撤销的操作');
    set('#btnGraphRedo', canRedo, canRedo ? 'Ctrl+Y' : '没有可重做的操作');
    set('#btnGraphDelete', hasSelection, hasSelection ? '删除选中的节点或连线' : '先选中节点或连线');
    set('#btnGraphClear', hasGraph, hasGraph ? '清空节点画布' : '画布已经是空的');
  }
  function render() {
    G.ensureCanvas();
    renderNodes();
    renderEdges();
    renderInspector();
    applyViewport();
  }
  function setModeUI(next) {
    // 脚本库开合由「屏幕可见模式」的唯一控制方决定（graph=展开，quick=收起）；
    // 避免 analysis-ui onShow 按 state.analysis.mode 再压一次造成两处打架
    if (window.XHGCS_ANALYSIS_UI && typeof window.XHGCS_ANALYSIS_UI.setShelfExpanded === 'function') {
      window.XHGCS_ANALYSIS_UI.setShelfExpanded(next !== 'quick');
    }
    $('#analysisGraphView').classList.toggle('hidden', next !== 'graph');
    $('#analysisQuickView').classList.toggle('hidden', next !== 'quick');
    $('#btnGraphMode').classList.toggle('active', next === 'graph');
    $('#btnQuickMode').classList.toggle('active', next === 'quick');
    // 节点画布模式下页脚的「运行分析 / 运行并添加到脚本数据」和画布工具条的「运行」是同一动作，只留工具条那一份
    const hideFooterRun = next === 'graph';
    ['#btnAnalysisRun', '#btnAnalysisAttach'].forEach((sel) => { const btn = $(sel); if (btn) btn.classList.toggle('hidden', hideFooterRun); });
    // 画布模式下页脚两个按钮都藏起来了，整条页脚也一起收掉，不留一条 24px 的空框
    if ($('#analysisFoot')) $('#analysisFoot').classList.toggle('hidden', hideFooterRun);
    // 「保存当前为模块」存的东西随模式变：画布模式存画布、快速模式存算式。
    // 文案写死一个的话，用户在画布模式下会以为自己在存公式（反之亦然）
    const saveBtn = $('#btnAnalysisSaveScript');
    if (saveBtn) {
      const graphMode = next === 'graph';
      saveBtn.textContent = graphMode ? '保存画布为模块' : '保存算式为模块';
      saveBtn.title = graphMode
        ? '把当前这张画布存成脚本库里的一张卡，之后点那张卡就能切回来'
        : '把当前的算式存成脚本库里的一条算式';
    }
    if (next === 'quick' && window.XHGCS_ANALYSIS_UI) {
      window.XHGCS_ANALYSIS_UI.renderInputs();
      window.XHGCS_ANALYSIS_UI.renderOutputs();
    }
    requestAnimationFrame(() => { if (next === 'graph') applyViewport(); else window.dispatchEvent(new Event('resize')); });
  }

  function addNode(type) {
    markHistory();
    const node = G.makeNode(type, nodePositionAtCenter());
    canvasData().nodes.push(node);
    selectedNodeId = node.id;
    selectedEdgeId = '';
    persist();
    render();
    setStatus('已添加 ' + NODE_NAMES[type]);
  }

  function addComponentNode(componentId) {
    const def = X.getComponent(componentId);
    if (!def) { toast('组件不存在：' + componentId); return; }
    markHistory();
    const node = G.makeNode('component', nodePositionAtCenter(), { componentId: componentId });
    node.label = def.name;
    node.config.name = def.name;
    canvasData().nodes.push(node);
    selectedNodeId = node.id;
    selectedEdgeId = '';
    persist();
    render();
    setStatus('已添加组件 ' + def.name);
  }
  function deleteSelected() {
    if (!selectedNodeId && !selectedEdgeId) { toast('请先选择节点或连线'); return; }
    markHistory();
    if (selectedNodeId) {
      canvasData().nodes = canvasData().nodes.filter((n) => n.id !== selectedNodeId);
      canvasData().edges = canvasData().edges.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId);
      toast('节点已删除');
    }
    if (selectedEdgeId) {
      canvasData().edges = canvasData().edges.filter((e) => e.id !== selectedEdgeId);
      toast('连线已删除');
    }
    selectedNodeId = selectedEdgeId = '';
    persist();
    render();
  }
  function clearGraph() {
    if (!canvasData().nodes.length) return;
    if (!confirm('确定清空节点画布？')) return;
    markHistory();
    canvasData().nodes = [];
    canvasData().edges = [];
    canvasData().autoRun = false;
    // 清空之后画布不再对应任何一个模块，脚本库里的「当前画布」标记也要摘掉
    X.state.analysis.canvasScriptId = '';
    $('#btnGraphAutoRun').checked = false;
    selectedNodeId = selectedEdgeId = '';
    persist();
    render();
    toast('画布已清空');
  }

  async function runGraph() {
    try {
      setStatus('计算中…');
      const result = await G.runGraph(canvasData(), { scriptId: 'graph-live', attach: true, persist: true });
      const outputs = G.outputConfigs().length;
      setStatus('运行完成 · ' + result.nodes + ' 节点 / ' + result.edges + ' 连线 → ' + outputs + ' 输出'
        + (result.notes && result.notes.length ? ' · ' + result.notes.join('；') : ''), 'ok');
      // 原来点完「运行」屏幕上只有一行 10px 小字变了，结果其实写进了另一个页面的
      // 「脚本数据」页签，而这一页从头到尾没说这件事 —— 说清楚它去哪了
      if (outputs) toast('结果已写入「可视化 → 多通道数据 → 脚本数据」的 ' + outputs + ' 条通道');
      if (window.XHGCS_ANALYSIS_UI) window.XHGCS_ANALYSIS_UI.renderScripts();
      V.renderGaugeCards();
      V.renderThresholdRows();
      V.switchChannelTab('script');
      return result;
    } catch (err) {
      setStatus(String(err.message || err), 'error');
      throw err;
    }
  }
  // 「运行并附加」原来和「运行」在实现上完全一样（都是 attach:true），只多一句 toast。
  // 两个同义的按钮并排摆着只会让人犹豫该点哪个，所以工具栏只留一个主按钮；
  // 这个函数名留着给快速公式模式页脚的那条路径用（analysis-ui.js）。
  function attachGraph() { return runGraph(); }
  async function runSavedGraph(script) {
    try {
      setStatus('计算中…');
      await G.runGraphScript(script, { persist: true });
      setStatus('模块运行完成 · ' + (script.outputs || []).length + ' 个输出', 'ok');
      V.renderGaugeCards();
      V.renderThresholdRows();
      V.switchChannelTab('script');
      return { ok: true };
    } catch (err) {
      setStatus(String(err.message || err), 'error');
      throw err;
    }
  }
  async function saveGraph() {
    const script = G.toScript('节点画布·' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    A.saveScript(script);
    A.ensureOutputs(script);
    await G.runGraphScript(script, { persist: true });
    // 存下来的这张就是当前画布本身，脚本库据此标「当前画布」
    state.analysis.canvasScriptId = script.id;
    X.persist();
    window.dispatchEvent(new Event('xhgcs:scripts-changed'));
    if (window.XHGCS_ANALYSIS_UI) window.XHGCS_ANALYSIS_UI.renderScripts();
    toast('已存成「' + script.name + '」：脚本库里点那张卡就能切回这张画布');
    return script;
  }

  function componentById(id) {
    return (X.state.components || []).find((item) => item.id === id) || null;
  }
  function componentRefCount(id) {
    return (canvasData().nodes || []).filter((node) => node.type === 'component' && node.config && node.config.componentId === id).length;
  }
  function parseComponentArray(id, fallback, label) {
    const raw = document.getElementById(id) ? document.getElementById(id).value : '';
    if (!raw.trim()) return fallback;
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error(label + ' 必须是数组');
      return value;
    } catch (err) {
      throw new Error(label + ' JSON 格式错误：' + (err && err.message || err));
    }
  }
  function collectComponentForm() {
    const name = document.getElementById('componentName').value.trim() || '自定义组件';
    const kind = document.getElementById('componentKind').value === 'python' ? 'python' : 'formula';
    const inputs = parseComponentArray('componentInputs', [{ id: 'x1', label: '输入 1' }], '输入端口');
    const outputs = parseComponentArray('componentOutputs', [{ id: 'out1', label: '输出', unit: '', color: '#38bdf8', range: [0, 100] }], '输出端口');
    const parameters = parseComponentArray('componentParameters', [], '参数');
    const formula = document.getElementById('componentFormula') ? document.getElementById('componentFormula').value : '';
    const code = document.getElementById('componentCode') ? document.getElementById('componentCode').value : '';
    return {
      name: name.slice(0, 48),
      description: (document.getElementById('componentDescription').value || '').slice(0, 200),
      kind: kind,
      inputs: inputs,
      outputs: outputs,
      parameters: parameters,
      config: kind === 'python' ? { code: code } : { formula: formula }
    };
  }
  function componentEditorHtml(component) {
    const value = (v) => X.esc(v == null ? '' : String(v));
    const kind = component ? component.kind : 'formula';
    // 内置组件是随软件发布的模板：字段留 readonly（仍可选中、可复制代码），但不提供保存/删除。
    // 原来保存按钮是能用的，等于编辑一次就把默认模板永久改掉，而且没有恢复入口；
    // 删除又是灰的，界面上没有一句话解释。只读 + 一个「复制为新组件」出口最省事。
    const builtin = Boolean(component && component.builtin);
    const ro = builtin ? ' readonly' : '';
    const roSel = builtin ? ' disabled' : '';
    const formula = component && component.config && component.config.formula || 'mean(x1)';
    const code = component && component.config && component.config.code || 'def analyze(ctx):\n    x1 = ctx.get("x1", [])\n    return {"out1": mean(x1)}';
    return '<div class="component-editor-head"><b>' + (builtin ? '内置组件' : component ? '编辑组件' : '新建组件') + '</b><span>' + (builtin ? '随软件内置，只读 · 点「复制为新组件」后可改' : component ? '自定义 / AI 组件' : '定义一个可拖入画布的数据组件') + '</span></div>' +
      '<div class="component-editor-body" data-readonly="' + (builtin ? '1' : '0') + '" data-kind="' + kind + '">' +
      '<div class="component-editor-grid">' +
      '<label>组件名称<input id="componentName" value="' + value(component && component.name || '') + '" maxlength="48" placeholder="例如：双通道均值"' + ro + ' /></label>' +
      '<label>类型<select id="componentKind"' + roSel + '><option value="formula"' + (kind === 'formula' ? ' selected' : '') + '>公式 / 函数嵌套</option><option value="python"' + (kind === 'python' ? ' selected' : '') + '>Python 脚本</option></select></label>' +
      '</div>' +
      '<label class="span2">说明<textarea id="componentDescription" maxlength="200" placeholder="组件用途、公式含义或算法说明"' + ro + '>' + value(component && component.description || '') + '</textarea></label>' +
      '<label>输入端口 JSON<textarea id="componentInputs" spellcheck="false"' + ro + '>' + value(JSON.stringify((component && component.inputs || [{ id: 'x1', label: '输入 1' }]), null, 2)) + '</textarea></label>' +
      '<label>输出端口 JSON<textarea id="componentOutputs" spellcheck="false"' + ro + '>' + value(JSON.stringify((component && component.outputs || [{ id: 'out1', label: '输出', unit: '', color: '#38bdf8', range: [0, 100] }]), null, 2)) + '</textarea></label>' +
      '<label class="span2">参数 JSON<textarea id="componentParameters" spellcheck="false"' + ro + '>' + value(JSON.stringify((component && component.parameters || []), null, 2)) + '</textarea></label>' +
      '<div class="component-editor-formula">' +
      '<label>表达式（可用 x1/x2/x3、v1/v2/v3、p_参数名）<textarea id="componentFormula" spellcheck="false"' + ro + '>' + value(formula) + '</textarea></label>' +
      '<div class="mini-hint">示例：mean(x1,x2)、rms(x1)、slope(x1, p_window)；输出端口使用 out1/out2 与表达式一一对应。</div>' +
      '</div>' +
      '<div class="component-editor-code">' +
      '<label>Python 代码<textarea id="componentCode" spellcheck="false"' + ro + '>' + value(code) + '</textarea></label>' +
      '<div class="mini-hint">ctx 中提供 x1/x2 序列与 parameters 参数；返回 {"out1": value}。</div>' +
      '</div>' +
      '</div>' +
      '<div class="component-editor-actions">' +
      '<button class="btn" data-component-action="cancel">取消</button>' +
      (builtin
        ? '<button class="btn primary" data-component-action="copy">复制为新组件</button>'
        : '<button class="btn" data-component-action="copy">复制</button>' +
          '<button class="btn danger" data-component-action="delete">删除</button>' +
          '<button class="btn primary" data-component-action="save">保存组件</button>') +
      '</div>';
  }
  function renderComponentList() {
    const box = $('#componentManagerList');
    box.innerHTML = '<button class="component-list-new" data-component-action="new">＋ 新建组件</button>' +
      (X.state.components || []).map((item) => '<button class="component-list-item' + (item.id === componentDraftId ? ' active' : '') + '" data-component-id="' + X.esc(item.id) + '"><b>' + X.esc(item.name) + '</b><span>' + (item.kind === 'python' ? 'PY' : 'ƒ') + ' · ' + (item.inputs || []).length + ' 入 / ' + (item.outputs || []).length + ' 出</span>' + (item.builtin ? '<small>内置</small>' : '<small>可修改</small>') + '</button>').join('');
  }
  function renderComponentEditor(id) {
    componentDraftId = id || '';
    const component = id ? componentById(id) : null;
    $('#componentManagerEditor').innerHTML = componentEditorHtml(component);
  }
  function renderComponentManager() {
    renderComponentList();
    renderComponentEditor(componentDraftId);
  }
  function openComponentManager(id) {
    componentDraftId = id || '';
    renderComponentManager();
    const manager = $('#componentManager');
    if (manager) manager.classList.remove('hidden');
  }
  function closeComponentManager() {
    const manager = $('#componentManager');
    if (manager) manager.classList.add('hidden');
  }
  function downloadComponent(component) {
    if (!component) return;
    const blob = new Blob([JSON.stringify(component, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = component.id + '.component.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function handleComponentAction(action) {
    if (action === 'new') { renderComponentList(); renderComponentEditor(''); return; }
    if (action === 'cancel') { closeComponentManager(); return; }
    if (action === 'save') {
      try {
        const data = collectComponentForm();
        let saved;
        if (componentDraftId) saved = X.updateComponent(componentDraftId, data);
        else saved = X.addComponent(Object.assign({}, data, { origin: 'user' }));
        if (!saved) throw new Error(componentDraftId ? '组件不存在，或内置组件只读（请先「复制为新组件」）' : '组件保存失败');
        componentDraftId = saved.id;
        renderComponentManager();
        bindPalette();
        toast('组件「' + saved.name + '」已保存');
      } catch (err) { toast(String(err && err.message || err)); }
      return;
    }
    if (action === 'copy') {
      const source = componentById(componentDraftId);
      if (!source) return;
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = '';
      copy.name = (source.name || '组件') + ' 副本';
      copy.origin = 'user';
      copy.builtin = false;
      const saved = X.addComponent(copy);
      componentDraftId = saved.id;
      renderComponentManager();
      bindPalette();
      toast('已复制组件');
      return;
    }
    if (action === 'delete') {
      const source = componentById(componentDraftId);
      if (!source || source.builtin) return;
      const refs = componentRefCount(source.id);
      const message = refs ? '组件「' + source.name + '」正在被 ' + refs + ' 个画布节点引用。删除组件不会删除画布节点，但缺失组件将无法运行。确定删除？' : '确定删除组件「' + source.name + '」？';
      if (!confirm(message)) return;
      if (X.removeComponent(source.id)) {
        componentDraftId = '';
        renderComponentManager();
        bindPalette();
        render();
        toast('组件已删除，画布节点保留');
      }
      return;
    }
    if (action === 'export') downloadComponent(componentById(componentDraftId));
  }
  async function importComponentFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const list = Array.isArray(raw) ? raw : [raw];
      let count = 0;
      list.forEach((item) => {
        if (!item || !item.name) return;
        const component = Object.assign({}, item, { id: '', origin: 'user', builtin: false });
        X.addComponent(component);
        count++;
      });
      renderComponentManager();
      bindPalette();
      toast('已导入 ' + count + ' 个组件');
    } catch (err) {
      toast('导入失败：' + (err && err.message || err));
    }
  }
  function bindComponentManager() {
    const manager = $('#componentManager');
    manager.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-component-action]');
      if (actionEl) { handleComponentAction(actionEl.dataset.componentAction); return; }
      const item = e.target.closest('[data-component-id]');
      if (item) { renderComponentList(); renderComponentEditor(item.dataset.componentId); }
    });
    manager.addEventListener('change', (e) => {
      if (e.target.id === 'componentKind') {
        const editor = $('#componentManagerEditor');
        if (editor && editor.querySelector('.component-editor-body')) editor.querySelector('.component-editor-body').dataset.kind = e.target.value;
      }
      if (e.target.id === 'componentImportFile') {
        importComponentFile(e.target.files && e.target.files[0]);
        e.target.value = '';
      }
    });
  }
  function loadScript(script) {
    if (!script) return false;
    if (script.type === 'graph' && script.graph) {
      markHistory();
      setCanvasFromGraph(script.graph);
      // 记下画布上现在载的是哪个模块：脚本库靠它标「当前画布」，不然「切换」没有锚点
      X.state.analysis.canvasScriptId = script.id;
      X.persist();
      setModeUI('graph');
      // 切画布是高频动作，不拦；但要说清未保存的改动去哪了
      toast('已切到「' + script.name + '」；画布上没保存的改动按 Ctrl+Z 可撤销');
      return true;
    }
    return false;
  }
  function setCanvasFromGraph(graph) {
    G.setCanvas(graph);
    selectedNodeId = selectedEdgeId = '';
    render();
  }

  function open() {
    G.ensureCanvas();
    if (!canvasData().initialized) G.sampleCanvas();
    $('#btnGraphAutoRun').checked = Boolean(canvasData().autoRun);
    setModeUI('graph');
    render();
    // 进场/恢复：有节点越出视口时自动 fitView（内边距 40px），否则不打扰用户已调整的视角
    requestAnimationFrame(() => {
      const nodes = canvasData().nodes;
      if (!nodes.length) { fitView(); return; }
      const vp = viewportSize();
      const view = canvasData().viewport || { x: 0, y: 0, zoom: 1 };
      const zoom = Number(view.zoom) || 1;
      const overflow = nodes.some((n) => {
        const sx = n.x * zoom + Number(view.x || 0);
        const sy = n.y * zoom + Number(view.y || 0);
        return sx < 4 || sy < 4 || sx + 210 * zoom > vp.w - 4 || sy + 125 * zoom > vp.h - 4;
      });
      if (overflow) fitView();
    });
  }
  function close() {
    cancelConnect(true);
    if (window.XHGCS_ANALYSIS_UI && window.XHGCS_ANALYSIS_UI.close) window.XHGCS_ANALYSIS_UI.close();
  }

  function updateNodeField(node, field, value) {
    const c = node.config;
    if (field === 'label') node.label = String(value || '').slice(0, 40) || NODE_NAMES[node.type];
    else if (field === 'outLabel') { c.label = String(value || '').slice(0, 40) || '分析输出'; node.label = c.label; }
    else if (field === 'channelId') c.channelId = value;
    else if (field === 'op') c.op = value;
    else if (field === 'formula') c.formula = value;
    else if (field === 'kind') c.kind = value;
    else if (field === 'windowSize' || field === 'sampleRate' || field === 'inputCount') c[field] = Math.max(1, Number(value) || 1);
    else if (field === 'windowType' || field === 'output') c[field] = value;
    else if (field === 'code') c.code = value;
    else if (field.indexOf('param_') === 0) {
      const key = field.slice(6);
      c.parameters = Object.assign({}, c.parameters || {});
      const current = c.parameters[key];
      c.parameters[key] = typeof current === 'number' || /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : value;
    }
    else if (field === 'unit') c.unit = value;
    else if (field === 'color') c.color = value;
    else if (field === 'range0') c.range = [Number(value) || 0, Number(c.range && c.range[1]) || 100];
    else if (field === 'range1') c.range = [Number(c.range && c.range[0]) || 0, Number(value) || 100];
    else if (field === 'attach') c.attach = Boolean(value);
    if (field === 'inputCount') { G.ensureCanvas(); }
    persist();
    G.ensureCanvas();
  }

  function renderPalette() {
    // 名称套一层 .pal-label：窄栏里长名字用省略号收尾，而不是折成两行把整列顶得参差不齐
    const base = PALETTE.map(([group, items]) => '<h4>' + group + '</h4>' + items.map((item) => '<button data-add-node="' + item.type + '" title="' + item.label + '：' + (item.desc || '') + '">' + '<span class="pal-icon ' + (FFT_FUNCS[item.type] || '') + '">' + (NODE_ICONS[item.type] || '·') + '</span><span class="pal-label">' + item.label + '</span></button>').join('')).join('');
    const custom = (X.state.components || []).map((item) => '<button data-add-component="' + X.esc(item.id) + '" title="' + X.esc(item.description || item.name) + '"><span class="pal-icon component">⚙</span><span class="pal-label">' + X.esc(item.name) + '</span><small>' + (item.kind === 'python' ? 'PY' : 'ƒ') + '</small></button>').join('');
    // 分组名跟工具栏按钮、组件库标题保持一致：这一份列表里既有内置组件也有自定义组件，
    // 叫「自定义组件」等于把内置的 5 个也说成自己建的（组件库面板里它们是只读模板）。
    $('#graphPalette').innerHTML = base + '<h4>组件库</h4>' + (custom || '<div class="palette-empty">暂无组件<br />可从工具栏「组件库」创建</div>');
  }
  function bindPalette() {
    renderPalette();
    const el = $('#graphPalette');
    if (el.dataset.uiBound === '1') return;
    el.dataset.uiBound = '1';
    $('#graphPalette').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add-node]');
      const comp = e.target.closest('[data-add-component]');
      if (comp) addComponentNode(comp.dataset.addComponent);
      else if (btn) addNode(btn.dataset.addNode);
    });
  }
  function bindToolbar() {
    $('#btnGraphRun').addEventListener('click', runGraph);
    // 空画布上的「搭一个最小示例」：放一张真能跑的图进去让用户照着改，
    // 比对着一张白板猜「第一个节点该拖哪个」有用得多
    if ($('#btnGraphSample')) {
      $('#btnGraphSample').addEventListener('click', () => {
        markHistory();
        G.sampleCanvas();
        selectedNodeId = '';
        selectedEdgeId = '';
        render();
        fitView();
        setStatus('已放入示例：直接改它，或点「清空画布」自己搭');
      });
    }
    $('#btnGraphAutoRun').addEventListener('change', (e) => {
      markHistory();
      canvasData().autoRun = e.target.checked;
      persist();
      setStatus(e.target.checked ? '自动运行已开启，每 500ms 执行一次画布' : '自动运行已关闭');
    });
    $('#btnGraphZoomIn').addEventListener('click', () => zoomBy(1.18));
    $('#btnGraphZoomOut').addEventListener('click', () => zoomBy(1 / 1.18));
    $('#btnGraphFit').addEventListener('click', fitView);
    $('#btnGraphUndo').addEventListener('click', undo);
    $('#btnGraphRedo').addEventListener('click', redo);
    $('#btnGraphDelete').addEventListener('click', deleteSelected);
    $('#btnGraphClear').addEventListener('click', clearGraph);
    $('#btnGraphComponents').addEventListener('click', () => openComponentManager(componentDraftId));
    $('#btnInspExpand').addEventListener('click', () => { inspForceOpen = true; renderInspector(); });
    $('#btnGraphMode').addEventListener('click', () => setModeUI('graph'));
    $('#btnQuickMode').addEventListener('click', () => setModeUI('quick'));
  }
  function bindInspector() {
    const body = $('#graphInspectorBody');
    body.addEventListener('change', (e) => {
      const field = e.target.closest('[data-field]');
      if (!field || !selectedNodeId) return;
      const node = canvasData().nodes.find((n) => n.id === selectedNodeId);
      if (!node) return;
      markHistory();
      updateNodeField(node, field.dataset.field, field.type === 'checkbox' ? field.checked : field.value);
      render();
    });
    body.addEventListener('input', (e) => {
      const field = e.target.closest('[data-field]');
      if (!field || !selectedNodeId) return;
      if (!['label', 'outLabel', 'unit', 'range0', 'range1', 'color'].includes(field.dataset.field)) return;
      const node = canvasData().nodes.find((n) => n.id === selectedNodeId);
      if (!node) return;
      updateNodeField(node, field.dataset.field, field.type === 'checkbox' ? field.checked : field.value);
      refreshNodeCard(node);
      renderEdges();
      // 摘要卡标题就是节点名，改名后得跟着走，否则那张卡一直挂着旧名字。
      // 整块 renderInspector() 会重建名称输入框把光标顶掉，所以只换摘要卡；其余字段不影响它
      if (field.dataset.field === 'label' || field.dataset.field === 'outLabel') refreshInspectorSummary(node);
    });
    body.addEventListener('click', (e) => {
      if (e.target.id === 'btnInspectorDelete') deleteSelected();
    });
  }
  function tempLayer() { return $('#graphTempLayer') || $('#graphEdges'); }

  function cancelConnect(silent) {
    if (tempPath && tempPath.parentNode) tempPath.parentNode.removeChild(tempPath);
    tempPath = null;
    const wasConnecting = !!connecting;
    connecting = null;
    clearPortHot();
    const viewport = $('#graphViewport');
    if (viewport) viewport.classList.remove('connect-mode');
    if (wasConnecting && !silent) {
      const status = $('#graphStatus');
      if (status && status.textContent.indexOf('连线中') >= 0) setStatus('等待运行');
    }
  }

  function startConnect(portEl, clientX, clientY) {
    cancelConnect(true);
    const viewport = $('#graphViewport');
    connecting = {
      sourceId: portEl.dataset.nodeId,
      sourceHandle: portEl.dataset.portId,
      x: clientX,
      y: clientY,
      ox: clientX,
      oy: clientY,
      moved: false,
      sticky: false
    };
    tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempPath.setAttribute('class', 'gn-edge temp-path');
    tempLayer().appendChild(tempPath);
    if (viewport) viewport.classList.add('connect-mode');
    selectedNodeId = connecting.sourceId;
    selectedEdgeId = '';
    renderInspector();
    renderEdges();
  }

  function finishConnect(targetEl) {
    const source = connecting;
    cancelConnect(true);
    if (!source) return;
    if (!targetEl) {
      render();
      return;
    }
    try {
      markHistory();
      const edge = G.connect(source.sourceId, source.sourceHandle, targetEl.dataset.nodeId, targetEl.dataset.portId);
      selectedEdgeId = edge.id;
      selectedNodeId = '';
      setStatus('已连接');
    } catch (err) {
      setStatus(String(err.message || err), 'error');
    }
    render();
  }

  function bindStage() {
    const viewport = $('#graphViewport');
    const content = $('#graphContent');
    viewport.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (connecting) {
        // 连线模式：点输入端口完成；点输出端口重新起线；点其它位置退出
        const inPort = target.closest ? target.closest('.gn-port.in') : null;
        const outPort = target.closest ? target.closest('.gn-port.out') : null;
        e.preventDefault();
        e.stopPropagation();
        if (inPort) finishConnect(inPort);
        else if (outPort) startConnect(outPort, e.clientX, e.clientY);
        else cancelConnect();
        return;
      }
      if (e.button !== 0) return;
      const out = target.closest ? target.closest('.gn-port.out') : null;
      if (out) {
        e.preventDefault();
        e.stopPropagation();
        startConnect(out, e.clientX, e.clientY);
        return;
      }
      const head = target.closest ? target.closest('.gn-head') : null;
      if (head) {
        e.stopPropagation();
        const node = canvasData().nodes.find((n) => n.id === head.closest('.graph-node').dataset.nodeId);
        if (node) {
          const point = screenToGraph(e.clientX, e.clientY);
          dragging = { id: node.id, ox: point.x - node.x, oy: point.y - node.y };
          selectedNodeId = node.id;
          selectedEdgeId = '';
          renderInspector();
        }
        return;
      }
      if (target.closest('.graph-node') || target.closest('.graph-toolbar') || target.closest('.gn-edge-group')) return;
      panning = { x: e.clientX, y: e.clientY, px: canvasData().viewport && canvasData().viewport.x || 0, py: canvasData().viewport && canvasData().viewport.y || 0 };
      viewport.classList.add('panning');
      markHistory();
    });
    document.addEventListener('pointermove', (e) => {
      if (panning) {
        canvasData().viewport.x = panning.px + e.clientX - panning.x;
        canvasData().viewport.y = panning.py + e.clientY - panning.y;
        applyViewport();
      }
      if (dragging) {
        const node = canvasData().nodes.find((n) => n.id === dragging.id);
        const point = screenToGraph(e.clientX, e.clientY);
        node.x = point.x - dragging.ox;
        node.y = point.y - dragging.oy;
        const el = $('#graphNodes [data-node-id="' + node.id + '"]');
        if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
        renderEdges();
      }
      if (connecting) {
        connecting.x = e.clientX;
        connecting.y = e.clientY;
        if (!connecting.moved && Math.hypot(e.clientX - connecting.ox, e.clientY - connecting.oy) > 4) connecting.moved = true;
        renderEdges();
        updatePortHot(e.clientX, e.clientY);
      }
    });
    document.addEventListener('pointerup', (e) => {
      if (panning) {
        const moved = Math.hypot(e.clientX - panning.x, e.clientY - panning.y);
        panning = null;
        viewport.classList.remove('panning');
        persist();
        if (moved < 3) {
          // 点空白 = 取消选中：节点高亮和连线高亮都要跟着退，别只剩一个「看起来选中」的框
          selectedNodeId = selectedEdgeId = '';
          $$('.graph-node').forEach((item) => item.classList.remove('selected'));
          renderEdges();
          renderInspector();
        }
      }
      if (dragging) {
        dragging = null;
        persist();
      }
      if (connecting) {
        if (!connecting.moved) {
          // 只是点了一下端口：进入跟随鼠标的连线模式，右键 / Esc 退出
          connecting.sticky = true;
          setStatus('连线中：点击目标输入端口完成，右键或 Esc 取消');
          return;
        }
        const target = nearestPort('in', e.clientX, e.clientY, 34) || (e.target && e.target.closest ? e.target.closest('.gn-port.in') : null);
        finishConnect(target);
      }
    });
    viewport.addEventListener('contextmenu', (e) => {
      if (!connecting) return;
      e.preventDefault();
      e.stopPropagation();
      cancelConnect();
    });
    $$('.graph-edges').forEach(() => {});
    $('#graphEdges').addEventListener('click', (e) => {
      const deleteButton = e.target.closest('.gn-edge-delete');
      const path = e.target.closest('.gn-edge-hit') || e.target.closest('.gn-edge-visible');
      const target = deleteButton || path;
      if (target && target.dataset.edgeId) {
        if (deleteButton) {
          selectedEdgeId = target.dataset.edgeId;
          selectedNodeId = '';
          deleteSelected();
          return;
        }
        selectedEdgeId = target.dataset.edgeId;
        selectedNodeId = '';
        renderInspector();
        renderEdges();
      }
    });
    $('#graphEdges').addEventListener('contextmenu', (e) => {
      const path = e.target.closest('.gn-edge-hit') || e.target.closest('.gn-edge-visible') || e.target.closest('.gn-edge-delete');
      if (!path || !path.dataset.edgeId) return;
      e.preventDefault();
      selectedEdgeId = path.dataset.edgeId;
      selectedNodeId = '';
      renderInspector();
      renderEdges();
      deleteSelected();
    });
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const c = canvasData();
      const rect = viewport.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (!e.shiftKey && !e.altKey) {
        const old = c.viewport.zoom || 1;
        const zoom = Math.max(.2, Math.min(3, old * Math.exp(-e.deltaY * .0016)));
        c.viewport.x = px - (px - (c.viewport.x || 0)) * zoom / old;
        c.viewport.y = py - (py - (c.viewport.y || 0)) * zoom / old;
        c.viewport.zoom = zoom;
      } else {
        const delta = e.deltaY || e.deltaX;
        if (e.shiftKey) c.viewport.x -= delta;
        if (e.altKey) c.viewport.y -= delta;
      }
      applyViewport();
      persistSoon();
    }, { passive: false });
  }
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!(window.XHGCS_ANALYSIS_UI && window.XHGCS_ANALYSIS_UI.isOpen && window.XHGCS_ANALYSIS_UI.isOpen())) return;
      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag);
      if (e.key === 'Escape' && !e.isComposing) {
        // 上面还压着别的浮层时（设置 / 视图插件）交给它们处理
        const app = window.XHGCS_APP;
        const top = app && app.topOverlay ? app.topOverlay() : '';
        if (top) return;
        if (!$('#componentManager').classList.contains('hidden')) { closeComponentManager(); return; }
        if (connecting) { cancelConnect(); return; }
        if (selectedNodeId || selectedEdgeId) {
          selectedNodeId = selectedEdgeId = '';
          renderInspector();
          renderEdges();
          return;
        }
        // 光标还在输入框里先退出输入，再按一次才关画布，避免误关
        if (typing) { document.activeElement.blur(); return; }
        if (window.XHGCS_ANALYSIS_UI) XHGCS_ANALYSIS_UI.close();
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    });
  }
  function init() {
    bindPalette();
    bindToolbar();
    bindInspector();
    bindComponentManager();
    bindStage();
    bindKeyboard();
    window.addEventListener('resize', () => { if (window.XHGCS_ANALYSIS_UI && window.XHGCS_ANALYSIS_UI.isOpen && window.XHGCS_ANALYSIS_UI.isOpen()) applyViewport(); });
    window.addEventListener('xhgcs:components-changed', () => { renderPalette(); if (!$('#componentManager').classList.contains('hidden')) renderComponentManager(); });
    G.ensureCanvas();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.XHGCS_GRAPH_UI = {
    open: open,
    close: close,
    render: render,
    runGraph: runGraph,
    attachGraph: attachGraph,
    runSavedGraph: runSavedGraph,
    saveGraph: saveGraph,
    loadScript: loadScript,
    addNode: addNode,
    renderComponents: renderPalette,
    openComponents: openComponentManager,
    setModeUI: setModeUI,
    setStatus: setStatus
  };
})();
