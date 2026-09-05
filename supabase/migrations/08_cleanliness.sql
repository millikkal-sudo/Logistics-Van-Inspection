-- =====================================================================
-- Vehicle cleanliness check, for vans and trucks.
--
-- No code change: checks and their cause options are data.
-- Run AFTER 20260822090000_trucks.sql. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The check.
--
-- Not critical: a dirty vehicle is a standards failure to close out, not
-- a reason to hold the load. Change `critical` to true if that is wrong.
-- ---------------------------------------------------------------------

insert into check_items (code, label, help_text, input_type, critical, sort_order, vehicle_types)
values (
  'cleanliness',
  'Vehicle cleanliness',
  'Body, cabin and load area clean inside and out',
  'boolean',
  false,
  8,
  array['van', 'truck']
)
on conflict (code) do update
  set label         = excluded.label,
      help_text     = excluded.help_text,
      vehicle_types = excluded.vehicle_types,
      active        = true;

-- ---------------------------------------------------------------------
-- Cause options.
--
-- Categories are never shown to the inspector. They are what lets a
-- report tell a standards problem from a supply or equipment one.
-- ---------------------------------------------------------------------

insert into check_causes (check_item_id, label, category, sort_order)
select c.id, v.label, v.category::cause_category, v.sort_order
from (values
  ('Dirty exterior',        'standards', 1),
  ('Dirty cabin',           'standards', 2),
  ('Dirty load area',       'standards', 3),
  ('Spillage or stains',    'standards', 4),
  ('Rubbish left inside',   'standards', 5),
  ('Bad odour',             'standards', 6),
  ('Other',                 'other',     99)
) as v(label, category, sort_order)
join check_items c on c.code = 'cleanliness'
on conflict (check_item_id, label) do nothing;

-- ---------------------------------------------------------------------
-- Verification. Expect 8 checks for vans, 6 for trucks, 7 cleanliness
-- causes.
-- ---------------------------------------------------------------------

select
  (select count(*) from check_items
     where active and 'van' = any(vehicle_types))    as checks_for_vans,
  (select count(*) from check_items
     where active and 'truck' = any(vehicle_types))  as checks_for_trucks,
  (select count(*) from check_causes cc
     join check_items ci on ci.id = cc.check_item_id
    where ci.code = 'cleanliness' and cc.active)     as cleanliness_causes;
