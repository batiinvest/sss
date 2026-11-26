let ideas = [], ideaMembers = [], ideaMe = null, ideaAdmin = false;
async function reloadIdeas() {
  ideas = await fetchAllPicks({}, { strict: true });
  renderIdeas();
}
function renderIdeas() {
  const month = document.getElementById('ideaMonth').value;
  const member = document.getElementById('ideaMember').value;
  const query = document.getElementById('ideaSearch').value.trim().toLowerCase();
  const effective = month ? buildCarryForwardPicks(month, ideas.filter(row => row.month === month), ideas,
    { activeMemberIds: new Set(ideaMembers.map(m => m.id)) }) : ideas;
  const rows = effective.filter(row => (!member || row.member_id === member) &&
    (!query || [row.stock_name, row.stock_code, row.reason, row.member_name].join(' ').toLowerCase().includes(query)));
  document.getElementById('ideaNotice').textContent = rows.length
    ? `${rows.length}건 · 담당자별 월 1개 탑픽 · 실제 매수 여부와 관계없이 표시됩니다.`
    : '조건에 맞는 탑픽이 없습니다. 추천 월이나 담당자를 변경하거나 탑픽을 등록하세요.';
  document.getElementById('ideaList').innerHTML = rows.map(row => `<article class="card" style="padding:18px" id="idea-${escapeHtml(row.pick_id || row.id)}">
    <div class="card-head"><strong>${escapeHtml(row.stock_name)}</strong><span class="badge">${row._isCarryFallback ? '자동 연장 탑픽' : '탑픽'}</span></div>
    <p class="muted">${escapeHtml(row.member_name || '')} · ${escapeHtml(row.month)} · ${escapeHtml(row.stock_code || '')}</p>
    <div class="detail-hero"><div><span>아이디어 기준가</span><strong>${row.price_at ? won(row.price_at) : '—'}</strong></div>
    <div><span>목표 주가</span><strong>${row.target_price ? won(row.target_price) : '—'}</strong></div>
    <div><span>목표 시가총액</span><strong>${row.target_cap ? Number(row.target_cap).toLocaleString('ko-KR') + '억원' : '—'}</strong></div></div>
    <p style="white-space:pre-wrap">${escapeHtml(row.reason || '투자 의견 없음')}</p>
    ${(ideaAdmin || ideaMe?.id === row.member_id) ? `<button class="btn" data-edit-idea="${escapeHtml(row.pick_id || row.id)}">탑픽 수정</button>` : ''}
  </article>`).join('');
  document.querySelectorAll('[data-edit-idea]').forEach(button => button.addEventListener('click', () => {
    const row = ideas.find(item => String(item.pick_id || item.id) === button.dataset.editIdea);
    if (row) openPickForm({ month: document.getElementById('ideaMonth').value || row.month, member: ideaMembers.find(m => m.id === row.member_id) });
  }));
}
function openPickForm(options = {}) {
  const selectedMember = ideaMembers.find(m => m.id === document.getElementById('ideaMember').value);
  return ModalPick.open({ month: document.getElementById('ideaMonth').value || currentMonth(),
    ...(ideaAdmin && selectedMember ? { member: selectedMember } : {}), ...options });
}
async function initIdeas() {
  if (!await requireAuth()) return;
  try {
    [ideaMembers, ideaMe, ideaAdmin] = await Promise.all([fetchMembers({ strict: true }), getCurrentMember(), isAdmin()]);
    const params = new URLSearchParams(location.search);
    document.getElementById('ideaMonth').value = params.get('month') || currentMonth();
    document.getElementById('ideaSearch').value = params.get('search') || '';
    document.getElementById('ideaMember').innerHTML = '<option value="">전체 담당자</option>' + ideaMembers.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    document.getElementById('newIdea').disabled = !ideaMe && !ideaAdmin;
    ModalPick.mount();
    ModalPick._onSubmit = reloadIdeas;
    await reloadIdeas();
    const target = ideas.find(row => String(row.pick_id || row.id) === params.get('id'));
    if (target) {
      document.getElementById('ideaMonth').value = target.month;
      renderIdeas();
      document.getElementById('idea-' + (target.pick_id || target.id))?.scrollIntoView({ block: 'center' });
    }
    if (params.get('action') === 'new') {
      if (params.get('presentation')) await openPickFromPresentation(params.get('presentation'));
      else await openPickForm();
    }
  } catch (error) {
    document.getElementById('ideaNotice').textContent = '탑픽을 불러오지 못했습니다. 새로고침해 주세요. ' + (error.message || '');
  }
}
initIdeas();

async function openPickFromPresentation(presentationId) {
  const { data: presentation, error } = await sb.from('presentations')
    .select('*').eq('id', presentationId).maybeSingle();
  if (error || !presentation) {
    toast('연결할 발표종목을 찾지 못했습니다.');
    openPickForm();
    return;
  }
  if (isFreePresentation(presentation)) {
    toast('기타 발표입니다. 투자종목은 종목을 선택해 별도로 등록해 주세요.');
    return;
  }
  const stockName = parsePresentationStockName(presentation);
  let stock = null;
  if (presentation.stock_code) {
    const { data } = await sb.from('stock_prices')
      .select('stock_code,stock_name,market,price,market_cap')
      .eq('stock_code', presentation.stock_code).maybeSingle();
    stock = data || null;
  }
  if (!stock && stockName.length >= 2) {
    const matches = await searchStockPrices(stockName, 5);
    stock = matches.find(item => item.stock_name === stockName) || matches[0] || null;
  }
  openPickForm({
    prefill: {
      stock_name: stock?.stock_name || stockName,
      stock_code: stock?.stock_code || presentation.stock_code || '',
      market: stock?.market || 'KOSPI',
      price: stock?.price || null,
      market_cap: stock?.market_cap || null,
      target_cap: presentation.target_cap || null,
      reason: presentation.reason || '',
      source_presentation_id: presentation.id,
    }
  });
}
