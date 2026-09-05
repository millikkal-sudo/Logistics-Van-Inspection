-- =====================================================================
-- Enhancements: helpers, simplified drivers, revised checklist
-- Run AFTER 20260821000000_areas.sql. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Drivers become "staff": a driver, or a helper paired to one driver.
-- A helper works the same van as their driver, so the van and area are
-- inherited rather than set separately — two places to record the same
-- fact is two places for it to drift.
-- ---------------------------------------------------------------------

alter table drivers drop column if exists employee_id;
alter table drivers drop column if exists route;

alter table drivers add column if not exists staff_role text not null default 'driver';
alter table drivers add column if not exists partner_id uuid references drivers(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drivers_staff_role_check'
  ) then
    alter table drivers
      add constraint drivers_staff_role_check
      check (staff_role in ('driver', 'helper'));
  end if;

  -- A helper must be paired to someone; a driver must not be.
  if not exists (
    select 1 from pg_constraint where conname = 'drivers_pairing_check'
  ) then
    alter table drivers
      add constraint drivers_pairing_check
      check (
        (staff_role = 'helper' and partner_id is not null)
        or (staff_role = 'driver' and partner_id is null)
      );
  end if;
end
$$;

-- One helper per driver.
create unique index if not exists drivers_one_helper_per_driver
  on drivers (partner_id)
  where staff_role = 'helper' and active;

create index if not exists drivers_staff_role_idx on drivers (staff_role) where active;

-- ---------------------------------------------------------------------
-- Record the helper on the inspection too. Denormalised for the same
-- reason as the area: pairings change, and an audit needs to show who
-- was actually on the van that morning.
-- ---------------------------------------------------------------------

alter table inspections add column if not exists helper_id uuid references drivers(id);

-- ---------------------------------------------------------------------
-- Every van runs 0-5 °C. The per-van columns stay so a future exception
-- is a row edit rather than a migration, but nothing sets them any more.
-- ---------------------------------------------------------------------

alter table vans alter column temp_min_c set default 0.0;
alter table vans alter column temp_max_c set default 5.0;
update vans set temp_min_c = 0.0, temp_max_c = 5.0
  where temp_min_c is distinct from 0.0 or temp_max_c is distinct from 5.0;

-- ---------------------------------------------------------------------
-- Checklist changes.
--
-- load_area is UPDATED rather than replaced: its id is referenced by
-- every inspection_result already filed. Inserting a new row and
-- deactivating the old one would orphan that history behind a check
-- nobody can see.
-- ---------------------------------------------------------------------

update check_items
   set code      = 'hygiene',
       label     = 'Personal Hygiene & Grooming',
       help_text = 'Clean hands, trimmed nails, hair covered, no jewellery'
 where code = 'load_area';

insert into check_items (code, label, help_text, input_type, critical, sort_order)
values ('uniform', 'Uniform', 'Clean, complete and correctly worn', 'boolean', false, 7)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Area reports are not tied to a single inspection.
-- ---------------------------------------------------------------------

alter table alerts alter column inspection_id drop not null;

-- ---------------------------------------------------------------------
-- Reporting view, now carrying the helper
-- ---------------------------------------------------------------------

drop view if exists v_inspection_summary;

create view v_inspection_summary as
select
  i.id,
  i.performed_at,
  v.plate,
  coalesce(a.name, 'Unassigned') as area_name,
  a.id                           as area_id,
  d.full_name  as driver_name,
  h.full_name  as helper_name,
  p.full_name  as inspector_name,
  i.status,
  i.dispatch_blocked,
  i.notes,
  (select count(*) from inspection_results r
     where r.inspection_id = i.id and not r.passed) as failed_count,
  (select r.numeric_value from inspection_results r
     join check_items c on c.id = r.check_item_id
     where r.inspection_id = i.id and c.code = 'temp') as temp_reading_c
from inspections i
join vans v       on v.id = i.van_id
join drivers d    on d.id = i.driver_id
join profiles p   on p.id = i.inspector_id
left join drivers h on h.id = i.helper_id
left join areas a on a.id = i.area_id
where not exists (
  select 1 from inspections newer where newer.supersedes_id = i.id
);

-- ---------------------------------------------------------------------
-- Verify. Expected: the trigger still exists, and 7 active check items
-- ending with Personal Hygiene & Grooming and Uniform.
-- ---------------------------------------------------------------------

select
  (select count(*) from pg_trigger where tgname = 'inspections_immutable') as immutability_trigger,
  (select count(*) from check_items where active) as active_checks;
