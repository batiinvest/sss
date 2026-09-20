-- Run after migration inside a transaction; caller MUST ROLLBACK.
do $$
declare m uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); a jsonb; preview jsonb; result jsonb; state jsonb;
  req uuid:=gen_random_uuid(); action_id uuid; trade_req uuid:=gen_random_uuid(); payload jsonb; n integer;
  original_base integer; rejected boolean; before_count bigint;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated',
    'email','batiinvestment@gmail.com')::text,true);
  insert into public.members(id,name,base_amount) values(m,'자동검증 전용',500000);
  insert into public.picks(id,member_id,month,stock_name,stock_code) values(p,m,'2026-04','자동검증','999999');
  perform public.sss_submit_trade(jsonb_build_object('member_id',m,'pick_id',p,'trade_type','buy',
    'stock_name','자동검증','quantity',6,'price',75500,'traded_at','2026-04-12T12:00:00+09:00'),gen_random_uuid());
  a:=jsonb_build_object('stock_code','999999','stock_name','자동검증','existing_shares',1,'new_shares',1,
    'ex_date','2026-07-24','record_date','2026-07-27','expected_credit_date','2026-08-18','source_url','https://kind.krx.co.kr/');
  preview:=public.sss_preview_bonus(a);
  if (preview->'positions'->0->>'quantity')::numeric<>12 then raise exception 'preview quantity'; end if;
  result:=public.sss_apply_bonus(a,preview->>'token',req); action_id:=(result->>'id')::uuid;
  perform public.sss_apply_bonus(a,preview->>'token',req);
  state:=public.sss_ca_state(p);
  if (state->>'quantity')::numeric<>12 or (state->>'averagePrice')::numeric<>37750
    or (state->>'cost')::numeric<>453000 or (state->>'tradableQuantity')::numeric<>6 then raise exception 'bonus balance'; end if;
  select base_amount into original_base from public.members where id=m;
  if original_base<>500000 then raise exception 'bonus cash changed'; end if;
  rejected:=false;
  begin
    perform public.sss_submit_trade(jsonb_build_object('member_id',m,'pick_id',p,'trade_type','sell','stock_name','자동검증',
      'quantity',7,'price',40000,'traded_at','2026-08-01T12:00:00+09:00'),gen_random_uuid());
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'pending oversell accepted'; end if;
  payload:=jsonb_build_object('member_id',m,'pick_id',p,'trade_type','sell','stock_name','자동검증',
    'quantity',6,'price',40000,'traded_at','2026-08-01T12:00:00+09:00');
  perform public.sss_submit_trade(payload,trade_req);
  perform public.sss_submit_trade(payload,trade_req);
  state:=public.sss_ca_state(p);
  if (state->>'pendingQuantity')::numeric<>6 or (state->>'cost')::numeric<>226500 then raise exception 'rights lost after sell'; end if;
  select base_amount into original_base from public.members where id=m;
  if original_base<>512100 then raise exception 'settlement expected 512100, got %',original_base; end if;
  if (select count(*) from public.trades where pick_id=p)<>2 then raise exception 'duplicate trade'; end if;
  req:=gen_random_uuid();
  perform public.sss_credit_bonus(action_id,'2026-08-18',req);
  perform public.sss_credit_bonus(action_id,'2026-08-18',req);
  state:=public.sss_ca_state(p);
  if (state->>'tradableQuantity')::numeric<>6 or (state->>'pendingQuantity')::numeric<>0 then raise exception 'credit failed'; end if;
  perform public.sss_submit_trade(jsonb_build_object('member_id',m,'pick_id',p,'trade_type','sell','stock_name','자동검증',
    'quantity',6,'price',50000,'traded_at','2026-09-01T12:00:00+09:00'),gen_random_uuid());
  state:=public.sss_ca_state(p);
  if (state->>'quantity')::numeric<>0 or (state->>'cost')::numeric<>0 then raise exception 'final balance'; end if;
  select base_amount into original_base from public.members where id=m;
  if original_base<>584020 then raise exception 'second settlement expected 584020, got %',original_base; end if;
  rejected:=false;
  begin perform public.sss_reverse_bonus(action_id,'취소 검증',gen_random_uuid()); exception when others then rejected:=true; end;
  if not rejected then raise exception 'invalid reversal accepted'; end if;
  if (select status from public.corporate_actions where id=action_id)<>'applied' then raise exception 'reversal rollback failed'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated','email','nonadmin@example.invalid')::text,true);
  rejected:=false;
  begin perform public.sss_preview_bonus(a); exception when others then rejected:=true; end;
  if not rejected then raise exception 'nonadmin access accepted'; end if;
  rejected:=false;
  begin perform public.sss_submit_trade(payload,gen_random_uuid()); exception when others then rejected:=true; end;
  if not rejected then raise exception 'other member trade accepted'; end if;
end $$;
select 'PASS: bonus, cost, pending rights, credit, partial sales, fees, idempotency, reversal rollback, permissions' as result;
