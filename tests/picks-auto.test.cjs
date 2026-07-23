const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function loadDbHelpers() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(read('js/db.js'), context, { filename: 'js/db.js' });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('latest held top pick automatically extends across multiple empty months', () => {
  const { buildCarryForwardPicks } = loadDbHelpers();
  const effective = plain(buildCarryForwardPicks('2026-07', [], [
    { id: 'apr', member_id: 'a', month: '2026-04', stock_name: 'A', status: 'hold', price_at: 100 },
    { id: 'may', member_id: 'a', month: '2026-05', stock_name: 'A', status: 'hold', price_at: 120, carried_from: '2026-04' },
  ], { activeMemberIds: new Set(['a']) }));

  assert.equal(effective.length, 1);
  assert.equal(effective[0].id, 'may');
  assert.equal(effective[0].month, '2026-07');
  assert.equal(effective[0].carried_from, '2026-04');
  assert.equal(effective[0].price_at, 120);
  assert.equal(effective[0]._isCarryFallback, true);
});

test('a direct pick for the month replaces the automatic extension', () => {
  const { buildCarryForwardPicks } = loadDbHelpers();
  const current = { id: 'jul', member_id: 'a', month: '2026-07', stock_name: 'B', status: 'hold' };
  const effective = plain(buildCarryForwardPicks('2026-07', [current], [
    { id: 'may', member_id: 'a', month: '2026-05', stock_name: 'A', status: 'hold' },
  ], { activeMemberIds: new Set(['a']) }));

  assert.deepEqual(effective, [current]);
});

test('a latest sold pick stops older held picks from returning', () => {
  const { buildCarryForwardPicks } = loadDbHelpers();
  const effective = plain(buildCarryForwardPicks('2026-07', [], [
    { id: 'apr', member_id: 'a', month: '2026-04', stock_name: 'A', status: 'hold' },
    { id: 'jun', member_id: 'a', month: '2026-06', stock_name: 'A', status: 'sold' },
  ], { activeMemberIds: new Set(['a']) }));

  assert.deepEqual(effective, []);
});

test('inactive members are excluded from automatic extension', () => {
  const { buildCarryForwardPicks } = loadDbHelpers();
  const effective = plain(buildCarryForwardPicks('2026-07', [
    { id: 'jul-b', member_id: 'b', month: '2026-07', stock_name: 'B2', status: 'hold' },
  ], [
    { id: 'jun-a', member_id: 'a', month: '2026-06', stock_name: 'A', status: 'hold' },
    { id: 'jun-b', member_id: 'b', month: '2026-06', stock_name: 'B', status: 'hold' },
  ], { activeMemberIds: new Set(['a']) }));

  assert.deepEqual(effective.map(pick => pick.member_id), ['a']);
});

test('automatic extension is shown consistently instead of as a missing submission', () => {
  const index = read('index.html');
  const mypage = read('mypage.html');

  assert.match(index, /effectivePick\?\._isCarryFallback/);
  assert.match(index, /탑픽 자동 연장/);
  assert.match(index, /직접 \$\{directCount\}명 · 자동 연장 \$\{automatic\.length\}명/);
  assert.match(index, /automaticPickLabel\(p\)/);
  assert.match(index, /detailRoute = `picks\?id=.*&month=/);
  assert.match(index, /const holdPicks = picks\.filter\(p => p\.status === 'hold'\)/);
  assert.match(index, /const isAutoSource = effectivePick\?\._isCarryFallback/);
  assert.match(mypage, /effectiveCurrentPick\?\._isCarryFallback/);
  assert.match(mypage, /월 자동 연장<\/span>/);
});

test('pick editor uses the latest carry source and never requires the exact prior month', () => {
  const source = read('js/modal-pick.js');
  const dbSource = read('js/db.js');
  const carryStart = dbSource.indexOf('function buildCarryForwardPicks');
  const carryEnd = dbSource.indexOf('// ── 거래', carryStart);
  const carrySource = dbSource.slice(carryStart, carryEnd);

  assert.match(source, /fetchCarryForwardSourcePicks\(/);
  assert.match(source, /별도 변경이 없으면 아래 종목이 유지됩니다/);
  assert.match(source, /id="pick-month"[^>]+disabled/);
  assert.match(source, /me\.is_active === false/);
  assert.doesNotMatch(source, /\.eq\('month', prevMonth\)/);
  assert.doesNotMatch(source, /ensurePickCarryForward/);
  assert.doesNotMatch(carrySource, /\.(?:insert|update|upsert|delete)\(/);
});

test('automatic pick details preserve the displayed month', () => {
  const source = read('picks.html');

  assert.match(source, /openInvestmentDetail\(id, displayMonth = ''\)/);
  assert.match(source, /const displayMonth = pick\._isCarryFallback \? \(pick\.month \|\| ''\) : ''/);
  assert.match(source, /buildCarryForwardPicks\(\s*displayMonth/);
  assert.match(source, /&month=\$\{encodeURIComponent\(pick\.month\)\}/);
  assert.match(source, /params\.delete\('month'\)/);
  assert.match(source, /해당 월의 자동 연장 상태가 변경되었습니다/);
});

test('changed pick pages and scripts keep valid JavaScript', () => {
  for (const file of ['index.html', 'picks.html', 'mypage.html']) {
    const html = read(file);
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map(match => match[1])
      .filter(code => code.trim());
    scripts.forEach((code, index) => {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${file}#${index}` }));
    });
  }
  for (const file of ['js/modal-pick.js', 'sw.js']) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }));
  }
});
