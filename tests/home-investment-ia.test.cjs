const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('home shares one action-first information structure across viewports', () => {
  const home = read('index.html');
  const actions = ['next-study', 'next-presentation', 'monthly-idea', 'fund-summary'];
  const positions = actions.map(action => home.indexOf(`data-home-action="${action}"`));

  positions.forEach(position => assert.notEqual(position, -1));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(home, /id="mobileActionHome" class="home-command-center"/);
  assert.doesNotMatch(home, /id="mobileActionHome" class="[^"]*mobile-only/);
  assert.match(home, /schedule-calendar\?schedule=/);
  assert.match(home, /presentations\?view=prepare/);
  assert.match(home, /picks\?view=holding/);
  assert.match(home, /function renderHomePriorities\(/);
  assert.ok(home.indexOf('data-home-action="fund-summary"') < home.indexOf('id="portfolioOverview"'));
});

test('investment lifecycle uses accessible buttons and exclusive tab panels', () => {
  const picks = read('picks.html');

  assert.match(picks, /id="investmentViewTabs"[^>]+role="tablist"/);
  for (const [key, panel] of [
    ['ideas', 'investmentPanelIdeas'],
    ['holding', 'investmentPanelHolding'],
    ['completed', 'investmentPanelCompleted'],
  ]) {
    assert.match(picks, new RegExp(`<button[^>]+role="tab"[^>]+aria-controls="${panel}"[^>]+data-investment-view="${key}"`));
    assert.match(picks, new RegExp(`id="${panel}"[^>]+role="tabpanel"`));
  }
  assert.doesNotMatch(picks, /<div[^>]+class="[^"]*\btab\b[^"]*"[^>]+onclick=/);
  assert.match(picks, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(picks, /function setInvestmentView\(/);
  assert.match(picks, /const ideaMonth = currentMonth\(\)/);
  assert.match(picks, /params\.set\('view', view\)/);
  assert.match(picks, /class="investment-search"[\s\S]*?class="sr-only">투자 기록 검색/);
  assert.match(picks, /id="investmentSearch" aria-label="투자 기록 검색"/);
  assert.match(picks, /<details class="investment-ledger-details">/);
});

test('investment lifecycle classification keeps ideas, live holdings and completed records separate', () => {
  const context = { console, Set };
  vm.createContext(context);
  vm.runInContext(read('js/db.js'), context, { filename: 'js/db.js' });
  const source = read('picks.html');
  vm.runInContext(
    sourceSection(source, 'function investmentState', 'function investmentCurrentPrice') +
      sourceSection(source, 'function partitionInvestmentItems', 'function investmentCardMarkup'),
    context,
    { filename: 'picks.html#investment-partition' }
  );

  const rows = [
    { id: 'idea-a', member_id: 'a', month: '2026-07', stock_code: 'A', status: 'hold', buy_price: 0, buy_quantity: 0 },
    { id: 'old-b', member_id: 'b', month: '2026-07', stock_code: 'B0', status: 'hold', buy_price: 0, buy_quantity: 0 },
    { id: 'idea-b', member_id: 'b', month: '2026-08', stock_code: 'B1', status: 'hold', buy_price: 0, buy_quantity: 0 },
    { id: 'holding-c', member_id: 'inactive', month: '2026-06', stock_code: 'C', status: 'hold', buy_price: 100, buy_quantity: 2 },
    { id: 'old-held-d', member_id: 'a', month: '2026-05', stock_code: 'D', status: 'hold', buy_price: 100, buy_quantity: 1 },
    { id: 'sold-d', member_id: 'a', month: '2026-07', carried_from: '2026-05', stock_code: 'D', status: 'sold', buy_price: 100, buy_quantity: 0, realized_return: 10 },
  ];
  const result = plain(context.partitionInvestmentItems('2026-08', rows, [{ id: 'a' }, { id: 'b' }]));

  assert.deepEqual(result.ideas.map(item => item.id), ['idea-b', 'idea-a']);
  assert.equal(result.ideas.find(item => item.id === 'idea-a')._isCarryFallback, true);
  assert.deepEqual(result.holding.map(item => item.id), ['holding-c']);
  assert.deepEqual(result.completed.map(item => item.id), ['sold-d']);
});

test('investment tab state synchronizes aria, panels and the route', () => {
  const views = ['ideas', 'holding', 'completed'];
  const tabs = views.map(view => ({
    dataset: { investmentView: view },
    attrs: {},
    tabIndex: -1,
    focused: false,
    setAttribute(name, value) { this.attrs[name] = value; },
    focus() { this.focused = true; },
  }));
  const panels = Object.fromEntries(views.map(view => [
    `investmentPanel${view[0].toUpperCase()}${view.slice(1)}`,
    { hidden: false },
  ]));
  const context = {
    investmentViews: views,
    activeInvestmentView: 'ideas',
    document: {
      querySelectorAll: selector => selector === '[data-investment-view]' ? tabs : [],
      getElementById: id => panels[id],
    },
    renderInvestmentWorkspace() { context.rendered = true; },
    syncInvestmentViewRoute(view) { context.routed = view; },
  };
  vm.createContext(context);
  const source = read('picks.html');
  vm.runInContext(
    sourceSection(source, 'function setInvestmentView', 'function renderInvestmentCards'),
    context,
    { filename: 'picks.html#investment-tabs' }
  );

  context.setInvestmentView('holding', { focus: true });
  assert.deepEqual(tabs.map(tab => tab.attrs['aria-selected']), ['false', 'true', 'false']);
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, 0, -1]);
  assert.equal(tabs[1].focused, true);
  assert.deepEqual(views.map(view => panels[`investmentPanel${view[0].toUpperCase()}${view.slice(1)}`].hidden), [true, false, true]);
  assert.equal(context.routed, 'holding');
  assert.equal(context.rendered, true);
});

test('raw carry-chain links resolve to the latest sold or held state', () => {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(read('js/db.js'), context, { filename: 'js/db.js' });
  const source = read('picks.html');
  vm.runInContext(
    sourceSection(source, 'function resolveLatestInvestmentChainPick', 'function investmentCardMarkup'),
    context,
    { filename: 'picks.html#investment-chain-resolution' }
  );
  const rows = [
    { id: 'origin', member_id: 'a', month: '2026-05', stock_code: 'A', status: 'hold' },
    { id: 'carried', member_id: 'a', month: '2026-06', carried_from: '2026-05', stock_code: 'A', status: 'hold' },
    { id: 'sold', member_id: 'a', month: '2026-07', carried_from: '2026-05', stock_code: 'A', status: 'sold' },
  ];

  assert.equal(context.resolveLatestInvestmentChainPick(rows[0], rows).id, 'sold');
  assert.equal(context.resolveLatestInvestmentChainPick(rows[1], rows).id, 'sold');
});

test('investment detail clears stale actions before asynchronous trade loading', () => {
  const picks = read('picks.html');
  const detail = sourceSection(picks, 'async function openInvestmentDetail', 'function closeInvestmentDetail');
  const awaitTrades = detail.indexOf('const { data: trades } = await');

  assert.ok(detail.indexOf('detailBuyButton.onclick = null') < awaitTrades);
  assert.ok(detail.indexOf('detailSellButton.onclick = null') < awaitTrades);
  assert.ok(detail.indexOf('detailShareButton.disabled = true') < awaitTrades);
  assert.match(detail, /investmentDetailId !== detailToken/);
  assert.match(picks, /params\.set\('view', activeInvestmentView\)/);
});

test('completed investment cards and details use realized results, not live valuation', () => {
  const picks = read('picks.html');
  const completedCard = sourceSection(picks, "if (mode === 'completed')", 'const rate = investmentReturn');
  const soldDetail = sourceSection(picks, "const detailHero = state.key === 'sold'", 'detailBody.innerHTML');

  assert.match(completedCard, /확정 수익률/);
  assert.doesNotMatch(completedCard, /평가손익|현재가/);
  assert.match(soldDetail, /매도가/);
  assert.match(soldDetail, /확정 수익률/);
});

test('home and investment pages keep unique element ids', () => {
  for (const file of ['index.html', 'picks.html']) {
    const ids = [...read(file).matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file} contains a duplicate id`);
  }
});
