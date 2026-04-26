// ============================================================
// js/modal-pick.js  v20260427
// 탑픽 제출 팝업 — index.html + picks.html 공통 사용
//
// 사용법:
//   1. HTML에 pickModal 마크업 포함 (또는 ModalPick.mount()로 자동 생성)
//   2. openPickModal() 호출
// ============================================================

const ModalPick = (() => {

  // ── 팝업 HTML 마운트 (페이지에 없으면 자동 생성)
  function mount() {
    if (document.getElementById('pickModal')) return;
    const el = document.createElement('div');
    el.innerHTML = `
<div id="pickModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:600;align-items:flex-start;justify-content:center;overflow-y:auto;padding:2rem 1rem;">
  <div style="background:var(--surface);border-radius:var(--r-lg);padding:1.5rem;width:100%;max-width:520px;border:0.5px solid var(--border);margin:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <div>
        <div style="font-size:15px;font-weight:500;">+ 탑픽 제출</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">내 탑픽 종목 제출</div>
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
    document.getElementById('pickModal').style.display = 'flex';
    document.getElementById('pick-panel').innerHTML =
      '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">불러오는 중...</div>';
    const me = await getCurrentMember();
    if (!me) {
      document.getElementById('pick-panel').innerHTML =
        '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">멤버 정보를 찾을 수 없습니다.</div>';
      return;
    }
    renderPanel(me, opts);
  }

  // ── 닫기
  function close() {
    document.getElementById('pickModal').style.display = 'none';
  }

  // ── 패널 렌더
  function renderPanel(me, opts = {}) {
    const mon = opts.month || currentMonth();
    const panel = document.getElementById('pick-panel');

    panel.innerHTML =
      // 대상 월
      '<div style="margin-bottom:10px;">' +
        '<label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">대상 월</label>' +
        '<input type="month" id="pick-month" value="' + mon + '" style="font-size:13px;padding:7px 10px;width:100%;" />' +
      '</div>' +
      // 종목 검색
      '<div style="margin-bottom:10px;">' +
        '<label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">종목 검색 *</label>' +
        '<div style="position:relative;">' +
          '<input type="text" id="pick-input" placeholder="종목명 또는 코드 (2글자 이상)" style="width:100%;font-size:14px;padding:8px 12px;" autocomplete="off" />' +
          '<div id="pick-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:700;background:var(--surface);border:0.5px solid var(--border2);border-radius:var(--r-md);box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:200px;overflow-y:auto;margin-top:2px;"></div>' +
        '</div>' +
      '</div>' +
      // 선택 배지
      '<div id="pick-badge" style="display:none;align-items:center;gap:8px;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;">' +
        '<button onclick="ModalPick.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>' +
      '</div>' +
      // 현재가 / 목표주가
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재가 (원)</label>' +
          '<input type="number" id="pick-cur-price" placeholder="자동 입력됨" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 주가 (원)</label>' +
          '<input type="number" id="pick-tgt-price" placeholder="예: 90000" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pick-price-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:8px;"></div>' +
      // 현재 시총 / 목표 시총
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재 시총 (억원)</label>' +
          '<input type="number" id="pick-cur-cap" placeholder="자동 입력됨" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 시총 (억원)</label>' +
          '<input type="number" id="pick-tgt-cap" placeholder="예: 4200000" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pick-cap-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;"></div>' +
      // 매수 사유
      '<div style="margin-bottom:12px;">' +
        '<label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">매수 사유</label>' +
        '<textarea id="pick-reason" placeholder="매수 근거, 투자 thesis, 리스크 등" ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:80px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;"></textarea>' +
      '</div>' +
      '<button class="btn btn-primary" id="pick-submit-btn" style="font-size:14px;padding:9px;justify-content:center;width:100%;" ' +
        'onclick="ModalPick.submit(\'' + me.id + '\')">탑픽 제출</button>';

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
        '✅ <strong>' + s.stock_name + '</strong>' +
        ' <span style="color:var(--muted);font-size:12px;">' + s.stock_code + ' · ' + s.market + '</span>' +
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

    const month    = document.getElementById('pick-month')?.value || currentMonth();
    const tgtPrice = parseInt(document.getElementById('pick-tgt-price')?.value) || null;
    const curCap   = parseInt(document.getElementById('pick-cur-cap')?.value)   || null;
    const tgtCap   = parseInt(document.getElementById('pick-tgt-cap')?.value)   || null;
    const reason   = document.getElementById('pick-reason')?.value?.trim()      || null;

    const { data: already } = await sb.from('picks')
      .select('id').eq('member_id', memberId).eq('month', month).maybeSingle();
    if (already) {
      if (!confirm(month.replace('-','년 ') + '월 탑픽을 이미 제출하셨습니다. 추가 제출할까요?')) return;
    }

    const btn = document.getElementById('pick-submit-btn');
    if (btn) { btn.textContent = '제출 중...'; btn.disabled = true; }

    try {
      await submitPick({
        member_id:    memberId,
        month,
        stock_name:   inp.value.trim(),
        stock_code:   inp.dataset.stockCode,
        market:       inp.dataset.market || 'KOSPI',
        target_price: tgtPrice,
        current_cap:  curCap,
        target_cap:   tgtCap,
        reason,
      });
      toast('✅ 탑픽이 제출되었습니다!');
      close();
      // 콜백: 각 페이지가 갱신할 함수를 등록해두면 실행
      if (typeof ModalPick._onSubmit === 'function') ModalPick._onSubmit();
    } catch(e) {
      toast('오류: ' + (e.message || '제출 실패'));
    } finally {
      if (btn) { btn.textContent = '탑픽 제출'; btn.disabled = false; }
    }
  }

  return { mount, open, close, clearStock, submit };
})();

// ── 전역 편의 함수 (기존 호출부 하위호환)
function openPickModal(opts)  { ModalPick.open(opts); }
function closePickModal()     { ModalPick.close(); }
function pickClearStock()     { ModalPick.clearStock(); }
function pickSubmit(memberId) { ModalPick.submit(memberId); }
