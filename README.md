# 투자 스터디 펀드 — 전체 세팅 가이드

## 📁 파일 구조 (GitHub에 올릴 파일)

```
fund-study/                     ← GitHub 저장소 루트
│
├── index.html                  ← 대시보드 (메인)
├── picks.html                  ← 탑픽 관리 (제출 + 히스토리)
├── trade.html                  ← 매수 / 매도 입력
├── members.html                ← 참여자 현황
├── settle.html                 ← 결산 관리
├── admin.html                  ← 사용자 추가/수정/탈퇴
│
├── css/
│   └── style.css               ← 공통 스타일
│
└── js/
    ├── config.js               ← ⚠️ 여기만 수정! (Supabase 키)
    └── db.js                   ← DB 쿼리 함수
```

**Supabase에서 실행하는 파일 (GitHub에 올리지 않아도 됨)**
```
supabase_schema_v3.sql          → Supabase SQL Editor에 붙여넣기
edge_function_stock_price.ts    → Supabase Edge Functions에 붙여넣기
```

---

## 🚀 세팅 순서 (총 약 25분)

### STEP 1. Supabase 프로젝트 생성 (5분)
1. https://supabase.com 접속 → 회원가입 → **New Project**
2. 프로젝트 이름: `fund-study`, 비밀번호 설정 → **Create Project**
3. 생성 완료까지 약 1분 대기

---

### STEP 2. DB 테이블 + 샘플 데이터 생성 (3분)
1. Supabase 좌측 메뉴 → **SQL Editor**
2. `supabase_schema_v3.sql` 파일 전체 내용 붙여넣기
3. 우측 상단 **Run** 클릭
4. 하단에 members 목록이 나오면 성공

---

### STEP 3. 현재가 API (Edge Function) 등록 — CLI 불필요 (5분)
> ⚡ 이 단계는 CLI 설치 없이 브라우저에서만 합니다
> ⚡ 배포 후 모든 참여자가 동일하게 현재가를 조회합니다

1. Supabase 좌측 메뉴 → **Edge Functions**
2. 우측 상단 **New Function** 클릭
3. Function name: `stock-price` 입력
4. 에디터에 `edge_function_stock_price.ts` 파일 내용 전체 붙여넣기
5. **Deploy** 클릭
6. 상태가 **Active** 로 바뀌면 완료

---

### STEP 4. Supabase API 키 복사 (1분)
1. Supabase 좌측 메뉴 → **Settings** → **API**
2. **Project URL** 복사
3. **anon public** 키 복사

---

### STEP 5. config.js 수정 (1분)
`js/config.js` 파일을 열어서 아래 두 줄 수정:
```js
const SUPABASE_URL  = 'https://여기에붙여넣기.supabase.co';
const SUPABASE_ANON = '여기에anon키붙여넣기';
```

---

### STEP 6. GitHub 업로드 (5분)
1. https://github.com → New repository → 이름: `fund-study` → **Public**
2. **Add file → Upload files** 로 아래 파일들 모두 업로드:
   ```
   index.html, picks.html, trade.html,
   members.html, settle.html, admin.html,
   css/style.css, js/config.js, js/db.js
   ```
   (supabase_schema_v3.sql, edge_function_stock_price.ts는 올리지 않아도 됨)
3. **Settings → Pages → Branch: main → / (root) → Save**
4. 약 2분 후 `https://[아이디].github.io/fund-study` 접속

---

### STEP 7. 로그인 계정 생성 (3분)
1. Supabase → **Authentication → Users → Invite user**
2. 참여자 이메일 입력 → 초대 메일 발송
3. 각자 이메일로 받은 링크에서 비밀번호 설정

---

## ✅ 완료 후 확인 체크리스트

- [ ] 대시보드 접속 → DB 배너가 초록색 "연결됨" 으로 바뀜
- [ ] 대시보드 → 참여자 6명, 이번 달 탑픽 5명 표시
- [ ] "현재가 갱신" 버튼 클릭 → 현재가 컬럼에 숫자 표시
- [ ] 탑픽 관리 → 월별 탭 클릭 시 데이터 변경
- [ ] 사용자 관리 → 참여자 추가/수정 동작

---

## ❓ 자주 묻는 질문

**Q. 현재가가 `-`로 표시돼요**
→ Edge Function이 미등록이거나, 장 마감 후에는 마지막 종가로 표시됩니다.
→ STEP 3을 다시 확인하세요.

**Q. 로그인이 안 돼요**
→ Supabase Authentication → Users 에서 해당 이메일 확인
→ "Email confirmed" 가 체크되어 있는지 확인 (직접 체크 가능)

**Q. 다른 참여자도 데이터를 입력할 수 있나요?**
→ 네. 로그인만 하면 누구나 탑픽 제출, 매수/매도 입력이 가능합니다.
→ 단, 사용자 관리(admin.html)는 운영자만 접근하도록 별도 안내 권장
