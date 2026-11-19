-- 발표 편집 충돌 감지. 기존 발표 내용과 접근 권한은 변경하지 않습니다.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.presentations
  add column if not exists edit_revision bigint not null default 0;

create or replace function public.bump_presentation_edit_revision()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.edit_revision := 0;
  else
    new.edit_revision := old.edit_revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_presentation_edit_revision on public.presentations;
create trigger bump_presentation_edit_revision
before insert or update on public.presentations
for each row execute function public.bump_presentation_edit_revision();

notify pgrst, 'reload schema';
commit;

-- 적용 확인: true / true이면 준비 완료입니다.
select
  exists(select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'presentations'
      and column_name = 'edit_revision') as revision_column_ready,
  exists(select 1 from pg_trigger
    where tgrelid = 'public.presentations'::regclass
      and tgname = 'bump_presentation_edit_revision' and tgenabled = 'O') as revision_trigger_ready;
