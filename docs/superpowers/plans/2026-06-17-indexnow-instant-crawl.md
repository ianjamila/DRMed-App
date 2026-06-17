# IndexNow — instant re-crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push new/changed public URLs (physician pages, service pages, full site) to IndexNow so participating engines (Bing → Copilot & DuckDuckGo, Yandex, Seznam, Naver, Yep) re-crawl drmed.ph promptly.

**Architecture:** A pure, unit-tested core (`indexnow-core.ts`) holds URL builders, the payload builder, and the gating predicate. A `server-only` wrapper (`indexnow.ts`) does the `fetch` + error reporting and exposes `allSiteUrls()`. The sitemap's URL set is extracted to a shared `buildSitemapEntries()` so the full-submit can't drift. On-publish hooks in the physician/service admin Server Actions ping the affected URLs; a small admin page offers a one-click full re-submit. A root route handler serves the verification key from an env var.

**Tech Stack:** Next.js 16 (App Router, Server Actions, route handlers), TypeScript strict, vitest, Supabase (admin client for audit only).

**Spec:** `docs/superpowers/specs/2026-06-17-indexnow-instant-crawl-design.md`

**Conventions to honor:**
- Server Actions return `{ ok: true, data } | { ok: false, error }`.
- Unit-tested modules must NOT `import "server-only"` (vitest can't load them). Keep pure logic in `indexnow-core.ts`.
- IndexNow is **best-effort**: `submitToIndexNow` never throws; failures go to `reportError`.
- Per AGENTS.md, this Next.js may differ from training data — when in doubt about a route-handler convention, check `node_modules/next/dist/docs/`.

---

## File Structure

**New**
- `src/lib/seo/indexnow-core.ts` — pure: endpoint constant, `indexNowEnabled`, `physicianPageUrls`, `servicePageUrls`, `buildIndexNowPayload`.
- `src/lib/seo/indexnow-core.test.ts` — vitest for the above.
- `src/lib/seo/sitemap-entries.ts` — `buildSitemapEntries()` (the shared URL set).
- `src/lib/seo/indexnow.ts` — `server-only`: `submitToIndexNow`, `allSiteUrls`.
- `src/app/indexnow-key.txt/route.ts` — serves `INDEXNOW_KEY` as text/plain at `/indexnow-key.txt`.
- `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx` — status + full-submit.
- `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts` — `resubmitAllToIndexNowAction`.
- `src/app/(staff)/staff/(dashboard)/admin/seo/resubmit-button.tsx` — client button.

**Modified**
- `src/app/sitemap.ts` — thin wrapper over `buildSitemapEntries`.
- `src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts` — 4 on-publish hooks (+ old-slug pre-read in update).
- `src/app/(staff)/staff/(dashboard)/services/actions.ts` — 2 on-publish hooks (+ `code` in prior-read).
- `src/components/staff/staff-nav-config.ts` — 1 Admin-tools nav item.
- `.env.example` — `INDEXNOW_KEY` block.

---

## Task 1: Pure core module (TDD)

**Files:**
- Create: `src/lib/seo/indexnow-core.ts`
- Test: `src/lib/seo/indexnow-core.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/seo/indexnow-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildIndexNowPayload,
  indexNowEnabled,
  physicianPageUrls,
  servicePageUrls,
} from "./indexnow-core";

describe("physicianPageUrls", () => {
  it("returns the doctor page and the index; trims a trailing slash on base", () => {
    expect(physicianPageUrls("https://drmed.ph/", "dr-jane-cruz")).toEqual([
      "https://drmed.ph/physicians/dr-jane-cruz",
      "https://drmed.ph/physicians",
    ]);
  });
});

describe("servicePageUrls", () => {
  it("lowercases the code and includes the index + packages", () => {
    expect(servicePageUrls("https://drmed.ph", "CBC")).toEqual([
      "https://drmed.ph/all-services/cbc",
      "https://drmed.ph/all-services",
      "https://drmed.ph/packages",
    ]);
  });
});

describe("indexNowEnabled", () => {
  it("is true only in production with a non-empty key", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "abc" })).toBe(true);
  });
  it("is false without a usable key", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "" })).toBe(false);
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "   " })).toBe(false);
    expect(indexNowEnabled({ VERCEL_ENV: "production" })).toBe(false);
  });
  it("is false outside production", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "preview", INDEXNOW_KEY: "abc" })).toBe(false);
    expect(indexNowEnabled({ INDEXNOW_KEY: "abc" })).toBe(false);
  });
});

describe("buildIndexNowPayload", () => {
  const base = { key: "abc", host: "drmed.ph", keyLocation: "https://drmed.ph/indexnow-key.txt" };

  it("dedupes and keeps only same-host http(s) urls", () => {
    const payload = buildIndexNowPayload({
      ...base,
      urls: [
        "https://drmed.ph/physicians",
        "https://drmed.ph/physicians",
        "https://evil.com/x",
        "not-a-url",
        "  ",
      ],
    });
    expect(payload).toEqual({ ...base, urlList: ["https://drmed.ph/physicians"] });
  });

  it("returns null when nothing valid remains", () => {
    expect(buildIndexNowPayload({ ...base, urls: ["https://evil.com/x"] })).toBeNull();
    expect(buildIndexNowPayload({ ...base, urls: [] })).toBeNull();
  });

  it("caps the list at 10000 urls", () => {
    const many = Array.from({ length: 10050 }, (_, i) => `https://drmed.ph/p/${i}`);
    expect(buildIndexNowPayload({ ...base, urls: many })?.urlList.length).toBe(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/seo/indexnow-core.test.ts`
Expected: FAIL — cannot find module `./indexnow-core`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/seo/indexnow-core.ts`:

```ts
// Pure IndexNow helpers — no `server-only` so vitest can import them.
// Keep all fetch / env-reading / reporting in the server wrapper indexnow.ts.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowEnv {
  VERCEL_ENV?: string;
  INDEXNOW_KEY?: string;
}

/**
 * Submissions only fire in production with a configured key. Preview/local
 * no-op so we never ping real engines with non-production URLs.
 */
export function indexNowEnabled(env: IndexNowEnv): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    typeof env.INDEXNOW_KEY === "string" &&
    env.INDEXNOW_KEY.trim().length > 0
  );
}

function trimBase(base: string): string {
  return base.replace(/\/$/, "");
}

/** The doctor's own page plus the physicians index. */
export function physicianPageUrls(base: string, slug: string): string[] {
  const b = trimBase(base);
  return [`${b}/physicians/${slug}`, `${b}/physicians`];
}

/** The service detail page (code lowercased, matching the sitemap), the
 *  all-services index, and the packages page. */
export function servicePageUrls(base: string, code: string): string[] {
  const b = trimBase(base);
  return [`${b}/all-services/${code.toLowerCase()}`, `${b}/all-services`, `${b}/packages`];
}

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/**
 * Build the POST body: dedupe, keep only http(s) URLs on `host`, cap at the
 * IndexNow per-request limit. Returns null when no usable URL remains.
 */
export function buildIndexNowPayload(input: {
  urls: string[];
  key: string;
  host: string;
  keyLocation: string;
}): IndexNowPayload | null {
  const { urls, key, host, keyLocation } = input;
  const seen = new Set<string>();
  const urlList: string[] = [];
  for (const raw of urls) {
    const u = raw.trim();
    if (!u) continue;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.host !== host) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urlList.push(u);
    if (urlList.length >= 10000) break;
  }
  if (urlList.length === 0) return null;
  return { host, key, keyLocation, urlList };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/seo/indexnow-core.test.ts`
Expected: PASS (4 describes, all green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seo/indexnow-core.ts src/lib/seo/indexnow-core.test.ts
git commit -m "feat(seo): pure IndexNow core helpers + tests"
```

---

## Task 2: Sitemap refactor + server wrapper

**Files:**
- Create: `src/lib/seo/sitemap-entries.ts`
- Create: `src/lib/seo/indexnow.ts`
- Modify: `src/app/sitemap.ts`

- [ ] **Step 1: Extract the sitemap entries**

Create `src/lib/seo/sitemap-entries.ts` (body moved verbatim from the current `sitemap.ts`):

```ts
import "server-only";
import type { MetadataRoute } from "next";
import { listActiveServices } from "@/lib/marketing/services";
import { listActivePhysicians } from "@/lib/marketing/physicians";
import { SITE } from "@/lib/marketing/site";

/** Single source of truth for the public URL set — used by both the sitemap
 *  route and the IndexNow full-submit. */
export async function buildSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = SITE.url.replace(/\/$/, "");
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    "/",
    "/all-services",
    "/packages",
    "/physicians",
    "/schedule",
    "/about",
    "/contact",
    "/privacy",
    "/terms",
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: path === "/" ? 1.0 : 0.7,
  }));

  const services = await listActiveServices();
  const serviceEntries: MetadataRoute.Sitemap = services.map((s) => ({
    url: `${base}/all-services/${s.code.toLowerCase()}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const physicians = await listActivePhysicians();
  const physicianEntries: MetadataRoute.Sitemap = physicians.map((p) => ({
    url: `${base}/physicians/${p.slug}`,
    lastModified: p.updated_at ? new Date(p.updated_at) : now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...staticEntries, ...serviceEntries, ...physicianEntries];
}
```

- [ ] **Step 2: Make `sitemap.ts` a thin wrapper**

Replace the entire contents of `src/app/sitemap.ts` with:

```ts
import type { MetadataRoute } from "next";
import { buildSitemapEntries } from "@/lib/seo/sitemap-entries";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries();
}
```

- [ ] **Step 3: Write the server wrapper**

Create `src/lib/seo/indexnow.ts`:

```ts
import "server-only";
import { SITE } from "@/lib/marketing/site";
import { reportError } from "@/lib/observability/report-error";
import {
  INDEXNOW_ENDPOINT,
  buildIndexNowPayload,
  indexNowEnabled,
} from "./indexnow-core";
import { buildSitemapEntries } from "./sitemap-entries";

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  skipped?: "disabled" | "no-urls";
}

/**
 * Best-effort IndexNow submission. Never throws; failures go to reportError.
 * MUST be awaited by callers — Vercel can freeze the function before a
 * fire-and-forget request completes.
 */
export async function submitToIndexNow(
  urls: string[],
  opts: { trigger: string },
): Promise<IndexNowResult> {
  if (!indexNowEnabled(process.env)) {
    return { ok: true, submitted: 0, skipped: "disabled" };
  }

  const base = SITE.url.replace(/\/$/, "");
  let host: string;
  try {
    host = new URL(base).host;
  } catch (error) {
    await reportError({ scope: "seo/indexnow", error, metadata: { trigger: opts.trigger, base } });
    return { ok: false, submitted: 0 };
  }

  // Non-null: indexNowEnabled() guarantees a non-empty key.
  const key = process.env.INDEXNOW_KEY as string;
  const keyLocation = `${base}/indexnow-key.txt`;
  const payload = buildIndexNowPayload({ urls, key, host, keyLocation });
  if (!payload) return { ok: true, submitted: 0, skipped: "no-urls" };

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      await reportError({
        scope: "seo/indexnow",
        error: new Error(`IndexNow responded ${res.status}`),
        metadata: { trigger: opts.trigger, count: payload.urlList.length, status: res.status },
      });
      return { ok: false, submitted: 0 };
    }
    return { ok: true, submitted: payload.urlList.length };
  } catch (error) {
    await reportError({
      scope: "seo/indexnow",
      error,
      metadata: { trigger: opts.trigger, count: payload.urlList.length },
    });
    return { ok: false, submitted: 0 };
  }
}

/** Every public URL in the sitemap — for the manual full-submit. */
export async function allSiteUrls(): Promise<string[]> {
  const entries = await buildSitemapEntries();
  return entries.map((e) => e.url);
}
```

- [ ] **Step 4: Verify types + existing tests**

Run: `npm run typecheck && npx vitest run src/lib/seo/indexnow-core.test.ts`
Expected: typecheck passes; core tests still PASS.

- [ ] **Step 5: Verify the sitemap still builds**

Run: `npx next build --no-lint 2>&1 | grep -iE "sitemap|error" | head` (or a full `npm run build`)
Expected: build completes; `/sitemap.xml` present; no errors referencing `sitemap` or `seo`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/seo/sitemap-entries.ts src/lib/seo/indexnow.ts src/app/sitemap.ts
git commit -m "feat(seo): IndexNow server wrapper + shared sitemap entries"
```

---

## Task 3: Verification key route handler

**Files:**
- Create: `src/app/indexnow-key.txt/route.ts`

- [ ] **Step 1: Create the route handler**

Create `src/app/indexnow-key.txt/route.ts`:

```ts
// Serves the IndexNow verification key (public, not secret) at the site root:
// https://drmed.ph/indexnow-key.txt. Root placement is required — IndexNow
// only trusts a key file whose path is a parent of every submitted URL, and
// our public URLs are all root-level. The ping sends this as `keyLocation`.

export const dynamic = "force-dynamic";

export function GET(): Response {
  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
```

- [ ] **Step 2: Verify the dotted route segment builds**

Run: `npm run build`
Expected: build succeeds and the route `/indexnow-key.txt` appears in the route list.

> **Contingency (only if the build rejects the dotted folder `indexnow-key.txt/`):**
> Delete `src/app/indexnow-key.txt/`, create `src/app/[seoKeyFile]/route.ts` instead, and keep the served path/keyLocation identical:
> ```ts
> import { notFound } from "next/navigation";
> export const dynamic = "force-dynamic";
> export async function GET(_req: Request, ctx: { params: Promise<{ seoKeyFile: string }> }): Promise<Response> {
>   const { seoKeyFile } = await ctx.params;
>   const key = process.env.INDEXNOW_KEY?.trim();
>   if (!key || seoKeyFile !== "indexnow-key.txt") notFound();
>   return new Response(key, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
> }
> ```
> (Literal routes take precedence over this single dynamic root segment, so existing pages are unaffected; unknown single-segment paths still 404 via `notFound()`.)

- [ ] **Step 3: Verify it serves locally**

Run: `INDEXNOW_KEY=testkey123 npm run dev` in one shell, then in another:
`curl -i http://localhost:3000/indexnow-key.txt`
Expected: `200`, `Content-Type: text/plain`, body exactly `testkey123`. Stop the dev server.
(Without the env var set, expect `404`.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/indexnow-key.txt/route.ts"
git commit -m "feat(seo): serve IndexNow verification key at /indexnow-key.txt"
```

---

## Task 4: Physician on-publish hooks

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts`

- [ ] **Step 1: Add imports**

At the top of the file, after the existing imports, add:

```ts
import { SITE } from "@/lib/marketing/site";
import { submitToIndexNow } from "@/lib/seo/indexnow";
import { physicianPageUrls } from "@/lib/seo/indexnow-core";
```

- [ ] **Step 2: Hook `createPhysicianAction`**

In `createPhysicianAction`, insert the ping immediately before `revalidatePath("/staff/admin/physicians");` (which is right before the final `redirect`):

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, created.slug), {
    trigger: "physician.created",
  });

  revalidatePath("/staff/admin/physicians");
  redirect("/staff/admin/physicians");
```

- [ ] **Step 3: Hook `updatePhysicianAction` (pre-read old slug)**

In `updatePhysicianAction`, replace the block that builds the admin client and runs the update:

```ts
  const admin = createAdminClient();
  const { error } = await admin
    .from("physicians")
    .update(parsed.data)
    .eq("id", physicianId);
  if (error) return { ok: false, error: error.message };
```

with:

```ts
  const admin = createAdminClient();
  const { data: prior } = await admin
    .from("physicians")
    .select("slug")
    .eq("id", physicianId)
    .maybeSingle();
  const { error } = await admin
    .from("physicians")
    .update(parsed.data)
    .eq("id", physicianId);
  if (error) return { ok: false, error: error.message };
```

Then insert the ping immediately before this action's `revalidatePath("/staff/admin/physicians");`:

```ts
  const slugs = new Set<string>([parsed.data.slug]);
  if (prior?.slug && prior.slug !== parsed.data.slug) slugs.add(prior.slug);
  await submitToIndexNow(
    [...slugs].flatMap((s) => physicianPageUrls(SITE.url, s)),
    { trigger: "physician.updated" },
  );

  revalidatePath("/staff/admin/physicians");
```

- [ ] **Step 4: Hook `uploadPhotoAction`**

In `uploadPhotoAction`, insert the ping immediately before this action's `revalidatePath("/staff/admin/physicians");` (it ends with `return { ok: true };`):

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.photo_updated",
  });

  revalidatePath("/staff/admin/physicians");
```

- [ ] **Step 5: Hook `deletePhysicianAction`**

In `deletePhysicianAction`, insert the ping immediately before its `revalidatePath("/staff/admin/physicians");`:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.deleted",
  });

  revalidatePath("/staff/admin/physicians");
  redirect("/staff/admin/physicians");
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass (no unused-import or type errors in `physicians/actions.ts`).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts"
git commit -m "feat(seo): ping IndexNow on physician create/update/photo/delete"
```

---

## Task 5: Service on-publish hooks

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/services/actions.ts`

- [ ] **Step 1: Add imports**

At the top of the file, after the existing imports, add:

```ts
import { SITE } from "@/lib/marketing/site";
import { submitToIndexNow } from "@/lib/seo/indexnow";
import { servicePageUrls } from "@/lib/seo/indexnow-core";
```

- [ ] **Step 2: Hook `createServiceAction`**

In `createServiceAction`, insert the ping immediately before its `revalidatePath("/staff/services");`:

```ts
  await submitToIndexNow(servicePageUrls(SITE.url, data.code), {
    trigger: "service.created",
  });

  revalidatePath("/staff/services");
  redirect("/staff/services");
```

- [ ] **Step 3: Add `code` to the prior-read in `updateServiceAction`**

In `updateServiceAction`, change the prior-read select from:

```ts
  const { data: prior } = await supabase
    .from("services")
    .select("price_php, hmo_price_php, senior_discount_php")
    .eq("id", serviceId)
    .maybeSingle();
```

to:

```ts
  const { data: prior } = await supabase
    .from("services")
    .select("code, price_php, hmo_price_php, senior_discount_php")
    .eq("id", serviceId)
    .maybeSingle();
```

- [ ] **Step 4: Hook `updateServiceAction`**

In `updateServiceAction`, insert the ping immediately before its `revalidatePath("/staff/services");`:

```ts
  const codes = new Set<string>([parsed.data.code]);
  if (prior?.code && prior.code !== parsed.data.code) codes.add(prior.code);
  await submitToIndexNow(
    [...codes].flatMap((c) => servicePageUrls(SITE.url, c)),
    { trigger: "service.updated" },
  );

  revalidatePath("/staff/services");
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass. (Note: `prior.price_php` / `prior.hmo_price_php` / `prior.senior_discount_php` still resolve — `code` was only added to the select.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/services/actions.ts"
git commit -m "feat(seo): ping IndexNow on service create/update"
```

---

## Task 6: Admin page + full-submit action + nav

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/admin/seo/resubmit-button.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx`
- Modify: `src/components/staff/staff-nav-config.ts`

- [ ] **Step 1: Create the full-submit action**

Create `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts`:

```ts
"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { allSiteUrls, submitToIndexNow } from "@/lib/seo/indexnow";

export type ResubmitResult =
  | { ok: true; data: { submitted: number; total: number; skipped: string | null } }
  | { ok: false; error: string };

export async function resubmitAllToIndexNowAction(): Promise<ResubmitResult> {
  const session = await requireAdminStaff();

  const urls = await allSiteUrls();
  const res = await submitToIndexNow(urls, { trigger: "manual.full" });

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "seo.indexnow.full_submit",
    resource_type: "seo",
    metadata: {
      count: urls.length,
      submitted: res.submitted,
      ok: res.ok,
      skipped: res.skipped ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (!res.ok) {
    return { ok: false, error: "IndexNow submission failed. Check the server logs." };
  }
  return {
    ok: true,
    data: { submitted: res.submitted, total: urls.length, skipped: res.skipped ?? null },
  };
}
```

- [ ] **Step 2: Create the client button**

Create `src/app/(staff)/staff/(dashboard)/admin/seo/resubmit-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { resubmitAllToIndexNowAction } from "./actions";

export function ResubmitIndexNowButton({ disabled }: { disabled?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function handleClick() {
    startTransition(async () => {
      const res = await resubmitAllToIndexNowAction();
      if (res.ok) {
        if (res.data.skipped === "disabled") {
          setResult("Submissions are disabled outside production — nothing was sent.");
        } else if (res.data.skipped === "no-urls") {
          setResult("No URLs to submit.");
        } else {
          setResult(`Submitted ${res.data.submitted} of ${res.data.total} URLs to IndexNow.`);
        }
      } else {
        setResult(`Error: ${res.error}`);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || disabled}
        className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-50"
      >
        {isPending ? "Submitting…" : "Re-submit all pages now"}
      </button>
      {result ? (
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">{result}</span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Create the admin page**

Create `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx`:

```tsx
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { SITE } from "@/lib/marketing/site";
import { allSiteUrls } from "@/lib/seo/indexnow";
import { indexNowEnabled } from "@/lib/seo/indexnow-core";
import { ResubmitIndexNowButton } from "./resubmit-button";

export const metadata = { title: "Search engines (IndexNow) — staff" };
export const dynamic = "force-dynamic";

export default async function IndexNowAdminPage() {
  await requireAdminStaff();

  const base = SITE.url.replace(/\/$/, "");
  const keyLocation = `${base}/indexnow-key.txt`;
  const keyConfigured = !!process.env.INDEXNOW_KEY?.trim();
  const live = indexNowEnabled(process.env);
  const urls = await allSiteUrls();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Search engines (IndexNow)
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          When a doctor or service is added or changed, the affected pages are
          pushed to IndexNow so Bing (which also powers Copilot &amp; DuckDuckGo),
          Yandex and others re-crawl them quickly. Google does not use IndexNow —
          it keeps getting changes through the sitemap and Search Console.
        </p>
      </header>

      <dl className="mb-6 space-y-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Verification key</dt>
          <dd className="font-semibold">
            {keyConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Submissions active here</dt>
          <dd className="font-semibold">
            {live ? "Yes (production)" : "No — disabled outside production"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Key file</dt>
          <dd className="break-all font-mono text-xs">{keyLocation}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Pages in a full submit</dt>
          <dd className="font-semibold">{urls.length}</dd>
        </div>
      </dl>

      <ResubmitIndexNowButton disabled={!live} />

      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Use this once after setting the key, or to re-seed every page (for
        example after a content update). Every full submit is recorded in the
        audit log.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Add the nav item**

In `src/components/staff/staff-nav-config.ts`, inside the **"Admin tools"** subgroup, insert the new item immediately after the `Dashboard settings` item (the one with `href: "/staff/admin/settings/dashboard-cards"`):

```ts
          {
            href: "/staff/admin/seo",
            label: "Search engines (IndexNow)",
            description: "Push new or changed pages to Bing, Yandex and other IndexNow engines for faster indexing, and re-submit the whole site after setup or a content update. (Google indexes via the sitemap, not IndexNow.)",
            roles: ["admin"],
          },
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/seo" src/components/staff/staff-nav-config.ts
git commit -m "feat(seo): admin IndexNow page + manual full re-submit"
```

---

## Task 7: Env documentation + final verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the env var**

In `.env.example`, immediately after the `CRON_SECRET=replace-with-random-hex-string` line, add:

```
# IndexNow — instant search-engine re-crawl (Bing/Copilot/DuckDuckGo, Yandex,
# Seznam, Naver, Yep — NOT Google). Public verification key, NOT a secret.
# Generate once with: openssl rand -hex 16
# Served at <site>/indexnow-key.txt. Pings only fire when VERCEL_ENV=production
# AND this is set; preview/local no-op.
INDEXNOW_KEY=
```

- [ ] **Step 2: Full verification sweep**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: typecheck clean, lint clean, all vitest green (including `indexnow-core.test.ts`), build succeeds with `/indexnow-key.txt` and `/sitemap.xml` in the route list.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(seo): document INDEXNOW_KEY env var"
```

---

## Self-Review (completed during plan authoring)

**Spec coverage:**
- Protocol / single endpoint → Task 2 (`INDEXNOW_ENDPOINT`, `submitToIndexNow`). ✓
- Env-var key + root `/indexnow-key.txt` + keyLocation → Task 3 + Task 2 (`keyLocation`). ✓
- Pure core, no `server-only`, unit-tested → Task 1. ✓
- Production gating / best-effort never-throws → Task 2 (`indexNowEnabled`, try/catch + reportError). ✓
- Shared sitemap source → Task 2 (`buildSitemapEntries`). ✓
- On-publish hooks (physicians ×4 incl. old-slug; services ×2 incl. old-code) → Tasks 4–5. ✓
- Manual full-submit page + action + audit + nav → Task 6. ✓
- `.env.example` → Task 7. ✓
- Google-not-participating note → page copy (Task 6) + env comment (Task 7) + spec. ✓

**Placeholder scan:** none — every code/command step is complete.

**Type consistency:** `submitToIndexNow(urls, { trigger })` / `IndexNowResult` / `indexNowEnabled(env)` / `physicianPageUrls(base, slug)` / `servicePageUrls(base, code)` / `buildIndexNowPayload({urls,key,host,keyLocation})` / `allSiteUrls()` / `buildSitemapEntries()` / `resubmitAllToIndexNowAction(): ResubmitResult` — names and signatures match across all tasks. `session.user_id`, `ipAndAgent()`, `audit()` match existing repo usage.
