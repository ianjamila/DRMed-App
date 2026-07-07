-- 0112: booking + registration hardening (H6, M4).
--
-- H6a: the public INSERT policy (0001) was with_check(true) — anyone holding
-- the anon key could insert junk appointments. The app's booking paths insert
-- via the service-role client, so the policy is dead surface area: drop it.
--
-- H6b: the conflict check in createAppointmentGroup was check-then-insert with
-- no serialization — two racing bookings for the same physician+slot could
-- both pass the SELECT and both insert. appointments_insert_slot_guarded moves
-- the insert into a SECURITY DEFINER RPC that takes a per-(physician, slot)
-- advisory xact-lock, re-checks occupancy under the lock, and honors
-- allow_concurrent. (Pattern: commit_hmo_history_run, 0036.) A partial unique
-- index can't express this — allow_concurrent physicians legitimately hold N
-- bookings per slot, and a multi-service doctor booking inserts several rows
-- for the same physician+slot within one booking_group.
--
-- M4: resolvePatient was the same TOCTOU shape (SELECT dedup triple, then
-- INSERT) — two concurrent registrations of the same person could create two
-- patient rows. resolve_patient_guarded serializes on the dedup triple.

drop policy if exists "appointments: public insert" on public.appointments;

-- Composite index the conflict check has always lacked (the existing indexes
-- cover scheduled_at and patient_id, not the (physician, slot) probe).
create index if not exists idx_appointments_physician_slot
  on public.appointments (physician_id, scheduled_at)
  where physician_id is not null and scheduled_at is not null;

-- H6b: atomic slot-guarded booking insert. p_rows is the same one-row-per-
-- service array the app previously passed to .insert(); null physician/slot
-- means no slot guard (walk-in labs, pending_callback, lab-request-only).
create or replace function public.appointments_insert_slot_guarded(
  p_rows jsonb,
  p_physician_id uuid default null,    -- null ⇒ no slot guard, plain insert
  p_scheduled_at timestamptz default null,
  p_allow_concurrent boolean default false
)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing int;
  r jsonb;
  v_id uuid;
begin
  if p_physician_id is not null and p_scheduled_at is not null then
    perform pg_advisory_xact_lock(
      hashtext('appt_slot:' || p_physician_id::text || ':' || p_scheduled_at::text)
    );
    if not p_allow_concurrent then
      select count(*) into v_existing
        from public.appointments
       where physician_id = p_physician_id
         and scheduled_at = p_scheduled_at
         and status not in ('cancelled','no_show');
      if v_existing > 0 then
        raise exception 'slot_taken: that slot was just taken'
          using errcode = 'P0040';
      end if;
    end if;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.appointments (
      patient_id, service_id, physician_id, scheduled_at, notes, status,
      booking_group_id, home_service_requested, walk_in_name, walk_in_phone, created_by
    ) values (
      nullif(r->>'patient_id','')::uuid,
      nullif(r->>'service_id','')::uuid,
      nullif(r->>'physician_id','')::uuid,
      nullif(r->>'scheduled_at','')::timestamptz,
      nullif(r->>'notes',''),
      r->>'status',
      nullif(r->>'booking_group_id','')::uuid,
      coalesce((r->>'home_service_requested')::boolean, false),
      nullif(r->>'walk_in_name',''),
      nullif(r->>'walk_in_phone',''),
      nullif(r->>'created_by','')::uuid
    ) returning id into v_id;
    return next v_id;
  end loop;
end;
$$;
revoke all on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean) from public;
grant execute on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean) to service_role;

-- M4: TOCTOU-safe patient resolve. Same dedup contract as resolvePatient
-- (match on lower(email) + last_name + birthdate → reuse, never overwrite
-- contact fields; else insert with pre_registered = true), but the
-- check-then-insert runs under an advisory lock on the dedup triple so two
-- concurrent resolves of the same identity yield one row.
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true
  ) returning patients.id, patients.drm_id, false;
end;
$$;
revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;
