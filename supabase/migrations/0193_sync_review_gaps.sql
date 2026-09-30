-- 0193: sync review gaps (fix/sync-review-gaps).
--
-- Part A: Sheet Sync (#240's sheet_sync_apply_customer_ops, defined in 0170).
--   S2  facts ops are stale-guarded by the patient's read row_version like
--       link/fill, and forgive only the bump this run's own fill made.
--   S3  a fill onto a deleted / merged / missing patient counts `stale` and
--       reports the id in stale_patient_ids (it used to count `skipped`).
--   (S1 and S4 are app-side: customer-plan.ts / review-queue.)
--   The body below is 0170's, byte for byte, except those two hunks (marked
--   "0193"). No new P-codes. ACL restated: service_role only.
--
-- Part B: Patient Sources / ad spend (0189's functions).
-- (Part B goes here.)

-- ===== Part A: Sheet Sync ====================================================

-- S1 recheck: a matches_deleted_patient hold clears patient_id (the target check
-- requires it for decision 'review'), so the deleted patient's id is kept HERE.
-- The planner reads it back on later runs (name/DOB/phone matching cannot always
-- find the deleted record again) and honours it only while that patient is still
-- deleted. No FK on purpose: a hard-deleted patient must not cascade the hold away,
-- and no CHECK: sheet_review_resolve (0170) turns a hold into a link/create without
-- touching this column, so the planner reads it only for decision 'review' holds.
alter table public.sheet_patient_links add column if not exists held_patient_id uuid;

create or replace function public.sheet_sync_apply_customer_ops(p_lease_token uuid, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_actor uuid;
  v_import uuid;
  v_op jsonb;
  v_f jsonb;
  v_admin_keys jsonb;
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_pid uuid;
  v_key text;
  v_src text;
  v_hit boolean;
  v_rows int;
  v_created jsonb := '{}'::jsonb;
  v_link_ver bigint;
  v_facts_ver bigint;
  -- Review fixes B/D: create_keys skipped (live or deleted dupe) and patient
  -- ids rejected as stale, deduped once at return time (array(select distinct
  -- unnest(...))) rather than on every append.
  v_skipped_keys text[] := '{}';
  v_stale_pids uuid[] := '{}';
  v_op_phone_digits text;
  v_op_phone text;
  v_op_name_norm text;
  -- Accent fold for the concurrent-registration recheck below — matches
  -- names.ts's normalizeName (NFD + combining-mark strip), pinned char by
  -- char against it by accent-fold.test.ts. Deliberately NOT unaccent() (no
  -- extension): a mark outside this list is left as-is, which can only make
  -- two names that are really the same look different (under-match), never
  -- the reverse — the safe direction for a backstop check.
  v_accent_from constant text := 'áàâäãåéèêëíìîïóòôöõúùûüñçý';
  v_accent_to   constant text := 'aaaaaaeeeeiiiiooooouuuuncy';
  v_dupe_id uuid;
  n_created int := 0; n_linked int := 0; n_filled int := 0; n_facts int := 0; n_held int := 0; n_skipped int := 0;
  n_stale int := 0; n_skipped_existing int := 0;
begin
  if jsonb_typeof(p_ops) is distinct from 'array' then
    raise exception 'Bad ops batch.' using errcode = '22023';
  end if;
  select r.actor_id, r.legacy_import_run_id into v_actor, v_import from public.sheet_sync_runs r where r.id = v_run;

  for v_op in select e from jsonb_array_elements(p_ops) e loop
    if v_op->>'op' = 'create' then
      v_admin_keys := coalesce(v_op->'admin_link_keys', '[]'::jsonb);
      if jsonb_typeof(v_op->'link_keys') is distinct from 'array'
         or jsonb_typeof(v_admin_keys) is distinct from 'array'
         or exists (select 1 from jsonb_array_elements_text(v_admin_keys) k where not ((v_op->'link_keys') ? k)) then
        raise exception 'Bad create op: admin_link_keys must be a subset of link_keys.' using errcode = '22023';
      end if;
      if v_import is null then
        insert into public.legacy_import_runs (source, dry_run, run_by, notes)
        values ('sheet_sync:CUSTOMER LIST2', false, v_actor, 'sheet_sync_runs ' || v_run)
        returning id into v_import;
        update public.sheet_sync_runs set legacy_import_run_id = v_import where id = v_run;
      end if;
      v_f := v_op->'fields';
      -- Concurrent-registration guard (Codex P2): the planner read patients
      -- once; front desk may have registered this exact person since. Same
      -- normalization as the planner's (names.ts nameNormOf/normalizeName —
      -- lower, drop apostrophes, fold the common Latin-1 accents (translate,
      -- v_accent_from/v_accent_to below — no unaccent extension), other
      -- punctuation -> space, collapse whitespace; a mark outside that list
      -- is left as-is, which can only under-match (two spellings of the same
      -- name read as different), never the reverse — the safe direction for
      -- a backstop this narrow, and the planner's own full-name index stays
      -- the primary match anyway). A LIVE, non-merged patient with the same
      -- normalized name plus the same birthdate (both present) — or, when this op has no
      -- birthdate, the same normalized phone — means someone else already
      -- holds this identity: skip the create (counted `skipped_existing`,
      -- no link written), leaving the row for the next run to link or review.
      -- ADMIN creates are exempt (v_op->>'method' = 'admin', an admin's own
      -- "create new patient" decision) — same trust rule as everywhere else
      -- in this function (an admin link skips the conflict test too): an
      -- admin already looked at this row and decided it is not an existing
      -- patient, so this heuristic must not silently veto that decision (and
      -- must not turn it into a re-asked question every run — the saved
      -- 'create' link decision has no patient yet until this insert runs).
      --
      -- Owner decision 2026-09-25 (review fix E): a DELETED patient (deleted_at
      -- is not null) matching the same rule ALSO counts as "someone already
      -- holds this identity" and skips the create — reversing the original
      -- 0167 read of this comment (a deleted record used to be exempt, on the
      -- theory that it "does not block the create"). The sync must never
      -- silently re-create a person staff deleted; customer-plan.ts's own
      -- deleted-patient hold catches this earlier, before an op is even
      -- built, so this is only the backstop for whatever reaches here anyway
      -- (an admin's earlier decision replayed, a race). Merged patients stay
      -- exempt (merged_into_id is null below): a merge redirects to a
      -- survivor the live index already resolves, it is not "gone".
      --
      -- No standing function or index on `patients` for this (review
      -- decision: a permanent functional index on an every-write core table
      -- was too much blast radius for a narrow race). Instead, prefilter
      -- with an EQUALITY match on birthdate (no index; `patients` has none
      -- on `birthdate` alone — a plain seq scan over merged_into_id is null
      -- rows, proven fast enough at 10k patients by the Timing check below)
      -- or phone_normalized (indexed: idx_patients_phone_normalized), plus
      -- merged_into_id is null (deleted_at is deliberately NOT filtered here
      -- — see above), and only THEN compare the normalized name inline
      -- against that small candidate set — never scanning the whole table by
      -- name. The name-norm expression below is byte-identical to names.ts's
      -- nameNormOf (see its own comment).
      v_dupe_id := null;
      if v_op->>'method' <> 'admin' then
        v_op_phone_digits := regexp_replace(coalesce(v_f->>'phone', ''), '[^0-9]', '', 'g');
        v_op_phone := case when length(v_op_phone_digits) between 10 and 12 then right(v_op_phone_digits, 10) else null end;
        v_op_name_norm :=
          trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(v_f->>'last_name', ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))
          || '|' ||
          trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(v_f->>'first_name', '') || ' ' || coalesce(v_f->>'middle_name', ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'));
        if nullif(v_f->>'birthdate', '') is not null then
          select p.id into v_dupe_id from public.patients p
           where p.merged_into_id is null
             and p.birthdate = (v_f->>'birthdate')::date
             and trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(p.last_name, ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))
                 || '|' ||
                 trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(p.first_name, '') || ' ' || coalesce(p.middle_name, ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))
                 = v_op_name_norm
           limit 1;
        elsif v_op_phone is not null then
          select p.id into v_dupe_id from public.patients p
           where p.merged_into_id is null
             and p.phone_normalized = v_op_phone
             and trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(p.last_name, ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))
                 || '|' ||
                 trim(regexp_replace(regexp_replace(translate(lower(replace(coalesce(p.first_name, '') || ' ' || coalesce(p.middle_name, ''), '''', '')), v_accent_from, v_accent_to), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'))
                 = v_op_name_norm
           limit 1;
        end if;
      end if;
      if v_dupe_id is not null then
        n_skipped_existing := n_skipped_existing + 1;
        v_skipped_keys := v_skipped_keys || (v_op->>'create_key');
        continue;
      end if;
      v_src := (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''));
      perform set_config('app.referral_origin', 'sheet', true);
      insert into public.patients (first_name, last_name, middle_name, birthdate, sex, phone, email, address,
        referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number,
        legacy_intake, legacy_import_run_id, birthdate_confirmed)
      values (v_f->>'first_name', v_f->>'last_name', nullif(v_f->>'middle_name', ''),
        nullif(v_f->>'birthdate', '')::date, nullif(v_f->>'sex', ''), nullif(v_f->>'phone', ''),
        nullif(v_f->>'email', ''), nullif(v_f->>'address', ''), v_src, nullif(v_f->>'referred_by_doctor', ''),
        nullif(v_f->>'preferred_release_medium', ''),
        -- the Senior/PWD pair is written together or not at all
        case when nullif(v_f->>'senior_pwd_id_kind', '') is not null and nullif(v_f->>'senior_pwd_id_number', '') is not null
             then v_f->>'senior_pwd_id_kind' end,
        case when nullif(v_f->>'senior_pwd_id_kind', '') is not null and nullif(v_f->>'senior_pwd_id_number', '') is not null
             then v_f->>'senior_pwd_id_number' end,
        v_op->'legacy_intake', v_import, false)
      returning id into v_pid;
      perform set_config('app.referral_origin', '', true);
      insert into public.sheet_sync_changes (run_id, patient_id, change_kind, row_version_after)
      values (v_run, v_pid, 'create', 0);
      for v_key in select jsonb_array_elements_text(v_op->'link_keys') loop
        insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id)
        values (v_key, v_pid, 'link', case when v_admin_keys ? v_key then 'admin' else 'auto_exact' end, v_run)
        on conflict (link_key) do update
          set patient_id = excluded.patient_id, decision = 'link', method = excluded.method,
              run_id = excluded.run_id, decided_at = now(), hold_reason = null
          where (public.sheet_patient_links.method <> 'admin' or public.sheet_patient_links.decision = 'create')
            and public.sheet_patient_links.decision <> 'review';
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          -- No key names in the message: they carry a patient's name and DOB.
          raise exception 'Bad create op: one of its keys is held for review or decided by an admin.' using errcode = '22023';
        end if;
      end loop;
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values (v_pid, nullif(v_op->'facts'->>'registered_on', '')::date,
              nullif(v_op->'facts'->>'new_repeat', ''), v_op->'facts'->>'source_ref');
      v_created := v_created || jsonb_build_object(v_op->>'create_key', v_pid);
      n_created := n_created + 1;

    elsif v_op->>'op' = 'link' then
      -- Only an admin resolve writes an admin decision.
      if coalesce(v_op->>'method', '') not in ('auto_exact','auto_loose') then
        raise exception 'Bad link op: method must be auto_exact or auto_loose.' using errcode = '22023';
      end if;
      -- 0167 active-patient rule: never auto-link to a deleted or merged
      -- patient. Treated as the same race the row_version check below
      -- handles — the planner's candidate is no longer what it read — so a
      -- deleted/merged target counts as `stale`, not a raised error: the
      -- next run re-plans the sheet row from a fresh read (and may hold it
      -- for review instead, once the planner sees the target is gone).
      if not exists (select 1 from public.patients p where p.id = (v_op->>'patient_id')::uuid
                       and p.deleted_at is null and p.merged_into_id is null) then
        n_stale := n_stale + 1;
        v_stale_pids := v_stale_pids || (v_op->>'patient_id')::uuid;
        continue;
      end if;
      -- Stale-read guard: the planner's candidate may have changed (or gone)
      -- since it read patients. A vanished patient counts as stale too.
      if v_op ? 'expected_row_version' then
        select p.row_version into v_link_ver from public.patients p where p.id = (v_op->>'patient_id')::uuid;
        if v_link_ver is distinct from (v_op->>'expected_row_version')::bigint then
          n_stale := n_stale + 1;
          v_stale_pids := v_stale_pids || (v_op->>'patient_id')::uuid;
          continue;
        end if;
      end if;
      insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id)
      values (v_op->>'link_key', (v_op->>'patient_id')::uuid, 'link', v_op->>'method', v_run)
      on conflict (link_key) do update
        set patient_id = excluded.patient_id, method = excluded.method, decision = 'link',
            run_id = excluded.run_id, decided_at = now(), hold_reason = null
        where public.sheet_patient_links.method <> 'admin'
          and public.sheet_patient_links.decision <> 'review';
      get diagnostics v_rows = row_count;
      if v_rows > 0 then n_linked := n_linked + 1; else n_skipped := n_skipped + 1; end if;

    elsif v_op->>'op' = 'hold' then
      if coalesce(v_op->>'link_key', '') = '' then
        raise exception 'Bad hold op.' using errcode = '22023';
      end if;
      -- 0193: a deleted-patient hold also records which patient (held_patient_id);
      -- any other hold clears it.
      insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id, hold_reason, held_patient_id)
      values (v_op->>'link_key', null, 'review', 'auto_exact', v_run, left(nullif(v_op->>'reason', ''), 400),
              case when v_op->>'reason' = 'matches_deleted_patient' then nullif(v_op->>'deleted_patient_id', '')::uuid end)
      on conflict (link_key) do update
        set decision = 'review', patient_id = null, run_id = excluded.run_id, decided_at = now(),
            hold_reason = excluded.hold_reason, held_patient_id = excluded.held_patient_id
        where public.sheet_patient_links.method <> 'admin';
      get diagnostics v_rows = row_count;
      if v_rows > 0 then n_held := n_held + 1; else n_skipped := n_skipped + 1; end if;

    elsif v_op->>'op' = 'fill' then
      v_f := v_op->'fields';
      -- 0167 active-patient rule: never write to a deleted or merged patient
      -- (the lifecycle guard would raise P0058 on the UPDATE below anyway —
      -- excluding them here means a fill on an inactive target reads as an
      -- ordinary "not found" skip, not a hard failure of the whole chunk).
      select * into v_old from public.patients p
       where p.id = (v_op->>'patient_id')::uuid and p.deleted_at is null and p.merged_into_id is null
       for update;
      -- 0193 (S3): a deleted / merged / vanished target is STALE, exactly as
      -- link and facts count it — not `skipped`. A skip left the id out of
      -- stale_patient_ids, so the runner published a mirror row pointing at a
      -- patient the database had just refused to write to.
      if not found then
        n_stale := n_stale + 1;
        v_stale_pids := v_stale_pids || (v_op->>'patient_id')::uuid;
        continue;
      end if;
      -- Stale-read guard: staff may have changed the patient since the
      -- planner read it (a conflicting DOB, say) — re-plan next run instead.
      if v_op ? 'expected_row_version' and v_old.row_version <> (v_op->>'expected_row_version')::bigint then
        n_stale := n_stale + 1;
        v_stale_pids := v_stale_pids || v_old.id;
        continue;
      end if;
      v_src := case
        when not (v_f ? 'referral_source') then v_old.referral_source
        when v_old.referral_source is null or v_old.referral_source_origin = 'sheet'
          then (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''))
        else v_old.referral_source end;
      perform set_config('app.referral_origin', 'sheet', true);
      update public.patients p set
        phone = coalesce(p.phone, nullif(v_f->>'phone', '')),
        email = coalesce(p.email, nullif(v_f->>'email', '')),
        birthdate = coalesce(p.birthdate, nullif(v_f->>'birthdate', '')::date),
        sex = coalesce(p.sex, nullif(v_f->>'sex', '')),
        address = coalesce(p.address, nullif(v_f->>'address', '')),
        referred_by_doctor = coalesce(p.referred_by_doctor, nullif(v_f->>'referred_by_doctor', '')),
        preferred_release_medium = coalesce(p.preferred_release_medium, nullif(v_f->>'preferred_release_medium', '')),
        -- the Senior/PWD pair: filled together, only when both are empty on
        -- the patient and both are present in the op
        senior_pwd_id_kind = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                       and nullif(v_f->>'senior_pwd_id_kind', '') is not null
                                       and nullif(v_f->>'senior_pwd_id_number', '') is not null
                                  then v_f->>'senior_pwd_id_kind' else p.senior_pwd_id_kind end,
        senior_pwd_id_number = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                         and nullif(v_f->>'senior_pwd_id_kind', '') is not null
                                         and nullif(v_f->>'senior_pwd_id_number', '') is not null
                                    then v_f->>'senior_pwd_id_number' else p.senior_pwd_id_number end,
        referral_source = v_src
      where p.id = v_old.id
        and ( (p.phone is null and nullif(v_f->>'phone', '') is not null)
           or (p.email is null and nullif(v_f->>'email', '') is not null)
           or (p.birthdate is null and nullif(v_f->>'birthdate', '') is not null)
           or (p.sex is null and nullif(v_f->>'sex', '') is not null)
           or (p.address is null and nullif(v_f->>'address', '') is not null)
           or (p.referred_by_doctor is null and nullif(v_f->>'referred_by_doctor', '') is not null)
           or (p.preferred_release_medium is null and nullif(v_f->>'preferred_release_medium', '') is not null)
           or (p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
               and nullif(v_f->>'senior_pwd_id_kind', '') is not null
               and nullif(v_f->>'senior_pwd_id_number', '') is not null)
           or (p.referral_source is distinct from v_src) )
      returning * into v_new;
      -- Capture FOUND before the PERFORM below: PERFORM resets it (to true,
      -- since set_config returns a row), which made a no-op fill look like
      -- a hit and record a before-image with a NULL patient id.
      v_hit := found;
      perform set_config('app.referral_origin', '', true);
      if v_hit then
        perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
        n_filled := n_filled + 1;
      else
        n_skipped := n_skipped + 1;
      end if;

    elsif v_op->>'op' = 'facts' then
      -- 0167 active-patient rule, same race as link above: the planner read
      -- this patient before it could be deleted or merged, so a gone target
      -- counts as `stale` and gets no facts row (the next run re-plans).
      select p.row_version into v_facts_ver from public.patients p
       where p.id = (v_op->>'patient_id')::uuid and p.deleted_at is null and p.merged_into_id is null;
      if not found then
        n_stale := n_stale + 1;
        v_stale_pids := v_stale_pids || (v_op->>'patient_id')::uuid;
        continue;
      end if;
      -- Stale-read guard (review fix D): the planner plans a patient's
      -- link/fill/facts ops from ONE read, so a facts write must not go
      -- through for an identity the sibling link/fill ops just rejected as
      -- stale — same check, same bucket, as link/fill above.
      --
      -- 0193 (S2): the planner now ALWAYS sends expected_row_version (the
      -- version it read). This run's own fill for the same patient bumps
      -- row_version by exactly one (trg_patients_referral_origin), and the fill
      -- may sit in this call or an earlier chunk, so a plain equality would
      -- reject every facts op that follows a fill. The bump is forgiven only
      -- when it is PROVABLY ours: the patient's current version is the
      -- row_version_after this run recorded in sheet_sync_changes for its own
      -- fill AND the version the planner read is exactly one below it. Any
      -- other movement (staff edit, before or after our fill) stays stale.
      -- Replay note: after a lost-response replay of the FILL chunk a patient can be
      -- in stale_patient_ids while its facts row was written (the fill applied the first
      -- time). Harmless: the mirror row stays unlinked one night and the next run re-plans.
      if v_op ? 'expected_row_version' and v_facts_ver is distinct from (v_op->>'expected_row_version')::bigint then
        if not ((v_op->>'expected_row_version')::bigint = v_facts_ver - 1
                and exists (select 1 from public.sheet_sync_changes c
                             where c.run_id = v_run and c.patient_id = (v_op->>'patient_id')::uuid
                               and c.change_kind = 'update' and c.row_version_after = v_facts_ver)) then
          n_stale := n_stale + 1;
          v_stale_pids := v_stale_pids || (v_op->>'patient_id')::uuid;
          continue;
        end if;
      end if;
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values ((v_op->>'patient_id')::uuid, nullif(v_op->>'registered_on', '')::date,
              nullif(v_op->>'new_repeat', ''), v_op->>'source_ref')
      on conflict (patient_id) do update
        set registered_on = excluded.registered_on, sheet_new_repeat = excluded.sheet_new_repeat,
            source_ref = excluded.source_ref, updated_at = now();
      n_facts := n_facts + 1;

    else
      raise exception 'Unknown customer op.' using errcode = '22023';
    end if;
  end loop;

  return jsonb_build_object('created', v_created,
    'skipped_create_keys', to_jsonb(v_skipped_keys),
    'stale_patient_ids', to_jsonb(array(select distinct unnest(v_stale_pids))),
    'counts', jsonb_build_object(
    'created', n_created, 'linked', n_linked, 'filled', n_filled, 'facts', n_facts,
    'held', n_held, 'skipped', n_skipped, 'stale', n_stale, 'skipped_existing', n_skipped_existing));
end $$;

revoke all on function public.sheet_sync_apply_customer_ops(uuid, jsonb) from public;
revoke execute on function public.sheet_sync_apply_customer_ops(uuid, jsonb) from anon, authenticated;
grant execute on function public.sheet_sync_apply_customer_ops(uuid, jsonb) to service_role;

do $$
declare
  v_def text := pg_get_functiondef('public.sheet_sync_apply_customer_ops(uuid, jsonb)'::regprocedure);
begin
  if has_function_privilege('anon', 'public.sheet_sync_apply_customer_ops(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.sheet_sync_apply_customer_ops(uuid, jsonb)', 'execute') then
    raise exception '0193: sheet_sync_apply_customer_ops is executable by a JWT role';
  end if;
  if not has_function_privilege('service_role', 'public.sheet_sync_apply_customer_ops(uuid, jsonb)', 'execute') then
    raise exception '0193: sheet_sync_apply_customer_ops is not executable by service_role';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sheet_sync_apply_customer_ops(uuid, jsonb)'::regprocedure)
     or v_def !~ 'SET search_path TO ''''' then
    raise exception '0193: sheet_sync_apply_customer_ops lost security definer or its empty search_path';
  end if;
  if v_def not like '%held_patient_id = excluded.held_patient_id%' then
    raise exception '0193: hold op no longer records held_patient_id';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'sheet_patient_links' and column_name = 'held_patient_id') then
    raise exception '0193: sheet_patient_links.held_patient_id is missing';
  end if;
  if v_def not like '%c.row_version_after = v_facts_ver%' then
    raise exception '0193: facts guard (S2) missing from sheet_sync_apply_customer_ops';
  end if;
  if v_def like '%if not found then n_skipped := n_skipped + 1; continue; end if;%' then
    raise exception '0193: fill still counts a deleted/merged target as skipped (S3)';
  end if;
end;
$$;

-- ===== Part B: Patient Sources / ad spend ====================================
-- Bodies below are the 0189 bodies (nothing later redefines them) with only
-- the marked hunks changed.

-- (B1, M1) The mirror-window start, single-sourced. Replaces the
-- "select mirror_window_start ... coalesce(v_window, '2026-05-26')" pair that
-- was repeated in _patient_sources_encounters and _ps_revenue_lines. The
-- column is NOT NULL default '2026-05-26' (0170), so no second copy of the
-- date is needed; a missing singleton row raises no_data_found (P0002) from
-- select ... into strict instead of silently falling back.
create or replace function public._ps_mirror_window_start()
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_window date;
begin
  perform public._ps_assert_mirror_mode();
  select s.mirror_window_start into strict v_window from public.sheet_sync_settings s where s.id;
  return v_window;
end;
$$;
revoke all on function public._ps_mirror_window_start() from public, anon, authenticated, service_role;

-- (B2, P2) Period lower bound.
create or replace function public._ps_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Pick a period whose start is on or before its end, at most 400 days long'
      using errcode = '22023';
  end if;
  -- (P2) Visit history only exists from 2023-12-01: an earlier period would
  -- count registration-only people as New while their pre-window visits are
  -- ignored, so refuse it rather than show a wrong number.
  if p_from < date '2023-12-01' then
    raise exception 'Patient Sources starts on 1 December 2023 - pick a start on or after that date'
      using errcode = '22023';
  end if;
end;
$$;

-- (B3, M1) Encounters: window from the single helper.
create or replace function public._patient_sources_encounters()
returns table (identity text, survivor_id uuid, loose_key text, service_date date, source text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  v_window := public._ps_mirror_window_start();

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  )
  select 'patient:' || s.survivor_id::text, s.survivor_id, null::text, v.visit_date, 'app'::text
  from public.visits v
  join surv s on s.patient_id = v.patient_id
  where v.deleted_at is null
    and v.visit_date >= date '2023-12-01'
    and (v.visit_date < v_window or v.legacy_import_run_id is null)
  union all
  select case when l.patient_id is null then 'name:' || l.loose_key
              else 'patient:' || s.survivor_id::text end,
         s.survivor_id,
         case when l.patient_id is null then l.loose_key end,
         l.service_date,
         'sheet'::text
  from public.sheet_encounter_lines l
  left join surv s on s.patient_id = l.patient_id
  where l.service_date >= date '2023-12-01'
    and (l.patient_id is null or s.survivor_id is not null);
end;
$$;

-- (B4, P1 + M1) Revenue lines: clinic share for doctor lines; window helper.
create or replace function public._ps_revenue_lines(p_from date, p_to date)
returns table (identity text, survivor_id uuid, service_date date, source text, php numeric, overlap boolean)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  v_window := public._ps_mirror_window_start();

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  app_visits as (
    select v.id as visit_id, s.survivor_id, v.visit_date
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null
      and v.visit_date between greatest(p_from, date '2023-12-01') and p_to
      and (v.visit_date < v_window or v.legacy_import_run_id is null)
  ),
  app_days as (
    select distinct a.survivor_id, a.visit_date from app_visits a
  ),
  app as (
    select 'patient:' || a.survivor_id::text as identity, a.survivor_id, a.visit_date as service_date,
           'app'::text as source,
           -- (P1) The CLINIC's share: a doctor consult/procedure line stores the
           -- whole doctor fee in final_price_php and the clinic's cut in
           -- clinic_fee_php (0011; set only on those kinds). Every other line
           -- has clinic_fee_php null, so it falls back to final_price_php.
           coalesce(sum(coalesce(tr.clinic_fee_php, tr.final_price_php)), 0)::numeric(14,2) as php,
           false as overlap
    from app_visits a
    join public.test_requests tr on tr.visit_id = a.visit_id and tr.deleted_at is null
    group by a.survivor_id, a.visit_date
  ),
  sheet as (
    select case when l.patient_id is null then 'name:' || l.loose_key
                else 'patient:' || s.survivor_id::text end,
           s.survivor_id,
           l.service_date,
           'sheet'::text,
           coalesce(l.revenue_php, 0)::numeric(14,2),
           (s.survivor_id is not null and exists (
              select 1 from app_days d where d.survivor_id = s.survivor_id and d.visit_date = l.service_date))
    from public.sheet_encounter_lines l
    left join surv s on s.patient_id = l.patient_id
    where l.service_date between greatest(p_from, date '2023-12-01') and p_to
      and (l.patient_id is null or s.survivor_id is not null)
  )
  select * from app
  union all
  select * from sheet;
end;
$$;

-- (B5, P3 + M2) Identities. A new OUT column changes the return type, so the
-- function is dropped and re-created (ACL restated below). Nothing depends on
-- it at the catalog level (its callers are plpgsql).
drop function if exists public._patient_sources_identities();
create or replace function public._patient_sources_identities()
returns table (
  identity     text,
  confirmed    boolean,
  survivor_id  uuid,
  loose_key    text,
  first_date   date,
  basis        text,
  is_returning boolean,
  channel      text,
  referrer_raw text
)
language sql
stable
set search_path = ''
as $$
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  -- (M2) The latest (highest sheet_row) non-blank sheet referrer per survivor,
  -- computed once; patient_sources_referrers reads it from referrer_raw.
  sheet_ref as (
    select distinct on (s.survivor_id) s.survivor_id, c.referred_by_raw
    from public.sheet_customer_rows c
    join surv s on s.patient_id = c.patient_id
    where nullif(btrim(c.referred_by_raw), '') is not null
    order by s.survivor_id, c.sheet_row desc
  ),
  enc as (
    select distinct e.identity, e.service_date from public._patient_sources_encounters() e
  ),
  first_enc as (
    select e.identity, min(e.service_date) as d from enc e group by e.identity
  ),
  member as (
    select s.survivor_id,
           f.registered_on as fact_on,
           f.sheet_new_repeat,
           -- An imported patient's created_at is the import night, never a registration day.
           case when p.legacy_import_run_id is null
                then (p.created_at at time zone 'Asia/Manila')::date end as app_on
    from surv s
    join public.patients p on p.id = s.patient_id
    left join public.patient_acquisition_facts f on f.patient_id = s.patient_id
  ),
  member_ranked as (
    select m.*, min(m.fact_on) over (partition by m.survivor_id) as min_fact_on from member m
  ),
  confirmed_reg as (
    select m.survivor_id,
           -- P18, decided per GROUP: a sheet date wins; else the earliest app-native
           -- sign-up; imported-only groups with no sheet date stay undated.
           coalesce(min(m.fact_on), min(m.app_on)) as reg_on,
           case when bool_or(m.fact_on is not null)
                then coalesce(bool_or(m.sheet_new_repeat = 'repeat') filter (where m.fact_on = m.min_fact_on), false)
                else coalesce(bool_or(m.sheet_new_repeat = 'repeat'), false)
           end as is_returning
    from member_ranked m
    group by m.survivor_id
  ),
  old_visitors as (
    select distinct s.survivor_id
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null and v.visit_date < date '2023-12-01'
  ),
  name_enc as (
    select e.identity from first_enc e where e.identity like 'name:%'
  ),
  confirmed_keys as (
    select r.survivor_id, public._ps_loose_key(sp.last_name, sp.first_name) as k
    from confirmed_reg r join public.patients sp on sp.id = r.survivor_id
    union
    select s.survivor_id, c.loose_key
    from public.sheet_customer_rows c join surv s on s.patient_id = c.patient_id
    union
    -- (P3) A merged-away duplicate's OWN spelling: unlinked sheet lines under
    -- the duplicate's name belong to the survivor, not a second New person.
    select s.survivor_id, public._ps_loose_key(m.last_name, m.first_name)
    from surv s join public.patients m on m.id = s.patient_id
    where s.patient_id <> s.survivor_id   -- only merged-away members (the survivor own key is above)
  ),
  suppressed as (
    select distinct k.survivor_id
    from confirmed_keys k join name_enc n on n.identity = 'name:' || k.k
  ),
  confirmed as (
    -- Owner decision 2026-09-28: a live visit before 2023-12-01 outranks a
    -- registration date — such a customer is an OLD customer (before_window,
    -- first_date null, counted nowhere), never New, even when they also have
    -- a later sheet registered_on or app created_at. An encounter since
    -- December 2023 still wins over everything (unchanged).
    select 'patient:' || r.survivor_id::text as identity,
           true as confirmed,
           r.survivor_id,
           null::text as loose_key,
           case when fe.d is not null then fe.d
                when sup.survivor_id is not null then null
                when ov.survivor_id is not null then null
                else r.reg_on end as first_date,
           case when fe.d is not null then 'encounter'
                when sup.survivor_id is not null then 'suppressed'
                when ov.survivor_id is not null then 'before_window'
                when r.reg_on is not null then 'registration'
                else 'undated' end as basis,
           r.is_returning,
           coalesce(sp.referral_source, 'not_recorded') as channel,
           coalesce(nullif(btrim(sp.referred_by_doctor), ''), sr.referred_by_raw) as referrer_raw
    from confirmed_reg r
    join public.patients sp on sp.id = r.survivor_id
    left join sheet_ref sr on sr.survivor_id = r.survivor_id
    left join first_enc fe on fe.identity = 'patient:' || r.survivor_id::text
    left join suppressed sup on sup.survivor_id = r.survivor_id
    left join old_visitors ov on ov.survivor_id = r.survivor_id
  ),
  cust_by_key as (
    select c.loose_key,
           count(*) as n_rows,
           min(c.referral_source_id) as only_source,
           min(c.registered_on) filter (where c.patient_id is null) as unlinked_reg_on,
           bool_or(c.patient_id is null) as has_unlinked,
           -- (M2) the answer only when this name has exactly ONE Customers row
           -- (linked or not) - the same rule as the channel below.
           case when count(*) = 1 then min(c.referred_by_raw) end as only_referrer_raw
    from public.sheet_customer_rows c
    group by c.loose_key
  ),
  name_ids as (
    select n.identity, substr(n.identity, 6) as k from name_enc n
    union
    select 'name:' || c.loose_key, c.loose_key from cust_by_key c where c.has_unlinked
  ),
  unconfirmed as (
    select ni.identity,
           false,
           null::uuid,
           ni.k,
           coalesce(fe.d, cb.unlinked_reg_on),
           case when fe.d is not null then 'encounter'
                when cb.unlinked_reg_on is not null then 'registration'
                else 'undated' end,
           false,
           case when cb.n_rows = 1 then coalesce(cb.only_source, 'not_recorded') else 'not_recorded' end,
           cb.only_referrer_raw
    from name_ids ni
    left join first_enc fe on fe.identity = ni.identity
    left join cust_by_key cb on cb.loose_key = ni.k
  )
  select * from confirmed
  union all
  select * from unconfirmed
$$;

-- (B6, M2) Referrers read referrer_raw from the identity core.
create or replace function public.patient_sources_referrers(p_from date, p_to date, p_limit int default 20)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  with ids as (
    select * from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
  -- (M2) The referrer answer now comes from the identity core (referrer_raw):
  -- one definition, no second copy of the linked/unlinked rules here.
  raw as (
    select i.confirmed, i.referrer_raw as raw_label from ids i
  ),
  normed as (
    select r.confirmed, btrim(r.raw_label) as spelling, public._ps_doctor_norm(r.raw_label) as k
    from raw r where r.raw_label is not null
  ),
  spellings as (
    select n.k, n.spelling, count(*) as c from normed n where n.k is not null group by n.k, n.spelling
  ),
  labels as (
    select distinct on (s.k) s.k, s.spelling from spellings s order by s.k, s.c desc, s.spelling
  )
  select l.spelling,
         (count(*) filter (where n.confirmed))::int,
         (count(*) filter (where not n.confirmed))::int
  from normed n
  join labels l on l.k = n.k
  group by l.k, l.spelling
  order by count(*) desc, l.spelling
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

-- (B7, P5) ad_spend_import refuses a mixed-kind group. The 3-arg signature is unchanged.
create or replace function public.ad_spend_import(p_upload_id uuid, p_rows jsonb, p_rejected_count int default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int := 0;
  v_replaced int := 0;
  v_deleted int := 0;
  v_days int := 0;
  v_n int;
  v_kind_changed boolean;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can save ad spend' using errcode = '42501';
  end if;
  -- Codex recheck #3: serialize every import/removal so two concurrent
  -- uploads can never both observe an empty/stale group and both insert.
  perform pg_advisory_xact_lock(hashtext('ad_spend_import'));

  if p_upload_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ad spend import needs an upload id and a list of rows' using errcode = '22023';
  end if;
  if p_rejected_count is null or p_rejected_count < 0 then
    raise exception 'Ad spend import needs a non-negative rejected row count' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 or v_n > 20000 then
    raise exception 'Ad spend import takes 1 to 20,000 rows, got %', v_n using errcode = '22023';
  end if;

  -- (P5) One group (spend_date, platform, campaign_key) must carry ONE kind of
  -- row. The client parser guarantees it, but a direct RPC call mixing a
  -- campaign total with per-ad rows would otherwise keep both (min(kind) below
  -- picks one, and the delete leaves the rest): double counted spend. Refuse
  -- before anything is deleted or written.
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int)
    group by r.spend_date, r.platform, r.campaign_key
    having count(distinct case when r.ad_key = '(campaign)' then 'total'
                               when r.ad_key like 'id:%' then 'id'
                               else 'name' end) > 1
  ) then
    raise exception 'A campaign and day in this file carries more than one ad-spend breakdown (campaign total, per ad name, per ad ID). Nothing was saved. [mixed breakdown]'
      using errcode = '22023';
  end if;

  -- A row's KIND: "(campaign)" is a campaign total; "id:…" is a per-ad row
  -- keyed by ad ID; anything else is a per-ad row keyed by ad name (the
  -- parser refuses a file mixing more than one kind for the same group, so a
  -- touched group's uploaded rows are homogeneous in practice). If any
  -- touched group's kind differs from what is already saved for it — a
  -- representation change — and the file had rejected rows, refuse the
  -- whole upload: nothing is saved.
  select exists (
    select 1
    from (
      select r.spend_date, r.platform, r.campaign_key,
             min(case when r.ad_key = '(campaign)' then 'total'
                      when r.ad_key like 'id:%' then 'id'
                      else 'name' end) as kind
      from jsonb_to_recordset(p_rows) as r(
        spend_date date, platform text, campaign_key text, ad_key text,
        campaign_label text, spend_php numeric, impressions int, clicks int)
      group by r.spend_date, r.platform, r.campaign_key
    ) g
    where exists (
      select 1 from public.ad_spend_daily a
      where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key
        and (case when a.ad_key = '(campaign)' then 'total'
                  when a.ad_key like 'id:%' then 'id'
                  else 'name' end) <> g.kind
    )
  ) into v_kind_changed;

  if v_kind_changed and p_rejected_count > 0 then
    -- [breakdown change] tags this specific message for the action to map to
    -- clean user text (never raw PG text) — never confuse it with any other
    -- 22023 raised above.
    raise exception 'This file changes how saved spend is broken down (campaign total vs per ad) but % rows were rejected — fix them and upload again. Nothing was saved. [breakdown change]', p_rejected_count
      using errcode = '22023';
  end if;

  -- Delete only rows of a DIFFERENT kind within each touched group. A
  -- same-kind row is left alone here — ON CONFLICT below updates it in
  -- place — so a sibling ad_key the upload doesn't mention survives. Two
  -- separate statements (not one WITH with two data-modifying CTEs on the
  -- same table, whose relative order is unspecified) so this delete is
  -- guaranteed visible to the insert that follows it.
  delete from public.ad_spend_daily a
  using (
    select r.spend_date, r.platform, r.campaign_key,
           min(case when r.ad_key = '(campaign)' then 'total'
                    when r.ad_key like 'id:%' then 'id'
                    else 'name' end) as kind
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int)
    group by r.spend_date, r.platform, r.campaign_key
  ) g
  where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key
    and (case when a.ad_key = '(campaign)' then 'total'
              when a.ad_key like 'id:%' then 'id'
              else 'name' end) <> g.kind;
  get diagnostics v_deleted = row_count;

  with src as (
    select r.spend_date, r.platform, r.campaign_key, r.ad_key,
           max(r.campaign_label) as campaign_label,
           sum(r.spend_php) as spend_php,
           sum(r.impressions)::int as impressions,
           sum(r.clicks)::int as clicks
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int)
    group by r.spend_date, r.platform, r.campaign_key, r.ad_key
  ),
  up as (
    insert into public.ad_spend_daily as a
      (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php,
       impressions, clicks, uploaded_by, uploaded_at, upload_id)
    select s.spend_date, s.platform, s.campaign_key, s.ad_key, s.campaign_label, s.spend_php,
           s.impressions, s.clicks, auth.uid(), now(), p_upload_id
    from src s
    on conflict (spend_date, platform, campaign_key, ad_key) do update
      set campaign_label = excluded.campaign_label,
          spend_php      = excluded.spend_php,
          impressions    = excluded.impressions,
          clicks         = excluded.clicks,
          uploaded_by    = excluded.uploaded_by,
          uploaded_at    = excluded.uploaded_at,
          upload_id      = excluded.upload_id
    returning (xmax = 0) as inserted, a.spend_date
  )
  select count(*) filter (where u.inserted), count(*) filter (where not u.inserted), count(distinct u.spend_date)
    into v_inserted, v_replaced, v_days
  from up u;
  v_replaced := v_replaced + v_deleted;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.imported', 'ad_spend_upload', p_upload_id,
          jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days));

  return jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days);
end;
$$;

-- (B8) ACLs restated (drop/create of the identities function lost its grants;
-- the rest are CREATE OR REPLACE and keep theirs, restated for clarity).
revoke all on function public._ps_check_period(date, date) from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_encounters() from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_identities() from public, anon, authenticated, service_role;
revoke all on function public._ps_revenue_lines(date, date) from public, anon, authenticated, service_role;
revoke all on function public.patient_sources_referrers(date, date, int) from public, anon;
grant execute on function public.patient_sources_referrers(date, date, int) to authenticated;
revoke all on function public.ad_spend_import(uuid, jsonb, int) from public, anon;
grant execute on function public.ad_spend_import(uuid, jsonb, int) to authenticated;

-- (B9) Post-conditions.
do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array[
    'public._ps_mirror_window_start()', 'public._ps_check_period(date,date)',
    'public._patient_sources_encounters()', 'public._patient_sources_identities()',
    'public._ps_revenue_lines(date,date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('service_role', f, 'execute') then
      raise exception '0193: helper % is executable by a JWT role', f;
    end if;
  end loop;
  foreach f in array array['public.patient_sources_referrers(date,date,integer)', 'public.ad_spend_import(uuid,jsonb,integer)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0193: % has the wrong ACL', f;
    end if;
  end loop;
  -- The bodies carry each hunk.
  v_def := pg_get_functiondef('public._ps_check_period(date,date)'::regprocedure);
  if v_def not like '%2023-12-01%' then raise exception '0193: period lower bound (P2) missing'; end if;
  v_def := pg_get_functiondef('public._ps_revenue_lines(date,date)'::regprocedure);
  if v_def not like '%coalesce(tr.clinic_fee_php, tr.final_price_php)%' then raise exception '0193: clinic share (P1) missing'; end if;
  if v_def like '%2026-05-26%' or v_def like '%sheet_sync_settings%' then raise exception '0193: revenue lines still carry their own mirror window (M1)'; end if;
  v_def := pg_get_functiondef('public._patient_sources_encounters()'::regprocedure);
  if v_def like '%2026-05-26%' or v_def like '%sheet_sync_settings%' then raise exception '0193: encounters still carry their own mirror window (M1)'; end if;
  v_def := pg_get_functiondef('public._patient_sources_identities()'::regprocedure);
  if v_def not like '%_ps_loose_key(m.last_name, m.first_name)%' then raise exception '0193: merged-member keys (P3) missing'; end if;
  if v_def not like '%referrer_raw%' then raise exception '0193: referrer_raw (M2) missing'; end if;
  v_def := pg_get_functiondef('public.patient_sources_referrers(date,date,integer)'::regprocedure);
  if v_def like '%sheet_customer_rows%' then raise exception '0193: referrers still reads the sheet directly (M2)'; end if;
  v_def := pg_get_functiondef('public.ad_spend_import(uuid,jsonb,integer)'::regprocedure);
  if v_def not like '%[mixed breakdown]%' then raise exception '0193: mixed-breakdown guard (P5) missing'; end if;
end;
$$;
