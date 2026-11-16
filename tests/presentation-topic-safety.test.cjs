const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function section(file, start, end) {
  const source = read(file);
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function helpers(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  vm.runInContext(read('js/schedule-shared.js'), ctx);
  vm.runInContext(section('js/config.js', 'function escapeHtml', 'function navigateToAppRoute'), ctx);
  return ctx;
}

test('home planned and completed presentation titles render tags as text', async () => {
  const nodes = { myPresPlanned: { style: {} }, myPresTbody: {} };
  const ctx = helpers({ document: { getElementById: id => nodes[id] }, dashboardPresentationSchedules: [],
    calcReturnRate: () => null,
  });
  vm.runInContext(section('index.html', 'async function renderMyPresData', '// 하위 호환 (팝업 닫힐 때 호출되는 기존 함수명 유지)'), ctx);
  const title = '<img src=x onerror="void 0"> 수요 > 공급 & 전망';
  for (const prefix of ['[자유 주제] ', '27년전망 > [자유 주제] ']) {
    const row = { category: 'industry', schedule_id: 'round', topic: prefix + title };
    await ctx.renderMyPresData({}, [{ ...row, status: 'planned' }, { ...row, status: 'done' }], {});
    for (const node of Object.values(nodes)) {
      assert.ok(node.innerHTML.includes(ctx.escapeHtml('[기타] ' + title)));
      assert.doesNotMatch(node.innerHTML, /<img\b|<svg\b|<script\b/i);
    }
  }
});

test('calendar, shared cards and editor preserve full other-topic comparisons', () => {
  const ctx = helpers();
  vm.runInContext(section('schedule-calendar.html', 'function getPresentationTopicLabel', 'async function loadScheduleIndustryTitleContext'), ctx);
  for (const prefix of ['[자유 주제] ', '27년전망 > [자유 주제] ']) {
    const row = { category: 'industry', topic: prefix + '수요 > 공급 > 재고' };
    assert.equal(ctx.parsePresentationStockName(row), '수요 > 공급 > 재고');
    assert.equal(ctx.getPresentationTopicLabel(row), '[기타] 수요 > 공급 > 재고');
    assert.equal(ctx.getPresentationDisplayInfo(row).topic, '[기타] 수요 > 공급 > 재고');
    assert.equal(ctx.getPresentationScheduleTopicParts(row).industry, prefix.startsWith('27') ? '27년전망' : '');
  }
  assert.equal(ctx.getPresentationTopicLabel({ topic: '' }), '종목 미입력');
  assert.equal(ctx.formatPresentationTopicLabel({ topic: '반도체 > 삼성전자' }), '삼성전자');
});

test('actual schedule category update retains other format, comparison title, and details', async () => {
  const writes = [];
  const rows = [
    { id: 'with-theme', topic: '27년전망 > [자유 주제] 수요 > 공급', reason: '핵심 전망', risk: '변수' },
    { id: 'no-theme', topic: '[자유 주제] 수요 > 공급', reason: '별도 의견' },
    { id: 'stock', topic: '반도체 > 삼성전자', stock_code: '005930' },
  ];
  const ctx = helpers({ category: 'stock', linkedPlanned: rows,
    sb: { from: () => ({ update: payload => ({ eq: async (_, id) => { writes.push({ id, payload }); return { error: null }; } }) }) },
  });
  const block = section('schedule-calendar.html', '      const results = await Promise.all(linkedPlanned.map(presentation => {', '\n    // 발표 목록과 일정 목록을 함께 갱신');
  // The excerpt includes the enclosing if's closing brace.
  await vm.runInContext('(async () => { if (true) {\n' + block + '\n})()', ctx);
  for (const original of rows.slice(0, 2)) {
    const saved = { ...original, ...writes.find(row => row.id === original.id).payload };
    assert.equal(saved.topic, '[자유 주제] 수요 > 공급');
    assert.equal(saved.category, 'stock');
    assert.equal(saved.reason, original.reason);
    assert.equal(saved.risk, original.risk);
    assert.equal(ctx.isFreePresentation(saved), true);
    assert.equal(ctx.parsePresentationStockName(saved), '수요 > 공급');
  }
  assert.equal(writes[2].payload.topic, '삼성전자');
  assert.equal(Object.hasOwn(writes[2].payload, 'stock_code'), false);
});

test('other topic survives switching from company back to industry and saving again', () => {
  const ctx = helpers();
  const row = { category: 'industry', topic: '[자유 주제] 수요 > 공급' };
  const payload = ctx.presentationContentPayload(row, { format: 'free', title: ctx.parsePresentationStockName(row), reason: '수정 내용' });
  assert.equal(payload.topic, row.topic);
  assert.equal(ctx.isFreePresentation(payload), true);
  assert.equal(payload.reason, '수정 내용');
});
