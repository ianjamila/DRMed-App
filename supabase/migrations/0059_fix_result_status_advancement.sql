-- =============================================================================
-- 0059_fix_result_status_advancement.sql
-- =============================================================================
-- Hotfix: uploaded results never advanced test_requests.status.
--
-- The advance trigger lived on `results` and walked `result_test_requests` to
-- find linked test_requests. But the application inserts the result FIRST and
-- the junction row SECOND — at the moment the trigger fired, no junction row
-- existed, the walk loop iterated zero times, and the test stayed at
-- in_progress.
--
-- The symptom: re-uploading on the stuck test trips
-- uq_result_test_requests_test_request and surfaces a duplicate-key error.
--
-- Fix: move the INSERT-path advancement to fire on result_test_requests INSERT
-- (when both sides exist). Keep the UPDATE-path on results so structured
-- draft→finalised still flips correctly. Backfill stuck rows.
--
-- Also tightens send-out enforcement at the DB level: block creating a
-- result_template against a service with is_send_out=true.
-- =============================================================================


-- ----- 1. Junction-driven advance function ----------------------------------
-- Fires AFTER INSERT on result_test_requests. Looks up the linked result and
-- advances the linked test_request from in_progress when the result is
-- "complete" (uploaded PDF, or a structured row that's already finalised).
create or replace function public.advance_test_on_rtr_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result           public.results%rowtype;
  v_request          public.test_requests%rowtype;
  v_should_advance   boolean;
  v_requires_signoff boolean;
begin
  select * into v_result from public.results where id = new.result_id;
  if not found then
    return new;
  end if;

  v_should_advance := (v_result.generation_kind = 'uploaded')
                   or (v_result.generation_kind = 'structured'
                       and v_result.finalised_at is not null);
  if not v_should_advance then
    return new;
  end if;

  select * into v_request from public.test_requests
  where id = new.test_request_id;
  if not found or v_request.status <> 'in_progress' then
    return new;
  end if;

  select coalesce(s.requires_signoff, false) into v_requires_signoff
  from public.services s where s.id = v_request.service_id;

  update public.test_requests
  set status = case when v_requires_signoff
                    then 'result_uploaded'
                    else 'ready_for_release' end,
      completed_at = now(),
      updated_at = now()
  where id = new.test_request_id;

  return new;
end;
$$;

drop trigger if exists trg_rtr_advance_test on public.result_test_requests;
create trigger trg_rtr_advance_test
  after insert on public.result_test_requests
  for each row
  execute function public.advance_test_on_rtr_insert();


-- ----- 2. Make existing results trigger UPDATE-only -------------------------
-- The INSERT branch was always a no-op given the app's write order. Removing
-- it keeps the trigger from misleading future readers.
drop trigger if exists trg_results_advance_test on public.results;
create trigger trg_results_advance_test
  after update on public.results
  for each row
  execute function public.advance_test_on_result_upload();


-- ----- 3. Backfill stuck test_requests --------------------------------------
-- Any test_request still at in_progress that already has a "complete" result
-- linked should advance now. CTE-first because Postgres won't let the target
-- of an UPDATE be referenced in joins inside the FROM clause.
with stuck as (
  select tr.id                                       as test_request_id,
         coalesce(s.requires_signoff, false)         as requires_signoff
  from public.test_requests tr
  join public.result_test_requests rtr on rtr.test_request_id = tr.id
  join public.results r                on r.id = rtr.result_id
  join public.services s               on s.id = tr.service_id
  where tr.status = 'in_progress'
    and (
      r.generation_kind = 'uploaded'
      or (r.generation_kind = 'structured' and r.finalised_at is not null)
    )
)
update public.test_requests tr
set status       = case when stuck.requires_signoff
                        then 'result_uploaded'
                        else 'ready_for_release' end,
    completed_at = coalesce(tr.completed_at, now()),
    updated_at   = now()
from stuck
where stuck.test_request_id = tr.id;


-- ----- 4. DB-level send-out guard on result_templates -----------------------
-- Defense-in-depth: the admin UI already blocks template creation for
-- send-out services and the structured-entry action rejects them, but a
-- service flipping is_send_out=true after a template exists, or a direct
-- INSERT via service_role, should still be rejected.
create or replace function public.assert_template_service_not_send_out()
returns trigger
language plpgsql
as $$
declare
  v_send_out boolean;
begin
  if new.service_id is null then
    return new;
  end if;

  select is_send_out into v_send_out
  from public.services where id = new.service_id;

  if coalesce(v_send_out, false) then
    raise exception
      'Send-out services cannot have a structured result template '
      '(service_id=%). Send-out results use the partner-lab PDF.', new.service_id
      using errcode = 'P0035';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_result_templates_no_send_out
  on public.result_templates;
create trigger trg_result_templates_no_send_out
  before insert or update of service_id on public.result_templates
  for each row
  execute function public.assert_template_service_not_send_out();
