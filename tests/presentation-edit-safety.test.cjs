const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function load(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  return ctx;
}
function database(initial) {
  let row = clone(initial), beforeUpdate = null;
  const requests = [];
  const client = { from() {
    let patch = null;
    const filters = [];
    return {
      update(value) { patch = clone(value); return this; },
      select() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() {
        if (patch) {
          beforeUpdate?.(); beforeUpdate = null;
          requests.push({ patch, filters });
        }
        if (!row || !filters.every(([key, value]) => row[key] === value)) return { data: null };
        if (patch) row = { ...row, ...patch, edit_revision: row.edit_revision + 1 };
        return { data: clone(row) };
      },
    };
  } };
  return { client, requests, get row() { return clone(row); },
    change(patch) { row = { ...row, ...patch, edit_revision: row.edit_revision + 1 }; },
    race(callback) { beforeUpdate = callback; }, delete() { row = null; } };
}
const original = () => ({ id: 'p1', member_id: 'm1', schedule_id: 's1', presented_at: '2026-11-30',
  category: 'industry', status: 'planned', topic: '27년전망 > [자유 주제] 클라우드',
  reason: '기존 전망', risk: null, market_cap_at: null, target_cap: null, stock_code: null, price_at: null, edit_revision: 0 });
const values = reason => ({ format: 'free', title: '클라우드', reason, risk: '', market_cap_at: null, target_cap: null });

test('two editors cannot overwrite each other, even when the race occurs at UPDATE time', async () => {
  const ctx = load(), base = original(), db = database(base);
  db.race(() => db.change({ reason: '다른 사람이 저장한 전망' }));
  await assert.rejects(ctx.savePresentationEdit(db.client, base, base, values('내 전망'), null), { code: 'PRESENTATION_CONFLICT' });
  assert.equal(db.row.reason, '다른 사람이 저장한 전망');
  const latest = db.row;
  await ctx.savePresentationEdit(db.client, latest, latest, values('비교 후 수정'), null);
  assert.equal(db.row.reason, '비교 후 수정');
});

test('content-only edit never writes an old shared theme; a theme change causes a safe conflict', async () => {
  const ctx = load(), base = original(), db = database(base);
  db.change({ topic: '28년전망 > [자유 주제] 클라우드' });
  await assert.rejects(ctx.savePresentationEdit(db.client, base, base, values('새 내용'), null), { code: 'PRESENTATION_CONFLICT' });
  assert.equal(db.row.topic, '28년전망 > [자유 주제] 클라우드');
  assert.equal(Object.hasOwn(db.requests[0].patch, 'topic'), false);
});

test('shared-topic propagation cannot overwrite a concurrently renamed individual presentation', async () => {
  const base = original(), db = database(base);
  const input = { value: '28년전망', dataset: { contextKey: 'theme' } };
  const ctx = load({ sb: db.client, presentations: [base], industrySaveToken: 1,
    setConfig: async () => {}, setIndustryNameSaveStatus() {}, notifyPresentationOrderChanged() {}, presOrder: [],
    document: { getElementById: () => input } });
  const source = read('schedule-order.html');
  vm.runInContext(source.slice(source.indexOf('async function persistTurnIndustryName'), source.indexOf('async function ensureIndustryNameSaved')), ctx);
  db.change({ topic: '27년전망 > [자유 주제] 반도체' });
  const result = await ctx.persistTurnIndustryName({ key: 'theme', name: '28년전망', scheduleId: 's1', requestToken: 1, opts: { silent: true } });
  assert.equal(result, false);
  assert.equal(input.dataset.dirty, 'true');
  assert.equal(db.row.topic, '27년전망 > [자유 주제] 반도체');
});

test('long manuscripts use a short revision predicate and preserve punctuation and line breaks', async () => {
  const ctx = load(), base = { ...original(), reason: '산업 전망 > 수요, "변화"\n'.repeat(4000) }, db = database(base);
  const reason = base.reason + '추가 전망';
  const saved = await ctx.savePresentationEdit(db.client, base, base, values(reason), null);
  assert.equal(saved.reason, reason);
  assert.deepEqual(db.requests[0].filters, [['id', 'p1'], ['edit_revision', 0]]);
  assert.deepEqual(Object.keys(db.requests[0].patch), ['reason']);
});

test('switching a stock to other clears stock fields atomically with content', async () => {
  const ctx = load(), base = { ...original(), topic: '전망 > 삼성전자', stock_code: '005930', price_at: 70000, market_cap_at: 100, target_cap: 200 }, db = database(base);
  await ctx.savePresentationEdit(db.client, base, base, values('클라우드 전망'), null);
  assert.equal(db.row.topic, '전망 > [자유 주제] 클라우드');
  for (const key of ['stock_code', 'price_at', 'market_cap_at', 'target_cap']) assert.equal(db.row[key], null);
});

test('deleted presentations and deployments missing the revision column fail closed', async () => {
  const ctx = load(), base = original(), db = database(base);
  db.delete();
  await assert.rejects(ctx.savePresentationEdit(db.client, base, base, values('추가'), null), { code: 'PRESENTATION_CONFLICT' });
  delete base.edit_revision;
  const untouched = database(base);
  await assert.rejects(ctx.savePresentationEdit(untouched.client, base, base, values('추가'), null), /DB 적용/);
  assert.equal(untouched.requests.length, 0);
});

function editor(storage = new Map(), db = database(original())) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, focus() {} });
    return elements.get(id);
  };
  const ctx = load({ localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  }, document: { getElementById: element, activeElement: { focus() {} } },
    confirm: () => true, toast() {}, presentations: [db.row], schedules: [], sb: db.client,
    getAutomaticPresentationPlan: () => ({}), getMemberPresentationPlanItem: () => null,
    registerDraftForFutureCycleIfNeeded: async () => {}, reloadPresentationSetupData: async () => {}, refreshPresentationScheduleViews() {},
  });
  const source = read('schedule-order.html');
  vm.runInContext(source.slice(source.indexOf('let _editDraft = null;'), source.indexOf("document.getElementById('presEditModal').addEventListener")), ctx);
  vm.runInContext("presentationEditorAccountId = 'account-a'", ctx);
  ctx.openPresEditModal({ name: '회원' }, original());
  return { ctx, element, storage, db };
}

test('refresh restores local inputs with their original revision, then successful save clears them', async () => {
  const first = editor();
  first.element('edit-reason').value = '길게 작성한 전망\n두 번째 줄';
  first.ctx.persistPresentationLocalDraft();
  assert.equal(first.storage.size, 1);
  const second = editor(first.storage, first.db);
  assert.equal(second.element('edit-reason').value, '길게 작성한 전망\n두 번째 줄');
  await second.ctx.savePresEditModal();
  assert.equal(first.db.row.reason, '길게 작성한 전망\n두 번째 줄');
  assert.equal(first.storage.size, 0);
  assert.equal(second.element('presEditModal').style.display, 'none');
});

test('restored stale drafts show latest contents without losing local input or allowing overwrite', async () => {
  const first = editor();
  first.element('edit-reason').value = '복구할 원고';
  first.ctx.persistPresentationLocalDraft();
  first.db.change({ reason: '<b>다른 창의 원고</b>' });
  const second = editor(first.storage, first.db);
  await second.ctx.savePresEditModal();
  assert.equal(second.element('edit-reason').value, '복구할 원고');
  assert.equal(second.element('edit-conflict').hidden, false);
  assert.match(second.element('edit-conflict-latest').textContent, /<b>다른 창의 원고<\/b>/);
  assert.equal(second.element('edit-conflict-latest').innerHTML, undefined);
  assert.equal(first.db.row.reason, '<b>다른 창의 원고</b>');
  assert.equal(first.storage.size, 1);
  second.ctx.reloadConflictedPresentation();
  assert.equal(second.element('edit-reason').value, '<b>다른 창의 원고</b>');
  assert.equal(first.storage.size, 0);
});

test('local draft keys isolate accounts, presenters, schedules and unscheduled cycles', () => {
  const ctx = load(), base = original();
  const keys = [ctx.presentationLocalDraftKey('a', base), ctx.presentationLocalDraftKey('b', base),
    ctx.presentationLocalDraftKey('a', { ...base, member_id: 'm2' }),
    ctx.presentationLocalDraftKey('a', { ...base, schedule_id: 's2' }),
    ctx.presentationLocalDraftKey('a', { ...base, id: null, schedule_id: null }, 'cycle-a'),
    ctx.presentationLocalDraftKey('a', { ...base, id: null, schedule_id: null }, 'cycle-b')];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(ctx.presentationLocalDraftKey(null, base), null);
});

test('discard confirmation, unavailable storage and malformed drafts do not lose the active form', () => {
  const fixture = editor();
  fixture.element('edit-reason').value = '보관할 입력';
  fixture.ctx.persistPresentationLocalDraft();
  fixture.ctx.confirm = () => false;
  fixture.ctx.closePresEditModal();
  assert.equal(fixture.storage.size, 1);
  assert.equal(fixture.element('presEditModal').style.display, 'flex');
  fixture.ctx.localStorage.setItem = () => { throw Error('quota'); };
  fixture.ctx.persistPresentationLocalDraft();
  assert.match(fixture.element('edit-draft-status').textContent, /임시저장할 수 없습니다/);
  assert.equal(fixture.element('edit-reason').value, '보관할 입력');
  assert.equal(fixture.ctx.readPresentationLocalDraft({ getItem: () => '{invalid' }, 'key'), null);
  fixture.ctx.confirm = () => true;
  fixture.ctx.closePresEditModal();
  assert.equal(fixture.storage.size, 0);
});
