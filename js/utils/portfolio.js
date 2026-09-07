// ============================================================
// js/utils/portfolio.js
// 현재 포트폴리오 평가 — DOM/DB 의존 없는 순수 함수
// ============================================================

function portfolioNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function portfolioCurrentPrice(priceMap, stockCode) {
  if (!stockCode) return null;
  const entry = (priceMap || {})[stockCode];
  const value = typeof entry === 'number' ? entry : entry?.price;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function portfolioPickId(row) {
  const value = row?.pick_id ?? row?.id;
  return value === null || value === undefined ? null : String(value);
}

function portfolioBelongsToMember(row, memberId) {
  if (memberId === null) return true;
  return row?.member_id !== null &&
    row?.member_id !== undefined &&
    String(row.member_id) === memberId;
}

function portfolioTradeTime(trade) {
  const value = trade?.traded_at || trade?.created_at || '';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function portfolioTradeCreatedTime(trade) {
  const time = new Date(trade?.created_at || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function portfolioCompareTrades(a, b) {
  return portfolioTradeTime(a) - portfolioTradeTime(b) ||
    portfolioTradeCreatedTime(a) - portfolioTradeCreatedTime(b) ||
    String(a?.id || '').localeCompare(String(b?.id || ''));
}

function portfolioRate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator * 100) * 1e10) / 1e10;
}

function buildMemberPortfolioValuation(
  member = {},
  holdings = [],
  allTrades = [],
  priceMap = {},
  initialAmount = 500000
) {
  const memberId = member?.id === null || member?.id === undefined
    ? null
    : String(member.id);
  const scopedHoldings = (holdings || []).filter(row =>
    row && portfolioBelongsToMember(row, memberId)
  );
  // 매도 거래는 부분매도라도 DB 결산 트리거가 base_amount에 확정손익을
  // 반영한다. 결산된 pick 전체를 제외하면 남은 수량까지 사라지므로,
  // 포지션은 항상 원거래 전체로 재구성한다.
  const scopedTrades = (allTrades || [])
    .filter(trade => trade && portfolioBelongsToMember(trade, memberId))
    .sort(portfolioCompareTrades);

  const tradeStateByPick = new Map();
  let totalBuyAmount = 0;
  let totalSellAmount = 0;

  scopedTrades.forEach(trade => {
    const price = portfolioNumber(trade.price);
    const quantity = portfolioNumber(trade.quantity);
    if (price <= 0 || quantity <= 0) return;

    if (trade.trade_type === 'buy') totalBuyAmount += price * quantity;
    if (trade.trade_type === 'sell') totalSellAmount += price * quantity;

    const pickId = portfolioPickId(trade);
    if (!pickId) return;
    const state = tradeStateByPick.get(pickId) || {
      pickId,
      quantity: 0,
      averagePrice: 0,
      stock_name: trade.stock_name || '',
    };

    if (trade.trade_type === 'buy') {
      const nextCost = state.averagePrice * state.quantity + price * quantity;
      state.quantity += quantity;
      state.averagePrice = state.quantity > 0 ? nextCost / state.quantity : 0;
    } else if (trade.trade_type === 'sell') {
      state.quantity = Math.max(0, state.quantity - quantity);
      if (state.quantity === 0) state.averagePrice = 0;
    }
    if (!state.stock_name && trade.stock_name) state.stock_name = trade.stock_name;
    tradeStateByPick.set(pickId, state);
  });

  const usedPickIds = new Set();
  const positions = [];
  let fallbackInvestment = 0;

  const addPosition = (holding, buyPrice, quantity, usesFallback = false) => {
    if (buyPrice <= 0 || quantity <= 0) return;
    const cost = buyPrice * quantity;
    const currentPrice = portfolioCurrentPrice(priceMap, holding?.stock_code);
    const currentValue = currentPrice === null ? null : currentPrice * quantity;
    const estimatedValue = currentValue ?? cost;
    const pnl = currentValue === null ? null : currentValue - cost;
    const returnRate = pnl === null ? null : portfolioRate(pnl, cost);
    if (usesFallback) fallbackInvestment += cost;
    positions.push({
      ...(holding || {}),
      buyPrice,
      quantity,
      cost,
      currentPrice,
      currentValue,
      estimatedValue,
      pnl,
      returnRate,
      hasLivePrice: currentPrice !== null,
      usesFallback,
    });
  };

  scopedHoldings.forEach(holding => {
    const pickId = portfolioPickId(holding);
    if (!pickId || usedPickIds.has(pickId)) return;
    if (holding._isCarryFallback) return;
    usedPickIds.add(pickId);

    const state = tradeStateByPick.get(pickId);
    if (state) {
      addPosition(holding, state.averagePrice, state.quantity, false);
      return;
    }
    if (holding.status !== 'hold') return;
    addPosition(
      holding,
      portfolioNumber(holding.buy_price),
      portfolioNumber(holding.buy_quantity),
      true
    );
  });

  tradeStateByPick.forEach((state, pickId) => {
    if (usedPickIds.has(pickId)) return;
    addPosition(
      { pick_id: pickId, stock_name: state.stock_name || '종목 미정' },
      state.averagePrice,
      state.quantity,
      false
    );
  });

  positions.sort((a, b) =>
    b.estimatedValue - a.estimatedValue ||
    String(a.stock_name || '').localeCompare(String(b.stock_name || ''))
  );

  const totalCost = positions.reduce((sum, position) => sum + position.cost, 0);
  const baseAmount = portfolioNumber(member?.base_amount);
  // base_amount에는 자동 결산된 매도손익·수수료가 이미 반영된다.
  // 따라서 현재 현금은 누적 매매대금이 아니라 남은 보유원가만 차감한다.
  const cashInvestment = totalCost;
  const cash = baseAmount - totalCost;
  const estimatedPositionValue = positions.reduce(
    (sum, position) => sum + position.estimatedValue,
    0
  );
  const pricedPositions = positions.filter(position => position.hasLivePrice);
  const pricedCost = pricedPositions.reduce((sum, position) => sum + position.cost, 0);
  const pricedValue = pricedPositions.reduce(
    (sum, position) => sum + position.currentValue,
    0
  );
  const holdingCount = positions.length;
  const priceMatchedCount = pricedPositions.length;
  const hasCompletePricing = priceMatchedCount === holdingCount;
  const totalMarketValue = hasCompletePricing ? pricedValue : null;
  const totalAsset = hasCompletePricing ? cash + pricedValue : null;
  const estimatedTotalAsset = cash + estimatedPositionValue;
  const unrealizedPnl = hasCompletePricing ? pricedValue - totalCost : null;
  const unrealizedRate = unrealizedPnl === null
    ? null
    : portfolioRate(unrealizedPnl, totalCost);
  const knownUnrealizedPnl = pricedValue - pricedCost;
  const knownUnrealizedRate = portfolioRate(knownUnrealizedPnl, pricedCost);
  const normalizedInitial = portfolioNumber(initialAmount);
  const totalProfit = totalAsset === null || normalizedInitial <= 0
    ? null
    : totalAsset - normalizedInitial;
  const totalReturnRate = totalProfit === null
    ? null
    : portfolioRate(totalProfit, normalizedInitial);

  return {
    memberId,
    initialAmount: normalizedInitial,
    baseAmount,
    totalBuyAmount: totalBuyAmount + fallbackInvestment,
    totalSellAmount,
    cashInvestment,
    cash,
    totalCost,
    totalPositionValue: estimatedPositionValue,
    totalMarketValue,
    pricedCost,
    pricedValue,
    unrealizedPnl,
    unrealizedRate,
    knownUnrealizedPnl,
    knownUnrealizedRate,
    totalAsset,
    estimatedTotalAsset,
    totalProfit,
    totalReturnRate,
    priceMatchedCount,
    holdingCount,
    hasCompletePricing,
    positions,
  };
}

function buildPortfolioSnapshot(
  members = [],
  holdings = [],
  allTrades = [],
  priceMap = {}
) {
  const safeMembers = members || [];
  const hasStableMemberIds = safeMembers.length > 0 && safeMembers.every(member =>
    member?.id !== null && member?.id !== undefined
  );
  // 활성 멤버 목록이 비었거나 ID가 불완전하면 보유/거래 행을 전체 펀드로
  // 간주하지 않는다. 멤버 조회 실패 시 비활성 데이터가 섞이는 것을 막는다.
  const valuationMembers = hasStableMemberIds ? safeMembers : [];
  const memberValuations = valuationMembers.map(member =>
    buildMemberPortfolioValuation(
      member,
      holdings,
      allTrades,
      priceMap,
      0
    )
  );
  const positions = memberValuations
    .flatMap(valuation => valuation.positions)
    .sort((a, b) =>
      b.estimatedValue - a.estimatedValue ||
      String(a.stock_name || '').localeCompare(String(b.stock_name || ''))
    );
  const totalBase = memberValuations.reduce((sum, value) => sum + value.baseAmount, 0);
  const totalBuyAmount = memberValuations.reduce((sum, value) => sum + value.totalBuyAmount, 0);
  const totalSellAmount = memberValuations.reduce((sum, value) => sum + value.totalSellAmount, 0);
  const cash = memberValuations.reduce((sum, value) => sum + value.cash, 0);
  const totalCost = positions.reduce((sum, position) => sum + position.cost, 0);
  const totalPositionValue = positions.reduce(
    (sum, position) => sum + position.estimatedValue,
    0
  );
  const pricedPositions = positions.filter(position => position.hasLivePrice);
  const pricedCost = pricedPositions.reduce((sum, position) => sum + position.cost, 0);
  const pricedValue = pricedPositions.reduce(
    (sum, position) => sum + position.currentValue,
    0
  );
  const holdingCount = positions.length;
  const priceMatchedCount = pricedPositions.length;
  const hasCompletePricing = holdingCount === priceMatchedCount;
  const totalMarketValue = hasCompletePricing ? pricedValue : null;
  const totalAsset = hasCompletePricing ? cash + pricedValue : null;
  const estimatedTotalAsset = cash + totalPositionValue;
  const unrealizedPnl = hasCompletePricing ? pricedValue - totalCost : null;
  const unrealizedRate = unrealizedPnl === null || totalCost <= 0
    ? null
    : unrealizedPnl / totalCost * 100;
  const knownUnrealizedPnl = pricedValue - pricedCost;

  const allocationByStock = new Map();
  positions.forEach(position => {
    const key = String(
      position.stock_code || position.stock_name || position.pick_id || position.id || ''
    );
    if (!key) return;
    const existing = allocationByStock.get(key) || {
      key,
      label: position.stock_name || position.stock_code || '종목 미정',
      value: 0,
      type: 'holding',
    };
    existing.value += position.estimatedValue;
    allocationByStock.set(key, existing);
  });
  const allocationRows = [...allocationByStock.values()]
    .filter(item => item.value > 0)
    .sort((a, b) => b.value - a.value);
  if (cash > 0) {
    allocationRows.push({ key: 'cash', label: '현금', value: cash, type: 'cash' });
  }
  const allocationTotal = allocationRows.reduce((sum, item) => sum + item.value, 0);
  const allocations = allocationRows.map(item => ({
    ...item,
    share: allocationTotal > 0 ? item.value / allocationTotal * 100 : 0,
  }));

  return {
    totalBase,
    totalBuyAmount,
    totalSellAmount,
    cash,
    totalCost,
    totalPositionValue,
    totalMarketValue,
    totalAsset,
    estimatedTotalAsset,
    pricedCost,
    pricedValue,
    unrealizedPnl,
    unrealizedRate,
    knownUnrealizedPnl,
    priceMatchedCount,
    holdingCount,
    hasCompletePricing,
    positions,
    allocations,
    memberValuations,
  };
}

// The holdings list uses the same remaining trade positions as the fund total.
function portfolioHoldingRows(snapshot, members = []) {
  const names = new Map(members.map(member => [String(member.id), member.name]));
  return snapshot.positions.map(position => ({
    ...position,
    status: 'hold',
    buy_price: position.buyPrice,
    buy_quantity: position.quantity,
    member_name: position.member_name || names.get(String(position.member_id)) || '담당자 미정',
  }));
}

function portfolioPriceAsOf(positions = [], priceMap = {}) {
  if (!positions.length) return '보유 내역 없음';
  const timestamps = positions.map(position => {
    const entry = priceMap[position.stock_code];
    return Date.parse(entry?.updatedAt || entry?.updated_at || '');
  });
  const valid = timestamps.filter(Number.isFinite);
  if (!valid.length) return '가격 기준 시각 확인 불가';
  const format = value => new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const oldest = Math.min(...valid);
  const newest = Math.max(...valid);
  return '가격 기준 ' + format(oldest) +
    (newest !== oldest ? ' ~ ' + format(newest) : '') + ' (한국시간)' +
    (valid.length !== positions.length ? ' · 일부 기준 시각 미확인' : '');
}

function sortPortfolioHoldings(rows, key = 'currentValue', direction = 'desc') {
  const allowed = ['stock_name', 'quantity', 'buyPrice', 'currentPrice', 'currentValue', 'returnRate', 'pnl'];
  const field = allowed.includes(key) ? key : 'currentValue';
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
    if (right === null || right === undefined) return -1;
    const comparison = field === 'stock_name'
      ? String(left).localeCompare(String(right), 'ko') : left - right;
    return comparison * sign || String(a.stock_name || '').localeCompare(String(b.stock_name || ''), 'ko');
  });
}
