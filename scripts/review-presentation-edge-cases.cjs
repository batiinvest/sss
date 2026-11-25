// Diagnostic review, not an all-green regression test. No network or production writes.
// Exit 1 means the undesired behavior was reproduced in the isolated scenario store.
const { scenario } = require('../tests/helpers/presentation-scenario.cjs');

(async () => {
  const s = scenario(8);
  s.ctx.console = { error() {} };
  const cycle = await s.addCycle('2026-11-23');
  await s.fillCycle(cycle, 1);
  const freeBefore = s.tables.presentations.filter(s.ctx.isFreePresentation).length;
  const rejected = !(await s.renameCycle(cycle, '2027년 > 장기 전망'));
  const freeAfter = s.tables.presentations.filter(s.ctx.isFreePresentation).length;
  const findings = [{
    id: 'shared-theme-delimiter', reproduced: freeBefore !== freeAfter,
    input: '2027년 > 장기 전망', rejected, freeBefore, freeAfter,
    storedTopic: s.tables.presentations[0].topic,
    parsedIndividualTitle: s.ctx.parsePresentationStockName(s.tables.presentations[0]),
  }];

  const draft = s.ctx.buildPresentationDraftStoragePayload({ member_id: 'test-new-member', status: 'planned',
    category: 'stock', schedule_id: cycle.rows[0].id, topic: '테스트 종목' });
  const values = { format: 'stock', title: '테스트 종목', reason: '테스트 의견', market_cap_at: 100, target_cap: 150 };
  s.lostInsertResponse = true;
  const request = s.ctx.createPresentationInsertRequest(draft, values, draft);
  let firstError;
  try { await s.ctx.savePresentationEdit(s.client, null, draft, values, draft, request); }
  catch (error) { firstError = error.message; }
  await s.ctx.savePresentationEdit(s.client, null, draft, values, draft, request);
  const inserted = s.tables.presentations.filter(row => row.member_id === draft.member_id);
  findings.push({ id: 'new-presentation-retry', reproduced: inserted.length !== 1,
    firstError, rowsAfterRetry: inserted.length, distinctIds: inserted.map(row => row.id),
    limitation: 'Isolated storage only; no production trades or presentations were written.' });
  console.log(JSON.stringify({ findings }, null, 2));
  if (findings.some(finding => finding.reproduced)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 2; });
