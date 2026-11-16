const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const key = 'presentation_cycles_v1';
const people = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), joined_at: '2026-01-01' }));
const rounds = ['2026-11-16', '2026-11-30', '2026-12-14'].map((event_date, i) => ({ id: 'r' + i, category: 'industry', event_date }));
function storage(initial = []) {
  const map = new Map(initial), updates = [];
  const state = { map, updates, fail: false, beforeUpdate: null };
  state.sb = { from(table) {
    assert.equal(table, 'app_config');
    return {
      async upsert(row, opts) {
        assert.equal(opts.ignoreDuplicates, true);
        if (state.fail) return { error: new Error('storage unavailable') };
        if (!map.has(row.key)) map.set(row.key, clone(row.value));
        return {};
      },
      select: () => ({ like: async (_, pattern) => ({ data: [...map.keys()]
        .filter(item => item.startsWith(pattern.slice(0, -1))).map(item => ({ key: item })) }) }),
      update(payload) {
        const filters = {};
        return {
          eq(field, value) { filters[field] = value; return this; },
          select() { return this; },
          async maybeSingle() {
            if (state.beforeUpdate) await state.beforeUpdate();
            if (state.fail) return { error: new Error('storage unavailable') };
            const previous = map.get(filters.key);
            if (String(previous.revision) !== filters['value->>revision']) return { data: null };
            updates.push(clone(payload.value));
            map.set(filters.key, clone(payload.value));
            return { data: clone(payload) };
          },
        };
      },
    };
  } };
  return state;
}
function context(db, extra = {}) {
  const ctx = vm.createContext({ console, sb: db.sb, getConfigStrict: async item => clone(db.map.get(item) ?? null),
    setConfig: async (item, value) => db.map.set(item, clone(value)), ...extra });
  vm.runInContext(read('js/schedule-shared.js'), ctx);
  return ctx;
}

test('registered cycle survives date reordering and retains newer common topic over legacy labels', async () => {
  const db = storage([['presentation_industry_v1:schedule:r0', '27년전망'],
    ['presentation_industry_v1:cycle:schedules:r0', '28년전망']]);
  const ctx = context(db);
  const before = await ctx.ensurePresentationCycleRegistry(rounds, people);
  const moved = rounds.map(row => row.id === 'r0' ? { ...row, event_date: '2026-12-07' } : row);
  const reloaded = context(db);
  const after = await reloaded.ensurePresentationCycleRegistry(moved, people.slice(0, 6));
  assert.deepEqual(clone(after), clone(before));
  for (const row of moved) {
    const cycle = reloaded.getPresentationIndustryCycle(row.id, moved, people.slice(0, 6));
    assert.deepEqual(clone(cycle.scheduleIds), ['r0', 'r1', 'r2']);
    assert.equal(reloaded.resolvePresentationIndustryTitle(row, moved, [], people.slice(0, 6), db.map), '28년전망');
  }
  assert.equal(db.updates.length, 1, 'reload must not regroup or rewrite');
});

test('deleting the anchor session preserves the topic key and does not absorb the next cycle', async () => {
  const db = storage([['presentation_industry_v1:cycle:schedules:r0', '27년전망']]);
  const ctx = context(db);
  await ctx.ensurePresentationCycleRegistry(rounds, people);
  const remaining = [...rounds.slice(1), { id: 'future', category: 'industry', event_date: '2027-01-11' }];
  await ctx.ensurePresentationCycleRegistry(remaining, people.slice(0, 6));
  const cycle = ctx.getPresentationIndustryCycle('r2', remaining, people.slice(0, 6));
  assert.deepEqual(clone(cycle.scheduleIds), ['r1', 'r2']);
  assert.equal(cycle.key, 'presentation_industry_v1:cycle:schedules:r0');
  assert.equal(ctx.resolvePresentationIndustryTitle(remaining[0], remaining, [], people, db.map), '27년전망');
  assert.equal(ctx.resolvePresentationIndustryTitle(remaining.at(-1), remaining, [], people, db.map), '');
  assert.ok(db.map.get(key).cycles[0].scheduleIds.includes('r0'), 'retain deleted anchor identity');
});

test('first migration keeps an existing canonical topic even if the original anchor was already moved', async () => {
  const db = storage([['presentation_industry_v1:cycle:schedules:r0', '28년전망'],
    ['presentation_industry_v1:schedule:r0', '27년전망']]);
  const ctx = context(db);
  const moved = rounds.map(row => row.id === 'r0' ? { ...row, event_date: '2026-12-07' } : row);
  await ctx.ensurePresentationCycleRegistry(moved, people);
  for (const row of moved) assert.equal(ctx.resolvePresentationIndustryTitle(row, moved, [], people, db.map), '28년전망');
});

test('concurrent registrations merge after revision conflict without losing either cycle', async () => {
  const db = storage();
  let release, arrivals = 0;
  const gate = new Promise(resolve => { release = resolve; });
  db.beforeUpdate = async () => {
    if (++arrivals === 2) release();
    if (arrivals <= 2) await gate;
  };
  const a = context(db), b = context(db);
  await Promise.all([
    a.ensurePresentationCycleRegistry([], [], [{ category: 'industry', scheduleIds: ['a', 'b'], participantIds: ['1', '2'] }]),
    b.ensurePresentationCycleRegistry([], [], [{ category: 'stock', scheduleIds: ['c', 'd'], participantIds: ['1', '2'] }]),
  ]);
  const saved = db.map.get(key);
  assert.equal(saved.cycles.length, 2);
  assert.deepEqual(saved.cycles.flatMap(cycle => cycle.scheduleIds).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(saved.revision, 2);
});

test('new study cycle persists all session IDs before schedule insertion and retries idempotently', async () => {
  const db = storage();
  const ctx = context(db);
  const plan = ctx.planStudyCycle([], { category: 'industry', event_date: '2026-11-16', event_time: '20:00' }, people, { today: '2026-11-16' });
  let sequence = 0;
  const rows = await ctx.prepareStudyCycleRosters(plan, [], { createId: () => 'new-' + ++sequence });
  assert.equal(db.map.get(key).cycles.length, 1);
  assert.deepEqual(db.map.get(key).cycles[0].scheduleIds, clone(rows.map(row => row.id)));
  assert.deepEqual(db.map.get(key).cycles[0].participantIds, people.map(row => row.id));
  await ctx.ensurePresentationCycleRegistry(rows, people.slice(0, 6));
  assert.equal(db.updates.length, 1);
  assert.equal(ctx.getPresentationIndustryCycle('new-3', rows, people.slice(0, 6)).scheduleIds.length, 3);
});

test('registry failure prevents new schedules from being returned for insertion', async () => {
  const db = storage();
  db.fail = true;
  const ctx = context(db);
  const plan = ctx.planStudyCycle([], { category: 'industry', event_date: '2026-11-16' }, people, { today: '2026-11-16' });
  let sequence = 0;
  await assert.rejects(ctx.prepareStudyCycleRosters(plan, [], { createId: () => 'new-' + ++sequence }), /storage unavailable/);
  assert.equal(db.map.has(key), false);
});

test('an explicit new cycle cannot silently merge two already registered cycles', async () => {
  const db = storage(), ctx = context(db);
  await ctx.ensurePresentationCycleRegistry([], [], [
    { category: 'industry', scheduleIds: ['a'], participantIds: ['1'] },
    { category: 'industry', scheduleIds: ['b'], participantIds: ['2'] },
  ]);
  const before = clone(db.map.get(key));
  await assert.rejects(ctx.ensurePresentationCycleRegistry([], [], [
    { category: 'industry', scheduleIds: ['a', 'b'], participantIds: ['1', '2'] },
  ]), /서로 다른 사이클/);
  assert.deepEqual(db.map.get(key), before);
});

test('corrupt registry is rejected without overwriting saved cycle information', async () => {
  const original = { version: 99, revision: 4, cycles: [] };
  const db = storage([[key, clone(original)]]), ctx = context(db);
  await assert.rejects(ctx.ensurePresentationCycleRegistry(rounds, people), /확인하지 못했습니다/);
  assert.deepEqual(db.map.get(key), original);
  assert.equal(db.updates.length, 0);
});

test('legacy topic saved only on a deleted first session is still inherited by the remaining sessions', async () => {
  const db = storage([['presentation_industry_v1:schedule:r0', '27년전망']]);
  const ctx = context(db);
  await ctx.ensurePresentationCycleRegistry(rounds, people);
  const remaining = rounds.slice(1);
  await ctx.ensurePresentationCycleRegistry(remaining, people);
  assert.equal(ctx.resolvePresentationIndustryTitle(remaining[0], remaining, [], people, db.map), '27년전망');
  const cycle = ctx.getPresentationIndustryCycle('r1', remaining, people);
  assert.deepEqual(clone(cycle.scheduleIds), ['r1', 'r2']);
  assert.deepEqual(clone(cycle.topicScheduleIds), ['r0', 'r1', 'r2']);
});

test('initial page load uses historical members for bootstrap before enabling schedule editing', async () => {
  const db = storage();
  const ctx = context(db, {
    fetchSchedules: async () => clone(rounds),
    fetchMembers: async opts => clone(opts.includeInactive ? people : people.slice(0, 6)),
  });
  ctx.reloadPresentations = async () => [];
  await ctx.loadSharedData();
  assert.equal(db.map.get(key).cycles.length, 1);
  assert.deepEqual(clone(ctx.getPresentationIndustryCycle('r2', rounds, people.slice(0, 6)).scheduleIds), ['r0', 'r1', 'r2']);
  db.fail = true;
  await assert.rejects(ctx.loadSharedData(), /storage unavailable/);
});
