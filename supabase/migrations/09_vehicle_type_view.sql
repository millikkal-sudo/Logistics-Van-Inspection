-- =====================================================================
-- Expose the vehicle type on the reporting view.
--
-- The report needs to say "8 Vans & 2 Trucks", which means knowing which
-- is which. Falls back to 'van' for a record whose vehicle has since
-- been deleted, so an old row still counts rather than disappearing.
--
-- Safe to re-run.
-- =====================================================================

drop view if exists v_inspection_summary;

create view v_inspection_summary as
select
  i.id,
  i.performed_at,
  coalesce(v.plate, i.van_plate_text, 'Deleted vehicle')      as plate,
  coalesce(v.vehicle_type::text, 'van')                       as vehicle_type,
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

select
  count(*) filter (where vehicle_type = 'van')   as van_inspections,
  count(*) filter (where vehicle_type = 'truck') as truck_inspections
from v_inspection_summary;
