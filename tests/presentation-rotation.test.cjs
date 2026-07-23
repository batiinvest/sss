const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function loadHelpers() {
  const context = { console, Date, Map, Set };
  vm.createContext(context);
  vm.runInContext(read('js/schedule-shared.js'), context);
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const members = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => ({
  id,
  name: id,
  is_active: true,
}));

function schedule(id, eventDate, category = 'stock', eventTime = '20:00:00') {
  return { id, event_date: eventDate, event_time: eventTime, category, title: id };
}

function presentation(id, scheduleId, memberId, date, status = 'planned') {
  return {
    id,
    schedule_id: scheduleId,
    member_id: memberId,
    presented_at: date,
    category: 'stock',
    topic: memberId,
    status,
    created_at: `${date}T00:00:00`,
  };
}

test('seven members rotate by 3, 3, 1 and restart on the next study date', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('s1', '2026-08-03'),
    schedule('s2', '2026-08-17'),
    schedule('s3', '2026-08-31'),
    schedule('s4', '2026-09-14'),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    [],
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(plan.items.map(item => item.memberIds)),
    [['A', 'B', 'C'], ['D', 'E', 'F'], ['G'], ['A', 'B', 'C']]
  );
  assert.deepEqual(plain(plan.items.map(item => item.cycleEnds)), [false, false, true, false]);
});

test('dinner and other events do not consume presentation turns', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('s1', '2026-08-03'),
    schedule('d1', '2026-08-17', 'dinner'),
    schedule('o1', '2026-08-31', 'other'),
    schedule('s2', '2026-09-14', 'industry'),
    schedule('s3', '2026-09-28'),
    schedule('s4', '2026-10-12'),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    [],
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(plan.items.map(item => [item.schedule.id, item.memberIds])),
    [
      ['s1', ['A', 'B', 'C']],
      ['s2', ['D', 'E', 'F']],
      ['s3', ['G']],
      ['s4', ['A', 'B', 'C']],
    ]
  );
});

test('changing a middle study to dinner cascades every later group', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const base = [
    schedule('s1', '2026-08-03'),
    schedule('s2', '2026-08-17'),
    schedule('s3', '2026-08-31'),
    schedule('s4', '2026-09-14'),
  ];
  const before = buildPresentationSchedulePlan(base, [], members, { fromDate: '2026-08-01' });
  const after = buildPresentationSchedulePlan(
    base.map(item => item.id === 's2' ? { ...item, category: 'dinner' } : item),
    [],
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(before.items.map(item => [item.schedule.id, item.memberIds])),
    [
      ['s1', ['A', 'B', 'C']],
      ['s2', ['D', 'E', 'F']],
      ['s3', ['G']],
      ['s4', ['A', 'B', 'C']],
    ]
  );
  assert.deepEqual(
    plain(after.items.map(item => [item.schedule.id, item.memberIds])),
    [
      ['s1', ['A', 'B', 'C']],
      ['s3', ['D', 'E', 'F']],
      ['s4', ['G']],
    ]
  );
});

test('the latest completed last member anchors the next cycle at the first three', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('past', '2026-06-15'),
    schedule('dinner1', '2026-06-29', 'dinner'),
    schedule('dinner2', '2026-07-13', 'dinner'),
    schedule('next', '2026-07-27'),
  ];
  const rows = [presentation('pG', 'past', 'G', '2026-06-15', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.deepEqual(plain(plan.items[0].memberIds), ['A', 'B', 'C']);
});

test('a past study consumes its automatic group even when topics were never entered', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('anchor', '2026-06-15'),
    schedule('empty-study', '2026-06-29'),
    schedule('next', '2026-07-27'),
  ];
  const rows = [presentation('pG', 'anchor', 'G', '2026-06-15', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.deepEqual(plain(plan.items[0].memberIds), ['D', 'E', 'F']);
});

test('the latest first group anchors the next schedule at members four to six', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('past', '2026-07-01'),
    schedule('next', '2026-07-15'),
  ];
  const rows = ['C', 'A', 'B'].map((memberId, index) =>
    presentation(`p${index}`, 'past', memberId, '2026-07-01', 'done')
  );
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-02' }
  );

  assert.deepEqual(plain(plan.items[0].memberIds), ['D', 'E', 'F']);
});

test('partial topic entry still consumes the full automatic group for that date', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('past', '2026-07-01'),
    schedule('next', '2026-07-15'),
  ];
  const rows = [presentation('pA', 'past', 'A', '2026-07-01', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-02' }
  );

  assert.deepEqual(plain(plan.items[0].memberIds), ['D', 'E', 'F']);
});

test('completed history still anchors the cycle after its schedule becomes dinner', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('last-cycle', '2026-06-15', 'dinner'),
    schedule('next', '2026-07-27'),
  ];
  const rows = [presentation('pG', 'last-cycle', 'G', '2026-06-15', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.deepEqual(plain(plan.items[0].memberIds), ['A', 'B', 'C']);
});

test('moving a completed schedule date consumes its group only once', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('moved', '2026-07-15'),
    schedule('next', '2026-07-29'),
  ];
  const rows = ['A', 'B', 'C'].map(memberId =>
    presentation(`p${memberId}`, 'moved', memberId, '2026-07-01', 'done')
  );
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.deepEqual(plain(plan.nextMemberIds), ['D', 'E', 'F']);
});

test('a fully completed group today advances to the next study', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('today', '2026-07-23'),
    schedule('next', '2026-08-06'),
  ];
  const rows = ['A', 'B', 'C'].map(memberId =>
    presentation(`p${memberId}`, 'today', memberId, '2026-07-23', 'done')
  );
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.equal(plan.fromDate, '2026-07-24');
  assert.equal(plan.nextSchedule.id, 'next');
  assert.deepEqual(plain(plan.nextMemberIds), ['D', 'E', 'F']);
});

test('a partially completed group today remains the current study', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('today', '2026-07-23'),
    schedule('next', '2026-08-06'),
  ];
  const rows = [presentation('pA', 'today', 'A', '2026-07-23', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.equal(plan.fromDate, '2026-07-23');
  assert.equal(plan.nextSchedule.id, 'today');
  assert.deepEqual(plain(plan.nextMemberIds), ['A', 'B', 'C']);
});

test('a completed group today still advances after its schedule becomes dinner', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('today', '2026-07-23', 'dinner'),
    schedule('next', '2026-08-06'),
  ];
  const rows = ['A', 'B', 'C'].map(memberId =>
    presentation(`p${memberId}`, 'today', memberId, '2026-07-23', 'done')
  );
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.equal(plan.fromDate, '2026-07-24');
  assert.equal(plan.nextSchedule.id, 'next');
  assert.deepEqual(plain(plan.nextMemberIds), ['D', 'E', 'F']);
});

test('order normalization removes stale, duplicate and inactive members', () => {
  const { normalizePresentationOrder } = loadHelpers();
  const allMembers = [
    { id: 'A', name: 'A', is_active: true },
    { id: 'B', name: 'B', is_active: false },
    { id: 'C', name: 'C', is_active: true },
  ];
  const normalized = normalizePresentationOrder(allMembers, ['C', 'B', 'C', 'missing']);

  assert.deepEqual(plain(normalized.map(member => member.id)), ['C', 'A']);
});

test('automatic roster shows members even before they enter a topic', () => {
  const {
    buildPresentationSchedulePlan,
    getEffectiveScheduleRoster,
  } = loadHelpers();
  const schedules = [schedule('s1', '2026-08-03')];
  const rows = [presentation('pA', 's1', 'A', '2026-08-03')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-08-01' }
  );
  const roster = getEffectiveScheduleRoster(schedules[0], schedules, rows, members, plan);

  assert.deepEqual(plain(roster.map(row => row.member_id)), ['A', 'B', 'C']);
  assert.equal(roster[0]._isAutoSlot, undefined);
  assert.equal(roster[1]._isAutoSlot, true);
  assert.equal(roster[1].topic, null);
});

test('completed members today use their next cycle occurrence for new input', () => {
  const {
    buildPresentationSchedulePlan,
    getNextPresentationInputPlanItem,
  } = loadHelpers();
  const schedules = [
    schedule('today', '2026-07-23'),
    schedule('second', '2026-08-06'),
    schedule('last', '2026-08-20'),
    schedule('restart', '2026-09-03'),
  ];
  const rows = [presentation('pA-done', 'today', 'A', '2026-07-23', 'done')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );
  const target = getNextPresentationInputPlanItem(
    plan,
    'A',
    schedules,
    rows
  );

  assert.equal(target.schedule.id, 'restart');
});

test('planned presentation content moves to its earliest automatic slot without inserts', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const schedules = [
    schedule('dinner', '2026-08-03', 'dinner'),
    schedule('s1', '2026-08-17'),
    schedule('s2', '2026-08-31'),
    schedule('s3', '2026-09-14'),
  ];
  const rows = [
    presentation('pA', 'dinner', 'A', '2026-08-03'),
    { ...presentation('pB', null, 'B', null), schedule_id: null, presented_at: null },
    presentation('pD', 's1', 'D', '2026-08-17'),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-08-01' }
  );
  const patches = buildPresentationAssignmentPatches(
    schedules,
    rows,
    plan,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(plain(patches), [
    {
      id: 'pA',
      payload: { schedule_id: 's1', presented_at: '2026-08-17' },
    },
    {
      id: 'pB',
      payload: { schedule_id: 's1', presented_at: '2026-08-17' },
    },
    {
      id: 'pD',
      payload: { schedule_id: 's2', presented_at: '2026-08-31' },
    },
  ]);

  const patchedRows = rows.map(row => {
    const patch = patches.find(item => item.id === row.id);
    return patch ? { ...row, ...patch.payload } : row;
  });
  const nextPlan = buildPresentationSchedulePlan(
    schedules,
    patchedRows,
    members,
    { fromDate: '2026-08-01' }
  );
  assert.deepEqual(
    plain(buildPresentationAssignmentPatches(
      schedules,
      patchedRows,
      nextPlan,
      { fromDate: '2026-08-01' }
    )),
    []
  );
});

test('planned content on a past dinner remains eligible for the next study', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const schedules = [
    schedule('past-dinner', '2026-07-13', 'dinner'),
    schedule('next', '2026-07-27'),
  ];
  const rows = [presentation('pA', 'past-dinner', 'A', '2026-07-13')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-07-23' }
  );

  assert.deepEqual(
    plain(buildPresentationAssignmentPatches(
      schedules,
      rows,
      plan,
      { fromDate: '2026-07-23' }
    )),
    [{
      id: 'pA',
      payload: { schedule_id: 'next', presented_at: '2026-07-27' },
    }]
  );
});

test('multiple future cycles preserve one planned row per matching member occurrence', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const schedules = [
    schedule('s1', '2026-08-03'),
    schedule('s2', '2026-08-17'),
    schedule('s3', '2026-08-31'),
    schedule('s4', '2026-09-14'),
  ];
  const rows = [
    presentation('a-cycle-1', 's1', 'A', '2026-08-03'),
    presentation('a-cycle-2', 's4', 'A', '2026-09-14'),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(buildPresentationAssignmentPatches(
      schedules,
      rows,
      plan,
      { fromDate: '2026-08-01' }
    )),
    []
  );
});

test('a just-detached earlier cycle stays ahead of an already scheduled later cycle', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const schedules = [
    schedule('s3', '2026-08-31'),
    schedule('s5', '2026-09-14', 'dinner'),
    schedule('s6', '2026-09-28'),
  ];
  const rows = [
    {
      ...presentation('d-first', null, 'A', null),
      schedule_id: null,
      presented_at: null,
      created_at: '2026-07-01T00:00:00',
    },
    {
      ...presentation('d-second', 's5', 'A', '2026-09-14'),
      created_at: '2026-07-15T00:00:00',
    },
  ];
  const repeatedMemberPlan = {
    fromDate: '2026-08-01',
    items: [
      { schedule: schedules[0], memberIds: ['A'] },
      { schedule: schedules[2], memberIds: ['A'] },
    ],
  };
  const patches = buildPresentationAssignmentPatches(
    schedules,
    rows,
    repeatedMemberPlan,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(plain(patches), [
    {
      id: 'd-first',
      payload: { schedule_id: 's3', presented_at: '2026-08-31' },
    },
    {
      id: 'd-second',
      payload: { schedule_id: 's6', presented_at: '2026-09-28' },
    },
  ]);
});

test('a dinner change shifts later rows and safely unassigns overflow content', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const schedules = [
    schedule('s1', '2026-08-03'),
    schedule('s2', '2026-08-17', 'dinner'),
    schedule('s3', '2026-08-31'),
    schedule('s4', '2026-09-14'),
  ];
  const rows = [
    ...['A', 'B', 'C'].map(memberId =>
      presentation(`${memberId}1`, 's1', memberId, '2026-08-03')
    ),
    ...['D', 'E', 'F'].map(memberId =>
      presentation(`${memberId}1`, 's2', memberId, '2026-08-17')
    ),
    presentation('G1', 's3', 'G', '2026-08-31'),
    ...['A', 'B', 'C'].map(memberId =>
      presentation(`${memberId}2`, 's4', memberId, '2026-09-14')
    ),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-08-01' }
  );
  const patches = buildPresentationAssignmentPatches(
    schedules,
    rows,
    plan,
    { fromDate: '2026-08-01' }
  );
  const patchById = new Map(patches.map(patch => [patch.id, plain(patch.payload)]));

  for (const memberId of ['D', 'E', 'F']) {
    assert.deepEqual(patchById.get(`${memberId}1`), {
      schedule_id: 's3',
      presented_at: '2026-08-31',
    });
  }
  assert.deepEqual(patchById.get('G1'), {
    schedule_id: 's4',
    presented_at: '2026-09-14',
  });
  for (const memberId of ['A', 'B', 'C']) {
    assert.deepEqual(patchById.get(`${memberId}2`), {
      schedule_id: null,
      presented_at: null,
    });
  }
});

test('an empty or unavailable future plan never detaches existing assignments', () => {
  const {
    buildPresentationSchedulePlan,
    buildPresentationAssignmentPatches,
  } = loadHelpers();
  const rows = [presentation('pA', 'missing-schedule', 'A', '2026-08-03')];
  const plan = buildPresentationSchedulePlan(
    [],
    rows,
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(buildPresentationAssignmentPatches(
      [],
      rows,
      plan,
      { fromDate: '2026-08-01' }
    )),
    []
  );
});

test('assignment sync rolls back earlier updates when a later update fails', async () => {
  const { syncPlannedPresentationsToSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('s1', '2026-08-03'),
    schedule('s2', '2026-08-17'),
  ];
  const rows = [
    presentation('pA', 's2', 'A', '2026-08-17'),
    presentation('pD', 's1', 'D', '2026-08-03'),
  ];
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, 'presentations');
      return {
        update(payload) {
          return {
            async eq(column, id) {
              assert.equal(column, 'id');
              calls.push({ id, payload: plain(payload) });
              if (id === 'pD' && payload.schedule_id === 's2') {
                return { error: new Error('boom') };
              }
              return { error: null };
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    () => syncPlannedPresentationsToSchedulePlan(
      client,
      schedules,
      rows,
      members,
      { fromDate: '2026-08-01' }
    ),
    /boom/
  );
  assert.deepEqual(calls, [
    {
      id: 'pA',
      payload: { schedule_id: 's1', presented_at: '2026-08-03' },
    },
    {
      id: 'pD',
      payload: { schedule_id: 's2', presented_at: '2026-08-17' },
    },
    {
      id: 'pA',
      payload: { schedule_id: 's2', presented_at: '2026-08-17' },
    },
  ]);
});

test('only the first presentation schedule on a date receives the daily group', () => {
  const { buildPresentationSchedulePlan } = loadHelpers();
  const schedules = [
    schedule('late', '2026-08-03', 'stock', '21:00:00'),
    schedule('early', '2026-08-03', 'industry', '20:00:00'),
    schedule('next', '2026-08-17'),
  ];
  const plan = buildPresentationSchedulePlan(
    schedules,
    [],
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(plan.items.map(item => [item.schedule.id, item.memberIds])),
    [
      ['early', ['A', 'B', 'C']],
      ['next', ['D', 'E', 'F']],
    ]
  );
});

test('a secondary presentation schedule on the same future date hides stale planned rows', () => {
  const {
    buildPresentationSchedulePlan,
    getEffectiveScheduleRoster,
  } = loadHelpers();
  const schedules = [
    schedule('early', '2026-08-03', 'stock', '20:00:00'),
    schedule('late', '2026-08-03', 'industry', '21:00:00'),
  ];
  const rows = [presentation('pD', 'late', 'D', '2026-08-03')];
  const plan = buildPresentationSchedulePlan(
    schedules,
    rows,
    members,
    { fromDate: '2026-08-01' }
  );

  assert.deepEqual(
    plain(getEffectiveScheduleRoster(
      schedules[0],
      schedules,
      rows,
      members,
      plan
    ).map(row => row.member_id)),
    ['A', 'B', 'C']
  );
  assert.deepEqual(
    plain(getEffectiveScheduleRoster(
      schedules[1],
      schedules,
      rows,
      members,
      plan
    )),
    []
  );
});

test('all schedule surfaces consume the same automatic plan', () => {
  const shared = read('js/schedule-shared.js');
  const calendar = read('schedule-calendar.html');
  const order = read('schedule-order.html');
  const index = read('index.html');
  const modal = read('js/modal-pres.js');

  assert.match(shared, /PRESENTATION_GROUP_SIZE = 3/);
  assert.match(shared, /buildPresentationSchedulePlan/);
  assert.match(shared, /buildPresentationAssignmentPatches/);
  assert.doesNotMatch(shared, /\.insert\(/);
  assert.match(calendar, /getEffectiveScheduleRoster/);
  assert.match(calendar, /reconcileAutomaticPresentationAssignments/);
  assert.match(order, /getAutomaticPresentationPlan/);
  assert.match(index, /turnData\?\.schedules/);
  assert.match(modal, /getConfig\('pres_order'\)/);
  assert.doesNotMatch(modal, /from\('app_settings'\).*pres_order/);
  assert.match(modal, /topic, category: cat/);
  assert.doesNotMatch(modal, /category:\s*_autoAssignment/);
  assert.match(modal, /getNextPresentationInputPlanItem/);
  assert.doesNotMatch(modal, /limit\(1\)/);
  assert.doesNotMatch(order, /assignDateModal|dataTransfer|doAssign/);
});
