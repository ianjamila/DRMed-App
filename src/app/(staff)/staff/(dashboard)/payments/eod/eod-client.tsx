"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closeEodAction } from "../cash-drawer/actions";
import { reopenEodCloseAction } from "@/app/(staff)/staff/(dashboard)/admin/accounting/cash-routing/actions";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const weekdayManila = (isoDate: string) =>
  new Intl.DateTimeFormat("en-PH", {
    weekday: "long",
    timeZone: "Asia/Manila",
  }).format(new Date(`${isoDate}T12:00:00+08:00`));

export function EodClient(props: {
  isAdmin: boolean;
  businessDate: string;
  shiftId: string;
  state: Record<string, unknown>;
}) {
  const router = useRouter();
  const s = props.state as {
    opening_float_php?: number;
    cash_payments_php?: number;
    cash_payouts_php?: number;
    expected_cash_php?: number;
    closed?: {
      id: string;
      closed_at: string;
      closed_by: string;
      counted_cash_php: number;
      expected_cash_php: number;
      variance_php: number;
      variance_reason: string | null;
    } | null;
  };
  const expected = Number(s.expected_cash_php ?? 0);
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const closed = s.closed;

  const variance = useMemo(
    () => (counted ? Number(counted) - expected : 0),
    [counted, expected],
  );

  const onClose = () => {
    setErr(null);
    start(async () => {
      const r = await closeEodAction(
        props.businessDate,
        props.shiftId,
        Number(counted),
        variance === 0 ? null : reason,
      );
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  };

  const onReopen = () => {
    if (!closed) return;
    const reopen = window.prompt("Reason for reopening this day?");
    if (!reopen) return;
    start(async () => {
      const r = await reopenEodCloseAction(closed.id, reopen);
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        End-of-day close · {weekdayManila(props.businessDate)}, {props.businessDate}
      </h1>

      {closed ? (
        <section className="mt-5 rounded-lg border bg-green-50 p-4">
          <p className="text-sm font-semibold text-green-800">
            ✓ Closed at {new Date(closed.closed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt>Expected</dt><dd className="font-mono text-right">{PESO(closed.expected_cash_php)}</dd>
            <dt>Counted</dt><dd className="font-mono text-right">{PESO(closed.counted_cash_php)}</dd>
            <dt>Variance</dt><dd className="font-mono text-right">{PESO(closed.variance_php)}</dd>
          </dl>
          {closed.variance_reason && (
            <p className="mt-2 text-sm italic text-[color:var(--color-brand-text-soft)]">&ldquo;{closed.variance_reason}&rdquo;</p>
          )}
          {props.isAdmin && (
            <button onClick={onReopen} disabled={pending} className="mt-4 min-h-[44px] rounded border px-4 py-2 text-sm">
              Reopen day
            </button>
          )}
        </section>
      ) : (
        <section className="mt-5 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex justify-between text-sm">
            <strong>Expected cash</strong>
            <span className="font-mono text-lg">{PESO(expected)}</span>
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            = opening {PESO(Number(s.opening_float_php ?? 0))} + cash in {PESO(Number(s.cash_payments_php ?? 0))} − cash out {PESO(Number(s.cash_payouts_php ?? 0))}
          </p>

          <label className="mt-4 block text-sm">
            Counted cash (PHP)
            <input
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="decimal"
              className="mt-1 block w-full rounded border px-2 py-2"
            />
          </label>

          <div className="mt-3 flex justify-between text-sm">
            <strong>Variance</strong>
            <span className={"font-mono " + (variance < 0 ? "text-red-600" : variance > 0 ? "text-amber-600" : "")}>
              {PESO(variance)}
            </span>
          </div>

          {variance !== 0 && (
            <label className="mt-3 block text-sm">
              Reason (required when variance ≠ 0)
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2" />
            </label>
          )}

          {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

          <div className="mt-5 flex flex-wrap gap-2">
            <a href={`/staff/payments/cash-drawer?date=${props.businessDate}&shift=${props.shiftId}`} className="min-h-[44px] rounded border px-4 py-2 text-sm">Back to drawer</a>
            <button
              onClick={onClose}
              disabled={pending || !counted || (variance !== 0 && !reason)}
              className="min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Closing…" : "Close day"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
