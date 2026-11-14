/* UI10 原生视图库。工作区内只保存 JSON 定义、实例和已完成申请的身份。 */
(function () {
  'use strict';
  const api=window.XuanjiViewV1, el=api.element;
  function create(host) {
    const key='xuanji.ui10.views.v1', live=new Map(), drafts=new Map();
    let store={version:1,defs:[],instances:[],receipts:[]}, active='', preview=null, generation=0, writable=true;
    const invalid=new Map(), uid=()=>crypto.randomUUID();
    try {
      const raw=localStorage.getItem(key);
      if(raw){const v=JSON.parse(raw);
        if(v.version!==1 || !Array.isArray(v.defs)||!Array.isArray(v.instances)) throw Error('无法读取视图库版本');
        store={...v,receipts:Array.isArray(v.receipts)?v.receipts:[]};
        for(const d of store.defs) {
          try { d.spec=api.validate(d.spec); } catch(e){invalid.set(d?.id,e.message);}
        }
      }
    } catch(e){ writable=false;host.toast('视图库需要修复 · '+e.message); }
    function commit(next) {
      if(!writable)throw Error('无法读取现有视图库，保存已暂停');
      const previous=store;
      try{
        store=next;active=null;refresh();
        localStorage.setItem(key,JSON.stringify(next));
      }catch(e){store=previous;active=null;refresh();throw e;}
      cards();
    }
    function catalog(){return api.describe();}
    let frameChannels=null;
    function mainSource(){return {channel(id){
      if(!frameChannels)return host.channel(id);
      if(!frameChannels.has(id))frameChannels.set(id,host.channel(id));
      return frameChannels.get(id);
    },palette:host.palette};}
    function currentPage(){const id=host.page();if(!id)throw Error('没有活动图页');return id;}
    function checkBindings(spec){
      for(const [i,c] of spec.components.entries())for(const id of c.channels)
        if(!host.channel(id))throw Error('components['+i+'].channels · 找不到 '+id);
    }
    function validateDraft(raw){const spec=api.validate(raw);checkBindings(spec);return spec;}
    function prepare(raw,pageId=currentPage()){
      if(!host.pages().includes(pageId))throw Error('目标图页不存在');
      const spec=validateDraft(raw),draftId=uid();
      // 实际挂载一次，捕获渲染异常。预检宿主有尺寸并使用与正式视图相同的样式。
      const box=el('div','nv-probe');document.body.append(box);
      try { api.mount(box,spec,mainSource()).dispose(); } finally { box.remove(); }
      drafts.set(draftId,{spec,pageId,time:Date.now()});
      for(const [id,d] of drafts)if(drafts.size>64 || Date.now()-d.time>600000)drafts.delete(id);
      return {draftId,pageId,version:1,workspaceId:host.workspace(),issues:[]};
    }
    function apply({draftId,pageId,version,workspaceId,requestId},editId) {
      if(!requestId || typeof requestId!=='string'||requestId.length>120)throw Error('需要 requestId');
      if(workspaceId!==host.workspace() || version!==1)throw Error('工作区或规格版本不匹配');
      const previous=store.instances.find(i=>i?.requestId===requestId)||store.receipts.find(i=>i?.requestId===requestId);
      if(previous){
        if(previous.draftId!==draftId || previous.pageId!==pageId)throw Error('requestId 已用于其他草稿');
        return {viewId:previous.viewId,instanceId:previous.id,pageId,applied:true};
      }
      const d=drafts.get(draftId);
      if(!d||Date.now()-d.time>600000||d.pageId!==pageId)throw Error('草稿过期或目标图页不匹配');
      if(currentPage()!==pageId)throw Error('请切换到预览所在图页再应用');
      validateDraft(d.spec);
      const viewId=editId||uid(),existing=editId && store.instances.find(i=>i?.viewId===editId && i.pageId===pageId);
      const offset=12+18*(store.instances.filter(i=>i?.pageId===pageId).length%7);
      const instance={id:existing?.id||uid(),viewId,pageId,x:existing?.x??offset,y:existing?.y??offset,bindings:d.spec.components.map(c=>c.channels),draftId,requestId};
      const defs=store.defs.filter(v=>v?.id!==viewId).concat({id:viewId,spec:d.spec});
      const instances=store.instances.filter(i=>i?.id!==instance.id).map(i=>i?.viewId===viewId?{...i,bindings:instance.bindings}:i).concat(instance);
      commit({...store,defs,instances,receipts:store.receipts.slice(-199).concat(instance)});
      if(!live.has(instance.id))throw Error('图页未挂载视图');
      invalid.delete(viewId);drafts.delete(draftId);return {viewId,instanceId:instance.id,pageId,applied:true};
    }
    function button(label,fn,cls='btn-ghost'){
      const b=el('button',cls,label);b.type='button';b.onclick=()=>{try{fn();}catch(e){host.toast(e.message);}};return b;
    }
    function download(data,name){
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const a=el('a');a.href=url;a.download=name+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
    }
    function legacy(){return (window.XHGCS?.state?.views||[]).filter(v=>v && typeof v.code==='string');}
    function cards(){
      const anchor=document.getElementById('addWidgetCard');if(!anchor)return;
      const grid=anchor.parentNode;
      grid.querySelectorAll('.nv-card').forEach(n=>n.remove());
      for(const d of store.defs.filter(d=>d && typeof d.id==='string')){
        const broken=invalid.has(d.id);
        grid.insertBefore(button(broken?'待修复 · 导出':d.spec.name,()=>broken?download(d,'待修复视图'):editor(d.spec,d.id),'wcard wide nv-card'),anchor);
      }
      for(const v of legacy())grid.insertBefore(button('旧格式 · '+(v.name||v.id),()=>legacyDialog(v),'wcard wide nv-card'),anchor);
      const count=document.getElementById('widgetCount');if(count)count.textContent=String(8+grid.querySelectorAll('.nv-card').length);
    }
    function removeInstance(i) {
      commit({...store,instances:store.instances.filter(x=>x?.id!==i.id)});
    }
    function position(node,i){
      const parent=node.parentElement;
      const x=Math.max(0,Math.min(i.x||0,parent.clientWidth-node.offsetWidth));
      const y=Math.max(0,Math.min(i.y||0,parent.clientHeight-35));
      node.style.left=x+'px';node.style.top=y+'px';
    }
    function attach(i,def){
      const layer=host.layer(),box=el('article','nv-window'),head=el('div','nv-head'),body=el('div','nv-body');
      head.append(el('b','nv-title',def.spec.name),button('编辑',()=>editor(def.spec,def.id)),button('关闭',()=>removeInstance(i)));
      box.append(head,body);layer.append(box);
      let render;
      try {
        const bound={...def.spec,components:def.spec.components.map((c,k)=>({...c,channels:i.bindings?.[k]??c.channels}))};
        render=api.mount(body,bound,mainSource());
      }catch(e){
        body.textContent='实例绑定需要修复 · '+e.message;
        render={update(){},dispose(){body.replaceChildren();}};
      }
      position(box,i);
      let drag=null;
      head.onpointerdown=e=>{if(e.target.closest('button'))return;drag=[e.clientX-box.offsetLeft,e.clientY-box.offsetTop];head.setPointerCapture(e.pointerId);};
      head.onpointermove=e=>{if(drag)position(box,{x:e.clientX-drag[0],y:e.clientY-drag[1]});};
      head.onpointerup=()=>{if(!drag)return;drag=null;
        try{commit({...store,instances:store.instances.map(v=>v?.id===i.id?{...v,x:box.offsetLeft,y:box.offsetTop}:v)});}
        catch(e){position(box,i);host.toast(e.message);}
      };
      head.onpointercancel=()=>{drag=null;position(box,i);};
      return {update:render.update,dispose(){render.dispose();box.remove();}};
    }
    function refresh(){
      const page=host.page()||'';
      if(active!==page){
        for(const item of live.values())item.dispose();live.clear();
        for(const i of store.instances){
          if(!i||i.pageId!==page)continue;
          const d=store.defs.find(d=>d && d.id===i.viewId);
          if(d && !invalid.has(d.id))live.set(i.id,attach(i,d));
        }
        active=page;
      }
    }
    // 由 UI10 已有的绘制循环统一驱动；无独立组件定时器。
    let lastPaint=-Infinity;
    function tick(){
      refresh();if(document.hidden || performance.now()-lastPaint<100)return;
      lastPaint=performance.now();frameChannels=new Map();
      try {
        preview?.update();
        if(host.visible())for(const view of live.values())view.update();
      }finally{frameChannels=null;}
    }
    function cleanup(){generation++;preview?.dispose();preview=null;}
    function dialog(title,body,foot,wide=true){
      host.dialog({title,wide,sub:'',body:'',foot:'',onMount(){
        document.getElementById('dlgBody').append(body);document.getElementById('dlgFoot').append(...foot);
      }});
    }
    function template(type){
      const meta=host.channels();
      if(!meta.length)throw Error('请先添加或连接一个通道');
      const spec={version:1,name:'通道视图',columns:1,components:[]};
      if(type==='axes'){
        const chosen=meta.filter(ch=>/陀螺|角速度|gyro/i.test(ch.name)).slice(0,3);
        if(chosen.length!==3)throw Error('需要三路角速度通道，请先连接或选择趋势图模板手动绑定');
        spec.name='三轴角速度';spec.columns=2;
        spec.components.push({type:'trend',title:spec.name,channels:chosen.map(c=>c.id),span:2});
        for(const c of chosen)spec.components.push({type:'value',title:c.name,channels:[c.id]});
      }else{
        const def=catalog().components.find(c=>c.type===type);
        spec.name=def.label;spec.components.push({type,title:def.label,channels:meta.slice(0,Math.min(def.maxChannels,3)).map(ch=>ch.id)});
      }
      return spec;
    }
    function legacyDialog(raw){
      dialog('旧格式视图',el('p','','可导出原始内容，或用原生模板重新绑定通道并预览。'),[
        button('导出原始内容',()=>download(raw,'旧版视图')),button('从模板迁移',()=>editor(template('trend')))]);
    }
    function editor(raw,editId){
      const spec=structuredClone(api.validate(raw));
      const body=el('div','nv-editor'),props=el('div','nv-properties'),screen=el('div','nv-preview'),status=el('p','nv-status');
      const field=(parent,name,control)=>{const l=el('label','nv-field');l.append(el('span','',name),control);parent.append(l);};
      function repaint(){
        preview?.dispose();preview=null;
        try{preview=api.mount(screen,spec,mainSource());checkBindings(spec);status.textContent='当前工作区数据';}
        catch(e){status.textContent=e.message;}
      }
      function select(options,value,change){
        const s=el('select','dlg-input');for(const [id,label] of options){const o=el('option','',label);o.value=id;s.append(o);}
        s.value=value;s.onchange=()=>change(s.value);return s;
      }
      function input(value,change){const n=el('input','dlg-input');n.value=value;n.maxLength=100;n.oninput=()=>change(n.value);return n;}
      function build(){
        props.replaceChildren();field(props,'视图名称',input(spec.name,v=>{spec.name=v;repaint();}));
        field(props,'布局',select([[1,'单列'],[2,'双列']],spec.columns,v=>{spec.columns=Number(v);for(const c of spec.components)c.span=Math.min(c.span,spec.columns);build();repaint();}));
        for(const [i,c] of spec.components.entries()){
          const def=catalog().components.find(x=>x.type===c.type);
          const row=el('fieldset');row.append(el('legend','',def.label));
          field(row,'标题',input(c.title,v=>{c.title=v;repaint();}));
          const channels=host.channels(),choices=el('select','dlg-input');choices.multiple=def.maxChannels>1;
          const missing=c.channels.filter(id=>!channels.some(ch=>ch.id===id));
          for(const ch of channels.concat(missing.map(id=>({id,name:'缺失 · '+id})))){
            const o=el('option','',ch.name+(ch.unit?' ('+ch.unit+')':''));o.value=ch.id;o.selected=c.channels.includes(ch.id);choices.append(o);
          }
          choices.onchange=()=>{c.channels=Array.from(choices.selectedOptions,o=>o.value);repaint();};field(row,'绑定通道',choices);
          field(row,'颜色',select([['channel','跟随通道'],['accent','强调'],['warning','警告']],c.color,v=>{c.color=v;repaint();}));
          if(spec.columns===2)field(row,'宽度',select([[1,'一列'],[2,'跨两列']],c.span,v=>{c.span=+v;repaint();}));
          if(def.fields.includes('normalize'))field(row,'纵轴',select([['0','按单位分轨'],['1','每路归一化']],c.normalize?'1':'0',v=>{c.normalize=v==='1';repaint();}));
          if(i>0)row.append(button('上移',()=>{[spec.components[i-1],spec.components[i]]=[c,spec.components[i-1]];build();repaint();}));
          if(spec.components.length>1)row.append(button('移除组件',()=>{spec.components.splice(i,1);build();repaint();}));
          props.append(row);
        }
        if(spec.components.length<12)for(const def of catalog().components)props.append(button('+ '+def.label,()=>{
          const c=template(def.type).components[0];spec.components.push(api.validate({...spec,components:[c]}).components[0]);build();repaint();
        }));
      }
      body.append(props,status,screen);build();
      dialog('编辑与预览',body,[button('取消',host.close),button('导出规格',()=>download(api.validate(spec),spec.name)),
        button('保存并添加到当前图页',()=>{try{const d=prepare(spec);apply({...d,requestId:uid()},editId);host.close();host.toast('视图已保存');}catch(e){status.textContent=e.message;}},'btn-primary')]);
      repaint();
    }
    function open(){
      const body=el('div','nv-start'),prompt=el('textarea','dlg-textarea'),note=el('p','nv-status'),templates=el('div','dlg-chips');
      prompt.placeholder='例如：上面画三轴角速度趋势，下面显示三个当前值';
      prompt.id='awPrompt';
      for(const d of catalog().components)templates.append(button(d.label,()=>editor(template(d.type)),'dlg-chip'));
      templates.append(button('三轴趋势与读数',()=>editor(template('axes')),'dlg-chip'));
      const file=el('input');file.type='file';file.accept='.json,application/json';
      file.onchange=async()=>{try{
        const f=file.files[0];if(!f)return;if(f.size>131072)throw Error('文件超过 128 KB');
        const data=JSON.parse(await f.text());if(typeof data?.code==='string'){legacyDialog(data);return;}editor(data);
      }catch(e){note.textContent=e.message;}};
      body.append(prompt,el('p','','使用模板'),templates,el('p','','导入视图规格'),file,note);
      const generate=button('AI 生成',async()=>{
        const serial=generation;generate.disabled=true;
        try{
          const chat=window.XHGCS_DESKTOP?.aiChat;if(!chat?.generateView)throw Error('请在桌面版配置支持内置对话的 Agent，或使用模板');
          if(!prompt.value.trim())throw Error('请描述要生成的视图');
          const base=['只返回一个 ViewSpec v1 JSON 对象，使用实际通道 ID。不要调用工具。无法表示时返回 {"unsupported":"缺少的组件名称和原因"}。',
            JSON.stringify(catalog()),JSON.stringify(host.channels()),prompt.value].join('\n');
          let next=base;
          for(let i=0;i<2;i++){
            note.textContent=i?'正在修正规格…':'正在生成规格…';
            const text=await chat.generateView(next);if(serial!==generation)return;
            let spec;
            try{
              const raw=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'));
              if(typeof raw?.unsupported==='string' && Object.keys(raw).length===1){
                note.textContent='当前组件目录无法生成此视图 · '+raw.unsupported.slice(0,250);return;
              }
              spec=validateDraft(raw);
            }
            catch(e){if(i)throw e;next=base+'\n上次输出：'+text.slice(0,12000)+'\n请修复：'+e.message;continue;}
            editor(spec);return;
          }
        }catch(e){note.textContent=e.message;}finally{generate.disabled=false;}
      },'btn-primary');
      dialog('自定义控件',body,[button('取消',host.close),generate]);
    }
    function handle(type,args){
      if(type==='view_components')return {...catalog(),channels:host.channels(),workspaceId:host.workspace(),pageId:currentPage()};
      if(type==='view_preview')return prepare(args.spec,args.pageId||currentPage());
      if(type==='view_apply')return apply(args);
      throw Error('未知视图操作');
    }
    cards();
    return {open,cleanup,tick,refresh,handle,editor,stats:()=>({instances:live.size,preview:Boolean(preview)})};
  }
  window.createXuanjiViewHost=create;
})();
