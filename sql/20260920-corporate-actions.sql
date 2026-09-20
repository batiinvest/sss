-- Transactional bonus-share ledger. Original trades/settlements are retained.
begin;
create schema if not exists sss_audit;
revoke all on schema sss_audit from public, anon, authenticated;
create table if not exists sss_audit.corporate_migration_backup (
  version text primary key, captured_at timestamptz not null default now(), data jsonb not null
);
insert into sss_audit.corporate_migration_backup(version,data)
select '20260920.1', jsonb_build_object(
  'trades',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.trades t),
  'settlements',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.settlements s),
  'member_balances',(select jsonb_agg(jsonb_build_object('id',id,'base_amount',base_amount)) from public.members),
  'auto_settle',pg_get_functiondef('public.auto_settle_on_sell()'::regprocedure)
) on conflict do nothing;

create table if not exists public.corporate_actions (
  id uuid primary key default gen_random_uuid(), stock_code text not null check (stock_code ~ '^[0-9]{6}$'),
  stock_name text not null, existing_shares integer not null check(existing_shares>0),
  new_shares integer not null check(new_shares>0), ex_date date not null, record_date date not null,
  expected_credit_date date, credit_date date, source_url text not null,
  status text not null default 'applied' check(status in ('applied','reversed')),
  created_by uuid, created_at timestamptz not null default now(),
  check(record_date>=ex_date), check(credit_date>=ex_date), check(expected_credit_date>=ex_date)
);
create unique index if not exists corporate_actions_active_unique
  on public.corporate_actions(stock_code,ex_date) where status='applied';
alter table public.corporate_actions enable row level security;
-- Shared study members already have authenticated access to portfolio data.
grant select on public.corporate_actions to authenticated;
revoke insert,update,delete on public.corporate_actions from anon,authenticated;
create table if not exists sss_audit.corporate_requests (
  id uuid primary key, actor uuid, kind text not null, payload jsonb not null,
  result jsonb not null, created_at timestamptz not null default now()
);
create table if not exists sss_audit.corporate_events (
  id bigint generated always as identity primary key, action_id uuid not null,
  kind text not null, actor uuid, before_state jsonb, after_state jsonb,
  created_at timestamptz not null default now()
);
alter table sss_audit.corporate_migration_backup enable row level security;
alter table sss_audit.corporate_requests enable row level security;
alter table sss_audit.corporate_events enable row level security;
alter table public.settlements add column if not exists corporate_note text;
alter table public.settlements add column if not exists corporate_action_id uuid;
alter table public.settlements add column if not exists source_trade_id uuid;

create or replace function public.sss_ca_require(p_admin boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  if p_admin and lower(coalesce(auth.jwt()->>'email','')) <> 'batiinvestment@gmail.com' then
    raise exception '관리자만 변경할 수 있습니다.';
  end if;
end $$;

create or replace function public.sss_ca_validate(a jsonb)
returns void language plpgsql set search_path=pg_catalog,public as $$
begin
  if coalesce(a->>'stock_code','') !~ '^[0-9]{6}$' or coalesce(trim(a->>'stock_name'),'')='' then
    raise exception '종목코드와 종목명을 확인하세요.'; end if;
  if coalesce((a->>'existing_shares')::numeric,0)<=0 or coalesce((a->>'new_shares')::numeric,0)<=0
    or (a->>'existing_shares')::numeric<>trunc((a->>'existing_shares')::numeric)
    or (a->>'new_shares')::numeric<>trunc((a->>'new_shares')::numeric) then
    raise exception '배정 비율은 양의 정수여야 합니다.'; end if;
  if a->>'ex_date' is null or a->>'record_date' is null
    or (a->>'record_date')::date < (a->>'ex_date')::date
    or (a->>'credit_date')::date < (a->>'ex_date')::date
    or (a->>'expected_credit_date')::date < (a->>'ex_date')::date then
    raise exception '권리락일·배정기준일·입고일을 확인하세요.'; end if;
  if (a->>'ex_date')::date > (now() at time zone 'Asia/Seoul')::date then
    raise exception '권리락일이 지난 후 적용할 수 있습니다.'; end if;
  if coalesce(a->>'source_url','') !~ '^https://' then raise exception 'HTTPS 공시 링크를 입력하세요.'; end if;
end $$;

create or replace function public.sss_ca_replay(p_trades jsonb, p_actions jsonb, p_as_of timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare e record; q numeric:=0; pending numeric:=0; cost numeric:=0; avg_price numeric:=0;
  added numeric; qty numeric; price numeric; gross numeric:=0; fees numeric:=0;
  sale_gross numeric; sale_fee numeric; rights jsonb:='{}'; history jsonb:='[]'; sales jsonb:='[]';
begin
  if p_as_of is null then raise exception '조회 기준일을 확인하세요.'; end if;
  for e in
    select * from (
      select (t->>'traded_at')::timestamptz as ts, 2 as rank, t->>'trade_type' as kind, t as row,
        coalesce(t->>'id','') as key from jsonb_array_elements(p_trades) t
      union all select ((a->>'ex_date')::date::timestamp at time zone 'Asia/Seoul'),0,'bonus',a,
        coalesce(a->>'id','preview') from jsonb_array_elements(p_actions) a where coalesce(a->>'status','applied')='applied'
      union all select ((a->>'credit_date')::date::timestamp at time zone 'Asia/Seoul'),1,'credit',a,
        coalesce(a->>'id','preview') from jsonb_array_elements(p_actions) a
        where coalesce(a->>'status','applied')='applied' and a->>'credit_date' is not null
    ) events where ts<=p_as_of order by ts,rank,key
  loop
    avg_price:=case when q+pending>0 then cost/(q+pending) else 0 end;
    if e.kind in ('buy','sell') then
      qty:=(e.row->>'quantity')::numeric; price:=(e.row->>'price')::numeric;
      if qty is null or qty<=0 or qty<>trunc(qty) or price is null or price<=0 then
        raise exception '거래 수량과 가격을 확인하세요.'; end if;
      if e.kind='buy' then q:=q+qty; cost:=cost+qty*price;
      else
        if qty>q then raise exception '거래일 기준 매도 가능 수량을 초과합니다. 신주 입고일도 확인하세요.'; end if;
        q:=q-qty; cost:=cost-qty*avg_price;
        sale_gross:=round((price-avg_price)*qty);
        sale_fee:=round((price+avg_price)*qty*0.003);
        gross:=gross+sale_gross; fees:=fees+sale_fee;
        sales:=sales||jsonb_build_array(jsonb_build_object('id',e.key,'averagePrice',avg_price,
          'quantity',qty,'price',price,'gross',sale_gross,'fee',sale_fee));
        if q+pending=0 then cost:=0; end if;
      end if;
    elsif e.kind='bonus' then
      if pending>0 then raise exception '이전 미입고 신주를 먼저 확인하세요.'; end if;
      added:=q*(e.row->>'new_shares')::numeric/(e.row->>'existing_shares')::numeric;
      if added<>trunc(added) then raise exception '단수주가 발생합니다. 증권사 배정 내역을 확인하세요.'; end if;
      if added>0 then
        history:=history||jsonb_build_array(jsonb_build_object('action_id',e.key,'ex_date',e.row->>'ex_date',
          'credit_date',e.row->>'credit_date','existing_shares',e.row->'existing_shares','new_shares',e.row->'new_shares',
          'beforeQuantity',q,'addedQuantity',added,'beforeAverage',avg_price,'afterAverage',cost/(q+added),'cost',cost));
      end if;
      pending:=pending+added; rights:=jsonb_set(rights,array[e.key],to_jsonb(added));
    elsif e.kind='credit' then
      added:=coalesce((rights->>e.key)::numeric,0); q:=q+added; pending:=pending-added;
    else raise exception '지원하지 않는 거래 유형입니다.';
    end if;
  end loop;
  return jsonb_build_object('quantity',q+pending,'tradableQuantity',q,'pendingQuantity',pending,'cost',cost,
    'averagePrice',case when q+pending>0 then cost/(q+pending) else 0 end,
    'realizedPnl',gross,'fees',fees,'netProfit',gross-fees,'history',history,'sales',sales);
end $$;

create or replace function public.sss_ca_state(p_pick uuid,p_as_of timestamptz default now(),p_extra jsonb default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare t jsonb; a jsonb; p public.picks; result jsonb;
begin
  select * into strict p from public.picks where id=p_pick;
  if exists(select 1 from public.trades where pick_id=p_pick and (traded_at is null or member_id is distinct from p.member_id)) then
    raise exception '거래일 또는 담당자가 일치하지 않는 기록이 있습니다.'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into t from public.trades x where pick_id=p_pick;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into a from public.corporate_actions x
    where stock_code=p.stock_code and status='applied';
  if p_extra is not null then a:=a||jsonb_build_array(p_extra); end if;
  result:=public.sss_ca_replay(t,a,p_as_of);
  return result||jsonb_build_object('pick_id',p_pick,'member_id',p.member_id,'stock_code',p.stock_code);
end $$;

create or replace function public.sss_corporate_actions_version()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform public.sss_ca_require(); return 1; end $$;
create or replace function public.sss_corporate_positions(p_pick_ids uuid[],p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.sss_ca_require();
  select coalesce(jsonb_agg(public.sss_ca_state(id,p_as_of)),'[]') into result
    from public.picks where id=any(p_pick_ids);
  return result;
end $$;
create or replace function public.sss_corporate_actions_list()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.sss_ca_require();
  select coalesce(jsonb_agg(to_jsonb(a) order by ex_date desc,created_at desc),'[]') into result from public.corporate_actions a;
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
  for p in select pickrow.id,m.name from public.picks pickrow join public.members m on m.id=pickrow.member_id
    where pickrow.stock_code=p_action->>'stock_code' order by pickrow.id loop
    before_state:=public.sss_ca_state(p.id);
    after_state:=public.sss_ca_state(p.id,now(),p_action);
    if jsonb_array_length(after_state->'history')>jsonb_array_length(before_state->'history') then
      rows:=rows||jsonb_build_array(after_state||jsonb_build_object('member_name',p.name,
        'beforeQuantity',before_state->'quantity','beforeAverage',before_state->'averagePrice',
        'settlementDelta',(after_state->>'netProfit')::numeric-coalesce((select sum(net_profit) from public.settlements where pick_id=p.id),0)));
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into ledger from public.trades t join public.picks pickrow on pickrow.id=t.pick_id
    where pickrow.stock_code=p_action->>'stock_code';
  token:=md5(p_action::text||rows::text||ledger::text);
  return jsonb_build_object('token',token,'positions',rows);
end $$;

-- Reconcile only the affected pick, preserving old settlement rows and applying a delta once.
create or replace function public.sss_ca_reconcile(p_pick uuid,p_action uuid default null,p_trade uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s jsonb; old_gross numeric; old_fee numeric; old_net numeric; gross_delta integer; fee_delta integer;
  p public.picks; last_sale jsonb;
begin
  select * into strict p from public.picks where id=p_pick;
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
  for p in select id from public.picks where stock_code=a.stock_code loop perform public.sss_ca_reconcile(p.id,a.id); end loop;
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
  for p in select id from public.picks where stock_code=a.stock_code loop perform public.sss_ca_state(p.id); end loop;
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
  for p in select id from public.picks where stock_code=a.stock_code loop perform public.sss_ca_reconcile(p.id,a.id); end loop;
  insert into sss_audit.corporate_events(action_id,kind,actor,before_state,after_state)
    values(a.id,'reverse',auth.uid(),to_jsonb(a),result||jsonb_build_object('reason',p_reason));
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'reverse',payload,result,now());
  return result;
end $$;

create or replace function public.sss_ca_trade_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.picks;
begin
  perform public.sss_ca_require(); perform pg_advisory_xact_lock(327260,20260920);
  if tg_op<>'INSERT' then raise exception '매매 원본은 보존됩니다. 기존 거래 정정은 관리자 점검이 필요합니다.'; end if;
  select * into strict p from public.picks where id=new.pick_id;
  if p.member_id is distinct from new.member_id then raise exception '담당자와 종목이 일치하지 않습니다.'; end if;
  if lower(coalesce(auth.jwt()->>'email',''))<>'batiinvestment@gmail.com' and not exists(
    select 1 from public.members where id=new.member_id and lower(email)=lower(auth.jwt()->>'email') and is_active
  ) then raise exception '본인의 거래만 등록할 수 있습니다.'; end if;
  if new.quantity<=0 or new.price<=0 or new.traded_at is null or new.traded_at>now() then raise exception '거래일·가격·수량을 확인하세요.'; end if;
  new.stock_code:=p.stock_code; new.stock_name:=p.stock_name;
  return new;
end $$;
-- Retain the existing trigger binding; replace its first-buy-only calculation.
create or replace function public.auto_settle_on_sell()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.sss_ca_state(new.pick_id); -- also validates backdated buys against all later sells
  perform public.sss_ca_reconcile(new.pick_id,null,new.id);
  return new;
end $$;
create trigger sss_ca_trade_guard before insert or update or delete on public.trades
  for each row execute function public.sss_ca_trade_guard();

create or replace function public.sss_submit_trade(p_trade jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare saved sss_audit.corporate_requests; result jsonb;
begin
  perform public.sss_ca_require(); perform pg_advisory_xact_lock(327260,20260920);
  select * into saved from sss_audit.corporate_requests where id=p_request_id;
  if found then
    if saved.actor is distinct from auth.uid() or saved.kind<>'trade' or saved.payload<>p_trade then raise exception '요청 식별자가 중복되었습니다.'; end if;
    return saved.result;
  end if;
  if (p_trade->>'quantity')::numeric<>trunc((p_trade->>'quantity')::numeric)
    or (p_trade->>'price')::numeric<>trunc((p_trade->>'price')::numeric) then raise exception '거래 가격과 수량은 정수여야 합니다.'; end if;
  insert into public.trades(member_id,pick_id,trade_type,stock_name,price,quantity,note,traded_at)
    values((p_trade->>'member_id')::uuid,(p_trade->>'pick_id')::uuid,p_trade->>'trade_type',p_trade->>'stock_name',
      (p_trade->>'price')::integer,(p_trade->>'quantity')::integer,p_trade->>'note',(p_trade->>'traded_at')::timestamptz)
    returning to_jsonb(trades.*) into result;
  insert into sss_audit.corporate_requests values(p_request_id,auth.uid(),'trade',p_trade,result,now());
  return result;
end $$;

-- Internal replay/reconciliation helpers are not callable through the public API.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'sss_ca_%' or p.proname in
      ('sss_corporate_actions_version','sss_corporate_positions','sss_corporate_actions_list','sss_preview_bonus',
       'sss_apply_bonus','sss_credit_bonus','sss_reverse_bonus','sss_submit_trade')) loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  end loop;
end $$;
grant execute on function public.sss_corporate_actions_version(),public.sss_corporate_positions(uuid[],timestamptz),
  public.sss_corporate_actions_list(),public.sss_preview_bonus(jsonb),public.sss_apply_bonus(jsonb,text,uuid),
  public.sss_credit_bonus(uuid,date,uuid),public.sss_reverse_bonus(uuid,text,uuid),public.sss_submit_trade(jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
