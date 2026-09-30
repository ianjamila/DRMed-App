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
      insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id, hold_reason)
      values (v_op->>'link_key', null, 'review', 'auto_exact', v_run, left(nullif(v_op->>'reason', ''), 400))
      on conflict (link_key) do update
        set decision = 'review', patient_id = null, run_id = excluded.run_id, decided_at = now(),
            hold_reason = excluded.hold_reason
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
  if v_def not like '%c.row_version_after = v_facts_ver%' then
    raise exception '0193: facts guard (S2) missing from sheet_sync_apply_customer_ops';
  end if;
  if v_def like '%if not found then n_skipped := n_skipped + 1; continue; end if;%' then
    raise exception '0193: fill still counts a deleted/merged target as skipped (S3)';
  end if;
end;
$$;

-- ===== Part B: Patient Sources ===============================================
-- (appended by Task B)
