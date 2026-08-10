const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function loadPortfolioHelpers() {
  const context = { Map };
  vm.createContext(context);
  vm.runInContext(read('js/utils/portfolio.js'), context, {
    filename: 'js/utils/portfolio.js',
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('portfolio snapshot combines cash, live holdings and unrealized return', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot(
    [{ base_amount: 1_000_000 }],
    [{
      id: 'pick-a',
      status: 'hold',
      stock_name: 'A 종목',
      stock_code: '000001',
      buy_price: 100,
      buy_quantity: 3_000,
    }],
    [{ trade_type: 'buy', price: 100, quantity: 3_000 }],
    { '000001': { price: 120 } }
  ));

  assert.equal(snapshot.cash, 700_000);
  assert.equal(snapshot.totalCost, 300_000);
  assert.equal(snapshot.totalPositionValue, 360_000);
  assert.equal(snapshot.totalAsset, 1_060_000);
  assert.equal(snapshot.unrealizedPnl, 60_000);
  assert.equal(snapshot.unrealizedRate, 20);
  assert.equal(snapshot.priceMatchedCount, 1);
  assert.deepEqual(
    snapshot.allocations.map(item => [item.label, Math.round(item.share)]),
    [['A 종목', 34], ['현금', 66]]
  );
});

test('unpriced holdings use cost only for allocation and keep returns unknown', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot(
    [{ base_amount: 500_000 }],
    [{
      id: 'pick-a',
      status: 'hold',
      stock_name: '가격 대기',
      stock_code: '000002',
      buy_price: 50_000,
      buy_quantity: 2,
    }],
    [{ trade_type: 'buy', price: 50_000, quantity: 2 }],
    {}
  ));

  assert.equal(snapshot.totalPositionValue, 100_000);
  assert.equal(snapshot.totalAsset, 500_000);
  assert.equal(snapshot.positions[0].currentValue, null);
  assert.equal(snapshot.positions[0].returnRate, null);
  assert.equal(snapshot.unrealizedPnl, null);
  assert.equal(snapshot.priceMatchedCount, 0);
});

test('portfolio snapshot excludes waiting, sold and virtual carry rows', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot([], [
    { id: 'waiting', status: 'hold', buy_price: 0, buy_quantity: 0 },
    { id: 'sold', status: 'sold', buy_price: 100, buy_quantity: 1 },
    { id: 'virtual', status: 'hold', buy_price: 100, buy_quantity: 1, _isCarryFallback: true },
    { id: 'live', status: 'hold', stock_name: '실보유', buy_price: 100, buy_quantity: 1 },
  ], [], {}));

  assert.deepEqual(snapshot.positions.map(position => position.id), ['live']);
});

test('portfolio allocation combines duplicate positions in the same stock', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot([], [
    { id: 'a1', status: 'hold', stock_name: 'A', stock_code: '000001', buy_price: 100, buy_quantity: 1 },
    { id: 'a2', status: 'hold', stock_name: 'A', stock_code: '000001', buy_price: 100, buy_quantity: 2 },
  ], [], { '000001': { price: 110 } }));

  assert.equal(snapshot.allocations.length, 1);
  assert.equal(snapshot.allocations[0].value, 330);
  assert.equal(snapshot.allocations[0].share, 100);
});

test('portfolio snapshot keeps holdings and cash inside the active member scope', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot(
    [{ id: 'active', base_amount: 1_000 }],
    [
      { id: 'active-pick', member_id: 'active', status: 'hold', stock_code: '000001', buy_price: 100, buy_quantity: 1 },
      { id: 'inactive-pick', member_id: 'inactive', status: 'hold', stock_code: '000002', buy_price: 500, buy_quantity: 1 },
    ],
    [
      { member_id: 'active', trade_type: 'buy', price: 100, quantity: 1 },
      { member_id: 'inactive', trade_type: 'buy', price: 500, quantity: 1 },
    ],
    { '000001': { price: 110 }, '000002': { price: 900 } }
  ));

  assert.equal(snapshot.cash, 900);
  assert.equal(snapshot.totalAsset, 1_010);
  assert.deepEqual(snapshot.positions.map(position => position.id), ['active-pick']);
});

test('home dashboard places portfolio chart and holdings table above monthly picks', () => {
  const index = read('index.html');
  const portfolioStart = index.indexOf('id="portfolioOverview"');
  const topPicksStart = index.indexOf('class="card top-picks-card');

  assert.notEqual(portfolioStart, -1);
  assert.ok(topPicksStart > portfolioStart);
  assert.match(index, /class="portfolio-overview-grid desktop-home-dashboard"/);
  assert.match(index, /id="portfolioDonut"[^>]+role="img"/);
  assert.match(index, /id="portfolioHoldingsTbody"/);
  assert.match(index, /<caption class="sr-only">현재 보유 중인 종목별 수량, 평가금액과 수익률<\/caption>/);
  assert.match(index, /<th scope="col">종목<\/th>/);
  assert.match(index, /function renderPortfolioOverview\(/);
  assert.match(index, /renderPortfolioOverview\(currentPortfolioContext, globalPriceMap\)/);
  assert.match(index, /js\/utils\/portfolio\.js\?v=/);
  assert.match(read('css/style.css'), /\.portfolio-overview-grid/);
  assert.match(read('sw.js'), /\.\/js\/utils\/portfolio\.js/);
});
