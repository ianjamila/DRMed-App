-- 0032_helpers_security_definer.sql
-- Spec compliance fix: bring coa_uuid_for_code and bridge_replay_summary
-- in line with the "all helpers are security definer with locked search_path"
-- spec requirement. Bodies unchanged.

create or replace function public.coa_uuid_for_code(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.chart_of_accounts where code = p_code;
$$;

create or replace function public.bridge_replay_summary(
  p_start timestamptz,
  p_end   timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'je_count', (
      select count(*) from public.journal_entries
      where created_at between p_start and p_end and status = 'posted'
    ),
    'suspense_postings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_number', je.entry_number,
        'source_kind', je.source_kind,
        'source_id', je.source_id,
        'amount', jl.debit_php + jl.credit_php
      ))
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
      join public.chart_of_accounts coa on coa.id = jl.account_id
      where je.created_at between p_start and p_end
        and coa.code = '9999'
        and je.status = 'posted'
    ), '[]'::jsonb),
    'totals_by_account', coalesce((
      select jsonb_object_agg(coa.code,
        jsonb_build_object('debit', sum_d, 'credit', sum_c))
      from (
        select jl.account_id,
          sum(jl.debit_php) as sum_d,
          sum(jl.credit_php) as sum_c
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.entry_id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by jl.account_id
      ) agg
      join public.chart_of_accounts coa on coa.id = agg.account_id
    ), '{}'::jsonb),
    'unbalanced_count', (
      select count(*) from (
        select je.id
        from public.journal_entries je
        join public.journal_lines jl on jl.entry_id = je.id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by je.id
        having sum(jl.debit_php) <> sum(jl.credit_php)
      ) unbal
    )
  );
$$;
