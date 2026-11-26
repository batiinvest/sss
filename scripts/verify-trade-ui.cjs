// Optional isolated UI check: PLAYWRIGHT_MODULE points to an installed playwright package.
// Uses a temporary, empty browser profile and a fake backend; never writes production data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function fixture() {
  const member = { id:'m', name:'테스트 담당자', email:'test@example.com', is_active:true, base_amount:500000 };
  const stock = { stock_name:'삼성전자', stock_code:'005930', market:'KOSPI', price:70000, change_rate:0, market_cap:4000000 };
  const state = window.testState = { members:[member], stock_prices:[stock], trades:[], picks:[], calls:[] };
  const session = { user:{id:'test-user', email:member.email} };
  const client = {
    auth: { getSession:async()=>({data:{session}}), onAuthStateChange(){} },
    from(table) {
      const filters=[]; let single=false, mutation=null;
      const q = {
        select(){return this;}, order(){return this;}, limit(){return this;}, or(){return this;},
        gt(k,v){filters.push(r=>r[k]>v);return this;}, lt(k,v){filters.push(r=>r[k]<v);return this;},
        eq(k,v){filters.push(r=>r[k]===v);return this;}, in(k,values){filters.push(r=>values.includes(r[k]));return this;},
        maybeSingle(){single=true;return this;}, single(){single=true;return this;},
        insert(value){mutation={type:'insert',value};return this;}, update(value){mutation={type:'update',value};return this;},
        then(resolve,reject){return Promise.resolve().then(()=>{
          if(mutation){
            if(table!=='picks') throw Error('unexpected direct financial write');
            if(mutation.type==='insert') state.picks.push({...mutation.value,id:'idea-'+(state.picks.length+1)});
            else state.picks.filter(r=>filters.every(fn=>fn(r))).forEach(r=>Object.assign(r,mutation.value));
          }
          let rows = table==='investment_ideas' ? state.picks.map(p=>({...p,pick_id:p.id,status:'idea',member_name:member.name}))
            : table==='trade_positions' ? state.trades.length ? [{id:'position',pick_id:'position',member_id:member.id,member_name:member.name,...stock,status:'hold',month:'2026-11'}] : []
            : state[table] || [];
          rows=rows.filter(r=>filters.every(fn=>fn(r)));
          return {data:single?rows[0]||null:rows,error:null};
        }).then(resolve,reject);}
      };return q;
    },
    async rpc(name,args){
      if(name==='sss_corporate_actions_version') return {data:1};
      if(name==='sss_corporate_actions_list') return {data:[]};
      if(name==='sss_corporate_positions') {
        const quantity=state.trades.reduce((sum,t)=>sum+(t.trade_type==='buy'?1:-1)*t.quantity,0);
        return {data:args.p_pick_ids.includes('position')?[{pick_id:'position',quantity,tradableQuantity:quantity,averagePrice:18030,pendingQuantity:0,history:[],sales:[]}]:[]};
      }
      if(name==='sss_submit_trade'){
        state.calls.push(args);
        const row={...args.p_trade,pick_id:'position',id:'t'+state.calls.length,members:{name:member.name}};
        state.trades.unshift(row);return {data:row};
      }
      throw Error('unexpected RPC '+name);
    }
  };
  window.supabase={createClient:()=>client};
}
(async()=>{
  const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const width of [1700,900,390,360]){
      const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Seoul'});
      await context.addInitScript(fixture);
      await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.fulfill({body:'',contentType:'text/javascript'}));
      const page=await context.newPage(), errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('dialog',d=>d.accept());
      await page.goto(base+'/trade.html');
      await page.waitForFunction(()=>document.getElementById('buy-member').value==='m');
      if(width>768){
        const buy=await page.locator('#buyFormCard').boundingBox(),sell=await page.locator('#sellFormCard').boundingBox();
        assert.ok(Math.abs(buy.width-sell.width)<2,'buy/sell cards have equal widths');
        const buyPrice=await page.locator('#buy-price').boundingBox(),sellPrice=await page.locator('#sell-price').boundingBox();
        assert.ok(Math.abs(buyPrice.y-sellPrice.y)<2,'execution rows align');
        const buySave=await page.locator('#buySubmitBtn').boundingBox(),sellSave=await page.locator('#sellSubmitBtn').boundingBox();
        assert.ok(Math.abs(buySave.y-sellSave.y)<2,'save buttons align');
      }
      await page.fill('#buy-qty','22');
      await page.click('#buyExistingMode');
      assert.equal(await page.locator('#buy-stock').isVisible(),false);
      assert.equal(await page.locator('#buy-pick').isVisible(),true);
      assert.equal(await page.locator('#buy-qty').inputValue(),'22');
      await page.click('#buySearchMode');
      await page.fill('#buy-stock','삼성');
      await page.locator('#buy-stock-results .dd-item').click();
      await page.fill('#buy-price','18030');
      await page.fill('#buy-qty','22');
      assert.match(await page.locator('#buyAmount').textContent(),/396,660/);
      await page.screenshot({path:path.join(root,`reports/trade-${width}.png`),fullPage:true});
      await page.click('#buySubmitBtn');
      await page.waitForFunction(()=>window.testState.calls.length===1 && !document.getElementById('buySubmitBtn').disabled);
      let state=await page.evaluate(()=>window.testState);
      assert.equal(state.calls[0].p_trade.quantity,22);
      assert.equal(state.calls[0].p_trade.stock_code,'005930');
      assert.equal(state.picks.length,0);
      await page.click('#buyExistingMode');
      await page.selectOption('#buy-pick','position');
      assert.equal(await page.locator('#buy-pick').inputValue(),'position');
      if(width<=768) await page.click('#mobileSellTab');
      await page.selectOption('#sell-pick','position');
      await page.waitForFunction(()=>document.getElementById('sellAvailable').textContent.includes('22주'));
      await page.fill('#sell-price','25350');await page.fill('#sell-qty','5');
      assert.match(await page.locator('#sellAmount').textContent(),/126,750/);
      await page.click('#sellSubmitBtn');
      await page.waitForFunction(()=>window.testState.calls.length===2 && !document.getElementById('sellSubmitBtn').disabled);
      state=await page.evaluate(()=>window.testState);
      assert.equal(state.calls[1].p_trade.position_id,'position');
      assert.equal(state.calls[1].p_trade.quantity,5);
      assert.ok(await page.locator('#sellAvailable').textContent().then(t=>t.includes('17주')));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));

      await page.goto(base+'/top-picks.html');
      await page.locator('#newIdea').click();
      await page.fill('#pick-input','삼성');
      await page.locator('#pick-dd .dd-item').click();
      await page.fill('#pick-buy-price','70000');
      await page.fill('#pick-tgt-price','90000');
      await page.fill('#pick-reason','2027년 실적 회복 전망');
      await page.click('#pick-submit-btn');
      await page.waitForFunction(()=>window.testState.picks.length===1 && document.getElementById('pickModal').style.display==='none');
      assert.match(await page.locator('#ideaList').textContent(),/2027년 실적 회복 전망/);
      assert.equal(await page.evaluate(()=>window.testState.trades.length),0);
      await page.screenshot({path:path.join(root,`reports/top-picks-${width}.png`),fullPage:true});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`PASS ${width}px: independent buy 22, sell 5, top-pick save, no overflow or script errors`);
    }
  } finally {if(browser) await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
