# Group Result Template Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consolidated report-group templates (CHEMISTRY) a full admin surface — list, edit, preview — move the encoding form's hardcoded service→parameter map into the database, and add DB guardrails so silent parameter loss can't recur.

**Architecture:** Two new admin routes (`group/[group_id]/edit`, `preview/group/[group_id]`) sit beside the existing per-service ones; the existing `TemplateEditor` + Save action are generalised over a discriminated `target` (`service` | `group`). A new `report_group_service_params` join table replaces the hardcoded `SERVICE_TO_PARAMS` map. Two migrations: `0118` (mapping table + RLS + backfill), `0119` (delete-guard trigger + audit trigger + service-role RPCs).

**Tech Stack:** Next.js 16 (App Router, RSC + Server Actions), Supabase (Postgres 17, RLS, PostgREST via supabase-js), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-group-result-template-admin-design.md` — read it first; it records verified production facts (gendered duplicate params, package-header semantics, why the guard must be RPC-shaped).

**Worktree/branch:** `~/Claude/DRMed/.worktrees/partner-feedback`, branch `feat/group-result-template-admin` (off `origin/main`).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/0118_report_group_service_params.sql` | Create | Mapping table + RLS + backfill |
| `supabase/migrations/0119_template_param_guardrails.sql` | Create | Guard trigger, audit trigger, `admin_delete_template_params` / `admin_delete_result_template` RPCs |
| `src/types/database.ts` | Regenerate | `npm run db:types` |
| `src/lib/results/enabled-params.ts` | Create | Pure `deriveEnabledParamIds` helper (no `server-only`) |
| `src/lib/results/enabled-params.test.ts` | Create | Unit tests |
| `src/lib/validations/result-template.ts` | Modify | `TemplateTargetSchema`; payload `target` replaces `service_id`; params gain `service_ids` |
| `src/lib/validations/result-template.test.ts` | Create | Unit tests |
| `.../admin/result-templates/[service_id]/edit/actions.ts` | Modify | Generalise over target; mapping reconciliation; delete via RPC |
| `.../admin/result-templates/[service_id]/edit/template-editor.tsx` | Modify | `target` prop, optional `mappableServices`, service chips per param, preview link by kind |
| `.../admin/result-templates/[service_id]/edit/page.tsx` | Modify | Pass `target`, `service_ids: null` |
| `.../admin/result-templates/group/[group_id]/edit/page.tsx` | Create | Group edit screen: panels + editor |
| `.../admin/result-templates/group/[group_id]/edit/actions.ts` | Create | `deleteSupersededTemplateAction` |
| `.../admin/result-templates/group/[group_id]/edit/superseded-templates.tsx` | Create | Client panel with delete buttons |
| `.../admin/result-templates/group/[group_id]/edit/encoding-preview.tsx` | Create | Client medtech-form preview with service toggles |
| `.../admin/result-templates/preview/group/[group_id]/route.ts` | Create | Group PDF preview |
| `.../admin/result-templates/preview/[service_id]/route.ts` | Modify | Remove dead group-template throw |
| `.../admin/result-templates/page.tsx` | Modify | "Report groups" section; grouped services stop offering "+ Create" |
| `.../queue/consolidated/[visitId]/[groupId]/page.tsx` | Modify | Fetch mapping, derive enabled ids server-side |
| `.../queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx` | Modify | Delete `SERVICE_TO_PARAMS`; id-based enablement |
| `scripts/seed-result-templates.ts` | Modify | Template wipe goes through RPC |

Route dir prefix throughout: `src/app/(staff)/staff/(dashboard)`.

---

### Task 1: Migration 0118 — mapping table + RLS + backfill

**Files:**
- Create: `supabase/migrations/0118_report_group_service_params.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0118 — report_group_service_params
-- =============================================================================
-- Moves the consolidated encoding form's hardcoded SERVICE_TO_PARAMS map
-- (consolidated-form.tsx) into the database. One row = "ordering this service
-- enables this template parameter on the consolidated form". Linking by
-- parameter_id (not name) means renaming a parameter in the admin editor can
-- no longer silently disable a medtech field.
--
-- LIPID_PROFILE_PACKAGE deliberately gets NO rows: it is a lab_package billing
-- header (0040) whose ₀-priced component test_requests (CHOLESTEROL,
-- HDL_LDL_VLDL, TRIGLYCERIDES) carry the encoding. See the 2026-07-27 spec.
-- =============================================================================

create table public.report_group_service_params (
  service_id   uuid not null references public.services(id) on delete cascade,
  parameter_id uuid not null references public.result_template_params(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (service_id, parameter_id)
);

create index idx_rgsp_parameter
  on public.report_group_service_params(parameter_id);

alter table public.report_group_service_params enable row level security;

-- Same shape as package_components (0040). Medtech read is load-bearing: the
-- consolidated queue page reads this through the user-scoped client.
create policy "report_group_service_params: staff read"
  on public.report_group_service_params for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "report_group_service_params: admin write"
  on public.report_group_service_params for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- Backfill from the hardcoded map ---------------------------------------
-- Joining on parameter_name naturally expands Creatinine and Uric Acid to both
-- their gendered rows (F + M), matching today's name-based behaviour exactly.
with map(code, pname) as (
  values
    ('FBS_RBS',       'FBS'),
    ('BUN',           'BUN'),
    ('CREATININE',    'Creatinine'),
    ('BUA_URIC_ACID', 'Uric Acid'),
    ('TRIGLYCERIDES', 'Triglycerides'),
    ('CHOLESTEROL',   'Cholesterol'),
    ('HDL_LDL_VLDL',  'HDL'),
    ('HDL_LDL_VLDL',  'LDL'),
    ('HDL_LDL_VLDL',  'VLDL'),
    ('SGPT_ALT',      'SGPT (ALT)'),
    ('SGOT_AST',      'SGOT (AST)'),
    ('HBA1C',         'HBA1C'),
    ('LIPID_PROFILE', 'Triglycerides'),
    ('LIPID_PROFILE', 'Cholesterol'),
    ('LIPID_PROFILE', 'HDL'),
    ('LIPID_PROFILE', 'LDL'),
    ('LIPID_PROFILE', 'VLDL')
)
insert into public.report_group_service_params (service_id, parameter_id)
select s.id, p.id
  from map m
  join public.services s
    on s.code = m.code and s.report_group_id is not null
  join public.result_templates rt
    on rt.report_group_id = s.report_group_id and rt.service_id is null
  join public.result_template_params p
    on p.template_id = rt.id and p.parameter_name = m.pname
on conflict do nothing;

-- ----- Assert ----------------------------------------------------------------
-- 17 map entries; CREATININE and BUA_URIC_ACID each expand to 2 gendered rows
-- => 19 pairs. On a fresh-from-migrations database `services` is empty (it is
-- seeded by scripts, not migrations), so the join legitimately inserts 0 rows —
-- only assert when grouped services actually exist.
do $$
declare
  svc_count  int;
  pair_count int;
begin
  select count(*) into svc_count
    from public.services where report_group_id is not null;
  select count(*) into pair_count
    from public.report_group_service_params;
  if svc_count > 0 and pair_count <> 19 then
    raise exception
      'report_group_service_params backfill expected 19 rows, got % (grouped services: %)',
      pair_count, svc_count;
  end if;
end $$;
```

- [ ] **Step 2: Reset local Supabase and verify the migration applies**

Run: `cd ~/Claude/DRMed/.worktrees/partner-feedback && npx supabase start && npm run db:reset`
Expected: reset completes with `0118_report_group_service_params.sql` in the applied list, no errors (assert skipped locally — services table is empty).

- [ ] **Step 3: Verify table + policies exist locally**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select count(*) from pg_policies where tablename='report_group_service_params';"`
Expected: `2`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0118_report_group_service_params.sql
git commit -m "feat(db): report_group_service_params mapping table + backfill (0118)"
```

---

### Task 2: Migration 0119 — guard + audit triggers + RPCs

**Files:**
- Create: `supabase/migrations/0119_template_param_guardrails.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0119 — template param guardrails
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
      using errcode = 'P0001';
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
      'db_role',         current_user
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
```

- [ ] **Step 2: Reset local DB**

Run: `npm run db:reset`
Expected: both 0118 and 0119 apply cleanly.

- [ ] **Step 3: Prove the guard blocks a bare delete locally**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "delete from public.result_template_params where parameter_name = 'FBS';"
```
Expected: `ERROR:  Deleting result_template_params requires explicit opt-in...`

- [ ] **Step 4: Prove the RPC path works and audits**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select public.admin_delete_template_params(array(select id from public.result_template_params where parameter_name = 'FBS'));" -c \
  "select action, metadata->>'deleted_count' as n, metadata->>'remaining_count' as left_over from public.audit_log where action = 'result_template.params_deleted' order by id desc limit 1;"
```
Expected: first select returns `1`; second returns one row `result_template.params_deleted | 1 | 13`.

- [ ] **Step 5: Restore local state**

Run: `npm run db:reset`
Expected: clean reset (FBS param back via 0053).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0119_template_param_guardrails.sql
git commit -m "feat(db): guard + audit template param deletes, service-role delete RPCs (0119)"
```

---

### Task 3: Regenerate types

**Files:**
- Regenerate: `src/types/database.ts`

- [ ] **Step 1: Regenerate**

Run: `npm run db:types`
Expected: `src/types/database.ts` gains `report_group_service_params` in `Tables` and `admin_delete_template_params` / `admin_delete_result_template` in `Functions`.

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` — expected clean.
```bash
git add src/types/database.ts
git commit -m "chore: regenerate database types for 0118/0119"
```

---

### Task 4: `deriveEnabledParamIds` helper (TDD)

**Files:**
- Create: `src/lib/results/enabled-params.ts`
- Test: `src/lib/results/enabled-params.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { deriveEnabledParamIds } from "./enabled-params";

const links = [
  // BUA_URIC_ACID enables BOTH gendered Uric Acid rows.
  { service_id: "svc-bua", parameter_id: "param-uric-f" },
  { service_id: "svc-bua", parameter_id: "param-uric-m" },
  { service_id: "svc-fbs", parameter_id: "param-fbs" },
  { service_id: "svc-lipid", parameter_id: "param-chol" },
  { service_id: "svc-lipid", parameter_id: "param-hdl" },
];

describe("deriveEnabledParamIds", () => {
  it("enables exactly the params linked to ordered services", () => {
    const out = deriveEnabledParamIds(links, ["svc-fbs"]);
    expect(out).toEqual(new Set(["param-fbs"]));
  });

  it("gendered duplicates: one service enables both rows", () => {
    const out = deriveEnabledParamIds(links, ["svc-bua"]);
    expect(out).toEqual(new Set(["param-uric-f", "param-uric-m"]));
  });

  it("package headers (no mapping rows) contribute nothing", () => {
    // LIPID_PROFILE_PACKAGE has no rows by design — components carry encoding.
    const out = deriveEnabledParamIds(links, ["svc-lipid-package", "svc-chol-component"]);
    expect(out).toEqual(new Set());
  });

  it("unions across multiple ordered services", () => {
    const out = deriveEnabledParamIds(links, ["svc-fbs", "svc-lipid"]);
    expect(out).toEqual(new Set(["param-fbs", "param-chol", "param-hdl"]));
  });

  it("empty inputs produce an empty set", () => {
    expect(deriveEnabledParamIds([], ["svc-fbs"])).toEqual(new Set());
    expect(deriveEnabledParamIds(links, [])).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/results/enabled-params.test.ts`
Expected: FAIL — cannot resolve `./enabled-params`.

- [ ] **Step 3: Implement**

```ts
// Pure derivation of which template parameters the consolidated encoding form
// enables, from report_group_service_params rows + this visit's ordered
// services. Identity-based (parameter_id) — replaces the old name-matched
// SERVICE_TO_PARAMS map. Must stay free of "server-only" imports (unit-tested).

export interface ServiceParamLink {
  service_id: string;
  parameter_id: string;
}

export function deriveEnabledParamIds(
  links: ServiceParamLink[],
  orderedServiceIds: string[],
): Set<string> {
  const ordered = new Set(orderedServiceIds);
  const enabled = new Set<string>();
  for (const link of links) {
    if (ordered.has(link.service_id)) enabled.add(link.parameter_id);
  }
  return enabled;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/results/enabled-params.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/results/enabled-params.ts src/lib/results/enabled-params.test.ts
git commit -m "feat: pure deriveEnabledParamIds helper for consolidated encoding"
```

---

### Task 5: Validation schema — discriminated target + `service_ids` (TDD)

**Files:**
- Modify: `src/lib/validations/result-template.ts`
- Test: `src/lib/validations/result-template.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  TemplateEditorPayloadSchema,
  TemplateTargetSchema,
} from "./result-template";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const baseParam = {
  id: null,
  parameter_name: "FBS",
  input_type: "numeric",
  section: null,
  is_section_header: false,
  unit_si: "mmol/L",
  unit_conv: "mg/dL",
  ref_low_si: 4.1,
  ref_high_si: 5.9,
  ref_low_conv: null,
  ref_high_conv: null,
  gender: null,
  si_to_conv_factor: 18.0182,
  allowed_values: null,
  abnormal_values: null,
  placeholder: null,
  ranges: [],
};

describe("TemplateTargetSchema", () => {
  it("accepts a service target", () => {
    expect(
      TemplateTargetSchema.parse({ kind: "service", id: UUID_A }),
    ).toEqual({ kind: "service", id: UUID_A });
  });

  it("accepts a group target", () => {
    expect(TemplateTargetSchema.parse({ kind: "group", id: UUID_A })).toEqual({
      kind: "group",
      id: UUID_A,
    });
  });

  it("rejects an unknown kind", () => {
    expect(
      TemplateTargetSchema.safeParse({ kind: "panel", id: UUID_A }).success,
    ).toBe(false);
  });
});

describe("TemplateEditorPayloadSchema", () => {
  const payload = {
    target: { kind: "group", id: UUID_A },
    layout: "dual_unit",
    header_notes: null,
    footer_notes: null,
    is_active: true,
    params: [baseParam],
  };

  it("parses a group payload; service_ids defaults to null", () => {
    const out = TemplateEditorPayloadSchema.parse(payload);
    expect(out.target).toEqual({ kind: "group", id: UUID_A });
    expect(out.params[0].service_ids).toBeNull();
  });

  it("carries service_ids through when provided", () => {
    const out = TemplateEditorPayloadSchema.parse({
      ...payload,
      params: [{ ...baseParam, service_ids: [UUID_B] }],
    });
    expect(out.params[0].service_ids).toEqual([UUID_B]);
  });

  it("rejects non-uuid service_ids", () => {
    const res = TemplateEditorPayloadSchema.safeParse({
      ...payload,
      params: [{ ...baseParam, service_ids: ["not-a-uuid"] }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a payload still using the old service_id key", () => {
    const legacy = { ...payload, target: undefined, service_id: UUID_A };
    expect(TemplateEditorPayloadSchema.safeParse(legacy).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/validations/result-template.test.ts`
Expected: FAIL — `TemplateTargetSchema` not exported.

- [ ] **Step 3: Modify the schema**

In `src/lib/validations/result-template.ts`:

Add after `ParamInputTypeEnum`:

```ts
// Which row of result_templates a save targets. XOR-enforced in the DB
// (result_templates_target_xor, 0051): service templates key by service_id,
// consolidated group templates by report_group_id.
export const TemplateTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service"), id: z.string().uuid() }),
  z.object({ kind: z.literal("group"), id: z.string().uuid() }),
]);
export type TemplateTarget = z.infer<typeof TemplateTargetSchema>;
```

Add to `TemplateParamSchema` (after `ranges`):

```ts
  // Group targets only: which services enable this parameter on the
  // consolidated encoding form (report_group_service_params rows). Null for
  // service targets and for section headers.
  service_ids: z
    .array(z.string().uuid())
    .nullish()
    .transform((v) => v ?? null),
```

Replace in `TemplateEditorPayloadSchema`:

```ts
  service_id: z.string().uuid(),
```
with
```ts
  target: TemplateTargetSchema,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/validations/result-template.test.ts`
Expected: all passed. (`npm run typecheck` will fail until Tasks 6–7 land — that's expected mid-refactor; don't "fix" it by reverting.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validations/result-template.ts src/lib/validations/result-template.test.ts
git commit -m "feat: template editor payload targets service or report group"
```

---

### Task 6: Generalise the Save action

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/result-templates/[service_id]/edit/actions.ts`

- [ ] **Step 1: Rework target resolution (replaces lines 29–81)**

After `const data = parsed.data;` / `const admin = createAdminClient();` replace the service-verification and template-upsert blocks with:

```ts
  // Resolve the target — a service or a report group. groupServiceIds doubles
  // as the validation set for per-param service_ids.
  let targetLabel: { code: string; name: string };
  let groupServiceIds: Set<string> | null = null;

  if (data.target.kind === "service") {
    const { data: svc } = await admin
      .from("services")
      .select("id, code, name")
      .eq("id", data.target.id)
      .maybeSingle();
    if (!svc) return { ok: false, error: "Service not found." };
    targetLabel = { code: svc.code, name: svc.name };
  } else {
    const { data: grp } = await admin
      .from("report_groups")
      .select("id, code, name")
      .eq("id", data.target.id)
      .maybeSingle();
    if (!grp) return { ok: false, error: "Report group not found." };
    targetLabel = { code: grp.code, name: grp.name };

    const { data: groupSvcs } = await admin
      .from("services")
      .select("id")
      .eq("report_group_id", data.target.id);
    groupServiceIds = new Set((groupSvcs ?? []).map((s) => s.id));
    for (const p of data.params) {
      for (const sid of p.service_ids ?? []) {
        if (!groupServiceIds.has(sid)) {
          return {
            ok: false,
            error: `"${p.parameter_name}" maps a service that is not in the ${grp.name} group.`,
          };
        }
      }
    }
  }

  // Upsert the template row — keyed by service_id or report_group_id.
  const targetColumn =
    data.target.kind === "service" ? "service_id" : "report_group_id";
  const { data: existing } = await admin
    .from("result_templates")
    .select("id")
    .eq(targetColumn, data.target.id)
    .maybeSingle();

  let templateId = existing?.id ?? null;
  if (!templateId) {
    const { data: created, error: insErr } = await admin
      .from("result_templates")
      .insert({
        [targetColumn]: data.target.id,
        layout: data.layout,
        header_notes: data.header_notes,
        footer_notes: data.footer_notes,
        is_active: data.is_active,
      })
      .select("id")
      .single();
    if (insErr || !created) {
      return {
        ok: false,
        error: `Could not create template: ${insErr?.message ?? "unknown"}`,
      };
    }
    templateId = created.id;
  } else {
    const { error: updErr } = await admin
      .from("result_templates")
      .update({
        layout: data.layout,
        header_notes: data.header_notes,
        footer_notes: data.footer_notes,
        is_active: data.is_active,
      })
      .eq("id", templateId);
    if (updErr) {
      return { ok: false, error: `Could not update template: ${updErr.message}` };
    }
  }
```

- [ ] **Step 2: Route the param delete through the RPC**

Replace the `.delete().in("id", toDelete)` block (keep the `result_values` refCount check above it exactly as-is) with:

```ts
    // 0119 guard: raw deletes are blocked; the RPC sets the opt-in flag and
    // deletes in one transaction. Mapping rows cascade away with the param.
    const { error: delErr } = await admin.rpc("admin_delete_template_params", {
      param_ids: toDelete,
    });
    if (delErr) {
      return { ok: false, error: `Could not delete params: ${delErr.message}` };
    }
```

- [ ] **Step 3: Reconcile mapping rows per param (group targets only)**

At the end of the per-param loop body — after the ranges reconciliation, still inside `for (let i = 0; ...)` — add:

```ts
    // Group targets: reconcile report_group_service_params for this param.
    if (data.target.kind === "group") {
      const desired = new Set(p.service_ids ?? []);
      const { data: existingMap } = await admin
        .from("report_group_service_params")
        .select("service_id")
        .eq("parameter_id", paramId);
      const have = new Set((existingMap ?? []).map((r) => r.service_id));
      const removeIds = [...have].filter((id) => !desired.has(id));
      const addIds = [...desired].filter((id) => !have.has(id));
      if (removeIds.length > 0) {
        const { error: mDelErr } = await admin
          .from("report_group_service_params")
          .delete()
          .eq("parameter_id", paramId)
          .in("service_id", removeIds);
        if (mDelErr) {
          return {
            ok: false,
            error: `Could not unmap services from "${p.parameter_name}": ${mDelErr.message}`,
          };
        }
      }
      if (addIds.length > 0) {
        const { error: mInsErr } = await admin
          .from("report_group_service_params")
          .insert(addIds.map((service_id) => ({ service_id, parameter_id: paramId })));
        if (mInsErr) {
          return {
            ok: false,
            error: `Could not map services to "${p.parameter_name}": ${mInsErr.message}`,
          };
        }
      }
    }
```

- [ ] **Step 4: Update audit metadata + revalidation**

In the `audit(...)` call replace `service_id: data.service_id, service_code: svc.code,` with:

```ts
      target_kind: data.target.kind,
      target_id: data.target.id,
      target_code: targetLabel.code,
```

Replace the two `revalidatePath` lines with:

```ts
  revalidatePath("/staff/admin/result-templates");
  if (data.target.kind === "service") {
    revalidatePath(`/staff/admin/result-templates/${data.target.id}/edit`);
  } else {
    revalidatePath(`/staff/admin/result-templates/group/${data.target.id}/edit`);
  }
```

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/result-templates/[service_id]/edit/actions.ts"
git commit -m "feat: save action handles group targets, mapping reconcile, guarded deletes"
```

---

### Task 7: TemplateEditor target refactor + service chips

**Files:**
- Modify: `.../[service_id]/edit/template-editor.tsx`
- Modify: `.../[service_id]/edit/page.tsx`

- [ ] **Step 1: Replace the editor's props + payload + header + preview link**

In `template-editor.tsx`:

Import `TemplateTarget` from validations. Replace `serviceId/serviceCode/serviceName` in `Props`:

```ts
export interface TemplateTargetInfo {
  kind: TemplateTarget["kind"];
  id: string;
  code: string;
  name: string;
}

interface Props {
  target: TemplateTargetInfo;
  // Group targets only: services of the group, for the per-param mapping
  // chips. Omit for service targets.
  mappableServices?: { id: string; code: string }[];
  hasTemplate: boolean;
  initialLayout: TemplateEditorPayload["layout"];
  initialHeaderNotes: string | null;
  initialFooterNotes: string | null;
  initialIsActive: boolean;
  initialParams: TemplateParamPayload[];
}
```

In `emptyParam()` add `service_ids: null,`.

In `submit()` replace `service_id: props.serviceId,` with:

```ts
        target: { kind: props.target.kind, id: props.target.id },
```

In the header JSX replace `props.serviceCode` → `props.target.code` and `props.serviceName` → `props.target.name`.

Replace the preview link `href`:

```ts
            href={
              props.target.kind === "service"
                ? `/staff/admin/result-templates/preview/${props.target.id}`
                : `/staff/admin/result-templates/preview/group/${props.target.id}`
            }
```

- [ ] **Step 2: Add mapping chips to `ParamRow`**

Pass `mappableServices` down at the call site:

```tsx
              <ParamRow
                key={p.id ?? `new-${idx}`}
                idx={idx}
                total={params.length}
                p={p}
                mappableServices={props.mappableServices}
                onChange={(patch) => updateParam(idx, patch)}
                onRemove={() => removeParam(idx)}
                onMoveUp={() => moveParam(idx, -1)}
                onMoveDown={() => moveParam(idx, 1)}
              />
```

Add `mappableServices?: { id: string; code: string }[];` to `ParamRowProps` and destructure it. Inside `ParamRow`, render after the existing field grid (skip for section headers):

```tsx
      {mappableServices && !isHeader ? (
        <div className="mt-3 border-t border-dashed border-[color:var(--color-brand-bg-mid)] pt-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Enabled by services ({(p.service_ids ?? []).length})
          </p>
          <p className="mt-0.5 text-[11px] text-[color:var(--color-brand-text-soft)]">
            Medtechs can only type into this field when the visit ordered one
            of the ticked services. A field no service enables is unreachable.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {mappableServices.map((s) => {
              const on = (p.service_ids ?? []).includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const cur = new Set(p.service_ids ?? []);
                    if (on) cur.delete(s.id);
                    else cur.add(s.id);
                    onChange({ service_ids: [...cur] });
                  }}
                  className={
                    on
                      ? "rounded-md bg-[color:var(--color-brand-navy)] px-2 py-1 font-mono text-[10px] font-bold text-white"
                      : "rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 font-mono text-[10px] text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)]"
                  }
                >
                  {s.code}
                </button>
              );
            })}
          </div>
          {(p.service_ids ?? []).length === 0 ? (
            <p className="mt-1.5 text-[11px] font-semibold text-amber-700">
              ⚠ No service enables this field — medtechs will never be able to
              fill it in.
            </p>
          ) : null}
        </div>
      ) : null}
```

- [ ] **Step 3: Update the per-service edit page**

In `[service_id]/edit/page.tsx`, add `service_ids: null,` to the `initialParams` mapping object, and replace the `TemplateEditor` invocation's first three props:

```tsx
      <TemplateEditor
        target={{ kind: "service", id: svc.id, code: svc.code, name: svc.name }}
        hasTemplate={!!tpl}
        ...
```

- [ ] **Step 4: Typecheck + test + commit**

Run: `npm run typecheck && npm test`
Expected: clean, 373+ tests pass.

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/result-templates/[service_id]/edit/template-editor.tsx" "src/app/(staff)/staff/(dashboard)/admin/result-templates/[service_id]/edit/page.tsx"
git commit -m "feat: template editor generalised over service/group target with mapping chips"
```

---

### Task 8: Seed script uses the RPC

**Files:**
- Modify: `scripts/seed-result-templates.ts` (`clearExistingTemplate`, ~line 516)

- [ ] **Step 1: Swap the template delete for the RPC**

Replace:

```ts
  const { error: delErr } = await admin
    .from("result_templates")
    .delete()
    .eq("id", priorTemplate.id);
```

with:

```ts
  // 0119 guards param deletes; this RPC opts in and cascades template → params
  // in one transaction. A raw .delete() here would be blocked by the trigger.
  const { error: delErr } = await admin.rpc("admin_delete_result_template", {
    p_template_id: priorTemplate.id,
  });
```

- [ ] **Step 2: Commit**

```bash
git add scripts/seed-result-templates.ts
git commit -m "fix: seed template wipe goes through guarded delete RPC"
```

---

### Task 9: Group edit screen

**Files:**
- Create: `.../group/[group_id]/edit/page.tsx`
- Create: `.../group/[group_id]/edit/actions.ts`
- Create: `.../group/[group_id]/edit/superseded-templates.tsx`

- [ ] **Step 1: Write `actions.ts`**

```ts
"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export type DeleteSupersededResult =
  | { ok: true }
  | { ok: false; error: string };

// Deletes an unreachable per-service template that a group template
// supersedes. Refuses if any finalised result still references its params
// (same FK protection as the Save action) or if the template is somehow
// still active / not actually superseded.
export async function deleteSupersededTemplateAction(input: {
  templateId: string;
  groupId: string;
}): Promise<DeleteSupersededResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, service_id, is_active")
    .eq("id", input.templateId)
    .maybeSingle();
  if (!tpl || !tpl.service_id) {
    return { ok: false, error: "Template not found (or not a per-service template)." };
  }
  if (tpl.is_active) {
    return { ok: false, error: "Template is still active — deactivate it first." };
  }

  const { data: svc } = await admin
    .from("services")
    .select("id, code, report_group_id")
    .eq("id", tpl.service_id)
    .maybeSingle();
  if (!svc || svc.report_group_id !== input.groupId) {
    return { ok: false, error: "Service is not part of this report group." };
  }

  const { data: params } = await admin
    .from("result_template_params")
    .select("id")
    .eq("template_id", tpl.id);
  const paramIds = (params ?? []).map((r) => r.id);
  if (paramIds.length > 0) {
    const { count: refCount } = await admin
      .from("result_values")
      .select("id", { count: "exact", head: true })
      .in("parameter_id", paramIds);
    if ((refCount ?? 0) > 0) {
      return {
        ok: false,
        error: `Cannot delete: ${refCount} finalised result values still reference this template's params.`,
      };
    }
  }

  const { error: delErr } = await admin.rpc("admin_delete_result_template", {
    p_template_id: tpl.id,
  });
  if (delErr) {
    return { ok: false, error: `Could not delete: ${delErr.message}` };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result_template.superseded_deleted",
    resource_type: "result_template",
    resource_id: tpl.id,
    metadata: {
      service_id: svc.id,
      service_code: svc.code,
      report_group_id: input.groupId,
      param_count: paramIds.length,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/admin/result-templates/group/${input.groupId}/edit`);
  revalidatePath("/staff/admin/result-templates");
  return { ok: true };
}
```

- [ ] **Step 2: Write `superseded-templates.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteSupersededTemplateAction } from "./actions";

export interface SupersededTemplate {
  templateId: string;
  serviceCode: string;
  serviceName: string;
  paramCount: number;
}

// The 0053 migration deactivated the per-service chemistry templates when the
// consolidated group template took over, but left the rows behind. They are
// unreachable — queue/[id] redirects any grouped service to the consolidated
// flow — yet the admin index used to file these services under "no template",
// inviting a pointless re-create. Surface + delete them here.
export function SupersededTemplates(props: {
  groupId: string;
  groupName: string;
  items: SupersededTemplate[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (props.items.length === 0) return null;

  function handleDelete(templateId: string) {
    setError(null);
    setBusyId(templateId);
    start(async () => {
      const res = await deleteSupersededTemplateAction({
        templateId,
        groupId: props.groupId,
      });
      setBusyId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
      <h3 className="font-heading text-lg font-extrabold text-amber-900">
        Superseded per-service templates ({props.items.length})
      </h3>
      <p className="mt-1 text-sm text-amber-900">
        These deactivated templates are unreachable: the queue always routes
        their services to the consolidated {props.groupName} form, so
        reactivating one does <strong>nothing</strong>. Safe to delete — the
        group template above is what medtechs actually use.
      </p>
      <ul className="mt-3 divide-y divide-amber-200">
        {props.items.map((t) => (
          <li
            key={t.templateId}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <p className="font-mono text-[10px] text-amber-800">
                {t.serviceCode}
              </p>
              <p className="truncate text-sm font-medium text-amber-900">
                {t.serviceName}{" "}
                <span className="font-normal">
                  · {t.paramCount} param{t.paramCount === 1 ? "" : "s"}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleDelete(t.templateId)}
              disabled={pending}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              {busyId === t.templateId ? "Deleting…" : "Delete"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 3: Write `page.tsx`**

```tsx
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { loadTemplateParams } from "@/lib/results/loaders";
import { TemplateEditor } from "../../../[service_id]/edit/template-editor";
import { SupersededTemplates } from "./superseded-templates";
import { EncodingPreview } from "./encoding-preview";
import type {
  TemplateEditorPayload,
  TemplateParamPayload,
} from "@/lib/validations/result-template";

export const metadata = { title: "Edit group template — staff" };

interface Props {
  params: Promise<{ group_id: string }>;
}

export default async function EditGroupTemplatePage({ params }: Props) {
  const session = await requireAdminStaff();
  if (session.role !== "admin") redirect("/staff");

  const { group_id } = await params;
  const admin = createAdminClient();

  const { data: group } = await admin
    .from("report_groups")
    .select("id, code, name, is_active")
    .eq("id", group_id)
    .maybeSingle();
  if (!group) notFound();

  const { data: services } = await admin
    .from("services")
    .select("id, code, name, kind, is_active, is_send_out")
    .eq("report_group_id", group_id)
    .order("code", { ascending: true });
  const svcList = services ?? [];
  const svcIds = svcList.map((s) => s.id);

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes, is_active")
    .eq("report_group_id", group_id)
    .maybeSingle();

  // Mapping rows for this template's params (group targets only).
  const rawParams = tpl ? await loadTemplateParams(admin, tpl.id) : [];
  const paramIds = rawParams.map((p) => p.id);
  const { data: mapRows } = paramIds.length
    ? await admin
        .from("report_group_service_params")
        .select("service_id, parameter_id")
        .in("parameter_id", paramIds)
    : { data: [] as { service_id: string; parameter_id: string }[] };
  const svcsByParam = new Map<string, string[]>();
  for (const m of mapRows ?? []) {
    const arr = svcsByParam.get(m.parameter_id) ?? [];
    arr.push(m.service_id);
    svcsByParam.set(m.parameter_id, arr);
  }

  const initialParams: TemplateParamPayload[] = rawParams.map((p) => ({
    id: p.id,
    parameter_name: p.parameter_name,
    input_type: p.input_type,
    section: p.section,
    is_section_header: p.is_section_header,
    unit_si: p.unit_si,
    unit_conv: p.unit_conv,
    ref_low_si: p.ref_low_si,
    ref_high_si: p.ref_high_si,
    ref_low_conv: p.ref_low_conv,
    ref_high_conv: p.ref_high_conv,
    gender: p.gender,
    si_to_conv_factor: p.si_to_conv_factor,
    allowed_values: p.allowed_values,
    abnormal_values: p.abnormal_values,
    placeholder: p.placeholder,
    service_ids: svcsByParam.get(p.id) ?? null,
    ranges: p.ranges.map((r) => ({
      id: r.id,
      band_label: r.band_label,
      age_min_months: r.age_min_months,
      age_max_months: r.age_max_months,
      gender: r.gender,
      ref_low_si: r.ref_low_si,
      ref_high_si: r.ref_high_si,
      ref_low_conv: r.ref_low_conv,
      ref_high_conv: r.ref_high_conv,
    })),
  }));

  // Superseded per-service templates on this group's services.
  const { data: perSvcTpls } = svcIds.length
    ? await admin
        .from("result_templates")
        .select("id, service_id, is_active, result_template_params(id)")
        .in("service_id", svcIds)
    : { data: [] };
  const superseded = (perSvcTpls ?? [])
    .filter((t) => !t.is_active)
    .map((t) => {
      const svc = svcList.find((s) => s.id === t.service_id);
      return {
        templateId: t.id,
        serviceCode: svc?.code ?? "?",
        serviceName: svc?.name ?? "Unknown service",
        paramCount: (t.result_template_params ?? []).length,
      };
    });

  // Change history: the app's own saves + the 0119 delete-audit rows.
  const { data: history } = tpl
    ? await admin
        .from("audit_log")
        .select("id, actor_id, actor_type, action, metadata, created_at")
        .eq("resource_type", "result_template")
        .eq("resource_id", tpl.id)
        .order("created_at", { ascending: false })
        .limit(15)
    : { data: [] };
  const actorIds = [
    ...new Set((history ?? []).map((h) => h.actor_id).filter((a): a is string => !!a)),
  ];
  const { data: actors } = actorIds.length
    ? await admin.from("staff_profiles").select("id, full_name").in("id", actorIds)
    : { data: [] };
  const actorName = new Map((actors ?? []).map((a) => [a.id, a.full_name]));

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/staff/admin/result-templates"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Result templates
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {tpl ? "Edit group template" : "Create group template"}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          One consolidated template shared by every service in the{" "}
          <strong>{group.name}</strong> group. The medtech queue routes all of
          them to a single {group.name} report form.
        </p>
      </div>

      {tpl && tpl.is_active && initialParams.length === 0 ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          This template is active but has no parameters — the {group.name}{" "}
          encoding form is broken until parameters are restored.
        </p>
      ) : null}

      {/* Mapped services */}
      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Services in this group ({svcList.length})
        </h3>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Changes to this template affect the encoding form and PDF for every
          service below.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {svcList.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                  {s.code}
                </p>
                <p className="truncate text-sm text-[color:var(--color-brand-text-mid)]">
                  {s.name}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {s.kind === "lab_package" ? (
                  <span className="rounded bg-[color:var(--color-brand-bg-mid)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-mid)]">
                    Billing header
                  </span>
                ) : null}
                {!s.is_active ? (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
                    Inactive
                  </span>
                ) : null}
                {s.is_send_out ? (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
                    Send-out⚠
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-[color:var(--color-brand-text-soft)]">
          Billing headers (lab packages) fan out into component tests at order
          time — they enable no fields themselves, their components do.
        </p>
      </section>

      <TemplateEditor
        target={{ kind: "group", id: group.id, code: group.code, name: group.name }}
        mappableServices={svcList
          .filter((s) => s.kind !== "lab_package")
          .map((s) => ({ id: s.id, code: s.code }))}
        hasTemplate={!!tpl}
        initialLayout={(tpl?.layout ?? "dual_unit") as TemplateEditorPayload["layout"]}
        initialHeaderNotes={tpl?.header_notes ?? null}
        initialFooterNotes={tpl?.footer_notes ?? null}
        initialIsActive={tpl?.is_active ?? true}
        initialParams={initialParams}
      />

      <EncodingPreview
        groupName={group.name}
        services={svcList.map((s) => ({
          id: s.id,
          code: s.code,
          kind: s.kind,
        }))}
        params={rawParams.map((p) => ({
          id: p.id,
          parameter_name: p.parameter_name,
          gender: p.gender,
          unit_si: p.unit_si,
          unit_conv: p.unit_conv,
          sort_order: p.sort_order,
        }))}
        links={(mapRows ?? []).map((m) => ({
          service_id: m.service_id,
          parameter_id: m.parameter_id,
        }))}
      />

      <SupersededTemplates
        groupId={group.id}
        groupName={group.name}
        items={superseded}
      />

      {/* Change history */}
      {tpl ? (
        <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
          <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Change history
          </h3>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            Saves from this screen plus database-level parameter deletions
            (logged by trigger since migration 0119). The 2-month CHEMISTRY
            outage was invisible precisely because nothing recorded the loss.
          </p>
          {(history ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-[color:var(--color-brand-text-soft)]">
              No recorded changes yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(history ?? []).map((h) => {
                const meta = (h.metadata ?? {}) as Record<string, unknown>;
                const isDelete = h.action === "result_template.params_deleted";
                return (
                  <li key={h.id} className="flex items-baseline justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${isDelete ? "text-red-700" : "text-[color:var(--color-brand-navy)]"}`}>
                        {isDelete
                          ? `Deleted ${String(meta.deleted_count ?? "?")} parameter(s) — ${String(meta.remaining_count ?? "?")} remaining`
                          : `Saved — ${String(meta.param_count ?? "?")} parameter(s)`}
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {h.actor_id
                          ? (actorName.get(h.actor_id) ?? "Unknown staff")
                          : `Database (${String(meta.db_role ?? "unknown role")})`}
                      </p>
                    </div>
                    <time className="shrink-0 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {new Date(h.created_at).toLocaleString("en-PH", {
                        timeZone: "Asia/Manila",
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck (EncodingPreview still missing — expected to fail), then proceed to Task 10 before committing**

Run: `npm run typecheck`
Expected: FAIL only on the missing `./encoding-preview` module. Task 10 supplies it; commit both together there.

---

### Task 10: Encoding-form preview component

**Files:**
- Create: `.../group/[group_id]/edit/encoding-preview.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState } from "react";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";

interface PreviewParam {
  id: string;
  parameter_name: string;
  gender: string | null;
  unit_si: string | null;
  unit_conv: string | null;
  sort_order: number;
}

interface PreviewService {
  id: string;
  code: string;
  kind: string;
}

// Simulates the medtech consolidated encoding form: tick the services a visit
// "ordered" and see exactly which fields enable. The 2-month CHEMISTRY outage
// was a broken ENTRY FORM — a PDF preview alone would not have shown 13
// missing fields. Uses the same deriveEnabledParamIds as the real form.
export function EncodingPreview(props: {
  groupName: string;
  services: PreviewService[];
  params: PreviewParam[];
  links: { service_id: string; parameter_id: string }[];
}) {
  const [ordered, setOrdered] = useState<Set<string>>(
    () => new Set(props.services.map((s) => s.id)),
  );

  if (props.params.length === 0) return null;

  const enabled = deriveEnabledParamIds(props.links, [...ordered]);
  const sorted = [...props.params].sort((a, b) => a.sort_order - b.sort_order);

  function toggle(id: string) {
    setOrdered((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Encoding form preview
      </h3>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        What the medtech sees on the consolidated {props.groupName} form. Tick
        the services a hypothetical visit ordered — greyed rows are disabled,
        exactly as on the real form. Save the template first to preview
        unsaved mapping changes.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {props.services.map((s) => {
          const on = ordered.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(s.id)}
              className={
                on
                  ? "rounded-md bg-[color:var(--color-brand-cyan)] px-2 py-1 font-mono text-[10px] font-bold text-white"
                  : "rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 font-mono text-[10px] text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)]"
              }
            >
              {s.code}
              {s.kind === "lab_package" ? " (header)" : ""}
            </button>
          );
        })}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)]">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Test</th>
              <th className="px-3 py-2">Gender</th>
              <th className="px-3 py-2">SI Unit</th>
              <th className="px-3 py-2">Conv Unit</th>
              <th className="px-3 py-2">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {sorted.map((p) => {
              const on = enabled.has(p.id);
              return (
                <tr key={p.id} className={on ? "" : "opacity-40"}>
                  <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                    {p.parameter_name}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.gender ?? "Any"}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.unit_si ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.unit_conv ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {on ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                        Enabled
                      </span>
                    ) : (
                      <span className="rounded bg-[color:var(--color-brand-bg-mid)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        Disabled
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + commit Tasks 9+10 together**

Run: `npm run typecheck`
Expected: clean.

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/result-templates/group"
git commit -m "feat: group template edit screen with mapping, previews, history, superseded cleanup"
```

---

### Task 11: Group PDF preview route

**Files:**
- Create: `.../preview/group/[group_id]/route.ts`
- Modify: `.../preview/[service_id]/route.ts` (remove dead check, lines 54–58)

- [ ] **Step 1: Write the group preview route**

```ts
// GET /staff/admin/result-templates/preview/group/[group_id]
// Sample PDF for a report-group (consolidated) template with synthesised
// values. Mirrors the per-service preview route; populates
// ResultDocumentInput.reportGroup — the same path real consolidated results
// use — instead of `service`.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { buildPreviewValues } from "@/lib/results/preview-data";
import { loadTemplateParams } from "@/lib/results/loaders";
import { loadConsultantSignatures, resolvePerformer } from "@/lib/results/signatures";
import type {
  ResultDocumentInput,
  ResultLayout,
} from "@/lib/results/types";

export const runtime = "nodejs";

interface Props {
  params: Promise<{ group_id: string }>;
}

export async function GET(_req: Request, { params }: Props) {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { group_id } = await params;
  const supabase = await createClient();

  const { data: group } = await supabase
    .from("report_groups")
    .select("id, code, name")
    .eq("id", group_id)
    .maybeSingle();
  if (!group) {
    return new NextResponse("Report group not found", { status: 404 });
  }

  const { data: template } = await supabase
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("report_group_id", group_id)
    .maybeSingle();
  if (!template) {
    return new NextResponse(
      "No template configured for this report group yet.",
      { status: 404 },
    );
  }

  const { data: services } = await supabase
    .from("services")
    .select("code, name, is_active")
    .eq("report_group_id", group_id)
    .order("code", { ascending: true });

  const templateParams = await loadTemplateParams(supabase, template.id);
  const values = buildPreviewValues(templateParams);

  const consultants = await loadConsultantSignatures();
  const performer = await resolvePerformer({
    service: { code: group.code, kind: null },
    finalisedByStaffId: null,
  });

  const input: ResultDocumentInput = {
    template: {
      layout: template.layout as ResultLayout,
      header_notes: template.header_notes,
      footer_notes: template.footer_notes,
    },
    params: templateParams,
    values,
    reportGroup: {
      code: group.code,
      name: group.name,
      orderedTests: (services ?? [])
        .filter((s) => s.is_active)
        .map((s) => ({ code: s.code, name: s.name })),
    },
    patient: {
      drm_id: "DRM-PREVIEW",
      last_name: "DOE",
      first_name: "JANE",
      sex: "F",
      birthdate: "1985-04-12",
    },
    visit: { visit_number: "PREVIEW" },
    controlNo: null,
    finalisedAt: null,
    medtech: {
      full_name: session.full_name,
      prc_license_kind: null,
      prc_license_no: null,
    },
    performer,
    consultantPathologist: consultants.pathologist,
    isPreview: true,
  };

  const pdf = await renderResultPdf(input);

  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${group.code}-preview.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 2: Remove the dead check in the per-service preview route**

In `preview/[service_id]/route.ts` delete lines 54–59 (the `if (template.report_group_id != null) { throw ... }` block) and drop `report_group_id` from the select on line 45. The `result_templates_target_xor` constraint makes that branch unreachable for a row fetched by `service_id`; group previews live at `preview/group/[group_id]`.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` — expected clean.

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/result-templates/preview"
git commit -m "feat: PDF preview for report-group templates; drop dead group check"
```

---

### Task 12: Consolidated encoding form reads the mapping from the DB

**Files:**
- Modify: `.../queue/consolidated/[visitId]/[groupId]/page.tsx`
- Modify: `.../queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx`

- [ ] **Step 1: Derive enabled ids server-side in `page.tsx`**

Add imports:

```ts
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";
```

After the `requests` load + guard, add:

```ts
  // Which params this visit's ordered services enable — from
  // report_group_service_params (0118), not the old hardcoded map. Package
  // headers legitimately have no rows; their components carry the encoding.
  const orderedServiceIds = requests.map((r) => {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    return svc?.id ?? "";
  });
  const { data: mapRows } = await supabase
    .from("report_group_service_params")
    .select("service_id, parameter_id")
    .in(
      "parameter_id",
      (template.result_template_params ?? []).map((p: { id: string }) => p.id),
    );
  const enabledParamIds = [
    ...deriveEnabledParamIds(mapRows ?? [], orderedServiceIds),
  ];
```

Pass it to the form (new prop):

```tsx
      enabledParamIds={enabledParamIds}
```

- [ ] **Step 2: Swap name-matching for id-matching in `consolidated-form.tsx`**

1. Delete the whole `SERVICE_TO_PARAMS` constant (lines ~20–34 incl. comment).
2. Add `enabledParamIds: string[];` to `Props`.
3. Replace:

```ts
  const enabledParamNames = new Set<string>(
    props.orderedServiceCodes.flatMap((c) => SERVICE_TO_PARAMS[c] ?? []),
  );
```

with:

```ts
  // Derived server-side from report_group_service_params — identity-based, so
  // renaming a parameter in the admin editor can't silently disable a field.
  const enabledParamIds = new Set(props.enabledParamIds);
```

4. In `handleFinalise` replace `.filter((p) => enabledParamNames.has(p.parameter_name))` with `.filter((p) => enabledParamIds.has(p.id))`.
5. In the table body replace `const enabled = enabledParamNames.has(p.parameter_name);` with `const enabled = enabledParamIds.has(p.id);`.

- [ ] **Step 3: Typecheck + full test run + commit**

Run: `npm run typecheck && npm test`
Expected: clean / all pass.

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/consolidated"
git commit -m "feat: consolidated encoding form enablement comes from the database mapping"
```

---

### Task 13: Index page — report groups section + honest grouped services

**Files:**
- Modify: `.../admin/result-templates/page.tsx`

- [ ] **Step 1: Extend the data loads**

Add `report_group_id` to the services select (line 30). After the templates fetch, add:

```ts
  const { data: groups } = await supabase
    .from("report_groups")
    .select("id, code, name, is_active");

  const { data: groupTemplates } = await supabase
    .from("result_templates")
    .select("id, report_group_id, layout, is_active")
    .not("report_group_id", "is", null);

  const { data: paramRows } = await supabase
    .from("result_template_params")
    .select("template_id");
  const paramCountByTemplate = new Map<string, number>();
  for (const r of paramRows ?? []) {
    paramCountByTemplate.set(
      r.template_id,
      (paramCountByTemplate.get(r.template_id) ?? 0) + 1,
    );
  }
```

- [ ] **Step 2: Partition grouped services out of the existing buckets**

Extend `ServiceRow` with `reportGroupId: string | null` (map it from `s.report_group_id ?? null`). Then:

```ts
  const grouped = rows.filter((r) => r.reportGroupId);
  const ungrouped = rows.filter((r) => !r.reportGroupId);
  const withTemplate = ungrouped.filter((r) => r.templateLayout);
  const eligibleNoTemplate = ungrouped.filter(
    (r) => !r.templateLayout && !r.is_send_out,
  );
  const sendOut = ungrouped.filter((r) => r.is_send_out);
```

- [ ] **Step 3: Add the "Report groups" section (first, above "With template")**

```tsx
      <Section
        title="Report groups (consolidated templates)"
        subtitle="One shared template per group — services below route to a single consolidated report form in the queue."
      >
        {(groups ?? []).length === 0 ? (
          <Empty text="No report groups configured." />
        ) : (
          <ul className="grid gap-3">
            {(groups ?? []).map((g) => {
              const tpl = (groupTemplates ?? []).find(
                (t) => t.report_group_id === g.id,
              );
              const nParams = tpl ? (paramCountByTemplate.get(tpl.id) ?? 0) : 0;
              const members = grouped.filter((r) => r.reportGroupId === g.id);
              const broken = !!tpl && tpl.is_active && nParams === 0;
              return (
                <li
                  key={g.id}
                  className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.code}
                      </p>
                      <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                        {g.name}
                        <span className="ml-2 text-xs font-normal text-[color:var(--color-brand-text-soft)]">
                          {tpl
                            ? `${tpl.layout} · ${nParams} param${nParams === 1 ? "" : "s"} · ${members.length} services`
                            : "no template yet"}
                        </span>
                      </p>
                      {broken ? (
                        <p className="mt-0.5 text-xs font-bold text-red-700">
                          ⚠ Active template with 0 parameters — the encoding
                          form is broken.
                        </p>
                      ) : null}
                      {tpl && !tpl.is_active ? (
                        <p className="mt-0.5 text-xs font-bold text-amber-700">
                          Template inactive — the consolidated queue form will
                          not load.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Link
                        href={`/staff/admin/result-templates/group/${g.id}/edit`}
                        className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                      >
                        {tpl ? "Edit" : "Create"}
                      </Link>
                      {tpl ? (
                        <Link
                          href={`/staff/admin/result-templates/preview/group/${g.id}`}
                          target="_blank"
                          rel="noopener"
                          className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
                        >
                          Preview PDF
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  {members.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        Managed by this group:
                      </span>
                      {members.map((m) => (
                        <span
                          key={m.id}
                          className="font-mono text-[10px] text-[color:var(--color-brand-text-mid)]"
                        >
                          {m.code}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
```

Also update the page's Phase header line `Phase 13 · Admin` intro copy if it mentions counts — no change needed otherwise. The grouped services no longer appear in "Eligible without template", so the misleading "+ Create" is gone by construction.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/result-templates/page.tsx"
git commit -m "feat: result-templates index lists report groups, stops offering + Create on grouped services"
```

---

### Task 14: Full verification

- [ ] **Step 1: Lint, typecheck, unit tests**

Run: `npm run lint && npm run typecheck && npm test`
Expected: 0 lint errors (3 pre-existing warnings OK), typecheck clean, all tests pass (368 pre-existing + ~14 new).

- [ ] **Step 2: Render-pipeline smoke**

Run: `npm run smoke:results`
Expected: passes (unchanged renderer).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: builds clean; both new routes appear in the route manifest.

- [ ] **Step 4: Manual browser verification (local dev, Playwright MCP, admin sign-in as Ian Jamila)**

Local stack + `npm run seed:services && npm run seed:templates` first if the local DB is fresh, then `npm run dev`. Verify with text-first snapshots (screenshot only the group edit screen once):
1. `/staff/admin/result-templates` — Report groups section shows CHEMISTRY with param/service counts; chemistry services show under the group, not under "Eligible without template".
2. Group edit screen loads: mapped services, editor with chips, encoding preview, superseded panel.
3. Toggle a service off in the encoding preview → its params grey out.
4. Save the template unchanged → success; change-history gains a row.
5. Group Preview PDF returns a PDF (check response content-type; no screenshot needed).
6. A consolidated queue report still enables the right fields (seeded visit or skip if no seed path — note it in the report).

- [ ] **Step 5: Commit any fixes**

---

### Task 15: Apply migrations to production + PR

- [ ] **Step 1: Dry-run 0118 against production (BEGIN/ROLLBACK) — via MCP `execute_sql`**

Wrap the 0118 body in `begin; ... rollback;` and confirm: 19 mapping rows inserted, assert passes. **Ask the user before any non-rolled-back prod write.**

- [ ] **Step 2: With user confirmation, apply 0118 + 0119 to prod** (`supabase db push` from the worktree, or MCP `apply_migration` with the same numbered names).

- [ ] **Step 3: Verify prod post-apply**

```sql
select count(*) from report_group_service_params;              -- 19
select proname from pg_proc where proname like 'admin_delete%'; -- 2 rows
```
And confirm a bare `delete from result_template_params where false;` runs (0 rows, no error) but the guard blocks a real one inside a `begin/rollback` probe.

- [ ] **Step 4: Push branch + open PR**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/group-result-template-admin
gh pr create --title "feat: admin surface for consolidated report-group result templates" --body "<summary per repo conventions incl. verification evidence>"
```
PR body must cover: the blind-spot mechanism, the mapping move (incl. package-header semantics), the guard design and why it's RPC-shaped, prod apply status, and test evidence.

---

## Self-review notes

- **Spec coverage:** routes (T9/T11), shared editor target (T5–T7), four screen extras (T9/T10), index (T13), mapping table + backfill + RLS (T1), form reads DB (T12), guard + audit + RPCs (T2), seed fix (T8), tests (T4/T5), prod ordering (T15). Full-group CRUD: out of scope per spec.
- **Known coupling:** Task 9's page imports `TemplateEditor` from `../../../[service_id]/edit/template-editor` — path traverses the dynamic segment dir; valid in Next (imports are module paths, not routes).
- **Gendered chips caveat:** `BUA_URIC_ACID` must stay ticked on BOTH Uric Acid rows (F and M); the editor shows each row separately with its own chips — the backfill guarantees the starting state, the encoding preview makes regressions visible.
