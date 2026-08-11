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
    [{ id: 'member-a', base_amount: 1_000_000 }],
    [{
      id: 'pick-a',
      member_id: 'member-a',
      status: 'hold',
      stock_name: 'A 종목',
      stock_code: '000001',
      buy_price: 100,
      buy_quantity: 3_000,
    }],
    [{ pick_id: 'pick-a', member_id: 'member-a', trade_type: 'buy', price: 100, quantity: 3_000 }],
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
    [{ id: 'member-a', base_amount: 500_000 }],
    [{
      id: 'pick-a',
      member_id: 'member-a',
      status: 'hold',
      stock_name: '가격 대기',
      stock_code: '000002',
      buy_price: 50_000,
      buy_quantity: 2,
    }],
    [{ pick_id: 'pick-a', member_id: 'member-a', trade_type: 'buy', price: 50_000, quantity: 2 }],
    {}
  ));

  assert.equal(snapshot.totalPositionValue, 100_000);
  assert.equal(snapshot.totalAsset, null);
  assert.equal(snapshot.estimatedTotalAsset, 500_000);
  assert.equal(snapshot.positions[0].currentValue, null);
  assert.equal(snapshot.positions[0].returnRate, null);
  assert.equal(snapshot.unrealizedPnl, null);
  assert.equal(snapshot.priceMatchedCount, 0);
});

test('settled trades are not subtracted from the updated member balance twice', () => {
  const { buildMemberPortfolioValuation } = loadPortfolioHelpers();
  const valuation = plain(buildMemberPortfolioValuation(
    { id: 'member-a', base_amount: 406_187 },
    [
      { pick_id: 'settled', member_id: 'member-a', status: 'sold', stock_name: '과거종목', stock_code: '000001' },
      { pick_id: 'current', member_id: 'member-a', status: 'hold', stock_name: '현재종목', stock_code: '000002' },
    ],
    [
      { pick_id: 'settled', member_id: 'member-a', trade_type: 'buy', price: 51_400, quantity: 9, traded_at: '2026-04-01' },
      { pick_id: 'settled', member_id: 'member-a', trade_type: 'sell', price: 40_700, quantity: 9, traded_at: '2026-05-01' },
      { pick_id: 'current', member_id: 'member-a', trade_type: 'buy', price: 18_030, quantity: 22, traded_at: '2026-06-01' },
    ],
    { '000002': { price: 20_000 } },
    500_000
  ));

  assert.equal(valuation.cash, 9_527);
  assert.equal(valuation.totalCost, 396_660);
  assert.equal(valuation.totalMarketValue, 440_000);
  assert.equal(valuation.totalAsset, 449_527);
  assert.equal(valuation.totalProfit, -50_473);
  assert.equal(Math.round(valuation.totalReturnRate * 100) / 100, -10.09);
});

test('partial sales use remaining quantity and preserve sale proceeds as cash', () => {
  const { buildMemberPortfolioValuation } = loadPortfolioHelpers();
  const valuation = plain(buildMemberPortfolioValuation(
    { id: 'member-a', base_amount: 507_856 },
    [{ pick_id: 'open', member_id: 'member-a', status: 'hold', stock_name: '부분매도', stock_code: '000001' }],
    [
      { pick_id: 'open', member_id: 'member-a', trade_type: 'buy', price: 10_000, quantity: 10, traded_at: '2026-04-01' },
      { pick_id: 'open', member_id: 'member-a', trade_type: 'sell', price: 12_000, quantity: 4, traded_at: '2026-05-01' },
    ],
    { '000001': { price: 11_000 } },
    500_000
  ));

  assert.equal(valuation.positions[0].quantity, 6);
  assert.equal(valuation.positions[0].buyPrice, 10_000);
  assert.equal(valuation.cash, 447_856);
  assert.equal(valuation.totalMarketValue, 66_000);
  assert.equal(valuation.totalAsset, 513_856);
  assert.equal(valuation.totalReturnRate, 2.7712);
});

test('same-day partial sale and additional buy follow creation order and recalculate average cost', () => {
  const { buildMemberPortfolioValuation } = loadPortfolioHelpers();
  const valuation = plain(buildMemberPortfolioValuation(
    { id: 'member-a', base_amount: 507_856 },
    [{ pick_id: 'open', member_id: 'member-a', status: 'hold', stock_name: '추가매수', stock_code: '000001' }],
    [
      { id: '3', pick_id: 'open', member_id: 'member-a', trade_type: 'buy', price: 13_000, quantity: 2, traded_at: '2026-06-01T03:00:00Z', created_at: '2026-06-01T03:02:00Z' },
      { id: '2', pick_id: 'open', member_id: 'member-a', trade_type: 'sell', price: 12_000, quantity: 4, traded_at: '2026-06-01T03:00:00Z', created_at: '2026-06-01T03:01:00Z' },
      { id: '1', pick_id: 'open', member_id: 'member-a', trade_type: 'buy', price: 10_000, quantity: 10, traded_at: '2026-06-01T03:00:00Z', created_at: '2026-06-01T03:00:00Z' },
    ],
    { '000001': { price: 12_000 } },
    500_000
  ));

  assert.equal(valuation.positions[0].quantity, 8);
  assert.equal(valuation.positions[0].buyPrice, 10_750);
  assert.equal(valuation.cash, 421_856);
  assert.equal(valuation.totalAsset, 517_856);
  assert.equal(valuation.totalReturnRate, 3.5712);
});

test('an automatically settled full sale remains in cash without leaving a ghost holding', () => {
  const { buildMemberPortfolioValuation } = loadPortfolioHelpers();
  const valuation = plain(buildMemberPortfolioValuation(
    { id: 'member-a', base_amount: 519_640 },
    [{ pick_id: 'open', member_id: 'member-a', status: 'sold', stock_name: '매도완료', stock_code: '000001' }],
    [
      { pick_id: 'open', member_id: 'member-a', trade_type: 'buy', price: 10_000, quantity: 10, traded_at: '2026-04-01' },
      { pick_id: 'open', member_id: 'member-a', trade_type: 'sell', price: 12_000, quantity: 10, traded_at: '2026-05-01' },
    ],
    {},
    500_000
  ));

  assert.equal(valuation.positions.length, 0);
  assert.equal(valuation.cash, 519_640);
  assert.equal(valuation.totalAsset, 519_640);
  assert.equal(valuation.totalReturnRate, 3.928);
});

test('portfolio snapshot excludes waiting, sold and virtual carry rows', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot([{ id: 'member-a', base_amount: 100 }], [
    { id: 'waiting', member_id: 'member-a', status: 'hold', buy_price: 0, buy_quantity: 0 },
    { id: 'sold', member_id: 'member-a', status: 'sold', buy_price: 100, buy_quantity: 1 },
    { id: 'virtual', member_id: 'member-a', status: 'hold', buy_price: 100, buy_quantity: 1, _isCarryFallback: true },
    { id: 'live', member_id: 'member-a', status: 'hold', stock_name: '실보유', buy_price: 100, buy_quantity: 1 },
  ], [], {}));

  assert.deepEqual(snapshot.positions.map(position => position.id), ['live']);
});

test('portfolio allocation combines duplicate positions in the same stock', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot([{ id: 'member-a', base_amount: 300 }], [
    { id: 'a1', member_id: 'member-a', status: 'hold', stock_name: 'A', stock_code: '000001', buy_price: 100, buy_quantity: 1 },
    { id: 'a2', member_id: 'member-a', status: 'hold', stock_name: 'A', stock_code: '000001', buy_price: 100, buy_quantity: 2 },
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

test('portfolio snapshot fails closed when there are no active members', () => {
  const { buildPortfolioSnapshot } = loadPortfolioHelpers();
  const snapshot = plain(buildPortfolioSnapshot(
    [],
    [{ id: 'stale', member_id: 'inactive', status: 'hold', stock_code: '000001', buy_price: 100, buy_quantity: 1 }],
    [{ pick_id: 'stale', member_id: 'inactive', trade_type: 'buy', price: 100, quantity: 1 }],
    { '000001': { price: 110 } }
  ));

  assert.equal(snapshot.totalAsset, 0);
  assert.equal(snapshot.positions.length, 0);
  assert.equal(snapshot.allocations.length, 0);
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
