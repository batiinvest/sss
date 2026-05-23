const STOCK_PRICE_SELECT = 'stock_code,stock_name,market,price,change_rate,market_cap,updated_at';

function normalizePriceRow(row) {
  if (!row || Number(row.price) <= 0) return null;
  return {
    ...row,
    price: Number(row.price),
    change: Number(row.change_rate || 0),
    marketCap: row.market_cap || null,
    updatedAt: row.updated_at || null,
  };
}

function buildPriceMap(rows) {
  const map = {};
  for (const row of (rows || [])) {
    const normalized = normalizePriceRow(row);
    if (normalized?.stock_code) map[normalized.stock_code] = normalized;
  }
  return map;
}

async function fetchPriceMapByCodes(codes) {
  const uniqueCodes = [...new Set((codes || []).filter(Boolean))];
  if (!uniqueCodes.length) return {};

  const { data, error } = await sb.from('stock_prices')
    .select(STOCK_PRICE_SELECT)
    .in('stock_code', uniqueCodes);
  if (error) {
    console.error('fetchPriceMapByCodes:', error);
    return {};
  }
  return buildPriceMap(data || []);
}

async function fetchPriceRowsByNames(stockNames, limitMultiplier = 3) {
  const names = [...new Set((stockNames || []).map(n => String(n || '').trim()).filter(n => n.length >= 2))];
  if (!names.length) return [];

  const { data, error } = await sb.from('stock_prices')
    .select(STOCK_PRICE_SELECT)
    .or(names.map(n => `stock_name.eq.${n}`).join(','))
    .gt('price', 0)
    .order('market_cap', { ascending: false, nullsFirst: false })
    .limit(names.length * limitMultiplier);
  if (error) {
    console.error('fetchPriceRowsByNames:', error);
    return [];
  }
  return data || [];
}

function mergePriceMaps(...maps) {
  return Object.assign({}, ...maps.filter(Boolean));
}
