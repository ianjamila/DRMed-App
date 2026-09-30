-- 0204: clear sheet_patient_links.held_patient_id when a key stops meaning
-- "held because of that deleted patient".
--
-- 0193 added held_patient_id: a deleted-patient hold (hold_reason
-- 'matches_deleted_patient') records WHICH patient. It is only meaningful while
-- the row is that hold. The planner already gates every read on
-- hold_reason = 'matches_deleted_patient' (which only a review row can carry,
-- sheet_patient_links_hold_reason), and the hold op already replaces / clears it,
-- so a stale value was never harmful — this just stops it lingering:
--   * sheet_review_resolve: an admin Link / Create overwrites the hold, so the
--     deleted-patient pointer goes with it. (Dismiss "Keep deleted" / "Keep
--     undone" leaves the link row untouched on purpose — the row IS still held
--     for that deleted patient.)
--   * sheet_sync_revert_run: the three places an Undo re-holds a link
--     ('undone by an admin') now clear it. "Let the sync decide again"
--     (sheet_sync_release_undo) DELETES the undo holds, so it needs no change,
--     and the sync's own hold op (0193) is untouched — re-holding the same
--     deleted patient must keep the id.
-- Bodies are the 0170 bodies (nothing later redefines either function) plus
-- exactly these hunks. ACLs restated: service_role only.

create or replace function public.sheet_sync_revert_run(p_lease_token uuid, p_target_run uuid, p_limit integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_target public.sheet_sync_runs%rowtype;
  v_sync_run boolean;
  v_left bigint;
  v_done boolean;
  v_pid uuid;
  v_ver bigint;
  v_del_at timestamptz;
  v_map jsonb;
  v_cur public.patients%rowtype;
  v_new public.patients%rowtype;
  v_alias public.referral_source_aliases%rowtype;
  v_restore jsonb;
  v_rows int;
  n_restored int := 0; n_blocked int := 0; n_deleted int := 0; n_kept int := 0; n_held int := 0;
  n_alias_removed int := 0; n_alias_restored int := 0; n_links_left int := 0; n_gone int := 0;
begin
  if p_limit is not null and p_limit < 1 then
    raise exception 'The undo page size must be at least 1.' using errcode = '22023';
  end if;
  v_left := coalesce(p_limit, 2147483647);
  select * into v_target from public.sheet_sync_runs r where r.id = p_target_run for update;
  if not found then
    raise exception 'Unknown sheet sync run.' using errcode = '22023';
  end if;
  if v_target.reverted_by_run_id is not null then
    raise exception 'This run has already been undone.' using errcode = '22023';
  end if;
  if v_target.trigger = 'revert' then
    raise exception 'An undo cannot itself be undone.' using errcode = '22023';
  end if;
  if v_target.trigger = 'release' then
    raise exception 'Letting the sync decide again cannot be undone.' using errcode = '22023';
  end if;
  if v_target.status = 'running' then
    raise exception 'That run has not finished.' using errcode = '22023';
  end if;
  v_sync_run := v_target.trigger in ('cron','manual','cli');

  for v_pid, v_ver, v_map in
    -- order by id desc: when one run changed a column twice, the EARLIEST
    -- before-image (the true pre-run value) is aggregated last and wins.
    select c.patient_id, max(c.row_version_after), jsonb_object_agg(c.column_name, c.old_value order by c.id desc)
      from public.sheet_sync_changes c
     where c.run_id = p_target_run and c.change_kind = 'update' and c.undo_outcome is null
     group by c.patient_id
     order by c.patient_id
     limit v_left
  loop
    v_left := v_left - 1;
    select * into v_cur from public.patients p where p.id = v_pid for update;
    -- 0167 active-patient rule: a patient staff has since soft-deleted or
    -- merged must never receive this UPDATE (the lifecycle guard would raise
    -- P0058 on a deleted target). In practice the delete/merge write itself
    -- already bumps row_version (trg_patients_referral_origin fires on every
    -- UPDATE, deletion included), so `v_cur.row_version <> v_ver` alone
    -- already catches this — the explicit checks below are the direct,
    -- self-documenting guarantee, independent of that incidental side
    -- effect. Either way this is `blocked`, never a raised error, and (same
    -- as every other `blocked` row here) its links are left exactly as the
    -- blocked rule already leaves them — nothing below touches links for a
    -- row that continues here.
    if not found or v_cur.row_version <> v_ver or v_cur.deleted_at is not null or v_cur.merged_into_id is not null then
      update public.sheet_sync_changes set undo_outcome = 'blocked', undo_run_id = v_run
       where run_id = p_target_run and patient_id = v_pid and change_kind = 'update' and undo_outcome is null;
      n_blocked := n_blocked + 1;
      continue;
    end if;
    -- The origin is only recorded when it changed. When it did not (a
    -- sheet -> sheet channel move), row_version equality proves the current
    -- origin is still the pre-run one, so restore under that.
    perform set_config('app.referral_origin',
      coalesce(v_map->>'referral_source_origin', v_cur.referral_source_origin, 'staff'), true);
    update public.patients p set
      phone = case when v_map ? 'phone' then v_map->>'phone' else p.phone end,
      email = case when v_map ? 'email' then v_map->>'email' else p.email end,
      birthdate = case when v_map ? 'birthdate' then (v_map->>'birthdate')::date else p.birthdate end,
      sex = case when v_map ? 'sex' then v_map->>'sex' else p.sex end,
      address = case when v_map ? 'address' then v_map->>'address' else p.address end,
      referred_by_doctor = case when v_map ? 'referred_by_doctor' then v_map->>'referred_by_doctor' else p.referred_by_doctor end,
      preferred_release_medium = case when v_map ? 'preferred_release_medium' then v_map->>'preferred_release_medium' else p.preferred_release_medium end,
      senior_pwd_id_kind = case when v_map ? 'senior_pwd_id_kind' then v_map->>'senior_pwd_id_kind' else p.senior_pwd_id_kind end,
      senior_pwd_id_number = case when v_map ? 'senior_pwd_id_number' then v_map->>'senior_pwd_id_number' else p.senior_pwd_id_number end,
      referral_source = case when v_map ? 'referral_source' then v_map->>'referral_source' else p.referral_source end
    where p.id = v_pid
    returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_cur), to_jsonb(v_new));
    update public.sheet_sync_changes set reverted_at = now(), undo_outcome = 'restored', undo_run_id = v_run
     where run_id = p_target_run and patient_id = v_pid and change_kind = 'update';
    n_restored := n_restored + 1;
    if v_sync_run then
      -- Hold the auto links that would re-fill what was just restored.
      update public.sheet_patient_links l
         set decision = 'review', patient_id = null, run_id = v_run, decided_at = now(),
             hold_reason = 'undone by an admin', held_patient_id = null
       where l.patient_id = v_pid and l.decision = 'link' and l.method <> 'admin';
      get diagnostics v_rows = row_count;
      n_held := n_held + v_rows;
    end if;
  end loop;

  if v_left > 0 then
    for v_pid in select c.patient_id from public.sheet_sync_changes c
                  where c.run_id = p_target_run and c.change_kind = 'create' and c.undo_outcome is null
                  order by c.patient_id
                  limit v_left loop
      select p.row_version, p.deleted_at into v_ver, v_del_at from public.patients p where p.id = v_pid for update;
      if not found then
        -- removed by staff since: nothing left to undo
        update public.sheet_sync_changes set undo_outcome = 'gone', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_gone := n_gone + 1;
        continue;
      end if;
      if v_del_at is not null then
        -- 0167: an admin has since soft-deleted this created patient. 0167's
        -- active-patient rule treats a deleted record the same as one that
        -- vanished — nothing left here for THIS undo to act on (never a hard
        -- DELETE against a deleted row: the lifecycle guard would raise
        -- P0058, and there is no reason to fight that decision). `gone`, not
        -- `kept`: unlike `kept` below (a real edit worth preserving), this
        -- patient is already administratively removed from the active set —
        -- restoring it is Admin Tools › Deleted Patients' job, not undo's.
        update public.sheet_sync_changes set undo_outcome = 'gone', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_gone := n_gone + 1;
        continue;
      end if;
      if v_ver <> 0 then
        update public.sheet_sync_changes set undo_outcome = 'kept', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_kept := n_kept + 1;
        continue;
      end if;
      -- patient_consents.patient_id is the ONE column that references
      -- patients ON DELETE CASCADE (confirmed against pg_constraint —
      -- appointments/audit_log/critical_alerts/patient_merges/visits are all
      -- NO ACTION and are caught by the foreign_key_violation handler below;
      -- appointment_attachments is ON DELETE SET NULL, not a blocker).
      -- Deleting straight through would silently take a consent record with
      -- it instead of raising, so check for one first and treat it exactly
      -- like the foreign_key_violation case: keep the patient, hold nothing.
      -- audit_log.patient_id (NO ACTION) is the other de-facto gate on this
      -- delete, already covered by the exception handler. In today's app,
      -- trg_patient_consents_sync (an AFTER INSERT trigger on
      -- patient_consents) already UPDATEs the patient row on every consent
      -- write, which the ownership trigger above turns into a row_version
      -- bump — so v_ver <> 0 already catches this case in practice. This
      -- check stays as the direct, self-documenting guarantee: it does not
      -- depend on that other trigger continuing to exist or to always touch
      -- patients.
      if exists (select 1 from public.patient_consents c where c.patient_id = v_pid) then
        update public.sheet_sync_changes set undo_outcome = 'kept', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_kept := n_kept + 1;
        continue;
      end if;
      begin
        -- Hold (not cascade-delete) every key that pointed at this patient.
        update public.sheet_patient_links
           set decision = 'review', patient_id = null, run_id = v_run, decided_at = now(),
               hold_reason = 'undone by an admin', held_patient_id = null
         where patient_id = v_pid;
        get diagnostics v_rows = row_count;
        delete from public.patient_acquisition_facts where patient_id = v_pid;
        update public.sheet_customer_rows set patient_id = null, link_state = 'unlinked' where patient_id = v_pid;
        update public.sheet_encounter_lines set patient_id = null where patient_id = v_pid;
        delete from public.patients where id = v_pid;
        update public.sheet_sync_changes set reverted_at = now(), undo_outcome = 'deleted', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_deleted := n_deleted + 1;
        n_held := n_held + v_rows;
      exception when foreign_key_violation then
        update public.sheet_sync_changes set undo_outcome = 'kept', undo_run_id = v_run
         where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
        n_kept := n_kept + 1;
      end;
    end loop;
  end if;

  v_done := not exists (select 1 from public.sheet_sync_changes c
                         where c.run_id = p_target_run and c.undo_outcome is null);
  if v_done then
    -- The run's own auto decisions (still the latest word on their key) ->
    -- holds, except the links of a patient the undo did not undo (kept or
    -- blocked): those stay and are counted as links_left.
    update public.sheet_patient_links l
       set decision = 'review', patient_id = null, run_id = v_run, decided_at = now(),
           hold_reason = 'undone by an admin', held_patient_id = null
     where l.run_id = p_target_run and l.method <> 'admin' and l.decision <> 'review'
       and not exists (select 1 from public.sheet_sync_changes c
                        where c.run_id = p_target_run and c.patient_id = l.patient_id
                          and c.undo_outcome in ('kept','blocked'));
    get diagnostics v_rows = row_count;
    n_held := n_held + v_rows;
    select count(*) into n_links_left from public.sheet_patient_links l
     where l.run_id = p_target_run and l.method <> 'admin' and l.decision = 'link';

    -- A map-answer run: take back the alias it wrote, unless rewritten since
    -- (then the later run owns the row, and its own undo walks past this run
    -- — see below). What comes back is the newest replaced version whose run
    -- has NOT been undone: undos can happen in any order, and restoring a
    -- mapping an earlier undo already took back would make it permanent (its
    -- run can never be undone twice).
    for v_alias in select * from public.referral_source_aliases a where a.run_id = p_target_run for update loop
      v_restore := v_alias.replaced;
      while v_restore is not null and exists (
        select 1 from public.sheet_sync_runs r
         where r.id = (v_restore->>'run_id')::uuid and r.reverted_by_run_id is not null) loop
        v_restore := nullif(v_restore->'replaced', 'null'::jsonb);
      end loop;
      if v_restore is null then
        delete from public.referral_source_aliases a where a.raw_normalized = v_alias.raw_normalized;
        n_alias_removed := n_alias_removed + 1;
      else
        update public.referral_source_aliases a set
          referral_source_id = v_restore->>'referral_source_id',
          created_by = (select u.id from auth.users u where u.id = (v_restore->>'created_by')::uuid),
          created_at = coalesce((v_restore->>'created_at')::timestamptz, now()),
          run_id = (select r.id from public.sheet_sync_runs r where r.id = (v_restore->>'run_id')::uuid),
          replaced = nullif(v_restore->'replaced', 'null'::jsonb)
        where a.raw_normalized = v_alias.raw_normalized;
        n_alias_restored := n_alias_restored + 1;
      end if;
    end loop;

    update public.sheet_sync_runs set reverted_by_run_id = v_run where id = p_target_run;
  end if;
  return jsonb_build_object('done', v_done, 'restored', n_restored, 'blocked', n_blocked, 'deleted', n_deleted,
                            'kept', n_kept, 'gone', n_gone, 'held', n_held, 'links_left', n_links_left,
                            'alias_removed', n_alias_removed, 'alias_restored', n_alias_restored);
end $$;

create or replace function public.sheet_review_resolve(
  p_item_id uuid, p_actor uuid, p_action text, p_patient_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item public.sheet_sync_review_items%rowtype;
  v_live public.sheet_sync_runs%rowtype;
  v_keys jsonb;
  v_keep_undone boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('sheet_sync_lease')) then
    raise exception 'The sheet sync is busy right now — try again in a moment.' using errcode = 'P0062';
  end if;
  begin
    select * into v_live from public.sheet_sync_runs r where r.status = 'running' for update nowait;
  exception when lock_not_available then
    raise exception 'Another sheet sync is running.' using errcode = 'P0062';
  end;
  if v_live.id is not null and not v_live.dry_run and public._sheet_sync_lease_live(v_live.heartbeat_at) then
    raise exception 'Another sheet sync is running.' using errcode = 'P0062';
  end if;
  -- An OPEN item, or a KEPT-UNDONE identity item (dismissed by an admin's Keep
  -- undone, or raised that way after an undo) for Link / Create: keeping a row
  -- undone parks it, it does not close the question — the admin can still
  -- decide who it is. Anything else (resolved, released, a plain dismissal,
  -- or Dismiss on a kept-undone item) is no longer actionable: P0064.
  select * into v_item from public.sheet_sync_review_items i
   where i.id = p_item_id
     and (i.status = 'open'
          or (i.status = 'dismissed' and coalesce((i.resolution->>'keep_undone')::boolean, false)
              and i.kind in ('ambiguous_patient','identity_conflict','possible_existing_patient')
              and p_action in ('link','create')))
   for update;
  if not found then
    raise exception 'This review item was already handled.' using errcode = 'P0064';
  end if;
  v_keys := case when jsonb_typeof(v_item.payload->'link_keys') = 'array' then v_item.payload->'link_keys' else '[]'::jsonb end;
  if p_action = 'dismiss' then
    -- "Keep undone" (an undo hold) and "Keep deleted" (review fix E's
    -- deleted-patient-match hold) are the only two holds Dismiss is allowed
    -- to leave standing — every other evidence-based hold still needs a
    -- link or a new patient.
    if exists (select 1 from public.sheet_patient_links l
                where l.decision = 'review' and l.link_key in (select jsonb_array_elements_text(v_keys))
                  and l.hold_reason is distinct from 'undone by an admin'
                  and l.hold_reason is distinct from 'matches_deleted_patient') then
      raise exception 'This row is held for a decision: link it to a patient or create a new one.' using errcode = '22023';
    end if;
    v_keep_undone := exists (select 1 from public.sheet_patient_links l
                              where l.decision = 'review' and l.link_key in (select jsonb_array_elements_text(v_keys)));
    update public.sheet_sync_review_items
       set status = 'dismissed', resolved_by = p_actor, resolved_at = now(),
           resolution = jsonb_build_object('action', 'dismiss', 'keep_undone', v_keep_undone,
                                           'candidate_ids', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
                              from (select distinct c->>'patient_id' as x
                                      from jsonb_array_elements(case when jsonb_typeof(v_item.payload->'candidates') = 'array'
                                                                     then v_item.payload->'candidates' else '[]'::jsonb end) c
                                     where c->>'patient_id' is not null) s))
     where id = p_item_id;
    return;
  end if;
  if p_action is null or p_action not in ('link','create')
     or v_item.kind not in ('ambiguous_patient','identity_conflict','possible_existing_patient') then
    raise exception 'That action does not fit this item.' using errcode = '22023';
  end if;
  -- 0167 active-patient rule: an admin resolve is a deliberate, one-shot
  -- decision (unlike the automated link op above, which quietly re-plans a
  -- stale target) — refuse it outright rather than silently no-op.
  if p_action = 'link' and not exists (
       select 1 from public.patients p where p.id = p_patient_id and p.deleted_at is null and p.merged_into_id is null
     ) then
    raise exception 'Pick a current (not deleted or merged) patient.' using errcode = '22023';
  end if;
  -- Overwrites any saved decision for the key, holds included.
  insert into public.sheet_patient_links (link_key, patient_id, decision, method, decided_by, run_id)
  select k, case when p_action = 'link' then p_patient_id end, p_action, 'admin', p_actor, null
    from jsonb_array_elements_text(v_keys) k
  on conflict (link_key) do update
    set patient_id = excluded.patient_id, decision = excluded.decision, method = 'admin',
        decided_by = excluded.decided_by, decided_at = now(), run_id = null, hold_reason = null,
        held_patient_id = null;
  update public.sheet_sync_review_items
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', p_action, 'patient_id', p_patient_id)
   where id = p_item_id;
  -- The same key's other identity items (an earlier kept-undone dismissal, or
  -- an item re-opened since) are answered by this decision too.
  update public.sheet_sync_review_items i
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', p_action, 'patient_id', p_patient_id, 'via_item', p_item_id)
   where i.item_key = v_item.item_key and i.id <> p_item_id
     and i.kind in ('ambiguous_patient','identity_conflict','possible_existing_patient')
     and i.status in ('open','dismissed');
end $$;

revoke all on function public.sheet_sync_revert_run(uuid, uuid, integer) from public;
revoke execute on function public.sheet_sync_revert_run(uuid, uuid, integer) from anon, authenticated;
grant execute on function public.sheet_sync_revert_run(uuid, uuid, integer) to service_role;
revoke all on function public.sheet_review_resolve(uuid, uuid, text, uuid) from public;
revoke execute on function public.sheet_review_resolve(uuid, uuid, text, uuid) from anon, authenticated;
grant execute on function public.sheet_review_resolve(uuid, uuid, text, uuid) to service_role;

-- One-time tidy of rows that already carry a stale pointer: anything that is
-- not a live deleted-patient hold. Idempotent (a second run matches nothing).
do $$
declare n bigint;
begin
  update public.sheet_patient_links
     set held_patient_id = null
   where held_patient_id is not null
     and (decision <> 'review' or hold_reason is distinct from 'matches_deleted_patient');
  get diagnostics n = row_count;
  raise notice '0204: cleared held_patient_id on % stale link row(s)', n;
end $$;

-- Post-conditions.
do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array['public.sheet_sync_revert_run(uuid,uuid,integer)', 'public.sheet_review_resolve(uuid,uuid,text,uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or not has_function_privilege('service_role', f, 'execute') then
      raise exception '0204: % must be executable by service_role only', f;
    end if;
    if not (select p.prosecdef from pg_proc p where p.oid = f::regprocedure)
       or (select p.proconfig from pg_proc p where p.oid = f::regprocedure) is distinct from array['search_path=""'] then
      raise exception '0204: % lost security definer / search_path', f;
    end if;
  end loop;
  v_def := pg_get_functiondef('public.sheet_sync_revert_run(uuid,uuid,integer)'::regprocedure);
  if (length(v_def) - length(replace(v_def, 'held_patient_id = null', ''))) / length('held_patient_id = null') <> 3 then
    raise exception '0204: revert_run must clear held_patient_id at exactly its three re-hold sites';
  end if;
  v_def := pg_get_functiondef('public.sheet_review_resolve(uuid,uuid,text,uuid)'::regprocedure);
  if v_def not like '%hold_reason = null,%held_patient_id = null;%' then
    raise exception '0204: review_resolve no longer clears held_patient_id';
  end if;
  if exists (select 1 from public.sheet_patient_links
              where held_patient_id is not null
                and (decision <> 'review' or hold_reason is distinct from 'matches_deleted_patient')) then
    raise exception '0204: stale held_patient_id rows remain';
  end if;
end $$;
