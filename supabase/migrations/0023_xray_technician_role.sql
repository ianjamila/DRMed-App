-- =============================================================================
-- 0023_xray_technician_role.sql
-- =============================================================================
-- Adds the `xray_technician` staff role. Imaging x-ray tests are handled by
-- a radiologic technologist, not a medtech — the previous schema lumped
-- both into `medtech`, which misrepresented the workflow and made future
-- per-role notifications and audit slices ambiguous.
--
-- Design choice: at the RLS layer xray_technician gets the same access
-- as medtech (same tables, same row scope). The app filters the queue to
-- the right section per role — RLS is not section-aware. This keeps the
-- migration small and avoids per-row subqueries on the hot lab path; if
-- defence-in-depth ever becomes necessary, a section-aware policy can be
-- layered on top without altering this baseline.
--
-- prc_license_kind already accepts 'RT' (Radiologic Technology), so no
-- change to that constraint.
-- =============================================================================

-- 1. Extend the role check constraint.
alter table public.staff_profiles
  drop constraint staff_profiles_role_check;

alter table public.staff_profiles
  add constraint staff_profiles_role_check
  check (role in ('reception', 'medtech', 'pathologist', 'admin', 'xray_technician'));

-- 2. Update every policy that currently grants medtech write/select access
--    to also include xray_technician. We drop+recreate each by name.
--    Read-only universal policies (which already list every role) are
--    extended in the same pattern.

-- staff_profiles: staff read (everyone authenticated sees the roster)
drop policy if exists "staff_profiles: staff read" on public.staff_profiles;
create policy "staff_profiles: staff read"
  on public.staff_profiles for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- patients: staff full
drop policy if exists "patients: staff full" on public.patients;
create policy "patients: staff full"
  on public.patients for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- services: staff (non-admin) read
drop policy if exists "services: staff read" on public.services;
create policy "services: staff read"
  on public.services for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'xray_technician']));

-- visits: staff full
drop policy if exists "visits: staff full" on public.visits;
create policy "visits: staff full"
  on public.visits for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- test_requests: staff select
drop policy if exists "test_requests: staff select" on public.test_requests;
create policy "test_requests: staff select"
  on public.test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- test_requests: medtech/pathologist update — extend to xray_technician
drop policy if exists "test_requests: medtech/pathologist update" on public.test_requests;
create policy "test_requests: medtech/pathologist update"
  on public.test_requests for update to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'xray_technician']))
  with check (public.has_role(array['medtech', 'pathologist', 'xray_technician']));

-- results: staff select
drop policy if exists "results: staff select" on public.results;
create policy "results: staff select"
  on public.results for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- results: medtech/pathologist/admin write
drop policy if exists "results: medtech/pathologist/admin write" on public.results;
create policy "results: medtech/pathologist/admin write"
  on public.results for all to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']));

-- payments: staff select (read-only universal staff access)
drop policy if exists "payments: staff select" on public.payments;
create policy "payments: staff select"
  on public.payments for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- audit_log: staff select (already universal; extend role list)
drop policy if exists "audit_log: staff select" on public.audit_log;
create policy "audit_log: staff select"
  on public.audit_log for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- result_templates: staff read (0007)
drop policy if exists "result_templates: staff read" on public.result_templates;
create policy "result_templates: staff read"
  on public.result_templates for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- result_template_params: staff read (0007)
drop policy if exists "result_template_params: staff read" on public.result_template_params;
create policy "result_template_params: staff read"
  on public.result_template_params for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- result_values: staff read (0007)
drop policy if exists "result_values: staff read" on public.result_values;
create policy "result_values: staff read"
  on public.result_values for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- result_values: medtech/pathologist/admin write (0007)
drop policy if exists "result_values: medtech/pathologist/admin write" on public.result_values;
create policy "result_values: medtech/pathologist/admin write"
  on public.result_values for all to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']));

-- result_values: medtech write own claimed test (0007 — narrow path used
-- by the structured-form flow). Extend to xray_technician so an xray
-- tech can save values on a test they've claimed.
drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'xray_technician'])
    and exists (
      select 1 from public.test_requests tr
      where tr.id = result_values.test_request_id
        and tr.assigned_to = auth.uid()
    )
  );

drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'xray_technician'])
    and exists (
      select 1 from public.test_requests tr
      where tr.id = result_values.test_request_id
        and tr.assigned_to = auth.uid()
    )
  )
  with check (
    public.has_role(array['medtech', 'xray_technician'])
    and exists (
      select 1 from public.test_requests tr
      where tr.id = result_values.test_request_id
        and tr.assigned_to = auth.uid()
    )
  );

-- Read-only staff policies elsewhere (price history, accounting, gift
-- code reads, inquiries reads, physicians reads, age-band reads). Each
-- is extended to include xray_technician.

drop policy if exists "service_price_history: staff read" on public.service_price_history;
create policy "service_price_history: staff read"
  on public.service_price_history for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "accounting_export_runs: staff read" on public.accounting_export_runs;
create policy "accounting_export_runs: staff read"
  on public.accounting_export_runs for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "inquiries: staff read" on public.inquiries;
create policy "inquiries: staff read"
  on public.inquiries for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "gift_codes: staff read" on public.gift_codes;
create policy "gift_codes: staff read"
  on public.gift_codes for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "physicians: staff read" on public.physicians;
create policy "physicians: staff read"
  on public.physicians for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "result_param_age_bands: staff read" on public.result_param_age_bands;
create policy "result_param_age_bands: staff read"
  on public.result_param_age_bands for select to authenticated
  using (public.has_role(array['reception','medtech','pathologist','admin','xray_technician']));

drop policy if exists "result_template_param_ranges: staff read" on public.result_template_param_ranges;
create policy "result_template_param_ranges: staff read"
  on public.result_template_param_ranges for select to authenticated
  using (public.has_role(array['reception','medtech','pathologist','admin','xray_technician']));

drop policy if exists "physicians: staff read all" on public.physicians;
create policy "physicians: staff read all"
  on public.physicians
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "hmo_providers: staff read all" on public.hmo_providers;
create policy "hmo_providers: staff read all"
  on public.hmo_providers
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- Owning-medtech read on result_values: extend the implicit "owner can
-- read what they wrote" leg to xray_technician owners too.
drop policy if exists "result_values: read by owning medtech + pathologist + admin" on public.result_values;
create policy "result_values: read by owning medtech + pathologist + admin"
  on public.result_values for select to authenticated
  using (
    public.has_role(array['pathologist', 'admin'])
    or exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and tr.assigned_to = auth.uid()
        and public.has_role(array['medtech', 'xray_technician'])
    )
  );
