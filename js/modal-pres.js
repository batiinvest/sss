// ============================================================
// js/modal-pres.js  v20260427
// 발표종목 입력 팝업 — index.html 전용 (본인 발표종목 draft 저장)
// ============================================================

const ModalPres = (() => {
  let _drafts  = [];   // 현재 유저의 planned presentations (draft)
  let _me      = null;

  // ── 팝업 HTML 마운트
  function mount() {
    if (document.getElementById('presModal')) return;
    const el = document.createElement('div');
    el.innerHTML = `
<div id="presModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:600;align-items:flex-start;justify-content:center;overflow-y:auto;padding:2rem 1rem;">
  <div style="background:var(--surface);border-radius:var(--r-lg);padding:1.5rem;width:100%;max-width:560px;border:0.5px solid var(--border);margin:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <div>
        <div style="font-size:15px;font-weight:500;">📋 발표종목 입력</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">내 발표종목 입력 · 스터디 일정 탭에서 날짜 배정</div>
      </div>
      <button class="btn" onclick="ModalPres.close()" style="font-size:12px;">닫기</button>
    </div>
    <!-- 카테고리 설정 -->
    <div style="background:var(--bg);border-radius:var(--r-md);padding:10px 12px;margin-bottom:1rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="font-size:12px;font-weight:500;color:var(--muted);">이번 발표</span>
      <select id="pm-category" onchange="ModalPres.onCategoryChange()" style="font-size:12px;padding:4px 8px;">
        <option value="stock">기업 분석</option>
        <option value="industry">산업 분석</option>
      </select>
      <div id="pm-industryWrap" style="display:none;flex:1;">
        <input type="text" id="pm-industry" placeholder="산업명 입력 (예: 반도체)" style="font-size:12px;padding:4px 8px;width:100%;max-width:200px;" />
        <div id="pm-industry-hint" style="font-size:11px;color:var(--green);margin-top:2px;display:none;">✅ 다른 멤버 입력 기반 자동 채워짐</div>
      </div>
    </div>
    <!-- 입력 패널 -->
    <div id="pm-memberPanel"></div>
    <!-- 하단 -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;padding-top:1rem;border-top:0.5px solid var(--border);">
      <span style="font-size:12px;color:var(--muted);">저장 후 스터디 일정 → 발표 순서 탭에서 날짜 배정</span>
      <button class="btn btn-primary" style="font-size:13px;" onclick="ModalPres.close()">완료</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el.firstElementChild);
    document.getElementById('presModal').addEventListener('click', e => {
      if (e.target === document.getElementById('presModal')) ModalPres.close();
    });
  }

  // ── 열기
  async function open() {
    mount();
    document.getElementById('presModal').style.display = 'flex';
    document.getElementById('pm-memberPanel').innerHTML =
      '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">불러오는 중...</div>';

    _me = await getCurrentMember();
    if (!_me) {
      document.getElementById('pm-memberPanel').innerHTML =
        '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">멤버 정보를 찾을 수 없습니다.</div>';
      return;
    }

    // 내 draft + 전체 멤버 draft(산업명 공유용) 동시 로드
    const [myRes, allRes] = await Promise.all([
      sb.from('presentations')
        .select('*').eq('status','planned').is('schedule_id',null).eq('member_id',_me.id),
      sb.from('presentations')
        .select('category,topic').eq('status','planned').is('schedule_id',null)
        .order('created_at', { ascending: false }).limit(10)
    ]);
    _drafts = myRes.data || [];

    // 이번 세션의 카테고리 + 산업명 추론
    // 1순위: 전체 draft에서 가장 최근 category/industry
    // 2순위: 완료된 발표 기준 다음 카테고리 추천
    const allDrafts = allRes.data || [];
    let sharedCat      = null;
    let sharedIndustry = '';

    if (allDrafts.length) {
      const latestDraft = allDrafts[0];
      sharedCat = latestDraft.category;
      if (sharedCat === 'industry' && latestDraft.topic?.includes('>')) {
        sharedIndustry = latestDraft.topic.split('>')[0].trim();
      }
    }

    // 카테고리 추천 (draft 없을 때만 이전 완료 발표 기반으로)
    if (!sharedCat) {
      try {
        const { data: last } = await sb.from('presentations')
          .select('category').eq('status','done')
          .order('presented_at', { ascending: false }).limit(1);
        if (last?.[0]) sharedCat = last[0].category === 'stock' ? 'industry' : 'stock';
      } catch(e) {}
    }

    if (sharedCat) {
      document.getElementById('pm-category').value = sharedCat;
      onCategoryChange();
    }

    // 공유 산업명 자동 입력
    if (sharedIndustry) {
      const industryEl = document.getElementById('pm-industry');
      if (industryEl && !industryEl.value) {
        industryEl.value = sharedIndustry;
        // 힌트 표시 (내 draft가 없을 때만 — 다른 사람 기반 자동입력)
        const myDraft = _drafts.find(p => p.member_id === _me.id);
        if (!myDraft) {
          const hintEl = document.getElementById('pm-industry-hint');
          if (hintEl) hintEl.style.display = 'block';
        }
      }
    }

    // 산업명 변경 시 다른 draft들에도 반영 (실시간 공유)
    setTimeout(() => {
      const industryEl = document.getElementById('pm-industry');
      if (industryEl) {
        industryEl.addEventListener('change', () => syncIndustryName(industryEl.value.trim()));
        industryEl.addEventListener('blur',   () => syncIndustryName(industryEl.value.trim()));
      }
    }, 0);

    renderPanel();
  }

  // ── 닫기
  function close() {
    document.getElementById('presModal').style.display = 'none';
    if (typeof ModalPres._onClose === 'function') ModalPres._onClose();
  }

  function onCategoryChange() {
    const cat = document.getElementById('pm-category')?.value;
    const wrap = document.getElementById('pm-industryWrap');
    if (wrap) wrap.style.display = cat === 'industry' ? 'block' : 'none';
  }

  // ── 패널 렌더 (본인 1명)
  function renderPanel() {
    const panel = document.getElementById('pm-memberPanel');
    const draft = _drafts.find(p => p.member_id === _me.id);
    const stockName = draft?.topic?.includes('>') ? draft.topic.split('>')[1].trim() : (draft?.topic || '');

    panel.innerHTML =
      // 종목 검색
      '<div style="position:relative;margin-bottom:10px;">' +
        '<input type="text" id="pm-input" placeholder="종목명 또는 코드 검색" ' +
          'style="width:100%;font-size:14px;padding:8px 12px;" value="' + stockName + '" />' +
        '<div id="pm-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:700;' +
          'background:var(--surface);border:0.5px solid var(--border2);border-radius:var(--r-md);' +
          'box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:200px;overflow-y:auto;margin-top:2px;"></div>' +
      '</div>' +
      // 선택 배지
      '<div id="pm-badge" style="display:' + (draft?.stock_code ? 'flex' : 'none') + ';align-items:center;gap:8px;' +
        'padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);' +
        'font-size:13px;color:var(--green);margin-bottom:10px;">' +
        (draft?.stock_code ? '✅ <strong>' + stockName + '</strong> <span style="color:var(--muted);font-size:12px;">' + draft.stock_code + '</span>' : '') +
        '<button onclick="ModalPres.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>' +
      '</div>' +
      // 현재 시총 / 목표 시총
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재 시총 (억원)</label>' +
          '<input type="number" id="pm-cur-cap" placeholder="자동 입력됨" value="' + (draft?.market_cap_at||'') + '" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 시총 (억원)</label>' +
          '<input type="number" id="pm-tgt-cap" placeholder="예: 4200000" value="' + (draft?.target_cap||'') + '" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pm-cap-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;"></div>' +
      // 투자 사유
      '<div style="margin-bottom:10px;"><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">투자 사유</label>' +
        '<textarea id="pm-reason" placeholder="매수 근거, 투자 thesis 등" ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:64px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;">' +
          (draft?.reason||'') + '</textarea></div>' +
      // 투자 리스크
      '<div><label style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">투자 리스크</label>' +
        '<textarea id="pm-risk" placeholder="주요 리스크 요인" ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:52px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;">' +
          (draft?.risk||'') + '</textarea></div>';

    const inp     = document.getElementById('pm-input');
    const dd      = document.getElementById('pm-dd');
    const curC    = document.getElementById('pm-cur-cap');
    const tgtC    = document.getElementById('pm-tgt-cap');
    const capPrev = document.getElementById('pm-cap-prev');

    inp.dataset.stockCode = draft?.stock_code || '';
    inp.dataset.capAt     = draft?.market_cap_at || '';

    // 자동완성
    bindStockSearch(inp, dd, s => {
      inp.value = s.stock_name;
      inp.dataset.stockCode = s.stock_code;
      inp.dataset.capAt     = s.market_cap || '';
      const badge = document.getElementById('pm-badge');
      badge.style.display = 'flex';
      badge.innerHTML =
        '✅ <strong>' + s.stock_name + '</strong> <span style="color:var(--muted);font-size:12px;">' + s.stock_code + ' · ' + (s.market||'') + '</span>' +
        '<button onclick="ModalPres.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
      if (s.market_cap) curC.value = s.market_cap;
      curC.dispatchEvent(new Event('input'));
      saveDraft(inp);
    });

    // 상승여력
    const calcCap = () => {
      const c = parseInt(curC.value), t = parseInt(tgtC.value);
      capPrev.style.display = (c>0&&t>0) ? 'block' : 'none';
      if (c>0&&t>0)
        capPrev.innerHTML = '시총 상승여력: ' + c.toLocaleString() + '억 → ' + t.toLocaleString() + '억 <strong>(+' + ((t-c)/c*100).toFixed(1) + '%)</strong>';
      saveDraft(inp);
    };
    curC.addEventListener('input', calcCap);
    tgtC.addEventListener('input', calcCap);
    document.getElementById('pm-reason').addEventListener('input', () => saveDraft(inp));
    document.getElementById('pm-risk').addEventListener('input',   () => saveDraft(inp));

    if (draft?.target_cap && draft?.market_cap_at) calcCap();
  }

  // ── 종목 초기화
  function clearStock() {
    const inp = document.getElementById('pm-input');
    if (inp) { inp.value = ''; inp.dataset.stockCode = ''; }
    document.getElementById('pm-dd') && (document.getElementById('pm-dd').style.display = 'none');
    const badge = document.getElementById('pm-badge');
    if (badge) badge.style.display = 'none';
    ['pm-cur-cap','pm-tgt-cap'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    const cp = document.getElementById('pm-cap-prev'); if(cp) cp.style.display='none';
  }

  // ── 산업명 변경 시 내 draft topic 즉시 업데이트
  async function syncIndustryName(industryName) {
    if (!_me || !industryName) return;
    const myDraft = _drafts.find(p => p.member_id === _me.id);
    if (!myDraft || myDraft.category !== 'industry') return;

    // 현재 topic에서 종목명 추출
    const stockName = myDraft.topic?.includes('>')
      ? myDraft.topic.split('>')[1].trim()
      : (myDraft.topic || '');
    if (!stockName) return;

    const newTopic = industryName + ' > ' + stockName;
    await sb.from('presentations').update({ topic: newTopic }).eq('id', myDraft.id);
    myDraft.topic = newTopic;
  }

  // ── Draft 자동 저장
  async function saveDraft(inp) {
    if (!_me) return;
    const stockName = inp?.value?.trim();
    if (!stockName || !inp.dataset.stockCode) return;

    const cat      = document.getElementById('pm-category')?.value || 'stock';
    const industry = document.getElementById('pm-industry')?.value?.trim() || '';
    const topic    = (cat === 'industry' && industry) ? industry + ' > ' + stockName : stockName;
    const payload  = {
      topic, category: cat,
      stock_code:    inp.dataset.stockCode || null,
      market_cap_at: parseInt(document.getElementById('pm-cur-cap')?.value)  || null,
      target_cap:    parseInt(document.getElementById('pm-tgt-cap')?.value)   || null,
      reason:        document.getElementById('pm-reason')?.value?.trim()      || null,
      risk:          document.getElementById('pm-risk')?.value?.trim()        || null,
      status: 'planned',
    };

    const existing = _drafts.find(p => p.member_id === _me.id);
    if (existing) {
      await sb.from('presentations').update(payload).eq('id', existing.id);
      Object.assign(existing, payload);
    } else {
      const { data, error } = await sb.from('presentations')
        .insert({ member_id: _me.id, ...payload }).select().single();
      if (!error && data) _drafts.push(data);
    }
  }

  return { mount, open, close, onCategoryChange, clearStock };
})();

// ── 전역 편의 함수 (기존 호출부 하위호환)
function openPresModal()      { ModalPres.open(); }
function closePresModal()     { ModalPres.close(); }
function onPmCategoryChange() { ModalPres.onCategoryChange(); }
function pmClearStock()       { ModalPres.clearStock(); }
