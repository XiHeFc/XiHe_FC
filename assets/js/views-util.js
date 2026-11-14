(function () {
  'use strict';
  const V = window.XHGCS_VIEWS = window.XHGCS_VIEWS || {};
  const X = window.XHGCS;

  V.$ = function (s) { return document.querySelector(s); };
  V.$$ = function (s) { return Array.from(document.querySelectorAll(s)); };

  V.callApp = function (fn, arg) {
    if (window.XHGCS_APP && typeof window.XHGCS_APP[fn] === 'function') {
      if (arg === undefined) window.XHGCS_APP[fn]();
      else window.XHGCS_APP[fn](arg);
    }
  };

  V.ensureCanvas = function (canvas) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(rect.width));
    const h = Math.max(10, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  };

  V.resizeCanvas = function (canvas) {
    if (!canvas || canvas.classList.contains('hidden')) return null;
    return V.ensureCanvas(canvas);
  };

  V.drawStake = function (ctx, x, y, label, color, last) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = .94;
    ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 8);
    if (!last) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.strokeRect(x - 15, y - 24, 30, 14);
    }
    ctx.restore();
  };

  V.clampColor = function (hex, alphaHex) {
    return String(hex || '#38bdf8') + String(alphaHex || '33');
  };

  V.ref = {};
})();
