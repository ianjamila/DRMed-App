"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createClaimBatchAction,
  addItemsToBatchAction,
} from "../../actions";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

type UnbilledRow = {
  test_request_id: string;
  released_at: string;
  billed_amount_php: number;
  days_since_release: number;
  past_threshold: boolean;
};

export function NewBatchClient({
  providers,
  initialProviderId,
  unbilled,
  preselectedIds,
  addToBatch = null,
}: {
  providers: { id: string; name: string }[];
  initialProviderId: string;
  unbilled: UnbilledRow[];
  preselectedIds: string[];
  addToBatch?: string | null;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(initialProviderId);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectedIds),
  );
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isAddMode = Boolean(addToBatch);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onProviderChange(newId: string) {
    // Provider switching is locked while adding to an existing batch.
    if (isAddMode) return;
    setProviderId(newId);
    setSelected(new Set());
    router.push(
      `/staff/admin/accounting/hmo-claims/batches/new?providerId=${newId}`,
    );
  }

  function onSave() {
    if (selected.size < 1) {
      setErr("Pick at least one item.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      if (isAddMode && addToBatch) {
        const res = await addItemsToBatchAction({
          batch_id: addToBatch,
          test_request_ids: Array.from(selected),
        });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        router.push(
          `/staff/admin/accounting/hmo-claims/batches/${addToBatch}`,
        );
        return;
      }
      const res = await createClaimBatchAction({
        provider_id: providerId,
        test_request_ids: Array.from(selected),
      });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      if (res.data) {
        router.push(
          `/staff/admin/accounting/hmo-claims/batches/${res.data.batch_id}`,
        );
      }
    });
  }

  const total = unbilled
    .filter((r) => selected.has(r.test_request_id))
    .reduce((a, r) => a + Number(r.billed_amount_php), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={
            isAddMode && addToBatch
              ? `/staff/admin/accounting/hmo-claims/batches/${addToBatch}`
              : "/staff/admin/accounting/hmo-claims"
          }
          className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          {isAddMode ? "← Back to batch" : "← Back to HMO claims"}
        </Link>
      </div>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Provider
          {isAddMode ? (
            <span className="ml-2 text-xs font-normal text-[color:var(--color-brand-text-soft)]">
              (locked — must match the existing batch)
            </span>
          ) : null}
        </span>
        <select
          value={providerId}
          onChange={(e) => onProviderChange(e.target.value)}
          disabled={isAddMode}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm disabled:opacity-60"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {unbilled.length === 0 ? (
        <p className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm text-[color:var(--color-brand-text-soft)]">
          No unbilled items for this provider.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3"></th>
                <th className="px-4 py-3">Released</th>
                <th className="px-4 py-3 text-right">Age (days)</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {unbilled.map((r) => {
                const isChecked = selected.has(r.test_request_id);
                return (
                  <tr
                    key={r.test_request_id}
                    className={
                      "border-t border-[color:var(--color-brand-bg-mid)] " +
                      (r.past_threshold ? "bg-amber-50" : "")
                    }
                  >
                    <td className="px-4 py-3">
                      <label className="inline-flex min-h-[44px] items-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(r.test_request_id)}
                          aria-label={`Select item ${r.test_request_id}`}
                          className="h-5 w-5"
                        />
                      </label>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {new Date(r.released_at).toLocaleDateString("en-PH")}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {r.days_since_release}
                      {r.past_threshold ? " ⚠" : ""}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {PHP.format(r.billed_amount_php)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm">
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {selected.size}
          </span>{" "}
          selected · total{" "}
          <span className="font-mono font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(total)}
          </span>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={pending || selected.size < 1}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending
            ? "Saving…"
            : isAddMode
              ? `Add ${selected.size} item${selected.size === 1 ? "" : "s"} to batch`
              : "Create draft batch"}
        </button>
      </div>
      {err ? (
        <p role="alert" className="text-sm text-red-700">
          {err}
        </p>
      ) : null}
    </div>
  );
}
