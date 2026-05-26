"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createSendOutTrueup } from "@/lib/actions/accounting/cogs-send-out-trueups";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceInfo = { id: string; code: string; name: string } | null;
type VendorInfo = { id: string; name: string } | null;

type AccruedEntry = {
  id: string;
  accrued_at: string;
  unit_cost_php: number;
  test_request_id: string;
  service_id: string | null;
  vendor_id: string | null;
  services: ServiceInfo | ServiceInfo[];
  vendors: VendorInfo | VendorInfo[];
};

type TrueupRow = {
  id: string;
  vendor_id: string;
  bill_id: string | null;
  period_start_date: string;
  period_end_date: string;
  accrued_total_php: number;
  billed_total_php: number;
  variance_php: number;
  matched_at: string;
  voided_at: string | null;
  journal_entry_id: string | null;
  vendors: VendorInfo | VendorInfo[];
};

type VendorOption = { id: string; name: string };

type Tab = "accrued" | "trueups";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
});

function ageBucket(
  accruedAt: string,
  nowMs: number
): "0_30" | "31_60" | "61_90" | "90_plus" {
  const days = (nowMs - new Date(accruedAt).getTime()) / 86_400_000;
  if (days < 31) return "0_30";
  if (days < 61) return "31_60";
  if (days < 91) return "61_90";
  return "90_plus";
}

function getVendorName(v: VendorInfo | VendorInfo[] | null): string {
  if (!v) return "(no vendor)";
  if (Array.isArray(v)) return v[0]?.name ?? "(no vendor)";
  return v.name;
}

function getServiceCode(s: ServiceInfo | ServiceInfo[] | null): string {
  if (!s) return "—";
  if (Array.isArray(s)) return s[0]?.code ?? "—";
  return s.code;
}

function getServiceName(s: ServiceInfo | ServiceInfo[] | null): string {
  if (!s) return "—";
  if (Array.isArray(s)) return s[0]?.name ?? "—";
  return s.name;
}

// ---------------------------------------------------------------------------
// Root client component
// ---------------------------------------------------------------------------

export function SendOutsClient(props: {
  accrued: AccruedEntry[];
  trueups: TrueupRow[];
  /** Active vendors — reserved for future vendor-picker extension */
  vendors: VendorOption[];
  nowIso: string;
}) {
  const { accrued, trueups, nowIso } = props;
  const [tab, setTab] = useState<Tab>("accrued");

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "accrued", label: "Accrued", count: accrued.length },
    { key: "trueups", label: "True-ups", count: trueups.length },
  ];

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-[color:var(--color-brand-border)]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              "px-4 py-2 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-b-2 border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)]"
                : "text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]",
            ].join(" ")}
          >
            {t.label}{" "}
            <span className="ml-1 rounded-full bg-[color:var(--color-brand-bg)] px-1.5 py-0.5 text-xs">
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {tab === "accrued" && (
        <AccruedTab entries={accrued} nowIso={nowIso} />
      )}
      {tab === "trueups" && <TrueupsTab trueups={trueups} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor-grouped accrued entries
// ---------------------------------------------------------------------------

type VendorGroup = {
  vendorName: string;
  entries: AccruedEntry[];
  total: number;
};

function AccruedTab({
  entries,
  nowIso,
}: {
  entries: AccruedEntry[];
  nowIso: string;
}) {
  const [matchVendorId, setMatchVendorId] = useState<string | null>(null);
  const nowMs = new Date(nowIso).getTime();

  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No accrued send-out costs.
      </div>
    );
  }

  // Group by vendor_id
  const byVendor = new Map<string, VendorGroup>();
  for (const e of entries) {
    const vid = e.vendor_id ?? "unassigned";
    if (!byVendor.has(vid)) {
      byVendor.set(vid, {
        vendorName: getVendorName(e.vendors),
        entries: [],
        total: 0,
      });
    }
    const g = byVendor.get(vid)!;
    g.entries.push(e);
    g.total += Number(e.unit_cost_php);
  }

  const matchGroup = matchVendorId ? byVendor.get(matchVendorId) : undefined;

  return (
    <div className="space-y-4">
      {Array.from(byVendor.entries()).map(([vid, g]) => (
        <div
          key={vid}
          className="rounded-md border border-[color:var(--color-brand-border)] overflow-hidden"
        >
          {/* Vendor header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[color:var(--color-brand-bg)]">
            <span className="font-semibold text-sm">{g.vendorName}</span>
            <div className="flex items-center gap-3">
              <span className="text-sm font-mono">{PHP.format(g.total)}</span>
              {vid !== "unassigned" && (
                <button
                  onClick={() => setMatchVendorId(vid)}
                  className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1 text-xs font-semibold text-white hover:bg-[color:var(--color-brand-cyan)] transition-colors"
                >
                  Match to Hi Precision bill
                </button>
              )}
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-[color:var(--color-brand-border)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Code</th>
                  <th className="px-4 py-2 text-left font-medium">Service</th>
                  <th className="px-4 py-2 text-left font-medium">Accrued date</th>
                  <th className="px-4 py-2 text-left font-medium">Age</th>
                  <th className="px-4 py-2 text-right font-medium">Unit cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-border)]">
                {g.entries.map((e) => {
                  const bucket = ageBucket(e.accrued_at, nowMs);
                  const isZeroCost = Number(e.unit_cost_php) === 0;
                  const rowClass = isZeroCost
                    ? "bg-red-50"
                    : bucket === "90_plus"
                      ? "bg-yellow-50"
                      : "";
                  return (
                    <tr key={e.id} className={rowClass}>
                      <td className="px-4 py-2 font-mono text-xs">
                        {getServiceCode(e.services)}
                      </td>
                      <td className="px-4 py-2">
                        {getServiceName(e.services)}
                      </td>
                      <td className="px-4 py-2 text-[color:var(--color-brand-text-soft)]">
                        {e.accrued_at.slice(0, 10)}
                      </td>
                      <td
                        className={`px-4 py-2 text-xs font-medium ${
                          bucket === "90_plus"
                            ? "text-yellow-700"
                            : bucket === "61_90"
                              ? "text-orange-600"
                              : "text-[color:var(--color-brand-text-soft)]"
                        }`}
                      >
                        {bucket.replace("_", "–")}d
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {isZeroCost ? (
                          <span
                            title="Will reconcile at next bill true-up if unit_cost was missing; otherwise update service configuration."
                            className="cursor-help rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
                          >
                            missing
                          </span>
                        ) : (
                          PHP.format(Number(e.unit_cost_php))
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden divide-y divide-[color:var(--color-brand-border)]">
            {g.entries.map((e) => {
              const bucket = ageBucket(e.accrued_at, nowMs);
              const isZeroCost = Number(e.unit_cost_php) === 0;
              const cardClass = isZeroCost
                ? "bg-red-50"
                : bucket === "90_plus"
                  ? "bg-yellow-50"
                  : "";
              return (
                <div key={e.id} className={`px-4 py-3 space-y-1 ${cardClass}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-mono font-semibold">
                        {getServiceCode(e.services)}
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {getServiceName(e.services)}
                      </p>
                    </div>
                    <div className="text-right">
                      {isZeroCost ? (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                          missing
                        </span>
                      ) : (
                        <span className="font-mono text-xs">
                          {PHP.format(Number(e.unit_cost_php))}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {e.accrued_at.slice(0, 10)} · {bucket.replace("_", "–")}d
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {matchVendorId && matchGroup && (
        <NewTrueupDialog
          vendorId={matchVendorId}
          vendorName={matchGroup.vendorName}
          accruedEntries={matchGroup.entries}
          onClose={() => setMatchVendorId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// True-ups tab
// ---------------------------------------------------------------------------

function TrueupsTab({ trueups }: { trueups: TrueupRow[] }) {
  if (trueups.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No true-ups yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
      <table className="w-full text-sm md:min-w-[700px]">
        <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Date</th>
            <th className="px-4 py-3 text-left font-medium">Vendor</th>
            <th className="px-4 py-3 text-left font-medium">Period</th>
            <th className="px-4 py-3 text-right font-medium">Accrued</th>
            <th className="px-4 py-3 text-right font-medium">Billed</th>
            <th className="px-4 py-3 text-right font-medium">Variance</th>
            <th className="px-4 py-3 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-border)]">
          {trueups.map((t) => {
            const isVoided = !!t.voided_at;
            const vendorName = getVendorName(t.vendors);
            const variance = Number(t.variance_php);

            return (
              <tr
                key={t.id}
                className={`hover:bg-[color:var(--color-brand-bg)]/50 ${
                  isVoided ? "opacity-50" : ""
                }`}
              >
                <td
                  className={`px-4 py-3 text-[color:var(--color-brand-text-soft)] ${
                    isVoided ? "line-through" : ""
                  }`}
                >
                  {t.matched_at.slice(0, 10)}
                </td>
                <td
                  className={`px-4 py-3 ${isVoided ? "line-through" : ""}`}
                >
                  {vendorName}
                </td>
                <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                  {t.period_start_date} → {t.period_end_date}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {PHP.format(Number(t.accrued_total_php))}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {PHP.format(Number(t.billed_total_php))}
                </td>
                <td
                  className={`px-4 py-3 text-right font-mono font-semibold ${
                    variance === 0
                      ? "text-[color:var(--color-brand-text-soft)]"
                      : variance > 0
                        ? "text-orange-600"
                        : "text-[color:var(--color-brand-cyan)]"
                  }`}
                >
                  {PHP.format(variance)}
                </td>
                <td className="px-4 py-3 text-right">
                  {t.journal_entry_id && (
                    <Link
                      href={`/staff/admin/accounting/journal/${t.journal_entry_id}`}
                      className="text-xs text-[color:var(--color-brand-cyan)] hover:underline font-medium"
                    >
                      JE
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New trueup dialog
// ---------------------------------------------------------------------------

function NewTrueupDialog({
  vendorId,
  vendorName,
  accruedEntries,
  onClose,
}: {
  vendorId: string;
  vendorName: string;
  accruedEntries: AccruedEntry[];
  onClose: () => void;
}) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [billedTotal, setBilledTotal] = useState("");
  const [billId, setBillId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Client-side preview: sum entries within selected period
  const accruedPreview =
    periodStart && periodEnd
      ? accruedEntries
          .filter((e) => {
            const d = e.accrued_at.slice(0, 10);
            return d >= periodStart && d <= periodEnd;
          })
          .reduce((s, e) => s + Number(e.unit_cost_php), 0)
      : 0;

  const billedNum = Number(billedTotal || 0);
  const variancePreview = billedNum - accruedPreview;

  // Optional bill_id must be a valid UUID if provided, otherwise the action's
  // bill-belongs-to-vendor check surfaces a misleading error.
  const billIdTrimmed = billId.trim();
  const billIdLooksValid =
    billIdTrimmed === "" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(billIdTrimmed);

  const canSubmit =
    !submitting &&
    periodStart !== "" &&
    periodEnd !== "" &&
    billedTotal !== "" &&
    billIdLooksValid;

  async function handleSubmit() {
    setSubmitting(true);
    setErr(null);
    const res = await createSendOutTrueup({
      vendor_id: vendorId,
      bill_id: billId.trim() || undefined,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      billed_total_php: billedNum,
    });
    setSubmitting(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    onClose();
    window.location.reload();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New send-out true-up — {vendorName}</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Period start
            </label>
            <input
              type="date"
              name="period_start"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Period end
            </label>
            <input
              type="date"
              name="period_end"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Billed total (PHP, from invoice)
            </label>
            <input
              type="number"
              step="0.01"
              name="billed_total"
              value={billedTotal}
              onChange={(e) => setBilledTotal(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Linked AP bill (optional — paste UUID)
            </label>
            <input
              name="bill_id"
              value={billId}
              onChange={(e) => setBillId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]"
            />
          </div>

          {/* Client-side preview */}
          {periodStart && periodEnd && (
            <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-[color:var(--color-brand-text-soft)]">
                  Accrued in period
                </span>
                <span className="font-mono">{PHP.format(accruedPreview)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[color:var(--color-brand-text-soft)]">
                  Billed
                </span>
                <span className="font-mono">{PHP.format(billedNum)}</span>
              </div>
              <div className="flex justify-between border-t border-[color:var(--color-brand-border)] pt-1 font-semibold">
                <span>Variance</span>
                <span
                  className={`font-mono ${
                    variancePreview === 0
                      ? ""
                      : variancePreview > 0
                        ? "text-orange-600"
                        : "text-[color:var(--color-brand-cyan)]"
                  }`}
                >
                  {PHP.format(variancePreview)}
                </span>
              </div>
              <p className="pt-1 text-[11px] text-[color:var(--color-brand-text-soft)]">
                Preview only — final variance is recomputed server-side on submit.
              </p>
            </div>
          )}

          {!billIdLooksValid && (
            <p className="text-xs text-red-600">
              Bill ID must be a valid UUID (or leave blank).
            </p>
          )}

          {err && (
            <p className="text-sm text-red-600 rounded-md bg-red-50 border border-red-200 px-3 py-2">
              {err}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-[color:var(--color-brand-border)] hover:bg-[color:var(--color-brand-bg)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)] transition-colors disabled:opacity-60"
            >
              {submitting ? "Posting…" : "Post true-up"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
