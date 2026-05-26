-- =============================================================================
-- 0066_fix_recompute_clinic_fee.sql
-- =============================================================================
-- Hotfix for 0065. The original function used UPDATE ... FROM ... LEFT JOIN
-- where the JOIN's ON clause referenced tr.attending_physician_id (the
-- UPDATE target's alias). PostgreSQL rejects that with:
--
--   ERROR: invalid reference to FROM-clause entry for table "tr"
--
-- because the UPDATE target's column scope isn't available to JOIN conditions
-- inside the FROM clause. Rewrite using a subquery that resolves the set of
-- affected test_request ids first; UPDATE then applies the fields by id.
-- =============================================================================

create or replace function public.recompute_clinic_fee_for_unreleased()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected int;
begin
  with target_ids as (
    select tr.id
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
    left join public.physicians p
      on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
    where p.compensation_arrangement in ('rent_paying', 'shareholder')
      and tr.clinic_fee_php > 0
      and not exists (
        select 1 from public.journal_entries je
        where je.source_kind = 'test_request'
          and je.source_id = tr.id
          and je.status = 'posted'
      )
  ),
  updated as (
    update public.test_requests tr2
      set clinic_fee_php = 0,
          doctor_pf_php = tr2.final_price_php
      where tr2.id in (select id from target_ids)
      returning tr2.id
  )
  select count(*) into v_affected from updated;

  return jsonb_build_object('rows_affected', v_affected);
end;
$$;

revoke all on function public.recompute_clinic_fee_for_unreleased() from public;
