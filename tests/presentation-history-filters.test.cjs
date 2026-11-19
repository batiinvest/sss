const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function load(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  return ctx;
}
function section(start, end) {
  const source = read('presentations.html');
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const rows = [
  { id: 'free', category: 'industry', topic: '27년전망 > [자유 주제] 수요 > 공급', member_id: 'm1', members: { name: '박회원' }, schedule_id: 's1', status: 'done' },
  { id: 'stock', category: 'industry', topic: '27년전망 > 삼성전자', stock_code: '005930', member_id: 'm2', schedule_id: 's2', status: 'done' },
  { id: 'later', category: 'industry', topic: '[자유 주제] 수요 > 공급', member_id: 'm1', schedule_id: 's3', status: 'done' },
  { id: 'pending', category: 'industry', topic: '[자유 주제] 준비중', schedule_id: 's2', status: 'planned' },
  { id: 'legacy', category: 'stock', topic: 'Microsoft', member_id: 'm1', schedule_id: null, status: null },
];
const cycles = [{ id: 'c1', scheduleIds: ['s1', 's2'] }, { id: 'c2', scheduleIds: ['s3'] }];

test('presentation format, category, presenter, cycle and search combine independently', () => {
  const ctx = load();
  const matches = filters => rows.filter(row => ctx.matchesPresentationHistoryFilters(row, filters, cycles)).map(row => row.id);
  assert.deepEqual(matches({ category: 'industry', format: 'stock' }), ['stock']);
  assert.deepEqual(matches({ category: 'industry', format: 'free', member: 'm1', cycle: 'c1', search: '수요 > 공급' }), ['free']);
  assert.deepEqual(matches({ search: '기타' }), ['free', 'later']);
  assert.deepEqual(matches({ search: '박회원' }), ['free']);
  assert.deepEqual(matches({ search: '005930' }), ['stock']);
  assert.deepEqual(matches({ search: 'MICROSOFT', cycle: '__unassigned__' }), ['legacy']);
  assert.deepEqual(matches({ cycle: 'missing' }), []);
  assert.deepEqual(matches({}), ['free', 'stock', 'later', 'legacy']);
});

test('cycle membership uses saved IDs despite moved dates and deleted schedule anchors', () => {
  const ctx = load();
  const registry = { cycles: [{ id: 'c1', category: 'industry', topicKey: 'theme-c1', scheduleIds: ['s1', 's2'] },
    { id: 'c2', category: 'industry', topicKey: 'theme-c2', scheduleIds: ['s3'] }] };
  const result = ctx.buildPresentationHistoryCycles(registry, [
    { id: 's2', event_date: '2026-12-28' }, { id: 's3', event_date: '2026-11-30' }],
    { 'theme-c1': '27년전망' }, rows);
  assert.match(result[0].label, /27년전망.*2026-12-28/);
  assert.equal(ctx.matchesPresentationHistoryFilters(rows[0], { cycle: 'c1' }, result), true);
  assert.equal(ctx.matchesPresentationHistoryFilters(rows[2], { cycle: 'c1' }, result), false);
});

test('PC and mobile filters stay synchronized and reset restores all completed records', () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '' }); return elements.get(id); };
  let rendered = [];
  const ctx = load({ document: { getElementById: element }, allData: rows, presentationHistoryCycles: cycles,
    presentationSearchTerm: '', renderAll: data => { rendered = data.map(row => row.id); } });
  vm.runInContext(section('function applyMobilePresentationFilters', 'async function loadPresentationPriceContext'), ctx);
  vm.runInContext(section('function applyFilter', 'function getCurPrice'), ctx);
  vm.runInContext(section('function getFilteredData', '// 행의 수익률'), ctx);
  element('filterFormat').value = 'free'; element('filterCycle').value = 'c1';
  ctx.applyFilter();
  assert.equal(element('mobileFilterFormat').value, 'free');
  assert.equal(element('mobileFilterCycle').value, 'c1');
  assert.deepEqual(rendered, ['free']);
  element('mobileFilterFormat').value = 'stock'; ctx.applyMobilePresentationFilters();
  assert.deepEqual(rendered, ['stock']);
  ctx.presentationSearchTerm = 'no match';
  ctx.resetPresentationFilters();
  assert.deepEqual(rendered, ['free', 'stock', 'later', 'legacy']);
  for (const id of ['filterCycle', 'filterFormat', 'presentationDesktopSearch', 'presentationSearch']) assert.equal(element(id).value, '');
});

test('cycle lookup failure disables only that filter, leaving presentation history usable', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '' }); return elements.get(id); };
  const ctx = load({ console: { warn() {} }, document: { getElementById: element },
    getConfigStrict: async () => { throw Error('offline'); } });
  vm.runInContext(section('async function loadPresentationHistoryCycles', 'function togglePresentationFilters'), ctx);
  await ctx.loadPresentationHistoryCycles();
  assert.equal(element('filterCycle').disabled, true);
  assert.equal(element('mobileFilterCycle').disabled, true);
  assert.equal(element('filterFormat').disabled, undefined);
  assert.equal(element('presentationCycleStatus').hidden, false);
});

test('other-only desktop history foregrounds content cards and hides return summaries', () => {
  const rendered = [], classes = new Map();
  const ctx = load({ document: { getElementById: id => id === 'filterFormat' ? { value: 'free' } : {
    classList: { toggle: (name, enabled) => classes.set(name, enabled) },
  } }, window: { matchMedia: () => ({ matches: false }) },
    renderPresentationCards: () => rendered.push('cards'), renderSummary: () => rendered.push('returns') });
  vm.runInContext(section('function renderAll', 'function renderPresentationCards'), ctx);
  ctx.renderAll([rows[0]]);
  assert.deepEqual(rendered, ['cards']);
  assert.equal(classes.get('other-presentations'), true);
});

test('industry schedule copy includes common theme and location, but no blank place field', () => {
  const ctx = load({ getRenderedScheduleTitle: () => '산업 분석 — 27년전망',
    getSchedulePresentations: () => [rows[0]], getPresentationTopicLabel: row => ctx.formatPresentationTopicLabel(row),
    extractScheduleMemo: () => '' });
  const source = read('schedule-calendar.html');
  vm.runInContext(source.slice(source.indexOf('function buildScheduleClipboardText'), source.indexOf('function copyScheduleTextWithSelection')), ctx);
  const schedule = { id: 's1', category: 'industry', event_date: '2026-11-30', event_time: null, location: ' 강남 스터디룸 ' };
  assert.match(ctx.buildScheduleClipboardText(schedule), /산업 분석 — 27년전망\n일시: 2026-11-30 시간 미정\n장소: 강남 스터디룸/);
  assert.match(ctx.buildScheduleClipboardText(schedule), /1\. 박회원 - \[기타\] 수요 > 공급/);
  assert.doesNotMatch(ctx.buildScheduleClipboardText({ ...schedule, location: ' ' }), /장소:/);
});
