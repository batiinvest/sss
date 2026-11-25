const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scenario, clone, read } = require('./helpers/presentation-scenario.cjs');
const draft = () => ({ member_id: 'm', schedule_id: 's', category: 'industry', status: 'planned', presented_at: '2026-11-25', topic: '27년전망 > [자유 주제] 클라우드' });
const values = () => ({ format: 'free', title: '클라우드', reason: '원래 의견', risk: null });

test('lost insert response and repeated retries all recover the same presentation ID', async () => {
  const s = scenario(), row = draft(), input = values();
  const request = s.ctx.createPresentationInsertRequest(row, input, row);
  s.lostInsertResponse = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await s.ctx.savePresentationEdit(s.client, null, row, input, row, request);
    assert.equal(result.id, request.payload.id);
  }
  assert.equal(s.tables.presentations.length, 1);
});

test('a changed original request is never allowed to overwrite another edit after an uncertain insert', async () => {
  const s = scenario(), row = draft(), input = values();
  const request = s.ctx.createPresentationInsertRequest(row, input, row);
  s.lostInsertResponse = true; s.failPresentationReads = true;
  await assert.rejects(s.ctx.savePresentationEdit(s.client, null, row, input, row, request));
  await s.client.from('presentations').update({ reason: '다른 창의 의견' }).eq('id', request.payload.id);
  s.failPresentationReads = false;
  await assert.rejects(s.ctx.savePresentationEdit(s.client, null, row, input, row, request), { code: 'PRESENTATION_CONFLICT' });
  assert.equal(s.tables.presentations.length, 1);
  assert.equal(s.tables.presentations[0].reason, '다른 창의 의견');
});

function editor(s, storage, opened = draft()) {
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, focus() {} }); return nodes.get(id); };
  const ctx = vm.createContext({ console, crypto: require('node:crypto').webcrypto, sb: s.client,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { getElementById: el, activeElement: { focus() {} } }, confirm: () => true, toast() {},
    presentations: clone(s.tables.presentations), schedules: [],
    getAutomaticPresentationPlan: () => ({}), getMemberPresentationPlanItem: () => null,
    registerDraftForFutureCycleIfNeeded: async () => {}, reloadPresentationSetupData: async () => {}, refreshPresentationScheduleViews() {},
  });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  const source = read('schedule-order.html');
  vm.runInContext(source.slice(source.indexOf('let _editDraft = null;'), source.indexOf("document.getElementById('presEditModal').addEventListener")), ctx);
  vm.runInContext("presentationEditorAccountId = 'account';", ctx);
  ctx.openPresEditModal({ id: 'm', name: '회원' }, opened, opened.id ? null : opened);
  return { ctx, el };
}

test('reload discovers a committed new row and restores pending edits from the pre-insert local key', async () => {
  const s = scenario(), storage = new Map(), first = editor(s, storage);
  first.el('edit-reason').value = '첫 저장 의견';
  s.lostInsertResponse = true; s.failPresentationReads = true;
  await first.ctx.savePresEditModal();
  assert.equal(s.tables.presentations.length, 1);
  first.el('edit-reason').value = '응답 실패 후 추가한 의견';
  first.ctx.persistPresentationLocalDraft();
  first.ctx.closePresEditModal();
  assert.equal(storage.size, 1, 'uncertain INSERT identity must survive closing');
  s.failPresentationReads = false;
  const second = editor(s, storage, clone(s.tables.presentations[0]));
  assert.equal(second.el('edit-reason').value, '응답 실패 후 추가한 의견');
  await second.ctx.savePresEditModal();
  assert.equal(s.tables.presentations.length, 1);
  assert.equal(s.tables.presentations[0].reason, '응답 실패 후 추가한 의견');
  assert.equal(storage.size, 0);
  assert.equal(second.el('presEditModal').style.display, 'none');
});

test('new presentation cannot be sent if its durable request cannot be stored', async () => {
  const s = scenario(), ui = editor(s, new Map());
  ui.el('edit-reason').value = '입력 유지';
  ui.ctx.localStorage.setItem = () => { throw Error('quota'); };
  await ui.ctx.savePresEditModal();
  assert.equal(s.tables.presentations.length, 0);
  assert.equal(ui.el('edit-reason').value, '입력 유지');
});

test('shared theme delimiter is rejected before any write; legacy other-topic rows remain readable', async () => {
  const s = scenario();
  assert.throws(() => s.ctx.validatePresentationSharedTheme('2027년 > 장기 전망'), />/);
  const cycle = await s.addCycle('2026-11-25'); await s.fillCycle(cycle, 1);
  const before = clone(s.tables);
  s.ctx.console = { error() {} };
  assert.equal(await s.renameCycle(cycle, '2027년 > 장기 전망'), false);
  assert.deepEqual(s.tables, before);
  const old = { category: 'industry', topic: '2027년 > 장기 전망 > [자유 주제] 수요 > 공급' };
  assert.equal(s.ctx.isFreePresentation(old), true);
  assert.equal(s.ctx.parsePresentationStockName(old), '수요 > 공급');
  assert.equal(s.ctx.parsePresentationIndustry(old), '2027년 > 장기 전망');
  assert.equal(s.ctx.getPresentationScheduleTopicParts(old).subject, '[자유 주제] 수요 > 공급');
  assert.equal(s.ctx.presentationContentPayload(old, { ...values(), title: '수요 > 공급' }).topic, old.topic);
  assert.equal(s.ctx.matchesPresentationHistoryFilters(old, { format: 'free' }), true);
});
