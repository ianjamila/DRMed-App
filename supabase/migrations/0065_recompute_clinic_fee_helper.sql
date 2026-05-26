-- =============================================================================
-- 0065_recompute_clinic_fee_helper.sql
-- =============================================================================
-- Admin-triggered scrub for clinic_fee_php on unreleased test_requests where
-- the attending physician is rent_paying or shareholder. See spec §3.5.
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
  with updated as (
    update public.test_requests tr
      set clinic_fee_php = 0,
          doctor_pf_php = tr.final_price_php
      from public.visits v
      left join public.physicians p
        on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
      where v.id = tr.visit_id
        and p.compensation_arrangement in ('rent_paying', 'shareholder')
        and tr.clinic_fee_php > 0
        and not exists (
          select 1 from public.journal_entries je
          where je.source_kind = 'test_request' and je.source_id = tr.id and je.status = 'posted'
        )
      returning tr.id
  )
  select count(*) into v_affected from updated;

  return jsonb_build_object('rows_affected', v_affected);
end;
$$;

revoke all on function public.recompute_clinic_fee_for_unreleased() from public;
