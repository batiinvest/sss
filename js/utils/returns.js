function calcReturnRate(basePrice, currentPrice) {
  const base = Number(basePrice);
  const current = Number(currentPrice);
  if (!Number.isFinite(base) || !Number.isFinite(current) || base <= 0 || current <= 0) return null;
  return (current - base) / base * 100;
}

function calcMarketCapAt(priceAt, currentPrice, currentMarketCap) {
  const price = Number(priceAt);
  const current = Number(currentPrice);
  const cap = Number(currentMarketCap);
  if (!Number.isFinite(price) || !Number.isFinite(current) || !Number.isFinite(cap)) return null;
  if (price <= 0 || current <= 0 || cap <= 0) return null;
  return Math.round(cap * (price / current));
}

function calcMarketCapReturn(marketCapAt, currentMarketCap) {
  const base = Number(marketCapAt);
  const current = Number(currentMarketCap);
  if (!Number.isFinite(base) || !Number.isFinite(current) || base <= 0 || current <= 0) return null;
  return (current - base) / base * 100;
}
