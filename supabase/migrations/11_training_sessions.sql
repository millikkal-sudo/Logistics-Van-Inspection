-- =====================================================================
-- Recording that training was done.
--
-- Without this the queue only grows: someone trained on Monday is still
-- listed on Friday, and a list that never empties stops being read.
--
-- A session is dated rather than being a "done" flag. The queue then
-- counts only failures since the last session, so training resets the
-- clock and a person who slips again reappears on their own. A flag
-- would hide them permanently, which is the wrong answer.
--
-- Safe to re-run.
-- =====================================================================

create table if not exists training_sessions (
  id           uuid primary key default gen_random_uuid(),
  /** The driver or helper trained. */
  person_id    uuid not null references drivers(id) on delete cascade,
  /** Kept as text so the record survives the person being deleted. */
  person_name  text not null,
  topic        text,
  note         text,
  completed_at timestamptz not null default now(),
  completed_by uuid references profiles(id)
);

create index if not exists training_sessions_person_idx
  on training_sessions (person_id, completed_at desc);

alter table training_sessions enable row level security;

drop policy if exists training_sessions_read on training_sessions;
create policy training_sessions_read on training_sessions
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- Verify.
-- ---------------------------------------------------------------------

select
  (select count(*) from information_schema.tables
    where table_name = 'training_sessions') as table_created,
  (select count(*) from training_sessions)  as sessions_logged;
