const test = require('node:test');
const assert = require('node:assert/strict');

const {
  monthRange,
  getMembersForMonth,
  buildEffectiveFees,
  buildEffectiveExpenses,
  summarizeFundBalance,
  summarizeFundMonth,
} = require('../js/fees-auto.js');

test('monthRange handles year boundaries without timezone drift', () => {
  assert.deepEqual(monthRange('2025-11', '2026-02'), [
    '2025-11', '2025-12', '2026-01', '2026-02',
  ]);
});

test('automatic fees fill only missing eligible member-month pairs', () => {
  const members = [
    { id: 'a', name: 'A', is_active: true, joined_at: '2026-04-03' },
    { id: 'b', name: 'B', is_active: true, joined_at: '2026-06-01' },
    { id: 'c', name: 'C', is_active: false, joined_at: '2026-04-01' },
  ];
  const stored = [
    { id: 'fee-a-apr', member_id: 'a', month: '2026-04', amount: 20000, fee_type: 'regular' },
    { id: 'fee-b-jun', member_id: 'b', month: '2026-06', amount: 15000, fee_type: 'regular' },
    { id: 'extra-a-may', member_id: 'a', month: '2026-05', amount: 5000, fee_type: 'extra' },
  ];

  const effective = buildEffectiveFees(stored, members, {
    monthlyFee: 20000,
    startMonth: '2026-04',
    throughMonth: '2026-07',
  });
  const automatic = effective.filter(fee => fee.is_auto);

  assert.deepEqual(
    automatic.map(fee => fee.member_id + ':' + fee.month).sort(),
    ['a:2026-05', 'a:2026-06', 'a:2026-07', 'b:2026-07'],
  );
  assert.equal(
    effective.filter(fee => fee.member_id === 'b' && fee.month === '2026-06' && fee.fee_type === 'regular').length,
    1,
  );
  assert.equal(effective.find(fee => fee.id === 'fee-b-jun').amount, 15000);
  assert.equal(effective.find(fee => fee.id === 'extra-a-may').amount, 5000);
  assert.deepEqual(getMembersForMonth(members, '2026-05').map(member => member.id), ['a']);
});

test('automatic fees do not create future months', () => {
  const effective = buildEffectiveFees([], [
    { id: 'a', name: 'A', is_active: true, joined_at: '2026-01-01' },
  ], {
    monthlyFee: 20000,
    startMonth: '2026-04',
    throughMonth: '2026-05',
  });

  assert.deepEqual(effective.map(fee => fee.month), ['2026-04', '2026-05']);
});

test('duplicate stored regular fees count only once for a member-month', () => {
  const stored = [
    { id: 'older-duplicate', member_id: 'a', month: '2026-04', amount: 15000, fee_type: 'regular', paid_at: '2026-04-01', created_at: '2026-04-01T10:00:00Z' },
    { id: 'latest', member_id: 'a', month: '2026-04', amount: 20000, fee_type: 'regular', paid_at: '2026-04-01', created_at: '2026-04-01T11:00:00Z' },
    { id: 'extra', member_id: 'a', month: '2026-04', amount: 5000, fee_type: 'extra' },
  ];
  const effective = buildEffectiveFees(stored, [
    { id: 'a', name: 'A', is_active: true, joined_at: '2026-01-01' },
  ], {
    monthlyFee: 20000,
    startMonth: '2026-04',
    throughMonth: '2026-04',
  });

  assert.deepEqual(effective.map(fee => fee.id), ['latest', 'extra']);
  assert.equal(effective.reduce((sum, fee) => sum + fee.amount, 0), 25000);
});

test('room expenses repeat the latest actual monthly total into missing months', () => {
  const stored = [
    { id: 'apr-room', category: 'room', amount: 130000, spent_at: '2026-04-24', note: '4월 이용료' },
    { id: 'may-room-1', category: 'room', amount: 100000, spent_at: '2026-05-01', note: '5월 이용료' },
    { id: 'may-room-2', category: 'room', amount: 30000, spent_at: '2026-05-02', note: '추가 사용' },
    { id: 'may-drink', category: 'drink', amount: 5000, spent_at: '2026-05-10', note: '음료' },
  ];

  const effective = buildEffectiveExpenses(stored, {
    startMonth: '2026-04',
    throughMonth: '2026-07',
  });
  const automatic = effective.filter(expense => expense.is_auto);

  assert.deepEqual(automatic.map(expense => ({
    month: expense.spent_at.slice(0, 7),
    date: expense.spent_at,
    amount: expense.amount,
    source: expense.source_month,
  })), [
    { month: '2026-06', date: '2026-06-02', amount: 130000, source: '2026-05' },
    { month: '2026-07', date: '2026-07-02', amount: 130000, source: '2026-05' },
  ]);
  assert.equal(effective.filter(expense => expense.id === 'may-drink').length, 1);
});

test('a new actual room total replaces the virtual amount for that month and future months', () => {
  const stored = [
    { id: 'may-room', category: 'room', amount: 130000, spent_at: '2026-05-01', note: '스터디룸 이용료' },
    { id: 'jul-room', category: 'room', amount: 150000, spent_at: '2026-07-13', note: '변경된 이용료' },
  ];

  const effective = buildEffectiveExpenses(stored, {
    startMonth: '2026-04',
    throughMonth: '2026-08',
  });
  const automatic = effective.filter(expense => expense.is_auto);

  assert.deepEqual(automatic.map(expense => [expense.spent_at, expense.amount]), [
    ['2026-06-01', 130000],
    ['2026-08-13', 150000],
  ]);
  assert.equal(automatic.some(expense => expense.spent_at.startsWith('2026-07')), false);
});

test('a zero-won actual room record stops future automatic repetition', () => {
  const stored = [
    { id: 'may-room', category: 'room', amount: 130000, spent_at: '2026-05-01' },
    { id: 'jul-room', category: 'room', amount: 130000, spent_at: '2026-07-01' },
    { id: 'jul-stop', category: 'room', amount: 0, spent_at: '2026-07-01', note: '스터디룸 자동 반복 중지' },
  ];

  const effective = buildEffectiveExpenses(stored, {
    startMonth: '2026-04',
    throughMonth: '2026-09',
  });
  const automatic = effective.filter(expense => expense.is_auto);

  assert.deepEqual(automatic.map(expense => [expense.spent_at, expense.amount]), [
    ['2026-06-01', 130000],
  ]);
  assert.equal(effective.some(expense => expense.id === 'jul-stop'), true);
});

test('room automation stays inactive until an actual room expense exists', () => {
  const stored = [
    { id: 'drink', category: 'drink', amount: 5000, spent_at: '2026-04-10' },
  ];
  assert.deepEqual(
    buildEffectiveExpenses(stored, { startMonth: '2026-04', throughMonth: '2026-07' }),
    stored,
  );
});

test('room automation carries the latest pre-start actual amount into the first automatic month', () => {
  const effective = buildEffectiveExpenses([
    { id: 'mar-room', category: 'room', amount: 125000, spent_at: '2026-03-31', note: '3월 이용료' },
  ], {
    startMonth: '2026-04',
    throughMonth: '2026-05',
  });
  const automatic = effective.filter(expense => expense.is_auto);

  assert.deepEqual(automatic.map(expense => ({
    spent_at: expense.spent_at,
    amount: expense.amount,
    source: expense.source_month,
  })), [
    { spent_at: '2026-04-30', amount: 125000, source: '2026-03' },
    { spent_at: '2026-05-31', amount: 125000, source: '2026-03' },
  ]);
});

test('a pre-start zero-won room record keeps automatic repetition stopped', () => {
  const stored = [
    { id: 'feb-room', category: 'room', amount: 125000, spent_at: '2026-02-28' },
    { id: 'mar-stop', category: 'room', amount: 0, spent_at: '2026-03-31', note: '스터디룸 자동 반복 중지' },
  ];
  const effective = buildEffectiveExpenses(stored, {
    startMonth: '2026-04',
    throughMonth: '2026-05',
  });

  assert.deepEqual(effective, stored);
});

test('current ledger scenario yields four months of seven fees and four room charges', () => {
  const members = Array.from({ length: 7 }, (_, index) => ({
    id: 'member-' + index,
    name: '회원' + index,
    is_active: true,
    joined_at: '2026-01-01',
  }));
  const storedFees = ['2026-04', '2026-05'].flatMap(month =>
    members.map(member => ({
      id: month + '-' + member.id,
      member_id: member.id,
      month,
      amount: 20000,
      fee_type: 'regular',
    }))
  );
  const storedExpenses = [
    { id: 'apr-room', category: 'room', amount: 130000, spent_at: '2026-04-24' },
    { id: 'may-room', category: 'room', amount: 130000, spent_at: '2026-05-01' },
  ];

  const effectiveFees = buildEffectiveFees(storedFees, members, {
    monthlyFee: 20000,
    startMonth: '2026-04',
    throughMonth: '2026-07',
  });
  const effectiveExpenses = buildEffectiveExpenses(storedExpenses, {
    startMonth: '2026-04',
    throughMonth: '2026-07',
  });
  const totalFees = effectiveFees.reduce((sum, fee) => sum + fee.amount, 0);
  const totalRoom = effectiveExpenses.reduce((sum, expense) => sum + expense.amount, 0);

  assert.equal(totalFees, 560000);
  assert.equal(totalRoom, 520000);
  assert.equal(totalFees - totalRoom, 40000);
  assert.equal(effectiveFees.filter(fee => fee.month === '2026-07').length, 7);
  assert.equal(effectiveExpenses.filter(expense => expense.spent_at.startsWith('2026-07')).length, 1);
});

test('monthly summary aggregates automatic income, exceptions, fixed costs, and variable spending', () => {
  const members = [
    { id: 'a', name: 'A', is_active: true, joined_at: '2026-04-01' },
    { id: 'b', name: 'B', is_active: true, joined_at: '2026-04-01' },
  ];
  const fees = [
    { member_id: 'a', month: '2026-08', amount: '20000', fee_type: 'regular', is_auto: true },
    { member_id: 'b', month: '2026-08', amount: 15000, fee_type: 'regular' },
    { member_id: 'a', month: '2026-08', amount: '5000', fee_type: 'extra' },
    { member_id: 'a', month: '2026-07', amount: 20000, fee_type: 'regular' },
  ];
  const expenses = [
    { category: 'room', amount: '30000', spent_at: '2026-08-02', is_auto: true },
    { category: 'drink', amount: 4000, spent_at: '2026-08-10' },
    { category: 'other', amount: null, spent_at: '2026-08-11' },
    { category: 'room', amount: 30000, spent_at: '2026-07-02' },
  ];

  const summary = summarizeFundMonth(fees, expenses, members, '2026-08', {
    monthlyFee: 20000,
    startMonth: '2026-04',
  });

  assert.equal(summary.activeMemberCount, 2);
  assert.equal(summary.regularIncome, 35000);
  assert.equal(summary.expectedRegularIncome, 40000);
  assert.equal(summary.regularAdjustment, -5000);
  assert.equal(summary.extraIncome, 5000);
  assert.equal(summary.roomExpense, 30000);
  assert.equal(summary.variableExpense, 4000);
  assert.equal(summary.totalIncome, 40000);
  assert.equal(summary.totalExpense, 34000);
  assert.equal(summary.net, 6000);
  assert.equal(summary.automatedRegularCount, 1);
  assert.equal(summary.manualRegularCount, 1);
});

test('monthly summary handles automation start boundary and invalid month safely', () => {
  const members = [
    { id: 'a', name: 'A', is_active: true, joined_at: '2026-01-01' },
  ];
  const beforeStart = summarizeFundMonth([], [], members, '2026-03', {
    monthlyFee: 20000,
    startMonth: '2026-04',
  });
  const invalid = summarizeFundMonth([], [], members, 'not-a-month', {
    monthlyFee: 20000,
    startMonth: '2026-04',
  });

  assert.equal(beforeStart.activeMemberCount, 0);
  assert.equal(beforeStart.expectedRegularIncome, 0);
  assert.equal(beforeStart.net, 0);
  assert.equal(invalid.month, '');
  assert.deepEqual(invalid.activeMembers, []);
});

test('fund balance excludes future and invalid ledger rows', () => {
  const balance = summarizeFundBalance([
    { month: '2026-07', amount: '20000' },
    { month: '2026-08', amount: 20000 },
    { month: '2026-09', amount: 20000 },
    { month: 'invalid', amount: 999999 },
  ], [
    { spent_at: '2026-08-02', amount: '13000' },
    { spent_at: '2026-09-02', amount: 13000 },
    { spent_at: null, amount: 999999 },
  ], '2026-08');

  assert.deepEqual(balance, {
    totalFees: 40000,
    totalExpenses: 13000,
    balance: 27000,
  });
});
