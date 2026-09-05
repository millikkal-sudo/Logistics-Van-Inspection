-- =====================================================================
-- Two fixes for the report reading wrong.
--
-- 1. "Van temperature" reads oddly on a transfer truck.
-- 2. Trucks are still filed under Dubai, so a truck check lands in
--    Dubai's compliance figure. In the report above, Dubai showed 0%
--    when no Dubai van had been inspected at all.
--
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The checklist is shared by vans and trucks, so the labels should be.
-- ---------------------------------------------------------------------

update check_items set label = 'Vehicle temperature'
 where code = 'temp';

update check_items set help_text = 'Must read 0-5 °C at the loading point'
 where code = 'temp';

-- ---------------------------------------------------------------------
-- 2. Transfer trucks become their own area.
--
-- Done as data: areas already drive the inspector's list, the by-area
-- breakdown and the Slack grouping, so one row gets all of that with no
-- special cases anywhere.
-- ---------------------------------------------------------------------

insert into areas (name, code, sort_order)
values ('Transfer Trucks', 'TRK', 99)
on conflict (name) do nothing;

update vans
   set area_id = (select id from areas where code = 'TRK')
 where vehicle_type = 'truck';

-- Crews follow their vehicle. A driver left in Dubai while their truck
-- sits in Transfer Trucks drops off the inspector's list entirely, since
-- the two have to match for the vehicle to be pickable.
update drivers d
   set area_id = (select id from areas where code = 'TRK')
  from vans v
 where d.default_van = v.id
   and v.vehicle_type = 'truck';

update drivers h
   set area_id = d.area_id
  from drivers d
 where h.partner_id = d.id
   and d.area_id = (select id from areas where code = 'TRK');

-- ---------------------------------------------------------------------
-- Verify. trucks_still_elsewhere must be 0.
-- Past inspections keep the area they were filed under, which is
-- correct: the record should say where the check actually happened.
-- ---------------------------------------------------------------------

select
  (select label from check_items where code = 'temp')               as temperature_label,
  (select count(*) from vans where vehicle_type = 'truck')          as total_trucks,
  (select count(*) from vans v join areas a on a.id = v.area_id
    where v.vehicle_type = 'truck' and a.code = 'TRK')              as trucks_in_own_area,
  (select count(*) from vans v left join areas a on a.id = v.area_id
    where v.vehicle_type = 'truck' and a.code is distinct from 'TRK') as trucks_still_elsewhere,
  (select count(*) from drivers d join areas a on a.id = d.area_id
    where a.code = 'TRK')                                           as crew_moved;
