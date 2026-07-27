-- =============================================================================
-- 0124_rls_auto_enable_codify.sql
-- =============================================================================
-- Brings `public.rls_auto_enable()` and its `ensure_rls` event trigger into the
-- migration history. They exist on the hosted project and in no migration file,
-- which is the definition of schema drift: `supabase db reset` produces a
-- database that differs from production in a way nothing in the repo explains.
--
-- WHAT THEY DO
-- ------------
-- `ensure_rls` fires on `ddl_command_end` for CREATE TABLE / CREATE TABLE AS /
-- SELECT INTO and calls `rls_auto_enable()`, which runs
-- `alter table … enable row level security` on any new table in `public`. It is
-- a backstop for the per-new-table checklist: a table that ships without an
-- explicit `enable row level security` still comes up closed rather than open.
-- Failures are logged, never raised, so a DDL statement is never broken by it.
--
-- WHY CODIFY RATHER THAN DROP
-- ---------------------------
-- The alternative was to delete it from production and rely on the checklist
-- alone. Rejected: the drift is a safety net whose failure mode is silent and
-- severe (a public table with RLS off is readable by `anon` through PostgREST),
-- and it costs nothing to keep. Codifying also removes the conditional
-- `to_regprocedure(...)` dance 0118 had to wrap around its revoke, and means
-- the next `db reset` stops diverging from prod here.
--
-- THIS IS NOT PLUGGING AN RLS HOLE
-- --------------------------------
-- Checked before writing this: all 96 tables in `public` on production have RLS
-- enabled, and every one of them is enabled explicitly by a migration in this
-- repo (`alter table … enable row level security`). The trigger is therefore
-- load-bearing for FUTURE tables only — a fresh local database built from
-- migrations alone is not missing RLS anywhere today. Because this migration
-- runs last, it does not (and does not need to) retro-enable anything.
--
-- REPLAY SAFETY
-- -------------
-- Creating an event trigger requires superuser. `postgres` IS superuser on a
-- local CLI stack, so a fresh `db reset` gets the trigger. On the hosted
-- project it is not, but the trigger is already there, so the guarded block
-- below skips it. On any other environment where neither holds — a Supabase
-- branch, a restricted replica — the block degrades to a NOTICE instead of
-- failing the migration: the trigger is a backstop, not a correctness
-- requirement, and losing it must not make the history unreplayable.
--
-- Idempotent: `create or replace` for the function, existence-guarded create
-- for the trigger. `create or replace` preserves the existing ACL, so 0118's
-- revoke on the production copy is not undone.
-- =============================================================================

-- The definition is a byte-for-byte copy of what production runs today
-- (pg_get_functiondef, 2026-07-27). SECURITY DEFINER + `set search_path` are
-- both load-bearing: it has to run as the table owner to alter the table, and
-- the pinned search_path is what keeps that safe.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is not null
       and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog', 'information_schema')
       and cmd.schema_name not like 'pg_toast%'
       and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    else
      raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)',
        cmd.object_identity, cmd.schema_name;
    end if;
  end loop;
end;
$fn$;

-- Nothing calls this by hand — the DDL engine invokes it. Matches what 0118
-- already did to the production copy, and re-states it for the fresh-database
-- path in case 0119's default-privilege fix is ever rolled back.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The event trigger itself.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    raise notice '0124: event trigger ensure_rls already exists — left as is.';
    return;
  end if;

  execute $ddl$
    create event trigger ensure_rls
      on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable()
  $ddl$;
  raise notice '0124: created event trigger ensure_rls.';
exception
  when insufficient_privilege then
    raise notice
      '0124: cannot create event trigger ensure_rls here (requires superuser). New tables in public will NOT get RLS enabled automatically on this database — the per-table checklist in supabase/migrations is the only protection.';
end $$;

-- ---------------------------------------------------------------------------
-- Self-verification. The function is the part this migration is responsible
-- for on every environment; the trigger is asserted only where it exists, so
-- the restricted-privilege path above stays survivable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn oid := to_regprocedure('public.rls_auto_enable()');
  v_evt record;
begin
  if v_fn is null then
    raise exception '0124: public.rls_auto_enable() was not created';
  end if;

  if has_function_privilege('anon', v_fn, 'EXECUTE')
     or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '0124: rls_auto_enable() is still reachable by anon/authenticated';
  end if;

  select evtevent, evtenabled, evttags, evtfoid
    into v_evt
    from pg_event_trigger
   where evtname = 'ensure_rls';

  if not found then
    raise notice '0124: no ensure_rls event trigger on this database (see the notice above).';
    return;
  end if;

  if v_evt.evtfoid <> v_fn then
    raise exception '0124: ensure_rls points at % rather than public.rls_auto_enable()',
      v_evt.evtfoid::regprocedure;
  end if;

  if v_evt.evtevent <> 'ddl_command_end' or v_evt.evtenabled = 'D' then
    raise exception '0124: ensure_rls is on event % and enabled-state % — expected ddl_command_end, enabled',
      v_evt.evtevent, v_evt.evtenabled;
  end if;
end $$;
