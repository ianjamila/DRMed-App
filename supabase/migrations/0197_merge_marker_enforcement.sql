-- =============================================================================
-- 0197_merge_marker_enforcement.sql — patient-delete rollout PR 3b follow-up
-- =============================================================================
-- Merge markers (patients.merged_into_id / merged_at) now change ONLY through
-- merge_patients_guarded / undo_patient_merge_guarded (0196), which run as the
-- private role patient_merge_writer. Shipped separately, after the app that
-- calls those functions was deployed and verified (spec deploy order; 0196 and
-- its app went live together in #286 on 2026-10-01).
-- Legal transitions, for the writer only:
--   merge     (null, null) -> (X, t)   on a row that is not deleted
--   undo      (X, t)       -> (null, null)
--   re-parent (X, t)       -> (Y, t)   (chain flattening / restore)
-- A merged row refuses every other change except bookkeeping (P0058, like
-- 0167 does for deleted rows). INSERT of an already-merged row is refused.
-- Same shape as 0167's enforce_patient_lifecycle: SECURITY INVOKER, keyed on
-- current_user, which inside the writer-owned SECURITY DEFINER functions is
-- patient_merge_writer. BEFORE triggers fire in name order:
-- trg_patients_lifecycle_guard runs first (a deleted row stays P0058), then
-- this guard, then the normalise / referral-origin / updated_at triggers — so
-- this guard compares the statement's own values against OLD.
-- This migration SUPERSEDES 0196's narrower rollback guard (section 5): this
-- trigger covers every merged_into_id/merged_at change, writer or not, so
-- 0196's guard_live_merge_marker + patient_has_live_v2_merge are dropped.
-- Rollback: drop trigger trg_patients_merge_marker_guard (app unaffected) —
-- that leaves NO marker guard (0196's is dropped here), so reverting 0197 =
-- drop the trigger AND re-run 0196 section 5 to restore the narrower guard.
-- An app rollback below #286 (the pre-0196 multi-step merge) must do both
-- FIRST: with 0197 in place the old merge moves every row, then its final
-- tombstone write fails P0080 and leaves only a best-effort app-side rollback.
-- Bulk backfills of patients: exclude merged rows, or disable BOTH
-- trg_patients_lifecycle_guard and trg_patients_merge_marker_guard inside the
-- migration and assert both are re-enabled (0170 disabled only the first).
-- =============================================================================

set lock_timeout = '5s';

-- Superseded by the trigger below (Opus SQL review fix round 1, F8).
drop trigger if exists trg_patients_live_merge_guard on public.patients;
drop function if exists public.guard_live_merge_marker();
drop function if exists public.patient_has_live_v2_merge(uuid);

create or replace function public.enforce_merge_marker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_marker constant text[] := array['merged_into_id', 'merged_at', 'updated_at', 'row_version'];
  k_bookkeeping constant text[] := array['updated_at', 'row_version'];
begin
  if tg_op = 'INSERT' then
    if new.merged_into_id is not null or new.merged_at is not null then
      raise exception 'a patient record cannot be created already merged' using errcode = 'P0080';
    end if;
    return new;
  end if;

  if (new.merged_into_id, new.merged_at) is distinct from (old.merged_into_id, old.merged_at) then
    if current_user <> 'patient_merge_writer' then
      raise exception 'patient % can only be merged or un-merged from Admin Tools', old.drm_id
        using errcode = 'P0080';
    end if;
    if (to_jsonb(new) - k_marker) is distinct from (to_jsonb(old) - k_marker) then
      raise exception 'a merge or un-merge cannot change any other field in the same statement'
        using errcode = 'P0080';
    end if;
    if old.merged_into_id is null and new.merged_into_id is not null then
      if old.merged_at is not null or new.merged_at is null or new.deleted_at is not null then
        raise exception 'a merge sets both merge fields on an active record' using errcode = 'P0080';
      end if;
    elsif old.merged_into_id is not null and new.merged_into_id is null then
      if new.merged_at is not null then
        raise exception 'an un-merge clears both merge fields' using errcode = 'P0080';
      end if;
    elsif old.merged_into_id is not null and new.merged_into_id is not null then
      if new.merged_at is distinct from old.merged_at then
        raise exception 're-pointing a merged record keeps its merge time' using errcode = 'P0080';
      end if;
    else
      raise exception 'merged_at cannot change without a merge' using errcode = 'P0080';
    end if;
    return new;
  end if;

  if old.merged_into_id is not null
     and (to_jsonb(new) - k_bookkeeping) is distinct from (to_jsonb(old) - k_bookkeeping) then
    raise exception 'patient % was merged into another record — edit that record instead', old.drm_id
      using errcode = 'P0058';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_merge_marker() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_merge_marker_guard on public.patients;
create trigger trg_patients_merge_marker_guard
  before insert or update on public.patients
  for each row execute function public.enforce_merge_marker();

do $assert$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_patients_merge_marker_guard'
                   and tgrelid = 'public.patients'::regclass and tgenabled = 'O') then
    raise exception '0197: trg_patients_merge_marker_guard missing or disabled';
  end if;
  if exists (select 1 from pg_proc where oid = 'public.enforce_merge_marker()'::regprocedure and prosecdef) then
    raise exception '0197: enforce_merge_marker must be SECURITY INVOKER (it keys on current_user)';
  end if;
  if has_function_privilege('anon', 'public.enforce_merge_marker()', 'execute')
     or has_function_privilege('authenticated', 'public.enforce_merge_marker()', 'execute')
     or has_function_privilege('service_role', 'public.enforce_merge_marker()', 'execute') then
    raise exception '0197: enforce_merge_marker is executable by a runtime role';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'trg_patients_live_merge_guard')
     or to_regprocedure('public.patient_has_live_v2_merge(uuid)') is not null then
    raise exception '0197: the superseded 0196 guard is still installed';
  end if;
  if exists (select 1 from public.patients where (merged_into_id is null) <> (merged_at is null)) then
    raise exception '0197: existing rows have only one of merged_into_id / merged_at set — reconcile first';
  end if;
end
$assert$;

reset lock_timeout;
