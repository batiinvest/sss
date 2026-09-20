let caPreviewState = null;
let caBusy = false;
const caElement = id => document.getElementById(id);
function caReadForm() {
  return validateBonusAction({ stock_code: caElement('caCode').value.trim(),
    stock_name: caElement('caName').value.trim(), existing_shares: Number(caElement('caExisting').value),
    new_shares: Number(caElement('caNew').value), ex_date: caElement('caEx').value,
    record_date: caElement('caRecord').value, expected_credit_date: caElement('caExpected').value || null,
    source_url: caElement('caSource').value.trim() });
}
function caInvalidate() {
  caPreviewState = null;
  caElement('caPreview').hidden = true;
  const existing = Number(caElement('caExisting').value);
  const added = Number(caElement('caNew').value);
  caElement('caRatio').textContent = existing > 0 && added > 0
    ? `기존 ${existing}주당 신주 ${added}주 → 총 ${existing + added}주` : '배정 비율을 입력하세요.';
}
async function caRun(operation) {
  if (caBusy) return;
  caBusy = true;
  caElement('caError').textContent = '';
  document.querySelectorAll('button, input').forEach(element => { element.disabled = true; });
  try { await operation(); }
  catch (error) { caElement('caError').textContent = error.message || '처리하지 못했습니다.'; }
  finally {
    caBusy = false;
    document.querySelectorAll('button, input').forEach(element => { element.disabled = false; });
  }
}
async function caLoadHistory() {
  const rows = await corporateRpc('sss_corporate_actions_list');
  const container = caElement('caHistory');
  container.innerHTML = '';
  if (!rows?.length) { container.textContent = '등록한 무상증자가 없습니다.'; return; }
  for (const row of rows) {
    const article = document.createElement('article');
    article.className = 'detail-section';
    const heading = document.createElement('h3');
    heading.textContent = `${row.stock_name} · ${row.existing_shares}:${row.new_shares}`;
    const text = document.createElement('p');
    text.textContent = `권리락 ${row.ex_date} · ${row.credit_date ? '입고 ' + row.credit_date : '신주 미입고'} · ${row.status === 'reversed' ? '취소됨' : '반영됨'}`;
    article.append(heading, text);
    if (row.status === 'applied' && !row.credit_date) {
      const label = document.createElement('label');
      label.htmlFor = `credit-${row.id}`;
      label.textContent = '실제 신주 입고일';
      const date = document.createElement('input');
      date.type = 'date'; date.id = label.htmlFor; date.min = row.ex_date;
      date.max = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
      const button = document.createElement('button');
      button.className = 'btn'; button.textContent = '입고 확인'; button.type = 'button';
      const requestId = crypto.randomUUID();
      button.onclick = () => caRun(async () => {
        corporateActionDateTime(date.value);
        await corporateRpc('sss_credit_bonus', { p_action_id: row.id, p_credit_date: date.value, p_request_id: requestId });
        await caLoadHistory(); toast('신주 입고를 반영했습니다.');
      });
      article.append(label, date, button);
    }
    if (row.status === 'applied') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '잘못 등록한 내역 취소';
      const reason = document.createElement('input');
      reason.placeholder = '취소 사유'; reason.setAttribute('aria-label', row.stock_name + ' 무상증자 취소 사유');
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = '기록을 남기고 취소';
      const requestId = crypto.randomUUID();
      cancel.onclick = () => caRun(async () => {
        if (reason.value.trim().length < 3) throw new Error('취소 사유를 3자 이상 입력하세요.');
        await corporateRpc('sss_reverse_bonus', { p_action_id: row.id, p_reason: reason.value.trim(), p_request_id: requestId });
        await caLoadHistory(); toast('무상증자를 취소하고 잔고를 다시 계산했습니다.');
      });
      const help = document.createElement('p');
      help.textContent = '취소 후 수량·결산이 다시 계산됩니다. 이미 신주를 매도해 잔고가 부족해지는 경우에는 취소되지 않습니다.';
      details.append(summary, help, reason, cancel); article.append(details);
    }
    container.append(article);
  }
}
caElement('caForm').addEventListener('input', caInvalidate);
caElement('caRfPreset').onclick = () => {
  for (const [id, value] of Object.entries({ caCode: '327260', caName: 'RF머트리얼즈', caExisting: '1', caNew: '1',
    caEx: '2026-07-24', caRecord: '2026-07-27', caExpected: '2026-08-18',
    caSource: 'https://kind.krx.co.kr/external/2026/07/10/000410/20260710000913/11307.htm' })) caElement(id).value = value;
  caInvalidate();
};
caElement('caForm').onsubmit = event => {
  event.preventDefault();
  caRun(async () => {
    const payload = caReadForm();
    const preview = await corporateRpc('sss_preview_bonus', { p_action: payload });
    caPreviewState = { payload, token: preview.token, requestId: crypto.randomUUID() };
    caElement('caPreviewBody').innerHTML = (preview.positions || []).map(row => '<p><strong>' + escapeHtml(row.member_name) +
      '</strong> · ' + Number(row.beforeQuantity).toLocaleString('ko-KR') + '주 → ' +
      Number(row.quantity).toLocaleString('ko-KR') + '주<br>평균 매수가 ' + won(Number(row.beforeAverage)) + ' → ' +
      won(Number(row.averagePrice)) + '<br>총원가 ' + won(Number(row.cost)) + ' · 미입고 ' +
      Number(row.pendingQuantity).toLocaleString('ko-KR') + '주<br>결산 보정 차액 ' + won(Number(row.settlementDelta || 0)) + '</p>').join('') || '<p>권리 대상 보유분이 없습니다.</p>';
    caElement('caPreview').hidden = false;
  });
};
caElement('caApply').onclick = () => caRun(async () => {
  if (!caPreviewState || JSON.stringify(caReadForm()) !== JSON.stringify(caPreviewState.payload)) {
    caInvalidate(); throw new Error('내용이 변경되었습니다. 미리보기를 다시 확인하세요.');
  }
  await corporateRpc('sss_apply_bonus', { p_action: caPreviewState.payload,
    p_preview_token: caPreviewState.token, p_request_id: caPreviewState.requestId });
  caInvalidate(); await caLoadHistory(); toast('무상증자를 반영했습니다.');
});
(async () => {
  await requireAuth();
  if (!await isAdmin()) { caElement('caStatus').textContent = '관리자만 이용할 수 있습니다.'; caElement('caHistory').textContent = ''; return; }
  await caRun(async () => {
    if (!await corporateBackendAvailable()) {
      caElement('caStatus').textContent = '운영 DB 연결 설정 대기 중입니다. 아직 보유 수량에는 적용되지 않았습니다.';
      caElement('caHistory').textContent = '연결 후 반영 이력이 표시됩니다.';
      return;
    }
    caElement('caStatus').textContent = '변경 내역을 확인한 뒤 적용하세요.';
    caElement('caFormCard').hidden = false;
    await caLoadHistory();
  });
})();
