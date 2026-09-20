// Pure event replay shared by previews and portfolio validation.
// Persisted balances and permission checks are owned by the database.
function corporateActionDateTime(date) {
  const time = Date.parse(String(date || '') + 'T00:00:00+09:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isFinite(time) ||
      new Date(time + 9 * 3600000).toISOString().slice(0, 10) !== date) {
    throw new Error('유효한 날짜를 입력하세요.');
  }
  return time;
}

function validateBonusAction(action) {
  if (!/^\d{6}$/.test(String(action.stock_code || ''))) throw new Error('종목코드 6자리를 입력하세요.');
  const existing = Number(action.existing_shares);
  const added = Number(action.new_shares);
  if (!Number.isSafeInteger(existing) || existing <= 0 || !Number.isSafeInteger(added) || added <= 0) {
    throw new Error('기존 주식과 신주 비율은 양의 정수로 입력하세요.');
  }
  const ex = corporateActionDateTime(action.ex_date);
  if (corporateActionDateTime(action.record_date) < ex) throw new Error('배정기준일은 권리락일 이후여야 합니다.');
  if (action.credit_date && corporateActionDateTime(action.credit_date) < ex) {
    throw new Error('실제 입고일은 권리락일 이후여야 합니다.');
  }
  if (action.expected_credit_date && corporateActionDateTime(action.expected_credit_date) < ex) {
    throw new Error('입고 예정일은 권리락일 이후여야 합니다.');
  }
  return { ...action, existing_shares: existing, new_shares: added };
}

function replayCorporatePosition(trades = [], actions = [], options = {}) {
  const asOf = options.asOf === undefined ? Date.now() : new Date(options.asOf).getTime();
  if (!Number.isFinite(asOf)) throw new Error('조회 기준 시각을 확인하세요.');
  const events = [];
  const seen = new Set();
  for (const original of actions) {
    if (original.status && original.status !== 'applied') continue;
    const action = validateBonusAction(original);
    const key = action.id || `${action.stock_code}:${action.ex_date}`;
    if (seen.has(key)) throw new Error('동일한 무상증자가 중복되었습니다.');
    seen.add(key);
    events.push({ time: corporateActionDateTime(action.ex_date), rank: 0, type: 'bonus', action, key });
    if (action.credit_date) events.push({ time: corporateActionDateTime(action.credit_date), rank: 1, type: 'credit', action, key });
  }
  for (const trade of trades) {
    const time = Date.parse(trade.traded_at || trade.created_at || '');
    if (!Number.isFinite(time)) throw new Error('거래일이 없는 기록은 자동 보정할 수 없습니다.');
    if (!['buy', 'sell'].includes(trade.trade_type)) throw new Error('지원하지 않는 거래 유형입니다.');
    if (!(Number(trade.price) > 0) || !Number.isSafeInteger(Number(trade.quantity)) || Number(trade.quantity) <= 0) {
      throw new Error('거래 가격과 수량을 확인하세요.');
    }
    events.push({ time, rank: 2, type: trade.trade_type, trade });
  }
  events.sort((a, b) => a.time - b.time || a.rank - b.rank ||
    String(a.trade?.created_at || '').localeCompare(String(b.trade?.created_at || '')) ||
    String(a.trade?.id || a.key || '').localeCompare(String(b.trade?.id || b.key || '')));
  let tradableQuantity = 0;
  let pendingQuantity = 0;
  let cost = 0;
  let realizedPnl = 0;
  const entitlements = new Map();
  const history = [];
  for (const event of events) {
    if (event.time > asOf) continue;
    const beforeQuantity = tradableQuantity + pendingQuantity;
    const beforeAverage = beforeQuantity ? cost / beforeQuantity : 0;
    if (event.type === 'buy') {
      tradableQuantity += Number(event.trade.quantity);
      cost += Number(event.trade.price) * Number(event.trade.quantity);
    } else if (event.type === 'sell') {
      const quantity = Number(event.trade.quantity);
      if (quantity > tradableQuantity) throw new Error('거래일 기준 매도 가능 수량을 초과합니다.');
      tradableQuantity -= quantity;
      cost -= beforeAverage * quantity;
      realizedPnl += (Number(event.trade.price) - beforeAverage) * quantity;
      if (tradableQuantity + pendingQuantity === 0) cost = 0;
    } else if (event.type === 'bonus') {
      // Overlapping uncredited rights require account-level entitlement review.
      if (pendingQuantity > 0) throw new Error('이전 미입고 신주를 먼저 확인하세요.');
      const quantity = tradableQuantity * event.action.new_shares / event.action.existing_shares;
      if (!Number.isSafeInteger(quantity)) throw new Error('단수주가 발생합니다. 증권사 배정 내역을 확인하세요.');
      pendingQuantity += quantity;
      entitlements.set(event.key, quantity);
      if (quantity > 0) history.push({
        action_id: event.key, ex_date: event.action.ex_date, credit_date: event.action.credit_date || null,
        existing_shares: event.action.existing_shares, new_shares: event.action.new_shares,
        beforeQuantity, addedQuantity: quantity, beforeAverage,
        afterAverage: cost / (tradableQuantity + pendingQuantity), cost,
      });
    } else if (event.type === 'credit') {
      const quantity = entitlements.get(event.key) || 0;
      pendingQuantity -= quantity;
      tradableQuantity += quantity;
    }
  }
  const quantity = tradableQuantity + pendingQuantity;
  return { quantity, tradableQuantity, pendingQuantity, cost,
    averagePrice: quantity ? cost / quantity : 0, realizedPnl, history };
}

function adjustedIdeaPrice(price, basisDate, actions = [], asOf = new Date()) {
  if (!(Number(price) > 0) || !basisDate) return null;
  const basis = Date.parse(basisDate.length === 10 ? basisDate + 'T00:00:00+09:00' : basisDate);
  const end = new Date(asOf).getTime();
  if (!Number.isFinite(basis) || !Number.isFinite(end)) return null;
  return actions.filter(action => !action.status || action.status === 'applied').reduce((value, action) => {
    const valid = validateBonusAction(action);
    const ex = corporateActionDateTime(valid.ex_date);
    return basis < ex && ex <= end ? value * valid.existing_shares / (valid.existing_shares + valid.new_shares) : value;
  }, Number(price));
}
