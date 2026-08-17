const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('root HTML keeps a single class attribute on every element', () => {
  const htmlFiles = fs.readdirSync(root).filter(file => file.endsWith('.html'));
  for (const file of htmlFiles) {
    assert.doesNotMatch(
      read(file),
      /<[^>]*\bclass=(?:"[^"]*"|'[^']*')[^>]*\bclass=/i,
      `${file}: duplicate class attribute`,
    );
  }
});

test('mypage cards keep spacing and metrics reuse the responsive three-column variant', () => {
  const page = read('mypage.html');
  const metricTag = page.match(/<div\b(?=[^>]*\bid="myMetricGrid")[^>]*>/)?.[0];

  assert.ok(metricTag);
  assert.match(metricTag, /\bclass="[^"]*\bmetric-grid\b/);
  assert.match(metricTag, /\bmetric-grid-dashboard\b/);
  assert.doesNotMatch(metricTag, /style=/);
  assert.equal((page.match(/class="card mb-card"/g) || []).length, 3);
});

test('mobile topbar layout targets explicit action containers only', () => {
  const css = read('css/style.css');

  assert.doesNotMatch(css, /\.topbar\s*>\s*div:last-child\b/);
  assert.match(css, /\.topbar\s*>\s*\.topbar-actions\b/);
  assert.match(css, /\.topbar\s*>\s*\.topbar-actions\s*>\s*\.btn/);
  assert.doesNotMatch(
    css,
    /\.topbar\s*>\s*\.topbar-actions\s*\{[^}]*display\s*:/,
  );

  for (const [file, marker] of [
    ['index.html', 'btn-row topbar-actions'],
    ['fees.html', 'btn-row topbar-actions'],
    ['members.html', 'member-price-actions topbar-actions'],
    ['schedule-calendar.html', 'schedule-topbar-actions topbar-actions'],
  ]) {
    assert.match(read(file), new RegExp(`class="${marker}"`), `${file}: action marker`);
  }
});

test('fees mobile action grid remains owned by the fees component', () => {
  const css = read('css/style.css');
  assert.match(
    css,
    /@media \(max-width: 768px\)[\s\S]*?\.fund-page-header \.btn-row \{ display: grid;/,
  );
  assert.match(
    css,
    /@media \(max-width: 380px\)[\s\S]*?\.fund-page-header \.btn-row \{ grid-template-columns: 1fr; \}/,
  );
});
