const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { eligible, parseAdjusted, buildQuote, collectQuotes } = require('../scripts/presentation-prices.cjs');

const row = { id: 'a', stock_code: '356860', presented_at: '2026-06-01', status: 'done' };
const now = new Date('2026-09-22T00:00:00Z');
const chart = "[['날짜', '시가', '고가', '저가', '종가'], ['20260601', 1, 2, 1, 53453,],]";
const raw = [{ localTradedAt: '2026-06-01', closePrice: '106,300' }];

test('only completed domestic presentations after 18:00 KST are eligible', () => {
  assert.equal(eligible(row, new Date('2026-06-01T08:59:59Z')), false);
  assert.equal(eligible(row, new Date('2026-06-01T09:00:00Z')), true);
  for (const patch of [{ stock_code: null }, { stock_code: 'AAPL' }, { presented_at: null },
    { presented_at: 'bad' }, { presented_at: '2027-01-01' }, { status: 'planned' }]) {
    assert.equal(eligible({ ...row, ...patch }, now), false);
  }
  assert.equal(eligible({ ...row, status: null }, now), true);
});

test('raw close and adjusted close stay separate with exact date provenance', () => {
  const quote = buildQuote(row, raw, parseAdjusted(chart), now.toISOString());
  assert.equal(quote.p_close, 106300);
  assert.equal(quote.p_adjusted_close, 53453);
  assert.equal(quote.p_presented_at, row.presented_at);
  assert.equal(quote.p_id, row.id);
});

test('missing date, suspended/invalid price and missing adjusted close never fall back to current price', () => {
  for (const daily of [[], [{ localTradedAt: '2026-05-29', closePrice: '100' }],
    [{ localTradedAt: row.presented_at, closePrice: '0' }],
    [{ localTradedAt: row.presented_at, closePrice: 'invalid' }]]) {
    assert.throws(() => buildQuote(row, daily, parseAdjusted(chart), now.toISOString()), /unavailable/);
  }
  assert.throws(() => buildQuote(row, raw, new Map(), now.toISOString()), /unavailable/);
});

test('duplicate stock/date requests share provider calls and preserve distinct presentation ids', async () => {
  const calls = [];
  const result = await collectQuotes([row, { ...row, id: 'b' }, { ...row, id: 'c', status: 'planned' }], {
    now, get: async url => { calls.push(url); return url.includes('siseJson') ? chart : JSON.stringify(raw); },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.quotes.length, 2);
  assert.deepEqual(result.quotes.map(q => q.p_id), ['a', 'b']);
  assert.equal(result.failures.length, 0);
});

test('provider failure is reported for retries, never generates a replacement quote', async () => {
  const result = await collectQuotes([row], { now, get: async () => { throw new Error('network'); } });
  assert.equal(result.quotes.length, 0);
  assert.equal(result.failures.length, 1);
});

test('daily pagination finds older presentations without selecting an adjacent day', async () => {
  const result = await collectQuotes([row], { now, get: async url => {
    if (url.includes('siseJson')) return chart;
    return JSON.stringify(url.endsWith('page=1') ? [{ localTradedAt: '2026-09-21', closePrice: '1' }] : raw);
  } });
  assert.equal(result.quotes[0].p_close, 106300);
});

test('all presentation views use the verified adjusted basis, not selection-time prices', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/utils/presentation.js'), 'utf8'), ctx);
  assert.equal(ctx.getPresentationReturnBase({ ...row, price_at: 118800 }), null);
  const verified = { ...row, price_at: 106300, price_adjusted_at: 53453,
    price_source: 'naver_daily_close_v1', price_date: row.presented_at };
  assert.equal(ctx.getPresentationReturnBase(verified), 53453);
  assert.equal(ctx.getPresentationReturnBase({ ...verified, price_date: '2026-05-29' }), null);
  assert.equal(ctx.getPresentationReturnBase({ ...verified, price_adjusted_at: null }), null);
  assert.match(ctx.getPresentationPriceTitle(verified), /53,453/);
  assert.equal(ctx.getPresentationReturnBase({ stock_code: null, price_at: 100 }), 100);
  for (const file of ['index.html', 'presentations.html', 'mypage.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(html, /js\/utils\/presentation\.js/);
    assert.match(html, /getPresentationReturnBase/);
  }
});
