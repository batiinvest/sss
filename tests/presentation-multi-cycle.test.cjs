const test = require('node:test');
const assert = require('node:assert/strict');
const { scenario, clone } = require('./helpers/presentation-scenario.cjs');

async function sixCycles(count = 8) {
  const s = scenario(count), cycles = [];
  let start = '2026-11-23';
  for (let i = 0; i < 6; i++) {
    const cycle = await s.addCycle(start);
    assert.equal(cycle.plan.category, i % 2 ? 'stock' : 'industry');
    await s.fillCycle(cycle, i + 1);
    if (cycle.plan.category === 'industry') assert.equal(await s.renameCycle(cycle, '27년전망 ' + (i + 1)), true);
    cycles.push(cycle);
    start = s.ctx.addDaysToLocalDate(cycle.rows.at(-1).event_date, 14);
  }
  return { ...s, cycles };
}

for (const count of [1, 2, 3, 4, 6, 8, 10]) {
  test(`${count} presenters: six alternating cycles retain every presenter exactly once per cycle`, async () => {
    const s = await sixCycles(count);
    assert.equal(s.tables.schedules.length, Math.ceil(count / 3) * 6);
    assert.equal(s.tables.presentations.length, count * 6);
    const registry = s.config('presentation_cycles_v1');
    assert.equal(registry.cycles.length, 6);
    assert.equal(new Set(registry.cycles.flatMap(cycle => cycle.scheduleIds)).size, s.tables.schedules.length);
    for (const cycle of s.cycles) {
      const ids = cycle.rows.map(row => row.id);
      const rows = s.tables.presentations.filter(row => ids.includes(row.schedule_id));
      assert.equal(rows.length, count);
      assert.deepEqual(rows.map(row => row.member_id).sort(), s.people.map(row => row.id).sort());
      assert.ok(rows.every(row => row.category === cycle.plan.category));
      const plan = s.ctx.buildPresentationSchedulePlan(s.tables.schedules, s.tables.presentations, s.people, { fromDate: cycle.rows[0].event_date });
      for (const schedule of cycle.rows) {
        assert.deepEqual(clone(plan.byScheduleId.get(schedule.id).memberIds), s.config('presentation_manual_rosters_v1')[schedule.id]);
      }
      assert.deepEqual(clone(s.ctx.buildPresentationAssignmentPatches(s.tables.schedules, s.tables.presentations, plan)), []);
    }
  });
}

test('three industry themes stay inside their cycles after repeated changes with mixed formats', async () => {
  const s = await sixCycles();
  const before = clone(s.tables.presentations);
  const changed = s.cycles[2];
  for (const name of ['28년전망', '수요·공급 점검', '2027년 하반기 전망']) assert.equal(await s.renameCycle(changed, name), true);
  const changedIds = changed.rows.map(row => row.id);
  for (const row of s.tables.presentations) {
    const old = before.find(item => item.id === row.id);
    assert.equal(s.ctx.isFreePresentation(row), s.ctx.isFreePresentation(old));
    assert.equal(s.ctx.parsePresentationStockName(row), s.ctx.parsePresentationStockName(old));
    assert.equal(row.reason, old.reason);
    if (changedIds.includes(row.schedule_id)) assert.match(row.topic, /^2027년 하반기 전망 > /);
    else assert.deepEqual(row, old);
  }
  for (const cycle of s.cycles.filter(cycle => cycle.plan.category === 'industry')) {
    const theme = cycle === changed ? '2027년 하반기 전망' : '27년전망 ' + (s.cycles.indexOf(cycle) + 1);
    for (const row of cycle.rows) assert.equal(s.ctx.resolvePresentationIndustryTitle(row, s.tables.schedules, s.tables.presentations, s.people,
      new Map(s.tables.app_config.map(config => [config.key, config.value]))), theme);
  }
});

test('18 sessions complete successively, retaining all history and exposing only the next pending inputs', async () => {
  const s = await sixCycles();
  const content = s.tables.presentations.map(row => [row.id, row.topic, row.reason]);
  let completed = 0;
  for (let index = 0; index < s.tables.schedules.length; index++) {
    const round = s.tables.schedules[index];
    const today = s.ctx.addDaysToLocalDate(round.event_date, 1);
    const result = await s.ctx.syncPastScheduledPresentationsDone(s.client, s.tables.schedules, s.tables.presentations, { today });
    completed += s.config('presentation_manual_rosters_v1')[round.id].length;
    assert.equal(s.tables.presentations.filter(row => row.status === 'done').length, completed);
    assert.equal(result.patches.length, s.config('presentation_manual_rosters_v1')[round.id].length);
    const retry = await s.ctx.syncPastScheduledPresentationsDone(s.client, s.tables.schedules, s.tables.presentations, { today });
    assert.equal(retry.patches.length, 0);
    const plan = s.ctx.buildPresentationSchedulePlan(s.tables.schedules, s.tables.presentations, s.people, { fromDate: today });
    assert.equal(plan.nextSchedule?.id, s.tables.schedules[index + 1]?.id);
    assert.ok(plan.items.every(item => item.schedule.event_date >= today));
  }
  assert.deepEqual(s.tables.presentations.map(row => [row.id, row.topic, row.reason]), content);
  const cycles = s.ctx.buildPresentationHistoryCycles(s.config('presentation_cycles_v1'), s.tables.schedules,
    Object.fromEntries(s.tables.app_config.map(row => [row.key, row.value])), s.tables.presentations);
  for (const cycle of cycles) {
    const history = s.tables.presentations.filter(row => s.ctx.matchesPresentationHistoryFilters(row, { cycle: cycle.id }, cycles));
    assert.equal(history.length, 8);
    assert.equal(history.filter(s.ctx.isFreePresentation).length, 5);
    assert.equal(history.filter(row => !s.ctx.isFreePresentation(row)).length, 3);
  }
});

test('moving dates across a cycle boundary preserves saved membership and every linked presentation', async () => {
  const s = await sixCycles();
  const registry = s.config('presentation_cycles_v1');
  const first = s.tables.schedules[0];
  first.event_date = s.ctx.addDaysToLocalDate(s.cycles[1].rows[0].event_date, 7);
  await s.ctx.ensurePresentationCycleRegistry(s.tables.schedules, s.people.slice(0, 6));
  assert.deepEqual(s.config('presentation_cycles_v1'), registry);
  const before = clone(s.tables.presentations);
  const result = await s.ctx.syncPlannedPresentationsToSchedulePlan(s.client, s.tables.schedules, s.tables.presentations, s.people,
    { fromDate: '2026-11-01' });
  assert.equal(result.patches.length, 3);
  for (const row of s.tables.presentations) {
    const previous = before.find(item => item.id === row.id);
    assert.equal(row.schedule_id, previous.schedule_id);
    assert.equal(row.category, previous.category);
    assert.equal(row.topic, previous.topic);
    assert.equal(row.presented_at, row.schedule_id === first.id ? first.event_date : previous.presented_at);
  }
});

test('48 mixed presentations can each be edited three times without changing topic, cycle or format', async () => {
  const s = await sixCycles();
  const before = clone(s.tables.presentations);
  for (let round = 1; round <= 3; round++) {
    for (const previous of clone(s.tables.presentations)) {
      const free = s.ctx.isFreePresentation(previous);
      const saved = await s.ctx.savePresentationEdit(s.client, previous, previous, {
        format: free ? 'free' : 'stock', title: s.ctx.parsePresentationStockName(previous),
        reason: '수정 ' + round + ': ' + previous.id, risk: '토론 질문 ' + round,
        market_cap_at: previous.market_cap_at, target_cap: previous.target_cap,
      });
      assert.equal(saved.edit_revision, previous.edit_revision + 1);
      assert.equal(saved.topic, previous.topic);
      assert.equal(saved.schedule_id, previous.schedule_id);
      assert.equal(saved.category, previous.category);
      assert.equal(s.ctx.isFreePresentation(saved), free);
    }
  }
  for (const row of s.tables.presentations) {
    assert.match(row.reason, /^수정 3:/);
    assert.equal(row.topic, before.find(item => item.id === row.id).topic);
  }
});
