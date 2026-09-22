begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare
  p public.presentations%rowtype;
  n bigint;
  accepted boolean;
begin
  -- The nested subtransaction also rolls back if an editor drops outer transaction statements.
  begin
  select * into strict p from public.presentations
  where stock_code ~ '^[0-9]{6}$' and coalesce(status, 'done') = 'done'
    and presented_at < (now() at time zone 'Asia/Seoul')::date
  order by presented_at limit 1;
  if has_function_privilege('authenticated',
    'public.apply_presentation_day_price(uuid,text,date,integer,numeric,timestamptz)', 'EXECUTE') then
    raise exception 'Authenticated clients must not call the price service';
  end if;
  accepted := public.apply_presentation_day_price(p.id, p.stock_code, p.presented_at, 100, 50, now());
  if not accepted then raise exception 'Valid close rejected'; end if;
  select count(*) into n from sss_audit.presentation_price_changes;
  perform public.apply_presentation_day_price(p.id, p.stock_code, p.presented_at, 100, 50, now());
  if (select count(*) from sss_audit.presentation_price_changes) <> n then
    raise exception 'Repeated close must not duplicate audit entries';
  end if;
  if public.apply_presentation_day_price(p.id, '999999', p.presented_at, 100, 50, now()) then
    raise exception 'Stale stock identity accepted';
  end if;
  if public.apply_presentation_day_price(p.id, p.stock_code, p.presented_at - 1, 100, 50, now()) then
    raise exception 'Stale presentation date accepted';
  end if;
  if public.apply_presentation_day_price(p.id, p.stock_code, p.presented_at, 100, 50, now() - interval '1 second') then
    raise exception 'Stale quote accepted';
  end if;
  update public.presentations set presented_at = presented_at - 1 where id = p.id;
  if exists(select 1 from public.presentations where id = p.id
    and (price_at is not null or price_adjusted_at is not null or price_source is not null)) then
    raise exception 'Date change failed to invalidate price';
  end if;
  update public.presentations set status = 'planned' where id = p.id;
  if public.apply_presentation_day_price(p.id, p.stock_code, p.presented_at - 1, 100, 50, now()) then
    raise exception 'Planned presentation accepted';
  end if;
  raise exception using errcode = 'P0099', message = 'Rollback successful test mutations';
  exception when sqlstate 'P0099' then null;
  end;
end;
$$;
rollback;
