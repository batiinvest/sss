// ============================================================
// js/schedule-shared.js  v20260725
// schedule-calendar.html + schedule-order.html 공통 모듈
// ============================================================

// ── 타임존 안전한 날짜 문자열
function toDateStr(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function addDaysToLocalDate(dateValue, days) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12
  );
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }
  date.setDate(date.getDate() + Number(days || 0));
  return toDateStr(date);
}

const SCHEDULE_AUTO_TITLES = {
  study: '스터디',
  dinner: '회식',
  other: '기타 일정',
};

const PRESENTATION_SCHEDULE_AUTO_TITLES = {
  industry: '산업 분석',
  stock: '기업 분석',
};

function getScheduleEventType(category) {
  if (['industry', 'stock'].includes(category)) return 'study';
  if (category === 'dinner') return 'dinner';
  return 'other';
}

function getScheduleCategoryForEventType(eventType, presentationTheme = 'industry') {
  if (eventType === 'study') {
    return ['industry', 'stock'].includes(presentationTheme)
      ? presentationTheme
      : 'industry';
  }
  return eventType === 'dinner' ? 'dinner' : 'other';
}

function getAutomaticScheduleTitle(eventType, category) {
  if (eventType === 'study' && PRESENTATION_SCHEDULE_AUTO_TITLES[category]) {
    return PRESENTATION_SCHEDULE_AUTO_TITLES[category];
  }
  return SCHEDULE_AUTO_TITLES[eventType] || '일정';
}

function resolveScheduleTitle({
  eventType,
  category,
  otherTitle,
  editing = false,
  originalEventType,
  originalCategory,
  originalTitle,
} = {}) {
  if (eventType === 'other') {
    return String(otherTitle || '').trim() || getAutomaticScheduleTitle('other');
  }
  const storedTitle = String(originalTitle || '').trim();
  const samePresentationTheme =
    eventType !== 'study' || originalCategory === category;
  const legacyGenericTitle = ['스터디', '종목 분석'].includes(storedTitle);
  const categoryStampedTitle =
    /^(기업 분석|종목 분석|산업 분석)\s*—\s*.+$/.test(storedTitle);
  const customPresentationTitle =
    eventType === 'study' &&
    !isManagedPresentationScheduleTitle(storedTitle) &&
    !categoryStampedTitle;
  if (
    editing &&
    originalEventType === eventType &&
    storedTitle &&
    !legacyGenericTitle &&
    (samePresentationTheme || customPresentationTitle)
  ) {
    return storedTitle;
  }
  return getAutomaticScheduleTitle(eventType, category);
}

function uniqueScheduleTitleParts(values = []) {
  const seen = new Set();
  return values.reduce((result, value) => {
    const normalized = String(value || '').trim();
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

function getPresentationScheduleTopicParts(presentation) {
  const topic = String(presentation?.topic || '').trim();
  if (!topic) return { industry: '', subject: '' };
  const parts = topic.split('>').map(part => part.trim()).filter(Boolean);
  return {
    industry:
      presentation?.category === 'industry' && parts.length > 1
        ? parts[0]
        : '',
    subject: parts[parts.length - 1] || '',
  };
}

function getAutomaticPresentationScheduleTitle(
  category,
  linkedPresentations = [],
  opts = {}
) {
  const baseTitle =
    PRESENTATION_SCHEDULE_AUTO_TITLES[category] ||
    getAutomaticScheduleTitle('study', category);
  const configuredIndustryName = String(opts.industryName || '').trim();
  const inferredIndustryNames = category === 'industry'
    ? uniqueScheduleTitleParts(
        linkedPresentations.map(presentation =>
          getPresentationScheduleTopicParts(presentation).industry
        )
      )
    : [];
  const detailParts = category === 'industry'
    ? configuredIndustryName
      ? [configuredIndustryName]
      : inferredIndustryNames.length === 1
        ? inferredIndustryNames
        : []
    : category === 'stock'
      ? uniqueScheduleTitleParts(
          linkedPresentations
            .filter(presentation => presentation?.category !== 'industry')
            .map(presentation =>
              getPresentationScheduleTopicParts(presentation).subject
            )
        )
      : [];
  return detailParts.length
    ? `${baseTitle} — ${detailParts.join('·')}`
    : baseTitle;
}

function isManagedPresentationScheduleTitle(title) {
  const normalized = String(title || '').trim();
  if (!normalized) return true;
  return ['스터디', '기업 분석', '종목 분석', '산업 분석'].includes(normalized);
}

function getScheduleDisplayTitle(schedule, linkedPresentations = [], opts = {}) {
  if (!schedule) return '일정';
  const storedTitle = String(schedule.title || '').trim();
  if (!isPresentationSchedule(schedule)) {
    return storedTitle || getAutomaticScheduleTitle(
      getScheduleEventType(schedule.category),
      schedule.category
    );
  }
  if (storedTitle && !isManagedPresentationScheduleTitle(storedTitle)) {
    return storedTitle;
  }

  const automaticTitle = getAutomaticPresentationScheduleTitle(
    schedule.category,
    linkedPresentations,
    opts
  );
  const baseTitle = PRESENTATION_SCHEDULE_AUTO_TITLES[schedule.category];
  return automaticTitle;
}

function normalizeScheduleSeriesField(key, value) {
  if (key === 'event_time') return String(value || '').slice(0, 5);
  return String(value ?? '').trim();
}

function isSameScheduleSeriesEntry(existing, candidate) {
  return [
    'title',
    'category',
    'event_date',
    'event_time',
    'location',
    'created_by',
    'description',
  ].every(key =>
    normalizeScheduleSeriesField(key, existing?.[key]) ===
    normalizeScheduleSeriesField(key, candidate?.[key])
  );
}

function planBiweeklyPresentationSchedules(
  existingSchedules = [],
  basePayload = {},
  opts = {}
) {
  const count = Math.max(1, Number(opts.count) || 3);
  const intervalDays = Math.max(1, Number(opts.intervalDays) || 14);
  if (!isPresentationSchedule(basePayload)) {
    return {
      candidates: [{ ...basePayload }],
      rowsToCreate: [{ ...basePayload }],
      reused: [],
      conflicts: [],
    };
  }
  const startDate = addDaysToLocalDate(basePayload.event_date, 0);
  if (!startDate) throw new Error('자동 등록 시작일이 올바르지 않습니다.');

  const candidates = Array.from({ length: count }, (_, index) => ({
    ...basePayload,
    event_date: addDaysToLocalDate(startDate, index * intervalDays),
  }));
  const rowsToCreate = [];
  const reused = [];
  const conflicts = [];

  candidates.forEach(candidate => {
    const sameDate = (existingSchedules || []).filter(schedule =>
      String(schedule.event_date || '') === candidate.event_date
    );
    const exactRows = sameDate.filter(schedule =>
      isSameScheduleSeriesEntry(schedule, candidate)
    );
    const otherRows = sameDate.filter(schedule =>
      !isSameScheduleSeriesEntry(schedule, candidate)
    );
    if (otherRows.length || exactRows.length > 1) {
      conflicts.push({
        event_date: candidate.event_date,
        schedules: sameDate,
      });
    } else if (exactRows.length) {
      reused.push(exactRows[0]);
    } else {
      rowsToCreate.push(candidate);
    }
  });
  return { candidates, rowsToCreate, reused, conflicts };
}

function normalizePresentationDate(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// 운영 DB의 presentations.presented_at은 필수다. 아직 일정이 없는 초안은
// 오늘을 저장용 기준일로 사용하고, 일정이 생기면 자동 편성에서 실제 날짜로 바꾼다.
function buildPresentationDraftStoragePayload(payload = {}, opts = {}) {
  const presentedAt =
    normalizePresentationDate(payload.presented_at) ||
    normalizePresentationDate(opts.existingDate) ||
    normalizePresentationDate(opts.today) ||
    toDateStr(opts.now instanceof Date ? opts.now : new Date());
  return { ...payload, presented_at: presentedAt };
}

// ── 공통 전역 변수
let schedules     = [];
let members       = [];
let presentations = [];

let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-indexed

let editingScheduleId = null;

// ── 공통 상수
const CAT_LABEL = { industry: '산업 분석', stock: '기업 분석', dinner: '회식', other: '기타' };
const CAT_CLASS = { industry: 'ev-meeting', stock: 'ev-deadline', dinner: 'ev-dinner', other: 'ev-other' };
const MONTH_KR  = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const PRESENTATION_GROUP_SIZE = 3;
const PRESENTATION_DRAFT_CYCLE_CONFIG_KEY = 'presentation_draft_cycle_v1';
const PRESENTATION_DRAFT_CARRYOVER_CONFIG_PREFIX = 'presentation_draft_carryover_v1:';
const PRESENTATION_DRAFT_RECOVERY_CONFIG_KEY = 'presentation_draft_recovery_v1';
const PRESENTATION_INDUSTRY_CONFIG_PREFIX = 'presentation_industry_v1:';
// 최초 배포 전에 일정 연결 없이 남은 planned 행만 이전 사이클로 분리한다.
const PRESENTATION_DRAFT_MIGRATION_EPOCH = '2026-07-25T02:37:00.000Z';
const PRESENTATION_DEFAULT_EVENT_TIME = '20:00:00';
let presentationDraftEpoch = null;
let presentationDraftCycleKey = null;
let presentationDraftCarryoverIds = new Set();

function isPresentationSchedule(schedule) {
  return !!schedule && ['industry', 'stock'].includes(schedule.category);
}

function normalizePresentationDraftEpoch(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizePresentationDraftCycleState(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cycleKey = String(parsed.cycle_key || parsed.cycleKey || '').trim();
  const startedAt = normalizePresentationDraftEpoch(
    parsed.started_at || parsed.startedAt
  );
  const cycleMarker = String(
    parsed.cycle_marker ||
    parsed.cycleMarker ||
    (cycleKey.startsWith('rotation:') ? cycleKey.slice('rotation:'.length) : '')
  ).trim();
  return cycleKey && startedAt
    ? { cycleKey, startedAt, cycleMarker: cycleMarker || 'initial' }
    : null;
}

function normalizePresentationDraftIds(value) {
  if (value instanceof Set) {
    return new Set([...value].filter(Boolean).map(String));
  }
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(Boolean).map(String));
}

function presentationDraftCyclePayload(state) {
  return {
    cycle_key: state.cycleKey,
    cycle_marker: state.cycleMarker,
    started_at: state.startedAt,
  };
}

async function persistPresentationDraftCycleMonotonic(state) {
  const payload = presentationDraftCyclePayload(state);
  const cycleMarker = String(payload.cycle_marker || '').trim();
  if (
    cycleMarker !== 'initial' &&
    !/^\d{4}-\d{2}-\d{2}$/.test(cycleMarker)
  ) {
    throw new Error('발표 사이클 기준일이 올바르지 않습니다.');
  }

  // 먼저 "없을 때만 삽입"한다. 동시에 여러 탭이 열려도 기존 행은
  // 덮어쓰지 않으며, 아래 조건부 UPDATE가 더 최신 marker만 허용한다.
  const { error: insertError } = await sb.from('app_config').upsert(
    {
      key: PRESENTATION_DRAFT_CYCLE_CONFIG_KEY,
      value: payload,
    },
    {
      onConflict: 'key',
      ignoreDuplicates: true,
    }
  );
  if (insertError) throw insertError;

  if (cycleMarker !== 'initial') {
    const markerFilter = [
      'value->>cycle_marker.is.null',
      'value->>cycle_marker.eq.initial',
      'value->>cycle_marker.lt.' + cycleMarker,
    ].join(',');
    const { error: updateError } = await sb.from('app_config')
      .update({ value: payload })
      .eq('key', PRESENTATION_DRAFT_CYCLE_CONFIG_KEY)
      .or(markerFilter);
    if (updateError) throw updateError;
  }

  const authoritative = normalizePresentationDraftCycleState(
    await getConfigStrict(PRESENTATION_DRAFT_CYCLE_CONFIG_KEY)
  );
  if (!authoritative) {
    throw new Error('저장된 발표 사이클을 확인하지 못했습니다.');
  }
  return authoritative;
}

function resolvePresentationDraftCycleState(savedState, cycleKey, opts = {}) {
  const normalizedCycleKey = String(cycleKey || '').trim();
  if (!normalizedCycleKey) return null;
  const cycleMarker = String(
    opts.cycleMarker ||
    (normalizedCycleKey.startsWith('rotation:')
      ? normalizedCycleKey.slice('rotation:'.length)
      : 'initial')
  ).trim() || 'initial';
  const normalizedSaved = normalizePresentationDraftCycleState(savedState);
  if (normalizedSaved?.cycleKey === normalizedCycleKey) {
    return { ...normalizedSaved, changed: false };
  }
  if (normalizedSaved) {
    const savedMarker = normalizedSaved.cycleMarker === 'initial'
      ? ''
      : normalizedSaved.cycleMarker;
    const incomingMarker = cycleMarker === 'initial' ? '' : cycleMarker;
    if (savedMarker >= incomingMarker) {
      return { ...normalizedSaved, changed: false, ignoredStale: true };
    }
  }
  const startedAt = normalizedSaved
    ? normalizePresentationDraftEpoch(opts.now) || new Date().toISOString()
    : normalizePresentationDraftEpoch(opts.initialEpoch) ||
      PRESENTATION_DRAFT_MIGRATION_EPOCH;
  return {
    cycleKey: normalizedCycleKey,
    cycleMarker,
    startedAt,
    changed: true,
  };
}

async function fetchPresentationDraftCarryoverIds() {
  const { data, error } = await sb.from('app_config')
    .select('key,value')
    .like('key', PRESENTATION_DRAFT_CARRYOVER_CONFIG_PREFIX + '%');
  if (error) throw error;
  return new Set((data || [])
    .filter(row => row.value !== false && row.value !== null)
    .map(row => String(row.key || '').slice(
      PRESENTATION_DRAFT_CARRYOVER_CONFIG_PREFIX.length
    ))
    .filter(Boolean));
}

async function ensurePresentationDraftCycle(cycleKey, opts = {}) {
  const [savedState, savedCarryoverIds] = await Promise.all([
    getConfigStrict(PRESENTATION_DRAFT_CYCLE_CONFIG_KEY),
    fetchPresentationDraftCarryoverIds(),
  ]);
  const resolved = resolvePresentationDraftCycleState(
    savedState,
    cycleKey,
    opts
  );
  if (!resolved) throw new Error('발표 사이클을 확인하지 못했습니다.');
  const authoritative = await persistPresentationDraftCycleMonotonic(resolved);
  presentationDraftCycleKey = authoritative.cycleKey;
  presentationDraftEpoch = authoritative.startedAt;
  presentationDraftCarryoverIds = savedCarryoverIds;
  return {
    cycleKey: presentationDraftCycleKey,
    cycleMarker: authoritative.cycleMarker,
    startedAt: presentationDraftEpoch,
    carryoverIds: [...presentationDraftCarryoverIds],
  };
}

async function registerPresentationDraftCarryoverIds(ids = []) {
  const requested = normalizePresentationDraftIds(ids);
  if (!requested.size) return [...presentationDraftCarryoverIds];
  const { error } = await sb.from('app_config').upsert(
    [...requested].map(id => ({
      key: PRESENTATION_DRAFT_CARRYOVER_CONFIG_PREFIX + id,
      value: true,
    })),
    { onConflict: 'key' }
  );
  if (error) throw error;
  requested.forEach(id => presentationDraftCarryoverIds.add(id));
  return [...presentationDraftCarryoverIds];
}

function presentationDraftActivityTime(presentation) {
  const timestamps = [
    presentation?.created_at,
    presentation?.updated_at,
  ]
    .map(value => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : NaN;
}

function presentationCycleBoundaryTime(
  allSchedules = [],
  cycleMarker,
  defaultEventTime = PRESENTATION_DEFAULT_EVENT_TIME
) {
  const marker = String(cycleMarker || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marker)) return NaN;
  const markerSchedule = [...(allSchedules || [])]
    .filter(schedule => schedule?.event_date === marker)
    .sort((a, b) =>
      String(a.event_time || '').localeCompare(String(b.event_time || ''))
    )[0];
  const rawTime = String(
    markerSchedule?.event_time || defaultEventTime
  ).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(rawTime);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  const second = Number(match?.[3] || 0);
  const validTime = (
    Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
    Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isInteger(second) && second >= 0 && second <= 59
  )
    ? [
        String(hour).padStart(2, '0'),
        String(minute).padStart(2, '0'),
        String(second).padStart(2, '0'),
      ].join(':')
    : PRESENTATION_DEFAULT_EVENT_TIME;
  return Date.parse(marker + 'T' + validTime + '+09:00');
}

function isInitialPresentationDraftRecoveryContext(
  allSchedules = [],
  plan,
  cycleState,
  opts = {}
) {
  const migrationEpoch = normalizePresentationDraftEpoch(
    opts.migrationEpoch || PRESENTATION_DRAFT_MIGRATION_EPOCH
  );
  const draftEpoch = normalizePresentationDraftEpoch(
    opts.draftEpoch || presentationDraftEpoch
  );
  const cycleMarker = String(
    cycleState?.cycleMarker ||
    (String(cycleState?.cycleKey || '').startsWith('rotation:')
      ? String(cycleState.cycleKey).slice('rotation:'.length)
      : '')
  ).trim();
  const rosterIds = [...new Set(
    (plan?.nextMemberIds || []).filter(Boolean).map(String)
  )];
  const boundaryTime = presentationCycleBoundaryTime(
    allSchedules,
    cycleMarker,
    opts.defaultEventTime
  );
  return {
    eligible: (
      Boolean(migrationEpoch) &&
      draftEpoch === migrationEpoch &&
      /^\d{4}-\d{2}-\d{2}$/.test(cycleMarker) &&
      rosterIds.length > 0 &&
      Number.isFinite(boundaryTime)
    ),
    migrationEpoch,
    cycleMarker,
    rosterIds,
    boundaryTime,
  };
}

function selectInitialPresentationDraftRecoveryIds(
  allSchedules = [],
  allPresentations = [],
  plan,
  cycleState,
  opts = {}
) {
  const context = isInitialPresentationDraftRecoveryContext(
    allSchedules,
    plan,
    cycleState,
    opts
  );
  if (!context.eligible) return [];

  const epochTime = Date.parse(context.migrationEpoch);
  const carryoverIds = normalizePresentationDraftIds(
    opts.carryoverIds || presentationDraftCarryoverIds
  );
  const rowsByMember = new Map();
  for (const presentation of allPresentations || []) {
    const memberId = String(presentation?.member_id || '');
    if (!context.rosterIds.includes(memberId)) continue;
    if (!rowsByMember.has(memberId)) rowsByMember.set(memberId, []);
    rowsByMember.get(memberId).push(presentation);
  }

  const selectedIds = [];
  for (const memberId of context.rosterIds) {
    const plannedRows = (rowsByMember.get(memberId) || []).filter(
      presentation => presentation?.status === 'planned'
    );
    if (plannedRows.some(presentation => presentation.schedule_id)) continue;

    // A post-migration orphan without a presentation date is already a visible
    // current draft. Never replace it with an older hidden row.
    const hasCurrentDraft = plannedRows.some(presentation => {
      if (
        presentation.schedule_id ||
        presentation.presented_at ||
        carryoverIds.has(String(presentation.id || ''))
      ) {
        return false;
      }
      const createdAt = Date.parse(presentation.created_at || '');
      return Number.isFinite(createdAt) && createdAt >= epochTime;
    });
    if (hasCurrentDraft) continue;

    const candidates = plannedRows
      .filter(presentation =>
        presentation.id &&
        !presentation.schedule_id &&
        String(presentation.topic || '').trim() &&
        presentationDraftActivityTime(presentation) > context.boundaryTime
      )
      .sort((a, b) =>
        presentationDraftActivityTime(b) - presentationDraftActivityTime(a) ||
        String(b.updated_at || '').localeCompare(String(a.updated_at || '')) ||
        String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
        String(b.id || '').localeCompare(String(a.id || ''))
      );
    const registeredCandidates = candidates.filter(presentation =>
      carryoverIds.has(String(presentation.id))
    );
    const selected = registeredCandidates[0] || candidates[0];
    if (selected?.id) selectedIds.push(String(selected.id));
  }
  return selectedIds;
}

async function recoverInitialPresentationDrafts(
  client,
  allSchedules = [],
  allPresentations = [],
  orderedMembers = [],
  opts = {}
) {
  const readRecoveryState = opts.readRecoveryState ||
    (() => getConfigStrict(PRESENTATION_DRAFT_RECOVERY_CONFIG_KEY));
  const writeRecoveryState = opts.writeRecoveryState ||
    (value => setConfig(PRESENTATION_DRAFT_RECOVERY_CONFIG_KEY, value));
  const registerCarryoverIds = opts.registerCarryoverIds ||
    registerPresentationDraftCarryoverIds;
  const savedRecovery = Object.prototype.hasOwnProperty.call(
    opts,
    'recoveryState'
  )
    ? opts.recoveryState
    : await readRecoveryState();
  if (savedRecovery) {
    return { recoveredIds: [], skipped: 'completed' };
  }

  const fromDate = opts.fromDate || toDateStr(new Date());
  const cycleState = opts.cycleState || getPresentationDraftCycleState(
    allSchedules,
    allPresentations,
    orderedMembers,
    { fromDate }
  );
  const plan = opts.plan || buildPresentationSchedulePlan(
    allSchedules,
    allPresentations,
    orderedMembers,
    { fromDate }
  );
  const context = isInitialPresentationDraftRecoveryContext(
    allSchedules,
    plan,
    cycleState,
    opts
  );
  if (!context.eligible) {
    return { recoveredIds: [], skipped: 'not-initial-migration' };
  }

  const recoveredIds = selectInitialPresentationDraftRecoveryIds(
    allSchedules,
    allPresentations,
    plan,
    cycleState,
    opts
  );
  if (recoveredIds.length) {
    await registerCarryoverIds(recoveredIds);
  }

  const completedAt = normalizePresentationDraftEpoch(opts.now) ||
    new Date().toISOString();
  await writeRecoveryState({
    cycle_key: cycleState.cycleKey,
    cycle_marker: context.cycleMarker,
    roster_member_ids: context.rosterIds,
    recovered_ids: recoveredIds,
    completed_at: completedAt,
  });
  return { recoveredIds, skipped: null };
}

function isCurrentUnassignedPresentationDraft(
  presentation,
  draftEpoch = presentationDraftEpoch,
  carryoverIds = presentationDraftCarryoverIds
) {
  if (
    !presentation ||
    presentation.status !== 'planned' ||
    presentation.schedule_id
  ) {
    return false;
  }
  const normalizedCarryoverIds = normalizePresentationDraftIds(carryoverIds);
  if (presentation.id && normalizedCarryoverIds.has(String(presentation.id))) {
    return true;
  }
  const normalizedEpoch = normalizePresentationDraftEpoch(draftEpoch);
  if (!normalizedEpoch) return false;
  const createdAt = Date.parse(presentation.created_at || '');
  return Number.isFinite(createdAt) && createdAt >= Date.parse(normalizedEpoch);
}

function findCurrentPresentationDraft(
  allPresentations = [],
  memberId,
  opts = {}
) {
  const memberKey = String(memberId || '');
  const plannedRows = (allPresentations || [])
    .filter(presentation =>
      String(presentation.member_id || '') === memberKey &&
      presentation.status === 'planned'
    )
    .sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
  const scheduleId = opts.scheduleId ? String(opts.scheduleId) : '';
  if (scheduleId) {
    const assigned = plannedRows.find(presentation =>
      String(presentation.schedule_id || '') === scheduleId
    );
    if (assigned) return assigned;
  }
  return plannedRows.find(presentation =>
    isCurrentUnassignedPresentationDraft(
      presentation,
      opts.draftEpoch,
      opts.carryoverIds
    )
  ) || null;
}

function getPresentationIndustryConfigKey(
  scheduleId,
  draftEpoch = presentationDraftEpoch,
  cycleKey = null
) {
  if (scheduleId) {
    return PRESENTATION_INDUSTRY_CONFIG_PREFIX + 'schedule:' + String(scheduleId);
  }
  if (cycleKey) {
    return PRESENTATION_INDUSTRY_CONFIG_PREFIX + 'cycle:' + String(cycleKey);
  }
  const normalizedEpoch = normalizePresentationDraftEpoch(draftEpoch);
  return normalizedEpoch
    ? PRESENTATION_INDUSTRY_CONFIG_PREFIX + 'draft:' + normalizedEpoch
    : null;
}

function classifyPastScheduledPresentationRows(
  allSchedules = [],
  allPresentations = [],
  opts = {}
) {
  const today = opts.today || toDateStr(new Date());
  const orderedMembers = (opts.orderedMembers || []).filter(member => member?.id);
  if (!orderedMembers.length) {
    return { completionPatches: [], carryoverPatches: [] };
  }
  const orderedIds = orderedMembers.map(member => String(member.id));
  const pastSchedules = sortPresentationSchedules(allSchedules)
    .filter(schedule => schedule.event_date && schedule.event_date < today);
  const primaryByDate = new Map();
  pastSchedules.forEach(schedule => {
    if (!primaryByDate.has(schedule.event_date)) {
      primaryByDate.set(schedule.event_date, schedule);
    }
  });

  const completionPatches = [];
  const carryoverPatches = [];
  const processedIds = new Set();
  for (const schedule of primaryByDate.values()) {
    const cursor = inferPresentationCursor(
      allSchedules,
      allPresentations,
      orderedMembers,
      schedule.event_date,
      opts.groupSize
    );
    const take = Math.min(
      Math.max(1, Number(opts.groupSize) || PRESENTATION_GROUP_SIZE),
      orderedIds.length - cursor
    );
    const expectedIds = new Set(orderedIds.slice(cursor, cursor + take));
    const completedMembers = new Set();
    const linkedRows = (allPresentations || [])
      .filter(presentation =>
        presentation.status === 'planned' &&
        String(presentation.schedule_id || '') === String(schedule.id)
      )
      .sort((a, b) =>
        String(a.created_at || '').localeCompare(String(b.created_at || ''))
      );

    for (const presentation of linkedRows) {
      processedIds.add(String(presentation.id));
      const memberId = String(presentation.member_id || '');
      if (expectedIds.has(memberId) && !completedMembers.has(memberId)) {
        completedMembers.add(memberId);
        completionPatches.push({
          id: presentation.id,
          payload: { status: 'done' },
        });
      } else {
        carryoverPatches.push({
          id: presentation.id,
          payload: { schedule_id: null },
        });
      }
    }
  }
  const pastScheduleIds = new Set(pastSchedules.map(schedule => String(schedule.id)));
  for (const presentation of allPresentations || []) {
    if (
      presentation.status !== 'planned' ||
      !presentation.schedule_id ||
      !pastScheduleIds.has(String(presentation.schedule_id)) ||
      processedIds.has(String(presentation.id))
    ) {
      continue;
    }
    carryoverPatches.push({
      id: presentation.id,
      payload: { schedule_id: null },
    });
  }
  return { completionPatches, carryoverPatches };
}

function buildPastPresentationCompletionPatches(
  allSchedules = [],
  allPresentations = [],
  opts = {}
) {
  return classifyPastScheduledPresentationRows(
    allSchedules,
    allPresentations,
    opts
  ).completionPatches;
}

async function syncPastScheduledPresentationsDone(
  client,
  allSchedules = [],
  allPresentations = [],
  opts = {}
) {
  const classified = classifyPastScheduledPresentationRows(
    allSchedules,
    allPresentations,
    opts
  );
  const carryoverIds = classified.carryoverPatches.map(patch => patch.id);
  if (carryoverIds.length) {
    await registerPresentationDraftCarryoverIds(carryoverIds);
    const { error } = await client
      .from('presentations')
      .update({ schedule_id: null })
      .in('id', carryoverIds);
    if (error) throw error;
  }
  const patches = classified.completionPatches;
  if (patches.length) {
    const { error } = await client
      .from('presentations')
      .update({ status: 'done' })
      .in('id', patches.map(patch => patch.id));
    if (error) throw error;
  }
  return { patches, carryoverPatches: classified.carryoverPatches };
}

function normalizePresentationOrder(allMembers = [], savedOrder = []) {
  const activeMembers = (allMembers || []).filter(member =>
    member?.id && member.is_active !== false
  );
  const memberById = new Map(activeMembers.map(member => [String(member.id), member]));
  const ordered = [];
  const seen = new Set();

  for (const id of Array.isArray(savedOrder) ? savedOrder : []) {
    const key = String(id);
    if (!memberById.has(key) || seen.has(key)) continue;
    ordered.push(memberById.get(key));
    seen.add(key);
  }
  for (const member of activeMembers) {
    const key = String(member.id);
    if (seen.has(key)) continue;
    ordered.push(member);
    seen.add(key);
  }
  return ordered;
}

function sortPresentationSchedules(allSchedules = []) {
  return [...(allSchedules || [])]
    .filter(isPresentationSchedule)
    .sort((a, b) =>
      String(a.event_date || '').localeCompare(String(b.event_date || '')) ||
      String(a.event_time || '20:00:00').localeCompare(String(b.event_time || '20:00:00')) ||
      String(a.id || '').localeCompare(String(b.id || ''))
    );
}

function nextScheduleDate(dateString) {
  const date = new Date(String(dateString) + 'T12:00:00');
  date.setDate(date.getDate() + 1);
  return toDateStr(date);
}

function getLinkedSchedulePresentations(schedule, allSchedules = [], allPresentations = []) {
  if (!schedule) return [];
  const sameDayTalks = (allSchedules || []).filter(item =>
    item.event_date === schedule.event_date && isPresentationSchedule(item)
  );
  return (allPresentations || []).filter(presentation => {
    if (presentation.schedule_id) {
      return String(presentation.schedule_id) === String(schedule.id);
    }
    return presentation.presented_at === schedule.event_date &&
      sameDayTalks.length === 1 &&
      String(sameDayTalks[0].id) === String(schedule.id);
  });
}

function inferPresentationCyclePosition(
  allSchedules,
  allPresentations,
  orderedMembers,
  fromDate,
  groupSize = PRESENTATION_GROUP_SIZE
) {
  const orderedIds = (orderedMembers || []).map(member => String(member.id));
  if (!orderedIds.length) {
    return {
      cursor: 0,
      cycleMarker: 'initial',
      cycleKey: 'rotation:initial',
    };
  }

  const scheduleById = new Map(
    (allSchedules || []).map(schedule => [String(schedule.id), schedule])
  );
  const completedHistoryDates = (allPresentations || [])
    .filter(presentation =>
      presentation.status === 'done' &&
      ['industry', 'stock'].includes(presentation.category)
    )
    .map(presentation => {
      const linkedSchedule = presentation.schedule_id
        ? scheduleById.get(String(presentation.schedule_id))
        : null;
      return linkedSchedule && isPresentationSchedule(linkedSchedule)
        ? linkedSchedule.event_date
        : presentation.presented_at;
    })
    .filter(date => date && date < fromDate);
  const historyDates = [...new Set([
    ...sortPresentationSchedules(allSchedules)
      .filter(schedule => schedule.event_date < fromDate)
      .map(schedule => schedule.event_date),
    ...completedHistoryDates,
  ])].sort();

  let anchorIndex = -1;
  let cursor = 0;
  let cycleMarker = 'initial';
  const memberIdsByDate = new Map();
  for (let index = 0; index < historyDates.length; index += 1) {
    const date = historyDates[index];
    const daySchedules = (allSchedules || []).filter(schedule =>
      schedule.event_date === date && isPresentationSchedule(schedule)
    );
    const scheduleIds = new Set(daySchedules.map(schedule => String(schedule.id)));
    const memberIds = [...new Set(
      (allPresentations || [])
        .filter(presentation =>
          presentation.status === 'done' &&
          presentation.member_id &&
          (
            (presentation.schedule_id && scheduleIds.has(String(presentation.schedule_id))) ||
            (!presentation.schedule_id && presentation.presented_at === date) ||
            (
              presentation.status === 'done' &&
              presentation.presented_at === date &&
              ['industry', 'stock'].includes(presentation.category)
            )
          )
        )
        .map(presentation => String(presentation.member_id))
        .filter(memberId => orderedIds.includes(memberId))
    )];
    memberIdsByDate.set(date, memberIds);
  }

  const lastMemberId = orderedIds[orderedIds.length - 1];
  for (let index = historyDates.length - 1; index >= 0; index -= 1) {
    const memberIds = memberIdsByDate.get(historyDates[index]) || [];
    if (!memberIds.includes(lastMemberId)) continue;
    cursor = 0;
    anchorIndex = index;
    cycleMarker = historyDates[index];
    break;
  }
  // 자동 슬롯은 발표종목 행이 없어도 실제 스터디 날짜가 지나면 순서를 소비한다.
  for (let index = anchorIndex + 1; index < historyDates.length; index += 1) {
    const remainingInCycle = orderedIds.length - cursor;
    cursor += Math.min(groupSize, remainingInCycle);
    if (cursor >= orderedIds.length) {
      cursor = 0;
      cycleMarker = historyDates[index];
    }
  }
  return {
    cursor,
    cycleMarker,
    cycleKey: 'rotation:' + cycleMarker,
  };
}

function inferPresentationCursor(
  allSchedules,
  allPresentations,
  orderedMembers,
  fromDate,
  groupSize = PRESENTATION_GROUP_SIZE
) {
  return inferPresentationCyclePosition(
    allSchedules,
    allPresentations,
    orderedMembers,
    fromDate,
    groupSize
  ).cursor;
}

function getPresentationDraftCycleState(
  allSchedules = [],
  allPresentations = [],
  orderedMembers = [],
  opts = {}
) {
  const requestedFromDate = opts.fromDate || toDateStr(new Date());
  const plan = buildPresentationSchedulePlan(
    allSchedules,
    allPresentations,
    orderedMembers,
    { ...opts, fromDate: requestedFromDate }
  );
  return inferPresentationCyclePosition(
    allSchedules,
    allPresentations,
    orderedMembers,
    plan.fromDate || requestedFromDate,
    Math.max(1, Number(opts.groupSize) || PRESENTATION_GROUP_SIZE)
  );
}

function shouldCarryPresentationDraftToNextCycle(
  memberId,
  allSchedules = [],
  allPresentations = [],
  orderedMembers = [],
  opts = {}
) {
  const orderedIds = (orderedMembers || []).map(member => String(member.id));
  const memberIndex = orderedIds.indexOf(String(memberId || ''));
  if (memberIndex < 0) return false;
  const position = getPresentationDraftCycleState(
    allSchedules,
    allPresentations,
    orderedMembers,
    opts
  );
  return position.cursor > 0 && memberIndex < position.cursor;
}

function buildPresentationSchedulePlan(
  allSchedules = [],
  allPresentations = [],
  orderedMembers = [],
  opts = {}
) {
  const requestedFromDate = opts.fromDate || toDateStr(new Date());
  const groupSize = Math.max(1, Number(opts.groupSize) || PRESENTATION_GROUP_SIZE);
  const ordered = (orderedMembers || []).filter(member => member?.id);
  const orderedIds = ordered.map(member => String(member.id));
  const requestedDaySchedules = sortPresentationSchedules(allSchedules).filter(schedule =>
    schedule.event_date === requestedFromDate && isPresentationSchedule(schedule)
  );
  const requestedDayPrimary = requestedDaySchedules[0] || null;
  const requestedDayCursor = inferPresentationCursor(
    allSchedules,
    allPresentations,
    ordered,
    requestedFromDate,
    groupSize
  );
  const requestedDayTake = orderedIds.length
    ? Math.min(groupSize, orderedIds.length - requestedDayCursor)
    : 0;
  const requestedDayMemberIds = orderedIds.slice(
    requestedDayCursor,
    requestedDayCursor + requestedDayTake
  );
  const requestedDayRows = requestedDayPrimary
    ? getLinkedSchedulePresentations(
        requestedDayPrimary,
        allSchedules,
        allPresentations
      )
    : (allPresentations || []).filter(presentation =>
        presentation.presented_at === requestedFromDate &&
        presentation.status === 'done' &&
        ['industry', 'stock'].includes(presentation.category)
      );
  const doneMemberIds = new Set(
    requestedDayRows
      .filter(presentation => presentation.status === 'done')
      .map(presentation => String(presentation.member_id))
  );
  const todayIsComplete = (requestedDayPrimary || requestedDayRows.length > 0) &&
    requestedDayMemberIds.length > 0 &&
    requestedDayMemberIds.every(memberId => doneMemberIds.has(memberId));
  const fromDate = todayIsComplete
    ? nextScheduleDate(requestedFromDate)
    : requestedFromDate;
  let cursor = inferPresentationCursor(
    allSchedules,
    allPresentations,
    ordered,
    fromDate,
    groupSize
  );

  const futureSchedules = sortPresentationSchedules(allSchedules)
    .filter(schedule => schedule.event_date >= fromDate);
  const primaryByDate = new Map();
  for (const schedule of futureSchedules) {
    if (!primaryByDate.has(schedule.event_date)) {
      primaryByDate.set(schedule.event_date, schedule);
    }
  }

  const items = [];
  for (const schedule of primaryByDate.values()) {
    if (!orderedIds.length) {
      items.push({ schedule, memberIds: [], members: [], cycleEnds: false });
      continue;
    }

    const remainingInCycle = orderedIds.length - cursor;
    const take = Math.min(groupSize, remainingInCycle);
    const memberIds = orderedIds.slice(cursor, cursor + take);
    const memberSet = new Set(memberIds);
    const assignedMembers = ordered.filter(member => memberSet.has(String(member.id)));
    cursor += take;
    const cycleEnds = cursor >= orderedIds.length;
    if (cycleEnds) cursor = 0;

    items.push({
      schedule,
      memberIds,
      members: assignedMembers,
      cycleEnds,
    });
  }

  const previewTake = orderedIds.length
    ? Math.min(groupSize, orderedIds.length - cursor)
    : 0;
  const previewMemberIds = orderedIds.slice(cursor, cursor + previewTake);
  const firstItem = items[0] || null;

  return {
    requestedFromDate,
    fromDate,
    groupSize,
    orderedMembers: ordered,
    items,
    byScheduleId: new Map(items.map(item => [String(item.schedule.id), item])),
    nextSchedule: firstItem?.schedule || null,
    nextMemberIds: firstItem?.memberIds || previewMemberIds,
    nextMembers: firstItem?.members ||
      ordered.filter(member => previewMemberIds.includes(String(member.id))),
  };
}

function getEffectiveScheduleRoster(
  schedule,
  allSchedules = [],
  allPresentations = [],
  orderedMembers = [],
  plan = null
) {
  const actualRows = getLinkedSchedulePresentations(
    schedule,
    allSchedules,
    allPresentations
  );
  const orderIndex = new Map(
    (orderedMembers || []).map((member, index) => [String(member.id), index])
  );
  const sortRows = rows => [...rows].sort((a, b) =>
    (orderIndex.get(String(a.member_id)) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(String(b.member_id)) ?? Number.MAX_SAFE_INTEGER) ||
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
  );

  if (!isPresentationSchedule(schedule) || !plan) return sortRows(actualRows);
  const planItem = plan.byScheduleId instanceof Map
    ? plan.byScheduleId.get(String(schedule.id))
    : (plan.items || []).find(item => String(item.schedule?.id) === String(schedule.id));
  if (!planItem) {
    const displayFromDate = plan.requestedFromDate || plan.fromDate;
    return sortRows(
      schedule.event_date >= displayFromDate
        ? actualRows.filter(row => row.status === 'done')
        : actualRows
    );
  }

  const actualByMember = new Map();
  for (const row of actualRows) {
    const key = String(row.member_id || '');
    if (key && !actualByMember.has(key)) actualByMember.set(key, row);
  }
  const memberById = new Map(
    (orderedMembers || []).map(member => [String(member.id), member])
  );

  const expectedRows = planItem.memberIds.map((memberId, index) => {
    const actual = actualByMember.get(String(memberId));
    if (actual) {
      return { ...actual, _isAutoScheduled: true, _autoOrder: index };
    }
    const member = memberById.get(String(memberId));
    return {
      id: `auto-slot:${schedule.id}:${memberId}`,
      schedule_id: schedule.id,
      member_id: memberId,
      category: schedule.category,
      topic: null,
      presented_at: schedule.event_date,
      status: 'planned',
      members: member ? { name: member.name } : null,
      _isAutoSlot: true,
      _isAutoScheduled: true,
      _autoOrder: index,
    };
  });
  const expectedIds = new Set(planItem.memberIds.map(String));
  const extras = actualRows.filter(row =>
    !expectedIds.has(String(row.member_id)) &&
    (row.status === 'done' || schedule.event_date < plan.fromDate)
  );
  return [...expectedRows, ...sortRows(extras)];
}

function getPlanItemDoneMemberIds(
  item,
  allSchedules = [],
  allPresentations = []
) {
  if (!item?.schedule) return new Set();
  return new Set(
    getLinkedSchedulePresentations(
      item.schedule,
      allSchedules,
      allPresentations
    )
      .filter(presentation => presentation.status === 'done')
      .map(presentation => String(presentation.member_id))
  );
}

function getNextPresentationInputPlanItem(
  plan,
  memberId,
  allSchedules = [],
  allPresentations = []
) {
  const memberKey = String(memberId);
  return (plan?.items || []).find(item => {
    if (!(item.memberIds || []).map(String).includes(memberKey)) return false;
    return !getPlanItemDoneMemberIds(
      item,
      allSchedules,
      allPresentations
    ).has(memberKey);
  }) || null;
}

function buildPresentationAssignmentPatches(
  allSchedules = [],
  allPresentations = [],
  plan,
  opts = {}
) {
  const fromDate = opts.fromDate || plan?.fromDate || toDateStr(new Date());
  const draftEpoch = opts.draftEpoch || presentationDraftEpoch;
  const draftCarryoverIds = opts.draftCarryoverIds ||
    presentationDraftCarryoverIds;
  const normalizedDraftCarryoverIds = normalizePresentationDraftIds(
    draftCarryoverIds
  );
  if (!plan?.items?.length) return [];
  const scheduleById = new Map(
    (allSchedules || []).map(schedule => [String(schedule.id), schedule])
  );
  const targetsByMember = new Map();
  for (const item of plan?.items || []) {
    const doneMemberIds = getPlanItemDoneMemberIds(
      item,
      allSchedules,
      allPresentations
    );
    for (const memberId of item.memberIds || []) {
      const key = String(memberId);
      if (doneMemberIds.has(key)) continue;
      if (!targetsByMember.has(key)) targetsByMember.set(key, []);
      targetsByMember.get(key).push(item.schedule);
    }
  }

  const eligibleRows = (allPresentations || []).filter(presentation => {
    if (presentation.status !== 'planned' || !presentation.member_id) return false;
    if (!presentation.schedule_id) {
      const isCurrentDraft = isCurrentUnassignedPresentationDraft(
        presentation,
        draftEpoch,
        normalizedDraftCarryoverIds
      );
      if (draftEpoch && !isCurrentDraft) {
        return false;
      }
      return (
        isCurrentDraft ||
        normalizedDraftCarryoverIds.has(String(presentation.id || '')) ||
        !presentation.presented_at ||
        presentation.presented_at >= fromDate
      );
    }
    const schedule = scheduleById.get(String(presentation.schedule_id));
    if (schedule && !isPresentationSchedule(schedule)) return true;
    const assignedDate = schedule?.event_date || presentation.presented_at || '';
    return assignedDate >= fromDate;
  });
  const rowsByMember = new Map();
  for (const row of eligibleRows) {
    const key = String(row.member_id);
    if (!rowsByMember.has(key)) rowsByMember.set(key, []);
    rowsByMember.get(key).push(row);
  }

  const patches = [];
  for (const [memberId, rows] of rowsByMember) {
    const targets = [...(targetsByMember.get(memberId) || [])];
    const remainingRows = [...rows].sort((a, b) => {
      const aSchedule = scheduleById.get(String(a.schedule_id || ''));
      const bSchedule = scheduleById.get(String(b.schedule_id || ''));
      // 회식 전환·일정 삭제로 막 해제된 행은 기존 후속 회차보다 먼저 배정한다.
      const aDate = aSchedule?.event_date || a.presented_at || '0000-01-01';
      const bDate = bSchedule?.event_date || b.presented_at || '0000-01-01';
      return aDate.localeCompare(bDate) ||
        String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    const matches = [];

    // 이미 올바른 회차에 연결된 행은 그대로 보존한다.
    for (let targetIndex = targets.length - 1; targetIndex >= 0; targetIndex -= 1) {
      const target = targets[targetIndex];
      const rowIndex = remainingRows.findIndex(row =>
        String(row.schedule_id || '') === String(target.id)
      );
      if (rowIndex < 0) continue;
      matches.push({ row: remainingRows.splice(rowIndex, 1)[0], target });
      targets.splice(targetIndex, 1);
    }

    // 나머지 발표 콘텐츠와 자동 회차를 시간순으로 1:1 매칭한다.
    while (remainingRows.length && targets.length) {
      matches.push({
        row: remainingRows.shift(),
        target: targets.shift(),
      });
    }

    for (const { row, target } of matches) {
      const payload = {
        schedule_id: target.id,
        presented_at: target.event_date,
      };
      if (
        String(row.schedule_id || '') !== String(target.id) ||
        row.presented_at !== target.event_date
      ) {
        patches.push({ id: row.id, payload });
      }
    }

    // 회식·기타 일정은 다음 발표 일정이 생길 때까지 carry anchor로 보존한다.
    // 발표 일정에 남은 overflow는 과거 날짜에 잘못 완료되지 않도록 연결을
    // 해제하고, 실제 쓰기 전에 carryover ID로 별도 보존한다. presented_at은
    // 운영 DB의 필수 컬럼이므로 기존 값을 유지한다.
    for (const row of remainingRows) {
      const linkedSchedule = scheduleById.get(String(row.schedule_id || ''));
      if (linkedSchedule && !isPresentationSchedule(linkedSchedule)) continue;
      if (row.schedule_id) {
        patches.push({
          id: row.id,
          payload: { schedule_id: null },
        });
      }
    }
  }
  return patches;
}

async function syncPlannedPresentationsToSchedulePlan(
  client,
  allSchedules,
  allPresentations,
  orderedMembers,
  opts = {}
) {
  if (
    !Array.isArray(allSchedules) ||
    !allSchedules.length ||
    !Array.isArray(allPresentations) ||
    !Array.isArray(orderedMembers) ||
    !orderedMembers.length
  ) {
    return {
      plan: buildPresentationSchedulePlan(
        allSchedules || [],
        allPresentations || [],
        orderedMembers || [],
        opts
      ),
      patches: [],
      skipped: 'incomplete-data',
    };
  }
  const plan = buildPresentationSchedulePlan(
    allSchedules,
    allPresentations,
    orderedMembers,
    opts
  );
  const patches = buildPresentationAssignmentPatches(
    allSchedules,
    allPresentations,
    plan,
    opts
  );
  const carryoverIds = patches
    .filter(patch => patch.payload?.schedule_id === null)
    .map(patch => patch.id);
  if (carryoverIds.length) {
    await registerPresentationDraftCarryoverIds(carryoverIds);
  }
  const originals = new Map(
    (allPresentations || []).map(presentation => [
      String(presentation.id),
      {
        schedule_id: presentation.schedule_id || null,
        presented_at: presentation.presented_at || null,
      },
    ])
  );
  const applied = [];
  try {
    for (const patch of patches) {
      const { error } = await client
        .from('presentations')
        .update(patch.payload)
        .eq('id', patch.id);
      if (error) throw error;
      applied.push(patch);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const patch of applied.reverse()) {
      const original = originals.get(String(patch.id));
      if (!original) continue;
      try {
        const { error: rollbackError } = await client
          .from('presentations')
          .update(original)
          .eq('id', patch.id);
        if (rollbackError) rollbackErrors.push(rollbackError);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      const recoveryError = new Error(
        '발표 일정 자동 조정과 원상 복구에 실패했습니다. 연결 상태를 다시 확인해 주세요.'
      );
      recoveryError.cause = error;
      recoveryError.rollbackErrors = rollbackErrors;
      throw recoveryError;
    }
    throw error;
  }
  return { plan, patches };
}

function getPresentationTurnState(allPresentations, orderedMembers, opts = {}) {
  const ordered = (orderedMembers || []).filter(Boolean);
  const orderedIds = ordered.map(m => m.id);
  const total = orderedIds.length;
  let category = 'industry';
  const doneInCycle = new Set();
  let completedCycleCount = 0;
  let lastCompletedCycleMarker = 'initial';

  const talks = (allPresentations || [])
    .filter(p => {
      if (!p.member_id || !p.presented_at || !['industry', 'stock'].includes(p.category)) return false;
      if (p.status === 'done') return true;
      return !!opts.includePlanned && p.status === 'planned' && !!p.schedule_id;
    })
    .filter(p => !opts.untilDate || p.presented_at <= opts.untilDate)
    .sort((a, b) =>
      String(a.presented_at || '').localeCompare(String(b.presented_at || '')) ||
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
    );

  talks.forEach(p => {
    if (!total || !orderedIds.includes(p.member_id)) return;

    if (p.category !== category) {
      if (doneInCycle.size === 0) category = p.category;
      else return;
    }

    doneInCycle.add(p.member_id);
    if (doneInCycle.size >= total) {
      completedCycleCount += 1;
      lastCompletedCycleMarker = [
        p.presented_at || '',
        p.id || p.created_at || p.member_id,
      ].join(':');
      category = category === 'industry' ? 'stock' : 'industry';
      doneInCycle.clear();
    }
  });

  const pending = ordered.filter(m => !doneInCycle.has(m.id));
  return {
    category,
    label: CAT_LABEL[category] || category,
    completedCount: doneInCycle.size,
    total,
    pendingMembers: pending,
    nextMember: pending[0] || ordered[0] || null,
    cycleKey: [
      category,
      completedCycleCount,
      lastCompletedCycleMarker,
    ].join(':'),
  };
}

// ── 공통 데이터 로드 (schedules + members + presentations 동시 조회)
async function loadSharedData() {
  const [s, m, p] = await Promise.all([
    fetchSchedules({ strict: true }),
    fetchMembers({ strict: true }),
    reloadPresentations({ strict: true })
  ]);
  schedules     = s;
  members       = m;
  presentations = p;
}

async function syncLoadedPastPresentations(orderedMembers) {
  const result = await syncPastScheduledPresentationsDone(
    sb,
    schedules,
    presentations,
    { orderedMembers }
  );
  if (result.patches.length || result.carryoverPatches.length) {
    presentations = await reloadPresentations({ strict: true });
  }
  return result;
}

async function reloadPresentations(opts = {}) {
  const { data, error } = await sb.from('presentations')
    .select('*, members(name)')
    .order('created_at');
  if (error) {
    if (opts.strict) throw error;
    console.error('reloadPresentations:', error);
    return [];
  }
  presentations = data || [];
  return presentations;
}

function refreshPresentationScheduleViews() {
  if (typeof renderMemberPresPanel === 'function') renderMemberPresPanel();
  if (typeof updatePanelGuide === 'function') updatePanelGuide();
}

// ── 탭 버튼 전환 헬퍼 (app.html iframe 또는 직접 이동)
function goToSchedulePage(pageName) {
  if (window.parent && window.parent.loadPage) {
    window.parent.loadPage(pageName);
  } else {
    const [page, query = ''] = String(pageName).split('?');
    location.href = page + '.html' + (query ? '?' + query : '');
  }
}
