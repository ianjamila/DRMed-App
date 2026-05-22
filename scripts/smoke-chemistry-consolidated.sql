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

rollback;
