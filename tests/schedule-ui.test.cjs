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

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('changed app pages keep valid inline JavaScript', () => {
  for (const file of ['app.html', 'index.html', 'schedule-calendar.html', 'schedule-order.html', 'presentations.html']) {
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

test('schedule and presentation preparation pages have separate responsibilities', () => {
  const calendar = read('schedule-calendar.html');
  const order = read('schedule-order.html');
  const shared = read('js/schedule-shared.js');
  const detailLoader = sourceSection(
    calendar,
    'async function loadPlannedItems',
    'function closeDetail',
  );
  const memberPanel = sourceSection(
    order,
    'function renderMemberPresPanel',
    '// 외부 클릭 시 드롭다운 닫기',
  );

  assert.match(calendar, /id="calGrid"/);
  assert.match(calendar, /id="plannedSection"/);
  assert.match(calendar, /순서·종목 관리/);
  assert.doesNotMatch(calendar, /id="presentationSection"|id="presentationList"/);
  assert.doesNotMatch(calendar, /function (?:addPresenter|addPlannedRow|savePlannedItems|presStockSearch)\b/);
  assert.doesNotMatch(detailLoader, /\.insert\(|\.update\(|\.delete\(/);

  assert.match(order, /id="turnGuide"/);
  assert.match(order, /id="memberPresPanel"/);
  assert.match(order, /getAutomaticPresentationPlan/);
  assert.match(order, /getNextPresentationInputPlanItem/);
  assert.match(memberPanel, /\.insert\(payload\)/);
  assert.match(memberPanel, /schedule_id: autoItem\?\.schedule\.id \|\| null/);
  assert.doesNotMatch(order, /from\(['"]schedules['"]\)/);
  assert.doesNotMatch(order, /id="(?:calTitle2|calGrid2|filterCat2|scheduleListTbody2)"/);
  assert.doesNotMatch(order, /function (?:renderPresOrderCalendar|renderPresScheduleList|getOrderScheduleRoster|autoAssignNextCycle|resetPresOrder)\b/);
  assert.doesNotMatch(shared, /renderPresOrderCalendar|renderPresScheduleList/);
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
  const legacy = context.splitScheduleDescription(
    '《AI 반도체》\n1. 삼성전자 — 홍길동\n\n준비 자료 확인',
  );
  assert.equal(legacy.presentationPrefix, '《AI 반도체》\n1. 삼성전자 — 홍길동');
  assert.equal(legacy.memo, '준비 자료 확인');
  assert.equal(context.extractScheduleMemo('순수 메모'), '순수 메모');
  assert.match(
    read('schedule-calendar.html'),
    /\[formLegacyPresentationPrefix, memo\]\.filter\(Boolean\)\.join\('\\n\\n'\)/,
  );
});

test('mobile shell exposes schedule and one integrated presentation section', () => {
  const source = read('app.html');
  assert.match(source, /data-page="schedule-calendar" onclick="loadPage\('schedule-calendar'\)"/);
  assert.match(source, /schedule-calendar\?action=new/);
  assert.match(source, /'schedule-calendar': '스터디 일정'/);
  assert.match(source, /presentations: '발표 관리'/);
  assert.match(source, /data-page="presentations" onclick="loadPage\('presentations\?view=prepare'\)"/);
  assert.match(source, /runQuickRoute\('presentations\?view=prepare'\)/);
  assert.doesNotMatch(source, /data-page="schedule-order"/);
  assert.match(source, /if \(page === 'schedule-order'\)[\s\S]*params\.set\('view', 'prepare'\)/);
  assert.match(source, /framePage = parsed\.page === 'presentations' && parsed\.params\.get\('view'\) === 'prepare'/);
  assert.match(source, /if \(!APP_PAGES\.has\(page\) && page !== 'schedule-order'\) return/);
  assert.match(read('schedule-calendar.html'), /presentations\?view=prepare&schedule=/);
  assert.match(read('schedule-order.html'), /requestedScheduleId/);
  assert.match(read('js/schedule-shared.js'), /page \+ '\.html' \+ \(query \? '\?' \+ query : ''\)/);
});

test('legacy presentation routes normalize to the integrated canonical views', () => {
  const source = read('app.html');
  const helperSource = sourceSection(source, 'const APP_PAGES', 'function updateActiveNavigation');
  const context = { URLSearchParams };
  vm.createContext(context);
  vm.runInContext(helperSource, context);

  assert.equal(
    context.normalizeRoute('schedule-order?schedule=abc').route,
    'presentations?view=prepare&schedule=abc',
  );
  assert.equal(
    context.normalizeRoute('presentations?id=xyz').route,
    'presentations?view=history&id=xyz',
  );
  assert.equal(
    context.routeFrameSrc('presentations?view=prepare&schedule=abc'),
    'schedule-order.html?view=prepare&schedule=abc&v=20260725.5',
  );
  assert.equal(
    context.routeFrameSrc('presentations?view=history&id=xyz'),
    'presentations.html?view=history&id=xyz&v=20260725.5',
  );
});

test('presentation management uses prepare and history views without a duplicate planned list', () => {
  const prepare = read('schedule-order.html');
  const history = read('presentations.html');
  const dashboard = read('index.html');

  assert.match(prepare, /<h1 class="page-title">발표 관리<\/h1>/);
  assert.match(prepare, /class="active" aria-current="page">준비 중<\/button>/);
  assert.match(prepare, /presentations\?view=history/);
  assert.doesNotMatch(prepare, /id="calGrid"/);

  assert.match(history, /<h1 class="page-title">발표 관리<\/h1>/);
  assert.match(history, /presentations\?view=prepare/);
  assert.match(history, /class="active" aria-current="page">발표 기록<\/button>/);
  assert.doesNotMatch(history, /tabPlanned|tabDone|mobilePresentationStatus|switchTab/);
  assert.match(history, /\(p\.status \|\| 'done'\) === 'done'/);
  assert.match(history, /if \(item\.status === 'planned'\)[\s\S]*presentations\?view=prepare/);

  assert.match(dashboard, /presentations\?view=prepare/);
  assert.match(dashboard, /presentations\?view=history&id=/);
  assert.match(dashboard, /item\.status === 'planned'[\s\S]*presentations\?view=prepare/);
  assert.match(read('app.html'), /item\.status === 'planned'[\s\S]*presentations\?view=prepare/);
});

test('schedule details reuse the complete in-memory presentation list', () => {
  const source = read('schedule-calendar.html');
  assert.match(source, /const filteredItems = getSchedulePresentations\(scheduleId, s\.event_date\)/);
  assert.match(source, /getEffectiveScheduleRoster\(/);
  assert.doesNotMatch(source, /\.or\('schedule_id\.eq\.' \+ scheduleId/);
});

test('changing a talk to dinner keeps a carry anchor and reconciles later rows', () => {
  const source = read('schedule-calendar.html');
  const saveSchedule = sourceSection(
    source,
    'async function saveSchedule',
    'async function confirmDelete',
  );
  assert.doesNotMatch(saveSchedule, /update\(\{ schedule_id: null, presented_at: null \}\)/);
  assert.match(saveSchedule, /reconcileAutomaticPresentationAssignments\(today\)/);
  assert.match(saveSchedule, /일정과 발표 순서가 자동으로 조정되었습니다/);
  assert.match(saveSchedule, /select\('id'\)[\s\S]*?eq\('schedule_id', editingScheduleId\)[\s\S]*?eq\('status', 'done'\)/);
  assert.match(saveSchedule, /registerPresentationDraftCarryoverIds\(reopenedDoneIds\)/);
  assert.match(saveSchedule, /update\(\{ status: 'planned' \}\)[\s\S]*?updateSchedule/);
  assert.match(saveSchedule, /update\(\{ status: 'done' \}\)[\s\S]*?rollbackError/);
  assert.match(saveSchedule, /catch\(e\)[\s\S]*?lockScheduleData\(\)/);
  assert.match(saveSchedule, /previousCategory !== category[\s\S]*?update\(\{ category, topic \}\)/);
  assert.doesNotMatch(saveSchedule, /querySelectorAll\('\.pres-card'\)|presentationPayloads|retainedPresentationIds/);
});

test('schedule deletion preserves presentation history and recovers failed deletes', () => {
  const source = read('schedule-calendar.html');
  const confirmDelete = sourceSection(
    source,
    'async function confirmDelete',
    'async function showDetail',
  );
  assert.match(source, /select\('id,status,presented_at'\)[\s\S]*eq\('schedule_id', id\)/);
  assert.match(source, /연결된 발표를 확인하지 못해 일정을 삭제하지 않았습니다/);
  assert.match(source, /filter\(p => p\.status !== 'planned'\)/);
  assert.ok(
    confirmDelete.indexOf('await registerPresentationDraftCarryoverIds(plannedIds)') <
    confirmDelete.indexOf('.update({ schedule_id: null })'),
  );
  assert.match(confirmDelete, /update\(\{ schedule_id: null \}\)/);
  assert.doesNotMatch(confirmDelete, /update\(\{[^}]*presented_at:\s*null[^}]*\}\)/);
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
  const memberPanel = sourceSection(
    order,
    'function renderMemberPresPanel',
    '// 외부 클릭 시 드롭다운 닫기',
  );
  assert.match(db, /setConfig[\s\S]*if \(error\)[\s\S]*throw error/);
  assert.equal(
    [...memberPanel.matchAll(/await setConfig\('pres_order', presOrder\)[\s\S]*?await reconcileAutomaticPresentationPlan\(\)/g)].length,
    2,
  );
  assert.equal((memberPanel.match(/presOrder = previousOrder/g) || []).length, 2);
});

test('presentation preparation preserves pending input and uses each automatic schedule category', () => {
  const order = read('schedule-order.html');
  const memberPanel = sourceSection(
    order,
    'function renderMemberPresPanel',
    '// 외부 클릭 시 드롭다운 닫기',
  );
  const entryBuilder = sourceSection(
    order,
    'function buildPresentationEntry',
    'async function reconcileAutomaticPresentationPlan',
  );

  assert.match(memberPanel, /panel\.querySelectorAll\('input\[data-member-id\]'\)/);
  assert.match(memberPanel, /const savedInput = saved\[String\(m\.id\)\]/);
  assert.match(memberPanel, /input\.value = savedInput\.v/);
  assert.match(entryBuilder, /const category = autoItem\?\.schedule\.category \|\| fallbackCategory/);
  assert.match(entryBuilder, /matchesVisibleContext/);
  assert.match(memberPanel, /topic: entry\.topic/);
  assert.match(memberPanel, /category: entry\.category/);
});

test('industry names persist independently and legacy topics stay outside the new cycle', () => {
  const order = read('schedule-order.html');
  const modal = read('js/modal-pres.js');
  const shared = read('js/schedule-shared.js');

  assert.match(order, /id="saveIndustryNameBtn"[\s\S]*saveTurnIndustryName\(\)/);
  assert.match(order, /id="industryNameSaveStatus"[\s\S]*aria-live="polite"/);
  assert.match(order, /await setConfig\(key, name\)/);
  assert.match(order, /update\(\{ topic \}\)\.eq\('id', presentation\.id\)/);
  assert.match(order, /findCurrentPresentationDraft\(/);
  assert.match(order, /id="legacyDraftNotice"/);
  assert.match(shared, /PRESENTATION_DRAFT_CYCLE_CONFIG_KEY/);
  assert.match(shared, /PRESENTATION_DRAFT_CARRYOVER_CONFIG_PREFIX/);
  assert.match(shared, /ensurePresentationDraftCycle/);
  assert.match(shared, /registerPresentationDraftCarryoverIds/);
  assert.match(shared, /recoverInitialPresentationDrafts/);
  assert.match(shared, /syncPastScheduledPresentationsDone/);
  assert.match(shared, /isCurrentUnassignedPresentationDraft/);
  assert.match(modal, /findCurrentPresentationDraft\(/);
  for (const source of [order, read('schedule-calendar.html'), read('index.html'), modal]) {
    assert.match(source, /recoverInitialPresentationDrafts\(/);
  }
  assert.match(modal, /getPresentationIndustryConfigKey\(/);
  assert.match(modal, /return getPresentationTurnState\(allPresentations, orderedMembers\)/);
  assert.doesNotMatch(
    sourceSection(modal, 'function getModalTurnState', '// ── 팝업 HTML 마운트'),
    /includePlanned|p\.status === 'planned'/,
  );
  assert.match(order, /industrySaveQueue/);
  assert.match(order, /input\.dataset\.persisted/);
  assert.match(modal, /if \(industryInput\) industryInput\.value = ''/);
  assert.match(modal, /configKey: _industryConfigKey/);
  assert.match(modal, /await _closePromise/);
  assert.match(modal, /const openToken = \+\+_openToken/);
  assert.match(modal, /setModalContextControlsDisabled\(true\)/);
  assert.match(modal, /setModalContextControlsDisabled\(false\)[\s\S]*?renderPanel\(\)/);
  assert.match(modal, /Promise\.allSettled\(\[\s*flushDraftSave\(\),\s*_industrySaveQueue/);
  assert.doesNotMatch(modal, /_draftEpoch = PRESENTATION_DRAFT_MIGRATION_EPOCH/);
  assert.match(order, /function lockPresentationSetup\(/);
  assert.match(order, /reloadPresentations\(\{ strict: true \}\)/);
  assert.match(order, /catch\(e\)[\s\S]*?lockPresentationSetup\(\)[\s\S]*?return;/);
  assert.match(order, /getConfigStrict\(key\)/);
  assert.match(shared, /ignoreDuplicates: true/);
  assert.match(shared, /value->>cycle_marker\.lt\./);
  assert.match(shared, /if \(!normalizedEpoch\) return false/);
  assert.doesNotMatch(shared, /payload:\s*\{\s*schedule_id:\s*null,\s*presented_at:\s*null\s*\}/);
  assert.doesNotMatch(read('index.html'), /created_at,\s*updated_at/);
  assert.doesNotMatch(modal, /created_at,updated_at/);
  assert.match(read('index.html'), /formatDataLoadError\(error\), error/);
  assert.doesNotMatch(
    sourceSection(read('index.html'), 'async function activatePresentationDraftCycle', 'function mobilePresentationName'),
    /PRESENTATION_DRAFT_MIGRATION_EPOCH|catch \(/,
  );
});

test('schedule UI cache versions stay aligned', () => {
  assert.match(read('app.html'), /css\/style\.css\?v=20260725\.5/);
  assert.match(read('app.html'), /js\/pwa\.js\?v=20260725\.5/);
  assert.match(read('app.html'), /params\.set\('v', '20260725\.5'\)/);
  assert.match(read('app.html'), /sss-sw-refresh-20260725\.5/);
  assert.match(read('app.html'), /controllerchange[\s\S]*location\.reload\(\)/);
  for (const file of ['index.html', 'schedule-calendar.html', 'schedule-order.html', 'presentations.html']) {
    assert.match(read(file), /css\/style\.css\?v=20260725\.5/);
  }
  for (const file of ['index.html', 'schedule-calendar.html', 'schedule-order.html']) {
    assert.match(read(file), /js\/schedule-shared\.js\?v=20260725\.5/);
  }
  assert.doesNotMatch(read('app.html'), /js\/schedule-shared\.js/);
  assert.match(read('sw.js'), /sss-pwa-v20260725-5/);
  assert.doesNotMatch(read('sw.js'), /ignoreSearch\s*:\s*true/);
  assert.equal(
    (read('sw.js').match(/caches\.match\(request\)/g) || []).length,
    2,
  );
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
  assert.match(source, /if \(!\['industry', 'stock'\]\.includes\(schedule\.category\)\) return \[\]/);
});

test('schedule table shows escaped presentation topics from the effective roster', () => {
  const source = read('schedule-calendar.html');
  const tableRenderer = sourceSection(
    source,
    'function renderScheduleList',
    '// ── 폼',
  );
  const topicHelper = sourceSection(
    source,
    'function getPresentationTopicLabel',
    'async function reconcileAutomaticPresentationAssignments',
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(topicHelper, context);

  assert.match(source, /<th>발표자·종목<\/th>/);
  assert.equal((source.match(/colspan="8"/g) || []).length, 2);
  assert.match(tableRenderer, /getSchedulePresentations\(schedule\.id, schedule\.event_date\)/);
  assert.match(tableRenderer, /class="schedule-table-presentations"/);
  assert.match(tableRenderer, /escapeHtml\(p\.members\?\.name \|\| '발표자 미정'\)/);
  assert.match(tableRenderer, /escapeHtml\(getPresentationTopicLabel\(p\)\)/);
  assert.match(tableRenderer, /if \(!\['industry', 'stock'\]\.includes\(schedule\.category\)\) return \[\]/);
  assert.equal(context.getPresentationTopicLabel({ topic: '반도체 > 삼성전자' }), '삼성전자');
  assert.equal(context.getPresentationTopicLabel({ topic: null }), '종목 미입력');
});
