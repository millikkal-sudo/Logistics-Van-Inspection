-- =====================================================================
-- Cause options per check, plus the inspector's training call.
-- Run AFTER 20260821120000_enhancements.sql. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Causes live in a table, not in code. When Kuldeep says "add missing
-- gloves to the uniform list" that is a row, not a deploy.
--
-- The category is never shown to the inspector. It is what lets the
-- reports answer "is this a training problem or a stores problem",
-- without asking someone standing in a yard at 06:30 to make that call.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'cause_category') then
    create type cause_category as enum (
      'supply',     -- something was not issued or has run out
      'standards',  -- issued and available, not maintained
      'wear',       -- worn out, needs replacing
      'equipment',  -- a device or fitting has failed
      'behaviour',  -- a person did not do what they know to do
      'other'
    );
  end if;
end
$$;

create table if not exists check_causes (
  id            uuid primary key default gen_random_uuid(),
  check_item_id uuid not null references check_items(id) on delete cascade,
  label         text not null,
  category      cause_category not null default 'other',
  sort_order    int not null default 100,
  active        boolean not null default true,
  unique (check_item_id, label)
);

create index if not exists check_causes_item_idx
  on check_causes (check_item_id, sort_order) where active;

alter table check_causes enable row level security;

drop policy if exists check_causes_read on check_causes;
create policy check_causes_read on check_causes
  for select to authenticated using (active);

-- ---------------------------------------------------------------------
-- The chosen cause hangs off the individual failed result.
-- ---------------------------------------------------------------------

alter table inspection_results
  add column if not exists cause_id uuid references check_causes(id);

-- ---------------------------------------------------------------------
-- The training call is per inspection, not per check, and it names who.
-- A van carries a driver and a helper: flagging "the driver" for a
-- uniform failure that was the helper's is both wrong and unfair.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'training_flag') then
    create type training_flag as enum ('none', 'driver', 'helper', 'both');
  end if;
end
$$;

alter table inspections
  add column if not exists training_flag training_flag not null default 'none';

create index if not exists inspections_training_idx
  on inspections (training_flag, performed_at desc)
  where training_flag <> 'none';

-- ---------------------------------------------------------------------
-- Seed the lists
-- ---------------------------------------------------------------------

insert into check_causes (check_item_id, label, category, sort_order)
select c.id, v.label, v.category::cause_category, v.sort_order
from (values
  -- Uniform
  ('uniform',  'Missing shoes',             'supply',    1),
  ('uniform',  'Dirty shoes',               'standards', 2),
  ('uniform',  'Missing black pants',       'supply',    3),
  ('uniform',  'Missing black t-shirt',     'supply',    4),
  ('uniform',  'Torn t-shirt',              'wear',      5),
  ('uniform',  'Other',                     'other',     99),

  -- Personal Hygiene & Grooming
  ('hygiene',  'Long beard',                'standards', 1),
  ('hygiene',  'Long hair',                 'standards', 2),
  ('hygiene',  'Bad hair grooming',         'standards', 3),
  ('hygiene',  'Bad beard grooming',        'standards', 4),
  ('hygiene',  'Other',                     'other',     99),

  -- Floor mats
  ('mats',     'Dirty mats',                'standards', 1),
  ('mats',     'Missing mats',              'supply',    2),
  ('mats',     'Broken mats',               'wear',      3),
  ('mats',     'Other',                     'other',     99),

  -- Plastic curtains
  ('curtains', 'Dirty plastic curtains',    'standards', 1),
  ('curtains', 'Missing plastic curtains',  'supply',    2),
  ('curtains', 'Broken plastic curtains',   'wear',      3),
  ('curtains', 'Other',                     'other',     99),

  -- Van temperature
  ('temp',     'Driver negligence',         'behaviour', 1),
  ('temp',     'Compressor fail',           'equipment', 2),
  ('temp',     'Other',                     'other',     99),

  -- Temperature sensor
  ('sensor',   'Not powered',               'equipment', 1),
  ('sensor',   'Not logging',               'equipment', 2),
  ('sensor',   'Sensor damaged',            'equipment', 3),
  ('sensor',   'Display faulty',            'equipment', 4),
  ('sensor',   'Other',                     'other',     99),

  -- GPS tracker
  ('gps',      'No signal',                 'equipment', 1),
  ('gps',      'Device missing',            'equipment', 2),
  ('gps',      'Device damaged',            'equipment', 3),
  ('gps',      'Not powered',               'equipment', 4),
  ('gps',      'Other',                     'other',     99)
) as v(code, label, category, sort_order)
join check_items c on c.code = v.code
on conflict (check_item_id, label) do nothing;

-- ---------------------------------------------------------------------
-- Reporting view, carrying the training flag
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
  d.id         as driver_id,
  h.full_name  as helper_name,
  h.id         as helper_id,
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
join vans v       on v.id = i.van_id
join drivers d    on d.id = i.driver_id
join profiles p   on p.id = i.inspector_id
left join drivers h on h.id = i.helper_id
left join areas a on a.id = i.area_id
where not exists (
  select 1 from inspections newer where newer.supersedes_id = i.id
);

-- ---------------------------------------------------------------------
-- Verify. Expect 7 checks, 33 causes, and the trigger still in place.
-- ---------------------------------------------------------------------

select
  (select count(*) from check_items where active)  as active_checks,
  (select count(*) from check_causes where active) as active_causes,
  (select count(*) from pg_trigger
     where tgname = 'inspections_immutable')       as immutability_trigger;
