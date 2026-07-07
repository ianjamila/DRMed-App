-- PR 9 (H2): make the patient RLS policies actually enforce for portal reads.
--
-- Background: patients are not Postgres-authenticated (DRM-ID + PIN, not Supabase
-- Auth). Until now the portal read every table through the service-role admin
-- client and relied on application-level `.eq("patient_id", …)` filters — the
-- `set_patient_context()` / `app.current_patient_id` RLS bridge was effectively
-- dead code. This migration makes real RLS the source of truth for portal reads:
--
--   current_patient_id() now resolves the patient in two ways —
--     1. the transaction-local GUC `app.current_patient_id` (legacy bridge, still
--        honoured for any RPC that calls set_patient_context in the same tx), then
--     2. a `patient_id` claim on the request JWT. The portal server mints a
--        short-lived anon-role JWT carrying that claim per request (see
--        src/lib/supabase/patient.ts), so PostgREST — which wraps every supabase-js
--        call in its own transaction and therefore cannot share a GUC across calls —
--        still evaluates the patient's identity on every query.
--
-- Scope note (reviewer): the migration adds/broadens PATIENT SELECT policies on
-- the exact set of tables the portal reads, so the patient-scoped anon client can
-- serve every read without regressing the shipped "still in progress" hint, the
-- package cards, consolidated report names, or the upload context labels. Every
-- policy is own-patient-scoped (no cross-patient exposure) and result *content*
-- stays released-gated (results / result_test_requests below still require
-- status='released'). Staff policies are untouched. The change is additive and
-- GUC-preserving, so it is safe to deploy ahead of the app change and trivially
-- reversible (revert the app deploy; the policies simply see no patient claim).

-- 1. Claim-aware current_patient_id(). search_path is pinned (unchanged from the
--    prior definition) to keep the function immune to search_path hijacking. Every
--    current_setting read is nullif-guarded so an empty/absent GUC or claims blob
--    resolves to NULL rather than raising on a bad ::uuid / ::jsonb cast.
create or replace function public.current_patient_id()
returns uuid
language sql
stable
set search_path to 'public'
as $$
  select coalesce(
    nullif(current_setting('app.current_patient_id', true), '')::uuid,
    nullif(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'patient_id',
      ''
    )::uuid
  );
$$;

-- 2. results: 0051 recreated this policy as `to authenticated` only, which dropped
--    anon — the anon-role patient client would see zero results. Recreate it for
--    both roles. The USING expression is byte-for-byte the live one (released tests
--    the patient owns); only the role list changes. Result CONTENT stays gated to
--    released tests regardless of test_requests visibility below.
drop policy if exists "results: patient released only" on public.results;
create policy "results: patient released only"
  on public.results for select to anon, authenticated
  using (exists (
    select 1
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    where rtr.result_id = results.id
      and tr.status = 'released'
      and v.patient_id = public.current_patient_id()
  ));

-- 3. result_test_requests: had NO patient policy (the portal always joined it via
--    the admin client). Scope it to junction rows of the patient's released tests
--    so the patient client can resolve which result belongs to which released test.
--    Still released-gated, so it never leaks results for unreleased tests.
create policy "result_test_requests: patient released only"
  on public.result_test_requests for select to anon, authenticated
  using (exists (
    select 1
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
    where tr.id = result_test_requests.test_request_id
      and tr.status = 'released'
      and v.patient_id = public.current_patient_id()
  ));

-- 4. appointment_attachments: had NO patient policy either. Scope to the patient's
--    own rows (lab-request uploads they attached at booking). Rows with a NULL
--    patient_id stay hidden (NULL = current_patient_id() is never true).
create policy "appointment_attachments: patient self"
  on public.appointment_attachments for select to anon, authenticated
  using (patient_id = public.current_patient_id());

-- 5. test_requests: the existing patient policy was released-only. The portal shows
--    the STATUS of a patient's own tests — the "still in progress" hint and the
--    package-progress cards need to see in_progress package headers and unreleased
--    components. A test_request row is an order + status, not result content (that
--    is separately gated in §2/§3), and the patient already sees these statuses
--    today via the admin client. Broaden to the patient's own visits (any status);
--    own-scoped, so no cross-patient exposure.
drop policy if exists "test_requests: patient released only" on public.test_requests;
create policy "test_requests: patient own visits"
  on public.test_requests for select to anon, authenticated
  using (visit_id in (
    select v.id from public.visits v where v.patient_id = public.current_patient_id()
  ));

-- 6. report_groups: a lookup/catalog table (code + display name for consolidated
--    panels, e.g. "Chemistry") shared across patients — not patient data. The
--    portal embeds report_groups(name) when labelling consolidated results, so the
--    patient client needs read access. Mirror the services public-read pattern.
create policy "report_groups: public read active"
  on public.report_groups for select to anon, authenticated
  using (is_active = true);

-- 7. appointments: had only a staff policy. The portal reads a patient's own
--    appointments to build the context label on their uploaded request forms.
--    Scope to own rows.
create policy "appointments: patient self"
  on public.appointments for select to anon, authenticated
  using (patient_id = public.current_patient_id());

-- visits / patients / payments patient SELECT policies (0001) already read
-- current_patient_id() with `to anon, authenticated`, and services is public-read
-- (`services: public read active` covers anon) — no change.
