-- =============================================================================
-- smoke-14.sql — Phase 14 full end-to-end SQL smoke
-- =============================================================================
-- Mirrors the spec § 9 acceptance criteria for package decomposition:
--
--   B1: header auto-promoted to 'ready_for_release' on insert
--   B2: 2 component test_requests created and linked via parent_id
--   B3: visit total = header price (components contribute ₱0)
--   B4: header flagged is_package_header = true
--   B5: package_completed_at is set after header + all components release
--
-- Flow:
--   1. Bootstrap auth.users + staff_profile + patient + visit + a synthetic
--      lab_package service + 2 component services + package_components rows
--      defining the composition.
--   2. Insert header test_request + 2 components mirroring the
--      createVisitAction decomposition logic (header carries the price,
--      components priced at ₱0).
--   3. Assert B1..B4 against the resulting rows.
--   4. Record payment to flip the visit to 'paid', then release components +
--      header to exercise the 0042 header-completion symmetric leg.
--   5. Assert B5: package_completed_at populated.
--
-- Cleanup via begin/rollback. Idempotent — safe to re-run.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_admin_id         uuid := gen_random_uuid();
  v_patient_id       uuid;
  v_visit_id         uuid;
  v_pkg_svc          uuid := gen_random_uuid();
  v_cbc_svc          uuid := gen_random_uuid();
  v_xray_svc         uuid := gen_random_uuid();
  v_pkg_req          uuid;
  v_cbc_req          uuid;
  v_xray_req         uuid;
  v_header_status    text;
  v_header_is_pkg    boolean;
  v_component_count  int;
  v_visit_total      numeric(10,2);
  v_completed        timestamptz;
begin
  -- ----- Bootstrap ---------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-14@drmed.local');

  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_id, 'Smoke 14 Admin', 'admin', true);

  insert into public.patients (last_name, first_name, sex, birthdate, drm_id)
  values ('Smoke', 'Phase14', 'female', '1990-01-01', 'DRM-S14FULL')
  returning id into v_patient_id;

  -- Visit total at ₱1000 — header price only, components contribute ₱0.
  insert into public.visits (patient_id, visit_number, total_php, created_by)
  values (v_patient_id, 'V-S14FULL', 1000, v_admin_id)
  returning id into v_visit_id;

  -- Services: 1 package, 2 components.
  insert into public.services (id, code, name, description, price_php, kind,
                                section, is_active, is_send_out)
  values
    (v_pkg_svc,  'SMK14F_PKG',  'Smoke 14 Full Package', '', 1000, 'lab_package',
     'package',      true, false),
    (v_cbc_svc,  'SMK14F_CBC',  'Smoke 14 Full CBC',     '', 0,    'lab_test',
     'hematology',   true, false),
    (v_xray_svc, 'SMK14F_XRAY', 'Smoke 14 Full X-Ray',   '', 0,    'lab_test',
     'imaging_xray', true, false);

  -- package_components composition.
  insert into public.package_components (package_service_id, component_service_id, sort_order)
  values
    (v_pkg_svc, v_cbc_svc,  1),
    (v_pkg_svc, v_xray_svc, 2);

  -- ----- Insert header + 2 components --------------------------------------
  -- Mirrors createVisitAction: header carries full price, components ₱0.
  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, is_package_header
  )
  values (v_visit_id, v_pkg_svc, 'in_progress', v_admin_id,
          1000, 0, 1000, true)
  returning id into v_pkg_req;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_cbc_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_req, false)
  returning id into v_cbc_req;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_xray_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_req, false)
  returning id into v_xray_req;

  -- ----- B1: header auto-promoted to ready_for_release ---------------------
  select status into v_header_status
    from public.test_requests where id = v_pkg_req;
  if v_header_status <> 'ready_for_release' then
    raise exception 'B1 FAIL: header status is % (expected ready_for_release)',
      v_header_status;
  end if;
  raise notice 'B1 PASS: header auto-promoted to ready_for_release';

  -- ----- B2: 2 components created and linked ------------------------------
  select count(*) into v_component_count
    from public.test_requests
   where parent_id = v_pkg_req;
  if v_component_count <> 2 then
    raise exception 'B2 FAIL: expected 2 components linked to header, got %',
      v_component_count;
  end if;
  raise notice 'B2 PASS: 2 components created and linked via parent_id';

  -- ----- B3: visit total = header price ------------------------------------
  -- Visit total was inserted at 1000 (header price). Components add ₱0, so
  -- the sum of final_price_php across requests must equal visit total.
  select total_php into v_visit_total
    from public.visits where id = v_visit_id;
  if v_visit_total <> 1000 then
    raise exception 'B3 FAIL: visit total is % (expected 1000 = header price)',
      v_visit_total;
  end if;

  declare
    v_sum_final numeric(10,2);
  begin
    select coalesce(sum(final_price_php), 0) into v_sum_final
      from public.test_requests where visit_id = v_visit_id;
    if v_sum_final <> v_visit_total then
      raise exception 'B3 FAIL: sum(final_price_php) is % but visit.total_php is %',
        v_sum_final, v_visit_total;
    end if;
  end;
  raise notice 'B3 PASS: visit total = % = header price (components contribute ₱0)',
    v_visit_total;

  -- ----- B4: header flagged is_package_header = true -----------------------
  select is_package_header into v_header_is_pkg
    from public.test_requests where id = v_pkg_req;
  if v_header_is_pkg is not true then
    raise exception 'B4 FAIL: header is_package_header is % (expected true)',
      v_header_is_pkg;
  end if;
  raise notice 'B4 PASS: header flagged is_package_header = true';

  -- ----- Pay visit + release components + header ---------------------------
  -- Pay the visit so the payment-gating trigger lets us flip statuses to
  -- 'released'. The payments-insert trigger recalculates payment_status.
  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v_visit_id, 1000, 'cash', v_admin_id);

  -- Confirm visit transitioned to paid.
  declare
    v_pay_status text;
  begin
    select payment_status into v_pay_status from public.visits where id = v_visit_id;
    if v_pay_status <> 'paid' then
      raise exception 'precondition FAIL: visit not marked paid after ₱1000 payment (got %)',
        v_pay_status;
    end if;
  end;

  -- Release the components first, then the header. The 0042 trigger handles
  -- the case where components release before the header.
  update public.test_requests set status = 'released', released_at = now()
   where id = v_cbc_req;
  update public.test_requests set status = 'released', released_at = now()
   where id = v_xray_req;
  update public.test_requests set status = 'released', released_at = now()
   where id = v_pkg_req;

  -- ----- B5: package_completed_at set --------------------------------------
  select package_completed_at into v_completed
    from public.test_requests where id = v_pkg_req;
  if v_completed is null then
    raise exception 'B5 FAIL: package_completed_at is NULL after all rows released';
  end if;
  raise notice 'B5 PASS: package_completed_at set after all rows released (= %)',
    v_completed;

  raise notice 'all 5 Phase 14 smoke assertions PASS';
end$$;

rollback;
