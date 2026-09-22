const fs = require('node:fs');

const SOURCE = 'naver_daily_close_v1';

function eligible(row, now = new Date()) {
  if (!/^\d{6}$/.test(row.stock_code || '') || (row.status || 'done') !== 'done') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.presented_at || '')) return false;
  // Wait until 18:00 KST, never persist an intraday quote as the daily close.
  const readyAt = Date.parse(row.presented_at + 'T18:00:00+09:00');
  return Number.isFinite(readyAt) && now.getTime() >= readyAt;
}

async function request(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function parseAdjusted(text) {
  const data = JSON.parse(text.replaceAll("'", '"').replace(/,\s*\]/g, ']'));
  if (!Array.isArray(data)) throw new Error('Invalid daily chart response');
  return new Map(data.filter(row => Array.isArray(row) && /^\d{8}$/.test(row[0]))
    .map(row => [row[0], Number(row[4])]));
}

function buildQuote(row, daily, adjusted, checkedAt) {
  const candle = daily.find(item => item.localTradedAt === row.presented_at);
  const close = Number(String(candle?.closePrice || '').replaceAll(',', ''));
  const adjustedClose = adjusted.get(row.presented_at.replaceAll('-', ''));
  if (!Number.isSafeInteger(close) || close <= 0 || !Number.isFinite(adjustedClose) || adjustedClose <= 0) {
    throw new Error('Exact-date close unavailable: ' + row.stock_code + '/' + row.presented_at);
  }
  return { p_id: row.id, p_stock_code: row.stock_code, p_presented_at: row.presented_at,
    p_close: close, p_adjusted_close: adjustedClose, p_checked_at: checkedAt };
}

async function collectQuotes(rows, { now = new Date(), get = request } = {}) {
  const groups = new Map();
  for (const row of rows.filter(row => eligible(row, now))) {
    if (!groups.has(row.stock_code)) groups.set(row.stock_code, []);
    groups.get(row.stock_code).push(row);
  }
  const quotes = [], failures = [];
  const jobs = [...groups.entries()];
  for (let offset = 0; offset < jobs.length; offset += 3) {
    await Promise.all(jobs.slice(offset, offset + 3).map(async ([code, records]) => {
      try {
        const dates = records.map(row => row.presented_at).sort();
        const daily = [];
        for (let page = 1; page <= 100; page++) {
          const batch = JSON.parse(await get(`https://m.stock.naver.com/api/stock/${code}/price?pageSize=60&page=${page}`));
          if (!Array.isArray(batch)) throw new Error('Invalid daily price response');
          daily.push(...batch);
          if (!batch.length || batch.some(item => item.localTradedAt <= dates[0])) break;
        }
        const query = new URLSearchParams({ symbol: code, requestType: '1',
          startTime: dates[0].replaceAll('-', ''), endTime: dates.at(-1).replaceAll('-', ''), timeframe: 'day' });
        const adjusted = parseAdjusted(await get('https://api.finance.naver.com/siseJson.naver?' + query));
        for (const row of records) {
          try { quotes.push(buildQuote(row, daily, adjusted, now.toISOString())); }
          catch (error) { failures.push({ id: row.id, code, error: error.message }); }
        }
      } catch (error) { failures.push({ code, error: error.message }); }
    }));
  }
  return { source: SOURCE, checkedAt: now.toISOString(), quotes, failures };
}

async function run() {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const apply = args.includes('--apply');
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  let rows;
  if (args.includes('--input')) {
    const input = JSON.parse(fs.readFileSync(option('--input'), 'utf8'));
    rows = input.rows || input;
  } else {
    if (!base || !key) throw new Error('Supabase service credentials required');
    rows = [];
    for (let offset = 0; ; offset += 500) {
      const query = new URLSearchParams({ select: 'id,stock_code,presented_at,status',
        or: '(status.eq.done,status.is.null)', order: 'id', limit: '500', offset: String(offset) });
      const batch = JSON.parse(await request(base + '/rest/v1/presentations?' + query, { headers }));
      rows.push(...batch);
      if (batch.length < 500) break;
    }
  }
  const result = await collectQuotes(rows);
  let applied = 0, skipped = 0;
  if (apply) {
    if (!base || !key) throw new Error('Supabase service credentials required');
    for (const quote of result.quotes) {
      try {
        const accepted = JSON.parse(await request(base + '/rest/v1/rpc/apply_presentation_day_price', {
          method: 'POST', headers, body: JSON.stringify(quote),
        }));
        if (accepted === true) applied++; else skipped++;
      } catch (error) { result.failures.push({ id: quote.p_id, error: error.message }); }
    }
  }
  if (args.includes('--output')) fs.writeFileSync(option('--output'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ eligible: rows.filter(row => eligible(row)).length,
    quotes: result.quotes.length, applied, skipped, failures: result.failures }, null, 2));
  if (result.failures.length) process.exitCode = 1;
}

module.exports = { SOURCE, eligible, parseAdjusted, buildQuote, collectQuotes };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
