import { manilaDateTime } from "@/lib/dates/manila";
import type { AmendmentChanges } from "@/lib/results/version-diff";

/**
 * Staff-only "What changed" panel: one block per correction to a structured
 * result, newest first — what a parameter read before vs. after, and the
 * flag when it moved too. Renders nothing when there is nothing to show
 * (amendment_count = 0, or RLS returned an empty read for an out-of-section
 * or reception viewer — see version-diff.server.ts).
 */
export function ResultChanges({ amendments }: { amendments: readonly AmendmentChanges[] }) {
  if (amendments.length === 0) return null;
  return (
    <details className="mt-5 rounded-xl border border-[color:var(--color-brand-bg-mid)] px-4 py-3">
      <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        What changed
      </summary>
      <div className="mt-3 space-y-4">
        {amendments.map((a) => (
          <div key={a.amendmentId}>
            <p className="text-xs font-bold text-[color:var(--color-brand-navy)]">
              v{a.fromVersion} → v{a.toVersion} · {manilaDateTime(a.amendedAt)}
            </p>
            {!a.structured ? (
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                File replaced; values unchanged.
              </p>
            ) : a.changes.length === 0 ? (
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">Values unchanged.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-xs">
                {a.changes.map((c) => (
                  <li key={c.parameterId} className="text-[color:var(--color-brand-text-mid)]">
                    <span className="font-semibold text-[color:var(--color-brand-navy)]">{c.name}:</span>{" "}
                    {c.before} → {c.after}
                    {c.flagBefore !== c.flagAfter ? (
                      <span className="ml-1 text-[color:var(--color-brand-text-soft)]">
                        (flag {c.flagBefore ?? "—"} → {c.flagAfter ?? "—"})
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
