-- =====================================================================
-- Calo UAE — Van pre-departure quality check
-- COMPLETE SCHEMA. Run this one file. Replaces both earlier migrations.
--
-- Safe to run more than once.
--
-- Storage policies are NOT created here. Supabase does not reliably
-- grant ownership of storage.objects to the SQL editor role, and a
-- failure there rolls back this entire file. Create the bucket and its
-- policies in the dashboard instead — instructions at the bottom.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums (create type has no IF NOT EXISTS)
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inspection_status') then
    create type inspection_status as enum ('compliant', 'noncompliant', 'action_required');
  end if;
  if not exists (select 1 from pg_type where typname = 'check_input_type') then
    create type check_input_type as enum ('boolean', 'temperature');
  end if;
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('supervisor', 'manager', 'admin');
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------

create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  full_name  text not null,
  role       user_role not null default 'supervisor',
  depot      text not null default 'Central Warehouse',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Password auth: the access boundary is account creation, not the email
-- domain. Only accounts created in Supabase exist, and public signup is
-- disabled in the dashboard. So this trigger just mirrors the new user
-- into profiles — it must never raise, or sign-in breaks.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      initcap(replace(split_part(new.email, '@', 1), '.', ' '))
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------
-- Fleet and checklist
-- ---------------------------------------------------------------------

create table if not exists vans (
  id         uuid primary key default gen_random_uuid(),
  plate      text not null unique,
  depot      text not null default 'Central Warehouse',
  temp_min_c numeric(4,1) not null default 0.0,
  temp_max_c numeric(4,1) not null default 5.0,
  active     boolean not null default true
);

create table if not exists drivers (
  id          uuid primary key default gen_random_uuid(),
  employee_id text not null unique,
  full_name   text not null,
  route       text,
  default_van uuid references vans(id),
  active      boolean not null default true
);

create table if not exists check_items (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  label      text not null,
  help_text  text,
  input_type check_input_type not null default 'boolean',
  critical   boolean not null default false,
  sort_order int not null,
  active     boolean not null default true
);

-- ---------------------------------------------------------------------
-- Inspections
-- ---------------------------------------------------------------------

create table if not exists inspections (
  id               uuid primary key default gen_random_uuid(),
  van_id           uuid not null references vans(id),
  driver_id        uuid not null references drivers(id),
  inspector_id     uuid not null references profiles(id),
  performed_at     timestamptz not null default now(),
  status           inspection_status not null,
  dispatch_blocked boolean not null default false,
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  notes            text,
  supersedes_id    uuid references inspections(id),
  created_at       timestamptz not null default now()
);

create index if not exists inspections_performed_at_idx on inspections (performed_at desc);
create index if not exists inspections_van_idx          on inspections (van_id, performed_at desc);

create table if not exists inspection_results (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  check_item_id uuid not null references check_items(id),
  passed        boolean not null,
  numeric_value numeric(5,2),
  note          text,
  unique (inspection_id, check_item_id),
  constraint failure_needs_note check (passed or note is not null)
);

create table if not exists inspection_photos (
  id          uuid primary key default gen_random_uuid(),
  result_id   uuid not null references inspection_results(id) on delete cascade,
  storage_key text not null,
  captured_at timestamptz not null default now(),
  byte_size   int
);

create table if not exists alerts (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id),
  channel       text not null,
  recipient     text not null,
  sent_at       timestamptz,
  delivered     boolean not null default false,
  error         text,
  payload       jsonb
);

create table if not exists audit_log (
  id          bigserial primary key,
  actor_id    uuid references profiles(id),
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  occurred_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Immutability. Nobody, including an admin holding the service key, can
-- quietly rewrite a temperature reading after the fact.
-- ---------------------------------------------------------------------

create or replace function prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Inspections are immutable. File a correcting inspection with supersedes_id instead.';
end;
$$;

drop trigger if exists inspections_immutable on inspections;
create trigger inspections_immutable
  before update or delete on inspections
  for each row execute function prevent_mutation();

drop trigger if exists results_immutable on inspection_results;
create trigger results_immutable
  before update or delete on inspection_results
  for each row execute function prevent_mutation();

-- ---------------------------------------------------------------------
-- Reporting view
-- ---------------------------------------------------------------------

create or replace view v_inspection_summary as
select
  i.id,
  i.performed_at,
  v.plate,
  v.depot,
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
join vans v     on v.id = i.van_id
join drivers d  on d.id = i.driver_id
join profiles p on p.id = i.inspector_id
where not exists (
  select 1 from inspections newer where newer.supersedes_id = i.id
);

-- ---------------------------------------------------------------------
-- RLS: read policies only, as defence in depth. All writes go through
-- server route handlers using the service role, after an explicit check.
-- ---------------------------------------------------------------------

alter table profiles           enable row level security;
alter table vans               enable row level security;
alter table drivers            enable row level security;
alter table check_items        enable row level security;
alter table inspections        enable row level security;
alter table inspection_results enable row level security;
alter table inspection_photos  enable row level security;
alter table audit_log          enable row level security;

drop policy if exists profiles_read_self on profiles;
create policy profiles_read_self on profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists vans_read on vans;
create policy vans_read on vans
  for select to authenticated using (active);

drop policy if exists drivers_read on drivers;
create policy drivers_read on drivers
  for select to authenticated using (active);

drop policy if exists check_items_read on check_items;
create policy check_items_read on check_items
  for select to authenticated using (active);

drop policy if exists inspections_read on inspections;
create policy inspections_read on inspections
  for select to authenticated
  using (
    inspector_id = auth.uid()
    or exists (
      select 1 from profiles
      where id = auth.uid() and role in ('manager', 'admin')
    )
  );

drop policy if exists results_read on inspection_results;
create policy results_read on inspection_results
  for select to authenticated
  using (exists (select 1 from inspections i where i.id = inspection_id));

drop policy if exists photos_read on inspection_photos;
create policy photos_read on inspection_photos
  for select to authenticated
  using (exists (select 1 from inspection_results r where r.id = result_id));

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------

insert into check_items (code, label, help_text, input_type, critical, sort_order) values
  ('temp',      'Van temperature',     'Must read 0-5 °C at the loading point',   'temperature', true,  1),
  ('sensor',    'Temperature sensor',  'Powered and logging to the fleet portal', 'boolean',     true,  2),
  ('gps',       'GPS tracker',         'Live signal showing on the fleet portal', 'boolean',     true,  3),
  ('curtains',  'Plastic curtains',    'Intact and clean, no tears',              'boolean',     false, 4),
  ('mats',      'Floor mats',          'Clean, dry and in position',              'boolean',     false, 5),
  ('load_area', 'Load area condition', 'No debris, spills or odours',             'boolean',     false, 6)
on conflict (code) do nothing;

insert into vans (plate) values
  ('DXB-4021'), ('DXB-4022'), ('SHJ-1108'),
  ('AUH-2210'), ('DXB-4023'), ('DXB-4024')
on conflict (plate) do nothing;

insert into drivers (employee_id, full_name, route, default_van)
select v.emp, v.name, v.route, vans.id
from (values
  ('D-1041', 'Rashid Al Mansoori', 'Dubai Marina – JLT',       'DXB-4021'),
  ('D-1042', 'Joseph Fernandes',   'Downtown – Business Bay',  'DXB-4022'),
  ('D-1043', 'Anil Kumar',         'Sharjah Central',          'SHJ-1108'),
  ('D-1044', 'Mohammed Irfan',     'Abu Dhabi – Khalifa City', 'AUH-2210'),
  ('D-1045', 'Peter Okoye',        'Jumeirah – Umm Suqeim',    'DXB-4023'),
  ('D-1046', 'Samuel Thomas',      'Deira – Al Nahda',         'DXB-4024')
) as v(emp, name, route, plate)
join vans on vans.plate = v.plate
on conflict (employee_id) do nothing;

-- Repairs any account left behind by an earlier failed sign-in: a row in
-- auth.users with no matching profile, which then fails on every retry.
insert into profiles (id, email, full_name)
select
  u.id,
  u.email,
  initcap(replace(split_part(u.email, '@', 1), '.', ' '))
from auth.users u
left join profiles p on p.id = u.id
where p.id is null and u.email is not null
on conflict (id) do nothing;

-- =====================================================================
-- AFTER RUNNING THIS, do the storage setup in the dashboard:
--
-- 1. Storage → New bucket
--      Name:   inspection-photos
--      Public: OFF
--
-- 2. Storage → inspection-photos → Policies → New policy
--      "For full customisation", then create two:
--        INSERT, target role authenticated, expression: true
--        SELECT, target role authenticated, expression: true
--
-- 3. Authentication → Providers → Email
--      "Allow new users to sign up"  OFF   ← this is the access boundary
--      "Confirm email"               OFF
--
-- 4. Authentication → Users → Add user → Create new user
--      Tick "Auto Confirm User". One per supervisor.
--      Then set role in the profiles table.
-- =====================================================================
