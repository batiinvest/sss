const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'fees.html'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'css', 'style.css'), 'utf8');

test('fees page inline scripts parse successfully', () => {
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(source => source.trim());

  assert.ok(inlineScripts.length >= 2);
  inlineScripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: `fees-inline-${index}.js` }));
  });
});

test('fees page centers automatic ledger totals instead of member payment rows', () => {
  assert.doesNotMatch(html, /id="memberFeeList"/);
  assert.doesNotMatch(html, /paidCount|memberCount\s*\+\s*'\/\'/);

  [
    'totalBalance',
    'thisMonthNet',
    'monthFlowStatus',
    'monthRegularIncome',
    'monthExpenseTotal',
    'monthNet',
    'monthFlowList',
    'automationRules',
    'monthlySummary',
    'expenseList',
  ].forEach(id => assert.match(html, new RegExp(`id="${id}"`)));
});

test('fees page month navigation prevents future ledger browsing', () => {
  assert.match(html, /if \(nextMonth > currentMonthKey\(\)\) return;/);
  assert.match(html, /nextButton\.disabled = feeCurrentMonth >= todayMonth;/);
});

test('fees page protects admin-only actions and historical regular records', () => {
  assert.match(html, /id="adminBtns" hidden/);
  assert.match(css, /#adminBtns\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(html, /if \(feeCurrentMonth < AUTO_LEDGER_START_MONTH\)/);
  assert.match(html, /eligibleMemberIds\.has\(fee\.member_id\)/);
});

test('fees page keeps older direct expenses manageable', () => {
  assert.match(html, /id="expenseShowAll"/);
  assert.match(html, /showAllExpenses \? list : list\.slice\(0, 8\)/);
  assert.match(html, /function toggleExpenseList\(\)/);
});
