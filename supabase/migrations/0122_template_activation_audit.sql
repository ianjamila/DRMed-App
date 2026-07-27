-- =============================================================================
-- 0122 — audit template activation flips
-- =============================================================================
-- 0121 made param loss traceable; deactivating a template is currently just
-- as silent — a direct SQL `update result_templates set is_active=false`
-- leaves no trace, same blind spot that let the CHEMISTRY outage run ~2
-- months undetected. This migration does NOT block the update (the admin
-- editor legitimately toggles is_active through PostgREST via the Save
-- action) — it only audits direct-SQL/out-of-band flips.
--
-- The app's Save action (saveTemplateAndParamsAction) already writes its own
-- richer `result_template.saved` row on every save, including ones that flip
-- is_active. This trigger fires on that same UPDATE too, so an app-driven
-- flip double-logs: one `result_template.saved` row (actor = the admin) and
-- one `result_template.deactivated`/`reactivated` row (actor = system). That
-- is acceptable and cheap — the point is that a hand-run SQL flip, which
-- writes no app-level row at all, is still caught.
-- =============================================================================

create or replace function public.log_template_activation_flip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (
    null,
    'system',
    case when new.is_active then 'result_template.reactivated' else 'result_template.deactivated' end,
    'result_template',
    new.id,
    jsonb_build_object(
      'service_id',       new.service_id,
      'report_group_id',  new.report_group_id,
      'param_count',      (select count(*) from public.result_template_params p
                            where p.template_id = new.id),
      'db_role',          session_user
    )
  );
  return null;
end;
$$;

create trigger trg_log_template_activation_flip
  after update on public.result_templates
  for each row
  when (old.is_active is distinct from new.is_active)
  execute function public.log_template_activation_flip();
