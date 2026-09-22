begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create schema if not exists sss_audit;
revoke all on schema sss_audit from public, anon, authenticated;
create table if not exists sss_audit.presentation_price_backup (
  presentation_id uuid primary key,
  snapshot jsonb not null,
  recorded_at timestamptz not null default now()
);
insert into sss_audit.presentation_price_backup (presentation_id, snapshot)
select id, to_jsonb(p) from public.presentations p on conflict do nothing;

alter table public.presentations
  add column if not exists price_adjusted_at numeric,
  add column if not exists price_date date,
  add column if not exists price_source text,
  add column if not exists price_checked_at timestamptz;

create table if not exists sss_audit.presentation_price_changes (
  id bigint generated always as identity primary key,
  presentation_id uuid not null,
  recorded_at timestamptz not null default now(),
  before_value jsonb not null,
  after_value jsonb not null
);
alter table sss_audit.presentation_price_backup enable row level security;
alter table sss_audit.presentation_price_changes enable row level security;
revoke all on sss_audit.presentation_price_backup, sss_audit.presentation_price_changes
from public, anon, authenticated;

create or replace function public.guard_presentation_day_price()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (tg_op = 'INSERT' and new.stock_code ~ '^[0-9]{6}$')
    or (tg_op = 'UPDATE' and (
      new.stock_code is distinct from old.stock_code
      or new.presented_at is distinct from old.presented_at
      or (new.status = 'planned' and new.status is distinct from old.status)
    )) then
    new.price_at := null;
    new.price_adjusted_at := null;
    new.price_date := null;
    new.price_source := null;
    new.price_checked_at := null;
  elsif tg_op = 'UPDATE' and new.stock_code ~ '^[0-9]{6}$'
    and current_user not in ('postgres', 'service_role', 'supabase_admin')
    and row(new.price_at, new.price_adjusted_at, new.price_date, new.price_source, new.price_checked_at)
      is distinct from row(old.price_at, old.price_adjusted_at, old.price_date, old.price_source, old.price_checked_at) then
    raise exception 'Presentation prices are finalized by the daily close service';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_presentation_day_price on public.presentations;
create trigger guard_presentation_day_price before insert or update on public.presentations
for each row execute function public.guard_presentation_day_price();

create or replace function public.apply_presentation_day_price(
  p_id uuid, p_stock_code text, p_presented_at date,
  p_close integer, p_adjusted_close numeric, p_checked_at timestamptz
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  existing public.presentations%rowtype;
  next_value jsonb;
begin
  if p_stock_code is null or p_stock_code !~ '^[0-9]{6}$'
    or p_presented_at is null or p_close is null or p_close <= 0
    or p_adjusted_close is null or p_adjusted_close <= 0 or p_adjusted_close > 2147483647
    or p_checked_at is null or p_checked_at > now() + interval '5 minutes'
    or p_checked_at < (p_presented_at + time '18:00') at time zone 'Asia/Seoul'
    or now() < (p_presented_at + time '18:00') at time zone 'Asia/Seoul' then
    raise exception 'Invalid or unfinished presentation daily close';
  end if;
  select * into existing from public.presentations where id = p_id for update;
  if not found or existing.stock_code is distinct from p_stock_code
    or existing.presented_at is distinct from p_presented_at
    or coalesce(existing.status, 'done') <> 'done'
    or existing.price_checked_at > p_checked_at then
    return false;
  end if;
  next_value := jsonb_build_object('price_at', p_close, 'price_adjusted_at', p_adjusted_close,
    'price_date', p_presented_at, 'price_source', 'naver_daily_close_v1', 'price_checked_at', p_checked_at);
  if row(existing.price_at, existing.price_adjusted_at, existing.price_date, existing.price_source)
    is distinct from row(p_close, p_adjusted_close, p_presented_at, 'naver_daily_close_v1'::text) then
    insert into sss_audit.presentation_price_changes(presentation_id, before_value, after_value)
    values (p_id, to_jsonb(existing), next_value);
  end if;
  update public.presentations set price_at = p_close, price_adjusted_at = p_adjusted_close,
    price_date = p_presented_at, price_source = 'naver_daily_close_v1', price_checked_at = p_checked_at
  where id = p_id;
  return true;
end;
$$;
revoke all on function public.apply_presentation_day_price(uuid,text,date,integer,numeric,timestamptz)
from public, anon, authenticated;
grant execute on function public.apply_presentation_day_price(uuid,text,date,integer,numeric,timestamptz) to service_role;

-- Selection-time quotes are not presentation closes. Original rows are backed up above.
update public.presentations set price_at = null, price_adjusted_at = null,
  price_date = null, price_source = null, price_checked_at = null
where status = 'planned' and stock_code ~ '^[0-9]{6}$'
  and (price_at is not null or price_source is not null);

notify pgrst, 'reload schema';
commit;
