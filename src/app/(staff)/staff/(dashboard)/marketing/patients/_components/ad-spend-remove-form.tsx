"use client";
import { useActionState, useState } from "react";
import { removeAdSpendAction, type RemoveAdSpendResult } from "../../ad-spend-actions";

export function AdSpendRemoveForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [state, action, pending] = useActionState<RemoveAdSpendResult | null, FormData>(removeAdSpendAction, null);
  const [confirming, setConfirming] = useState(false);
  const [platform, setPlatform] = useState("meta");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  return (
    <form action={action} onSubmit={() => setConfirming(false)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col text-xs font-bold">
        Platform
        <select name="platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="rounded border px-2 py-1 text-sm">
          <option value="meta">Meta (Facebook)</option>
          <option value="google">Google</option>
        </select>
      </label>
      <label className="flex flex-col text-xs font-bold">
        From
        <input type="date" name="from" value={from} onChange={(e) => setFrom(e.target.value)} required className="rounded border px-2 py-1 text-sm" />
      </label>
      <label className="flex flex-col text-xs font-bold">
        To
        <input type="date" name="to" value={to} onChange={(e) => setTo(e.target.value)} required className="rounded border px-2 py-1 text-sm" />
      </label>
      {confirming ? (
        <>
          <span className="text-amber-800">
            Remove all saved {platform === "meta" ? "Meta" : "Google"} spend from {from} to {to}?
          </span>
          <button type="submit" disabled={pending} className="rounded bg-red-700 px-3 py-1.5 text-xs font-bold text-white">
            Yes, remove
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded border px-3 py-1.5 text-xs font-bold">
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="rounded border px-3 py-1.5 text-xs font-bold">
          Remove saved spend…
        </button>
      )}
      {state ? (
        <p className={state.ok ? "w-full text-sm text-emerald-700" : "w-full text-sm text-red-600"} role="status">
          {state.ok ? `Removed ${state.data.deleted} saved row${state.data.deleted === 1 ? "" : "s"}.` : state.error}
        </p>
      ) : null}
    </form>
  );
}
