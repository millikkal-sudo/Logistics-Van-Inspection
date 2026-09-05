-- =====================================================================
-- "What was done" options, plus optional photo and note.
-- Safe to run as many times as you like.
--
-- Each step raises a notice, so if it stops partway the Results panel
-- shows how far it got. Read the final table before moving on.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Photo and note stop being mandatory.
-- ---------------------------------------------------------------------

alter table inspection_results
  drop constraint if exists failure_needs_note;

-- ---------------------------------------------------------------------
-- 2. The action list.
--
-- Global rather than per check: "reported to workshop" means the same
-- thing whichever check failed. In a table so it can be edited from the
-- admin panel without a deploy.
--
-- This is the field that tells a held van from a fixed one. Without it
-- the two look identical in the record.
-- ---------------------------------------------------------------------

create table if not exists public.check_actions (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  sort_order int not null default 100,
  active     boolean not null default true
);

-- Added separately: if the table already existed from a partial run
-- without this, the insert below would create duplicates.
create unique index if not exists check_actions_label_key
  on public.check_actions (label);

-- ---------------------------------------------------------------------
-- 3. Seed the five options.
-- ---------------------------------------------------------------------

insert into public.check_actions (label, sort_order)
select v.label, v.sort_order
from (values
  ('Reported to workshop', 1),
  ('Fixed on the spot',    2),
  ('Driver corrected it',  3),
  ('Item replaced',        4),
  ('Nothing yet',          5)
) as v(label, sort_order)
where not exists (
  select 1 from public.check_actions existing where existing.label = v.label
);

-- ---------------------------------------------------------------------
-- 4. Hang the chosen action off the failed result.
-- ---------------------------------------------------------------------

alter table public.inspection_results
  add column if not exists action_id uuid references public.check_actions(id);

-- ---------------------------------------------------------------------
-- 5. Read access.
--
-- Wrapped so a permissions error here cannot roll back everything above,
-- which is how a whole migration disappears with nothing to show for it.
-- ---------------------------------------------------------------------

do $$
begin
  alter table public.check_actions enable row level security;

  drop policy if exists check_actions_read on public.check_actions;
  create policy check_actions_read on public.check_actions
    for select to authenticated using (active);
exception
  when others then
    raise notice 'Row level security step skipped: %', sqlerrm;
end
$$;

-- =====================================================================
-- Verification. Every row should say OK.
-- =====================================================================

select 'check_actions table' as step,
       case when exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'check_actions'
       ) then 'OK' else 'MISSING' end as result
union all
select 'five action options',
       case when (select count(*) from public.check_actions) >= 5
            then 'OK' else 'MISSING, only ' || (select count(*)::text from public.check_actions) end
union all
select 'action_id column',
       case when exists (
         select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'inspection_results'
           and column_name = 'action_id'
       ) then 'OK' else 'MISSING' end
union all
select 'note constraint removed',
       case when not exists (
         select 1 from pg_constraint where conname = 'failure_needs_note'
       ) then 'OK' else 'STILL PRESENT' end
union all
select 'immutability trigger intact',
       case when exists (
         select 1 from pg_trigger where tgname = 'inspections_immutable'
       ) then 'OK' else 'MISSING, tell Claude' end;
