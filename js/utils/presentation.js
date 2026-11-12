const PRESENTATION_CATEGORY_LABEL = {
  industry: '산업',
  stock: '종목',
};

// A human-readable topic marker keeps format and content in one atomic row write
// without changing the deployed schema. Missing markers retain the stock format,
// including manually entered overseas stocks without a stock_code.
const FREE_PRESENTATION_PREFIX = '[자유 주제] ';

function presentationTopicTail(p) {
  const topic = String(p?.topic || '').trim();
  if (topic.startsWith(FREE_PRESENTATION_PREFIX) || topic === FREE_PRESENTATION_PREFIX.trim()) return topic;
  const parts = topic.split('>');
  return (parts.length > 1 ? parts.slice(1).join('>') : parts[0]).trim();
}

function isFreePresentation(p) {
  const title = presentationTopicTail(p);
  return title === FREE_PRESENTATION_PREFIX.trim() || title.startsWith(FREE_PRESENTATION_PREFIX);
}

function presentationContentPayload(draft, values) {
  const free = values.format === 'free';
  const title = String(values.title || '').trim();
  if (!title) throw new Error(free ? '발표 주제나 산업명을 입력하세요.' : '종목명을 입력하세요.');
  const prefix = !String(draft.topic || '').trim().startsWith(FREE_PRESENTATION_PREFIX.trim()) && String(draft.topic || '').includes('>')
    ? String(draft.topic).split('>')[0].trim() + ' > ' : '';
  const result = {
    topic: prefix + (free ? FREE_PRESENTATION_PREFIX : '') + title,
    market_cap_at: free ? null : values.market_cap_at,
    target_cap: free ? null : values.target_cap,
    reason: values.reason || null,
    risk: values.risk || null,
  };
  if (free || title !== parsePresentationStockName(draft)) {
    result.stock_code = null;
    result.price_at = null;
  }
  return result;
}

function parsePresentationIndustry(p) {
  if (String(p?.topic || '').trim().startsWith(FREE_PRESENTATION_PREFIX.trim())) return null;
  if (p?.category === 'industry' && p.topic?.includes(' > ')) {
    return p.topic.split(' > ')[0].trim();
  }
  return null;
}

function parsePresentationStockName(p) {
  const title = presentationTopicTail(p);
  return isFreePresentation(p) ? title.slice(FREE_PRESENTATION_PREFIX.length) : title;
}

function getPresentationCategoryLabel(category) {
  return PRESENTATION_CATEGORY_LABEL[category] || '기타';
}

function isTalkCategory(category) {
  return category === 'industry' || category === 'stock';
}

function isDonePresentation(p) {
  return (p?.status || 'done') === 'done';
}

function isPlannedPresentation(p) {
  return p?.status === 'planned';
}

function isAutomaticPresentationPrice(p) {
  return !isFreePresentation(p) && /^\d{6}$/.test(p?.stock_code || '');
}

function getPresentationReturnBase(p) {
  if (isFreePresentation(p)) return null;
  if (isAutomaticPresentationPrice(p)) {
    if (p.price_source !== 'naver_daily_close_v1' || p.price_date !== p.presented_at) return null;
    const adjusted = Number(p.price_adjusted_at);
    return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : null;
  }
  const price = Number(p?.price_at);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function getPresentationPriceTitle(p) {
  if (!isAutomaticPresentationPrice(p)) return '';
  if (!getPresentationReturnBase(p)) return '발표일 종가 확인 대기';
  const adjusted = Number(p.price_adjusted_at);
  const suffix = adjusted !== Number(p.price_at)
    ? ` · 수익률 기준 수정종가 ${adjusted.toLocaleString('ko-KR')}원` : '';
  return `${p.price_date} 종가 · NAVER${suffix}`;
}
