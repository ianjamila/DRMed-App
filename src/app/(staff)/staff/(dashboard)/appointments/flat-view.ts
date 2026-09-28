/**
 * Pure logic for the Appointments page's flat/sorted search view — kept out
 * of page.tsx (a Server Component with DB calls) so it's cheaply
 * vitest-tested the way every other pure domain module in this repo is. No
 * `server-only`, no DB.
 *
 * The shapes below are intentionally minimal structural subsets of
 * page.tsx's `ApptRow`/`ApptGroup` (rather than importing them) so this
 * module has zero dependency on the page's DB-shaped types.
 */

import { appointmentStatusLabel } from "@/lib/appointments/labels";
import { appointmentSourceLabel } from "@/lib/appointments/source";

export interface FlatSortableRow {
  id: string;
  created_at: string;
  scheduled_at: string | null;
  status: string;
  patient_name: string | null;
  patient_drm_id: string | null;
  patient_phone: string | null;
  walk_in_name: string | null;
  walk_in_phone: string | null;
  source: string | null;
}

export interface FlatSortableGroup {
  lead: FlatSortableRow;
}

// Which of the four loaders/sections a group came from — shown as a badge
// in the flat view, where all four sections are mixed into one table.
export type BucketKey = "pending" | "walkin" | "today" | "upcoming";

export const BUCKET_LABEL: Record<BucketKey, string> = {
  pending: "Pending callback",
  walkin: "No set time",
  today: "Today",
  upcoming: "Upcoming",
};

export const BUCKET_STYLE: Record<BucketKey, string> = {
  pending: "bg-amber-100 text-amber-900",
  walkin: "bg-sky-100 text-sky-900",
  today: "bg-emerald-100 text-emerald-900",
  upcoming: "bg-violet-100 text-violet-900",
};

export function tagBucket<G extends FlatSortableGroup>(
  groups: readonly G[],
  bucket: BucketKey,
): (G & { bucket: BucketKey })[] {
  return groups.map((g) => ({ ...g, bucket }));
}

/**
 * A combined name+id+phone haystack for the "person" search box — covers
 * BOTH a linked patient (name, DRM-ID, phone) and a walk-in (name, phone).
 *
 * This is the part of "search by name, DRM-ID or phone" that runs AFTER the
 * appointments are fetched, not as a database filter: PostgREST can't ILIKE
 * across an *embedded* resource (the `patients` join here) without turning
 * it into an inner join — which would silently drop every walk-in row, since
 * a walk-in has no patient to join to. It is applied to the complete,
 * already-fully-loaded row set the grouped view itself renders (see
 * `loadScheduledRange` / `loadOpenWalkIns` / `loadPendingCallback` in
 * page.tsx, all paged with `fetchAllRows` up to `REPORT_EXPORT_MAX_ROWS`),
 * so it cannot miss a match the grouped view would have shown — but it also
 * can't reach further than what those loaders already cover (older,
 * cancelled, or completed appointments), which the page states in a caption
 * next to the search box.
 */
export function groupHaystack(g: FlatSortableGroup): string {
  const r = g.lead;
  return [r.patient_name, r.patient_drm_id, r.patient_phone, r.walk_in_name, r.walk_in_phone]
    .filter((v): v is string => Boolean(v))
    .join(" ");
}

// Sortable columns for the flat view. Not fed to a PostgREST `.order()` —
// the four sections are already fully materialised in JS by the time the
// flat view runs, so there is nothing left to push down to the database —
// but it still goes through `parseSort`'s allow-list in page.tsx for a
// consistent, validated URL contract with every other staff list page.
export const FLAT_SORTABLE_COLUMNS = ["created_at", "scheduled_at", "patient", "status", "source"] as const;
export type FlatSortColumn = (typeof FLAT_SORTABLE_COLUMNS)[number];

export interface FlatSortSpec {
  key: FlatSortColumn;
  dir: "asc" | "desc";
}

export const FLAT_DEFAULT_SORT: FlatSortSpec = { key: "created_at", dir: "desc" };

/**
 * The "upcoming" loader's default upper bound is 31 days out — enough for
 * the default grouped "what's coming up" view. But a `q` search is a lookup
 * for one specific person (e.g. the 0167 patient-delete blocker's
 * `/staff/appointments?q=<DRM-ID>` link), and a confirmed appointment
 * further out than that still blocks the delete and must be findable
 * through the same link. `null` means "no upper bound" — the caller omits
 * the `.lt("scheduled_at", …)` filter entirely instead of passing this
 * value. The non-search default view is unaffected: `hasQuery` is false
 * only when `q` is absent, never merely because sort/source narrowed the
 * flat view.
 */
export function upcomingRangeToIso(hasQuery: boolean, cappedToIso: string): string | null {
  return hasQuery ? null : cappedToIso;
}

/**
 * Mirrors the `.gte("scheduled_at", fromIso).lt("scheduled_at", toIso)`
 * predicate `loadScheduledRange` (page.tsx) builds from `fromIso`/`toIso` —
 * pure, so the "unbounded on search" behaviour can be proven directly
 * against a `scheduled_at` value, not only against the ISO string
 * `upcomingRangeToIso` returns. ISO 8601 UTC timestamps of the same fixed
 * width (`Date#toISOString()`'s format) compare correctly as strings.
 */
export function withinScheduledRange(
  scheduledAt: string,
  fromIso: string,
  toIso: string | null,
): boolean {
  if (scheduledAt < fromIso) return false;
  if (toIso !== null && scheduledAt >= toIso) return false;
  return true;
}

/**
 * Comparator for the flat view. Always ends in an `id` tie-break — per
 * `fetchAllRows`'s own rule, a total order is what keeps range-style paging
 * (here, an array `.slice()` standing in for `.range()`) from dropping or
 * repeating a row across pages.
 *
 * `scheduled_at` is null for pending-callback and open-walk-in groups; those
 * sink to the bottom regardless of sort direction (matching the NULLS_LAST
 * convention `/staff/patients` uses for its own nullable sort columns),
 * rather than clumping at the top on one of the two directions.
 */
export function compareFlat<G extends FlatSortableGroup>(a: G, b: G, sort: FlatSortSpec): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp = 0;
  switch (sort.key) {
    case "created_at":
      cmp = a.lead.created_at.localeCompare(b.lead.created_at) * dirMul;
      break;
    case "scheduled_at": {
      const av = a.lead.scheduled_at;
      const bv = b.lead.scheduled_at;
      if (av == null && bv != null) return 1;
      if (av != null && bv == null) return -1;
      if (av != null && bv != null) cmp = av.localeCompare(bv) * dirMul;
      break;
    }
    case "patient": {
      const an = (a.lead.patient_name ?? a.lead.walk_in_name ?? "").toLowerCase();
      const bn = (b.lead.patient_name ?? b.lead.walk_in_name ?? "").toLowerCase();
      cmp = an.localeCompare(bn) * dirMul;
      break;
    }
    case "status": {
      const al = appointmentStatusLabel(a.lead.status);
      const bl = appointmentStatusLabel(b.lead.status);
      cmp = al.localeCompare(bl) * dirMul;
      break;
    }
    case "source": {
      // Sorts on the LABEL, matching what the Source column actually
      // prints (incl. "Not recorded" for a null source), same rule as the
      // Status column above.
      const al = appointmentSourceLabel(a.lead.source);
      const bl = appointmentSourceLabel(b.lead.source);
      cmp = al.localeCompare(bl) * dirMul;
      break;
    }
  }
  if (cmp !== 0) return cmp;
  return a.lead.id.localeCompare(b.lead.id);
}
