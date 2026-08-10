// ============================================================
// js/utils/portfolio.js
// 홈 포트폴리오 현황 계산 — DOM/DB 의존 없는 순수 함수
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

function buildPortfolioSnapshot(
  members = [],
  holdings = [],
  allTrades = [],
  priceMap = {}
) {
  const portfolioMemberIds = new Set(
    (members || [])
      .map(member => member?.id)
      .filter(memberId => memberId !== null && memberId !== undefined)
      .map(String)
  );
  const belongsToPortfolio = row =>
    !portfolioMemberIds.size ||
    (row?.member_id !== null &&
      row?.member_id !== undefined &&
      portfolioMemberIds.has(String(row.member_id)));
  const totalBase = (members || []).reduce(
    (sum, member) => sum + portfolioNumber(member?.base_amount),
    0
  );
  const totalBuyAmount = (allTrades || [])
    .filter(trade => belongsToPortfolio(trade) && trade?.trade_type === 'buy')
    .reduce(
      (sum, trade) => sum + portfolioNumber(trade.price) * portfolioNumber(trade.quantity),
      0
    );
  const totalSellAmount = (allTrades || [])
    .filter(trade => belongsToPortfolio(trade) && trade?.trade_type === 'sell')
    .reduce(
      (sum, trade) => sum + portfolioNumber(trade.price) * portfolioNumber(trade.quantity),
      0
    );
  const cash = totalBase - (totalBuyAmount - totalSellAmount);

  const positions = (holdings || [])
    .filter(holding =>
      holding &&
      belongsToPortfolio(holding) &&
      holding.status === 'hold' &&
      !holding._isCarryFallback &&
      portfolioNumber(holding.buy_price) > 0 &&
      portfolioNumber(holding.buy_quantity) > 0
    )
    .map(holding => {
      const buyPrice = portfolioNumber(holding.buy_price);
      const quantity = portfolioNumber(holding.buy_quantity);
      const cost = buyPrice * quantity;
      const currentPrice = portfolioCurrentPrice(priceMap, holding.stock_code);
      const currentValue = currentPrice === null ? null : currentPrice * quantity;
      const estimatedValue = currentValue ?? cost;
      const pnl = currentValue === null ? null : currentValue - cost;
      const returnRate = pnl === null || cost <= 0 ? null : pnl / cost * 100;
      return {
        ...holding,
        buyPrice,
        quantity,
        cost,
        currentPrice,
        currentValue,
        estimatedValue,
        pnl,
        returnRate,
        hasLivePrice: currentPrice !== null,
      };
    })
    .sort((a, b) =>
      b.estimatedValue - a.estimatedValue ||
      String(a.stock_name || '').localeCompare(String(b.stock_name || ''))
    );

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
  const unrealizedPnl = pricedPositions.length ? pricedValue - pricedCost : null;
  const unrealizedRate = unrealizedPnl === null || pricedCost <= 0
    ? null
    : unrealizedPnl / pricedCost * 100;
  const totalAsset = cash + totalPositionValue;

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
    totalAsset,
    pricedCost,
    pricedValue,
    unrealizedPnl,
    unrealizedRate,
    priceMatchedCount: pricedPositions.length,
    holdingCount: positions.length,
    positions,
    allocations,
  };
}
