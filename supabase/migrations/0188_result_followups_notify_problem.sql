-- =============================================================================
-- 0188_result_followups_notify_problem.sql
-- =============================================================================
-- Result Follow-ups says "Send failed — call the patient" for every patient
-- notice that reached nobody, but not WHY. Reception can act differently on
-- each cause (fix the number / no contact to fix / tell the admin the
-- notices aren't set up), so result_outdated_copies gains one column:
--
--   notify_problem  null | 'not_set_up' | 'no_contact' | 'send_error'
--
-- derived from result_amendments.patient_notify_error, whose values are
-- written by src/lib/notifications/notify-corrected.ts (describeSendFailure):
--   "notices not set up: <reasons>"  → not_set_up
--   "no contact on file"             → no_contact
--   anything else (provider error, "internal error while sending") → send_error
-- The raw text still never leaves the database (0179's rule for staff RPCs).
--
-- Adding an OUT column changes the return type, so the function is dropped
-- and re-created from 0179's body, unchanged apart from the new column; its
-- ACL is restated as 0179 left it (authenticated + service_role; the body
-- itself refuses anyone but reception/admin with 42501). Nothing else in SQL
-- calls it.
-- =============================================================================

drop function public.result_outdated_copies(boolean);

create function public.result_outdated_copies(p_include_followed_up boolean default false)
returns table (
  result_id           uuid,
  latest_amendment_id uuid,
  amendment_count     int,
  amended_at          timestamptz,
  visit_id            uuid,
  patient_id          uuid,
  patient_name        text,
  drm_id              text,
  phone               text,
  has_email           boolean,
  test_names          text,
  portal_outdated     boolean,
  printed_outdated    boolean,
  followed_up         boolean,
  contacted_at        timestamptz,
  contacted_by_name   text,
  notified_at         timestamptz,
  notified_channels   text[],
  notify_failed       boolean,
  notify_problem      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.staff_role();
begin
  if v_role is null or v_role not in ('reception', 'admin') then
    raise exception 'reception or admin only' using errcode = '42501';
  end if;
  return query
    select s.result_id, s.latest_amendment_id, s.amendment_count, s.amended_at,
           s.visit_id, s.patient_id,
           nullif(btrim(concat_ws(' ', pt.first_name, pt.last_name)), ''),
           pt.drm_id, pt.phone, s.has_email,
           (select string_agg(x.name, ', ' order by x.name)
              from (select distinct sv.name
                      from public.result_test_requests rtr
                      join public.test_requests tr
                        on tr.id = rtr.test_request_id and tr.deleted_at is null
                      join public.services sv on sv.id = tr.service_id
                     where rtr.result_id = s.result_id) x),
           s.portal_outdated, s.printed_outdated, s.followed_up,
           s.contacted_at, sp.full_name, s.notified_at, s.notified_channels,
           (s.notify_error is not null),
           -- 0188: a coarse category, never the raw text (which can carry
           -- provider messages). notify-corrected.ts writes these prefixes.
           case
             when s.notify_error is null then null
             when s.notify_error like 'notices not set up%' then 'not_set_up'
             when s.notify_error = 'no contact on file' then 'no_contact'
             else 'send_error'
           end
      from public.result_copy_states_internal(null) s
      join public.visits v on v.id = s.visit_id and v.deleted_at is null
      -- 0167: this list is a patient-contact list, and 0167 removes inactive
      -- (deleted/merged) records from patient contact — an inner join so an
      -- inactive patient's rows drop off entirely.
      join public.patients pt on pt.id = s.patient_id
                              and pt.deleted_at is null and pt.merged_into_id is null
      left join public.staff_profiles sp on sp.id = s.contacted_by
     where (s.portal_outdated or s.printed_outdated)
       and (p_include_followed_up or not s.followed_up)
     order by s.amended_at desc, s.result_id;
end;
$$;
revoke all on function public.result_outdated_copies(boolean) from public, anon;
grant execute on function public.result_outdated_copies(boolean) to authenticated, service_role;
