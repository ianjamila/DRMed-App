"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closeEodAction } from "../cash-drawer/actions";
import { reopenEodCloseAction } from "@/app/(staff)/staff/(dashboard)/admin/accounting/cash-routing/actions";
import { PaymentsTabs } from "../_components/payments-tabs";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const formatBusinessDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00+08:00`);
  const longDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(d);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "Asia/Manila",
  }).format(d);
  return `${longDate} · ${weekday}`;
};

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
    const reopen = window.prompt("Why are you re-opening this day?");
    if (!reopen) return;
    start(async () => {
      const r = await reopenEodCloseAction(closed.id, reopen);
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <PaymentsTabs />
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        Close &amp; count cash · {formatBusinessDate(props.businessDate)}
      </h1>

      {closed ? (
        <section className="mt-5 rounded-lg border bg-green-50 p-4">
          <p className="text-sm font-semibold text-green-800">
            ✓ Day closed at {new Date(closed.closed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt>Cash you should have</dt><dd className="font-mono text-right">{PESO(closed.expected_cash_php)}</dd>
            <dt>Cash counted</dt><dd className="font-mono text-right">{PESO(closed.counted_cash_php)}</dd>
            <dt>Difference (over / short)</dt><dd className="font-mono text-right">{PESO(closed.variance_php)}</dd>
          </dl>
          {closed.variance_reason && (
            <p className="mt-2 text-sm italic text-[color:var(--color-brand-text-soft)]">&ldquo;{closed.variance_reason}&rdquo;</p>
          )}
          {props.isAdmin && (
            <button onClick={onReopen} disabled={pending} className="mt-4 min-h-[44px] rounded border px-4 py-2 text-sm">
              Re-open this day
            </button>
          )}
        </section>
      ) : (
        <section className="mt-5 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex justify-between text-sm">
            <strong>Cash you should have</strong>
            <span className="font-mono text-lg">{PESO(expected)}</span>
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            = starting cash {PESO(Number(s.opening_float_php ?? 0))} + cash received {PESO(Number(s.cash_payments_php ?? 0))} − cash paid out {PESO(Number(s.cash_payouts_php ?? 0))}
          </p>

          <label className="mt-4 block text-sm">
            Cash you actually counted (₱)
            <input
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="decimal"
              className="mt-1 block w-full rounded border px-2 py-2"
            />
          </label>

          <div className="mt-3 flex justify-between text-sm">
            <strong>Difference (over / short)</strong>
            <span className={"font-mono " + (variance < 0 ? "text-red-600" : variance > 0 ? "text-amber-600" : "")}>
              {PESO(variance)}
            </span>
          </div>

          {variance !== 0 && (
            <label className="mt-3 block text-sm">
              Reason for the difference (required)
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2" />
            </label>
          )}

          {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

          <div className="mt-5 flex flex-wrap gap-2">
            <a href={`/staff/payments/cash-drawer?date=${props.businessDate}&shift=${props.shiftId}`} className="min-h-[44px] rounded border px-4 py-2 text-sm">Back to cash drawer</a>
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
