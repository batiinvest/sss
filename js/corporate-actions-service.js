// Versioned server contract: no client-only writes to financial balances.
let corporateBackendPromise = null;
async function corporateBackendAvailable() {
  if (!corporateBackendPromise) corporateBackendPromise = (async () => {
    const { data, error } = await sb.rpc('sss_corporate_actions_version');
    if (error && ['PGRST202', '42883'].includes(error.code)) return false;
    if (error) throw error;
    if (Number(data) !== 1) throw new Error('무상증자 계산 버전이 다릅니다. 새로고침 후 다시 시도하세요.');
    return true;
  })().catch(error => { corporateBackendPromise = null; throw error; });
  return corporateBackendPromise;
}

async function corporateRpc(name, args = {}) {
  if (!await corporateBackendAvailable()) {
    throw new Error('운영 DB 연결 설정이 필요합니다. 아직 보유 수량에는 적용되지 않았습니다.');
  }
  const { data, error } = await sb.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message || '무상증자 정보를 처리하지 못했습니다.'), { code: error.code });
  return data;
}

async function attachCorporatePositions(picks) {
  if (picks?.some(pick => !pick.pick_id && !pick.id)) return picks;
  if (!picks?.length || !await corporateBackendAvailable()) return picks;
  const [result, actions] = await Promise.all([corporateRpc('sss_corporate_positions', {
    p_pick_ids: [...new Set(picks.map(p => String(p.pick_id || p.id)))],
    p_as_of: new Date().toISOString(),
  }), corporateRpc('sss_corporate_actions_list')]);
  const positions = new Map((result || []).map(row => [String(row.pick_id), row]));
  const unique = new Map(picks.map(pick => [String(pick.pick_id || pick.id), pick]));
  return [...unique.values()].map(pick => {
    const stockActions = (actions || []).filter(action => action.stock_code === pick.stock_code && action.status === 'applied');
    const basisDate = pick.submitted_at || (pick.carried_from || pick.month || '') + '-01';
    const originalPrice = pick._originalPriceAt ?? pick.price_at;
    const originalTarget = pick._originalTargetPrice ?? pick.target_price;
    const adjustedPrice = adjustedIdeaPrice(originalPrice, basisDate, stockActions);
    const adjustedTarget = adjustedIdeaPrice(originalTarget, basisDate, stockActions);
    const decorated = { ...pick, price_at: adjustedPrice ?? originalPrice, target_price: adjustedTarget ?? originalTarget,
      _originalPriceAt: originalPrice, _originalTargetPrice: originalTarget,
      _priceAdjusted: adjustedPrice !== null && adjustedPrice !== Number(originalPrice) };
    const position = positions.get(String(pick.pick_id || pick.id));
    if (!position || !(Number(position.quantity) > 0 || position.sales?.length || position.history?.length)) return decorated;
    const soldQuantity = (position.sales || []).reduce((sum, sale) => sum + Number(sale.quantity), 0);
    const soldCost = (position.sales || []).reduce((sum, sale) => sum + Number(sale.quantity) * Number(sale.averagePrice), 0);
    const soldValue = (position.sales || []).reduce((sum, sale) => sum + Number(sale.quantity) * Number(sale.price), 0);
    return {
      ...decorated, _corporatePosition: position,
      buy_price: Number(position.quantity) > 0 ? Number(position.averagePrice) : soldQuantity ? soldCost / soldQuantity : null,
      buy_quantity: Number(position.quantity),
      sell_price: soldQuantity ? soldValue / soldQuantity : pick.sell_price,
      realized_return: soldCost > 0 ? (soldValue - soldCost) / soldCost * 100 : pick.realized_return,
      status: Number(position.quantity) > 0 ? 'hold' : 'sold',
    };
  });
}

function corporatePositionLabel(pick) {
  const position = pick?._corporatePosition;
  if (!position?.history?.length) return '';
  const last = position.history[position.history.length - 1];
  return `무상증자 ${last.existing_shares}:${last.new_shares} 반영` +
    (Number(position.pendingQuantity) > 0 ? ` · 신주 ${Number(position.pendingQuantity).toLocaleString('ko-KR')}주 미입고` : '');
}

function corporateHistoryMarkup(pick) {
  const position = pick?._corporatePosition;
  if (!position?.history?.length) return '';
  return '<section class="detail-section"><h3>무상증자 반영 내역</h3>' +
    position.history.map(item => '<p>' + escapeHtml(item.ex_date) + ' · 기존 ' +
      escapeHtml(String(item.existing_shares)) + '주당 신주 ' + escapeHtml(String(item.new_shares)) + '주<br>' +
      Number(item.beforeQuantity).toLocaleString('ko-KR') + '주 → ' +
      (Number(item.beforeQuantity) + Number(item.addedQuantity)).toLocaleString('ko-KR') + '주 · 총원가 ' +
      won(Number(item.cost)) + ' 유지</p>').join('') +
    '<p>현재 매도 가능 ' + Number(position.tradableQuantity).toLocaleString('ko-KR') + '주 · 미입고 ' +
    Number(position.pendingQuantity).toLocaleString('ko-KR') + '주</p></section>';
}

async function corporateTradeStorageKey() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  const actor = data?.session?.user?.id;
  if (!actor) throw new Error('로그인 후 거래를 저장하세요.');
  return 'sss-pending-trade-v1:' + (typeof SUPABASE_URL === 'string' ? SUPABASE_URL : 'default') + ':' + actor;
}

function readPendingCorporateTrade(storageKey) {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  const request = JSON.parse(raw);
  if (!request?.id || !request?.payload || !request?.key) {
    throw new Error('미확인 거래 정보를 읽지 못했습니다. 관리자에게 확인을 요청하세요.');
  }
  return request;
}

async function getPendingCorporateTrade() {
  return readPendingCorporateTrade(await corporateTradeStorageKey());
}

function corporateTradeKey(payload) {
  const day = new Date(payload.traded_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(key =>
    [key, key === 'traded_at' ? day : payload[key]])));
}

async function submitCorporateTrade(payload) {
  const storageKey = await corporateTradeStorageKey();
  const key = corporateTradeKey(payload);
  let request = readPendingCorporateTrade(storageKey);
  if (request && request.key !== key) {
    throw new Error('처리 결과가 확인되지 않은 거래가 있습니다. 먼저 미확인 거래의 결과를 확인하세요.');
  }
  if (!request) {
    request = { id: crypto.randomUUID(), key, payload: { ...payload } };
    // Persist before sending: a reload must never turn an uncertain write into a new one.
    // If browser storage is unavailable, fail before making any financial write.
    localStorage.setItem(storageKey, JSON.stringify(request));
  }
  let data;
  try {
    data = await corporateRpc('sss_submit_trade', {
      p_trade: request.payload, p_request_id: request.id,
    });
  } catch (error) {
    // These database errors explicitly mean the transaction did not commit.
    if (/^(22|23|42501|P0001|PGRST202|42883)/.test(error.code || '')) {
      localStorage.removeItem(storageKey);
    }
    throw error;
  }
  localStorage.removeItem(storageKey);
  return data;
}
