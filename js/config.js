// ============================================================
// js/config.js
// ============================================================
// ⚠️ 아래 두 값을 Supabase 대시보드 > Settings > API 에서 복사
// ── 펀드 설정
const BASE_AMOUNT = 500000;    // 1인당 초기 기준금액 (원) — 변경 시 여기만 수정

// 관리자 이메일 목록 — 사용자 관리(추가/수정/탈퇴) 권한
// 로그인 시 사용하는 이메일 또는 "아이디@study.local" 형식
const ADMIN_EMAILS = [
  'batiinvestment@gmail.com',  // 김정훈
];

// 현재 로그인 유저가 관리자인지 확인
async function isAdmin() {
  const { data } = await sb.auth.getSession();
  const email = data?.session?.user?.email || '';
  return ADMIN_EMAILS.includes(email);
}

// 현재 로그인 유저의 member 정보 조회 (캐싱)
let _currentMember = undefined;
async function getCurrentMember() {
  if (_currentMember !== undefined) return _currentMember;
  const { data } = await sb.auth.getSession();
  const email = data?.session?.user?.email;
  if (!email) { _currentMember = null; return null; }
  const { data: member } = await sb.from('members')
    .select('*').eq('email', email).maybeSingle();
  _currentMember = member || null;
  return _currentMember;
}

const SUPABASE_URL  = 'https://xqqrxmxjvvzxcfxmqfks.supabase.co';
const SUPABASE_ANON = 'sb_publishable_M6XoN8lfV6_KEZ72yQ8OQQ_8tqo_nx2';


const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── 공통 유틸
const won  = n => n != null ? Number(n).toLocaleString('ko-KR') + '원' : '-';
const pct  = (n, d=1) => n != null ? (Number(n)>=0?'+':'')+Number(n).toFixed(d)+'%' : '-';
const rCls = n => n == null ? '' : Number(n) >= 0 ? 'up' : 'dn';
const avCls = ['av1','av2','av3','av4','av1','av2'];

function toast(msg, ms=2500) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id='toast'; el.className='toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

// ── GitHub Actions 트리거 설정
// ⚠️ 아래 GH_REPO만 본인 저장소로 변경 (PAT는 홈페이지에서 입력)
window.GH_REPO = 'batiinvest/sss';  // 예: kjhofone/fund-study

// ── DB 연결 상태 확인
async function checkDBConnection() {
  const banner = document.getElementById('db-banner');
  if (!banner) return;
  if (SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
    banner.className = 'db-banner error';
    banner.innerHTML = '❌ <strong>DB 미연결</strong> — js/config.js에서 SUPABASE_URL과 SUPABASE_ANON을 설정하세요.';
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
  } catch(e) {
    banner.className = 'db-banner error';
    banner.innerHTML = `❌ DB 연결 실패: ${e.message}`;
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
  overlay.innerHTML = `
    <div class="auth-box">
      <div class="auth-title">투자 스터디 로그인</div>
      <div class="form-section">
        <div class="form-group"><label>아이디</label>
          <input type="text" id="auth-id" placeholder="아이디 입력"
            onkeydown="if(event.key==='Enter')document.getElementById('auth-pw').focus()" /></div>
        <div class="form-group"><label>비밀번호</label>
          <input type="password" id="auth-pw" placeholder="비밀번호"
            onkeydown="if(event.key==='Enter')doLogin()" /></div>
        <button class="btn btn-primary" style="width:100%;margin-top:4px;" onclick="doLogin()">로그인</button>
        <div id="auth-err" style="font-size:12px;color:#a32d2d;text-align:center;min-height:16px;margin-top:8px;"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('auth-id')?.focus(), 100);
}
async function doLogin() {
  const userId = (document.getElementById('auth-id')?.value || '').trim();
  const pw     = (document.getElementById('auth-pw')?.value || '');
  const errEl  = document.getElementById('auth-err');
  if (!userId || !pw) { errEl.textContent = '아이디와 비밀번호를 입력하세요.'; return; }

  // 아이디를 이메일 형식으로 변환 (아이디@study.local)
  const email = userId.includes('@') ? userId : `${userId}@study.local`;

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


// ── 사이드바 권한별 표시 + 미니 프로필 카드
async function initSidebarAuth() {
  try {
    const [admin, me] = await Promise.all([isAdmin(), getCurrentMember()]);

    // 관리자 메뉴 표시
    const adminEl = document.getElementById('nav-admin');
    if (adminEl) {
      admin ? adminEl.classList.add('visible') : adminEl.classList.remove('visible');
    }

    // 미니 프로필 카드
    const card = document.getElementById('sideProfile');
    if (!card || !me) return;

    card.style.display = 'block';

    // 아바타 + 이름
    const avCls = ['av1','av2','av3','av4','av1','av2'];
    document.getElementById('sideAvatar').textContent  = me.name.slice(0, 2);
    document.getElementById('sideName').textContent    = me.name;

    // 기준금액 / 수익률
    const initBase  = typeof BASE_AMOUNT !== 'undefined' ? BASE_AMOUNT : 500000;
    const retRate   = ((me.base_amount - initBase) / initBase * 100).toFixed(1);
    const retSign   = retRate >= 0 ? '+' : '';
    const retCls    = retRate >= 0 ? '#0f6e56' : '#a32d2d';
    document.getElementById('sideBase').textContent   = Math.round(me.base_amount / 10000) + '만원';
    document.getElementById('sideReturn').textContent = retSign + retRate + '%';
    document.getElementById('sideReturn').style.color = retCls;

    // 투자금 / 잔액 (trades 조회)
    const { data: trades } = await sb.from('trades')
      .select('trade_type,price,quantity').eq('member_id', me.id);
    const bought   = (trades||[]).filter(t => t.trade_type === 'buy')
      .reduce((s,t) => s + t.price * t.quantity, 0);
    const sold     = (trades||[]).filter(t => t.trade_type === 'sell')
      .reduce((s,t) => s + t.price * t.quantity, 0);
    const invested = bought - sold;
    const cash     = (me.base_amount || 0) - invested;

    document.getElementById('sideInvested').textContent = Math.round(invested / 10000) + '만원';
    document.getElementById('sideCash').textContent     = Math.round(cash / 10000) + '만원';
    document.getElementById('sideCash').style.color     = cash < 0 ? '#a32d2d' : '';

  } catch(e) {
    console.warn('initSidebarAuth 오류:', e.message);
  }
}

// ── 햄버거 메뉴 (모바일)
(function() {
  function initHamburger() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // 햄버거 버튼 생성
    const btn = document.createElement('button');
    btn.className = 'hamburger';
    btn.setAttribute('aria-label', '메뉴');
    btn.innerHTML = '<span></span><span></span><span></span>';
    sidebar.appendChild(btn);

    btn.addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('nav-open');
      btn.classList.toggle('open', isOpen);
    });

    // 메뉴 항목 클릭 시 드로어 닫기
    sidebar.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        sidebar.classList.remove('nav-open');
        btn.classList.remove('open');
      });
    });

    // 외부 클릭 시 드로어 닫기
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target)) {
        sidebar.classList.remove('nav-open');
        btn.classList.remove('open');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initHamburger(); initSidebarAuth(); });
  } else {
    initHamburger();
    initSidebarAuth();
  }
})();
