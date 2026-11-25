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
  // Recover legacy other-topic rows whose shared theme itself contained '>'.
  const marker = topic.match(/>\s*(\[자유 주제\](?:\s|$))/);
  if (marker) return topic.slice(marker.index + marker[0].indexOf('[')).trim();
  const parts = topic.split('>');
  return (parts.length > 1 ? parts.slice(1).join('>') : parts[0]).trim();
}

function validatePresentationSharedTheme(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('공통 주제나 산업명을 입력해 주세요.');
  if (name.includes('>') || name.includes(FREE_PRESENTATION_PREFIX.trim())) {
    throw new Error('공통 주제에는 > 또는 [자유 주제]를 사용할 수 없습니다. 구분에는 · 또는 /를 사용해 주세요. 개별 발표 제목에는 >를 사용할 수 있습니다.');
  }
  return name;
}

function presentationTopicPrefix(p) {
  const topic = String(p?.topic || '').trim();
  const tail = presentationTopicTail(p);
  return topic === tail ? '' : topic.slice(0, topic.length - tail.length).replace(/>\s*$/, '').trim();
}

function isFreePresentation(p) {
  const title = presentationTopicTail(p);
  return title === FREE_PRESENTATION_PREFIX.trim() || title.startsWith(FREE_PRESENTATION_PREFIX);
}

// Display the legacy storage marker as the current label without changing data.
// Callers inserting this string into HTML must still escape it.
function formatPresentationTopicLabel(p, fallback = '') {
  return presentationTopicTail(p).replace('[자유 주제]', '[기타]') || fallback;
}

function presentationContentPayload(draft, values) {
  const free = values.format === 'free';
  const title = String(values.title || '').trim();
  if (!title) throw new Error(free ? '발표 주제나 산업명을 입력하세요.' : '종목명을 입력하세요.');
  const sharedTheme = presentationTopicPrefix(draft);
  const prefix = sharedTheme ? sharedTheme + ' > ' : '';
  if (sharedTheme && !free) validatePresentationSharedTheme(sharedTheme);
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
  return p?.category === 'industry' ? presentationTopicPrefix(p) || null : null;
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

// The DB increments edit_revision for every writer, including price jobs and
// shared-topic changes. A short CAS predicate also supports long manuscripts.
function createPresentationInsertRequest(draft, values, storagePayload) {
  return { payload: { ...(storagePayload || {}), ...presentationContentPayload(draft, values), id: crypto.randomUUID() } };
}

async function savePresentationEdit(client, baseline, draft, values, storagePayload, insertRequest) {
  const desired = { ...(storagePayload || {}), ...presentationContentPayload(draft, values) };
  if (!baseline?.id) {
    const original = insertRequest?.payload;
    if (!original?.id || original.member_id !== desired.member_id || original.schedule_id !== desired.schedule_id) {
      throw new Error('신규 발표 저장 정보를 확인할 수 없습니다. 입력 내용을 보관한 뒤 다시 열어 주세요.');
    }
    let result;
    try { result = await client.from('presentations').insert(original).select().single(); }
    catch (error) { result = { error }; }
    let data = result.data;
    if (result.error) {
      // A lost response is indistinguishable from a failed INSERT. Look up the
      // same UUID; never generate another request or blindly overwrite a row.
      let lookup;
      try { lookup = await client.from('presentations').select('*').eq('id', original.id).maybeSingle(); }
      catch (_) { throw result.error; }
      if (lookup.error || !lookup.data) throw result.error;
      data = lookup.data;
      const fields = ['member_id', 'schedule_id', 'category', 'status', 'topic', 'reason', 'risk', 'presented_at', 'stock_code', 'market_cap_at', 'target_cap'];
      if (Number(data.edit_revision) !== 0 || fields.some(key => JSON.stringify(data[key] ?? null) !== JSON.stringify(original[key] ?? null))) {
        throw Object.assign(new Error('이 발표는 이미 저장된 뒤 변경되었습니다. 최신 내용과 비교해 주세요.'), { code: 'PRESENTATION_CONFLICT' });
      }
    }
    if (!data?.id) throw new Error('저장 결과를 확인하지 못했습니다. 같은 입력창에서 다시 저장해 주세요.');
    // If the user amended inputs after the failed response, save those edits
    // against the recovered row's revision rather than discarding them.
    return savePresentationEdit(client, data, draft, values, storagePayload);
  }
  // An unchanged individual title must never write an old shared-topic prefix.
  if (!Object.hasOwn(storagePayload || {}, 'topic') &&
      values.title.trim() === parsePresentationStockName(draft) &&
      (values.format === 'free') === isFreePresentation(draft)) delete desired.topic;
  const patch = Object.fromEntries(Object.entries(desired).filter(([key, value]) =>
    key !== 'id' && JSON.stringify(value ?? null) !== JSON.stringify(baseline[key] ?? null)));
  if (!Object.keys(patch).length) {
    const { data, error } = await client.from('presentations').select('*').eq('id', baseline.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
    throw Object.assign(new Error('발표가 삭제되었거나 더 이상 접근할 수 없습니다.'), { code: 'PRESENTATION_CONFLICT' });
  }
  if (baseline.edit_revision == null) throw new Error('발표 저장 보호 기능의 DB 적용이 필요합니다. 관리자에게 문의해 주세요. 입력 내용은 유지됩니다.');
  const query = client.from('presentations').update(patch).eq('id', baseline.id).eq('edit_revision', baseline.edit_revision);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('다른 곳에서 발표가 변경되었습니다. 입력 내용을 유지했으니 최신 내용과 비교해 주세요.'), { code: 'PRESENTATION_CONFLICT' });
  return data;
}

function presentationLocalDraftKey(accountId, draft, epoch) {
  if (!accountId || !draft?.member_id) return null;
  return 'sss:presentation-edit:v1:' + JSON.stringify([
    accountId, draft.member_id, draft.id || null, draft.schedule_id || null,
    draft.id || draft.schedule_id ? null : epoch || draft.presented_at || 'pending',
  ]);
}

function readPresentationLocalDraft(storage, key) {
  if (!key) return null;
  try {
    const record = JSON.parse(storage.getItem(key));
    if (record?.version !== 1 || !record.draft || !record.baseline ||
        !Array.isArray(record.values) || record.values.length !== 6 ||
        !record.values.every(value => typeof value === 'string') ||
        !['stock', 'free'].includes(record.values[0])) return null;
    return record;
  } catch (_) { return null; }
}

function buildPresentationHistoryCycles(registry, schedules, configs, rows) {
  const bySchedule = new Map((schedules || []).map(row => [String(row.id), row]));
  return (registry?.cycles || []).map(cycle => {
    const ids = new Set(cycle.scheduleIds.map(String));
    const dates = cycle.scheduleIds.map(id => bySchedule.get(String(id))?.event_date).filter(Boolean).sort();
    const presentations = (rows || []).filter(row => ids.has(String(row.schedule_id)));
    const theme = configs?.[cycle.topicKey] || presentations.map(parsePresentationIndustry).find(Boolean) || '';
    const category = cycle.category === 'industry' ? '산업 분석' : '기업 분석';
    return { id: cycle.id, scheduleIds: [...ids], label: [category, theme, dates.length ? dates[0] + (dates.length > 1 ? ' ~ ' + dates.at(-1) : '') : '일정 삭제됨'].filter(Boolean).join(' · ') };
  });
}

function matchesPresentationHistoryFilters(row, filters, cycles = []) {
  const haystack = [parsePresentationStockName(row), row.stock_code, formatPresentationTopicLabel(row), row.topic, row.members?.name].filter(Boolean).join(' ').toLowerCase();
  const cycle = cycles.find(item => item.id === filters.cycle);
  return isDonePresentation(row) &&
    (!filters.member || row.member_id === filters.member) &&
    (!filters.category || row.category === filters.category) &&
    (!filters.format || (isFreePresentation(row) ? 'free' : 'stock') === filters.format) &&
    (!filters.cycle || (filters.cycle === '__unassigned__'
      ? !cycles.some(item => item.scheduleIds.includes(String(row.schedule_id)))
      : Boolean(cycle?.scheduleIds.includes(String(row.schedule_id))))) &&
    (!filters.search || haystack.includes(filters.search.trim().toLowerCase()));
}
