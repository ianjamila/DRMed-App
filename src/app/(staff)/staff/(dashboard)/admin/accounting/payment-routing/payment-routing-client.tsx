"use client";

import { useState, useTransition } from "react";
import { updatePaymentMethodMapAction } from "./actions";

interface MapRow {
  id: string;
  payment_method: string;
  account_id: string;
  notes: string | null;
  updated_at: string;
}

interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export function PaymentRoutingClient({
  maps,
  accounts,
}: {
  maps: MapRow[];
  accounts: AccountOption[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3">Payment method</th>
            <th className="px-4 py-3">Routes to (CoA)</th>
            <th className="px-4 py-3">Notes</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {maps.map((m) => (
            <Row key={m.id} row={m} accounts={accounts} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, accounts }: { row: MapRow; accounts: AccountOption[] }) {
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState(row.account_id);
  const [notes, setNotes] = useState(row.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      setErr(null);
      const result = await updatePaymentMethodMapAction(
        row.id,
        accountId,
        notes.trim() || null,
      );
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setEditing(false);
    });
  }

  const currentAccount = accounts.find((a) => a.id === accountId);

  return (
    <tr className="border-t border-[color:var(--color-brand-bg-mid)]">
      <td className="px-4 py-3 font-mono text-xs">{row.payment_method}</td>
      <td className="px-4 py-3">
        {editing ? (
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name} ({a.type})
              </option>
            ))}
          </select>
        ) : currentAccount ? (
          <span>
            <span className="font-mono text-xs">{currentAccount.code}</span> · {currentAccount.name}
          </span>
        ) : (
          <span className="text-red-600">Account not found</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {editing ? (
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
          />
        ) : (
          <span className="text-[color:var(--color-brand-text-soft)]">{row.notes ?? "—"}</span>
        )}
        {err ? <div className="mt-1 text-red-600">{err}</div> : null}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={pending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setAccountId(row.account_id);
                setNotes(row.notes ?? "");
                setErr(null);
              }}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}
