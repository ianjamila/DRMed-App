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
--
-- Note: this migration only touches policies that exist on the live
-- project. Earlier draft versions named non-existent objects
-- (accounting_export_runs, result_param_age_bands, physicians: staff
-- read, payments: staff select, audit_log: staff select); those were
-- artifacts of a divergence between the local migration files and the
-- live schema and have been removed from this migration.
-- =============================================================================

alter table public.staff_profiles
  drop constraint staff_profiles_role_check;

alter table public.staff_profiles
  add constraint staff_profiles_role_check
  check (role in ('reception', 'medtech', 'pathologist', 'admin', 'xray_technician'));

drop policy if exists "staff_profiles: staff read" on public.staff_profiles;
create policy "staff_profiles: staff read"
  on public.staff_profiles for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "patients: staff full" on public.patients;
create policy "patients: staff full"
  on public.patients for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "services: staff read" on public.services;
create policy "services: staff read"
  on public.services for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'xray_technician']));

drop policy if exists "visits: staff full" on public.visits;
create policy "visits: staff full"
  on public.visits for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "test_requests: staff select" on public.test_requests;
create policy "test_requests: staff select"
  on public.test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "test_requests: medtech/pathologist update" on public.test_requests;
create policy "test_requests: medtech/pathologist update"
  on public.test_requests for update to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'xray_technician']))
  with check (public.has_role(array['medtech', 'pathologist', 'xray_technician']));

drop policy if exists "results: staff select" on public.results;
create policy "results: staff select"
  on public.results for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "results: medtech/pathologist/admin write" on public.results;
create policy "results: medtech/pathologist/admin write"
  on public.results for all to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']))
  with check (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "result_templates: staff read" on public.result_templates;
create policy "result_templates: staff read"
  on public.result_templates for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "result_template_params: staff read" on public.result_template_params;
create policy "result_template_params: staff read"
  on public.result_template_params for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "result_template_param_ranges: staff read" on public.result_template_param_ranges;
create policy "result_template_param_ranges: staff read"
  on public.result_template_param_ranges for select to authenticated
  using (public.has_role(array['reception','medtech','pathologist','admin','xray_technician']));

-- result_values has no test_request_id column; the narrow-path policies
-- reach test_requests via results.test_request_id. Preserve the
-- original assigned_to + status guard and just extend the role array.
drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (tr.assigned_to = auth.uid() and tr.status in ('in_progress', 'result_uploaded'))
        )
    )
  );

drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (tr.assigned_to = auth.uid() and tr.status in ('in_progress', 'result_uploaded'))
        )
    )
  )
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (tr.assigned_to = auth.uid() and tr.status in ('in_progress', 'result_uploaded'))
        )
    )
  );

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

drop policy if exists "service_price_history: staff read" on public.service_price_history;
create policy "service_price_history: staff read"
  on public.service_price_history for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "inquiries: staff read" on public.inquiries;
create policy "inquiries: staff read"
  on public.inquiries for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

drop policy if exists "gift_codes: staff read" on public.gift_codes;
create policy "gift_codes: staff read"
  on public.gift_codes for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

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
