-- =====================================================================
-- Remove the approval queue.
--
-- Run this AFTER deploying the code, not before: the app stops writing
-- to these first.
--
-- Anything still sitting unapproved was never applied and is not
-- recoverable from here, so check before dropping:
--
--   select summary, requested_at from pending_changes where status = 'pending';
-- =====================================================================

drop table if exists pending_changes;

do $$
begin
  if exists (select 1 from pg_type where typname = 'change_status') then
    drop type change_status;
  end if;
end
$$;

-- The flag stays on profiles. It costs nothing, and leaving it means
-- turning approvals back on later is a code change rather than a
-- migration.

select
  (select count(*) from information_schema.tables
    where table_name = 'pending_changes') as queue_table_should_be_zero,
  (select count(*) from profiles where is_approver) as approver_flag_kept;
