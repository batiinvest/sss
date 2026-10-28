const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
function helpers(overrides = {}) {
  const context = vm.createContext({ console, Date, Map, Set, ...overrides });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/schedule-shared.js'), 'utf8'), context);
  return context;
}
const members = Array.from({length: 8}, (_, i) => ({id: String(i + 1), name: `Member ${i + 1}`, is_active: true}));
const payload = {category: 'industry', title: '산업 분석', event_date: '2026-11-02', event_time: '20:00'};
const opts = {today: '2026-10-28'};

test('industry cycle includes newcomers exactly once in saved order with a partial final session', () => {
  const h = helpers();
  const ordered = [members[2], members[0], members[1], ...members.slice(3), {id: 'inactive', is_active: false}];
  const plan = h.planStudyCycle([], payload, ordered, opts);
  assert.deepEqual(plain(plan.sessions.map(s => s.event_date)), ['2026-11-02', '2026-11-16', '2026-11-30']);
  assert.deepEqual(plain(plan.sessions.map(s => s.members.map(m => m.id))), [['3','1','2'],['4','5','6'],['7','8']]);
  assert.equal(plan.rowsToCreate.length, 3);
  assert.equal(h.planStudyCycle([], payload, members.slice(0,2), opts).sessions.length, 1);
  assert.equal(h.planStudyCycle([], payload, [...members, {id:'9'}, {id:'10'}], opts).sessions.length, 4);
  assert.throws(() => h.planStudyCycle([], payload, [], opts), /발표자/);
  assert.throws(() => h.planStudyCycle([], {...payload,event_date:'2026-10-27'}, members, opts), /오늘 이후/);
});

test('industry cycle blocks collisions and intervening presentation dates without changing existing schedules', () => {
  const h = helpers();
  const existing = [
    {id:'dinner',event_date:'2026-11-16',category:'dinner'},
    {id:'other-talk',event_date:'2026-11-09',category:'stock'},
  ];
  const before = JSON.stringify(existing);
  const plan = h.planStudyCycle(existing, payload, members, opts);
  assert.deepEqual(plain(plan.conflicts.map(c => c.event_date)), ['2026-11-16','2026-11-09']);
  assert.equal(JSON.stringify(existing), before);
});

test('industry rosters are persisted before schedule insertion and survive reload with other historical rotations', async () => {
  let saved;
  let counter = 0;
  const h = helpers({
    getConfigStrict: async () => ({unrelated:['99']}),
    setConfig: async (key, value) => { saved = plain(value); },
  });
  const plan = h.planStudyCycle([], payload, members, opts);
  const rows = await h.prepareStudyCycleRosters(plan, [], {createId: () => `new-${++counter}`});
  assert.deepEqual(saved, {unrelated:['99'],'new-1':['1','2','3'],'new-2':['4','5','6'],'new-3':['7','8']});
  assert.equal(rows.length, 3);
  const reloaded = helpers();
  const finalPlan = reloaded.buildPresentationSchedulePlan([
    {id:'past',event_date:'2026-10-05',category:'stock'}, ...plain(rows),
  ], [], members, {fromDate:'2026-10-28',manualRosters:saved});
  assert.deepEqual(plain(finalPlan.items.map(i => i.memberIds)), [['1','2','3'],['4','5','6'],['7','8']]);
});

test('industry retry reuses exact schedules and refuses to overwrite manual assignments or completed records', async () => {
  let writes = 0;
  let stored = {'existing':['1','2','3']};
  const h = helpers({getConfigStrict: async () => stored, setConfig: async () => {writes++;}});
  const existing = [{...payload,id:'existing'}];
  const plan = h.planStudyCycle(existing,payload,members.slice(0,3),opts);
  assert.equal((await h.prepareStudyCycleRosters(plan)).length, 0);
  assert.equal(writes, 1);
  stored = {'existing':['3','2','1']};
  await assert.rejects(h.prepareStudyCycleRosters(plan), /수동 발표 순서/);
  stored = {};
  await assert.rejects(h.prepareStudyCycleRosters(plan,[{schedule_id:'existing',member_id:'1',status:'done'}]), /다른 발표 기록/);
  assert.equal(writes, 1);
});

test('roster persistence failure prevents providing schedules for insertion', async () => {
  const h = helpers({getConfigStrict: async () => ({}),setConfig: async () => {throw new Error('write failed');}});
  const plan = h.planStudyCycle([],payload,members,opts);
  let counter = 0;
  await assert.rejects(h.prepareStudyCycleRosters(plan,[],{createId:()=> `new-${++counter}`}), /write failed/);
});

test('industry cycle form exposes start-date entry and preview and compiles', () => {
  const html = fs.readFileSync(path.join(root,'schedule-calendar.html'),'utf8');
  assert.match(html,/다음 스터디 시작<\/button>/);
  assert.match(html,/session\.members\.map\(member => escapeHtml\(member\.name\)\)/);
  assert.ok(html.indexOf('await prepareStudyCycleRosters(seriesPlan') < html.indexOf('await submitSchedules(seriesPlan.rowsToCreate)'));
  for (const [,script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script);
});

test('cycle generation alternates company to industry to company to industry from the chosen start date', () => {
  const h = helpers();
  const history = ['2026-09-07','2026-09-21','2026-10-19'].map((event_date,i) => ({
    id:`company-${i}`, category:'stock', event_date,
  }));
  const industry = h.planStudyCycle(history, payload, members, opts);
  assert.equal(industry.category, 'industry');
  const industryRows = plain(industry.rowsToCreate).map((row,i) => ({...row,id:`industry-${i}`}));
  const company = h.planStudyCycle([...history,...industryRows], {
    ...payload, event_date:'2026-12-14', category:'industry',
  }, members, opts);
  assert.equal(company.category, 'stock');
  assert.ok(company.rowsToCreate.every(row => row.category === 'stock' && row.title === '기업 분석'));
  assert.deepEqual(plain(company.sessions.map(s => s.members.map(m => m.id))), [['1','2','3'],['4','5','6'],['7','8']]);
  const companyRows = plain(company.rowsToCreate).map((row,i) => ({...row,id:`next-company-${i}`}));
  const next = h.planStudyCycle([...history,...industryRows,...companyRows], {
    ...payload,event_date:'2027-01-25',category:'stock',
  }, members, opts);
  assert.equal(next.category, 'industry');
  assert.ok(next.rowsToCreate.every(row => row.title === '산업 분석'));
  // Existing future sessions count toward the selected start date, not today's date.
  assert.equal(h.getNextStudyCycleState([...history,...industryRows], members, {startDate:'2026-12-14'}).category, 'stock');
  assert.throws(() => h.planStudyCycle([...history,...industryRows], {
    ...payload,event_date:'2026-11-23',
  }, members, opts), /아직 끝나지/);
});
