const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const payload = { member_id: 'm', pick_id: 'p', stock_name: 'Stock', price: 1000, quantity: 10,
  trade_type: 'buy', traded_at: '2026-11-10T03:00:00Z', note: null };

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
}

let sequence = 0;
function page(localStorage, rpc, actor = 'actor') {
  const scope = vm.createContext({ localStorage, crypto: { randomUUID: () => String(++sequence) },
    sb: { rpc, auth: { getSession: async () => ({ data: { session: { user: { id: actor } } } }) } },
  });
  vm.runInContext(read('js/corporate-actions-service.js'), scope);
  return scope;
}

test('response loss then page reload recovers one committed trade and permits an intentional next trade', async () => {
  const persisted = storage(), committed = new Map(), calls = [];
  let loseResponse = true;
  const rpc = async (name, args) => {
    if (name === 'sss_corporate_actions_version') return { data: 1 };
    calls.push(args);
    committed.set(args.p_request_id, args.p_trade);
    if (loseResponse) { loseResponse = false; return { error: { message: 'response lost' } }; }
    return { data: { id: args.p_request_id } };
  };
  await assert.rejects(page(persisted, rpc).submitCorporateTrade(payload), /response lost/);
  const reloaded = page(persisted, rpc);
  const pending = await reloaded.getPendingCorporateTrade();
  assert.equal(pending.payload.quantity, 10);
  await reloaded.submitCorporateTrade(pending.payload);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]));
  assert.equal(committed.size, 1);
  assert.equal(await reloaded.getPendingCorporateTrade(), null);
  await reloaded.submitCorporateTrade(payload);
  assert.equal(committed.size, 2);
});

test('pending trade blocks changed input and remains private to its signed-in account', async () => {
  const persisted = storage();
  let writes = 0;
  const rpc = async name => {
    if (name === 'sss_corporate_actions_version') return { data: 1 };
    writes++;
    return { error: { message: 'timeout' } };
  };
  await assert.rejects(page(persisted, rpc, 'A').submitCorporateTrade(payload), /timeout/);
  await assert.rejects(page(persisted, rpc, 'A').submitCorporateTrade({ ...payload, quantity: 20 }), /미확인 거래/);
  assert.equal(writes, 1);
  assert.equal(await page(persisted, rpc, 'B').getPendingCorporateTrade(), null);
  assert.ok(await page(persisted, rpc, 'A').getPendingCorporateTrade());
});

test('unavailable persistent storage prevents financial writes', async () => {
  let writes = 0;
  const persisted = storage();
  persisted.setItem = () => { throw new Error('quota exceeded'); };
  const scope = page(persisted, async () => { writes++; return { data: 1 }; });
  await assert.rejects(scope.submitCorporateTrade(payload), /quota exceeded/);
  assert.equal(writes, 0);
});

test('missing transactional backend never falls back to an unprotected trade insert', async () => {
  const ctx = vm.createContext({ corporateBackendAvailable: async () => false,
    sb: { from() { throw new Error('unexpected direct insert'); } },
  });
  vm.runInContext(read('js/db.js'), ctx);
  await assert.rejects(ctx.submitTrade(payload), /DB 업데이트/);
});

test('definite database rejection clears pending state so corrected input can be submitted', async () => {
  const persisted = storage();
  const scope = page(persisted, async name => name === 'sss_corporate_actions_version' ? { data: 1 } :
    { error: { code: 'P0001', message: 'insufficient shares' } });
  await assert.rejects(scope.submitCorporateTrade(payload), /insufficient shares/);
  assert.equal(await scope.getPendingCorporateTrade(), null);
});

function memberForm(baseInput, serverBase) {
  const values = { 'f-name': 'Renamed', 'f-email': '', 'f-base': String(baseInput), 'f-joined': '2026-01-01', 'f-note': '' };
  const state = { base_amount: serverBase, name: 'Original' }, messages = [];
  let patch;
  const ctx = vm.createContext({ currentUserIsAdmin: true, editingMemberId: 'm', editingMemberBase: 500000,
    document: { getElementById: id => ({ value: values[id] || '' }) },
    toast: message => messages.push(message), closeForm() {}, loadData: async () => {},
    sb: { from: () => ({ update(data) {
      patch = data;
      let expected;
      return { eq(field, value) { if (field === 'base_amount') expected = value; return this; },
        select() { return this; }, async maybeSingle() {
          if (expected !== undefined && expected !== state.base_amount) return { data: null };
          Object.assign(state, data);
          return { data: { id: 'm' } };
        } };
    } }) },
  });
  const source = read('admin.html');
  vm.runInContext(source.slice(source.indexOf('async function saveMember'), source.indexOf('function confirmDeactivate')), ctx);
  return { ctx, state, messages, patch: () => patch };
}

test('name-only member edit preserves a concurrently increased balance', async () => {
  const form = memberForm(500000, 510000);
  await form.ctx.saveMember();
  assert.equal(form.state.base_amount, 510000);
  assert.equal(form.state.name, 'Renamed');
  assert.equal(Object.hasOwn(form.patch(), 'base_amount'), false);
});

test('explicit member balance edit rejects conflicts and succeeds on the original balance', async () => {
  const conflict = memberForm(600000, 510000);
  await conflict.ctx.saveMember();
  assert.equal(conflict.state.base_amount, 510000);
  assert.equal(conflict.state.name, 'Original');
  assert.ok(conflict.messages.some(message => message.includes('기준금액이 변경')));
  const success = memberForm(600000, 500000);
  await success.ctx.saveMember();
  assert.equal(success.state.base_amount, 600000);
});

for (const type of ['buy', 'sell']) {
  test(`${type} rejects fractional and out-of-range input while preserving exponent values`, async () => {
    const nodes = {}, writes = [], errors = [];
    const values = { [`${type}-member`]: 'm', [`${type}-pick`]: 'p', [`${type}-price`]: '1e3',
      [`${type}-qty`]: '2.9', [`${type}-note`]: '', [`${type}-date`]: '2026-11-10' };
    const ctx = vm.createContext({ admin: true, allPicks: [{ id: 'p', member_id: 'm', stock_name: 'Stock' }],
      document: { getElementById: id => nodes[id] ||= { value: values[id] || '', disabled: false } },
      setTradeError: (type, error) => errors.push(error), submitTrade: async data => writes.push(data),
      corporateBackendAvailable: async () => true, clearTradeInputs() {}, reloadTradeState: async () => {},
      showPendingTrade: async () => {}, toast() {}, tradeDateTime: date => date,
    });
    const source = read('trade.html');
    vm.runInContext(source.slice(source.indexOf('function tradeInteger'), source.indexOf('function tradeDateTime')), ctx);
    const submit = type === 'buy' ? ctx.submitBuy : ctx.submitSell;
    await submit();
    assert.equal(writes.length, 0);
    assert.ok(errors.some(Boolean));
    nodes[`${type}-qty`].value = '2147483648';
    await submit();
    assert.equal(writes.length, 0);
    nodes[`${type}-qty`].value = '2';
    nodes[`${type}-price`].value = '1000.5';
    await submit();
    assert.equal(writes.length, 0);
    nodes[`${type}-price`].value = '1e3';
    await submit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].price, 1000);
    assert.equal(writes[0].quantity, 2);
  });
}
