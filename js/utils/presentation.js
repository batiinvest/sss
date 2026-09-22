const PRESENTATION_CATEGORY_LABEL = {
  industry: '산업',
  stock: '종목',
};

function parsePresentationIndustry(p) {
  if (p?.category === 'industry' && p.topic?.includes(' > ')) {
    return p.topic.split(' > ')[0].trim();
  }
  return null;
}

function parsePresentationStockName(p) {
  if (p?.topic?.includes(' > ')) return p.topic.split(' > ')[1].trim();
  return p?.topic || '';
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
  return /^\d{6}$/.test(p?.stock_code || '');
}

function getPresentationReturnBase(p) {
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
