// ============================================================
// js/db.js  v20260424
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
  return members.map((m, i) => {
    const netProfit  = settlements.filter(s => s.member_id === m.id).reduce((sum, s) => sum + (s.net_profit || 0), 0);
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
