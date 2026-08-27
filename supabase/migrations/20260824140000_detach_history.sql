-- =====================================================================
-- Delete vans and drivers freely. Inspections survive.
--
-- Today a delete is refused once anything references the record, because
-- removing it would break the foreign key or take the history with it.
--
-- The fix is to stop the history depending on those rows at all. The
-- plate and the names are copied onto the inspection when it is filed,
-- so the record reads correctly forever, and the links become optional.
--
-- This is better for an audit trail regardless: the record should say
-- what it said on the day, not whatever the fleet table happens to hold
-- now. A van renamed next year must not rewrite last year's checks.
--
-- Run AFTER 20260822090000_trucks.sql. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The names, stored on the inspection itself.
-- ---------------------------------------------------------------------

alter table inspections add column if not exists van_plate_text   text;
alter table inspections add column if not exists driver_name_text text;
alter table inspections add column if not exists helper_name_text text;
alter table inspections add column if not exists area_name_text   text;

-- Backfill from what the links currently point at. The immutability
-- trigger blocks UPDATE, so it comes off for this and goes straight
-- back on inside the same transaction.
begin;

drop trigger if exists inspections_immutable on inspections;

update inspections i
   set van_plate_text   = coalesce(i.van_plate_text, v.plate),
       driver_name_text = coalesce(i.driver_name_text, d.full_name),
       helper_name_text = coalesce(i.helper_name_text, h.full_name),
       area_name_text   = coalesce(i.area_name_text, a.name)
  from vans v
  left join areas a on a.id = v.area_id
  left join drivers d on d.id = i.driver_id
  left join drivers h on h.id = i.helper_id
 where i.van_id = v.id
   and (i.van_plate_text is null or i.driver_name_text is null);

create trigger inspections_immutable
  before update or delete on inspections
  for each row execute function prevent_mutation();

commit;

-- ---------------------------------------------------------------------
-- 2. The links become optional, and clear themselves on delete.
-- ---------------------------------------------------------------------

alter table inspections alter column van_id    drop not null;
alter table inspections alter column driver_id drop not null;

alter table inspections drop constraint if exists inspections_van_id_fkey;
alter table inspections add  constraint inspections_van_id_fkey
  foreign key (van_id) references vans(id) on delete set null;

alter table inspections drop constraint if exists inspections_driver_id_fkey;
alter table inspections add  constraint inspections_driver_id_fkey
  foreign key (driver_id) references drivers(id) on delete set null;

alter table inspections drop constraint if exists inspections_helper_id_fkey;
alter table inspections add  constraint inspections_helper_id_fkey
  foreign key (helper_id) references drivers(id) on delete set null;

alter table inspections drop constraint if exists inspections_area_id_fkey;
alter table inspections add  constraint inspections_area_id_fkey
  foreign key (area_id) references areas(id) on delete set null;

-- A driver assigned to a deleted van simply loses the assignment.
alter table drivers drop constraint if exists drivers_default_van_fkey;
alter table drivers add  constraint drivers_default_van_fkey
  foreign key (default_van) references vans(id) on delete set null;

-- ---------------------------------------------------------------------
-- 3. The reporting view reads the stored text first.
--
-- coalesce, not a plain join: the join still works while the van exists
-- and gives the current name, but the stored value is what survives.
-- ---------------------------------------------------------------------

drop view if exists v_inspection_summary;

create view v_inspection_summary as
select
  i.id,
  i.performed_at,
  coalesce(v.plate, i.van_plate_text, 'Deleted vehicle')        as plate,
  coalesce(a.name, i.area_name_text, 'Unassigned')              as area_name,
  a.id                                                          as area_id,
  coalesce(d.full_name, i.driver_name_text, 'Deleted driver')   as driver_name,
  d.id                                                          as driver_id,
  coalesce(h.full_name, i.helper_name_text)                     as helper_name,
  h.id                                                          as helper_id,
  p.full_name  as inspector_name,
  i.status,
  i.dispatch_blocked,
  i.training_flag,
  i.notes,
  (select count(*) from inspection_results r
     where r.inspection_id = i.id and not r.passed) as failed_count,
  (select r.numeric_value from inspection_results r
     join check_items c on c.id = r.check_item_id
     where r.inspection_id = i.id and c.code = 'temp') as temp_reading_c
from inspections i
left join vans v    on v.id = i.van_id
left join drivers d on d.id = i.driver_id
left join drivers h on h.id = i.helper_id
left join areas a   on a.id = i.area_id
join profiles p     on p.id = i.inspector_id
where not exists (
  select 1 from inspections newer where newer.supersedes_id = i.id
);

-- ---------------------------------------------------------------------
-- Verification. Every inspection should carry a plate and a driver name,
-- and the trigger must still be in place.
-- ---------------------------------------------------------------------

select
  (select count(*) from inspections)                                as total,
  (select count(*) from inspections where van_plate_text is null)   as missing_plate,
  (select count(*) from inspections where driver_name_text is null) as missing_driver,
  (select count(*) from pg_trigger
     where tgname = 'inspections_immutable')                        as trigger_intact;
