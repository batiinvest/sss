const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../js/utils/corporate-actions.js'), 'utf8'), context);
const { replayCorporatePosition: replay, adjustedIdeaPrice, validateBonusAction } = context;
const action = { id: 'rf-1', stock_code: '327260', existing_shares: 1, new_shares: 1,
  ex_date: '2026-07-24', record_date: '2026-07-27', credit_date: '2026-08-18', status: 'applied' };
const trade = (type, quantity, price, date) => ({ trade_type: type, quantity, price, traded_at: date + 'T12:00:00+09:00' });
const buy = trade('buy', 6, 75500, '2026-04-20');
const at = asOf => ({ asOf });

test('RF 1:1 doubles eligible shares and preserves acquisition cost', () => {
  const result = replay([buy], [action], at('2026-09-20'));
  assert.equal(result.quantity, 12);
  assert.equal(result.tradableQuantity, 12);
  assert.equal(result.averagePrice, 37750);
  assert.equal(result.cost, 453000);
  assert.equal(result.realizedPnl, 0);
  assert.equal(result.history.length, 1);
});
test('bonus rights enter valuation at ex date but cannot be sold before credit', () => {
  const result = replay([buy], [action], at('2026-07-24T00:00:00+09:00'));
  assert.equal(result.quantity, 12);
  assert.equal(result.pendingQuantity, 6);
  assert.equal(result.tradableQuantity, 6);
  assert.throws(() => replay([buy, trade('sell', 7, 40000, '2026-08-01')], [action], at('2026-09-20')), /매도 가능/);
});
test('selling all old shares after ex date keeps entitlement and allocated cost', () => {
  const trades = [buy, trade('sell', 6, 40000, '2026-08-01')];
  const pending = replay(trades, [action], at('2026-08-02'));
  assert.equal(pending.pendingQuantity, 6);
  assert.equal(pending.tradableQuantity, 0);
  assert.equal(pending.cost, 226500);
  assert.equal(pending.realizedPnl, 13500);
  assert.equal(replay(trades, [action], at('2026-09-20')).tradableQuantity, 6);
});
test('post-ex purchases are not entitled and pre-ex sales reduce entitlement', () => {
  const result = replay([buy, trade('sell', 2, 80000, '2026-07-23'), trade('buy', 2, 40000, '2026-07-24')], [action], at('2026-09-20'));
  assert.equal(result.quantity, 10);
  assert.equal(result.history[0].addedQuantity, 4);
  assert.equal(result.cost, 382000);
  assert.equal(replay([trade('buy', 2, 40000, '2026-07-24')], [action], at('2026-09-20')).quantity, 2);
});
test('credit requires actual date; expected credit never unlocks shares', () => {
  const result = replay([buy], [{ ...action, credit_date: null, expected_credit_date: '2026-08-18' }], at('2026-09-20'));
  assert.equal(result.pendingQuantity, 6);
  assert.equal(result.tradableQuantity, 6);
});
test('future events and trades do not enter past valuations', () => {
  assert.equal(replay([buy], [action], at('2026-07-23')).quantity, 6);
  assert.equal(replay([buy], [action], at('2026-04-19')).quantity, 0);
});
test('subsequent bonuses compound once and do not mutate source trades', () => {
  const second = { ...action, id: 'second', ex_date: '2026-09-01', record_date: '2026-09-03', credit_date: '2026-09-10' };
  assert.equal(replay([buy], [second, action], at('2026-09-20')).quantity, 24);
  assert.equal(buy.quantity, 6);
  assert.throws(() => replay([buy], [action, action]), /중복/);
});
test('fractional and overlapping entitlements require explicit resolution', () => {
  assert.throws(() => replay([trade('buy', 1, 100, '2026-04-20')], [{ ...action, existing_shares: 2 }]), /단수주/);
  const overlap = { ...action, id: 'overlap', ex_date: '2026-08-01', record_date: '2026-08-03' };
  assert.throws(() => replay([buy], [action, overlap]), /미입고/);
});
test('invalid dates and nonpositive ratios are rejected', () => {
  assert.throws(() => validateBonusAction({ ...action, ex_date: '2026-02-30' }), /날짜/);
  assert.throws(() => validateBonusAction({ ...action, new_shares: 0 }), /양의 정수/);
});
test('idea price adjustment uses its own basis date and retains original', () => {
  assert.equal(adjustedIdeaPrice(93300, '2026-04-01', [action], '2026-09-20'), 46650);
  assert.equal(adjustedIdeaPrice(40000, '2026-07-24', [action], '2026-09-20'), 40000);
  assert.equal(adjustedIdeaPrice(93300, '2026-04-01', [action], '2026-07-23'), 93300);
});

test('server position overrides raw trades once and rejects pre-ex quotes', () => {
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../js/utils/portfolio.js'), 'utf8'), context);
  const pick = { pick_id: 'p', member_id: 'm', stock_code: '327260', status: 'hold',
    _corporatePosition: replay([buy], [action], at('2026-09-20')) };
  const trades = [{ ...buy, pick_id: 'p', member_id: 'm' }];
  const member = { id: 'm', base_amount: 500000 };
  const quote = { '327260': { price: 48500, updatedAt: '2026-09-18T12:00:00Z' } };
  const snapshot = context.buildMemberPortfolioValuation(member, [pick], trades, quote);
  assert.equal(snapshot.positions[0].quantity, 12);
  assert.equal(snapshot.totalCost, 453000);
  assert.equal(snapshot.cash, 47000);
  assert.equal(snapshot.totalAsset, 629000);
  const stale = context.buildMemberPortfolioValuation(member, [pick], trades,
    { '327260': { price: 75500, updatedAt: '2026-07-23T12:00:00Z' } });
  assert.equal(stale.totalAsset, null);
  assert.equal(stale.totalCost, 453000);
});

function serviceContext(rpc) {
  const scope = vm.createContext({ sb: { rpc }, crypto: { randomUUID: () => 'stable-request-id' } });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../js/corporate-actions-service.js'), 'utf8'), scope);
  return scope;
}
test('missing backend leaves existing portfolio data unchanged', async () => {
  const scope = serviceContext(async () => ({ error: { code: 'PGRST202' } }));
  const rows = [{ pick_id: 'p', buy_price: 75500, buy_quantity: 6 }];
  assert.equal(await scope.attachCorporatePositions(rows), rows);
  await assert.rejects(scope.corporateRpc('sss_apply_bonus'), /연결 설정/);
});
test('backend failures cannot silently use unadjusted balances', async () => {
  const scope = serviceContext(async () => ({ error: { code: '503', message: 'unavailable' } }));
  await assert.rejects(scope.attachCorporatePositions([{ pick_id: 'p' }]), error => error.code === '503');
});
test('trade retries preserve idempotency token after uncertain response', async () => {
  const calls = [];
  const scope = serviceContext(async (name, args) => {
    if (name === 'sss_corporate_actions_version') return { data: 1 };
    calls.push(args.p_request_id);
    if (calls.length === 1) return { error: { message: 'timeout' } };
    return { data: { id: 'trade' } };
  });
  await assert.rejects(scope.submitCorporateTrade(buy), /timeout/);
  await scope.submitCorporateTrade(buy);
  assert.deepEqual(calls, ['stable-request-id', 'stable-request-id']);
});
