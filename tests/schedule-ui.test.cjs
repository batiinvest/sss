const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function inlineScripts(html) {
  return html.split('<script>').slice(1).map(block => block.split('</script>')[0]);
}

test('changed app pages keep valid inline JavaScript', () => {
  for (const file of ['app.html', 'index.html', 'schedule-calendar.html', 'schedule-order.html']) {
    inlineScripts(read(file)).forEach((code, index) => {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${file}#${index}` }));
    });
  }
});

test('schedule creation uses the 20:00 default and local calendar dates', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /editingScheduleId \? '' : '20:00'/);
  assert.doesNotMatch(source, /toISOString\(\)\.slice\(0,\s*10\)/);
  assert.match(source, /const today = toDateStr\(new Date\(\)\)/);
});

test('schedule refresh never calls the order-page-only renderer', () => {
  const source = read('schedule-calendar.html');
  assert.doesNotMatch(source, /renderPresOrderCalendar\s*\(/);
  assert.match(source, /function refreshSchedulePageViews\(\)/);
});

test('editing a schedule never detaches completed presentations', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /p\.schedule_id === editingScheduleId\s*&&\s*p\.status === 'planned'/);
  assert.match(source, /const schedulePresentations = prefill\.id/);
  assert.match(source, /else if \(!schedulePresentations\.length && prefill\.description\)/);
});

test('generated presentation blocks are removed from editable memo text', () => {
  const script = inlineScripts(read('schedule-calendar.html')).at(-1)
    .replace(/\ninit\(\);\s*$/, '\n');
  const context = {
    console,
    document: { addEventListener() {} },
    window: {},
    location: { search: '', origin: 'http://localhost', pathname: '/schedule-calendar.html', protocol: 'http:' },
    URLSearchParams,
    setTimeout() {},
    requestAnimationFrame() {},
  };
  vm.createContext(context);
  vm.runInContext(script, context);

  assert.equal(
    context.extractScheduleMemo('《AI 반도체》\n1. 삼성전자 — 홍길동\n2. SK하이닉스 — 김철수\n\n준비 자료 확인'),
    '준비 자료 확인',
  );
  assert.equal(context.extractScheduleMemo('순수 메모'), '순수 메모');
});

test('mobile shell exposes schedule directly and through quick add', () => {
  const source = read('app.html');
  assert.match(source, /data-page="schedule-calendar" onclick="loadPage\('schedule-calendar'\)"/);
  assert.match(source, /schedule-calendar\?action=new/);
  assert.match(source, /'schedule-calendar': '스터디 일정'/);
  assert.match(source, /page === 'schedule-order' && mobileScheduleNav/);
  assert.doesNotMatch(source, /\['index', 'presentations', 'schedule-calendar', 'picks'\]/);
});

test('schedule details reuse the complete in-memory presentation list', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /const filteredItems = getSchedulePresentations\(scheduleId, s\.event_date\)/);
  assert.match(source, /getEffectiveScheduleRoster\(/);
  assert.doesNotMatch(source, /\.or\('schedule_id\.eq\.' \+ scheduleId/);
});

test('changing a talk to a non-talk schedule only detaches planned rows', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /else if \(editingScheduleId\)[\s\S]*p\.status === 'planned'/);
  assert.match(source, /update\(\{ schedule_id: null, presented_at: null \}\)/);
  assert.match(source, /reconcileAutomaticPresentationAssignments\(today\)/);
  assert.match(source, /일정과 발표 순서가 자동으로 조정되었습니다/);
});

test('schedule deletion preserves presentation history and recovers failed deletes', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /select\('id,status,presented_at'\)[\s\S]*eq\('schedule_id', id\)/);
  assert.match(source, /연결된 발표를 확인하지 못해 일정을 삭제하지 않았습니다/);
  assert.match(source, /filter\(p => p\.status !== 'planned'\)/);
  assert.match(source, /update\(\{ schedule_id: null \}\)/);
  assert.match(source, /let scheduleDeleted = false/);
  assert.match(source, /let rollbackFailed = false/);
  assert.match(source, /if \(!scheduleDeleted && \(plannedDetached \|\| historyDetached\)\)/);
  assert.match(source, /Promise\.allSettled\(rollbackTasks\)/);
  assert.match(source, /presented_at: row\.presented_at/);
  assert.match(source, /기존 발표 연결을 복구했습니다/);
});

test('presentation order changes reconcile only after the order is saved', () => {
  const order = read('schedule-order.html');
  const db = read('js/db.js');
  assert.match(db, /setConfig[\s\S]*if \(error\)[\s\S]*throw error/);
  assert.match(order, /await setConfig\('pres_order', presOrder\)[\s\S]*await reconcileAutomaticPresentationPlan\(\)/);
  assert.match(order, /presOrder = previousOrder/);
});

test('mobile calendar compaction stays scoped to the schedule calendar', () => {
  const source = read('css/style.css');
  assert.match(source, /\.schedule-calendar-card \.cal-day \.cal-event/);
  assert.doesNotMatch(source, /\n\s*\.cal-day \.cal-event,\n/);
});

test('schedule form protects unsaved input and selected mobile dates are revealed', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /function isScheduleFormDirty\(\)/);
  assert.match(source, /작성 중인 내용이 있습니다/);
  assert.doesNotMatch(source, /id="scheduleForm"[^>]+onclick=/);
  assert.match(source, /panel\.scrollIntoView\(\{/);
});

test('generated presentation text is not repeated as memo or shown on non-talk cards', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /const memo = extractScheduleMemo\(s\.description\)/);
  assert.match(source, /const pres = \['industry', 'stock'\]\.includes\(s\.category\)/);
});
