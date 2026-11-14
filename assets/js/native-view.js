/* 璇玑声明式视图。只有宿主的注册项能绘制，规格只携带数据。 */
(function () {
  'use strict';
  const roles = ['channel', 'accent', 'warning'];
  const catalog = Object.freeze({
    trend: { label: '趋势图', max: 8, normalize: true, units: '按单位分轨；可显式归一化', draw: trend },
    bars: { label: '条形对比', max: 8, units: '按单位分组', draw: bars },
    gauge: { label: '仪表', max: 1, units: '通道量程', draw: gauge },
    value: { label: '数值卡', max: 1, units: '原始单位', draw: value }
  });
  const fields = ['type', 'title', 'channels', 'color', 'span'];
  const own = (obj, key) => Object.hasOwn(obj, key);
  function fail(path, reason) { throw new Error(path + ' · ' + reason); }
  function record(obj, allowed, at) {
    if (!obj || Object.getPrototypeOf(obj) !== Object.prototype) fail(at, '需要 JSON 对象');
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(at + '.' + k, '未知属性');
  }
  function label(s, at) {
    if (typeof s !== 'string' || !s.trim() || s.length > 100 ||
        /[<>\x00-\x1f]|(?:https?:\/\/|javascript:|data:text\/html)/i.test(s)) fail(at, '需要 1–100 字的纯文本');
    return s.trim();
  }
  function validate(input) {
    record(input, ['version','name','columns','components'], 'view');
    if (input.version !== 1) fail('version', '仅支持 v1');
    const name = label(input.name, 'name');
    if (![1, 2].includes(input.columns)) fail('columns', '只支持 1 或 2 列');
    if (!Array.isArray(input.components) || !input.components.length || input.components.length > 12)
      fail('components', '需要 1–12 个组件');
    const components = input.components.map((c, i) => {
      const at = 'components[' + i + ']';
      if (!c || typeof c.type !== 'string' || !own(catalog, c.type)) fail(at+'.type', '未注册的组件');
      const def = catalog[c.type];
      record(c, def.normalize ? fields.concat('normalize') : fields, at);
      if (!Array.isArray(c.channels) || c.channels.length < 1 || c.channels.length > def.max)
        fail(at+'.channels', '需要 1–' + def.max + ' 个通道 ID');
      const channels = c.channels.map((id,j) => label(id, at+'.channels['+j+']'));
      if (new Set(channels).size !== channels.length) fail(at+'.channels', '重复绑定');
      if (own(c,'normalize') && typeof c.normalize !== 'boolean') fail(at+'.normalize','需要布尔值');
      if (own(c,'color') && !roles.includes(c.color)) fail(at+'.color','需要主题角色');
      const span = own(c,'span') ? c.span : 1;
      if (span !== 1 && !(span === 2 && input.columns === 2)) fail(at+'.span','跨度超过网格');
      const result = { type:c.type, title:label(c.title, at+'.title'), channels, span, color:c.color || 'channel' };
      if (def.normalize) result.normalize = c.normalize === true;
      return result;
    });
    return { version:1, name, columns:input.columns, components };
  }
  function describe() {
    return {version:1, columns:[1,2], maxComponents:12, colors:roles.slice(),
      layout:'columns 和 span 都是 JSON 整数。columns=1 时 span 只能为 1；columns=2 时 span 可为 1 或 2。不指定 span 时占一列。组件按数组顺序自动排布。',
      components:Object.entries(catalog).map(([type,d])=>({type,label:d.label,minChannels:1,maxChannels:d.max,
        fields:d.normalize ? fields.concat('normalize') : fields.slice(), units:d.units,span:[1,2]})),
      example:{version:1,name:'通道趋势与读数',columns:2,components:[
        {type:'trend',title:'趋势',channels:['示例ID1','示例ID2'],span:2},
        {type:'value',title:'当前值 1',channels:['示例ID1']},{type:'value',title:'当前值 2',channels:['示例ID2']}
      ]}
    };
  }
  function element(tag, cls, text) {
    const el=document.createElement(tag);
    if (cls) el.className=cls;
    if (text !== undefined) el.textContent=text;
    return el;
  }
  function finitePoint(p) { return !!p && p.valid !== false && Number.isFinite(p.t) && Number.isFinite(p.v); }
  function color(c, ch, palette) { return c.color==='accent' ? palette.amber : c.color==='warning' ? palette.warn : ch.color || palette.ink; }
  function range(points) {
    let min=Infinity,max=-Infinity;
    for(const p of points) if(finitePoint(p)){ min=Math.min(min,p.v); max=Math.max(max,p.v); }
    return [min,max];
  }
  function groups(rows, normalized) {
    const result=new Map();
    for(const row of rows){const key=normalized ? '归一化 0–1' : row.unit || '无单位';
      if(!result.has(key)) result.set(key,[]); result.get(key).push(row);}
    return result;
  }
  function trend(g,w,h,c,rows,pal) {
    const tracks=groups(rows,c.normalize), height=h/Math.max(1,tracks.size);
    let index=0;
    for(const [unit,items] of tracks){
      const limits=items.map(ch=>range(ch.points));
      const lo=Math.min(...limits.map(r=>r[0])),hi=Math.max(...limits.map(r=>r[1]));
      let first=Infinity,last=-Infinity;
      for(const ch of items) for(const p of ch.points) if(Number.isFinite(p.t)){first=Math.min(first,p.t);last=Math.max(last,p.t);}
      const y=index++*height;
      g.fillStyle=pal.ink2;g.fillText(unit,3,y+12);g.strokeStyle=pal.grid;g.strokeRect(1,y+16,w-2,height-19);
      items.forEach((ch,i)=>{
        const [low,high]=c.normalize?limits[i]:[lo,hi];
        let prev=null;
        g.strokeStyle=color(c,ch,pal);g.beginPath();
        for(const p of ch.points){
          if(!finitePoint(p)){prev=null;continue;}
          const x=3+(p.t-first)/(last-first||1)*(w-6);
          const py=y+height-5-(high===low?.5:(p.v-low)/(high-low))*(height-24);
          if(prev && p.t>=prev.t && p.t-prev.t<=(p.gapLimit||.5)) g.lineTo(x,py);
          else {g.moveTo(x,py);g.lineTo(x+.1,py);}
          prev=p;
        }
        g.stroke();
      });
    }
  }
  function bars(g,w,h,c,rows,pal) {
    let y=0; const line=h/Math.max(1,rows.length);
    for(const items of groups(rows,false).values()){
      const max=Math.max(1e-12,...items.map(ch=>Math.abs(ch.latest??0)));
      for(const ch of items){ const x=w/2;
        g.strokeStyle=pal.grid;g.beginPath();g.moveTo(x,y);g.lineTo(x,y+line);g.stroke();
        if(ch.latest!=null){g.fillStyle=color(c,ch,pal);g.fillRect(x,y+3,ch.latest/max*(w/2-3),Math.max(1,line-6));}
        y+=line;}
    }
  }
  function gauge(g,w,h,c,rows,pal){
    const ch=rows[0];if(!ch)return;
    const [lo,hi]=ch.range || [];
    if(!(hi>lo) || ch.latest==null) return;
    const radius=Math.min(w*.42,h*.82),x=w/2,y=h-6;
    g.lineWidth=5;g.strokeStyle=pal.grid;g.beginPath();g.arc(x,y,radius,Math.PI,2*Math.PI);g.stroke();
    g.strokeStyle=color(c,ch,pal);g.beginPath();
    g.arc(x,y,radius,Math.PI,Math.PI*(1+Math.max(0,Math.min(1,(ch.latest-lo)/(hi-lo)))));g.stroke();
  }
  function value(node,c,rows,pal){
    const ch=rows[0];
    node.textContent=ch && ch.latest!=null ? format(ch.latest,ch.unit) : '—';
    node.style.color=ch ? color(c,ch,pal) : '';
  }
  function format(n,unit){return Number(n.toPrecision(5)).toString()+(unit?' '+unit:'');}
  function mount(host,input,source) {
    const spec=validate(input),grid=element('div','nv-grid');
    grid.style.setProperty('--nv-cols',spec.columns);
    const slots=spec.components.map(c=>{
      const panel=element('section','nv-panel'),title=element('strong','nv-title',c.title);
      panel.style.setProperty('--nv-span',c.span);
      const plot=element(c.type==='value'?'output':'canvas', c.type==='value'?'nv-value':'nv-plot');
      const legend=element('div','nv-legend');
      const labels=c.channels.map(()=>{const line=element('span');legend.append(line);return line;});
      panel.append(title,plot,legend);grid.append(panel);
      return {c,plot,labels};
    });
    host.replaceChildren(grid);
    function update(){
      if(document.hidden || !grid.isConnected || !grid.getClientRects().length) return;
      const pal=source.palette(),cache=new Map();
      for(const {c,plot,labels} of slots){
        const rows=[];
        c.channels.forEach((id,i)=>{
          if(!cache.has(id)) cache.set(id,source.channel(id));
          const ch=cache.get(id);
          const text=ch ? ch.name+' · '+(ch.latest==null?'暂无有效数据':format(ch.latest,ch.unit)) : id+' · 通道缺失，请重新绑定';
          if(labels[i].textContent!==text) labels[i].textContent=text;
          if(ch){rows.push(ch);labels[i].style.color=color(c,ch,pal);}
        });
        const draw=catalog[c.type].draw;
        if(c.type==='value'){draw(plot,c,rows,pal);continue;}
        const w=plot.clientWidth,h=c.type==='trend'?Math.max(65,groups(rows,c.normalize).size*54):Math.max(50,rows.length*14);
        if(!w)continue;
        plot.style.height=h+'px';
        const dpr=window.devicePixelRatio||1;
        if(plot.width!==Math.round(w*dpr))plot.width=Math.round(w*dpr);
        if(plot.height!==Math.round(h*dpr))plot.height=Math.round(h*dpr);
        const g=plot.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
        g.font='11px '+getComputedStyle(grid).fontFamily;
        draw(g,w,h,c,rows,pal);
      }
    }
    update();
    return { update, dispose(){grid.remove();} };
  }
  window.XuanjiViewV1=Object.freeze({validate,describe,mount,element,finitePoint});
})();
