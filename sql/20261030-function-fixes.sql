-- Apply before publishing the updated client. No existing balances are changed.
begin;

alter table public.members add column if not exists deactivated_at date;

create or replace function public.sss_member_departure_date()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if old.is_active and not new.is_active then
    new.deactivated_at := coalesce(new.deactivated_at, (now() at time zone 'Asia/Seoul')::date);
  end if;
  -- Reactivation needs membership-period history, not erasure of the old cutoff.
  if not old.is_active and new.is_active and old.deactivated_at is not null then
    raise exception '재가입은 과거 회비 보존을 위해 별도 회원 기록으로 등록하세요.';
  end if;
  return new;
end $$;
drop trigger if exists sss_member_departure_date on public.members;
create trigger sss_member_departure_date before update on public.members
for each row execute function public.sss_member_departure_date();

create schema if not exists sss_audit;
revoke all on schema sss_audit from public,anon,authenticated;
create table if not exists sss_audit.annual_requests (
  id uuid primary key, actor uuid not null, payload jsonb not null,
  result jsonb not null, created_at timestamptz not null default now()
);
alter table sss_audit.annual_requests enable row level security;
revoke all on sss_audit.annual_requests from public,anon,authenticated;
create unique index if not exists annual_settlements_year_unique
  on public.annual_settlements(year);

create or replace function public.sss_annual_settle(
  p_request_id uuid, p_year integer, p_prize integer, p_note text, p_expected jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  saved sss_audit.annual_requests;
  payload jsonb; actual jsonb; expected jsonb; result jsonb;
  total bigint; member_count integer; new_base integer; winner uuid;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> 'batiinvestment@gmail.com' then
    raise exception '관리자만 결산할 수 있습니다.';
  end if;
  if p_request_id is null or p_year is null or p_year < 2020 or p_year > 2099
     or p_prize is null or p_prize < 0 or p_expected is null
     or jsonb_typeof(p_expected) <> 'array' then
    raise exception '결산 입력값을 확인하세요.';
  end if;
  payload := jsonb_build_object('year',p_year,'prize',p_prize,'note',p_note,'expected',p_expected);
  -- Same lock order as sss_submit_trade: global accounting lock, then members.
  perform pg_advisory_xact_lock(327260,20260920);
  select * into saved from sss_audit.annual_requests where id=p_request_id;
  if found then
    if saved.actor <> auth.uid() or saved.payload <> payload then
      raise exception '요청 식별자가 중복되었습니다.';
    end if;
    return saved.result;
  end if;
  -- Also blocks direct member changes and activation/deactivation during snapshot validation.
  lock table public.members in share row exclusive mode;
  select jsonb_agg(jsonb_build_object('id',id,'base_amount',base_amount) order by id),
         sum(base_amount), count(*)
    into actual,total,member_count from public.members where is_active;
  select jsonb_agg(jsonb_build_object('id',id,'base_amount',base_amount) order by id)
    into expected from jsonb_to_recordset(p_expected) as x(id uuid, base_amount integer);
  if member_count=0 or actual is distinct from expected then
    raise exception '회원 또는 기준금액이 변경됐습니다. 계산해보기를 다시 실행하세요.';
  end if;
  if total is null or p_prize > total then raise exception '시상금이 총 기준금액을 초과합니다.'; end if;
  if exists(select 1 from public.annual_settlements where year=p_year) then
    raise exception '이미 결산한 연도입니다. 기존 내역을 확인하세요.';
  end if;
  select id into winner from public.members where is_active order by base_amount desc,id limit 1;
  new_base := floor((total-p_prize)::numeric/member_count)::integer;
  insert into public.annual_settlements(year,winner_id,prize_amount,total_before,total_after,new_base_amount,member_count,note)
    values(p_year,winner,p_prize,total,total-p_prize,new_base,member_count,p_note)
    returning to_jsonb(annual_settlements.*) into result;
  update public.members set base_amount=new_base where is_active;
  insert into sss_audit.annual_requests(id,actor,payload,result)
    values(p_request_id,auth.uid(),payload,result);
  return result;
end $$;
revoke all on function public.sss_annual_settle(uuid,integer,integer,text,jsonb) from public,anon;
grant execute on function public.sss_annual_settle(uuid,integer,integer,text,jsonb) to authenticated;
-- Old clients must not bypass the transaction by writing the annual record directly.
revoke insert,update,delete,truncate on public.annual_settlements from public,anon,authenticated;
notify pgrst,'reload schema';
commit;

-- Read-only follow-up: legacy departures require their real historical dates.
select id,name,joined_at from public.members where not is_active and deactivated_at is null;
