(function () {
  'use strict';
  const V = window.XHGCS_VIEWS;
  const X = window.XHGCS;
  const state = X.state;
  const ref = V.ref;
  let mapTransform = null;

  function bindMap() {
    ref.btnMapCruise.addEventListener('click', () => {
      state.cruise = !state.cruise;
      if (state.cruise) state.homeMode = false;
      // cruise 是随配置保存的字段，设置面板改的也是它；这条路径原来漏了 persist()
      X.persist();
      updateMapButtons();
      renderMap();
    });
    ref.btnMapHome.addEventListener('click', () => {
      state.homeMode = true;
      state.cruise = false;
      updateMapButtons();
      renderMap();
      V.callApp('toast', '已下达返航指令');
    });
    ref.btnMapWaypoint.addEventListener('click', () => {
      const p = state.track.length ? state.track[state.track.length - 1] : { x: 0, y: 0 };
      state.waypoints.push({ id: X.uid('wp'), x: Math.round(p.x), y: Math.round(p.y), name: 'WP-' + (state.waypoints.length + 1) });
      // 点画布加航点那条路径会落盘，按钮这条原来不会：重启后航点只剩一半
      X.persist();
      renderMap();
      V.callApp('toast', '已添加航点 (' + Math.round(p.x) + ', ' + Math.round(p.y) + ')');
    });
    ref.btnMapClear.addEventListener('click', () => {
      state.track = [];
      renderMap();
    });
    ref.mapCanvas.addEventListener('click', (e) => {
      if (!mapTransform) return;
      const rect = ref.mapCanvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wx = mapTransform.cx + (px - rect.width / 2) / mapTransform.scale;
      const wy = mapTransform.cy - (py - rect.height / 2) / mapTransform.scale;
      state.waypoints.push({ id: X.uid('wp'), x: Math.round(wx / 5) * 5, y: Math.round(wy / 5) * 5, name: 'WP-' + (state.waypoints.length + 1) });
      renderMap();
      X.persist();
    });
  }

  function updateMapButtons() {
    ref.btnMapCruise.textContent = '巡航：' + (state.cruise ? '开' : '关');
    ref.btnMapHome.textContent = state.homeMode ? '返航中' : '返航';
    ref.btnMapPlay.textContent = state.playing ? '▶ 暂停' : '▶ 播放';
  }

  function renderMap() {
    const info = V.ensureCanvas(ref.mapCanvas);
    if (!info) return;
    const ctx = info.ctx, W = info.w, H = info.h;
    const pts = state.track.slice(-600);
    const all = pts.concat(state.waypoints.map((p) => ({ x: p.x, y: p.y })));
    let minX = -180, maxX = 180, minY = -180, maxY = 180;
    if (all.length) {
      minX = Math.min.apply(null, all.map((p) => p.x));
      maxX = Math.max.apply(null, all.map((p) => p.x));
      minY = Math.min.apply(null, all.map((p) => p.y));
      maxY = Math.max.apply(null, all.map((p) => p.y));
    }
    const spanX = Math.max(100, maxX - minX);
    const spanY = Math.max(100, maxY - minY);
    const pad = 34;
    const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const sx = (x) => W / 2 + (x - cx) * scale;
    const sy = (y) => H / 2 - (y - cy) * scale;
    mapTransform = { cx: cx, cy: cy, scale: scale };

    ctx.clearRect(0, 0, W, H);
    const TH = X.canvasColors();
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(' + TH.accRgb + ',.06)';
    ctx.lineWidth = 1;
    const step = spanX > 400 ? 100 : spanX > 160 ? 50 : 20;
    for (let g = Math.floor(minX / step) * step; g <= maxX; g += step) {
      ctx.beginPath(); ctx.moveTo(sx(g), 0); ctx.lineTo(sx(g), H); ctx.stroke();
    }
    for (let g = Math.floor(minY / step) * step; g <= maxY; g += step) {
      ctx.beginPath(); ctx.moveTo(0, sy(g)); ctx.lineTo(W, sy(g)); ctx.stroke();
    }

    if (pts.length > 1) {
      ctx.save();
      ctx.strokeStyle = TH.acc;
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(' + TH.accRgb + ',.5)';
      ctx.shadowBlur = TH.glow ? 8 : 0;
      ctx.beginPath();
      ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
      pts.slice(1).forEach((p) => ctx.lineTo(sx(p.x), sy(p.y)));
      ctx.stroke();
      ctx.restore();
    }

    state.waypoints.forEach((wp, i) => {
      const x = sx(wp.x), y = sy(wp.y);
      ctx.fillStyle = i === 0 ? '#34d399' : '#fbbf24';
      ctx.beginPath(); ctx.arc(x, y, i === 0 ? 6 : 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = TH.bg;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y);
      ctx.fillStyle = TH.dimText;
      ctx.font = '10px sans-serif';
      ctx.fillText(wp.name, x + 9, y - 8);
    });

    const current = pts.length ? pts[pts.length - 1] : { x: 0, y: 0 };
    const prev = pts.length > 1 ? pts[pts.length - 2] : current;
    const angle = Math.atan2(current.y - prev.y, current.x - prev.x);
    ctx.save();
    ctx.translate(sx(current.x), sy(current.y));
    ctx.rotate(angle);
    ctx.fillStyle = '#f87171';
    ctx.shadowColor = '#f87171';
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(-7, -6); ctx.lineTo(-4, 0); ctx.lineTo(-7, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = TH.dimText;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('N ↑', 12, 18);
    ctx.strokeStyle = TH.frame;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    const mode = state.homeMode ? '返航中' : (state.cruise ? '巡航' : '悬停');
    // 规模归底栏右槽 —— 另外四个子视图都写在那里，画布里的浮层图例是同一个数说两遍，已去掉
    ref.statusInfo.textContent = '航迹 ' + pts.length + ' 点 · ' + mode + ' · 航点 ' + state.waypoints.length;
  }

  V.bindMap = bindMap;
  V.updateMapButtons = updateMapButtons;
  V.renderMap = renderMap;
})();
