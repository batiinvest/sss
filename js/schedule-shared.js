// ============================================================
// js/schedule-shared.js  v20260724
// schedule-calendar.html + schedule-order.html 공통 모듈
// ============================================================

// ── 타임존 안전한 날짜 문자열
function toDateStr(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

// ── 공통 전역 변수
let schedules     = [];
let members       = [];
let presentations = [];

let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-indexed

let editingScheduleId = null;

// ── 공통 상수
const CAT_LABEL = { industry: '산업 분석', stock: '종목 분석', dinner: '회식', other: '기타' };
const CAT_CLASS = { industry: 'ev-meeting', stock: 'ev-deadline', dinner: 'ev-dinner', other: 'ev-other' };
const MONTH_KR  = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const PRESENTATION_GROUP_SIZE = 3;

function isPresentationSchedule(schedule) {
  return !!schedule && ['industry', 'stock'].includes(schedule.category);
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

function inferPresentationCursor(
  allSchedules,
  allPresentations,
  orderedMembers,
  fromDate,
  groupSize = PRESENTATION_GROUP_SIZE
) {
  const orderedIds = (orderedMembers || []).map(member => String(member.id));
  if (!orderedIds.length) return 0;

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
    break;
  }
  // 자동 슬롯은 발표종목 행이 없어도 실제 스터디 날짜가 지나면 순서를 소비한다.
  for (let index = anchorIndex + 1; index < historyDates.length; index += 1) {
    const remainingInCycle = orderedIds.length - cursor;
    cursor += Math.min(groupSize, remainingInCycle);
    if (cursor >= orderedIds.length) cursor = 0;
  }
  return cursor;
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
      return !presentation.presented_at || presentation.presented_at >= fromDate;
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

    // 자동 계획 범위를 벗어난 예정 발표는 내용은 보존하고 날짜 연결만 해제한다.
    // 다음 스터디가 등록되면 이 행이 새 자동 슬롯에 다시 연결된다.
    for (const row of remainingRows) {
      if (row.schedule_id || row.presented_at) {
        patches.push({
          id: row.id,
          payload: { schedule_id: null, presented_at: null },
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
  };
}

// ── 공통 데이터 로드 (schedules + members + presentations 동시 조회)
async function loadSharedData() {
  const [s, m, p] = await Promise.all([
    fetchSchedules(),
    fetchMembers(),
    reloadPresentations()
  ]);
  schedules     = s;
  members       = m;
  presentations = p;
}

async function reloadPresentations() {
  const { data, error } = await sb.from('presentations')
    .select('*, members(name)')
    .order('created_at');
  if (error) {
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
