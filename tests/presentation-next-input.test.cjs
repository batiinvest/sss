const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const members = Array.from({length:8},(_,i)=>({id:String(i+1),name:i===3?'김정훈':`회원${i+1}`}));
const schedules = [
  ...['2026-09-07','2026-09-21','2026-10-19'].map((event_date,i)=>({id:`past-${i}`,event_date,category:'stock'})),
  {id:'next',event_date:'2026-11-30',category:'industry'},
];
const old = {id:'old',member_id:'4',schedule_id:'past-2',presented_at:'2026-10-19',status:'done',category:'industry',topic:'화장품 > 원익IPS'};

test('a prior company completion cannot count as completed in a new industry turn', () => {
  const context = vm.createContext({console,Date,Map,Set});
  vm.runInContext(fs.readFileSync(path.join(root,'js/schedule-shared.js'),'utf8'),context);
  const result = context.getCurrentCycleCompletedPresentations(schedules,[old],members,{
    fromDate:'2026-10-28',category:'industry',cycleState:{cycleMarker:'2026-09-21'},
  });
  assert.equal(result.length,0);
  // Even a stale marker cannot keep a previous same-category turn completed.
  const pastIndustry = schedules.map(s=>s.id==='next'?s:{...s,category:'industry'});
  assert.equal(context.getCurrentCycleCompletedPresentations(pastIndustry,[old],members,{
    fromDate:'2026-10-28',category:'industry',cycleState:{cycleMarker:'initial'},
  }).length,0);
  assert.equal(old.status,'done');
});

test('a scheduled next presentation retains its input and date selector despite an old completion', () => {
  const elements=[];
  function node(tag) {
    const value={tag,children:[],style:{},dataset:{},attributes:{},
      setAttribute(k,v){this.attributes[k]=v;},appendChild(v){this.children.push(v);},
      append(...items){this.children.push(...items);},querySelectorAll(){return [];},addEventListener(){},
    };
    elements.push(value); return value;
  }
  const panel=node('panel');
  const item={schedule:schedules.at(-1),memberIds:['4'],members:[members[3]]};
  const plan={items:[item]};
  const context=vm.createContext({
    console,Date,Map,Set,document:{getElementById:()=>panel,createElement:node},
    members:[members[3]],presOrder:['4'],schedules,presentations:[old],
    presentationOrderSaving:false,presentationSetupReady:true,adminUser:true,presentationDraftEpoch:null,
    normalizePresentationOrder:m=>m,getAutomaticPresentationPlan:()=>plan,
    getVisiblePresentationPlanItem:()=>item,getMemberPresentationPlanItem:()=>item,
    getPresentationTurnState:()=>({category:'industry',completedThrough:'2026-10-19'}),
    getCurrentCycleCompletedPresentations:()=>[old],findCurrentPresentationDraft:()=>null,
    getPresentationRotationDate:p=>p.presented_at,toDateStr:()=> '2026-10-28',
    CAT_LABEL:{industry:'산업 분석'},escapeHtml:s=>s,bindStockSearch(){},
    renderLegacyDraftNotice(){},renderMyPresentationCard(){},renderRoundReadiness(){},
  });
  const html=fs.readFileSync(path.join(root,'schedule-order.html'),'utf8').replace(/\r\n/g,'\n');
  const start=html.indexOf('function renderMemberPresPanel()');
  // The next top-level section differs between the deployed and pending local versions.
  const end=html.indexOf('\n}\n',start)+3;
  vm.runInContext(html.slice(start,end),context);
  context.renderMemberPresPanel();
  const input=elements.find(el=>el.tag==='input' && el.dataset.memberId==='4');
  assert.ok(input,'김정훈 next input must remain visible');
  assert.equal(input.attributes['aria-label'],'김정훈 발표종목 검색');
  const select=elements.find(el=>el.tag==='select');
  assert.ok(select);
  assert.equal(select.children.find(el=>el.selected).value,'next');
  assert.ok(elements.some(el=>el.textContent?.includes('최근 발표 완료 · 2026-10-19')));
});
