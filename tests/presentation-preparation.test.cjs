const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'schedule-order.html'), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function modal() {
  const elements = new Map();
  const writes = [];
  let failure = false;
  const context = {
    console, confirm: () => true, toast() {},
    document: {
      activeElement: { focus() {} },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', style: {}, focus() {} });
        return elements.get(id);
      },
    },
    sb: { from() {
      const request = (kind, payload) => {
        writes.push({ kind, payload });
        return { eq() { return this; }, select() { return this; }, async single() {
          return failure ? { error: new Error('offline') } : { data: { ...payload, id: 'saved', member_id: 'm' } };
        } };
      };
      return { insert: p => request('insert', p), update: p => request('update', p) };
    } },
    getAutomaticPresentationPlan: () => ({}), getMemberPresentationPlanItem: () => null,
    registerDraftForFutureCycleIfNeeded: async () => {}, reloadPresentationSetupData: async () => {},
    refreshPresentationScheduleViews() {}, schedules: [], presentations: [],
  };
  vm.createContext(context);
  vm.runInContext(section('let _editDraft = null;', "document.getElementById('presEditModal').addEventListener"), context);
  return { context, elements, writes, fail: value => { failure = value; } };
}
test('selecting and cancelling a new presentation never writes to storage', () => {
  const { context, writes, elements } = modal();
  const payload = { topic: '삼성전자', member_id: 'm', status: 'planned' };
  context.openPresEditModal({ name: '회원' }, payload, payload);
  assert.equal(writes.length, 0);
  context.closePresEditModal();
  assert.equal(writes.length, 0);
  assert.equal(elements.get('presEditModal').style.display, 'none');
});
test('dirty existing presentation stays open when discard is declined', () => {
  const { context, elements } = modal();
  context.openPresEditModal({ name: '회원' }, { id: 'old', topic: '삼성전자', reason: '원래 의견' });
  elements.get('edit-reason').value = '수정 의견';
  context.confirm = () => false;
  context.closePresEditModal();
  assert.equal(elements.get('presEditModal').style.display, 'flex');
});
test('failed save keeps input and permits retry with topic and details together', async () => {
  const { context, elements, writes, fail } = modal();
  const payload = { topic: '삼성전자', member_id: 'm', status: 'planned', schedule_id: 'round1' };
  context.openPresEditModal({ name: '회원' }, payload, payload);
  elements.get('edit-reason').value = '투자 근거';
  elements.get('edit-risk').value = '경쟁 심화';
  fail(true);
  await context.savePresEditModal();
  assert.equal(elements.get('presEditModal').style.display, 'flex');
  assert.equal(elements.get('edit-reason').value, '투자 근거');
  fail(false);
  await context.savePresEditModal();
  assert.equal(elements.get('presEditModal').style.display, 'none');
  assert.equal(writes[1].payload.topic, '삼성전자');
  assert.equal(writes[1].payload.reason, '투자 근거');
  assert.equal(writes[1].payload.schedule_id, 'round1');
});
test('successful insert followed by refresh failure retries as update, preventing duplicates', async () => {
  const { context, writes } = modal();
  const payload = { topic: '삼성전자', member_id: 'm', status: 'planned' };
  context.openPresEditModal({ name: '회원' }, payload, payload);
  context.reloadPresentationSetupData = async () => { throw new Error('refresh failed'); };
  await context.savePresEditModal();
  context.reloadPresentationSetupData = async () => {};
  await context.savePresEditModal();
  assert.deepEqual(writes.map(w => w.kind), ['insert', 'update']);
});
test('impact names changed members and readiness requires substantive topic, reason and risk', () => {
  const context = { members: [{ id: 'a', name: '가' }, { id: 'b', name: '나' }] };
  vm.createContext(context);
  vm.runInContext(section('function describePresentationPlanChanges', 'function renderRoundReadiness'), context);
  const plan = ids => ({ items: ids.map((id, i) => ({ memberIds: [id], schedule: { event_date: `2026-10-${10 + i}` } })) });
  const message = context.describePresentationPlanChanges(plan(['a', 'b']), plan(['b', 'a']));
  assert.match(message, /가: 2026-10-10 → 2026-10-11/);
  assert.match(message, /나: 2026-10-11 → 2026-10-10/);
  assert.equal(context.getPresentationReadiness({ topic: ' ' }), '종목 미입력');
  assert.equal(context.getPresentationReadiness({ topic: '삼성전자', reason: '분석', risk: ' ' }), '내용 작성 중');
  assert.equal(context.getPresentationReadiness({ topic: '삼성전자', reason: '분석', risk: '경쟁' }), '내용 입력 완료');
});

test('unassigned draft appears only in its next round, not every future round', () => {
  const element = () => ({ children: [], appendChild(child) { this.children.push(child); } });
  const container = element();
  const items = ['first', 'second'].map(id => ({ memberIds: ['a'], schedule: { id, event_date: id, category: 'stock' } }));
  const context = {
    document: { getElementById: () => container, createElement: element },
    members: [{ id: 'a', name: '회원' }], presentations: [], schedules: [], presentationDraftEpoch: null,
    CAT_LABEL: { stock: '기업 분석' }, escapeHtml: value => value,
    findCurrentPresentationDraft: () => ({ topic: '삼성전자', reason: '의견', risk: '경쟁' }),
    getNextPresentationInputPlanItem: () => items[0],
  };
  vm.createContext(context);
  vm.runInContext(section('function getPresentationReadiness', 'function renderMyPresentationCard'), context);
  context.renderRoundReadiness({ items });
  assert.match(container.children[0].children[0].textContent, /삼성전자 · 내용 입력 완료/);
  assert.match(container.children[1].children[0].textContent, /종목 미정 · 종목 미입력/);
});
