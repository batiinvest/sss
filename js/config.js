// ============================================================
// js/config.js  v20260426
// ⚠️  SUPABASE_URL · SUPABASE_ANON 만 수정하세요
// ============================================================

// ── Supabase 연결 정보
const SUPABASE_URL  = 'https://xqqrxmxjvvzxcfxmqfks.supabase.co';
const SUPABASE_ANON = 'sb_publishable_M6XoN8lfV6_KEZ72yQ8OQQ_8tqo_nx2';

// ── 펀드 설정
const BASE_AMOUNT = 500_000;   // 1인당 초기 기준금액 (원)

// ── 관리자 이메일 목록
const ADMIN_EMAILS = [
  'batiinvestment@gmail.com',  // 김정훈
];

// ── GitHub 저장소 (현재가 갱신 Actions용) ← 버그 수정
window.GH_REPO = 'batiinvestment/SSS';

// ── Supabase 클라이언트 초기화
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── 공통 유틸리티
const won  = (n) => n != null ? Number(n).toLocaleString('ko-KR') + '원' : '-';
const pct  = (n, d = 1) => n != null ? (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(d) + '%' : '-';
const rCls = (n) => n == null ? '' : Number(n) >= 0 ? 'up' : 'dn';
const avCls = ['av1', 'av2', 'av3', 'av4', 'av1', 'av2'];

// ── 날짜 포맷 (타임스탬프 문자열 또는 Date → 표시용 문자열)
// fmtDate('2025-04-15T10:30:00') → '2025.4.15'
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return String(ts).slice(0, 10).replace(/-/g, '.');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// fmtDateTime('2025-04-15T10:30:00') → '2025.4.15 10:30'
function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return String(ts).slice(0, 16).replace('T', ' ');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 상태 뱃지 HTML 반환
// statusBadge('hold') → '<span class="badge b-hold">보유중</span>'
function statusBadge(status) {
  const map = {
    hold:     ['b-hold',  '보유중'],
    sold:     ['b-sold',  '매도완료'],
    buy:      ['b-buy',   '매수'],
    sell:     ['b-sell',  '매도'],
    planned:  ['b-warn',  '예정'],
    done:     ['b-sold',  '완료'],
    regular:  ['b-hold',  '정기'],
    extra:    ['b-dn',    '추가'],
  };
  const [cls, label] = map[status] || ['b-hold', status || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function toast(msg, ms = 2500) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// ── DB 연결 상태 배너
async function checkDBConnection() {
  const banner = document.getElementById('db-banner');
  if (!banner) return;
  if (SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
    banner.className = 'db-banner error';
    banner.innerHTML = '❌ <strong>DB 미연결</strong> — js/config.js 에서 SUPABASE_URL 과 SUPABASE_ANON 을 설정하세요.';
    return;
  }
  banner.className = 'db-banner pending';
  banner.textContent = 'DB 연결 확인 중...';
  try {
    const { error } = await sb.from('members').select('id').limit(1);
    if (error) throw error;
    banner.className = 'db-banner ok';
    banner.innerHTML = '✅ DB 연결됨';
    setTimeout(() => { banner.style.display = 'none'; }, 3000);
  } catch (e) {
    banner.className = 'db-banner error';
    banner.innerHTML = 'DB 연결 실패: ' + e.message;
  }
}

// ── 인증
async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function requireAuth() {
  const session = await getSession();
  if (!session) showAuthOverlay();
  return session;
}

function showAuthOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.id = 'auth-overlay';
  overlay.innerHTML =
    '<div class="auth-box">' +
      '<div class="auth-title">투자 스터디 로그인</div>' +
      '<div class="form-section">' +
        '<div class="form-group"><label>아이디</label>' +
          '<input type="text" id="auth-id" placeholder="아이디 입력"' +
          ' onkeydown="if(event.key===\'Enter\') document.getElementById(\'auth-pw\').focus()" /></div>' +
        '<div class="form-group"><label>비밀번호</label>' +
          '<input type="password" id="auth-pw" placeholder="비밀번호"' +
          ' onkeydown="if(event.key===\'Enter\') doLogin()" /></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:4px;" onclick="doLogin()">로그인</button>' +
        '<div id="auth-err" style="font-size:12px;color:#a32d2d;text-align:center;min-height:16px;margin-top:8px;"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('auth-id')?.focus(), 100);
}

async function doLogin() {
  const userId = (document.getElementById('auth-id')?.value || '').trim();
  const pw     = document.getElementById('auth-pw')?.value || '';
  const errEl  = document.getElementById('auth-err');
  if (!userId || !pw) { errEl.textContent = '아이디와 비밀번호를 입력하세요.'; return; }
  const email = userId.includes('@') ? userId : userId + '@study.local';
  errEl.textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) {
    errEl.textContent = '아이디 또는 비밀번호가 올바르지 않습니다.';
  } else {
    document.getElementById('auth-overlay')?.remove();
    location.reload();
  }
}

async function doLogout() {
  await sb.auth.signOut();
  location.href = 'index.html';
}

// ── 관리자 확인
async function isAdmin() {
  const { data } = await sb.auth.getSession();
  const email = data?.session?.user?.email || '';
  return ADMIN_EMAILS.includes(email);
}

// ── 현재 로그인 멤버 (세션 내 캐싱)
let _currentMember = undefined;

async function getCurrentMember() {
  if (_currentMember !== undefined) return _currentMember;
  const { data } = await sb.auth.getSession();
  const email = data?.session?.user?.email;
  if (!email) { _currentMember = null; return null; }

  // 1차: 이메일 직접 조회
  let { data: member } = await sb.from('members').select('*').eq('email', email).maybeSingle();

  // 2차: @study.local 형식 처리
  if (!member && email.endsWith('@study.local')) {
    const userId = email.replace('@study.local', '');
    const { data: m2 } = await sb.from('members').select('*').ilike('email', userId + '@%').maybeSingle();
    member = m2;
  }

  _currentMember = member || null;
  return _currentMember;
}

// ── 사이드바 권한 제어 + 미니 프로필 카드
async function initSidebarAuth() {
  try {
    const [admin, me] = await Promise.all([isAdmin(), getCurrentMember()]);

    // 관리자 메뉴 토글
    document.getElementById('nav-admin')?.classList.toggle('visible', admin);

    // 미니 프로필 카드
    const card = document.getElementById('sideProfile');
    if (!card || !me) return;
    card.style.display = 'block';

    document.getElementById('sideAvatar').textContent = me.name.slice(0, 2);
    document.getElementById('sideName').textContent   = me.name;

    const retRate = ((me.base_amount - BASE_AMOUNT) / BASE_AMOUNT * 100).toFixed(1);
    document.getElementById('sideBase').textContent   = Math.round(me.base_amount / 10000) + '만원';
    document.getElementById('sideReturn').textContent = (retRate >= 0 ? '+' : '') + retRate + '%';
    document.getElementById('sideReturn').style.color = retRate >= 0 ? '#0f6e56' : '#a32d2d';

    // 투자금 / 잔액
    const { data: trades } = await sb.from('trades').select('trade_type,price,quantity').eq('member_id', me.id);
    const bought   = (trades || []).filter(t => t.trade_type === 'buy').reduce((s, t) => s + t.price * t.quantity, 0);
    const sold     = (trades || []).filter(t => t.trade_type === 'sell').reduce((s, t) => s + t.price * t.quantity, 0);
    const invested = bought - sold;
    const cash     = (me.base_amount || 0) - invested;

    document.getElementById('sideInvested').textContent = Math.round(invested / 10000) + '만원';
    document.getElementById('sideCash').textContent     = Math.round(cash / 10000) + '만원';
    document.getElementById('sideCash').style.color     = cash < 0 ? '#a32d2d' : '';
  } catch (e) {
    console.warn('initSidebarAuth 오류:', e.message);
  }
}

// ── 햄버거 메뉴 (모바일)
(function () {
  function setup() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const btn = document.createElement('button');
    btn.className = 'hamburger';
    btn.setAttribute('aria-label', '메뉴');
    btn.innerHTML = '<span></span><span></span><span></span>';
    sidebar.appendChild(btn);

    btn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('nav-open');
      btn.classList.toggle('open', open);
    });
    sidebar.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        sidebar.classList.remove('nav-open');
        btn.classList.remove('open');
      });
    });
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target)) {
        sidebar.classList.remove('nav-open');
        btn.classList.remove('open');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (session) {
      _currentMember = undefined;
      initSidebarAuth();
    }
  });
})();
