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

rollback;
