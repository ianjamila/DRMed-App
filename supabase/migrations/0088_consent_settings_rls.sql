-- =============================================================================
-- 0088 — Lock down consent_settings + let the gate read it under RLS
-- =============================================================================
-- Two fixes to the 0086 consent work, caught before it reached prod:
--
-- 1) consent_settings was created without RLS. In Supabase the anon/
--    authenticated roles hold default grants on public tables, so with RLS off
--    ANYONE with the public anon key could read and — worse — flip
--    `gate_required` via PostgREST, silently disabling (or enabling) the
--    consent release gate. Enable RLS and restrict to admins; the server reads
--    it via the service-role client (bypasses RLS) and the gate trigger reads
--    it via SECURITY DEFINER (below).
--
-- 2) The per-test release path (releaseTestAction) runs through the
--    authenticated SSR client, so enforce_consent_before_release() executes as
--    the `authenticated` role. Once consent_settings is under RLS, a plain
--    SELECT of gate_required returns no row for that role → the gate would
--    silently never fire. Recreate the function as SECURITY DEFINER (matching
--    sync_patient_consent_state, has_role, current_patient_id) so it reliably
--    reads the flag and patient state regardless of the invoking role.
-- =============================================================================

-- 1) RLS on the settings table.
alter table public.consent_settings enable row level security;

drop policy if exists "consent_settings: admin manage" on public.consent_settings;
create policy "consent_settings: admin manage"
  on public.consent_settings
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- 2) Gate function as SECURITY DEFINER (body identical to 0086 otherwise).
create or replace function public.enforce_consent_before_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required boolean;
  v_consent boolean;
begin
  if new.status = 'released' and (old.status is null or old.status <> 'released') then
    select gate_required into v_required from public.consent_settings where id = true;
    if coalesce(v_required, false) then
      select p.consent_current into v_consent
      from public.visits v
      join public.patients p on p.id = v.patient_id
      where v.id = new.visit_id;

      if not coalesce(v_consent, false) then
        raise exception
          'cannot release test result: patient data-privacy consent is not on file (RA 10173)'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;
