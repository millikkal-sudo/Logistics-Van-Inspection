-- =====================================================================
-- Photo and note become optional on a failed check. The cause does not.
--
-- Rollout decision: a required photo was costing more in adoption than
-- it was returning in evidence. The cause is the field the reports
-- actually depend on, so that stays mandatory.
--
-- To reverse this, re-add the constraint below and flip the two checks
-- in inspectionRepository.assertEvidenceComplete.
-- =====================================================================

alter table inspection_results
  drop constraint if exists failure_needs_note;

-- The cause is now the one thing a failure cannot be filed without.
-- Enforced in the API rather than here, because a check with no cause
-- options configured must still be submittable.

select
  (select count(*) from pg_constraint where conname = 'failure_needs_note') as note_constraint_removed;
