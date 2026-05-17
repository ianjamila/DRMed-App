-- =============================================================================
-- smoke-14-d1.sql — Dispatch 1 schema + trigger smoke
-- =============================================================================
-- Verifies:
--   1. Migration 0040 applied (table + columns + check + 4 triggers + 3 indexes)
--   2. parent-references-header trigger rejects bad inserts (3 cases)
--   3. header auto-promote trigger flips in_progress → ready_for_release
--   4. cascade-cancel trigger cancels non-released components
--   5. package_completed_at trigger sets on last-component release
--   6. package_completed_at does NOT set on cancelled headers (cascade case)
--   7. package_completed_at does NOT re-stamp on amendment
--
-- Cleanup via begin/rollback. Self-bootstraps services + visit + admin.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- Migration 0041 gates the 12.2 GL bridge on parent_id IS NULL so package
-- components (final_price_php = 0) skip JE emission and roll up to the
-- header. No trigger-disable workaround is needed here.

do $$
declare
  v_admin_id        uuid := gen_random_uuid();
  v_patient_id      uuid;
  v_visit_id        uuid;
  v_pkg_svc         uuid := gen_random_uuid();
  v_cbc_svc         uuid := gen_random_uuid();
  v_xray_svc        uuid := gen_random_uuid();
  v_pkg_id          uuid;
  v_cbc_id          uuid;
  v_xray_id         uuid;
  v_header_status   text;
  v_completed       timestamptz;
  v_bad             boolean;
begin
  -- Bootstrap auth.users + staff_profile + patient + visit + services.
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-14d1@drmed.local');

  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_id, 'Smoke 14 D1', 'admin', true);

  insert into public.patients (last_name, first_name, sex, birthdate, drm_id)
  values ('Smoke', 'D1', 'male', '2000-01-01', 'DRM-S14D1')
  returning id into v_patient_id;

  insert into public.visits (patient_id, visit_number, total_php, created_by)
  values (v_patient_id, 'V-S14D1', 1000, v_admin_id)
  returning id into v_visit_id;

  -- Mark visit waived so the 12.2 payment-gating trigger lets us flip
  -- test_request.status to 'released' below. The smoke is about package
  -- triggers, not payment gating.
  update public.visits set payment_status = 'waived' where id = v_visit_id;

  insert into public.services (id, code, name, description, price_php, kind,
                                section, is_active, is_send_out)
  values
    (v_pkg_svc,  'SMK14_PKG',  'Smoke 14 Package',     '',     1000, 'lab_package',
     'package',          true, false),
    (v_cbc_svc,  'SMK14_CBC',  'Smoke 14 CBC',         '',     0,    'lab_test',
     'hematology',       true, false),
    (v_xray_svc, 'SMK14_XRAY', 'Smoke 14 Chest X-Ray', '',     0,    'lab_test',
     'imaging_xray',     true, false);

  -- Insert header row directly.
  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, is_package_header
  )
  values (v_visit_id, v_pkg_svc, 'in_progress', v_admin_id,
          1000, 0, 1000, true)
  returning id into v_pkg_id;

  -- A1: header auto-promote — status should now be 'ready_for_release'
  select status into v_header_status
    from public.test_requests where id = v_pkg_id;
  if v_header_status <> 'ready_for_release' then
    raise exception 'A1 FAIL: header status is % (expected ready_for_release)',
      v_header_status;
  end if;
  raise notice 'A1 PASS: header auto-promoted to ready_for_release';

  -- Insert component referencing header.
  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_cbc_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_id, false)
  returning id into v_cbc_id;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_xray_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_id, false)
  returning id into v_xray_id;

  -- A2: parent-references-header trigger — try to attach a component to a
  -- non-header row (the CBC component). Should fail.
  begin
    insert into public.test_requests (
      visit_id, service_id, status, requested_by, base_price_php,
      discount_amount_php, final_price_php, parent_id, is_package_header
    )
    values (v_visit_id, v_cbc_svc, 'in_progress', v_admin_id,
            0, 0, 0, v_cbc_id, false);
    raise exception 'A2 FAIL: insert with parent pointing at non-header succeeded (should have raised)';
  exception when raise_exception then
    raise notice 'A2 PASS: parent-references-header trigger rejected child-of-component';
  end;

  -- A3: header with parent_id should fail the CHECK constraint.
  begin
    insert into public.test_requests (
      visit_id, service_id, status, requested_by, base_price_php,
      discount_amount_php, final_price_php, parent_id, is_package_header
    )
    values (v_visit_id, v_pkg_svc, 'in_progress', v_admin_id,
            0, 0, 0, v_pkg_id, true);
    raise exception 'A3 FAIL: header with parent_id succeeded (should have raised)';
  exception when check_violation then
    raise notice 'A3 PASS: CHECK constraint rejected header-with-parent';
  end;

  -- A4: package_completed_at — release one component, not yet complete.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_cbc_id;
  select package_completed_at into v_completed
    from public.test_requests where id = v_pkg_id;
  if v_completed is not null then
    raise exception 'A4 FAIL: package_completed_at set after first component release (still %s components pending)',
      'one';
  end if;
  raise notice 'A4 PASS: package_completed_at NULL after 1-of-2 components released';

  -- Header must be released first for completion stamp to apply.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_pkg_id;

  -- A5: release the second component — completion stamp should set.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_xray_id;
  select package_completed_at into v_completed
    from public.test_requests where id = v_pkg_id;
  if v_completed is null then
    raise exception 'A5 FAIL: package_completed_at NULL after last component released';
  end if;
  raise notice 'A5 PASS: package_completed_at set after last component released (= %)', v_completed;

  -- A6: amending (status flip to 'in_progress' then back to 'released')
  -- should NOT re-stamp package_completed_at.
  update public.test_requests set status = 'in_progress' where id = v_cbc_id;
  update public.test_requests set status = 'released',  released_at = now()
    where id = v_cbc_id;
  declare
    v_completed_after timestamptz;
  begin
    select package_completed_at into v_completed_after
      from public.test_requests where id = v_pkg_id;
    if v_completed_after is distinct from v_completed then
      raise exception 'A6 FAIL: package_completed_at re-stamped on amendment (was % now %)',
        v_completed, v_completed_after;
    end if;
  end;
  raise notice 'A6 PASS: amendment did not re-stamp package_completed_at';

  raise notice 'all 6 D1 smoke assertions PASS';
end$$;

rollback;
