'use strict';
// NODE_PATH 可指向已有开发依赖。--real-agent 启用真实 DSH 模型验收。
const assert=require('node:assert/strict'), path=require('node:path'), os=require('node:os');
const fs=require('node:fs/promises'), net=require('node:net'), crypto=require('node:crypto');
const {spawn}=require('node:child_process'), {once}=require('node:events'), readline=require('node:readline');
const {setTimeout:sleep}=require('node:timers/promises');
const {chromium}=require('playwright');
const {createStaticServer}=require('../electron/static-server');
const {createAiTaskService}=require('../electron/ai/task-service');
const root=path.resolve(__dirname,'..');
async function main(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'xuanji-spec-'));
  const server=createStaticServer(root);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port, socket=net.createServer();
  socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const endpoint='http://127.0.0.1:'+port,token=crypto.randomUUID(),instanceId=crypto.randomUUID();
  const env={...process.env,XHGCS_BRIDGE_PORT:String(port),XHGCS_BRIDGE_TOKEN:token,XHGCS_INSTANCE_ID:instanceId,
    XHGCS_WORKSPACE_ID:'fixture',XHGCS_INSTANCE_FILE:path.join(temp,'instance.json'),XHGCS_ALLOWED_ORIGINS:origin,XHGCS_MCP_WRITE:'1'};
  const proc=(script,args)=>spawn(process.execPath,[path.join(root,'mcp-server',script),...args],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const bridge=proc('bridge.mjs',[]);let proxy,browser,service;
  try {
    await once(bridge.stderr,'data',{signal:AbortSignal.timeout(5000)});
    const health=await(await fetch(endpoint+'/api/health')).json();assert.equal(health.pid,bridge.pid);
    await fs.writeFile(env.XHGCS_INSTANCE_FILE,JSON.stringify({pid:bridge.pid,bridgePort:port,bridgeToken:token,instanceId}));
    proxy=proc('launcher.mjs',['--stdio']);const waiting=new Map();let seq=0;
    readline.createInterface({input:proxy.stdout}).on('line',l=>{const m=JSON.parse(l);waiting.get(m.id)?.(m);});
    function rpc(method,params){const id=++seq;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(id);reject(Error('stdio timeout: '+method));},15000);
      waiting.set(id,msg=>{clearTimeout(timer);waiting.delete(id);resolve(msg);});
      proxy.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });}
    async function tool(name,args){const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.result?.isError,false,JSON.stringify(r));return JSON.parse(r.result.content[0].text);}
    browser=await chromium.launch({headless:true,channel:'msedge'});
    const context=await browser.newContext({viewport:{width:1300,height:810},deviceScaleFactor:2});
    const page=await context.newPage();page.setDefaultTimeout(7000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let replies=[],real=false;
    await page.exposeFunction('draft',async prompt=>{
      if(real)return service.generateView(prompt);
      assert.ok(replies.length,'unexpected extra model call');return replies.shift();
    });
    await page.addInitScript(({endpoint,token})=>{
      const key='xhgcs.pro.config.v1',cfg=JSON.parse(localStorage.getItem(key)||'{}');
      if(!cfg.channels)cfg.channels=['X','Y','Z'].map(k=>({id:'gyro'+k,name:'陀螺仪 '+k,unit:'rad/s',range:[-5,5],visible:true}));
      cfg.mcp={enabled:true,endpoint};localStorage.setItem(key,JSON.stringify(cfg));
      window.XHGCS_DESKTOP={ai:{token:async()=>token,bridge:async()=>({instance:{workspaceId:'fixture'}})},
        aiChat:{generateView:p=>window.draft(p),status:async()=>({}),onEvent:()=>()=>{}}};
    },{endpoint,token});
    await page.goto(origin);await page.waitForFunction(()=>window.XHGCS_SHELL?.nativeViewStats);
    const open=()=>page.locator('#addWidgetBtn').evaluate(n=>n.click());
    const save=()=>page.getByRole('button',{name:'保存并添加到当前图页'}).click();
    await open();await page.getByRole('button',{name:'三轴趋势与读数',exact:true}).click();
    assert.equal(await page.locator('.nv-preview .nv-panel').count(),4);
    assert.equal(await page.getByRole('button',{name:/示例数据/}).count(),0);
    assert.equal(await page.locator('.nv-status').textContent(),'当前工作区数据');
    await save();await page.waitForSelector('.nv-window:visible');await page.reload();
    await page.waitForSelector('.nv-window:visible');assert.equal(await page.locator('.nv-window .nv-panel').count(),4);
    await page.locator('.nv-window').getByText('编辑',{exact:true}).click();
    await page.locator('.nv-field').filter({has:page.getByText('视图名称',{exact:true})}).locator('input').fill('三轴记录');
    await save();assert.equal(await page.locator('.nv-window .nv-head b').textContent(),'三轴记录');
    console.log('PASS 模板 → 真实预览 → 编辑 → 保存、重载');
    const spec={version:1,name:'Agent 视图',columns:1,components:[{type:'value',title:'X',channels:['gyroX']}]};
    async function generate(text){await open();await page.locator('#awPrompt').fill(text);await page.getByRole('button',{name:'AI 生成',exact:true}).evaluate(n=>n.click());}
    replies=[JSON.stringify({...spec,code:'alert(1)'}),JSON.stringify(spec)];
    await generate('显示角速度 X');await page.waitForSelector('.nv-preview');await save();assert.equal(replies.length,0);
    replies=['{"html":"<script>"}','{"version":8}'];await generate('安全验证');
    await page.waitForFunction(()=>document.querySelector('.nv-status')?.textContent.includes('version'));
    assert.equal(await page.locator('#awPrompt').inputValue(),'安全验证');await page.getByRole('button',{name:'取消',exact:true}).last().click();
    console.log('PASS 模型规格校验、一次修复及失败保留需求');
    if(process.argv.includes('--real-agent')){
      service=createAiTaskService({userData:temp,rootDir:root,execPath:process.execPath,packaged:true,
        resourcesPath:process.env.XUANJI_RESOURCES||path.resolve(root,'../Xuanji/resources')});
      real=true;await generate('把陀螺仪 X、Y、Z 放在一张趋势图，下方放三个显示原始单位的数值卡。');
      await page.waitForFunction(()=>document.querySelector('.nv-preview')||
        (!document.querySelector('#awPrompt')?.closest('#dlg')?.querySelector('.btn-primary')?.disabled && document.querySelector('.nv-status')?.textContent),
        null,{timeout:300000});
      assert.equal(await page.locator('.nv-preview .nv-panel').count(),4,await page.locator('.nv-status').textContent());
      await save();
      const generated=await page.evaluate(()=>JSON.parse(localStorage.getItem('xuanji.ui10.views.v1')).defs.at(-1).spec);
      const trend=generated.components.filter(c=>c.type==='trend'),values=generated.components.filter(c=>c.type==='value');
      assert.equal(trend.length,1);assert.deepEqual([...trend[0].channels].sort(),['gyroX','gyroY','gyroZ']);
      assert.deepEqual(values.flatMap(v=>v.channels).sort(),['gyroX','gyroY','gyroZ']);
      real=false;console.log('PASS 真实 DSH/ACP → UI10 生成并保存三轴视图');
    }
    const list=(await rpc('tools/list')).result.tools.map(t=>t.name);
    assert.ok(list.includes('apply_view_spec')&&!list.includes('create_view'));
    const info=await tool('list_view_components',{});assert.equal(info.components.length,4);
    assert.equal((await tool('preview_view_spec',{spec:{...spec,html:'<img>'}})).ok,false);
    const draft=await tool('preview_view_spec',{spec});
    assert.ok(draft.draftId);const payload={...draft,requestId:crypto.randomUUID()};
    let dropped=false;
    await page.route('**/api/ack',async route=>{if(!dropped){dropped=true;return route.abort();}return route.continue();});
    const before=await page.locator('.nv-window').count(),applied=await tool('apply_view_spec',payload);
    assert.equal(applied.applied,true,JSON.stringify(applied));assert.ok(dropped);
    assert.equal((await tool('apply_view_spec',payload)).instanceId,applied.instanceId);
    assert.equal(await page.locator('.nv-window').count(),before+1);await page.unroute('**/api/ack');
    assert.equal((await tool('apply_view_spec',{...payload,workspaceId:'other'})).ok,false);
    console.log('PASS stdio MCP → UI10，丢 ACK 和重试只创建一个实例');
    await open();const file=page.locator('#dlgBody input[type=file]');
    await file.setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...spec,style:'x'}))});
    await page.waitForFunction(()=>document.querySelector('.nv-status')?.textContent.includes('style'));
    await file.setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({code:'throw Error()'}))});
    await page.getByRole('button',{name:'导出原始内容'}).waitFor();await page.keyboard.press('Escape');
    await page.evaluate(()=>{const key='xuanji.ui10.views.v1',s=JSON.parse(localStorage.getItem(key));s.defs.push({id:'bad',spec:{code:'alert(1)'}});localStorage.setItem(key,JSON.stringify(s));});
    await page.reload();await page.waitForSelector('.nv-window');assert.equal(await page.getByText('待修复 · 导出',{exact:true}).count(),1);
    console.log('PASS 文件导入及存档恢复拒绝脚本，旧格式可导出');
    const polarity=await page.locator('html').getAttribute('data-theme-pol');
    const panelColor=()=>page.locator('.nv-panel').first().evaluate(n=>getComputedStyle(n).backgroundColor);
    const initialColor=await panelColor();await page.locator('#themeBtn').evaluate(n=>n.click());
    await page.waitForFunction(p=>document.documentElement.dataset.themePol!==p,polarity);
    assert.notEqual(await panelColor(),initialColor);
    const replay=require('../tests/fixtures/native-view-replay.json').samples;
    const metrics=await page.evaluate(async ({spec,replay})=>{
      const V=window.XuanjiViewV1, box=document.createElement('div');box.className='nv-preview';document.body.append(box);
      box.style.width='230px';const points=[{t:0,v:1},{t:.1,v:2},{t:.2,v:9,valid:false},{t:2,v:3},{t:2.1,v:4}];
      let ch={name:'原名',unit:'rad/s',points,latest:null,color:'currentColor'},render;
      const source={channel:()=>ch,palette:()=>({ink:'black',ink2:'black',grid:'gray',amber:'orange',warn:'red'})};
      const s={...spec,columns:2,components:[{type:'trend',channels:['gyroX'],title:'趋势',span:2},...spec.components]};
      let moves=0;const proto=CanvasRenderingContext2D.prototype,old=proto.moveTo;
      proto.moveTo=function(...args){if(this.canvas.closest('.nv-preview')===box)moves++;return old.apply(this,args);};
      try{render=V.mount(box,s,source);if(moves!==2)throw Error('曲线没有按缺口断线');
        if(box.querySelector('output').textContent!=='—')throw Error('无效读数');
        ch={...ch,name:'改名',latest:4};render.update();if(!box.textContent.includes('改名')||!box.textContent.includes('4 rad/s'))throw Error('绑定/单位错误');
        const cv=box.querySelector('canvas');if(cv.width!==cv.clientWidth*devicePixelRatio||box.scrollWidth>box.clientWidth)throw Error('DPR/窄宽度溢出');
        ch=null;render.update();if(!box.textContent.includes('通道缺失'))throw Error('缺失绑定没有提示');
      }finally{proto.moveTo=old;render?.dispose();}
      const times=[],recorded=replay.map(([t,v])=>({t,v,valid:true,gapLimit:.5}));
      ch={name:'roll_vel',unit:'',points:recorded,latest:recorded.at(-1).v};
      let listeners=0,scheduled=0;
      const eventTarget=EventTarget.prototype,add=eventTarget.addEventListener,raf=window.requestAnimationFrame;
      eventTarget.addEventListener=function(...args){listeners++;return add.apply(this,args);};
      window.requestAnimationFrame=function(...args){scheduled++;return raf.apply(this,args);};
      try {
      for(const input of [s,JSON.parse(JSON.stringify(s))]){
        const clock=performance.now();
        for(let i=0;i<50;i++){const view=V.mount(box,input,source);view.update();view.dispose();}
        times.push(performance.now()-clock);
      }
      } finally { eventTarget.addEventListener=add;window.requestAnimationFrame=raf; }
      if(box.childNodes.length || listeners || scheduled)throw Error('卸载后仍有节点，或组件新增订阅/帧任务');
      box.remove();return times;
    },{spec,replay});
    console.log('PASS 缺口、无效样本、改名/缺失、深浅主题、窄屏 2x DPR；128 点台架回放，同规格模板/JSON 各 50 次挂载绘制卸载 ms',metrics.map(n=>n.toFixed(1)));
    assert.deepEqual(errors,[]);console.log('PASS UI10 无未捕获异常');
  } finally {
    service?.dispose();await browser?.close();for(const p of [proxy,bridge])if(p && p.exitCode===null){const closed=once(p,'close');p.kill();await closed;}
    await new Promise(r=>server.close(r));
    await fs.rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:300}).catch(err=>{
      console.error('临时测试目录清理失败',temp,err.code);
      process.exitCode=1;
    });
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
