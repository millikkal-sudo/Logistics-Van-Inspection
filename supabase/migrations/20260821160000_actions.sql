-- =====================================================================
-- Optional evidence, plus a tappable "what was done".
-- Run AFTER 20260821140000_causes.sql. Safe to re-run.
--
-- Rollout decision: a required photo and a required typed note were
-- costing more in adoption than they returned. The cause is the field
-- the reports depend on, so that stays required. Everything else is
-- optional and tappable.
--
-- To reverse, re-add the constraint at the bottom of this file and flip
-- the checks in inspectionRepository.assertEvidenceComplete.
-- =====================================================================

alter table inspection_results
  drop constraint if exists failure_needs_note;

-- ---------------------------------------------------------------------
-- What was done about it.
--
-- Global rather than per check: "reported to workshop" means the same
-- thing whichever check failed. In a table, not in code, so the list can
-- be edited without a deploy.
--
-- This is the field that tells a held van from a fixed one. Without it
-- the two look identical in the record.
-- ---------------------------------------------------------------------

create table if not exists check_actions (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  sort_order int not null default 100,
  active     boolean not null default true
);

alter table check_actions enable row level security;

drop policy if exists check_actions_read on check_actions;
create policy check_actions_read on check_actions
  for select to authenticated using (active);

insert into check_actions (label, sort_order) values
  ('Reported to workshop', 1),
  ('Fixed on the spot',    2),
  ('Driver corrected it',  3),
  ('Item replaced',        4),
  ('Nothing yet',          5)
on conflict (label) do nothing;

alter table inspection_results
  add column if not exists action_id uuid references check_actions(id);

-- ---------------------------------------------------------------------
-- Verify. Expect 5 actions and 0 for the removed constraint.
-- ---------------------------------------------------------------------

select
  (select count(*) from check_actions where active) as actions,
  (select count(*) from pg_constraint
     where conname = 'failure_needs_note')          as note_constraint_should_be_zero;
