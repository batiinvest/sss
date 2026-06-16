// ============================================================
// js/db.js  v20260427
// 현재가: stock_prices 테이블에서 읽기 (Edge Function 불필요)
// ============================================================

// ── 멤버
async function fetchMembers() {
  const { data, error } = await sb.from('members')
    .select('*').eq('is_active', true).order('joined_at');
  if (error) { console.error('fetchMembers:', error); return []; }
  return data;
}

async function fetchMemberStats() {
  const [members, settlements] = await Promise.all([fetchMembers(), fetchSettlements()]);
  const profitByMember = new Map();
  for (const s of settlements) {
    profitByMember.set(s.member_id, (profitByMember.get(s.member_id) || 0) + (s.net_profit || 0));
  }
  return members.map((m, i) => {
    const netProfit  = profitByMember.get(m.id) || 0;
    const returnRate = parseFloat(((m.base_amount - BASE_AMOUNT) / BASE_AMOUNT * 100).toFixed(1));
    return { ...m, net_profit: netProfit, return_rate: returnRate, av_cls: avCls[i % 6] };
  });
}

async function upsertMember(payload) {
  if (payload.id) {
    const { id, ...rest } = payload;
    const { data, error } = await sb.from('members').update(rest).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('members').insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function deactivateMember(id) {
  const { error } = await sb.from('members').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

// ── 탑픽
async function fetchPicksByMonth(month) {
  await ensurePickCarryForward(month);
  const { data, error } = await sb.from('picks_with_trades').select('*').eq('month', month).order('submitted_at');
  if (error) { console.error('fetchPicksByMonth:', error); return []; }
  return data;
}

async function fetchAllPicks(filters = {}) {
  let q = sb.from('picks_with_trades').select('*');
  if (filters.member_id) q = q.eq('member_id', filters.member_id);
  if (filters.status)    q = q.eq('status', filters.status);
  const { data, error } = await q.order('month', { ascending: false });
  if (error) { console.error('fetchAllPicks:', error); return []; }
  return data;
}

async function submitPick(payload) {
  const { data, error } = await sb.from('picks').insert(payload).select().single();
  if (error) throw error;
  return data;
}

function prevMonthOf(month) {
  const [year, mon] = String(month || currentMonth()).split('-').map(Number);
  if (!year || !mon) return null;
  return mon === 1
    ? `${year - 1}-12`
    : `${year}-${String(mon - 1).padStart(2, '0')}`;
}

async function fetchRawPriceMap(codes) {
  const uniqueCodes = [...new Set((codes || []).filter(Boolean))];
  if (!uniqueCodes.length) return {};
  if (typeof fetchPriceMapByCodes === 'function') return fetchPriceMapByCodes(uniqueCodes);

  const { data, error } = await sb.from('stock_prices')
    .select('stock_code, price, change_rate, market_cap')
    .in('stock_code', uniqueCodes);
  if (error) {
    console.error('fetchRawPriceMap:', error);
    return {};
  }
  return Object.fromEntries((data || []).filter(r => Number(r.price) > 0).map(r => [r.stock_code, r]));
}

async function fetchLatestPriorPicks(month, fields = '*') {
  const { data, error } = await sb.from('picks_with_trades')
    .select(fields)
    .lt('month', month)
    .order('month', { ascending: false });
  if (error) {
    console.error('fetchLatestPriorPicks:', error);
    return [];
  }

  const latestByMember = new Map();
  for (const pick of data || []) {
    if (pick.member_id && !latestByMember.has(pick.member_id)) {
      latestByMember.set(pick.member_id, pick);
    }
  }
  return [...latestByMember.values()];
}

async function fetchCarryForwardSourcePicks(month, fields = '*') {
  const latestPicks = await fetchLatestPriorPicks(month, fields);
  return latestPicks.filter(p => p.status === 'hold');
}

function buildCarryForwardPicks(month, currentPicks = [], priorPicks = [], opts = {}) {
  const activeMemberIds = opts.activeMemberIds || null;
  const currentMemberIds = new Set((currentPicks || []).map(p => p.member_id));
  const latestPriorByMember = new Map();

  [...(priorPicks || [])]
    .filter(p => p.month && p.month < month)
    .sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .forEach(p => {
      if (p.member_id && !latestPriorByMember.has(p.member_id)) {
        latestPriorByMember.set(p.member_id, p);
      }
    });

  const fallbackPicks = [...latestPriorByMember.values()]
    .filter(p =>
      p.status === 'hold' &&
      p.member_id &&
      !currentMemberIds.has(p.member_id) &&
      (!activeMemberIds || activeMemberIds.has(p.member_id))
    )
    .map(p => ({
      ...p,
      month,
      carried_from: p.carried_from || p.month,
      price_at: p.price_at || p.buy_price || p.buy_price_ref || null,
      _isCarryFallback: true,
    }));

  return [...(currentPicks || []), ...fallbackPicks];
}

async function fetchPicksByMonthWithCarryFallback(month, opts = {}) {
  const fields = opts.fields || '*';
  const activeOnly = opts.activeOnly !== false;
  const [currentPicks, priorHoldPicks, activeMembers] = await Promise.all([
    opts.currentPicks ? Promise.resolve(opts.currentPicks) : fetchPicksByMonth(month),
    fetchCarryForwardSourcePicks(month, fields),
    activeOnly && !opts.activeMemberIds ? fetchMembers() : Promise.resolve([]),
  ]);
  const activeMemberIds = activeOnly
    ? (opts.activeMemberIds || new Set((activeMembers || []).map(m => m.id)))
    : null;
  return buildCarryForwardPicks(month, currentPicks, priorHoldPicks, { activeMemberIds });
}

async function ensurePickCarryForward(month = currentMonth()) {
  const { data: currentPicks, error: curErr } = await sb.from('picks')
    .select('member_id')
    .eq('month', month);
  if (curErr) {
    console.error('ensurePickCarryForward current:', curErr);
    return 0;
  }

  const submittedMemberIds = new Set((currentPicks || []).map(p => p.member_id));
  const activeMemberIds = new Set((await fetchMembers()).map(m => m.id));
  const priorHoldPicks = await fetchCarryForwardSourcePicks(
    month,
    'member_id, stock_name, stock_code, market, target_price, current_cap, target_cap, reason, price_at, buy_price, buy_price_ref, month, carried_from, status'
  );
  const targets = priorHoldPicks.filter(p =>
    p.member_id &&
    activeMemberIds.has(p.member_id) &&
    p.stock_name &&
    !submittedMemberIds.has(p.member_id)
  );
  if (!targets.length) return 0;

  const priceMap = await fetchRawPriceMap(targets.map(p => p.stock_code));
  const payloads = targets.map(p => {
    const cur = p.stock_code ? priceMap[p.stock_code] : null;
    return {
      member_id: p.member_id,
      month,
      stock_name: p.stock_name,
      stock_code: p.stock_code,
      market: p.market || 'KOSPI',
      target_price: p.target_price || null,
      current_cap: cur?.market_cap || p.current_cap || null,
      target_cap: p.target_cap || null,
      reason: p.reason || null,
      price_at: cur?.price || p.price_at || p.buy_price || p.buy_price_ref || null,
      carried_from: p.carried_from || p.month,
    };
  });

  const { error } = await sb.from('picks').insert(payloads);
  if (error) {
    console.error('ensurePickCarryForward insert:', error);
    return 0;
  }
  return payloads.length;
}

// ── 거래
async function fetchTrades(limit = 30) {
  const { data, error } = await sb.from('trades')
    .select('*, members(name), picks(stock_name, month)')
    .order('traded_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('fetchTrades:', error); return []; }
  return data;
}

async function fetchAllTrades() {
  const { data, error } = await sb.from('trades')
    .select('*, members(name)')
    .order('traded_at', { ascending: false });
  if (error) { console.error('fetchAllTrades:', error); return []; }
  return data;
}

async function submitTrade(payload) {
  const { data, error } = await sb.from('trades').insert(payload).select().single();
  if (error) throw error;
  return data;
}

// ── 결산
async function fetchSettlements() {
  const { data, error } = await sb.from('settlements')
    .select('*, members(name), picks(stock_name, month)')
    .order('settled_at', { ascending: false });
  if (error) { console.error('fetchSettlements:', error); return []; }
  return data;
}

async function submitSettlement(payload) {
  const { data, error } = await sb.from('settlements').insert(payload).select().single();
  if (error) throw error;
  return data;
}

// ── 현재가
async function fetchCurrentPrices(codes) {
  if (!codes?.length) return {};
  if (typeof fetchPriceMapByCodes === 'function') {
    return fetchPriceMapByCodes(codes);
  }
  const { data, error } = await sb.from('stock_prices')
    .select('stock_code, price, change_rate, market_cap, updated_at')
    .in('stock_code', codes);
  if (error) { console.error('fetchCurrentPrices:', error); return {}; }
  return Object.fromEntries(
    (data || [])
      .filter(row => row.price > 0)
      .map(row => [row.stock_code, {
        price:     row.price,
        change:    row.change_rate || 0,
        marketCap: row.market_cap || null,
        updatedAt: row.updated_at,
      }])
  );
}

async function upsertStockPrice(payload) {
  const { data, error } = await sb.from('stock_prices')
    .upsert({ ...payload, updated_at: new Date().toISOString() }, { onConflict: 'stock_code' })
    .select().single();
  if (error) throw error;
  return data;
}

async function fetchStockPrices() {
  const { data, error } = await sb.from('stock_prices').select('*').order('stock_name');
  if (error) { console.error('fetchStockPrices:', error); return []; }
  return data || [];
}

// ── 일정
async function fetchSchedules() {
  const { data, error } = await sb.from('schedules').select('*').order('event_date', { ascending: true });
  if (error) { console.error('fetchSchedules:', error.message); return []; }
  return data ?? [];
}

async function submitSchedule(payload) {
  const { data, error } = await sb.from('schedules').insert(payload).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateSchedule(id, payload) {
  const { data, error } = await sb.from('schedules').update(payload).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteSchedule(id) {
  const { error } = await sb.from('schedules').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── 앱 설정
async function getAppSetting(key) {
  const { data, error } = await sb.from('app_settings').select('value').eq('key', key).single();
  if (error) return null;
  return data?.value || null;
}

async function setAppSetting(key, value) {
  const { error } = await sb.from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

// ── 펀드 현황 (보유 종목 매수금액)
async function fetchFundStatus() {
  const { data: picks } = await sb.from('picks_with_trades')
    .select('member_id, buy_price, buy_quantity, status');
  return picks || [];
}

// ── 내 탑픽 (로그인 멤버 기준)
async function fetchMyPicks(memberId, filters = {}) {
  let q = sb.from('picks_with_trades').select('*').eq('member_id', memberId);
  if (filters.status) q = q.eq('status', filters.status);
  const { data, error } = await q.order('month', { ascending: false });
  if (error) { console.error('fetchMyPicks:', error); return []; }
  return data || [];
}

// ── 내 발표 히스토리 (로그인 멤버 기준)
async function fetchMyPresentations(memberId, limit = 20) {
  const { data, error } = await sb.from('presentations')
    .select('*')
    .eq('member_id', memberId)
    .order('presented_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('fetchMyPresentations:', error); return []; }
  return data || [];
}

// ── 내 결산 내역
async function fetchMySettlements(memberId) {
  const { data, error } = await sb.from('settlements')
    .select('*, picks(stock_name)')
    .eq('member_id', memberId)
    .order('settled_at', { ascending: false });
  if (error) { console.error('fetchMySettlements:', error); return []; }
  return data || [];
}

// ── 스터디 회비
async function fetchFees(filters = {}) {
  let q = sb.from('study_fees').select('*, members(name)').order('paid_at', { ascending: false });
  if (filters.month) q = q.eq('month', filters.month);
  if (filters.member_id) q = q.eq('member_id', filters.member_id);
  const { data, error } = await q;
  if (error) {
    if (error.code === '42P01') return [];   // 테이블 미생성 무시
    console.error('fetchFees:', error);
    return [];
  }
  return data || [];
}

// ── 스터디 지출
async function fetchExpenses(filters = {}) {
  let q = sb.from('study_expenses').select('*').order('spent_at', { ascending: false });
  if (filters.category) q = q.eq('category', filters.category);
  const { data, error } = await q;
  if (error) {
    if (error.code === '42P01') return [];
    console.error('fetchExpenses:', error);
    return [];
  }
  return data || [];
}

// ── 연말 결산 내역
async function fetchAnnualSettlements() {
  const { data, error } = await sb.from('annual_settlements')
    .select('*, members(name)')
    .order('year', { ascending: false });
  if (error) {
    if (error.code === '42P01') return [];
    console.error('fetchAnnualSettlements:', error);
    return [];
  }
  return data || [];
}

// ── 발표 히스토리 (전체 / 필터)
async function fetchPresentations(filters = {}) {
  let q = sb.from('presentations').select('*, members(name)');
  if (filters.member_id) q = q.eq('member_id', filters.member_id);
  if (filters.status)    q = q.eq('status', filters.status);
  if (filters.category)  q = q.eq('category', filters.category);
  const { data, error } = await q
    .order('presented_at', { ascending: false })
    .order('created_at',   { ascending: true });
  if (error) { console.error('fetchPresentations:', error); return []; }
  return data || [];
}

// ════════════════════════════════════════
// 종목 자동완성 — DB 검색 (공통)
// ════════════════════════════════════════

/**
 * 종목명 또는 코드로 stock_prices 검색
 * @param {string} q - 검색어 (2자 이상)
 * @param {number} limit - 최대 결과 수 (기본 12)
 * @returns {Promise<Array>} 종목 배열 { stock_code, stock_name, market, price, change_rate, market_cap }
 */
async function searchStockPrices(q, limit = 12) {
  if (!q || q.trim().length < 2) return [];
  const { data, error } = await sb.from('stock_prices')
    .select('stock_code, stock_name, market, price, change_rate, market_cap')
    .or(`stock_name.ilike.%${q.trim()}%,stock_code.ilike.%${q.trim()}%`)
    .gt('price', 0)
    .order('market_cap', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) { console.error('searchStockPrices:', error); return []; }
  return data || [];
}

/**
 * 종목 자동완성 드롭다운 공통 헬퍼
 * @param {HTMLInputElement} input   - 검색 입력 필드
 * @param {HTMLElement}      ddEl    - 드롭다운 컨테이너 div
 * @param {Function}         onSelect - 항목 선택 시 콜백 (stock 객체 전달)
 * @param {Object}           options  - { delay: 250, limit: 12, showCap: true }
 */
function bindStockSearch(input, ddEl, onSelect, options = {}) {
  const { delay = 250, limit = 12, showCap = true } = options;
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { ddEl.style.display = 'none'; return; }

    timer = setTimeout(async () => {
      const stocks = await searchStockPrices(q, limit);
      ddEl.innerHTML = '';

      if (!stocks.length) {
        ddEl.innerHTML = '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">검색 결과 없음</div>';
        ddEl.style.display = 'block';
        return;
      }

      stocks.forEach(s => {
        const item = document.createElement('div');
        item.className = 'dd-item';
        const sign = (s.change_rate || 0) >= 0 ? '+' : '';
        const cl   = (s.change_rate || 0) >= 0 ? '#0f6e56' : '#a32d2d';
        const cap  = showCap && s.market_cap ? s.market_cap.toLocaleString() + '억' : '';

        item.innerHTML =
          `<div>
            <span style="font-weight:500;">${s.stock_name}</span>
            <span style="color:var(--muted);font-size:11px;margin-left:6px;">${s.stock_code} · ${s.market}</span>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:500;">${s.price ? s.price.toLocaleString() + '원' : '—'}</div>
            <div style="font-size:11px;color:${cl};">${sign}${(s.change_rate || 0).toFixed(2)}%
              ${cap ? `<span style="color:var(--muted);margin-left:4px;">${cap}</span>` : ''}
            </div>
          </div>`;

        item.addEventListener('click', () => {
          ddEl.style.display = 'none';
          onSelect(s);
        });
        ddEl.appendChild(item);
      });

      ddEl.style.display = 'block';
    }, delay);
  });

  // 외부 클릭 시 닫기
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !ddEl.contains(e.target)) {
      ddEl.style.display = 'none';
    }
  }, { passive: true });
}

// ── app_config: 키-값 설정 저장소
async function getConfig(key) {
  const { data, error } = await sb.from('app_config').select('value').eq('key', key).maybeSingle();
  if (error) { console.error('getConfig 오류:', error.message); return null; }
  return data?.value ?? null;
}
async function setConfig(key, value) {
  const { error } = await sb.from('app_config').upsert({ key, value }, { onConflict: 'key' });
  if (error) { console.error('setConfig 오류:', error.message); toast('설정 저장 오류: ' + error.message); }
}
