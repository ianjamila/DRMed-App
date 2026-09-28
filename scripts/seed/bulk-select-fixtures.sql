-- Local-only fixtures for the bulk-select browser checks (npm run check:bulk-select).
-- Loaded by scripts/seed-bulk-select-fixtures.ts, which refuses any non-local target.
--
-- Re-runnable: wipes only rows it owns (never patients — the 0146-0148
-- soft-delete guard means Bsqfixture patients are created once and reused).
-- Marked rows: services `BSQ-*`, visits `9101`-`9106`, patients with last
-- name `Bsqfixture`, appointments with `notes = 'bsq-fixture'`, website
-- messages with `message like 'bsq-fixture%'`.
begin;

-- ---- wipe what a previous run left (never patients) ----
-- Appointments (which reference services via service_id) must be deleted
-- BEFORE the BSQ-* services, or the services delete fails on
-- appointments_service_id_fkey.
delete from audit_log where resource_type = 'test_request' and resource_id in (
  select tr.id from test_requests tr join visits v on v.id = tr.visit_id
  where v.visit_number in ('9101','9102','9103','9104','9105','9106'));
delete from test_requests where visit_id in (
  select id from visits where visit_number in ('9101','9102','9103','9104','9105','9106'));
delete from visits where visit_number in ('9101','9102','9103','9104','9105','9106');
delete from audit_log where resource_type = 'appointment' and resource_id in (
  select id from appointments where notes = 'bsq-fixture');
delete from appointments where notes = 'bsq-fixture';
delete from services where code like 'BSQ-%';
delete from contact_messages where message like 'bsq-fixture%';

-- ---- patients (created once, reused) ----
insert into patients (first_name, last_name, birthdate, sex, phone)
select f, 'Bsqfixture', date '1990-01-01' + (rn * 40), case when rn % 2 = 0 then 'female' else 'male' end, '0917000000' || rn
from (values ('Alpha',1),('Bravo',2),('Charlie',3),('Delta',4),('Echo',5),('Foxtrot',6)) s(f, rn)
where not exists (select 1 from patients p where p.last_name = 'Bsqfixture' and p.first_name = s.f);

-- ---- services ----
insert into services (code, name, price_php, kind, section) values
  ('BSQ-CBC','BSQ Complete Blood Count',100,'lab_test','hematology'),
  ('BSQ-ESR','BSQ ESR',100,'lab_test','hematology'),
  ('BSQ-UA','BSQ Urinalysis',100,'lab_test','urinalysis'),
  ('BSQ-XR','BSQ Chest X-ray',100,'lab_test','imaging_xray');
insert into services (code, name, price_php, kind, section, report_group_id)
select c, n, 100, 'lab_test', 'chemistry', (select id from report_groups where code = 'CHEMISTRY')
from (values ('BSQ-GLU','BSQ Glucose'), ('BSQ-CHOL','BSQ Cholesterol'), ('BSQ-TRIG','BSQ Triglycerides')) s(c, n);

-- ---- visits: 9101/9102/9105/9106 paid, 9103/9104 unpaid + HMO (lab-gate passes via HMO) ----
with pts as (
  select id, row_number() over (order by first_name) rn from patients where last_name = 'Bsqfixture')
insert into visits (patient_id, visit_number, payment_status, hmo_provider_id, total_php)
select id, (9100 + rn)::text,
       case when rn in (3, 4) then 'unpaid' else 'paid' end,
       case when rn in (3, 4) then (select id from hmo_providers order by name limit 1) end,
       0
from pts;

-- ---- lab queue lines ----
-- 9101: 3 singles (claim/unclaim races); 9102: + x-ray (no medtech checkbox);
-- 9103/9104: cross-visit delete; 9105: a 3-test chemistry panel;
-- 9106: a 2-test chemistry panel + a single (use ?size=… to split a panel across pages).
insert into test_requests (visit_id, service_id, requested_by, final_price_php)
select v.id, s.id, (select id from auth.users where email = 'admin@drmed.ph'), 100
from visits v
join services s on (
     (v.visit_number = '9101' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA'))
  or (v.visit_number = '9102' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA','BSQ-XR'))
  or (v.visit_number = '9103' and s.code in ('BSQ-CBC','BSQ-UA'))
  or (v.visit_number = '9104' and s.code in ('BSQ-ESR'))
  or (v.visit_number = '9105' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-TRIG'))
  or (v.visit_number = '9106' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-CBC')))
where v.visit_number in ('9101','9102','9103','9104','9105','9106');

-- ---- appointments (Manila wall-clock times today / tomorrow) ----
-- `source` is constrained (appointments_source_check, 0154) to the values in
-- src/lib/appointments/source.ts — 'website'/'staff' are NOT members, so the
-- two pending-callback rows (which land here from the public /schedule
-- diagnostic-package flow) use 'online_booking', and the rest use a staff
-- pick ('walk_in' / 'phone').
with t as (select date_trunc('day', now() at time zone 'Asia/Manila') as d),
     p as (select id, first_name from patients where last_name = 'Bsqfixture'),
     g as (select gen_random_uuid() as grp)
insert into appointments (patient_id, walk_in_name, walk_in_phone, service_id, scheduled_at, status, notes, booking_group_id, source)
select * from (
  -- item 6: pending callback WITH a date today → must show once, under Today, tagged
  select (select id from p where first_name = 'Alpha'), null::text, null::text,
         (select id from services where code = 'BSQ-CBC'),
         ((select d from t) + interval '10 hours') at time zone 'Asia/Manila', 'pending_callback', 'bsq-fixture', null::uuid, 'online_booking'
  union all -- pending callback without a date → stays in Pending callback
  select null, 'BSQ Callback Undated', '09170000099', null, null, 'pending_callback', 'bsq-fixture', null, 'online_booking'
  union all -- a 2-service booking today (one row in the list, weight 2)
  select (select id from p where first_name = 'Bravo'), null, null, (select id from services where code = 'BSQ-CBC'),
         ((select d from t) + interval '11 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', (select grp from g), 'phone'
  union all
  select (select id from p where first_name = 'Bravo'), null, null, (select id from services where code = 'BSQ-UA'),
         ((select d from t) + interval '11 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', (select grp from g), 'phone'
  union all
  select null, 'BSQ Walk-in Today', '09170000098', null,
         ((select d from t) + interval '14 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', null, 'walk_in'
  union all
  select (select id from p where first_name = 'Charlie'), null, null, null,
         ((select d from t) + interval '9 hours') at time zone 'Asia/Manila', 'arrived', 'bsq-fixture', null, 'phone'
  union all
  select (select id from p where first_name = 'Delta'), null, null, null,
         ((select d from t) + interval '1 day 10 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', null, 'phone'
  union all -- untimed (Bookings with no set time)
  select null, 'BSQ Untimed', '09170000097', null, null, 'confirmed', 'bsq-fixture', null, 'walk_in'
) rows;

-- ---- website messages (PR 3's inbox) ----
insert into contact_messages (name, phone, message, status, kind) values
  ('BSQ Sender One', '09170000011', 'bsq-fixture: price of CBC?', 'new', 'general'),
  ('BSQ Sender Two', '09170000012', 'bsq-fixture: corporate APE for 40 staff', 'new', 'corporate'),
  ('BSQ Sender Three', '09170000013', 'bsq-fixture: thanks!', 'replied', 'general');

commit;
