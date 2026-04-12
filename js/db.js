// ============================================================
// js/db.js v5
// 현재가: Supabase DB의 stock_prices 테이블에서 읽기
// Edge Function 불필요 — 네이버 금융에서 확인 후 홈페이지에서 직접 입력
// ============================================================

async function fetchMembers() {
  const { data, error } = await sb.from('members').select('*').eq('is_active', true).order('joined_at');
  if (error) { console.error(error); return []; }
  return data;
}

async function fetchPicksByMonth(month) {
  const { data, error } = await sb.from('picks_with_trades').select('*').eq('month', month).order('submitted_at');
  if (error) { console.error(error); return []; }
  return data;
}

async function fetchAllPicks(filters = {}) {
  let q = sb.from('picks_with_trades').select('*');
  if (filters.member_id) q = q.eq('member_id', filters.member_id);
  if (filters.status)    q = q.eq('status', filters.status);
  const { data, error } = await q.order('month', { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}

async function fetchTrades(limit = 30) {
  const { data, error } = await sb.from('trades')
    .select('*, members(name), picks(stock_name, month)')
    .order('traded_at', { ascending: false }).limit(limit);
  if (error) { console.error(error); return []; }
  return data;
}

async function fetchSettlements() {
  const { data, error } = await sb.from('settlements')
    .select('*, members(name), picks(stock_name, month)')
    .order('settled_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}

async function submitPick(payload) {
  const { data, error } = await sb.from('picks').insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function submitTrade(payload) {
  const { data, error } = await sb.from('trades').insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function submitSettlement(payload) {
  const { data, error } = await sb.from('settlements').insert(payload).select().single();
  if (error) throw error;
  return data;
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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

async function fetchMemberStats() {
  const [members, settlements] = await Promise.all([fetchMembers(), fetchSettlements()]);
  return members.map((m, i) => {
    const myS        = settlements.filter(s => s.member_id === m.id);
    const netProfit  = myS.reduce((sum, s) => sum + (s.net_profit || 0), 0);
    // 누적 수익률: 결산 기록 기준 (결산이 없으면 0%)
    // settlements의 return_rate 합산보다 base_amount 변화로 계산
    // 초기 기준금액은 BASE_AMOUNT(config.js)에서 읽음
    const initBase   = typeof BASE_AMOUNT !== 'undefined' ? BASE_AMOUNT : 500000;
    const returnRate = parseFloat(((m.base_amount - initBase) / initBase * 100).toFixed(1));
    return { ...m, net_profit: netProfit, return_rate: returnRate, av_cls: avCls[i % 6] };
  });
}

// ============================================================
// 현재가 조회 — DB stock_prices 테이블에서 읽기
// ============================================================
async function fetchCurrentPrices(codes) {
  if (!codes || codes.length === 0) return {};
  const { data, error } = await sb
    .from('stock_prices')
    .select('stock_code, price, change_rate, market_cap, updated_at')
    .in('stock_code', codes);
  if (error) { console.error('fetchCurrentPrices 오류:', error); return {}; }
  const result = {};
  for (const row of (data || [])) {
    if (row.price && row.price > 0) {
      result[row.stock_code] = {
        price:     row.price,
        change:    row.change_rate || 0,
        marketCap: row.market_cap || null,
        updatedAt: row.updated_at,
      };
    }
  }
  return result;
}

// 현재가 저장 (주식 현황 페이지에서 호출)
async function upsertStockPrice(payload) {
  const { data, error } = await sb
    .from('stock_prices')
    .upsert({ ...payload, updated_at: new Date().toISOString() }, { onConflict: 'stock_code' })
    .select().single();
  if (error) throw error;
  return data;
}

// stock_prices 전체 목록
async function fetchStockPrices() {
  const { data, error } = await sb
    .from('stock_prices')
    .select('*')
    .order('stock_name');
  if (error) { console.error(error); return []; }
  return data || [];
}

// ============================================================
// 일정 관리
// ============================================================
async function fetchSchedules() {
  const { data, error } = await sb
    .from('schedules').select('*').order('event_date', { ascending: true });
  if (error) { console.error('fetchSchedules 오류:', error.message); return []; }
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

// ============================================================
// 앱 설정 (app_settings 테이블)
// ============================================================
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

// ============================================================
// 펀드 현황 조회 — 투자금 / 잔액 계산
// ============================================================
async function fetchFundStatus() {
  // 모든 매수 거래 조회 (picks 포함해서 status 확인용)
  const { data: trades, error } = await sb.from('trades')
    .select('*, picks(status:id, stock_name)')
    .eq('trade_type', 'buy');
  if (error) { console.error(error); return []; }

  // picks_with_trades 뷰에서 보유 중인 종목의 매수금액 조회
  const { data: picks } = await sb.from('picks_with_trades')
    .select('member_id, buy_price, buy_quantity, status');

  return picks || [];
}

async function fetchAllTrades() {
  const { data, error } = await sb.from('trades')
    .select('*, members(name)')
    .order('traded_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}
