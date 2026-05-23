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
