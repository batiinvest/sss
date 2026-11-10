const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('morning trade response loss retries the original payload and ID, then permits a new trade', async () => {
  let time = Date.parse('2026-10-30T08:59:59+09:00');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const calls = [];
  let sequence = 0;
  const storage = new Map();
  const ctx = vm.createContext({ Date: ClockDate, crypto: { randomUUID: () => String(++sequence) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sb: { auth: { getSession: async () => ({ data: { session: { user: { id: 'actor' } } } }) }, async rpc(name, args) {
      if (name === 'sss_corporate_actions_version') return { data: 1 };
      calls.push(args);
      return calls.length === 1 ? { error: { message: 'response lost' } } : { data: { id: 'saved' } };
    } },
  });
  const trade = read('trade.html');
  vm.runInContext(read('js/corporate-actions-service.js') + '\n' +
    trade.slice(trade.indexOf('function tradeDateTime'), trade.indexOf('function setTradeError')), ctx);
  const payload = () => ({ pick_id: 'p', member_id: 'm', trade_type: 'sell', price: 1000, quantity: 5,
    traded_at: ctx.tradeDateTime('2026-10-30') });
  await assert.rejects(ctx.submitCorporateTrade(payload()), /response lost/);
  time += 5000; // Cross UTC midnight, still the same Korean trading day.
  await ctx.submitCorporateTrade(payload());
  assert.deepEqual(calls[0], calls[1]);
  await ctx.submitCorporateTrade(payload());
  assert.notEqual(calls[1].p_request_id, calls[2].p_request_id);
});

test('departure preserves historical automatic fees and stops following months', () => {
  const { buildEffectiveFees, summarizeFundBalance } = require('../js/fees-auto.js');
  const member = { id: 'm', is_active: true, joined_at: '2026-06-01' };
  const opts = { monthlyFee: 30000, startMonth: '2026-06', throughMonth: '2026-12' };
  const before = buildEffectiveFees([], [member], opts);
  const after = buildEffectiveFees([], [{ ...member, is_active: false, deactivated_at: '2026-10-30' }], opts);
  assert.equal(summarizeFundBalance(before, [], '2026-09').balance, 120000);
  assert.equal(summarizeFundBalance(after, [], '2026-09').balance, 120000);
  assert.equal(after.length, 5);
  assert.equal(after.at(-1).month, '2026-10');
});

test('member edit preserves zero and never rewrites the login email', async () => {
  const source = read('admin.html');
  const values = { 'f-name': 'A', 'f-email': 'changed@example.test', 'f-base': '0', 'f-joined': '2026-01-01', 'f-note': '' };
  let update;
  const ctx = vm.createContext({ currentUserIsAdmin: true, editingMemberId: 'm', editingMemberBase: 500000,
    document: { getElementById: id => ({ value: values[id] || '' }) },
    toast() {}, closeForm() {}, loadData: async () => {},
    sb: { from: () => ({ update(data) { update = data; return {
      eq() { return this; }, select() { return this; }, maybeSingle: async () => ({ data: { id: 'm' }, error: null }),
    }; } }) },
  });
  vm.runInContext(source.slice(source.indexOf('async function saveMember'), source.indexOf('function confirmDeactivate')), ctx);
  await ctx.saveMember();
  assert.equal(update.base_amount, 0);
  assert.equal(Object.hasOwn(update, 'email'), false);
});

test('opening an existing zero-balance member keeps zero and locks their email', () => {
  const nodes = {};
  const ctx = vm.createContext({ currentUserIsAdmin: true,
    document: { getElementById: id => nodes[id] ||= { style: {}, focus() {}, scrollIntoView() {} } },
  });
  const source = read('admin.html');
  vm.runInContext(source.slice(source.indexOf('function openForm'), source.indexOf('function closeForm')), ctx);
  ctx.openForm({ id: 'm', email: 'original@example.test', base_amount: 0 });
  assert.equal(nodes['f-base'].value, 0);
  assert.equal(nodes['f-email'].readOnly, true);
  ctx.openForm();
  assert.equal(nodes['f-email'].readOnly, false);
});

test('clearing global search invalidates an already running request', async () => {
  const source = read('app.html');
  let resolvePrices;
  const node = { innerHTML: '' };
  const query = { select() { return this; }, or() { return this; }, not() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: [] }); } };
  const ctx = vm.createContext({ document: { getElementById: () => node }, sb: { from: () => query },
    searchStockPrices: () => new Promise(resolve => { resolvePrices = resolve; }),
    renderRecentSearches() { node.innerHTML = 'RECENT'; }, bindSearchResultButtons() {}, escapeHtml: String,
  });
  vm.runInContext('let searchRequestId = 0;\n' + source.slice(source.indexOf('async function runGlobalSearch'),
    source.indexOf("document.getElementById('globalSearchInput').addEventListener")), ctx);
  const pending = ctx.runGlobalSearch('삼성');
  await ctx.runGlobalSearch('');
  resolvePrices([]);
  await pending;
  assert.equal(node.innerHTML, 'RECENT');
});
