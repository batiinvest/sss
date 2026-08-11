const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('member portfolio page keeps valid inline JavaScript', () => {
  const html = read('members.html');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(code => code.trim());

  scripts.forEach((code, index) => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `members.html#${index}` }));
  });
});

test('member cards expose live valuation and accessible holding details', () => {
  const html = read('members.html');
  const css = read('css/style.css');

  assert.match(html, /js\/services\/price-service\.js\?v=/);
  assert.match(html, /js\/utils\/portfolio\.js\?v=/);
  assert.match(html, /fetchPriceMapByCodes\(/);
  assert.match(html, /buildMemberPortfolioValuation\(/);
  assert.match(html, /현재 총자산/);
  assert.match(html, /최초[^<]*500,000원 대비|최초[^`]*\$\{won\(initialAmount\)\} 대비/);
  assert.match(html, /현재 보유종목/);
  assert.match(html, /<caption class="sr-only">현재 보유종목의 수량, 평균매수가, 현재가, 평가금액과 평가손익<\/caption>/);
  assert.match(html, /<th scope="col">현재가<\/th>/);
  assert.match(html, /aria-expanded="\$\{isExpanded\}"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="member-cards-grid/);
  assert.match(html, /const pickSettlements = mySettles\.filter/);
  assert.match(html, /pickSettlements\.reduce\(\(sum, item\) => sum \+ Number\(item\.net_profit \|\| 0\), 0\)/);
  assert.match(css, /\.member-cards-grid/);
  assert.match(css, /\.member-holdings-table/);
});

test('missing prices stay visibly pending instead of using cost as market value', () => {
  const html = read('members.html');

  assert.match(html, /평가 대기/);
  assert.match(html, /현재가 미확인/);
  assert.match(html, /hasCompletePricing/);
});
