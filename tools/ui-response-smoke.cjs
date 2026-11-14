'use strict';
const assert = require('node:assert/strict');
const {once} = require('node:events');
const path = require('node:path');
const {chromium} = require('playwright');
const {createStaticServer} = require('../electron/static-server');
(async()=>{
  const server=createStaticServer(path.resolve(__dirname,'..')); server.listen(0,'127.0.0.1');await once(server,'listening');
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1360,height:850}});
    await page.route(/http:\/\/(?:localhost|127\.0\.0\.1):8787\//,r=>r.abort());
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const key='xhgcs.pro.config.v1';
      if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({
        channels:Array.from({length:64},(_,i)=>({id:'ch'+i,name:'温度 '+i,unit:'°C',visible:true,range:[0,100]})),
        simulation:{enabled:true},mcp:{enabled:false}
      }));
      const clear=CanvasRenderingContext2D.prototype.clearRect;
      window.hiddenDraws=0;
      CanvasRenderingContext2D.prototype.clearRect=function(...args){
        if(this.canvas.id==='scope' && !this.canvas.offsetWidth)window.hiddenDraws++;
        return clear.apply(this,args);
      };
    });
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.XHGCS_SHELL && window.__xhWB);
    const results=await page.evaluate(async()=>{
      const X=window.XHGCS, wait=ms=>new Promise(r=>setTimeout(r,ms));
      const bootSim=X.state.simulation.enabled;
      const start=X.state.t;await wait(500);const sourceAdvanced=X.state.t>start;
      // 基线同样停用模拟数据，使两次测量使用相同的离线负载。
      if(bootSim)X.setSimulationEnabled(false);
      for(let i=0;i<4;i++)document.querySelector('#addPageSide').click();
      await wait(400);
      const initRow=document.querySelector('#chList .ch-row');
      const times=[];
      for(let i=0;i<32;i++){
        const tabs=document.querySelectorAll('#ptabs .ptab-main');
        const t=performance.now();tabs[i%tabs.length].click();
        void document.querySelector('#canvasView').offsetWidth;
        times.push(performance.now()-t);await new Promise(requestAnimationFrame);
      }
      const rowPreserved=initRow===document.querySelector('#chList .ch-row');
      const idle={hiddenScope:0,readoutMutations:0,toolbarMutations:0};
      const obs=new MutationObserver(records=>{idle.readoutMutations+=records.length;});
      obs.observe(document.querySelector('#chList'),{childList:true,subtree:true,characterData:true});
      const toolObserver=new MutationObserver(records=>{idle.toolbarMutations+=records.length;});
      toolObserver.observe(document.querySelector('#canvasView').shadowRoot.querySelector('#pause'),{subtree:true,childList:true});
      window.hiddenDraws=0;await wait(1500);idle.hiddenScope=window.hiddenDraws;obs.disconnect();toolObserver.disconnect();
      const selected=document.querySelectorAll('#ptabs .ptab.active').length;
      const ch=X.state.channels[0];
      X.injectRealValues({[ch.id]:17.25});
      await wait(250);
      const label=document.querySelector('#chList [data-val="'+ch.id+'"]').textContent;
      times.sort((a,b)=>a-b);return {bootSim,sourceAdvanced,rowPreserved,idle,selected,label,channels:X.state.channels.length,
        switchMedianMs:times[16],switchP95Ms:times[30]};
    });
    console.log(JSON.stringify(results,null,2));assert.deepEqual(errors,[]);
    if(!process.argv.includes('--baseline')){
      assert.equal(results.bootSim,false);
      assert.equal(results.sourceAdvanced,false);
      assert.equal(results.rowPreserved,true);
      assert.equal(results.selected,1);
      assert.equal(results.idle.hiddenScope,0);
      assert.equal(results.idle.toolbarMutations,0);
      assert.equal(results.idle.readoutMutations,0);
      assert.match(results.label,/17/);
    }
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
