const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const source = read('trade.html');
test('complete trade page and shared stock-registration script compile', () => {
  for (const block of source.split('<script>').slice(1)) assert.doesNotThrow(() => new vm.Script(block.split('</script>')[0]));
  assert.doesNotThrow(() => new vm.Script(read('js/modal-pick.js')));
});
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function fixture(extra = {}) {
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, max: '', selectedOptions: [{ dataset: {} }], focus() {}, scrollIntoView() {} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ console, document: { getElementById: el }, allPicks: [], allTrades: [], members: [], admin: true,
    sellBalanceRequest: 0, availableSellQuantity: 0, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    calcSellReturn() {}, loadAvailableSellQuantity() {}, toast() {}, ...extra });
  return { ctx, el };
}

test('buy list explains empty state and includes unbought, additional-buy and repurchase stocks for only the chosen member', () => {
  const { ctx, el } = fixture();
  vm.runInContext(section('function updatePickSelect', 'function setupTradeStockSearch'), ctx);
  el('buy-member').value = 'm'; ctx.updatePickSelect('buy');
  assert.match(el('buyPickHelp').textContent, /종목을 검색/);
  ctx.allPicks = [
    { id: 'idea', member_id: 'm', stock_name: '삼성전자', month: '2026-11', status: 'pending' },
    { id: 'hold', member_id: 'm', stock_name: '원익IPS', month: '2026-10', buy_price: 20000, status: 'hold' },
    { id: 'sold', member_id: 'm', stock_name: '코스맥스비티아이', month: '2026-06', buy_price: 18030, status: 'sold' },
    { id: 'other', member_id: 'other', stock_name: '다른 회원 종목', status: 'pending' },
  ];
  ctx.updatePickSelect('buy');
  assert.match(el('buy-pick').innerHTML, /삼성전자/);
  assert.match(el('buy-pick').innerHTML, /추가 매수/);
  assert.match(el('buy-pick').innerHTML, /재매수/);
  assert.doesNotMatch(el('buy-pick').innerHTML, /다른 회원/);
});

test('sell list includes completed positions for historical dates, excludes never-purchased ideas, and reloads balance', () => {
  let loads = 0;
  const { ctx, el } = fixture({ loadAvailableSellQuantity: () => { loads++; }, allPicks: [
    { id: 'hold', member_id: 'm', stock_name: '보유종목', buy_price: 100, buy_quantity: 3, status: 'hold' },
    { id: 'sold', member_id: 'm', stock_name: '완료종목', buy_price: 100, buy_quantity: 0, status: 'sold' },
    { id: 'idea', member_id: 'm', stock_name: '미매수', buy_price: null, status: 'pending' },
  ] });
  vm.runInContext(section('function updatePickSelect', 'function setupTradeStockSearch'), ctx);
  el('sell-member').value = 'm'; ctx.updatePickSelect('sell');
  assert.match(el('sell-pick').innerHTML, /보유종목/);
  assert.match(el('sell-pick').innerHTML, /완료종목.*과거 거래 확인/);
  assert.doesNotMatch(el('sell-pick').innerHTML, /미매수/);
  el('sell-member').value = 'empty'; ctx.updatePickSelect('sell');
  assert.equal(loads, 2);
});

test('older sell balance failure cannot erase a newer successful selection', async () => {
  const pending = [];
  const { ctx, el } = fixture({ corporateBackendAvailable: async () => true,
    corporateRpc: (_name, args) => new Promise((resolve, reject) => pending.push({ resolve, reject, args })), tradeDateTime: date => date });
  vm.runInContext(section('async function loadAvailableSellQuantity', 'function calcBuyAmount'), ctx);
  el('sell-date').value = '2026-11-25'; el('sell-pick').value = 'a';
  const first = ctx.loadAvailableSellQuantity(); await new Promise(setImmediate);
  el('sell-pick').value = 'b'; const second = ctx.loadAvailableSellQuantity(); await new Promise(setImmediate);
  pending[1].resolve([{ pick_id: 'b', tradableQuantity: 7, averagePrice: 200, pendingQuantity: 0 }]); await second;
  pending[0].reject(Error('old request failed')); await first;
  assert.equal(ctx.availableSellQuantity, 7);
  assert.equal(el('sell-qty').max, '7');
  assert.match(el('sellAvailable').textContent, /7주/);
  el('sell-pick').value = ''; await ctx.loadAvailableSellQuantity();
  assert.equal(ctx.availableSellQuantity, 0);
  assert.equal(el('sell-qty').max, '0');
  assert.equal(el('sell-pick').selectedOptions[0].dataset.buy, '');
});

test('balance lookup errors, missing backend and invalid quantities never leave a usable stale balance', async () => {
  const { ctx, el } = fixture({ corporateBackendAvailable: async () => { throw Error('offline'); } });
  vm.runInContext(section('async function loadAvailableSellQuantity', 'function calcBuyAmount'), ctx);
  el('sell-pick').value = 'p'; el('sell-date').value = '2026-11-25';
  await ctx.loadAvailableSellQuantity();
  assert.equal(el('sellAvailable').textContent, 'offline');
  assert.equal(ctx.availableSellQuantity, 0);
  ctx.corporateBackendAvailable = async () => false;
  await ctx.loadAvailableSellQuantity();
  assert.match(el('sellAvailable').textContent, /확인할 수 없습니다/);
});

test('saving either trade refreshes both pick lists and retains history filters', async () => {
  const updated = [], renders = [];
  const { ctx, el } = fixture({ fetchTradePositions: async () => [{ id: 'new' }], fetchTrades: async () => [{ id: 't' }],
    updatePickSelect: type => updated.push(type), filterTrades: () => renders.push('filtered'), calcBuyAmount() {} });
  vm.runInContext(section('async function reloadTradeState', 'function renderTrades'), ctx);
  for (const type of ['buy', 'sell']) await ctx.reloadTradeState(type, 'm');
  assert.deepEqual(updated, ['buy', 'sell', 'buy', 'sell']);
  assert.deepEqual(renders, ['filtered', 'filtered']);
  assert.equal(el('sell-member').value, 'm');
});

test('stock search chooses a real stock, clears stale account selection and preserves entered quantity', () => {
  const listeners = {}, { ctx, el } = fixture({ selectedBuyStock: null,
    bindStockSearch: (input, dropdown, onSelect) => { ctx.choose = onSelect; } });
  for (const id of ['buy-stock', 'buy-pick']) el(id).addEventListener = (event, callback) => { listeners[id + event] = callback; };
  vm.runInContext(section('function setupTradeStockSearch', 'async function loadAvailableSellQuantity'), ctx);
  el('buy-qty').value = '22'; el('buy-pick').value = 'old';
  ctx.setupTradeStockSearch();
  ctx.choose({ stock_name: '삼성전자', stock_code: '005930' });
  assert.equal(ctx.selectedBuyStock.stock_code, '005930');
  assert.equal(el('buy-pick').value, '');
  assert.equal(el('buy-qty').value, '22');
  listeners['buy-stockinput']();
  assert.equal(ctx.selectedBuyStock, null);
  assert.equal(el('buy-pick').value, '');
});

test('registration modal permits an admin-selected owner and rejects that override for an ordinary member', async () => {
  const modal = read('js/modal-pick.js');
  const openSource = modal.slice(modal.indexOf('  async function open('), modal.indexOf('  // ── 닫기'));
  let admin = true, rendered;
  const nodes = new Map();
  const ctx = vm.createContext({ mount() {}, getCurrentMember: async () => ({ id: 'me', name: '나' }),
    isAdmin: async () => admin, currentMonth: () => '2026-11', fetchCarryForwardSourcePicks: async () => [],
    renderPanel: member => { rendered = member; },
    document: { activeElement: {}, getElementById: id => { if (!nodes.has(id)) nodes.set(id, { style: {} }); return nodes.get(id); } },
    sb: { from: () => ({ select() { return this; }, eq() { return this; }, limit: async () => ({ data: [] }) }) },
  });
  vm.runInContext(openSource, ctx);
  await ctx.open({ member: { id: 'selected', name: '황준선' } });
  assert.equal(rendered.id, 'selected');
  assert.equal(nodes.get('pick-modal-title').textContent, '황준선 · 탑픽 등록');
  admin = false; rendered = null;
  await ctx.open({ member: { id: 'selected', name: '황준선' } });
  assert.equal(rendered, null);
  assert.match(nodes.get('pick-panel').textContent, /관리자만/);
});

test('trade dates reject nonexistent and future calendar dates', () => {
  const { ctx } = fixture();
  vm.runInContext(section('function tradeDateTime', 'function setTradeError'), ctx);
  for (const date of ['', '2026-02-30', '2026-13-01', '2099-01-01', 'invalid']) assert.throws(() => ctx.tradeDateTime(date));
  assert.equal(ctx.tradeDateTime('2026-11-01'), '2026-11-01T03:00:00.000Z');
});

test('strict trade-page data loads report errors instead of disguising them as an empty list', async () => {
  const ctx = vm.createContext({ console: { error() {} }, sb: { from: () => ({ select() { return this; }, order() { return this; },
    limit: async () => ({ error: Error('permission denied') }), then(resolve) { return Promise.resolve({ error: Error('permission denied') }).then(resolve); } }) } });
  vm.runInContext(read('js/db.js'), ctx);
  await assert.rejects(ctx.fetchAllPicks({}, { strict: true }), /permission denied/);
  await assert.rejects(ctx.fetchTrades(50, { strict: true }), /permission denied/);
});
