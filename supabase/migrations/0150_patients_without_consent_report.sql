-- Finished consent worklist: PostgREST can sort, count and page before sending
-- rows to the app. Candidates are unmerged patients with consent_current=false;
-- patients have no deleted_at column. Keep patients with zero live visits.
-- A visit is ANY visits row for that patient with deleted_at IS NULL: no
-- payment, service, test-request, historical-import or visit-group exclusions.
--
-- 0143 already supplies idx_visits_patient_last_visit on
-- (patient_id, visit_date DESC) WHERE deleted_at IS NULL. No duplicate index.
-- Refresh the stats used to plan the live-row aggregate (see 0143's incident).
analyze public.visits;
analyze public.patients;

create or replace view public.v_patients_without_consent
with (security_invoker = true) as
select
  p.id,
  p.drm_id,
  p.first_name,
  p.last_name,
  p.phone,
  p.email,
  p.pre_registered,
  -- Match formatPatientName for this report, which selects no middle_name.
  -- The trim character set matches JavaScript String.trim(), including NBSP.
  nullif(concat_ws(', ', n.last_name, n.first_name), '') as patient_name,
  (case when coalesce(p.phone, '') <> '' then 1 else 0 end
   + case when coalesce(p.email, '') <> '' then 1 else 0 end) as contact_score,
  coalesce(v.visit_count, 0::bigint) as visit_count,
  v.last_visit_at
from public.patients p
cross join lateral (
  select
    nullif(btrim(p.last_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as last_name,
    nullif(btrim(p.first_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as first_name
) n
left join (
  select
    patient_id,
    count(*) as visit_count,
    -- visit_date is already a clinic calendar DATE in Asia/Manila (+08:00),
    -- not an instant. Preserve it as DATE; a timestamptz/UTC cast would change
    -- the old report/CSV contract. Its default is Manila-local since 0127.
    max(visit_date) as last_visit_at
  from public.visits
  where deleted_at is null
  group by patient_id
) v on v.patient_id = p.id
where p.consent_current = false
  and p.merged_into_id is null;

comment on view public.v_patients_without_consent is
  'Unmerged patients lacking current consent, with live visit count and last Manila visit date. Invoker RLS; shared by the admin report and CSV.';

-- Supabase default table privileges also apply to views (0148). Clear them
-- before granting authenticated SELECT only; never rely on a column revoke.
revoke all on public.v_patients_without_consent from public, anon, authenticated;
grant select on public.v_patients_without_consent to authenticated;
