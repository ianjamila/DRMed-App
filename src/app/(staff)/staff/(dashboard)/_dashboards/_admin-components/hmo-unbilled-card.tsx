"use client";

// Admin-only card: replaces the old hardcoded-90-day "HMO unbilled aged 90+"
// tile with a client toggle over three age bands computed server-side from a
// single `v_hmo_unbilled` fetch (see hmo-unbilled-bands.ts, shared with the
// HMO claims page's "All unbilled" tab so the arithmetic can't drift). Kept
// out of the shared `_components/` dashboard folder — it's admin-only and
// StatCard there has no toggle slot to extend.

import { useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  HMO_UNBILLED_AGE_BANDS,
  HMO_UNBILLED_AGE_BAND_SHORT_LABELS,
  isHmoUnbilledAgeBand,
  type HmoUnbilledAgeBand,
} from "@/lib/reports/hmo-unbilled-bands";
import { formatPeso } from "../_components/format";

const STORAGE_KEY = "drmed.admin.hmoUnbilledBand";

interface BandStats {
  count: number;
  total: number;
}

interface Props {
  stats: Record<HmoUnbilledAgeBand, BandStats>;
  truncated: boolean;
  error: boolean;
}

// `useSyncExternalStore` (not setState-in-effect) is this repo's SSR-safe
// way to read a localStorage-backed preference — see
// admin/payroll/runs/[id]/run-review-client.tsx's drawer-style hook, the
// same pattern.
function subscribeToStorage(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function readStoredBand(): HmoUnbilledAgeBand {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isHmoUnbilledAgeBand(raw)) return raw;
  } catch {
    // Private browsing / storage blocked.
  }
  return "threshold";
}

// During SSR there is no localStorage; the snapshot returns the default.
function getServerBand(): HmoUnbilledAgeBand {
  return "threshold";
}

export function HmoUnbilledCard({ stats, truncated, error }: Props) {
  const band = useSyncExternalStore(subscribeToStorage, readStoredBand, getServerBand);

  const choose = useCallback((next: HmoUnbilledAgeBand) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      // Fire a same-tab storage event so useSyncExternalStore re-reads —
      // the native `storage` event only fires in OTHER tabs.
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: next }));
    } catch {
      // Best-effort only.
    }
  }, []);

  const accentBar = error
    ? "before:bg-amber-500"
    : stats[band].count > 0
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";

  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accentBar}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          HMO unbilled
        </p>
        <div
          className="inline-flex shrink-0 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-0.5"
          role="tablist"
          aria-label="Unbilled age band"
        >
          {HMO_UNBILLED_AGE_BANDS.map((b) => (
            <button
              key={b}
              type="button"
              role="tab"
              aria-selected={band === b}
              onClick={() => choose(b)}
              className={
                "min-h-[24px] rounded px-1.5 text-[10px] font-bold uppercase tracking-wider " +
                (band === b
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "text-[color:var(--color-brand-text-soft)]")
              }
            >
              {HMO_UNBILLED_AGE_BAND_SHORT_LABELS[b]}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <>
          <p className="mt-2 font-heading text-2xl font-extrabold text-amber-700">
            Couldn&apos;t load
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            Reload the page — this figure is not zero, it is unknown.
          </p>
        </>
      ) : (
        <Link
          href={`/staff/admin/accounting/hmo-claims?age=${band}`}
          className="mt-2 block rounded-md -m-1 p-1 transition-colors hover:bg-[color:var(--color-brand-bg)]"
        >
          <p className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {formatPeso(stats[band].total)}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {truncated
              ? `${stats[band].count}+ item${stats[band].count === 1 ? "" : "s"} — capped at ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows, true total is higher`
              : `${stats[band].count} item${stats[band].count === 1 ? "" : "s"} unbilled`}
          </p>
        </Link>
      )}
    </article>
  );
}
