const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
function context(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  return ctx;
}
function section(file, start, end) {
  const source = read(file);
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
test('industry category and missing stock code never imply a free topic', () => {
  const ctx = context();
  for (const topic of ['반도체 > 삼성전자', '클라우드 > Microsoft', 'Tesla']) {
    const row = { category: 'industry', topic, stock_code: null, price_at: 100 };
    assert.equal(ctx.isFreePresentation(row), false);
    assert.equal(ctx.getPresentationReturnBase(row), 100);
  }
  const free = { category: 'industry', topic: '2027 전망 > [자유 주제] 반도체', price_at: 100, stock_code: '005930' };
  assert.equal(ctx.isFreePresentation(free), true);
  assert.equal(ctx.parsePresentationStockName(free), '반도체');
  assert.equal(ctx.getPresentationReturnBase(free), null);
  assert.equal(ctx.isAutomaticPresentationPrice(free), false);
});

test('stock details keep their price association when unchanged', () => {
  const ctx = context();
  const draft = { topic: '반도체 > 삼성전자', stock_code: '005930', price_at: 100 };
  const payload = ctx.presentationContentPayload(draft, { format: 'stock', title: '삼성전자', market_cap_at: 200, target_cap: 300 });
  assert.equal(payload.topic, draft.topic);
  assert.equal(Object.hasOwn(payload, 'stock_code'), false);
  assert.equal(Object.hasOwn(payload, 'price_at'), false);
});

test('a free title can contain a comparison sign without turning into a stock', () => {
  const ctx = context();
  const row = { category: 'industry', topic: '[자유 주제] 수요 > 공급' };
  assert.equal(ctx.isFreePresentation(row), true);
  assert.equal(ctx.parsePresentationIndustry(row), null);
  assert.equal(ctx.parsePresentationStockName(row), '수요 > 공급');
  assert.equal(ctx.presentationContentPayload(row, { format: 'free', title: '공급 전망' }).topic, '[자유 주제] 공급 전망');
});

test('free topics matching stock names are excluded from price lookup and statistics', async () => {
  const free = { topic: '2027 전망 > [자유 주제] 삼성전자', category: 'industry', stock_code: null };
  const stock = { topic: '반도체 > 삼성전자', category: 'industry', stock_code: null };
  const requests = [];
  const ctx = context({ allData: [free, stock], priceMap: {},
    fetchPriceMapByCodes: async codes => { requests.push([...codes]); return {}; },
    fetchPriceRowsByNames: async names => { requests.push([...names]); return [{ stock_code: '005930', stock_name: '삼성전자', price: 100 }]; },
    normalizePriceRow: row => row, mergePriceMaps: (...maps) => Object.assign({}, ...maps),
    buildPriceMap: rows => Object.fromEntries(rows.map(row => [row.stock_code, row])),
    parseStockName: row => row.topic.split('>').pop().trim(),
  });
  ctx.parseStockName = ctx.parsePresentationStockName;
  vm.runInContext(section('presentations.html', 'async function loadPresentationPriceContext', 'function applyFilter'), ctx);
  vm.runInContext(section('presentations.html', 'function getCurPrice', 'function getReturn'), ctx);
  await ctx.loadPresentationPriceContext();
  assert.deepEqual(requests, [[], ['삼성전자']]);
  assert.equal(free.stock_code, null);
  assert.equal(stock.stock_code, '005930');
  assert.equal(ctx.getCurPrice(free), null);
  assert.equal(ctx.getCurPrice(stock).price, 100);
});

test('free detail displays escaped contents, hides investment conversion, and never queries picks', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {} }, querySelector: () => ({ focus() {} }) });
    return elements.get(id);
  };
  const ctx = context({ allData: [{ id: 'free', topic: '전망 > [자유 주제] 반도체', reason: '<b>전망</b>', status: 'done' }],
    document: { getElementById: element, body: { style: {} } },
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    sb: { from() { throw Error('unexpected stock query'); } },
  });
  ctx.parseStockName = ctx.parsePresentationStockName;
  ctx.parseIndustry = ctx.parsePresentationIndustry;
  vm.runInContext(section('presentations.html', 'async function openPresentationDetail', 'function closePresentationDetail'), ctx);
  await ctx.openPresentationDetail('free');
  assert.equal(element('presentationConvertBtn').hidden, true);
  assert.match(element('presentationDetailBody').innerHTML, /핵심 전망/);
  assert.match(element('presentationDetailBody').innerHTML, /&lt;b&gt;전망&lt;\/b&gt;/);
  assert.doesNotMatch(element('presentationDetailBody').innerHTML, /현재가|수익률|목표주가/);
});

test('direct investment conversion also rejects a free topic without stock search or insertion', async () => {
  const messages = [];
  const ctx = context({ toast: message => messages.push(message), sb: { from: () => ({
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { topic: '[자유 주제] 클라우드' } }),
  }) } });
  vm.runInContext(section('picks.html', 'async function openPickFromPresentation', 'function toggleInvestmentFilters'), ctx);
  await ctx.openPickFromPresentation('free');
  assert.match(messages[0], /자유 주제/);
});

test('renaming a shared outlook preserves mixed presentation formats and individual titles', async () => {
  const rows = [
    { id: 'free', category: 'industry', status: 'planned', schedule_id: 'round', topic: '전망 > [자유 주제] 수요 > 공급' },
    { id: 'stock', category: 'industry', status: 'planned', schedule_id: 'round', topic: '전망 > 삼성전자' },
    { id: 'other', category: 'industry', status: 'planned', schedule_id: 'other', topic: '다른 회차 > 원익IPS' },
  ];
  const ctx = context({ presentations: rows, industrySaveToken: 0, setConfig: async () => {},
    document: { getElementById: () => null },
    sb: { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) },
  });
  vm.runInContext(section('schedule-order.html', 'async function persistTurnIndustryName', 'async function ensureIndustryNameSaved'), ctx);
  assert.equal(await ctx.persistTurnIndustryName({ key: 'round-theme', name: '2027년 전망', scheduleId: 'round', requestToken: 1, opts: { silent: true } }), true);
  assert.equal(rows[0].topic, '2027년 전망 > [자유 주제] 수요 > 공급');
  assert.equal(ctx.isFreePresentation(rows[0]), true);
  assert.equal(rows[1].topic, '2027년 전망 > 삼성전자');
  assert.equal(ctx.isFreePresentation(rows[1]), false);
  assert.equal(rows[2].topic, '다른 회차 > 원익IPS');
});
