-- =============================================================================
-- 0121 — template param guardrails
-- =============================================================================
-- The CHEMISTRY group template lost 13 of 14 params to a manual bulk delete
-- and sat broken ~2 months (repaired by 0115). Two defences:
--
--   1. AUDIT: statement-level AFTER DELETE writes an audit_log row per
--      affected template — every future loss is traceable.
--   2. GUARD: BEFORE DELETE raises unless the transaction opted in via the
--      app.allow_template_param_delete GUC.
--
-- PostgREST runs every supabase-js call in its own transaction, so app code
-- can never set the GUC for a later call. Legitimate deletes therefore go
-- through SECURITY DEFINER RPCs that set the flag transaction-locally and
-- delete in the same transaction. Migrations use:
--     SET LOCAL app.allow_template_param_delete = 'on';
-- Hand-run deletes from a SQL-editor session are blocked outright.
-- =============================================================================

-- ----- 1. Guard trigger ------------------------------------------------------
create or replace function public.guard_template_param_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.allow_template_param_delete', true), '') <> 'on' then
    raise exception
      'Deleting result_template_params requires explicit opt-in. Use the admin UI / admin_delete_* RPCs, or SET LOCAL app.allow_template_param_delete = ''on'' inside a migration.'
      using errcode = 'P0041';
  end if;
  return old;
end;
$$;

create trigger trg_guard_template_param_delete
  before delete on public.result_template_params
  for each row execute function public.guard_template_param_delete();

-- ----- 2. Audit trigger ------------------------------------------------------
-- Statement-level with a transition table: one audit_log row per affected
-- template per statement (a cascade from a result_templates delete also lands
-- here). actor_id is null / actor_type 'system' — the DB cannot know the app
-- user; the Save action writes its own richer result_template.saved row.
create or replace function public.log_template_param_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor_id, actor_type, action, resource_type, resource_id, metadata)
  select
    null, 'system', 'result_template.params_deleted', 'result_template',
    d.template_id,
    jsonb_build_object(
      'deleted_count',   d.cnt,
      'remaining_count', (select count(*) from public.result_template_params p
                           where p.template_id = d.template_id),
      'deleted_names',   d.names,
      'db_role',         session_user
    )
  from (
    select template_id,
           count(*) as cnt,
           jsonb_agg(parameter_name order by sort_order) as names
      from deleted_rows
     group by template_id
  ) d;
  return null;
end;
$$;

create trigger trg_log_template_param_delete
  after delete on public.result_template_params
  referencing old table as deleted_rows
  for each statement execute function public.log_template_param_delete();

-- ----- 3. RPCs ---------------------------------------------------------------
-- Service-role only (revoked from anon/authenticated up front — keeps faith
-- with the release-lifecycle lockdown; do not widen without a classify pass).

create or replace function public.admin_delete_template_params(param_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted integer;
begin
  perform set_config('app.allow_template_param_delete', 'on', true);
  delete from public.result_template_params where id = any(param_ids);
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- No is_active / result_values reference checks at the SQL layer — this RPC
-- trusts its caller (service_role only). Callers must confirm the template
-- is safe to remove (inactive, no longer the live template for its service /
-- report_group) and that no result_values still reference its params before
-- calling. The only DB-level backstop is the result_values FK on
-- result_template_params, which will simply block the delete outright.
create or replace function public.admin_delete_result_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.allow_template_param_delete', 'on', true);
  -- Cascades into result_template_params inside this same transaction, so the
  -- guard sees the flag.
  delete from public.result_templates where id = p_template_id;
end;
$$;

revoke execute on function public.admin_delete_template_params(uuid[])
  from public, anon, authenticated;
revoke execute on function public.admin_delete_result_template(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_delete_template_params(uuid[])
  to service_role;
grant execute on function public.admin_delete_result_template(uuid)
  to service_role;
