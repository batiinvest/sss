const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('all root pages and application scripts parse and reference existing local assets', () => {
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
    const source = read(file);
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/src=|application\//.test(match[1])) continue;
      assert.doesNotThrow(() => new vm.Script(match[2], { filename: file }));
    }
    for (const match of source.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
      const target = match[1].split('?')[0];
      if (/^(?:[a-z]+:|\/)/i.test(target)) continue;
      assert.ok(fs.existsSync(path.join(root, target)), `${file}: ${target}`);
    }
  }
  for (const dir of ['js', 'js/utils', 'js/services']) {
    for (const file of fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js'))) {
      assert.doesNotThrow(() => new vm.Script(read(`${dir}/${file}`), { filename: file }));
    }
  }
});

test('late stock search response cannot reopen cleared or dismissed results', async () => {
  let resolveSearch, pending;
  const handlers = {}, docHandlers = {};
  const input = { value: '삼성', addEventListener: (name, fn) => { handlers[name] = fn; }, contains: () => false };
  const dropdown = { style: {}, innerHTML: '', contains: () => false };
  const context = {
    setTimeout: fn => { pending = fn; }, clearTimeout() {},
    document: { addEventListener: (name, fn) => { docHandlers[name] = fn; } },
  };
  vm.createContext(context);
  vm.runInContext(read('js/db.js'), context);
  context.searchStockPrices = () => new Promise(resolve => { resolveSearch = resolve; });
  context.bindStockSearch(input, dropdown, () => {});
  handlers.input();
  const first = pending();
  input.value = '';
  handlers.input();
  resolveSearch([]);
  await first;
  assert.equal(dropdown.style.display, 'none');
  input.value = '현대';
  handlers.input();
  const second = pending();
  docHandlers.click({ target: {} });
  resolveSearch([]);
  await second;
  assert.equal(dropdown.style.display, 'none');
});

function settlementContext(failUpdate = false) {
  const nodes = {}, messages = [], writes = [];
  const context = {
    window: { _annualCalc: { year: 2025, prize: 100, winner: { id: 'a' }, activeMembers: [{ id: 'a' }], newBase: 900 } },
    document: { getElementById(id) { return nodes[id] ||= { value: id === 'a-year' ? '2025' : id === 'a-prize' ? '100' : '', style: {}, disabled: false }; } },
    toast: message => messages.push(message), won: String,
    crypto: { randomUUID: () => 'annual-request' },
    closeAnnualForm() {}, fetchMembers: async () => [], loadAnnualHistory: async () => {},
    sb: { async rpc(name, args) {
      writes.push({ name, args });
      return { error: failUpdate ? new Error('transaction rolled back') : null };
    }, from() { throw new Error('Client must never write settlement tables directly'); } },
  };
  vm.createContext(context);
  const source = read('settle.html');
  vm.runInContext('let annualAdmin = true; let annualSettlementLocked = false; let members = [];\n' +
    source.slice(source.indexOf('async function executeAnnualSettlement'), source.indexOf('async function loadAnnualHistory')), context);
  return { context, messages, writes, nodes };
}

test('annual transaction failure never reports success and retries the same request', async () => {
  const { context, messages, writes } = settlementContext(true);
  await context.executeAnnualSettlement();
  assert.ok(messages.some(message => message.includes('transaction rolled back')));
  assert.ok(!messages.some(message => message.includes('결산 완료!')));
  await context.executeAnnualSettlement();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].name, 'sss_annual_settle');
  assert.deepEqual(writes[0].args, writes[1].args);
});

test('successful annual transaction prevents a second submission', async () => {
  const { context, messages, writes } = settlementContext();
  await context.executeAnnualSettlement();
  await context.executeAnnualSettlement();
  assert.equal(writes.length, 1);
  assert.ok(messages.some(message => message.includes('결산 완료!')));
});

test('annual settlement refuses stale preview and non-admin execution', async () => {
  const { context, writes } = settlementContext();
  context.document.getElementById('a-prize').value = '200';
  await context.executeAnnualSettlement();
  assert.equal(writes.length, 0);
  vm.runInContext('annualAdmin = false', context);
  await context.executeAnnualSettlement();
  assert.equal(writes.length, 0);
});

test('Capacitor packaging includes every root HTML page', () => {
  const build = read('scripts/prepare-capacitor-web.mjs');
  for (const file of fs.readdirSync(root).filter(file => file.endsWith('.html'))) {
    assert.ok(build.includes(`'${file}'`), `Missing packaged page: ${file}`);
  }
});

test('member signup failure preserves saved member and never reports account creation success', async () => {
  const values = { 'f-name': '회원', 'f-email': 'member@example.test', 'f-base': '500000', 'f-joined': '2026-09-23', 'f-note': '', 'f-pw': 'test-only-password' };
  const messages = [];
  let closed = false, options;
  const context = {
    currentUserIsAdmin: true, editingMemberId: null,
    SUPABASE_URL: 'https://example.test', SUPABASE_ANON: 'test',
    document: { getElementById: id => ({ value: values[id] || '' }) },
    toast: message => messages.push(message), closeForm: () => { closed = true; }, loadData: async () => {},
    sb: { from: () => ({ insert: async () => ({ error: null }) }) },
    supabase: { createClient(url, key, config) {
      options = config;
      return { auth: { signUp: async () => ({ error: new Error('signup unavailable') }) } };
    } },
  };
  vm.createContext(context);
  const source = read('admin.html');
  vm.runInContext(source.slice(source.indexOf('async function saveMember'), source.indexOf('function confirmDeactivate')), context);
  await context.saveMember();
  assert.equal(options.auth.persistSession, false);
  assert.equal(closed, true);
  assert.ok(messages.some(message => message.includes('정보는 저장됐지만')));
  assert.ok(!messages.some(message => message.includes('계정 생성 완료')));
});
