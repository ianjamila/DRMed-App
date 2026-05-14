"use client";

import { useState, useTransition } from "react";

import { commitRunAction } from "../../actions";

interface Props {
  run: { id: string; cutover_date: string };
  blockers: {
    errors: number;
    unmappedProviders: number;
    unmappedServices: number;
    variancesOver5pct: number;
  };
  onDiscarded: () => void;
  onCommitted: () => void;
}

export function CommitFooter({ run, blockers, onDiscarded, onCommitted }: Props) {
  const [piiAck, setPiiAck] = useState(false);
  const [override, setOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const hasBlockers =
    blockers.errors > 0 ||
    blockers.unmappedProviders > 0 ||
    blockers.unmappedServices > 0;
  const needsOverride =
    blockers.variancesOver5pct > 0 && override.trim().length < 10;
  const disabled = isPending || hasBlockers || !piiAck || needsOverride;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-white border-t shadow-lg">
      <div className="max-w-5xl mx-auto px-4 py-4 sm:px-8 space-y-3">
        {blockers.variancesOver5pct > 0 && (
          <div>
            <label
              htmlFor="override-reason"
              className="block text-sm font-medium mb-1"
            >
              Override reason for variances &gt; 5% (required, ≥ 10 chars)
            </label>
            <textarea
              id="override-reason"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              rows={2}
              className="w-full rounded-md border px-3 py-2 text-sm"
              placeholder="e.g. workbook aging block is incomplete for May 2026; per-row total is the authoritative figure."
            />
          </div>
        )}

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={piiAck}
            onChange={(e) => setPiiAck(e.target.checked)}
            className="mt-1"
          />
          <span>
            I confirm we hold these patient names as part of our legitimate
            business records under RA 10173 and have a legal basis to retain them
            after import.
          </span>
        </label>

        {error && (
          <div role="alert" className="text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {hasBlockers
              ? `Blocked: ${blockers.errors} error(s), ${blockers.unmappedProviders} unmapped provider(s), ${blockers.unmappedServices} unmapped service(s).`
              : "Ready to commit."}{" "}
            Cutover: <strong>{run.cutover_date}</strong>.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onDiscarded}
              className="rounded-md border px-4 py-2 text-sm min-h-[44px]"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const res = await commitRunAction({
                    run_id: run.id,
                    variance_override_reason: override.trim() || undefined,
                    pii_ack: true,
                  });
                  if (!res.ok) setError(res.error);
                  else onCommitted();
                });
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40 min-h-[44px]"
            >
              {isPending ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
