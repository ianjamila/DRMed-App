-- 0175 — a portal patient can read the catalog rows their own bill names.
--
-- The patient's statement of account (/portal/visits/[id]/statement, PR #212)
-- reads through the patient-scoped client (anon role + patient_id claim,
-- 0114). Three lookups it needs were closed to that role:
--
--   * services       — anon sees only is_active rows (0151). A line billed
--                      before its service was retired printed with a blank
--                      name and code on the patient's copy, while staff saw it.
--   * hmo_providers  — same, for an HMO that has since been deactivated.
--   * discount_types — staff-only (0128), so the patient's copy could never
--                      tell a statutory Senior/PWD line apart.
--
-- Each new policy is SELECT-only, to anon, and matches a row only when it is
-- referenced by one of the CALLER's own visits — current_patient_id() is the
-- JWT claim, so without a claim (plain anon, the public website) the EXISTS
-- is always false and nothing new is visible. The inner reads of visits /
-- test_requests run under their own patient policies (0151), so they cannot
-- widen each other. Helper calls are wrapped in (select …) per 0151's
-- initplan rule. Additive only: no existing policy is touched.

create policy "services: patient billed" on public.services
  as permissive for select to anon
  using (
    exists (
      select 1
        from public.test_requests tr
        join public.visits v on v.id = tr.visit_id
       where tr.service_id = services.id
         and v.patient_id = (select public.current_patient_id())
    )
  );

create policy "hmo_providers: patient billed" on public.hmo_providers
  as permissive for select to anon
  using (
    exists (
      select 1
        from public.visits v
       where v.hmo_provider_id = hmo_providers.id
         and v.patient_id = (select public.current_patient_id())
    )
  );

create policy "discount_types: patient billed" on public.discount_types
  as permissive for select to anon
  using (
    exists (
      select 1
        from public.test_requests tr
        join public.visits v on v.id = tr.visit_id
       where tr.discount_kind = discount_types.code
         and v.patient_id = (select public.current_patient_id())
    )
  );
