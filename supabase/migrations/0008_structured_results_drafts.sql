-- =============================================================================
-- 0008_structured_results_drafts.sql
-- =============================================================================
-- Phase 13 Slice 2 enables medtechs to "Save draft" partway through a
-- structured result entry. Two changes vs. the Phase 4 model:
--
--   1. results.storage_path becomes nullable. Drafts have no PDF yet — the
--      app populates the path on Finalise after rendering.
--   2. The status-advancing trigger no longer flips test_requests.status on
--      every results INSERT. For structured rows, status only advances when
--      finalised_at transitions NULL → not-NULL. Uploaded PDFs keep the
--      Phase 4 behavior (advance on insert).
--
-- (The UPDATE policy needed by the upsert path is already present from 0007.)
-- =============================================================================


-- 1. storage_path nullable for drafts.
alter table public.results alter column storage_path drop not null;


-- 2. Trigger now gates on generation_kind + finalised_at.
create or replace function public.advance_test_on_result_upload()
returns trigger
language plpgsql
as $$
declare
  v_request public.test_requests%rowtype;
  v_requires_signoff boolean;
  v_should_advance boolean;
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

  select * into v_request
  from public.test_requests where id = new.test_request_id;

  if v_request.status <> 'in_progress' then
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

drop trigger if exists trg_results_advance_test on public.results;
create trigger trg_results_advance_test
  after insert or update on public.results
  for each row
  execute function public.advance_test_on_result_upload();


