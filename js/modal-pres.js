// ============================================================
// js/modal-pres.js  v20260725
// 발표종목 입력 팝업 — index.html 전용 (본인 발표종목 draft 저장)
// ============================================================

const ModalPres = (() => {
  let _drafts  = [];   // 현재 유저의 planned presentations (draft)
  let _me      = null;
  let _draftSaveTimer = null;
  let _draftSaveInput = null;
  let _draftSaveQueue = Promise.resolve();
  let _lastSavedDraftKey = null;
  let _lastQueuedDraftKey = null;
  let _returnFocus = null;
  let _autoAssignment = null;
  let _draftEpoch = null;
  let _industryConfigKey = null;
  let _industrySaveQueue = Promise.resolve(true);
  let _industrySaveToken = 0;
  let _scheduleRows = [];
  let _turnRows = [];
  let _orderedMembers = [];
  let _openToken = 0;
  let _closePromise = Promise.resolve();
  const DRAFT_SAVE_DELAY = 500;

  function getModalTurnState(allPresentations, orderedMembers) {
    if (typeof getPresentationTurnState === 'function') {
      return getPresentationTurnState(allPresentations, orderedMembers);
    }

    const ordered = (orderedMembers || []).filter(Boolean);
    const orderedIds = ordered.map(m => m.id);
    let category = 'industry';
    const doneInCycle = new Set();

    (allPresentations || [])
      .filter(p =>
        p.member_id &&
        p.presented_at &&
        ['industry', 'stock'].includes(p.category) &&
        p.status === 'done'
      )
      .sort((a, b) =>
        String(a.presented_at || '').localeCompare(String(b.presented_at || '')) ||
        String(a.created_at || '').localeCompare(String(b.created_at || ''))
      )
      .forEach(p => {
        if (!orderedIds.length || !orderedIds.includes(p.member_id)) return;
        if (p.category !== category) {
          if (doneInCycle.size === 0) category = p.category;
          else return;
        }
        doneInCycle.add(p.member_id);
        if (doneInCycle.size >= orderedIds.length) {
          category = category === 'industry' ? 'stock' : 'industry';
          doneInCycle.clear();
        }
      });

    return { category, cycleKey: 'legacy:' + category };
  }

  function setModalContextControlsDisabled(disabled) {
    const category = document.getElementById('pm-category');
    const industry = document.getElementById('pm-industry');
    if (category) category.disabled = disabled;
    if (industry) industry.disabled = disabled;
  }

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
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">발표 순서와 스터디 일정에 맞춰 날짜가 자동 배정됩니다.</div>
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
      <div><span id="pm-save-status" role="status" aria-live="polite" style="display:block;font-size:12px;color:var(--green);">변경 내용은 자동 저장됩니다.</span><span style="font-size:11px;color:var(--muted);">내 차례의 스터디 일정에 자동 연결됩니다.</span></div>
      <button class="btn btn-primary" style="font-size:13px;" onclick="ModalPres.close()">입력 완료</button>
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
    const openToken = ++_openToken;
    await _closePromise;
    if (openToken !== _openToken) return;

    mount();
    _returnFocus = document.activeElement;
    document.getElementById('presModal').style.display = 'flex';
    document.getElementById('pm-memberPanel').innerHTML =
      '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">불러오는 중...</div>';
    const industryInput = document.getElementById('pm-industry');
    const industryHint = document.getElementById('pm-industry-hint');
    if (industryInput) industryInput.value = '';
    if (industryInput) {
      industryInput.onchange = null;
      industryInput.onblur = null;
    }
    if (industryHint) industryHint.style.display = 'none';
    setModalContextControlsDisabled(true);
    _industryConfigKey = null;
    _industrySaveToken += 1;

    const currentMember = await getCurrentMember();
    if (openToken !== _openToken) return;
    _me = currentMember;
    if (!_me) {
      document.getElementById('pm-memberPanel').innerHTML =
        '<div style="font-size:13px;color:var(--muted);padding:1rem;text-align:center;">멤버 정보를 찾을 수 없습니다.</div>';
      return;
    }

    // 내 예정 발표를 모두 불러온 뒤 자동 회차와 정확히 일치하는 draft만 편집한다.
    const today = toDateStr(new Date());
    let myPlanned;
    let allRes;
    let membersRes;
    let savedOrder;
    let turnRes;
    let schedulesRes;
    try {
      [myPlanned, allRes, membersRes, savedOrder, turnRes, schedulesRes] = await Promise.all([
        sb.from('presentations')
          .select('*').eq('status','planned').eq('member_id',_me.id)
          .order('created_at', { ascending: true }),
        sb.from('presentations')
          .select('id,member_id,category,topic,status,schedule_id,presented_at,created_at')
          .eq('status','planned').is('schedule_id',null)
          .order('created_at', { ascending: false }).limit(10),
        sb.from('members').select('*').eq('is_active', true).order('joined_at'),
        getConfigStrict('pres_order'),
        sb.from('presentations')
          .select('id,member_id,category,topic,status,schedule_id,presented_at,created_at'),
        sb.from('schedules')
          .select('id,title,category,event_date,event_time')
          .order('event_date', { ascending: true }),
      ]);
      const dataError = [
        myPlanned.error,
        allRes.error,
        membersRes.error,
        turnRes.error,
        schedulesRes.error,
      ].find(Boolean);
      if (dataError) throw dataError;
    } catch (error) {
      console.error('발표 입력 데이터 로드 오류:', error);
      if (openToken === _openToken) {
        document.getElementById('pm-memberPanel').innerHTML =
          '<div style="font-size:13px;color:var(--up);padding:1rem;text-align:center;">발표 데이터를 불러오지 못했습니다. 닫은 뒤 다시 시도해 주세요.</div>';
      }
      return;
    }
    if (openToken !== _openToken) return;

    const allMembers = membersRes.data || [];
    const orderedMembers = normalizePresentationOrder(allMembers, savedOrder);
    const scheduleRows = schedulesRes.data || [];
    let turnRows = turnRes.data || [];
    try {
      const completion = await syncPastScheduledPresentationsDone(
        sb,
        scheduleRows,
        turnRows,
        { orderedMembers }
      );
      if (completion.patches.length || completion.carryoverPatches.length) {
        const completedIds = new Set(completion.patches.map(patch => String(patch.id)));
        const carryoverIds = new Set(
          completion.carryoverPatches.map(patch => String(patch.id))
        );
        turnRows = turnRows.map(row =>
          completedIds.has(String(row.id))
            ? { ...row, status: 'done' }
            : carryoverIds.has(String(row.id))
              ? { ...row, schedule_id: null }
              : row
        );
      }
    } catch (error) {
      console.error('지난 발표 완료 처리 오류:', error);
      if (openToken === _openToken) {
        document.getElementById('pm-memberPanel').innerHTML =
          '<div style="font-size:13px;color:var(--up);padding:1rem;text-align:center;">지난 발표 상태를 확인하지 못해 입력을 중단했습니다. 닫은 뒤 다시 시도해 주세요.</div>';
      }
      return;
    }
    if (openToken !== _openToken) return;
    _scheduleRows = scheduleRows;
    _turnRows = turnRows;
    _orderedMembers = orderedMembers;
    const modalTurnState = getModalTurnState(turnRows, orderedMembers);
    const draftCycleState = getPresentationDraftCycleState(
      scheduleRows,
      turnRows,
      orderedMembers,
      { fromDate: today }
    );
    try {
      const draftCycle = await ensurePresentationDraftCycle(
        draftCycleState.cycleKey,
        { cycleMarker: draftCycleState.cycleMarker }
      );
      if (openToken !== _openToken) return;
      _draftEpoch = draftCycle.startedAt;
      await recoverInitialPresentationDrafts(
        sb,
        scheduleRows,
        turnRows,
        orderedMembers,
        {
          fromDate: today,
          cycleState: draftCycleState,
        }
      );
      if (openToken !== _openToken) return;
    } catch (error) {
      console.error('발표 초안 사이클 저장 오류:', error);
      if (openToken === _openToken) {
        document.getElementById('pm-memberPanel').innerHTML =
          '<div style="font-size:13px;color:var(--up);padding:1rem;text-align:center;">새 발표 사이클을 확인하지 못해 입력을 중단했습니다. 닫은 뒤 다시 시도해 주세요.</div>';
      }
      return;
    }
    const presentationPlan = buildPresentationSchedulePlan(
      scheduleRows,
      turnRows,
      orderedMembers,
      { fromDate: today }
    );
    _autoAssignment = getNextPresentationInputPlanItem(
      presentationPlan,
      _me.id,
      scheduleRows,
      turnRows
    );
    const completedIds = new Set(
      turnRows.filter(row => row.status === 'done').map(row => String(row.id))
    );
    const plannedRows = (myPlanned.data || [])
      .filter(row => !completedIds.has(String(row.id)))
      .map(row =>
        presentationDraftCarryoverIds.has(String(row.id))
          ? { ...row, schedule_id: null }
          : row
      );
    const currentDraft = findCurrentPresentationDraft(
      plannedRows,
      _me.id,
      {
        scheduleId: _autoAssignment?.schedule.id,
        draftEpoch: _draftEpoch,
        carryoverIds: presentationDraftCarryoverIds,
      }
    );
    _drafts = currentDraft ? [currentDraft] : [];

    // 이번 세션의 카테고리 + 산업명 추론
    // 1순위: 전체 draft에서 가장 최근 category/industry
    // 2순위: 완료된 발표 기준 다음 카테고리 추천
    const allDrafts = (allRes.data || []).filter(row =>
      isCurrentUnassignedPresentationDraft(
        row,
        _draftEpoch,
        presentationDraftCarryoverIds
      )
    );
    let sharedCat      = null;
    let sharedIndustry = '';

    if (allDrafts.length) {
      const latestDraft = allDrafts[0];
      sharedCat = latestDraft.category;
      if (sharedCat === 'industry' && latestDraft.topic?.includes('>')) {
        sharedIndustry = latestDraft.topic.split('>')[0].trim();
      }
    }

    // 카테고리 추천: 산업/종목 한 사이클이 끝날 때만 다음 구분으로 전환
    if (!sharedCat) {
      sharedCat = modalTurnState.category;
    }
    const myDraft = _drafts.find(p => p.member_id === _me.id);
    if (_autoAssignment?.schedule.category && !myDraft) {
      sharedCat = _autoAssignment.schedule.category;
    }

    if (sharedCat) {
      document.getElementById('pm-category').value = sharedCat;
      onCategoryChange();
    }

    _industryConfigKey = getPresentationIndustryConfigKey(
      _autoAssignment?.schedule.id,
      _draftEpoch,
      draftCycleState.cycleKey
    );
    try {
      if (_industryConfigKey) {
        const savedIndustry = await getConfigStrict(_industryConfigKey);
        if (typeof savedIndustry === 'string' && savedIndustry.trim()) {
          sharedIndustry = savedIndustry.trim();
        } else if (_autoAssignment?.schedule.id) {
          const cycleIndustryKey = getPresentationIndustryConfigKey(
            null,
            _draftEpoch,
            draftCycleState.cycleKey
          );
          const savedCycleIndustry = cycleIndustryKey
            ? await getConfigStrict(cycleIndustryKey)
            : null;
          if (typeof savedCycleIndustry === 'string' && savedCycleIndustry.trim()) {
            sharedIndustry = savedCycleIndustry.trim();
          }
        }
      }
    } catch (error) {
      console.error('산업명 불러오기 오류:', error);
      if (openToken === _openToken) {
        document.getElementById('pm-memberPanel').innerHTML =
          '<div style="font-size:13px;color:var(--up);padding:1rem;text-align:center;">저장된 산업명을 확인하지 못해 입력을 중단했습니다. 닫은 뒤 다시 시도해 주세요.</div>';
      }
      return;
    }
    if (openToken !== _openToken) return;

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
      if (openToken !== _openToken) return;
      const industryEl = document.getElementById('pm-industry');
      if (industryEl) {
        industryEl.onchange = () => syncIndustryName(industryEl.value.trim());
        industryEl.onblur = () => syncIndustryName(industryEl.value.trim());
      }
    }, 0);

    if (openToken !== _openToken) return;
    setModalContextControlsDisabled(false);
    renderPanel();
  }

  // ── 닫기
  function close() {
    const modal = document.getElementById('presModal');
    if (!modal || modal.style.display === 'none') return _closePromise;
    _openToken += 1;
    modal.style.display = 'none';
    const returnFocus = _returnFocus;
    _closePromise = Promise.allSettled([
      flushDraftSave(),
      _industrySaveQueue,
    ]).finally(() => {
      if (typeof ModalPres._onClose === 'function') ModalPres._onClose();
      returnFocus?.focus?.();
    });
    return _closePromise;
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
    const isAssigned = draft && !!draft.schedule_id;
    const autoNotice = _autoAssignment
      ? '<div style="padding:8px 12px;background:#e8f2fb;border:0.5px solid #b5d4f4;border-radius:var(--r-md);font-size:12px;color:#185fa5;margin-bottom:10px;">↻ <strong>' +
        escapeHtml(_autoAssignment.schedule.event_date) +
        '</strong> 스터디에 발표 순서가 자동 배정됩니다.</div>'
      : '<div style="padding:8px 12px;background:var(--bg);border:0.5px solid var(--border2);border-radius:var(--r-md);font-size:12px;color:var(--muted);margin-bottom:10px;">다음 스터디 일정이 등록되면 발표 순서에 따라 자동 배정됩니다.</div>';

    // draft 카테고리·산업명 복원
    if (draft?.category) {
      const catEl = document.getElementById('pm-category');
      if (catEl) { catEl.value = draft.category; onCategoryChange(); }
    }
    if (draft?.category === 'industry' && draft?.topic?.includes('>')) {
      const industryEl = document.getElementById('pm-industry');
      if (industryEl && !industryEl.value) {
        industryEl.value = draft.topic.split('>')[0].trim();
      }
    }

    panel.innerHTML =
      // 배정 완료 안내
      (isAssigned ? '<div style="padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:12px;color:var(--green);margin-bottom:10px;">📅 <strong>' + escapeHtml(draft.presented_at||'날짜 미정') + '</strong> 발표 자동 배정 완료 · 종목 변경 시 아래에서 수정</div>' : autoNotice) +
      // 종목 검색 + 직접 입력
      '<div style="position:relative;margin-bottom:10px;">' +
        '<div style="display:flex;gap:4px;">' +
          '<div style="flex:1;position:relative;">' +
            '<input type="text" id="pm-input" aria-label="발표종목 검색" placeholder="종목명·코드 검색 또는 직접 입력" ' +
              'style="width:100%;font-size:14px;padding:8px 12px;" value="' + escapeHtml(stockName) + '" />' +
            '<div id="pm-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:700;' +
              'background:var(--surface);border:0.5px solid var(--border2);border-radius:var(--r-md);' +
              'box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:200px;overflow-y:auto;margin-top:2px;"></div>' +
          '</div>' +
          '<button id="pm-manual-btn" class="btn" style="font-size:12px;white-space:nowrap;flex-shrink:0;" ' +
            'title="검색 안 되는 해외주식 등 직접 입력">직접 입력</button>' +
        '</div>' +
      '</div>' +
      // 선택 배지
      '<div id="pm-badge" style="display:' + (draft?.stock_code ? 'flex' : 'none') + ';align-items:center;gap:8px;' +
        'padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);' +
        'font-size:13px;color:var(--green);margin-bottom:10px;">' +
        (draft?.stock_code ? '✅ <strong>' + escapeHtml(stockName) + '</strong> <span style="color:var(--muted);font-size:12px;">' + escapeHtml(draft.stock_code) + '</span>' : '') +
        '<button onclick="ModalPres.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>' +
      '</div>' +
      // 현재 시총 / 목표 시총
      '<div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">' +
        '<div><label for="pm-cur-cap" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">현재 시총 (억원)</label>' +
          '<input type="number" id="pm-cur-cap" inputmode="numeric" min="1" placeholder="자동 입력됨" value="' + (draft?.market_cap_at||'') + '" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
        '<div><label for="pm-tgt-cap" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">목표 시총 (억원)</label>' +
          '<input type="number" id="pm-tgt-cap" inputmode="numeric" min="1" placeholder="예: 420,000" value="' + (draft?.target_cap||'') + '" style="font-size:13px;padding:7px 10px;width:100%;"></div>' +
      '</div>' +
      '<div id="pm-cap-prev" style="display:none;padding:8px 12px;background:var(--greenbg);border:0.5px solid #9fe1cb;border-radius:var(--r-md);font-size:13px;color:var(--green);margin-bottom:10px;"></div>' +
      // 핵심 발표 아이디어
      '<div style="margin-bottom:10px;"><label for="pm-reason" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">핵심 발표 아이디어</label>' +
        '<textarea id="pm-reason" placeholder="발표에서 전달할 핵심 투자 아이디어" ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:64px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;">' +
          escapeHtml(draft?.reason||'') + '</textarea></div>' +
      // 투자 리스크
      '<div><label for="pm-risk" style="font-size:12px;color:var(--muted);font-weight:500;display:block;margin-bottom:4px;">투자 리스크</label>' +
        '<textarea id="pm-risk" placeholder="주요 리스크 요인" ' +
          'style="font-size:13px;padding:7px 10px;width:100%;min-height:52px;resize:vertical;border:0.5px solid var(--border2);border-radius:var(--r-md);font-family:inherit;">' +
          escapeHtml(draft?.risk||'') + '</textarea></div>';

    const inp     = document.getElementById('pm-input');
    const dd      = document.getElementById('pm-dd');
    const curC    = document.getElementById('pm-cur-cap');
    const tgtC    = document.getElementById('pm-tgt-cap');
    const capPrev = document.getElementById('pm-cap-prev');
    const badge   = document.getElementById('pm-badge');

    inp.dataset.stockCode = draft?.stock_code || '';
    inp.dataset.capAt     = draft?.market_cap_at || '';
    const initialState = readDraftState(inp);
    _lastSavedDraftKey = draft && initialState ? initialState.key : null;

    // 직접 입력 버튼 — 검색 안 되는 종목 (해외주식 등)
    const manualBtn = document.getElementById('pm-manual-btn');
    const doManualSave = async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      inp.dataset.stockCode = '';   // stock_code 없이 저장
      badge.style.display = 'flex';
      badge.innerHTML =
        '✅ <strong>' + name + '</strong>' +
        ' <span style="color:var(--muted);font-size:12px;">직접 입력</span>' +
        '<button onclick="ModalPres.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
      dd.style.display = 'none';
      await saveDraftNow(inp);
      toast('✅ ' + name + ' 저장됨');
    };
    manualBtn.onclick = doManualSave;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (dd.style.display === 'none' || !dd.querySelector('.dd-item')) doManualSave();
      }
    });

    // 자동완성
    bindStockSearch(inp, dd, s => {
      inp.value = s.stock_name;
      inp.dataset.stockCode = s.stock_code;
      inp.dataset.capAt     = s.market_cap || '';
      badge.style.display = 'flex';
      badge.innerHTML =
        '✅ <strong>' + s.stock_name + '</strong> <span style="color:var(--muted);font-size:12px;">' + s.stock_code + ' · ' + (s.market||'') + '</span>' +
        '<button onclick="ModalPres.clearStock()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;margin-left:auto;">✕ 다시 선택</button>';
      if (s.market_cap) curC.value = s.market_cap;
      curC.dispatchEvent(new Event('input'));
      saveDraftNow(inp);
    });

    // 상승여력
    const calcCap = (shouldSave = true) => {
      const c = parseInt(curC.value), t = parseInt(tgtC.value);
      capPrev.style.display = (c>0&&t>0) ? 'block' : 'none';
      if (c>0&&t>0)
        capPrev.innerHTML = '시총 상승여력: ' + c.toLocaleString() + '억 → ' + t.toLocaleString() + '억 <strong>(+' + ((t-c)/c*100).toFixed(1) + '%)</strong>';
      if (shouldSave) scheduleDraftSave(inp);
    };
    const reasonEl = document.getElementById('pm-reason');
    const riskEl = document.getElementById('pm-risk');
    curC.addEventListener('input', () => calcCap());
    tgtC.addEventListener('input', () => calcCap());
    reasonEl.addEventListener('input', () => scheduleDraftSave(inp));
    riskEl.addEventListener('input',   () => scheduleDraftSave(inp));
    [curC, tgtC, reasonEl, riskEl].forEach(el => {
      el.addEventListener('blur', () => saveDraftNow(inp));
    });

    if (draft?.target_cap && draft?.market_cap_at) calcCap(false);
    setTimeout(() => inp.focus(), 0);
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
  function syncIndustryName(industryName) {
    if (!_me || !industryName) return Promise.resolve(false);
    const token = ++_industrySaveToken;
    const myDraft = _drafts.find(p => p.member_id === _me.id);
    const stockName = myDraft?.topic?.includes('>')
      ? myDraft.topic.split('>')[1].trim()
      : (myDraft?.topic || '');
    const request = {
      industryName,
      token,
      configKey: _industryConfigKey,
      draftId: myDraft?.id || null,
      draftCategory: myDraft?.category || null,
      stockName,
    };
    const queued = _industrySaveQueue.then(
      () => persistIndustryName(request),
      () => persistIndustryName(request)
    );
    _industrySaveQueue = queued.catch(() => false);
    return queued;
  }

  async function persistIndustryName(request) {
    const {
      industryName,
      token,
      configKey,
      draftId,
      draftCategory,
      stockName,
    } = request;
    if (configKey) {
      try {
        await setConfig(configKey, industryName);
        if (token === _industrySaveToken) {
          setDraftSaveStatus('산업명 저장됨', false);
        }
      } catch (error) {
        if (token === _industrySaveToken) {
          setDraftSaveStatus('산업명 저장 실패 · 다시 시도해 주세요.', true);
        }
        return false;
      }
    }
    if (!draftId || draftCategory !== 'industry' || !stockName) return true;

    const newTopic = industryName + ' > ' + stockName;
    const { error } = await sb.from('presentations')
      .update({ topic: newTopic })
      .eq('id', draftId);
    if (error) {
      if (token === _industrySaveToken) {
        setDraftSaveStatus('산업명은 저장됐지만 종목 반영에 실패했습니다.', true);
      }
      return false;
    }
    const currentDraft = _drafts.find(draft => String(draft.id) === String(draftId));
    if (currentDraft) currentDraft.topic = newTopic;
    return true;
  }

  function readDraftState(inp) {
    if (!_me) return null;
    const stockName = inp?.value?.trim();
    if (!stockName) return null;

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
    if (_autoAssignment) {
      payload.schedule_id = _autoAssignment.schedule.id;
      payload.presented_at = _autoAssignment.schedule.event_date;
    }
    return { payload, key: JSON.stringify(payload) };
  }

  // ── Draft 자동 저장 (trailing debounce + 직렬 쓰기)
  async function persistDraft(state) {
    const { payload, key } = state;

    const existing = _drafts.find(p => p.member_id === _me.id);
    let savedDraft = existing || null;
    if (existing) {
      // 기존 draft 수정 (배정된 것 포함)
      const { error } = await sb.from('presentations').update(payload).eq('id', existing.id);
      if (error) throw error;
      Object.assign(existing, payload);
    } else {
      const { data, error } = await sb.from('presentations')
        .insert({ member_id: _me.id, ...payload }).select().single();
      if (error) throw error;
      if (data) {
        _drafts.push(data);
        savedDraft = data;
      }
    }
    if (
      savedDraft?.id &&
      !_autoAssignment &&
      !savedDraft.schedule_id &&
      shouldCarryPresentationDraftToNextCycle(
        savedDraft.member_id,
        _scheduleRows,
        _turnRows,
        _orderedMembers,
        { fromDate: toDateStr(new Date()) }
      )
    ) {
      await registerPresentationDraftCarryoverIds([savedDraft.id]);
    }
    _lastSavedDraftKey = key;
    setDraftSaveStatus('자동 저장됨', false);
  }

  function setDraftSaveStatus(message, isError = false) {
    const element = document.getElementById('pm-save-status');
    if (!element) return;
    element.textContent = message;
    element.style.color = isError ? 'var(--up)' : 'var(--green)';
  }

  function enqueueDraftSave(inp) {
    const state = readDraftState(inp);
    const alreadyPersisted = state?.key === _lastSavedDraftKey && !_lastQueuedDraftKey;
    if (!state || alreadyPersisted || state.key === _lastQueuedDraftKey) {
      return _draftSaveQueue;
    }

    _lastQueuedDraftKey = state.key;
    const queuedKey = state.key;
    setDraftSaveStatus('저장 중…');
    _draftSaveQueue = _draftSaveQueue
      .then(() => persistDraft(state))
      .catch(error => {
        console.error('발표 초안 자동 저장 오류:', error);
        toast('발표 초안을 저장하지 못했습니다.');
        setDraftSaveStatus('저장 실패 · 다시 입력하거나 잠시 후 시도하세요.', true);
      })
      .finally(() => {
        if (_lastQueuedDraftKey === queuedKey) _lastQueuedDraftKey = null;
      });
    return _draftSaveQueue;
  }

  function scheduleDraftSave(inp) {
    clearTimeout(_draftSaveTimer);
    _draftSaveInput = inp;
    setDraftSaveStatus('저장 대기 중…');
    _draftSaveTimer = setTimeout(() => {
      _draftSaveTimer = null;
      const pendingInput = _draftSaveInput;
      _draftSaveInput = null;
      enqueueDraftSave(pendingInput);
    }, DRAFT_SAVE_DELAY);
  }

  function saveDraftNow(inp) {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = null;
    _draftSaveInput = null;
    return enqueueDraftSave(inp);
  }

  function flushDraftSave() {
    if (!_draftSaveTimer) return _draftSaveQueue;
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = null;
    const pendingInput = _draftSaveInput;
    _draftSaveInput = null;
    return enqueueDraftSave(pendingInput);
  }

  return { mount, open, close, onCategoryChange, clearStock };
})();

// ── 전역 편의 함수 (기존 호출부 하위호환)
function openPresModal()      { ModalPres.open(); }
function closePresModal()     { ModalPres.close(); }
function onPmCategoryChange() { ModalPres.onCategoryChange(); }
function pmClearStock()       { ModalPres.clearStock(); }
