const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const people = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1) }));
const dates = ['2026-11-16', '2026-11-30', '2026-12-14'];
const rounds = dates.map((event_date, i) => ({ id: 'industry-' + i, category: 'industry', event_date }));
const allRounds = [...rounds,
  { id: 'company', category: 'stock', event_date: '2026-12-28' },
  { id: 'next-industry', category: 'industry', event_date: '2027-01-11' }];
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  vm.runInContext(read('js/schedule-shared.js'), ctx);
  return ctx;
}
function section(file, start, end) {
  const s = read(file); return s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
}

test('all three sessions inherit the existing outlook, without leaking to a later cycle', () => {
  const ctx = context();
  const config = new Map([[ctx.getPresentationIndustryConfigKey(rounds[0].id), '27년전망']]);
  for (const round of rounds) {
    const cycle = ctx.getPresentationIndustryCycle(round.id, allRounds, people);
    assert.deepEqual(plain(cycle.scheduleIds), rounds.map(row => row.id));
    assert.equal(ctx.resolvePresentationIndustryTitle(round, allRounds, [], people, config), '27년전망');
  }
  assert.equal(ctx.resolvePresentationIndustryTitle(allRounds.at(-1), allRounds, [], people, config), '');
  assert.equal(ctx.resolvePresentationIndustryTitle(allRounds[3], allRounds, [], people, config), '');
});

test('topic inference recovers first-session data and cycle identity survives completed sessions', () => {
  const ctx = context();
  const rows = [{ schedule_id: rounds[0].id, category: 'industry', status: 'done', topic: '27년전망 > [자유 주제] 클라우드' }];
  const keys = rounds.map(round => ctx.getPresentationIndustryCycle(round.id, allRounds, people).key);
  assert.equal(new Set(keys).size, 1);
  for (const round of rounds) assert.equal(ctx.resolvePresentationIndustryTitle(round, allRounds, rows, people, new Map()), '27년전망');
  assert.equal(ctx.resolvePresentationIndustryTitle(allRounds.at(-1), allRounds, rows, people, new Map()), '');
});

test('same-category following turns and non-talk events do not merge cycles', () => {
  const ctx = context();
  const schedules = [...rounds, { id: 'dinner', category: 'dinner', event_date: '2026-11-20' },
    { id: 'second-cycle', category: 'industry', event_date: '2026-12-28' }];
  assert.deepEqual(plain(ctx.getPresentationIndustryCycle(rounds[1].id, schedules, people).scheduleIds), rounds.map(row => row.id));
  assert.deepEqual(plain(ctx.getPresentationIndustryCycle('second-cycle', schedules, people).scheduleIds), ['second-cycle']);
});

test('moving presenters between sessions retains the cycle with an empty first session', () => {
  const ctx = context();
  const manualRosters = { 'industry-0': [], 'industry-1': ['1', '2', '3', '4'], 'industry-2': ['5', '6', '7', '8'] };
  assert.deepEqual(plain(ctx.getPresentationIndustryCycle(rounds[2].id, allRounds, people, { manualRosters }).scheduleIds), rounds.map(row => row.id));
});

test('explicit cycle topic overrides old date labels; ambiguous legacy topics are not guessed', () => {
  const ctx = context();
  const configs = new Map(rounds.slice(0, 2).map((round, i) => [ctx.getPresentationIndustryConfigKey(round.id), ['반도체', '로봇'][i]]));
  assert.equal(ctx.resolvePresentationIndustryTitle(rounds[2], allRounds, [], people, configs), '');
  assert.equal(ctx.resolvePresentationIndustryTitle(rounds[0], allRounds, [], people, configs), '반도체');
  configs.set(ctx.getPresentationIndustryCycle(rounds[0].id, allRounds, people).key, '27년전망');
  for (const round of rounds) assert.equal(ctx.resolvePresentationIndustryTitle(round, allRounds, [], people, configs), '27년전망');
});

test('saving a cycle updates each planned topic and retains each format and individual subject', async () => {
  const writes = [], configWrites = [];
  const rows = rounds.map((round, i) => ({ id: String(i), category: 'industry', status: 'planned', schedule_id: round.id,
    topic: ['구주제 > [자유 주제] 클라우드', '[자유 주제] 로봇', '삼성전자'][i] }));
  rows.push({ id: 'other', category: 'industry', status: 'planned', schedule_id: 'next-industry', topic: '다른 주제 > 원익IPS' });
  const ctx = context({ inputRows: rows, industrySaveToken: 1, presOrder: [],
    document: { getElementById: () => null }, setConfig: async (key, name) => configWrites.push([key, name]),
    sb: { from: () => ({ update: payload => ({ eq: async (_, id) => { writes.push([id, payload]); return { error: null }; } }) }) },
  });
  vm.runInContext('presentations = inputRows;', ctx);
  vm.runInContext(section('schedule-order.html', 'async function persistTurnIndustryName', 'async function ensureIndustryNameSaved'), ctx);
  const cycle = ctx.getPresentationIndustryCycle(rounds[1].id, allRounds, people);
  assert.equal(await ctx.persistTurnIndustryName({ key: cycle.key, name: '27년전망', scheduleId: rounds[1].id,
    scheduleIds: cycle.scheduleIds, requestToken: 1, opts: { silent: true } }), true);
  assert.deepEqual(configWrites, [[cycle.key, '27년전망']]);
  assert.deepEqual(writes.map(row => row[0]), ['0', '1', '2']);
  assert.deepEqual(rows.slice(0, 3).map(row => row.topic), ['27년전망 > [자유 주제] 클라우드', '27년전망 > [자유 주제] 로봇', '27년전망 > 삼성전자']);
  assert.equal(rows[3].topic, '다른 주제 > 원익IPS');
});

test('new presentation in another date of the same cycle gets its common topic', () => {
  const ctx = context({ inputSchedules: allRounds, inputMembers: people, currentIndustryName: '27년전망',
    document: { getElementById: () => ({ value: 'industry' }) },
    getFocusedPresentationPlanItem: () => null,
    getOrderedCycleMembers: () => people,
  });
  vm.runInContext('schedules = inputSchedules;', ctx);
  vm.runInContext(section('schedule-order.html', 'function buildPresentationEntry', 'async function registerDraftForFutureCycleIfNeeded'), ctx);
  const plan = { items: [{ schedule: rounds[0] }] };
  assert.equal(ctx.buildPresentationEntry('[자유 주제] 화장품', { schedule: rounds[2] }, plan).topic, '27년전망 > [자유 주제] 화장품');
  assert.equal(ctx.buildPresentationEntry('원익IPS', { schedule: allRounds.at(-1) }, plan).topic, '원익IPS');
});

test('opening the second session loads the first session topic into the cycle editor', async () => {
  const input = { value: '', dataset: {} };
  const ctx = context({ inputSchedules: allRounds, inputMembers: people, industryLoadToken: 0,
    document: { getElementById: () => input }, setIndustryNameSaveStatus() {},
    getVisiblePresentationPlanItem: () => ({ schedule: rounds[1] }), getOrderedCycleMembers: () => people,
    getConfigStrict: async key => key.endsWith('schedule:industry-0') ? '27년전망' : null,
  });
  vm.runInContext('schedules = inputSchedules; members = inputMembers;', ctx);
  ctx.getPresentationDraftCycleState = () => ({ cycleKey: 'rotation:old' });
  vm.runInContext(section('schedule-order.html', 'async function loadIndustryNameForContext', 'function saveTurnIndustryName'), ctx);
  await ctx.loadIndustryNameForContext({}, 'industry');
  assert.equal(input.value, '27년전망');
  assert.equal(input.dataset.contextKey, ctx.getPresentationIndustryCycle(rounds[0].id, allRounds, people).key);
  assert.equal(input.dataset.persisted, 'true');
});

test('partial topic write failure stays retryable rather than reporting a completed cycle save', async () => {
  const input = { value: '27년전망', dataset: { contextKey: 'cycle-key' } };
  let fail = true;
  const ctx = context({ industrySaveToken: 1, presOrder: [],
    document: { getElementById: () => input }, setIndustryNameSaveStatus() {}, setConfig: async () => {},
    sb: { from: () => ({ update: () => ({ eq: async () => ({ error: fail ? new Error('offline') : null }) }) }) },
  });
  vm.runInContext("presentations = [{ id: 'p', status: 'planned', category: 'industry', topic: '[자유 주제] 로봇', schedule_id: 'industry-1' }];", ctx);
  vm.runInContext(section('schedule-order.html', 'async function persistTurnIndustryName', 'async function ensureIndustryNameSaved'), ctx);
  const request = { key: 'cycle-key', name: '27년전망', scheduleId: rounds[0].id, scheduleIds: rounds.map(row => row.id), requestToken: 1, opts: { silent: true } };
  assert.equal(await ctx.persistTurnIndustryName(request), false);
  assert.equal(input.dataset.dirty, 'true');
  fail = false;
  assert.equal(await ctx.persistTurnIndustryName(request), true);
  assert.equal(input.dataset.dirty, 'false');
});
