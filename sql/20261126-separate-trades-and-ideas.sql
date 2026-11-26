-- Run the whole file once in Supabase SQL Editor. Safe to run again.
-- Preserve original trade/settlement IDs, balances, and per-position cost basis.
begin;
select pg_advisory_xact_lock(327260,20260920);

create table if not exists public.trade_accounts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.members(id),
  stock_name text not null,
  stock_code text,
  market text,
  source_pick_id uuid, -- historical provenance only, deliberately no cascading FK
  created_at timestamptz not null default now()
);
alter table public.trade_accounts enable row level security;
drop policy if exists trade_accounts_read on public.trade_accounts;
create policy trade_accounts_read on public.trade_accounts for select to authenticated using (true);
revoke all on public.trade_accounts from anon, authenticated;
grant select on public.trade_accounts to authenticated;
create index if not exists trade_accounts_member_stock on public.trade_accounts(member_id,stock_code);

insert into sss_audit.corporate_migration_backup(version,data)
select '20261126.separation', jsonb_build_object(
  'picks',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.picks p),
  'trades',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.trades t),
  'settlements',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.settlements s),
  'balances',(select jsonb_agg(jsonb_build_object('id',id,'base_amount',base_amount)) from public.members)
) on conflict do nothing;

insert into public.trade_accounts(id,member_id,stock_name,stock_code,market,source_pick_id,created_at)
select id,member_id,stock_name,stock_code,market,id,coalesce(submitted_at,now()) from public.picks
on conflict(id) do nothing;

-- pick_id is retained as a legacy column name/API alias. It now identifies a
-- trade account, independently of the monthly top pick and its future edits.
do $$ declare c record; begin
  for c in select conrelid::regclass as tbl,conname from pg_constraint
    where contype='f' and confrelid='public.picks'::regclass
      and conrelid in ('public.trades'::regclass,'public.settlements'::regclass) loop
    execute format('alter table %s drop constraint %I',c.tbl,c.conname);
  end loop;
  if not exists(select 1 from pg_constraint where conname='trades_account_fk' and conrelid='public.trades'::regclass) then
    alter table public.trades add constraint trades_account_fk foreign key(pick_id) references public.trade_accounts(id);
  end if;
  if not exists(select 1 from pg_constraint where conname='settlements_account_fk' and conrelid='public.settlements'::regclass) then
    alter table public.settlements add constraint settlements_account_fk foreign key(pick_id) references public.trade_accounts(id);
  end if;
end $$;

create or replace view public.investment_ideas with (security_invoker=true) as
select p.*, p.id as pick_id,m.name as member_name,
  null::numeric as buy_price,0::numeric as buy_quantity,null::numeric as sell_price,
  null::numeric as realized_return,'idea'::text as status
from public.picks p left join public.members m on m.id=p.member_id;

create or replace view public.trade_positions with (security_invoker=true) as
select a.*,a.id as pick_id,m.name as member_name,
  to_char((select min(t.traded_at) from public.trades t where t.pick_id=a.id) at time zone 'Asia/Seoul','YYYY-MM') as month,
  a.created_at as submitted_at,null::text as carried_from,null::text as reason,
  null::integer as price_at,null::integer as target_price,
  null::numeric as buy_price,0::numeric as buy_quantity,null::numeric as sell_price,
  null::numeric as realized_return,'hold'::text as status
from public.trade_accounts a left join public.members m on m.id=a.member_id
where exists(select 1 from public.trades t where t.pick_id=a.id);
revoke all on public.investment_ideas,public.trade_positions from anon;
grant select on public.investment_ideas,public.trade_positions to authenticated;

create or replace function public.sss_ca_state(p_pick uuid,p_as_of timestamptz default now(),p_extra jsonb default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare t jsonb; a jsonb; p public.trade_accounts; result jsonb;
begin
  select * into strict p from public.trade_accounts where id=p_pick;
  if exists(select 1 from public.trades where pick_id=p_pick and (traded_at is null or member_id is distinct from p.member_id)) then
    raise exception '거래일 또는 담당자가 일치하지 않는 기록이 있습니다.'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into t from public.trades x where pick_id=p_pick;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into a from public.corporate_actions x
    where stock_code=p.stock_code and status='applied';
  if p_extra is not null then a:=a||jsonb_build_array(p_extra); end if;
  result:=public.sss_ca_replay(t,a,p_as_of);
  return result||jsonb_build_object('pick_id',p_pick,'member_id',p.member_id,'stock_code',p.stock_code);
end $$;

create or replace function public.sss_corporate_positions(p_pick_ids uuid[],p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.sss_ca_require();
  select coalesce(jsonb_agg(public.sss_ca_state(id,p_as_of)),'[]') into result
    from public.trade_accounts where id=any(p_pick_ids);
  return result;
end $$;

create or replace function public.sss_preview_bonus(p_action jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p record; before_state jsonb; after_state jsonb; rows jsonb:='[]'; token text; ledger jsonb;
begin
  perform public.sss_ca_require(true); perform public.sss_ca_validate(p_action);
  if p_action->>'credit_date' is not null or p_action ? 'id' or p_action ? 'status' then
    raise exception '등록 후 별도로 실제 입고를 확인하세요.'; end if;
  perform pg_advisory_xact_lock(327260,20260920);
  if exists(select 1 from public.corporate_actions where stock_code=p_action->>'stock_code'
    and ex_date=(p_action->>'ex_date')::date and status='applied') then raise exception '이미 등록된 무상증자입니다.'; end if;
  for p in select pickrow.id,m.name from public.trade_accounts pickrow join public.members m on m.id=pickrow.member_id
    where pickrow.stock_code=p_action->>'stock_code' order by pickrow.id loop
    before_state:=public.sss_ca_state(p.id);
    after_state:=public.sss_ca_state(p.id,now(),p_action);
    if jsonb_array_length(after_state->'history')>jsonb_array_length(before_state->'history') then
      rows:=rows||jsonb_build_array(after_state||jsonb_build_object('member_name',p.name,
        'beforeQuantity',before_state->'quantity','beforeAverage',before_state->'averagePrice',
        'settlementDelta',(after_state->>'netProfit')::numeric-coalesce((select sum(net_profit) from public.settlements where pick_id=p.id),0)));
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into ledger from public.trades t join public.trade_accounts pickrow on pickrow.id=t.pick_id
    where pickrow.stock_code=p_action->>'stock_code';
  token:=md5(p_action::text||rows::text||ledger::text);
  return jsonb_build_object('token',token,'positions',rows);
end $$;

create or replace function public.sss_ca_reconcile(p_pick uuid,p_action uuid default null,p_trade uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s jsonb; old_gross numeric; old_fee numeric; old_net numeric; gross_delta integer; fee_delta integer;
  p public.trade_accounts; last_sale jsonb;
begin
  select * into strict p from public.trade_accounts where id=p_pick;
  perform 1 from public.members where id=p.member_id for update;
  s:=public.sss_ca_state(p_pick);
  select coalesce(sum(gross_profit),0),coalesce(sum(tax_fee),0),coalesce(sum(net_profit),0)
    into old_gross,old_fee,old_net from public.settlements where pick_id=p_pick;
  gross_delta:=((s->>'realizedPnl')::numeric-old_gross)::integer;
  -- Include any old inconsistent net amount in the correction, never overwrite history.
  fee_delta:=(gross_delta-((s->>'netProfit')::numeric-old_net))::integer;
  if gross_delta=0 and fee_delta=0 then return; end if;
  last_sale:=s->'sales'->-1;
  insert into public.settlements(member_id,pick_id,buy_price,sell_price,quantity,gross_profit,tax_fee,
    corporate_note,corporate_action_id,source_trade_id)
  values(p.member_id,p_pick,round((last_sale->>'averagePrice')::numeric)::integer,
    (last_sale->>'price')::integer,(last_sale->>'quantity')::integer,gross_delta,fee_delta,
    case when p_action is not null then '무상증자 원가 보정' else '거래 원가 재계산' end,p_action,p_trade);
end $$;

create or replace function public.sss_apply_bonus(p_action jsonb,p_preview_token text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare saved sss_audit.corporate_requests; preview jsonb; a public.corporate_actions; p record; result jsonb;
begin
  perform public.sss_ca_require(true); perform pg_advisory_xact_lock(327260,20260920);
  select * into saved from sss_audit.corporate_requests where id=p_request_id;
  if found then
    if saved.actor is distinct from auth.uid() or saved.kind<>'apply' or saved.payload<>p_action then raise exception '요청 식별자가 중복되었습니다.'; end if;
    return saved.result;
  end if;
  preview:=public.sss_preview_bonus(p_action);
  if preview->>'token' is distinct from p_preview_token then raise exception '거래 내역이 변경되었습니다. 미리보기를 다시 확인하세요.'; end if;
  insert into public.corporate_actions(stock_code,stock_name,existing_shares,new_shares,ex_date,record_date,expected_credit_date,source_url,created_by)
    values(p_action->>'stock_code',p_action->>'stock_name',(p_action->>'existing_shares')::integer,(p_action->>'new_shares')::integer,
      (p_action->>'ex_date')::date,(p_action->>'record_date')::date,(p_action->>'expected_credit_date')::date,p_action->>'source_url',auth.uid()) returning * into a;
  for p in select id from public.trade_accounts where stock_code=a.stock_code loop perform public.sss_ca_reconcile(p.id,a.id); end loop;
  result:=to_jsonb(a);
  insert into sss_audit.corporate_events(action_id,kind,actor,after_state) values(a.id,'apply',auth.uid(),preview||jsonb_build_object('action',result));
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'apply',p_action,result,now());
  return result;
end $$;

create or replace function public.sss_credit_bonus(p_action_id uuid,p_credit_date date,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.corporate_actions; result jsonb; saved sss_audit.corporate_requests; payload jsonb; p record;
begin
  perform public.sss_ca_require(true); perform pg_advisory_xact_lock(327260,20260920);
  payload:=jsonb_build_object('action_id',p_action_id,'credit_date',p_credit_date);
  select * into saved from sss_audit.corporate_requests where id=p_request_id;
  if found then
    if saved.actor is distinct from auth.uid() or saved.kind<>'credit' or saved.payload<>payload then raise exception '요청 식별자가 중복되었습니다.'; end if;
    return saved.result;
  end if;
  select * into strict a from public.corporate_actions where id=p_action_id for update;
  if a.status<>'applied' or a.credit_date is not null then raise exception '이미 입고되었거나 취소된 무상증자입니다.'; end if;
  if p_credit_date is null or p_credit_date<a.ex_date or p_credit_date>(now() at time zone 'Asia/Seoul')::date then raise exception '실제 입고일을 확인하세요.'; end if;
  update public.corporate_actions set credit_date=p_credit_date where id=a.id returning to_jsonb(corporate_actions.*) into result;
  for p in select id from public.trade_accounts where stock_code=a.stock_code loop perform public.sss_ca_state(p.id); end loop;
  insert into sss_audit.corporate_events(action_id,kind,actor,before_state,after_state) values(a.id,'credit',auth.uid(),to_jsonb(a),result);
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'credit',payload,result,now());
  return result;
end $$;

create or replace function public.sss_reverse_bonus(p_action_id uuid,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.corporate_actions; result jsonb; p record; saved sss_audit.corporate_requests; payload jsonb;
begin
  perform public.sss_ca_require(true); perform pg_advisory_xact_lock(327260,20260920);
  payload:=jsonb_build_object('action_id',p_action_id,'reason',p_reason);
  select * into saved from sss_audit.corporate_requests where id=p_request_id;
  if found then
    if saved.actor is distinct from auth.uid() or saved.kind<>'reverse' or saved.payload<>payload then raise exception '요청 식별자가 중복되었습니다.'; end if;
    return saved.result;
  end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception '취소 사유를 입력하세요.'; end if;
  select * into strict a from public.corporate_actions where id=p_action_id for update;
  if a.status<>'applied' then raise exception '이미 취소된 무상증자입니다.'; end if;
  update public.corporate_actions set status='reversed' where id=a.id returning to_jsonb(corporate_actions.*) into result;
  for p in select id from public.trade_accounts where stock_code=a.stock_code loop perform public.sss_ca_reconcile(p.id,a.id); end loop;
  insert into sss_audit.corporate_events(action_id,kind,actor,before_state,after_state)
    values(a.id,'reverse',auth.uid(),to_jsonb(a),result||jsonb_build_object('reason',p_reason));
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'reverse',payload,result,now());
  return result;
end $$;

create or replace function public.sss_ca_trade_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.trade_accounts;
begin
  perform public.sss_ca_require(); perform pg_advisory_xact_lock(327260,20260920);
  if tg_op<>'INSERT' then raise exception '매매 원본은 보존됩니다. 기존 거래 정정은 관리자 점검이 필요합니다.'; end if;
  select * into strict p from public.trade_accounts where id=new.pick_id;
  if p.member_id is distinct from new.member_id then raise exception '담당자와 종목이 일치하지 않습니다.'; end if;
  if lower(coalesce(auth.jwt()->>'email',''))<>'batiinvestment@gmail.com' and not exists(
    select 1 from public.members where id=new.member_id and lower(email)=lower(auth.jwt()->>'email') and is_active
  ) then raise exception '본인의 거래만 등록할 수 있습니다.'; end if;
  if new.quantity<=0 or new.price<=0 or new.traded_at is null or new.traded_at>now() then raise exception '거래일·가격·수량을 확인하세요.'; end if;
  new.stock_code:=p.stock_code; new.stock_name:=p.stock_name;
  return new;
end $$;

-- ACCOUNT_FUNCTIONS: existing replay, reconciliation and corporate-action
-- behavior is preserved; only the identity source changes to trade_accounts.

create or replace function public.sss_submit_trade(p_trade jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare saved sss_audit.corporate_requests; result jsonb; account_id uuid;
  owner_id uuid; stock record; matches integer;
begin
  perform public.sss_ca_require(); perform pg_advisory_xact_lock(327260,20260920);
  if p_request_id is null then raise exception '거래 요청 식별자가 필요합니다.'; end if;
  select * into saved from sss_audit.corporate_requests where id=p_request_id;
  if found then
    if saved.actor is distinct from auth.uid() or saved.kind<>'trade' or saved.payload<>p_trade then raise exception '요청 식별자가 중복되었습니다.'; end if;
    return saved.result;
  end if;
  owner_id:=(p_trade->>'member_id')::uuid;
  if owner_id is null or not exists(select 1 from public.members where id=owner_id and is_active) then
    raise exception '활성 담당자를 선택하세요.'; end if;
  if lower(coalesce(auth.jwt()->>'email',''))<>'batiinvestment@gmail.com' and not exists(
    select 1 from public.members where id=owner_id and lower(email)=lower(auth.jwt()->>'email') and is_active
  ) then raise exception '본인의 거래만 등록할 수 있습니다.'; end if;
  if coalesce(p_trade->>'trade_type','') not in ('buy','sell')
    or coalesce((p_trade->>'quantity')::numeric,0)<=0 or coalesce((p_trade->>'price')::numeric,0)<=0
    or (p_trade->>'quantity')::numeric<>trunc((p_trade->>'quantity')::numeric)
    or (p_trade->>'price')::numeric<>trunc((p_trade->>'price')::numeric)
    or (p_trade->>'traded_at') is null or (p_trade->>'traded_at')::timestamptz>now() then
    raise exception '거래 유형·거래일·가격·수량을 확인하세요.'; end if;
  account_id:=coalesce(nullif(p_trade->>'position_id',''),nullif(p_trade->>'pick_id',''))::uuid;
  if account_id is null then
    if p_trade->>'trade_type'<>'buy' then raise exception '매도할 보유 종목을 선택하세요.'; end if;
    select * into stock from public.stock_prices where stock_code=p_trade->>'stock_code';
    if not found then raise exception '종목을 검색 결과에서 선택하세요.'; end if;
    select count(*) into matches from public.trade_accounts a where a.member_id=owner_id
      and a.stock_code=stock.stock_code and exists(select 1 from public.trades t where t.pick_id=a.id);
    if matches>1 then raise exception '같은 종목의 기존 거래가 여러 건입니다. 추가 매수할 보유 기록을 선택하세요.'; end if;
    if matches=1 then
      select a.id into account_id from public.trade_accounts a where a.member_id=owner_id
        and a.stock_code=stock.stock_code and exists(select 1 from public.trades t where t.pick_id=a.id);
    else
      insert into public.trade_accounts(member_id,stock_name,stock_code,market)
        values(owner_id,stock.stock_name,stock.stock_code,stock.market) returning id into account_id;
    end if;
  elsif not exists(select 1 from public.trade_accounts where id=account_id) then
    -- Compatibility with a pending request from the previous release.
    insert into public.trade_accounts(id,member_id,stock_name,stock_code,market,source_pick_id)
      select id,member_id,stock_name,stock_code,market,id from public.picks where id=account_id and member_id=owner_id;
    if not found then raise exception '거래 종목을 찾을 수 없습니다.'; end if;
  end if;
  if not exists(select 1 from public.trade_accounts where id=account_id and member_id=owner_id) then
    raise exception '담당자와 보유종목 정보가 일치하지 않습니다.'; end if;
  insert into public.trades(member_id,pick_id,trade_type,stock_name,price,quantity,note,traded_at)
    values(owner_id,account_id,p_trade->>'trade_type','',
      (p_trade->>'price')::integer,(p_trade->>'quantity')::integer,p_trade->>'note',(p_trade->>'traded_at')::timestamptz)
    returning to_jsonb(trades.*) into result;
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'trade',p_trade,result,now());
  return result;
end $$;

create or replace function public.sss_trade_accounts_version()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform public.sss_ca_require(); return 1; end $$;
revoke all on function public.sss_trade_accounts_version() from public,anon;
grant execute on function public.sss_trade_accounts_version() to authenticated;
revoke all on function public.sss_submit_trade(jsonb,uuid) from public,anon;
grant execute on function public.sss_submit_trade(jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;

select to_regclass('public.trade_accounts') is not null as accounts_ready,
  to_regclass('public.investment_ideas') is not null as ideas_ready,
  to_regprocedure('public.sss_trade_accounts_version()') is not null as api_ready;
