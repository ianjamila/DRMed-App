-- =============================================================================
-- 0051_consolidated_reports_and_signatures.sql
-- =============================================================================
-- Visit-consolidated reports + embedded signatures schema.
-- See docs/superpowers/specs/2026-05-22-visit-consolidated-report-design.md
-- =============================================================================

-- ----- 1. report_groups ------------------------------------------------------
create table public.report_groups (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.report_groups enable row level security;

create policy "report_groups: staff read"
  on public.report_groups for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "report_groups: admin manage"
  on public.report_groups for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- 2. services.report_group_id ------------------------------------------
alter table public.services
  add column report_group_id uuid references public.report_groups(id);

create index idx_services_report_group on public.services(report_group_id)
  where report_group_id is not null;

-- ----- 3. result_templates: group target ------------------------------------
alter table public.result_templates
  alter column service_id drop not null,
  add column report_group_id uuid references public.report_groups(id),
  add constraint result_templates_target_xor
    check (
      (service_id is not null and report_group_id is null) or
      (service_id is null and report_group_id is not null)
    );

create unique index uq_result_templates_report_group
  on public.result_templates(report_group_id)
  where report_group_id is not null;

-- ----- 4. result_test_requests junction -------------------------------------
create table public.result_test_requests (
  result_id        uuid not null references public.results(id) on delete cascade,
  test_request_id  uuid not null references public.test_requests(id) on delete restrict,
  created_at       timestamptz not null default now(),
  primary key (result_id, test_request_id)
);

create unique index uq_result_test_requests_test_request
  on public.result_test_requests(test_request_id);

alter table public.result_test_requests enable row level security;

create policy "result_test_requests: staff read"
  on public.result_test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "result_test_requests: admin manage"
  on public.result_test_requests for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- 5. Backfill junction --------------------------------------------------
insert into public.result_test_requests (result_id, test_request_id)
select id, test_request_id from public.results
where test_request_id is not null;

-- ----- 6. Drop policies that depend on results.test_request_id --------------
-- These must be dropped before the column drop. Recreated in step 10 to walk
-- the junction.
drop policy if exists "results: patient released only" on public.results;
drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
drop policy if exists "result_values: read by owning medtech + pathologist + admin" on public.result_values;

-- ----- 7. results deltas -----------------------------------------------------
alter table public.results
  add column report_group_id uuid references public.report_groups(id),
  add column finalised_by_staff_id uuid references public.staff_profiles(id),
  drop column test_request_id;

create index idx_results_report_group on public.results(report_group_id)
  where report_group_id is not null;

create index idx_results_finalised_by on public.results(finalised_by_staff_id);

-- ----- 8. staff_profiles deltas ---------------------------------------------
-- staff_profiles.id IS auth.users.id (FK on delete cascade). No auth_user_id.
alter table public.staff_profiles
  add column signature_path text,
  add column signature_uploaded_at timestamptz;

-- ----- 9. Update result-flip trigger function -------------------------------
-- Replaces the function defined in 0008_structured_results_drafts.sql.
-- The trigger binding (trg_results_advance_test) was also created in 0008 and
-- remains unchanged — only the function body is replaced here.
-- On INSERT: flips every linked test_request (via result_test_requests) from
--   in_progress → result_uploaded (if service.requires_signoff) or
--   → ready_for_release (if not), when the result should advance.
-- On UPDATE: same but only when a structured result transitions
--   finalised_at from NULL → not-NULL.
create or replace function public.advance_test_on_result_upload()
returns trigger
language plpgsql
as $$
declare
  v_should_advance boolean;
  v_rtr            record;
  v_request        public.test_requests%rowtype;
  v_requires_signoff boolean;
begin
  if (tg_op = 'INSERT') then
    -- Uploaded PDFs are complete the moment they're inserted.
    -- Structured rows might be finalised at insert time (rare but allowed).
    v_should_advance := (new.generation_kind = 'uploaded')
                     or (new.generation_kind = 'structured' and new.finalised_at is not null);
  else
    -- UPDATE: only advance when a previously-draft structured result becomes
    -- finalised. Avoids re-firing on subsequent edits and on uploaded-row
    -- updates (e.g. notes changes).
    v_should_advance := new.generation_kind = 'structured'
                     and new.finalised_at is not null
                     and old.finalised_at is null;
  end if;

  if not v_should_advance then
    return new;
  end if;

  -- Walk the junction: flip every linked test_request that is still in_progress.
  for v_rtr in
    select test_request_id
    from public.result_test_requests
    where result_id = new.id
  loop
    select * into v_request
    from public.test_requests
    where id = v_rtr.test_request_id;

    if v_request.status <> 'in_progress' then
      continue;
    end if;

    select coalesce(s.requires_signoff, false) into v_requires_signoff
    from public.services s where s.id = v_request.service_id;

    update public.test_requests
    set status = case when v_requires_signoff
                      then 'result_uploaded'
                      else 'ready_for_release' end,
        completed_at = now(),
        updated_at = now()
    where id = v_rtr.test_request_id;
  end loop;

  return new;
end;
$$;

-- ----- 10. Recreate dropped policies to walk junction -----------------------
-- Patient portal: a patient can SELECT a results row when ANY of its linked
-- test_requests has been released for one of their visits.
create policy "results: patient released only"
  on public.results for select to authenticated
  using (
    exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      join public.visits v on v.id = tr.visit_id
      where rtr.result_id = results.id
        and tr.status = 'released'
        and v.patient_id = public.current_patient_id()
    )
  );

create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  )
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

create policy "result_values: read by owning medtech + pathologist + admin"
  on public.result_values for select to authenticated
  using (
    public.has_role(array['pathologist', 'admin'])
    or exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and tr.assigned_to = auth.uid()
        and public.has_role(array['medtech'])
    )
  );
