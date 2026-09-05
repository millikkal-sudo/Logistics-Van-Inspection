-- =====================================================================
-- Areas (emirates) + manager dashboard support
-- Run AFTER 20260820000000_schema.sql. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Areas
-- ---------------------------------------------------------------------

create table if not exists areas (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  code       text not null unique,
  active     boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

insert into areas (name, code, sort_order) values
  ('Dubai',          'DXB', 1),
  ('Abu Dhabi',      'AUH', 2),
  ('Sharjah',        'SHJ', 3),
  ('Al Ain',         'AAN', 4),
  ('Ajman',          'AJM', 5),
  ('Fujairah',       'FUJ', 6),
  ('Umm Al Quwain',  'UAQ', 7),
  ('Ras Al Khaimah', 'RAK', 8)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- Scope vans, drivers and people to an area
-- ---------------------------------------------------------------------

alter table vans     add column if not exists area_id uuid references areas(id);
alter table drivers  add column if not exists area_id uuid references areas(id);

-- A supervisor's home area. Null means they work across all areas,
-- which is how managers and admins are set up.
alter table profiles add column if not exists area_id uuid references areas(id);

create index if not exists vans_area_idx    on vans (area_id) where active;
create index if not exists drivers_area_idx on drivers (area_id) where active;

-- Backfill from the existing plate prefixes so nothing is orphaned.
update vans set area_id = (select id from areas where code = 'DXB')
  where area_id is null and plate like 'DXB-%';
update vans set area_id = (select id from areas where code = 'AUH')
  where area_id is null and plate like 'AUH-%';
update vans set area_id = (select id from areas where code = 'SHJ')
  where area_id is null and plate like 'SHJ-%';

-- Anything still unassigned goes to Dubai rather than disappearing from
-- the app. A van nobody can select is worse than one in the wrong area.
update vans set area_id = (select id from areas where code = 'DXB')
  where area_id is null;

-- A driver inherits the area of the van they are assigned to.
update drivers d
   set area_id = v.area_id
  from vans v
 where d.default_van = v.id
   and d.area_id is null;

update drivers set area_id = (select id from areas where code = 'DXB')
  where area_id is null;

-- ---------------------------------------------------------------------
-- Record the area on each inspection.
--
-- Denormalised deliberately: a van can be reassigned to another area
-- later, and an audit needs to show where the check actually happened,
-- not where the van lives today.
-- ---------------------------------------------------------------------

alter table inspections add column if not exists area_id uuid references areas(id);

-- The immutability trigger blocks UPDATE on inspections by design. It is
-- dropped for this one backfill and recreated immediately, inside the
-- same transaction, so it is never absent while the app is running.
drop trigger if exists inspections_immutable on inspections;

update inspections i
   set area_id = v.area_id
  from vans v
 where i.van_id = v.id
   and i.area_id is null;

create trigger inspections_immutable
  before update or delete on inspections
  for each row execute function prevent_mutation();

create index if not exists inspections_area_idx
  on inspections (area_id, performed_at desc);

-- ---------------------------------------------------------------------
-- Reporting view, now carrying the area
-- ---------------------------------------------------------------------

drop view if exists v_inspection_summary;

create view v_inspection_summary as
select
  i.id,
  i.performed_at,
  v.plate,
  coalesce(a.name, 'Unassigned') as area_name,
  a.id                           as area_id,
  d.full_name as driver_name,
  p.full_name as inspector_name,
  i.status,
  i.dispatch_blocked,
  (select count(*) from inspection_results r
     where r.inspection_id = i.id and not r.passed) as failed_count,
  (select r.numeric_value from inspection_results r
     join check_items c on c.id = r.check_item_id
     where r.inspection_id = i.id and c.code = 'temp') as temp_reading_c
from inspections i
join vans v      on v.id = i.van_id
join drivers d   on d.id = i.driver_id
join profiles p  on p.id = i.inspector_id
left join areas a on a.id = i.area_id
where not exists (
  select 1 from inspections newer where newer.supersedes_id = i.id
);

-- ---------------------------------------------------------------------
-- RLS read policy for areas
-- ---------------------------------------------------------------------

alter table areas enable row level security;

drop policy if exists areas_read on areas;
create policy areas_read on areas
  for select to authenticated using (active);

-- ---------------------------------------------------------------------
-- Verify the trigger is back. Expected: one row, inspections_immutable.
-- ---------------------------------------------------------------------

select tgname as restored_trigger
from pg_trigger
where tgname = 'inspections_immutable';
