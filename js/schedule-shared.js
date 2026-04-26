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

// ── 공통 데이터 로드 (schedules + members + presentations 동시 조회)
async function loadSharedData() {
  const [s, m, p] = await Promise.all([
    fetchSchedules(),
    fetchMembers(),
    sb.from('presentations').select('*, members(name)').order('created_at').then(r => r.data || [])
  ]);
  schedules     = s;
  members       = m;
  presentations = p;
}

// ── 탭 버튼 전환 헬퍼 (app.html iframe 또는 직접 이동)
function goToSchedulePage(pageName) {
  if (window.parent && window.parent.loadPage) {
    window.parent.loadPage(pageName);
  } else {
    location.href = pageName + '.html';
  }
}
