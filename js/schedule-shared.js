// ============================================================
// js/schedule-shared.js  v20260427
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

let dragSrcMemberId   = null;
let dragSrcScheduleId = null;
let dragSrcPresId     = null;
let editingScheduleId = null;

// ── 공통 상수
const CAT_LABEL = { industry: '산업 분석', stock: '종목 분석', dinner: '회식', other: '기타' };
const CAT_CLASS = { industry: 'ev-meeting', stock: 'ev-deadline', dinner: 'ev-dinner', other: 'ev-other' };
const MONTH_KR  = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

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
  await repairKnownScheduleData();
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
  if (typeof renderPresOrderCalendar === 'function') renderPresOrderCalendar();
  if (typeof renderPresScheduleList === 'function') renderPresScheduleList();
  if (typeof renderMemberPresPanel === 'function') renderMemberPresPanel();
  if (typeof updatePanelGuide === 'function') updatePanelGuide();
}

async function repairKnownScheduleData() {
  const target = schedules.find(s => s.event_date === '2026-06-01' && s.category === 'industry');
  if (!target) return;

  const schedulePatch = { category: 'stock' };
  if (!target.title || target.title.includes('산업')) schedulePatch.title = '종목 분석';

  const { error } = await sb.from('schedules').update(schedulePatch).eq('id', target.id);
  if (error) {
    console.warn('schedule repair skipped:', error.message);
    return;
  }

  await sb.from('presentations').update({ category: 'stock' }).eq('schedule_id', target.id);
  Object.assign(target, schedulePatch);
  presentations = presentations.map(p =>
    p.schedule_id === target.id ? { ...p, category: 'stock' } : p
  );
}

// ── 탭 버튼 전환 헬퍼 (app.html iframe 또는 직접 이동)
function goToSchedulePage(pageName) {
  if (window.parent && window.parent.loadPage) {
    window.parent.loadPage(pageName);
  } else {
    location.href = pageName + '.html';
  }
}
