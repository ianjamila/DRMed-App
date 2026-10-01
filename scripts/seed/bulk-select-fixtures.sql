-- Local-only fixtures for the bulk-select browser checks (npm run check:bulk-select).
-- Loaded by scripts/seed-bulk-select-fixtures.ts, which refuses any non-local target.
--
-- Re-runnable: wipes only rows it owns (never patients — the 0146-0148
-- soft-delete guard means Bsqfixture patients are created once and reused;
-- never BSQ-* services either — other local smoke fixtures may borrow them,
-- so they are upserted by code instead of deleted and recreated).
-- Marked rows: services `BSQ-*`, visits `9101`-`9107`, patients with last
-- name `Bsqfixture`, appointments with `notes = 'bsq-fixture'`, website
-- messages with `message like 'bsq-fixture%'`, historic HMO claims with
-- `patient_name like 'BSQ Hist %'` (plus the journal entries, reversal
-- mirrors, lines and audit rows their Undo checks create).
begin;

-- ---- wipe what a previous run left (never patients) ----
delete from audit_log where resource_type = 'test_request' and resource_id in (
  select tr.id from test_requests tr join visits v on v.id = tr.visit_id
  where v.visit_number in ('9101','9102','9103','9104','9105','9106','9107'));
delete from test_requests where visit_id in (
  select id from visits where visit_number in ('9101','9102','9103','9104','9105','9106','9107'));
delete from visits where visit_number in ('9101','9102','9103','9104','9105','9106','9107');
delete from audit_log where resource_type = 'appointment' and resource_id in (
  select id from appointments where notes = 'bsq-fixture');
delete from appointments where notes = 'bsq-fixture';
delete from contact_messages where message like 'bsq-fixture%';

-- Historic HMO claims (Undo end-to-end checks). Collect JE ids FIRST — the
-- updates below null the FK pointers (`reverses` / `reversed_by`) that link a
-- claim's original settlement/write-off JE to Undo's reversal mirror, so
-- those pointers can't be used to find the mirror again afterwards. Nulling
-- both pointers before deleting (rather than relying on delete order) avoids
-- a `journal_entries.reverses`/`reversed_by` FK violation either way round.
drop table if exists _bsq_hist_je_ids;
create temporary table _bsq_hist_je_ids on commit drop as
  with orig as (
    select je.id from journal_entries je
    where je.source_kind = 'history_import'
      and je.source_id in (select id from historic_hmo_claims where patient_name like 'BSQ Hist %')
  )
  select id from orig
  union
  select je.id from journal_entries je join orig o on je.reverses = o.id;
-- Back to draft first: trg_je_lines_balance_check refuses to leave a POSTED
-- entry with no lines (P0003), and the Undo checks leave both the original
-- (reversed) and its mirror (posted) behind.
update journal_entries set reversed_by = null, reverses = null, status = 'draft'
  where id in (select id from _bsq_hist_je_ids);
delete from journal_lines where entry_id in (select id from _bsq_hist_je_ids);
delete from journal_entries where id in (select id from _bsq_hist_je_ids);
delete from audit_log where resource_type = 'historic_hmo_claim' and resource_id in (
  select id from historic_hmo_claims where patient_name like 'BSQ Hist %');
delete from historic_hmo_claims where patient_name like 'BSQ Hist %';

-- ---- patients (created once, reused) ----
insert into patients (first_name, last_name, birthdate, sex, phone)
select f, 'Bsqfixture', date '1990-01-01' + (rn * 40), case when rn % 2 = 0 then 'female' else 'male' end, '0917000000' || rn
from (values ('Alpha',1),('Bravo',2),('Charlie',3),('Delta',4),('Echo',5),('Foxtrot',6),('Golf',7)) s(f, rn)
where not exists (select 1 from patients p where p.last_name = 'Bsqfixture' and p.first_name = s.f);

-- ---- services ----
insert into services (code, name, price_php, kind, section) values
  ('BSQ-CBC','BSQ Complete Blood Count',100,'lab_test','hematology'),
  ('BSQ-ESR','BSQ ESR',100,'lab_test','hematology'),
  ('BSQ-UA','BSQ Urinalysis',100,'lab_test','urinalysis'),
  ('BSQ-XR','BSQ Chest X-ray',100,'lab_test','imaging_xray')
on conflict (code) do update set name = excluded.name, price_php = excluded.price_php,
  kind = excluded.kind, section = excluded.section, report_group_id = null;
insert into services (code, name, price_php, kind, section, report_group_id)
select c, n, 100, 'lab_test', 'chemistry', (select id from report_groups where code = 'CHEMISTRY')
from (values ('BSQ-GLU','BSQ Glucose'), ('BSQ-CHOL','BSQ Cholesterol'), ('BSQ-TRIG','BSQ Triglycerides')) s(c, n)
on conflict (code) do update set name = excluded.name, price_php = excluded.price_php,
  kind = excluded.kind, section = excluded.section, report_group_id = excluded.report_group_id;

-- ---- visits: 9101/9102/9105/9106 paid, 9103/9104/9107 unpaid + HMO (lab-gate passes via HMO) ----
with pts as (
  select id, row_number() over (order by first_name) rn from patients where last_name = 'Bsqfixture')
insert into visits (patient_id, visit_number, payment_status, hmo_provider_id, total_php)
select id, (9100 + rn)::text,
       case when rn in (3, 4, 7) then 'unpaid' else 'paid' end,
       case when rn in (3, 4, 7) then (select id from hmo_providers order by name limit 1) end,
       0
from pts;

-- ---- lab queue lines ----
-- 9101: 3 singles (claim/unclaim races); 9102: + x-ray (no medtech checkbox);
-- 9103/9104: cross-visit delete; 9105: a 3-test chemistry panel;
-- 9106: a 2-test chemistry panel + a single (use ?size=… to split a panel across pages);
-- 9107: a 3-test chemistry panel on an UNPAID (HMO) visit — the only panel a bulk
-- Delete may touch (deletability is `unpaid` only), for the panel Delete -> Undo check.
insert into test_requests (visit_id, service_id, requested_by, final_price_php)
select v.id, s.id, (select id from auth.users where email = 'admin@drmed.ph'), 100
from visits v
join services s on (
     (v.visit_number = '9101' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA'))
  or (v.visit_number = '9102' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA','BSQ-XR'))
  or (v.visit_number = '9103' and s.code in ('BSQ-CBC','BSQ-UA'))
  or (v.visit_number = '9104' and s.code in ('BSQ-ESR'))
  or (v.visit_number = '9105' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-TRIG'))
  or (v.visit_number = '9106' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-CBC'))
  or (v.visit_number = '9107' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-TRIG')))
where v.visit_number in ('9101','9102','9103','9104','9105','9106','9107');

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
  ('BSQ Sender Three', '09170000013', 'bsq-fixture: thanks!', 'replied', 'general'),
  -- Every source status exists. Four is 'booked' but links to no appointment
  -- (linked_appointment_id stays null): the inbox bulk bar's Reopen of it is
  -- the check. Five is already 'closed'.
  ('BSQ Sender Four', '09170000014', 'bsq-fixture: booked already', 'booked', 'general'),
  ('BSQ Sender Five', '09170000015', 'bsq-fixture: done', 'closed', 'general');

-- ---- historic HMO claims (Undo end-to-end checks: Mark billed / Mark paid /
-- Write off, each followed by Undo). Marked by patient_name like 'BSQ Hist %'.
-- Provider picked from whatever exists locally (never hardcode a name — the
-- seeder only guarantees hmo_providers is non-empty). All four start
-- eligible (pending/overdue) and NOT YET BILLED (date_submitted null) — the
-- Unbilled tab shows Mark billed / Mark paid / Write off on every historic
-- row regardless of billed status (all three actions only require
-- status in ('pending','overdue')), so a single tab exercises all three.
with prov as (select name from hmo_providers order by name limit 1)
insert into historic_hmo_claims
  (hmo_provider, patient_name, claim_date, service_description, base_amount_php, final_amount_php, status, source_tab, source_row)
select prov.name, x.patient_name, x.claim_date, x.service_description, x.amount, x.amount, x.status, 'LAB SERVICE', x.source_row
from prov, (values
  ('BSQ Hist Alpha',   current_date - 30, 'BSQ Hist Lab Test', 500::numeric, 'pending', -9101),
  ('BSQ Hist Bravo',   current_date - 35, 'BSQ Hist Lab Test', 750::numeric, 'pending', -9102),
  ('BSQ Hist Charlie', current_date - 40, 'BSQ Hist Lab Test', 600::numeric, 'overdue', -9103),
  ('BSQ Hist Delta',   current_date - 32, 'BSQ Hist Lab Test', 450::numeric, 'pending', -9104)
) as x(patient_name, claim_date, service_description, amount, status, source_row);

commit;
