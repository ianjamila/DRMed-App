"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateCashAdjustmentRoutingAction,
  updateDefaultChangeFundAction,
} from "./actions";

type RoutingMap = { id: string; kind: string; account_id: string; requires_user_choice: boolean; notes: string | null; updated_at: string };
type Account = { id: string; code: string; name: string; type: string };

export function CashRoutingClient(props: { maps: RoutingMap[]; accounts: Account[]; defaultChangeFund: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fund, setFund] = useState(String(props.defaultChangeFund));
  const [err, setErr] = useState<string | null>(null);

  const updateRow = (kind: string, account_id: string, requires_user_choice: boolean, notes: string | null) => {
    setErr(null);
    start(async () => {
      const r = await updateCashAdjustmentRoutingAction({ kind, account_id, requires_user_choice, notes });
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  };

  const saveFund = () => {
    setErr(null);
    start(async () => {
      const r = await updateDefaultChangeFundAction(Number(fund));
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  };

  return (
    <>
      <section className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
        <h2 className="font-semibold text-[color:var(--color-brand-navy)]">Default change fund</h2>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">Baseline opening float per business date.</p>
        <div className="mt-2 flex gap-2">
          <input value={fund} onChange={(e) => setFund(e.target.value)} inputMode="decimal" className="rounded border px-2 py-2" />
          <button onClick={saveFund} disabled={pending} className="min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Save
          </button>
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="bg-[color:var(--color-bg-mid)] text-left">
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Contra account</th>
              <th className="px-3 py-2">Requires user choice</th>
              <th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {props.maps.map((m) => (
              <RoutingRow key={m.kind} m={m} accounts={props.accounts} pending={pending} onSave={updateRow} />
            ))}
          </tbody>
        </table>
      </section>
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
    </>
  );
}

function RoutingRow(props: {
  m: RoutingMap;
  accounts: Account[];
  pending: boolean;
  onSave: (kind: string, account_id: string, requires_user_choice: boolean, notes: string | null) => void;
}) {
  const [acct, setAcct] = useState(props.m.account_id);
  const [req, setReq] = useState(props.m.requires_user_choice);
  const [notes, setNotes] = useState(props.m.notes ?? "");
  const dirty = acct !== props.m.account_id || req !== props.m.requires_user_choice || notes !== (props.m.notes ?? "");
  return (
    <tr className="border-t">
      <td className="px-3 py-2 font-mono">{props.m.kind}</td>
      <td className="px-3 py-2">
        <select value={acct} onChange={(e) => setAcct(e.target.value)} className="rounded border px-2 py-1">
          {props.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
        </select>
      </td>
      <td className="px-3 py-2 text-center">
        <input type="checkbox" checked={req} onChange={(e) => setReq(e.target.checked)} />
      </td>
      <td className="px-3 py-2">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded border px-2 py-1" />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          disabled={!dirty || props.pending}
          onClick={() => props.onSave(props.m.kind, acct, req, notes || null)}
          className="min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Save
        </button>
      </td>
    </tr>
  );
}
