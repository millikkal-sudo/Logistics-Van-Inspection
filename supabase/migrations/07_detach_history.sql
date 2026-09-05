-- =====================================================================
-- Delete vans and drivers freely. Inspections survive.
--
-- Run each STEP separately: select the block, then Run. If one fails you
-- will know which, instead of losing the whole file to a rollback.
--
-- Why: history currently depends on the fleet rows, so a delete is
-- refused. Copying the plate and names onto the inspection removes that
-- dependency. Better for an audit trail regardless, since the record
-- should say what it said on the day rather than whatever the fleet
-- table holds now.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1. Columns to hold the names.
-- ---------------------------------------------------------------------

alter table inspections add column if not exists van_plate_text   text;
alter table inspections add column if not exists driver_name_text text;
alter table inspections add column if not exists helper_name_text text;
alter table inspections add column if not exists area_name_text   text;


-- ---------------------------------------------------------------------
-- STEP 2. Backfill.
--
-- The immutability trigger blocks UPDATE, so it comes off and goes
-- straight back on. Run this whole step in one go: leaving the trigger
-- off is the one state you do not want to stop in.
-- ---------------------------------------------------------------------

drop trigger if exists inspections_immutable on inspections;

update inspections i
   set van_plate_text = v.plate
  from vans v
 where i.van_id = v.id and i.van_plate_text is null;

update inspections i
   set area_name_text = a.name
  from vans v
  join areas a on a.id = v.area_id
 where i.van_id = v.id and i.area_name_text is null;

update inspections i
   set driver_name_text = d.full_name
  from drivers d
 where i.driver_id = d.id and i.driver_name_text is null;

update inspections i
   set helper_name_text = h.full_name
  from drivers h
 where i.helper_id = h.id and i.helper_name_text is null;

create trigger inspections_immutable
  before update or delete on inspections
  for each row execute function prevent_mutation();


-- ---------------------------------------------------------------------
-- STEP 3. The links become optional and clear themselves on delete.
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

alter table drivers drop constraint if exists drivers_default_van_fkey;
alter table drivers add  constraint drivers_default_van_fkey
  foreign key (default_van) references vans(id) on delete set null;


-- ---------------------------------------------------------------------
-- STEP 4. The reporting view reads the stored text as a fallback.
--
-- coalesce, not a plain join: while the van exists the join gives the
-- current name, and the stored value is what survives it.
-- ---------------------------------------------------------------------

drop view if exists v_inspection_summary;

create view v_inspection_summary as
select
  i.id,
  i.performed_at,
  coalesce(v.plate, i.van_plate_text, 'Deleted vehicle')      as plate,
  coalesce(a.name, i.area_name_text, 'Unassigned')            as area_name,
  a.id                                                        as area_id,
  coalesce(d.full_name, i.driver_name_text, 'Deleted driver') as driver_name,
  d.id                                                        as driver_id,
  coalesce(h.full_name, i.helper_name_text)                   as helper_name,
  h.id                                                        as helper_id,
  p.full_name                                                 as inspector_name,
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
-- STEP 5. Verify. missing_plate and missing_driver must be 0,
-- trigger_intact must be 1.
-- ---------------------------------------------------------------------

select
  (select count(*) from inspections)                                as total,
  (select count(*) from inspections where van_plate_text is null)   as missing_plate,
  (select count(*) from inspections where driver_name_text is null) as missing_driver,
  (select count(*) from pg_trigger
     where tgname = 'inspections_immutable')                        as trigger_intact;
