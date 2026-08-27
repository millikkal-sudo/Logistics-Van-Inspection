-- =====================================================================
-- Transfer trucks.
--
-- A truck is still a plate with a crew that gets checked before it
-- leaves, so it lives in the vans table with a type rather than in a
-- table of its own. A parallel table would mean duplicating inspections,
-- coverage, the training queue and every report.
--
-- Run AFTER 20260821160000_actions.sql. Safe to re-run.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vehicle_type') then
    create type vehicle_type as enum ('van', 'truck');
  end if;
end
$$;

alter table vans
  add column if not exists vehicle_type vehicle_type not null default 'van';

create index if not exists vans_type_idx on vans (vehicle_type, area_id) where active;

-- ---------------------------------------------------------------------
-- Which checks apply to which vehicle.
--
-- An array rather than a boolean per type: adding a third vehicle later
-- is a data change, not a migration.
-- ---------------------------------------------------------------------

alter table check_items
  add column if not exists vehicle_types text[] not null default array['van', 'truck'];

-- Trucks carry bags in cages, not loose stock on a matted floor, so
-- these two do not apply.
update check_items
   set vehicle_types = array['van']
 where code in ('curtains', 'mats');

-- Everything else applies to both. Stated explicitly so a partial
-- earlier run cannot leave an item applying to nothing.
update check_items
   set vehicle_types = array['van', 'truck']
 where code not in ('curtains', 'mats');

-- ---------------------------------------------------------------------
-- Verification. Expect 5 checks for trucks, 7 for vans.
-- ---------------------------------------------------------------------

select
  (select count(*) from check_items
     where active and 'van' = any(vehicle_types))   as checks_for_vans,
  (select count(*) from check_items
     where active and 'truck' = any(vehicle_types)) as checks_for_trucks,
  (select count(*) from vans where vehicle_type = 'truck') as trucks_so_far;
