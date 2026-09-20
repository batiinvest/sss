-- Read-only preflight. Run in the project's SQL editor before migrating.
-- Returns schema/rules, not credentials or personal account data.
select jsonb_build_object(
  'columns', (select jsonb_agg(to_jsonb(c)) from (
    select table_name, column_name, data_type, udt_name, column_default, is_nullable
    from information_schema.columns where table_schema = 'public'
      and table_name in ('picks', 'picks_with_trades', 'trades', 'settlements', 'members', 'app_settings')
    order by table_name, ordinal_position
  ) c),
  'triggers', (select jsonb_agg(to_jsonb(t)) from (
    select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition,
      p.proname, pg_get_functiondef(p.oid) as function_definition
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and not t.tgisinternal
      and c.relname in ('picks', 'trades', 'settlements', 'members')
  ) t),
  'view', pg_get_viewdef('public.picks_with_trades'::regclass, true),
  'policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname = 'public'
    and tablename in ('picks', 'trades', 'settlements', 'members', 'app_settings')),
  'constraints', (select jsonb_agg(to_jsonb(c)) from (
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint where conrelid in ('public.picks'::regclass, 'public.trades'::regclass,
      'public.settlements'::regclass, 'public.members'::regclass)
  ) c)
) as schema_review;
