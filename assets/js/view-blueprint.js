(function () {
  'use strict';

  const X = window.XHGCS;
  const B = window.XHGCS_VIEW_BLUEPRINT = window.XHGCS_VIEW_BLUEPRINT || {};

  const TYPES = {
    trend: { name: '趋势', icon: '∿', desc: '多通道折线 / 示波器' },
    bars: { name: '对比', icon: '▥', desc: '通道当前值横向对比' },
    donut: { name: '占比', icon: '◕', desc: '通道当前值占比环' },
    kpi: { name: '指标', icon: '◫', desc: '关键通道当前值摘要' }
  };

  function channelList() {
    const list = X && X.allChannels ? X.allChannels() : [];
    return list.filter(function (ch) { return ch && ch.visible !== false; });
  }

  function mentionedChannels(text) {
    const source = String(text || '').toLowerCase();
    return channelList().filter(function (ch) {
      const id = String(ch.id || '').toLowerCase();
      const name = String(ch.name || '').toLowerCase();
      return (id && source.indexOf(id) >= 0) || (name && source.indexOf(name) >= 0);
    }).map(function (ch) { return ch.id; });
  }

  function inferTypes(text) {
    const src = String(text || '');
    const out = [];
    const push = function (type) { if (out.indexOf(type) < 0) out.push(type); };
    if (/折线|曲线|趋势|波形|示波|频谱|轨迹/.test(src)) push('trend');
    if (/柱状|条形|排行|排名|对比|比较/.test(src)) push('bars');
    if (/环形|饼图|占比|比例|构成/.test(src)) push('donut');
    if (/关键指标|指标|KPI|数值|读数|状态卡/i.test(src)) push('kpi');
    if (!out.length) out.push('trend');
    if (/看板|仪表盘|组合|多图|总览/.test(src) && out.indexOf('kpi') < 0 && out.length < 3) push('kpi');
    return out.slice(0, 4);
  }

  function cleanSeries(value, fallback) {
    const source = Array.isArray(value) ? value : (value ? [value] : []);
    const ids = [];
    source.forEach(function (item) {
      const found = X && X.findChannel ? X.findChannel(String(item)) : null;
      if (found && ids.indexOf(found.id) < 0) ids.push(found.id);
    });
    return ids.length ? ids.slice(0, 8) : fallback.slice(0, 8);
  }

  function normalize(input, prompt) {
    const raw = input || {};
    const text = String(prompt || raw.prompt || '').trim();
    const mentioned = mentionedChannels(text);
    const all = channelList().map(function (ch) { return ch.id; });
    const baseSeries = mentioned.length ? mentioned : all;
    const requested = Array.isArray(raw.blocks) ? raw.blocks : [];
    const types = requested.length
      ? requested.map(function (item) { return String(item && (item.type || item) || ''); })
      : inferTypes(text);
    const blocks = types
      .filter(function (type) { return Object.prototype.hasOwnProperty.call(TYPES, type); })
      .slice(0, 4)
      .map(function (type, index) {
        const item = requested[index] || {};
        const series = cleanSeries(item.series || raw.channels, baseSeries);
        return {
          type: type,
          title: String(item.title || TYPES[type].name).slice(0, 24),
          series: series.slice(0, type === 'kpi' ? 4 : 6)
        };
      });
    if (!blocks.length) {
      blocks.push({ type: 'trend', title: TYPES.trend.name, series: baseSeries.slice(0, 6) });
    }
    const requestedLayout = String(raw.layout || 'auto');
    const layout = /single|stack|split|dashboard/.test(requestedLayout)
      ? requestedLayout
      : blocks.length === 1 ? 'single' : blocks.length === 2 ? 'split' : 'dashboard';
    return {
      version: 1,
      layout: layout,
      blocks: blocks,
      channels: baseSeries,
      prompt: text
    };
  }

  function nameFromPrompt(prompt, types) {
    let text = String(prompt || '')
      .replace(/^(请|帮我|麻烦|生成|画|做|创建|来)(一个|一张|个|张)?/g, '')
      .replace(/^包含/, '')
      .replace(/(的可视化|视图|仪表盘|看板|界面|图)$/g, '')
      .replace(/的$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) text = types.map(function (type) { return TYPES[type].name; }).join(' + ') + '视图';
    return text.length > 18 ? text.slice(0, 18) : text;
  }

  function codeFor(blueprint) {
    const blocks = blueprint.blocks;
    const id = X && X.uid ? X.uid('bpview') : 'bpview-' + Date.now().toString(36);
    const blockHtml = blocks.map(function (block, index) {
      const title = X.esc(block.title || TYPES[block.type].name);
      const data = ' data-bp="' + index + '"';
      if (block.type === 'kpi') {
        return '<div class="vp-card vp-blueprint-card"><div class="vp-title">' + title
          + '</div><div class="vp-rows" data-bp-kpi="' + index + '"></div></div>';
      }
      return '<div class="vp-card vp-blueprint-card"><div class="vp-title">' + title
        + '</div><div class="vp-plot"><canvas' + data + '></canvas></div></div>';
    }).join('');
    const updateLines = blocks.map(function (block, index) {
      const series = JSON.stringify(block.series || []);
      if (block.type === 'trend') {
        return 'ctx.draw.scope(ctx.canvas[' + index + '],{series:' + series + ',limit:6,value:true,time:true,legend:"right",normalize:true});';
      }
      if (block.type === 'bars') {
        return 'ctx.draw.bars(ctx.canvas[' + index + '],{series:' + series + ',limit:8,rows:8});';
      }
      if (block.type === 'donut') {
        return 'ctx.draw.donut(ctx.canvas[' + index + '],{series:' + series + ',limit:6,centerText:"' + String(block.title || TYPES.donut.name).replace(/"/g, '') + '"});';
      }
      return [
        'var kp' + index + '=ctx.host.querySelector(\'[data-bp-kpi="' + index + '"]\');',
        'if(kp' + index + '){',
        'var ks' + index + '=ctx.series(' + series + ',4);',
        'if(!kp' + index + '.children.length){kp' + index + '.innerHTML=ks' + index + '.map(function(ch){return \'<div class="vp-row"><i class="vp-dot" style="background:\'+ctx.esc(ch.color)+\'"></i><span class="vp-name">\'+ctx.esc(ch.name)+\'</span><span class="vp-num" data-kpi-id="\'+ctx.esc(ch.id)+\'">--</span></div>\';}).join("");}',
        'ks' + index + '.forEach(function(ch){var v=ctx.latest(ch);var el=kp' + index + '.querySelector(\'[data-kpi-id="\'+ch.id+\'"]\');if(el)el.textContent=ctx.formatValue(ch,v);});',
        '}'
      ].join('');
    }).join('');
    const code = '({\n'
      + 'id:' + JSON.stringify(id) + ',\n'
      + 'mount:function(ctx){\n'
      + 'ctx.host.innerHTML=' + JSON.stringify('<div class="vp-wrap vp-blueprint"><div class="vp-blueprint-grid" data-layout="' + blueprint.layout + '">' + blockHtml + '</div></div>') + ';\n'
      + 'ctx.canvas=Array.prototype.slice.call(ctx.host.querySelectorAll("canvas[data-bp]"));\n'
      + '},\n'
      + 'update:function(ctx){\n'
      + 'var TH=ctx.theme();\n'
      + updateLines + '\n'
      + '}\n'
      + '})';
    const first = blocks[0] || { type: 'trend' };
    return {
      name: nameFromPrompt(blueprint.prompt, blocks.map(function (block) { return block.type; })),
      icon: TYPES[first.type].icon,
      desc: blocks.map(function (block) { return TYPES[block.type].name; }).join(' + ') + ' 组合视图',
      code: code,
      blueprint: blueprint
    };
  }

  function promptText(blueprint, prompt) {
    return String(prompt || blueprint.prompt || '').trim()
      + '\n\n# 构图板\n'
      + '布局：' + blueprint.layout + '\n'
      + blueprint.blocks.map(function (block) {
        return '- ' + TYPES[block.type].name + '：' + (block.series.length ? block.series.join(', ') : '全部可见通道');
      }).join('\n');
  }

  B.types = TYPES;
  B.normalize = normalize;
  B.compile = function (blueprint, prompt) {
    return codeFor(normalize(blueprint, prompt));
  };
  B.promptText = function (blueprint, prompt) {
    return promptText(normalize(blueprint, prompt), prompt);
  };
  B.channels = channelList;
})();
