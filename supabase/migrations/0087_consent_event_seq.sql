-- =============================================================================
-- 0087 — Bulletproof consent-event ordering
-- =============================================================================
-- The 0086 sync trigger resolved a patient's latest consent event by
-- (created_at desc, id desc). created_at can tie when two events land in the
-- same instant (e.g. the same transaction), and the id tie-break is a random
-- UUID — so ordering was not provably deterministic. Add a monotonic identity
-- column and order by it instead. In production, events for a patient arrive in
-- separate transactions so created_at already differs; this just removes the
-- theoretical tie.
-- =============================================================================

alter table public.patient_consents
  add column if not exists seq bigint generated always as identity;

-- Re-define the sync function to order by the monotonic seq.
create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.patient_consents%rowtype;
begin
  select * into v_latest
  from public.patient_consents
  where patient_id = new.patient_id
  order by seq desc
  limit 1;

  if v_latest.event_type = 'granted' then
    update public.patients set
      consent_current = true,
      consent_signed_at = v_latest.created_at,
      consent_withdrawn_at = null,
      consent_method = v_latest.method,
      consent_notice_version = v_latest.notice_version
    where id = new.patient_id;
  else
    update public.patients set
      consent_current = false,
      consent_withdrawn_at = v_latest.created_at
      -- consent_signed_at left as the historical grant time on purpose.
    where id = new.patient_id;
  end if;
  return null;
end;
$$;
