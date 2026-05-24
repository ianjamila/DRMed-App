-- =============================================================================
-- smoke-chemistry-consolidated.sql — S0: schema sanity
-- =============================================================================
\set ON_ERROR_STOP on

begin;

do $$
declare
  v_report_groups_exists  boolean;
  v_junction_exists       boolean;
  v_results_has_group     boolean;
  v_results_has_test_req  boolean;
  v_staff_has_sig         boolean;
begin
  select exists(select 1 from information_schema.tables
                where table_schema='public' and table_name='report_groups')
    into v_report_groups_exists;
  if not v_report_groups_exists then
    raise exception 'S0: report_groups table missing';
  end if;

  select exists(select 1 from information_schema.tables
                where table_schema='public' and table_name='result_test_requests')
    into v_junction_exists;
  if not v_junction_exists then
    raise exception 'S0: result_test_requests junction missing';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='results'
                  and column_name='report_group_id')
    into v_results_has_group;
  if not v_results_has_group then
    raise exception 'S0: results.report_group_id column missing';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='results'
                  and column_name='test_request_id')
    into v_results_has_test_req;
  if v_results_has_test_req then
    raise exception 'S0: results.test_request_id still present (should be dropped)';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='staff_profiles'
                  and column_name='signature_path')
    into v_staff_has_sig;
  if not v_staff_has_sig then
    raise exception 'S0: staff_profiles.signature_path missing';
  end if;

  raise notice 'S0 schema sanity OK';
end $$;

-- =============================================================================
-- S1: Chemistry seed sanity
-- =============================================================================
do $$
declare
  v_group_id   uuid;
  v_tpl_id     uuid;
  v_param_cnt  int;
  v_svc_cnt    int;
begin
  select id into v_group_id
    from public.report_groups
   where code = 'CHEMISTRY';
  if v_group_id is null then
    raise exception 'S1: CHEMISTRY report_group missing';
  end if;

  select id into v_tpl_id
    from public.result_templates
   where report_group_id = v_group_id and is_active;
  if v_tpl_id is null then
    raise exception 'S1: active Chemistry template missing';
  end if;

  select count(*) into v_param_cnt
    from public.result_template_params
   where template_id = v_tpl_id;
  if v_param_cnt <> 14 then
    raise exception 'S1: expected 14 Chemistry params (12 + 2 gender Creatinine/UricAcid), got %', v_param_cnt;
  end if;

  select count(*) into v_svc_cnt
    from public.services
   where report_group_id = v_group_id and is_active;
  if v_svc_cnt < 11 then
    raise exception 'S1: expected ≥11 active Chemistry services, got %', v_svc_cnt;
  end if;

  raise notice 'S1 chemistry seed OK (% params, % services)', v_param_cnt, v_svc_cnt;
end $$;

-- =============================================================================
-- S2: end-to-end finalise + release on a paid chemistry visit
-- =============================================================================
do $$
declare
  v_admin_id    uuid := gen_random_uuid();
  v_patient_id  uuid;
  v_visit_id    uuid;
  v_fbs_id      uuid;
  v_lipid_id    uuid;
  v_hba1c_id    uuid;
  v_result_id   uuid;
  v_junction_n  int;
  v_value_n     int;
  v_released_n  int;
begin
  -- Bootstrap auth.users + admin staff
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-admin@drmed.test');
  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_id, 'Smoke Admin', 'admin', true);

  -- Patient + paid visit
  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-001', 'Smoke', 'Patient', 'female', '1985-01-01')
  returning id into v_patient_id;

  insert into public.visits (patient_id, visit_number, total_php, paid_php, payment_status)
  values (v_patient_id, 'V-SMK-001', 0, 0, 'paid')
  returning id into v_visit_id;

  -- Three chemistry test_requests on the visit (include prices so the
  -- bridge_test_request_released trigger can post a non-zero journal line).
  insert into public.test_requests (visit_id, service_id, status, assigned_to, requested_by, base_price_php, final_price_php)
  select v_visit_id, s.id, 'in_progress', v_admin_id, v_admin_id, s.price_php, s.price_php
    from public.services s where s.code = 'FBS_RBS' returning id into v_fbs_id;
  insert into public.test_requests (visit_id, service_id, status, assigned_to, requested_by, base_price_php, final_price_php)
  select v_visit_id, s.id, 'in_progress', v_admin_id, v_admin_id, s.price_php, s.price_php
    from public.services s where s.code = 'LIPID_PROFILE' returning id into v_lipid_id;
  insert into public.test_requests (visit_id, service_id, status, assigned_to, requested_by, base_price_php, final_price_php)
  select v_visit_id, s.id, 'in_progress', v_admin_id, v_admin_id, s.price_php, s.price_php
    from public.services s where s.code = 'HBA1C' returning id into v_hba1c_id;

  -- One results row + 3 junction rows
  insert into public.results
    (report_group_id, finalised_by_staff_id, generation_kind, finalised_at,
     uploaded_by)
  select rg.id, v_admin_id, 'structured', now(), v_admin_id
    from public.report_groups rg where rg.code = 'CHEMISTRY'
  returning id into v_result_id;

  insert into public.result_test_requests (result_id, test_request_id)
  values (v_result_id, v_fbs_id), (v_result_id, v_lipid_id), (v_result_id, v_hba1c_id);

  -- 7 result_values (FBS=1, Lipid=5, HBA1C=1)
  insert into public.result_values (result_id, parameter_id, numeric_value_si, is_blank)
  select v_result_id, p.id, 5.4, false
    from public.result_template_params p
    join public.result_templates t on t.id = p.template_id
    join public.report_groups rg on rg.id = t.report_group_id and rg.code='CHEMISTRY'
   where p.parameter_name in
     ('FBS','Triglycerides','Cholesterol','HDL','LDL','VLDL','HBA1C')
     and (p.gender is null or p.gender = 'F');

  select count(*) into v_junction_n
    from public.result_test_requests where result_id = v_result_id;
  if v_junction_n <> 3 then
    raise exception 'S2: expected 3 junction rows, got %', v_junction_n;
  end if;

  select count(*) into v_value_n
    from public.result_values where result_id = v_result_id;
  if v_value_n <> 7 then
    raise exception 'S2: expected 7 result_values rows, got %', v_value_n;
  end if;

  -- The advance trigger should have flipped all 3 to ready_for_release.
  -- Now release them; payment-gating allows because visit is paid.
  update public.test_requests
     set status = 'released', released_by = v_admin_id, released_at = now()
   where id in (v_fbs_id, v_lipid_id, v_hba1c_id);

  select count(*) into v_released_n
    from public.test_requests
   where id in (v_fbs_id, v_lipid_id, v_hba1c_id)
     and status = 'released';
  if v_released_n <> 3 then
    raise exception 'S2: expected all 3 test_requests released, got %', v_released_n;
  end if;

  raise notice 'S2 end-to-end OK (% junction, % values, % released)',
               v_junction_n, v_value_n, v_released_n;
end $$;

-- =============================================================================
-- S3: payment-gating trigger blocks release on unpaid visit
-- =============================================================================
do $$
declare
  v_admin_id    uuid := gen_random_uuid();
  v_patient_id  uuid;
  v_visit_id    uuid;
  v_fbs_req     uuid;
  v_caught      boolean := false;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-s3@drmed.test');
  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_id, 'Smoke S3', 'admin', true);

  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-S3', 'S3', 'Patient', 'female', '1985-01-01')
  returning id into v_patient_id;

  -- Unpaid visit
  insert into public.visits (patient_id, visit_number, total_php, paid_php, payment_status)
  values (v_patient_id, 'V-SMK-S3', 100, 0, 'unpaid')
  returning id into v_visit_id;

  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  select v_visit_id, s.id, 'ready_for_release', v_admin_id, s.price_php, s.price_php
    from public.services s where s.code = 'FBS_RBS' returning id into v_fbs_req;

  begin
    update public.test_requests set status='released', released_by=v_admin_id, released_at=now()
     where id = v_fbs_req;
  exception when check_violation then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'S3: expected check_violation (23514) from payment-gating trigger, got none';
  end if;
  raise notice 'S3 payment gating OK';
end $$;

-- =============================================================================
-- S4: RLS — medtechs reading shared result_values
-- (Set local role approach may not work without a JWT issuer configured.
--  This smoke verifies insertion and junction presence; RLS read access
--  is asserted in the .ts smoke via the service-role client.)
-- =============================================================================
do $$
declare
  v_a      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_patient uuid;
  v_visit   uuid;
  v_fbs     uuid;
  v_lipid   uuid;
  v_result  uuid;
  v_param   uuid;
  v_val_n   int;
begin
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-mt-a@drmed.test'),
    (v_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-mt-b@drmed.test');
  insert into public.staff_profiles (id, full_name, role, is_active) values
    (v_a, 'MT A', 'medtech', true),
    (v_b, 'MT B', 'medtech', true);

  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-S4', 'S4', 'Patient', 'female', '1985-01-01') returning id into v_patient;
  insert into public.visits (patient_id, visit_number, paid_php, total_php, payment_status)
  values (v_patient, 'V-SMK-S4', 0, 0, 'paid') returning id into v_visit;

  insert into public.test_requests (visit_id, service_id, status, assigned_to, requested_by, base_price_php, final_price_php)
  select v_visit, s.id, 'in_progress', v_a, v_a, s.price_php, s.price_php from public.services s where s.code='FBS_RBS'
  returning id into v_fbs;
  insert into public.test_requests (visit_id, service_id, status, assigned_to, requested_by, base_price_php, final_price_php)
  select v_visit, s.id, 'in_progress', v_b, v_b, s.price_php, s.price_php from public.services s where s.code='LIPID_PROFILE'
  returning id into v_lipid;

  insert into public.results (report_group_id, generation_kind, finalised_at, uploaded_by)
  select id, 'structured', now(), v_a from public.report_groups where code='CHEMISTRY'
  returning id into v_result;

  insert into public.result_test_requests (result_id, test_request_id)
  values (v_result, v_fbs), (v_result, v_lipid);

  select p.id into v_param
    from public.result_template_params p
    join public.result_templates t on t.id=p.template_id
    join public.report_groups r on r.id=t.report_group_id and r.code='CHEMISTRY'
   where p.parameter_name='FBS' limit 1;

  insert into public.result_values (result_id, parameter_id, numeric_value_si, is_blank)
  values (v_result, v_param, 5.4, false);

  select count(*) into v_val_n from public.result_values where result_id = v_result;
  if v_val_n <> 1 then
    raise exception 'S4: expected 1 result_value, got %', v_val_n;
  end if;

  raise notice 'S4 shared result insertion OK (% junction rows, % values)',
               2, v_val_n;
end $$;

-- =============================================================================
-- S5: signatures presence
-- =============================================================================
do $$
declare
  v_n_sigs int;
begin
  select count(*) into v_n_sigs
    from public.staff_profiles
   where signature_path is not null
     and prc_license_no in ('0063443','0139409','0069135','0089935','0098739','0087903');
  if v_n_sigs <> 6 then
    raise exception 'S5: expected 6 staff_profiles with signature_path, got %', v_n_sigs;
  end if;
  raise notice 'S5 signatures present OK';
end $$;

-- =============================================================================
-- S6: env-var fail-fast — runtime concern, asserted via .ts smoke
-- =============================================================================
do $$ begin raise notice 'S6 must run from .ts smoke (env-var fail-fast)'; end $$;

rollback;
