// ============================================================
// js/modal-pick.js  v20260427
// 탑픽 제출 팝업 — index.html + picks.html 공통 사용
//
// 사용법:
//   1. HTML에 pickModal 마크업 포함 (또는 ModalPick.mount()로 자동 생성)
//   2. openPickModal() 호출
// ============================================================

const ModalPick = (() => {
  let _dirty = false;
  let _returnFocus = null;

  // ── 팝업 HTML 마운트 (페이지에 없으면 자동 생성)
  function mount() {
    if (document.getElementById('pickModal')) return;
    const el = document.createElement('div');
    el.innerHTML = `
<div id="pickModal" role="dialog" aria-modal="true" aria-labelledby="pick-modal-title" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:600;align-items:flex-start;justify-content:center;overflow-y:auto;padding:2rem 1rem;">
  <div style="background:var(--surface);border-radius:var(--r-lg);padding:1.5rem;width:100%;max-width:520px;border:0.5px solid var(--border);margin:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <div>
        <div id="pick-modal-title" style="font-size:15px;font-weight:500;">투자종목 등록</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">핵심 정보만 먼저 저장하고 상세 내용은 나중에 보완할 수 있습니다.</div>
      </div>
      <button class="btn" onclick="ModalPick.close()" style="font-size:12px;">닫기</button>
    </div>
    <div id="pick-panel"></div>
  </div>
</div>`;
    document.body.appendChild(el.firstElementChild);
    document.getElementById('pickModal').addEventListener('click', e => {
      if (e.target === document.getElementById('pickModal')) ModalPick.close();
    });
  }

  // ── 열기
  async function open(opts = {}) {
    mount();
    _dirty = false;
    _returnFocus = document.activeElement;
    document.getElementById('pickModal').style.display = 'flex';
    document.getElementById('pick-panel').innerHTML =
      '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">불러오는 중...</div>';
    const me = await getCurrentMember();
    if (!me) {
      document.getElementById('pick-panel').innerHTML =
        '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">멤버 정보를 찾을 수 없습니다.</div>';
      return;
    }

    // 전월 탑픽 조회
    const thisMonth = opts.month || currentMonth();
    const [y, m]    = thisMonth.split('-').map(Number);
    const prevMonth = m === 1
      ? `${y-1}-12`
      : `${y}-${String(m-1).padStart(2,'0')}`;

    const { data: prevPicks } = await sb.from('picks_with_trades')
      .select('stock_name,stock_code,market,target_price,current_cap,target_cap,reason,buy_price,buy_quantity,month')
      .eq('member_id', me.id)
      .eq('month', prevMonth)
      .limit(1);
    const prevPick = prevPicks?.[0] || null;

    renderPanel(me, { ...opts, prevPick, thisMonth });
  }

  // ── 닫기
  function close() {
    if (_dirty && !confirm('입력 중인 내용이 있습니다. 닫을까요?')) return;
    _dirty = false;
    document.getElementById('pickModal').style.display = 'none';
    _returnFocus?.focus?.();
  }

  // ── 패널 렌더
  function renderPanel(me, opts = {}) {
    const mon      = opts.thisMonth || opts.month || currentMonth();
    const prevPick = opts.prevPick || null;
    const panel    = document.getElementById('pick-panel');

    // 전월 탑픽 유지 배너
    const prevBanner = prevPick
      ? `<div id="prev-pick-banner"
            data-tgt-price="${prevPick.target_price||''}"
            data-tgt-cap="${prevPick.target_cap||''}"
            data-buy-price="${prevPick.buy_price||prevPick.buy_price_ref||''}"
            data-from-month="${prevPick.month||''}"
            data-reason="${escapeHtml(prevPick.reason||'')}"
            style="background:var(--bg);border:0.5px solid var(--border2);border-radius:var(--r-md);padding:10px 14px;margin-bottom:12px;">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">전월 탑픽 — 동일 종목 유지?</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
              <span style="font-size:14px;font-weight:500;">${escapeHtml(prevPick.stock_name)}</span>
              <span style="color:var(--muted);font-size:12px;margin-left:6px;">${escapeHtml(prevPick.stock_code)} · ${escapeHtml(prevPick.market)}</span>
              ${prevPick.buy_price ? `<span style="font-size:12px;color:var(--muted);margin-left:6px;">· 매수가 ${prevPick.buy_price.toLocaleString()}원</span>` : ''}
            </div>
            <button class="btn btn-primary" style="font-size:12px;white-space:nowrap;"
              onclick="ModalPick.carryOver()">↩ 이 종목으로 유지</button>
          </div>
          ${prevPick.reason ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;line-height:1.5;">${escapeHtml(prevPick.reason.slice(0,80))}${prevPick.reason.length>80?'…':''}</div>` : ''}
        </div>`
      : '';

    panel.innerHTML =
      prevBanner +
      // 대상 월
      '<div style="margin-bottom:10px;">' +
        '<label for="pick-month" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">대상 월</label>' +
        '<input type="month" id="pick-month" value="' + mon + '" aria-label="대상 월" style="font-size:13px;padding:7px 10px;width:100%;" />' +
      '</div>' +
      // 종목 검색
      '<div style="margin-bottom:10px;">' +
        '<label for="pick-input" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">종목 검색 *</label>' +
        '<div style="position:relative;">' +
          '<input type="text" id="pick-input" placeholder="종목명 또는 코드 (2글자 이상)" style="width:100%;font-size:14px;padding:8px 12px;" autocomplete="off" />' +
          '<div id="pick-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:700;background:var(--surface);border:0.5px solid var(--border2);border-radius:var(--r-md);box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:200px;overflow-y:auto;margin-top:2px;"></div>' +
        '</div>' +
      '</div>' +
      // 선택 배지
      '<div id="pick-badge" style="display:none;align-items:center;gap:8px;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;">' +
        '<button onclick="ModalPick.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>' +
      '</div>' +
      // 매수가 (직접 입력 가능)
      '<div style="margin-bottom:8px;">' +
        '<label for="pick-buy-price" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">' +
          '예상 또는 평균 매수가 (원) <span style="font-weight:400;color:var(--muted);">— 선택</span>' +
        '</label>' +
        '<input type="number" id="pick-buy-price" inputmode="numeric" min="1" placeholder="예: 75,500" style="font-size:13px;padding:7px 10px;width:100%;">' +
      '</div>' +
      // 현재가 / 목표주가
      '<div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">' +
        '<div><label for="pick-cur-price" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재가 (원)</label>' +
          '<input type="number" id="pick-cur-price" inputmode="numeric" min="1" placeholder="종목 선택 시 자동 입력" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label for="pick-tgt-price" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 주가 (원) *</label>' +
          '<input type="number" id="pick-tgt-price" inputmode="numeric" min="1" placeholder="예: 90,000" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pick-price-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:8px;"></div>' +
      // 현재 시총 / 목표 시총
      '<details class="optional-details">' +
        '<summary>선택 정보 · 시가총액 기준도 함께 관리</summary>' +
      '<div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0 8px;">' +
        '<div><label for="pick-cur-cap" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재 시총 (억원)</label>' +
          '<input type="number" id="pick-cur-cap" inputmode="numeric" min="1" placeholder="자동 입력" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label for="pick-tgt-cap" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 시총 (억원)</label>' +
          '<input type="number" id="pick-tgt-cap" inputmode="numeric" min="1" placeholder="예: 420,000" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pick-cap-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;"></div>' +
      '</details>' +
      // 매수 사유
      '<div style="margin-bottom:12px;">' +
        '<label for="pick-reason" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">핵심 투자 의견 *</label>' +
        '<textarea id="pick-reason" placeholder="왜 이 종목을 투자 후보로 보는지 핵심만 입력하세요." ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:80px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;"></textarea>' +
      '</div>' +
      '<div class="mobile-sticky-action"><button class="btn btn-primary" id="pick-submit-btn" style="font-size:14px;padding:9px;justify-content:center;width:100%;" ' +
        'onclick="ModalPick.submit(\'' + me.id + '\')">투자종목 저장</button></div>';

    // 종목 자동완성
    const inp   = document.getElementById('pick-input');
    const dd    = document.getElementById('pick-dd');
    const badge = document.getElementById('pick-badge');
    bindStockSearch(inp, dd, s => {
      inp.value = s.stock_name;
      inp.dataset.stockCode = s.stock_code;
      inp.dataset.market    = s.market || 'KOSPI';
      badge.style.display   = 'flex';
      badge.innerHTML =
        '✅ <strong>' + escapeHtml(s.stock_name) + '</strong>' +
        ' <span style="color:var(--muted);font-size:12px;">' + escapeHtml(s.stock_code) + ' · ' + escapeHtml(s.market) + '</span>' +
        '<button onclick="ModalPick.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
      const curP = document.getElementById('pick-cur-price');
      const curC = document.getElementById('pick-cur-cap');
      if (s.price)      curP.value = s.price;
      if (s.market_cap) curC.value = s.market_cap;
      curP.dispatchEvent(new Event('input'));
    });

    // 상승여력 계산
    const pricePrev = document.getElementById('pick-price-prev');
    const capPrev   = document.getElementById('pick-cap-prev');
    const calcCap = () => {
      const c = parseInt(document.getElementById('pick-cur-cap')?.value);
      const t = parseInt(document.getElementById('pick-tgt-cap')?.value);
      capPrev.style.display = (c > 0 && t > 0) ? 'block' : 'none';
      if (c > 0 && t > 0)
        capPrev.innerHTML = '시총 상승여력: ' + c.toLocaleString() + '억 → ' + t.toLocaleString() + '억 <strong>(+' + ((t-c)/c*100).toFixed(1) + '%)</strong>';
    };
    const calcPrice = () => {
      const c = parseInt(document.getElementById('pick-cur-price')?.value);
      const t = parseInt(document.getElementById('pick-tgt-price')?.value);
      pricePrev.style.display = (c > 0 && t > 0) ? 'block' : 'none';
      if (c > 0 && t > 0)
        pricePrev.innerHTML = '주가 상승여력: ' + c.toLocaleString() + '원 → ' + t.toLocaleString() + '원 <strong>(' + ((t-c)/c*100).toFixed(1) + '%)</strong>';
      if (c > 0 && parseInt(document.getElementById('pick-cur-cap')?.value) > 0 && t > 0)
        document.getElementById('pick-tgt-cap').value =
          Math.round(parseInt(document.getElementById('pick-cur-cap').value) * (t / c));
      calcCap();
    };
    document.getElementById('pick-cur-price').addEventListener('input', calcPrice);
    document.getElementById('pick-tgt-price').addEventListener('input', calcPrice);
    document.getElementById('pick-cur-cap').addEventListener('input', calcCap);
    document.getElementById('pick-tgt-cap').addEventListener('input', calcCap);

    panel.addEventListener('input', () => { _dirty = true; });

    const prefill = opts.prefill || null;
    if (prefill?.stock_name) {
      inp.value = prefill.stock_name;
      inp.dataset.stockCode = prefill.stock_code || '';
      inp.dataset.market = prefill.market || 'KOSPI';
      badge.style.display = 'flex';
      badge.innerHTML =
        '✅ <strong>' + escapeHtml(prefill.stock_name) + '</strong>' +
        ' <span style="color:var(--muted);font-size:12px;">' + escapeHtml(prefill.stock_code || '') + ' · ' + escapeHtml(prefill.market || 'KOSPI') + '</span>' +
        '<button type="button" onclick="ModalPick.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
      if (prefill.price) document.getElementById('pick-cur-price').value = prefill.price;
      if (prefill.market_cap) document.getElementById('pick-cur-cap').value = prefill.market_cap;
      if (prefill.target_price) document.getElementById('pick-tgt-price').value = prefill.target_price;
      if (prefill.target_cap) document.getElementById('pick-tgt-cap').value = prefill.target_cap;
      if (prefill.reason) document.getElementById('pick-reason').value = prefill.reason;
      if (prefill.source_presentation_id) {
        panel.insertAdjacentHTML('afterbegin', '<div class="info-banner" style="margin-bottom:10px;">발표종목 정보를 불러왔습니다. 매수가와 목표가를 확인한 뒤 저장하세요.</div>');
      }
      document.getElementById('pick-cur-price').dispatchEvent(new Event('input'));
      document.getElementById('pick-tgt-cap').dispatchEvent(new Event('input'));
      document.getElementById('prev-pick-banner')?.style.setProperty('display', 'none');
      _dirty = true;
    }
    setTimeout(() => (prefill?.stock_name ? document.getElementById('pick-tgt-price') : inp)?.focus(), 0);
  }

  // ── 전월 탑픽 그대로 제출
  async function carryOver() {
    const banner = document.getElementById('prev-pick-banner');
    if (!banner) return;

    // 배너에서 종목명/코드 읽기
    const nameEl = banner.querySelector('span[style*="font-weight:500"]');
    const codeEl = banner.querySelector('span[style*="color:var(--muted)"]');
    if (!nameEl || !codeEl) return;

    const stockName = nameEl.textContent.trim();
    const parts     = codeEl.textContent.trim().split('·');
    const stockCode = parts[0]?.trim();
    const market    = parts[1]?.trim() || 'KOSPI';

    if (!stockName || !stockCode) return;

    // 폼에 종목 자동 입력
    const inp = document.getElementById('pick-input');
    if (inp) {
      inp.value = stockName;
      inp.dataset.stockCode = stockCode;
      inp.dataset.market    = market;
    }

    // 배지 표시
    const badge = document.getElementById('pick-badge');
    if (badge) {
      badge.style.display = 'flex';
      badge.innerHTML =
        '✅ <strong>' + escapeHtml(stockName) + '</strong>' +
        ' <span style="color:var(--muted);font-size:12px;">' + escapeHtml(stockCode) + ' · ' + escapeHtml(market) + '</span>' +
        '<button onclick="ModalPick.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
    }

    // 현재가 조회 후 매수가·시총 자동 입력
    try {
      const { data } = await sb.from('stock_prices')
        .select('price,market_cap').eq('stock_code', stockCode).single();
      if (data?.price) {
        const curP  = document.getElementById('pick-cur-price');
        const curC  = document.getElementById('pick-cur-cap');
        const buyP  = document.getElementById('pick-buy-price'); // 매수가 = 현재가
        if (curP)  { curP.value  = data.price; curP.dispatchEvent(new Event('input')); }
        if (buyP)  { buyP.value  = data.price; }  // 유지 시 매수가 = 오늘 현재가
        if (curC && data.market_cap) { curC.value = data.market_cap; curC.dispatchEvent(new Event('input')); }
      }
    } catch(e) {}

    // 전월 목표가·시총·매수사유 복사 (매수가는 현재가로 이미 입력됨)
    const tgtP   = document.getElementById('pick-tgt-price');
    const tgtC   = document.getElementById('pick-tgt-cap');
    const reason = document.getElementById('pick-reason');
    if (banner.dataset.tgtPrice && tgtP)   { tgtP.value = banner.dataset.tgtPrice; tgtP.dispatchEvent(new Event('input')); }
    if (banner.dataset.tgtCap   && tgtC)   { tgtC.value = banner.dataset.tgtCap;   tgtC.dispatchEvent(new Event('input')); }
    if (banner.dataset.reason   && reason) reason.value = banner.dataset.reason;

    // 이월 마킹
    if (inp) inp.dataset.carriedFrom = banner.dataset.fromMonth || '';

    // 배너 숨기기 (이미 선택됨)
    banner.style.display = 'none';
    toast('전월 탑픽 ' + stockName + ' 이 입력됐습니다. 내용 확인 후 제출하세요.');
  }

  // ── 종목 초기화
  function clearStock() {
    const inp = document.getElementById('pick-input');
    if (inp) { inp.value = ''; inp.dataset.stockCode = ''; inp.focus(); }
    document.getElementById('pick-dd') && (document.getElementById('pick-dd').style.display = 'none');
    document.getElementById('pick-badge') && (document.getElementById('pick-badge').style.display = 'none');
    ['pick-cur-price','pick-tgt-price','pick-cur-cap','pick-tgt-cap'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    ['pick-price-prev','pick-cap-prev'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
  }

  // ── 제출
  async function submit(memberId) {
    const inp = document.getElementById('pick-input');
    if (!inp?.value.trim() || !inp?.dataset.stockCode) { toast('종목을 검색해서 선택하세요.'); return; }

    const month       = document.getElementById('pick-month')?.value      || currentMonth();
    const tgtPrice    = parseInt(document.getElementById('pick-tgt-price')?.value)  || null;
    const curCap      = parseInt(document.getElementById('pick-cur-cap')?.value)    || null;
    const tgtCap      = parseInt(document.getElementById('pick-tgt-cap')?.value)    || null;
    const reason      = document.getElementById('pick-reason')?.value?.trim()       || null;
    const buyPriceInp = parseInt(document.getElementById('pick-buy-price')?.value)  || null;
    const curPrice    = parseInt(document.getElementById('pick-cur-price')?.value)  || null;
    const carriedFrom = inp.dataset.carriedFrom || null;
    // 매수가 직접 입력 시 우선, 없으면 현재가를 추천 시점가로 사용
    const priceAt     = buyPriceInp || curPrice || null;

    if (!reason) { toast('핵심 투자 의견을 입력하세요.'); document.getElementById('pick-reason')?.focus(); return; }
    if (!tgtPrice && !tgtCap) { toast('목표 주가 또는 목표 시가총액을 입력하세요.'); document.getElementById('pick-tgt-price')?.focus(); return; }
    if ([tgtPrice, curCap, tgtCap, buyPriceInp, curPrice].some(value => value != null && value <= 0)) {
      toast('가격과 시가총액은 0보다 큰 숫자로 입력하세요.');
      return;
    }

    const { data: already } = await sb.from('picks')
      .select('id,stock_code,stock_name').eq('member_id', memberId).eq('month', month).maybeSingle();
    let hasLinkedTrades = false;
    if (already) {
      const changingStock = already.stock_code !== inp.dataset.stockCode;
      const { data: linkedTrades } = await sb.from('trades').select('id').eq('pick_id', already.id).limit(1);
      hasLinkedTrades = Boolean(linkedTrades?.length);
      if (changingStock && hasLinkedTrades) {
          toast('매매내역이 있는 투자종목은 종목을 바꿀 수 없습니다. 목표가와 투자 의견만 수정해 주세요.');
          return;
      }
      if (!confirm(month.replace('-','년 ') + '월 투자종목이 이미 있습니다.\n기존 기록을 안전하게 수정할까요?')) return;
    }

    const payload = {
      member_id:     memberId,
      month,
      stock_name:    inp.value.trim(),
      stock_code:    inp.dataset.stockCode,
      market:        inp.dataset.market || 'KOSPI',
      target_price:  tgtPrice,
      current_cap:   curCap,
      target_cap:    tgtCap,
      reason,
      price_at:      priceAt,
      carried_from:  carriedFrom,
    };

    const btn = document.getElementById('pick-submit-btn');
    if (btn) { btn.textContent = '저장 중…'; btn.disabled = true; }

    try {
      if (already) {
        const safeUpdate = hasLinkedTrades
          ? { target_price: tgtPrice, current_cap: curCap, target_cap: tgtCap, reason }
          : payload;
        const { error } = await sb.from('picks').update(safeUpdate).eq('id', already.id);
        if (error) throw error;
      } else {
        await submitPick(payload);
      }
      toast('투자종목을 저장했습니다.');
      _dirty = false;
      close();
      if (typeof ModalPick._onSubmit === 'function') ModalPick._onSubmit();
    } catch(e) {
      toast('오류: ' + (e.message || '제출 실패'));
    } finally {
      if (btn) { btn.textContent = '투자종목 저장'; btn.disabled = false; }
    }
  }

  return { mount, open, close, clearStock, submit, carryOver };
})();

// ── 전역 편의 함수 (기존 호출부 하위호환)
function openPickModal(opts)  { ModalPick.open(opts); }
function closePickModal()     { ModalPick.close(); }
function pickClearStock()     { ModalPick.clearStock(); }
function pickSubmit(memberId) { ModalPick.submit(memberId); }
