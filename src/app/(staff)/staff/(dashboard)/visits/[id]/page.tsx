import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { ReleaseButton } from "./release-button";

export const metadata = {
  title: "Visit — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

const PAYMENT_STATUS_STYLE: Record<string, string> = {
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-slate-200 text-slate-800",
};

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  result_uploaded: "bg-amber-100 text-amber-900",
  ready_for_release: "bg-emerald-100 text-emerald-900",
  released: "bg-[color:var(--color-brand-navy)] text-white",
  cancelled: "bg-red-100 text-red-900",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
  bank_transfer: "Bank transfer",
};

export default async function VisitDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status,
        total_php, paid_php, notes, created_at,
        patients!inner ( id, drm_id, first_name, last_name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!visit) notFound();
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();

  const [{ data: tests }, { data: payments }] = await Promise.all([
    supabase
      .from("test_requests")
      .select(
        `
          id, status, requested_at, completed_at, released_at,
          services!inner ( id, code, name, price_php )
        `,
      )
      .eq("visit_id", id)
      .order("requested_at", { ascending: true }),
    supabase
      .from("payments")
      .select("id, amount_php, method, reference_number, received_at, notes")
      .eq("visit_id", id)
      .order("received_at", { ascending: false }),
  ]);

  const isPaid = visit.payment_status === "paid" || visit.payment_status === "waived";
  const balance = Number(visit.total_php) - Number(visit.paid_php);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {patient.last_name}, {patient.first_name} ({patient.drm_id})
      </Link>

      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
            Visit #{visit.visit_number} ·{" "}
            {new Date(visit.visit_date).toLocaleDateString("en-PH")}
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/staff/visits/${visit.id}/receipt`}
            className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
          >
            Receipt
          </Link>
          <Link
            href={`/staff/payments/new?visit_id=${visit.id}`}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Record payment
          </Link>
        </div>
      </header>

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-4">
        <Field label="Total" value={formatPhp(visit.total_php)} />
        <Field label="Paid" value={formatPhp(visit.paid_php)} />
        <Field
          label="Balance"
          value={formatPhp(balance > 0 ? balance : 0)}
          highlight={balance > 0}
        />
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Status
          </p>
          <p className="mt-1">
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                PAYMENT_STATUS_STYLE[visit.payment_status] ?? ""
              }`}
            >
              {visit.payment_status}
            </span>
          </p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Tests
        </h2>
        <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(tests ?? []).map((t) => {
                const svc = Array.isArray(t.services) ? t.services[0] : t.services;
                if (!svc) return null;
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 font-mono text-[color:var(--color-brand-text-mid)]">
                      {svc.code}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-navy)]">
                      {svc.name}
                    </td>
                    <td className="px-4 py-3">{formatPhp(svc.price_php)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[t.status] ?? ""
                        }`}
                      >
                        {t.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <TestAction
                        status={t.status}
                        testRequestId={t.id}
                        visitId={visit.id}
                        paid={isPaid}
                      />
                    </td>
                  </tr>
                );
              })}
              {(tests ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No tests on this visit yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {!isPaid ? (
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            ℹ️ Releases are blocked until visit payment status is paid or
            waived. The payment-gating trigger enforces this at the database
            level.
          </p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Payments
        </h2>
        <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(payments ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {new Date(p.received_at).toLocaleString("en-PH")}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {formatPhp(p.amount_php)}
                  </td>
                  <td className="px-4 py-3">
                    {p.method ? PAYMENT_METHOD_LABEL[p.method] ?? p.method : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {p.reference_number ?? "—"}
                  </td>
                </tr>
              ))}
              {(payments ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No payments yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {visit.notes ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 text-sm">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Visit notes
          </p>
          <p className="mt-2 whitespace-pre-wrap text-[color:var(--color-brand-text-mid)]">
            {visit.notes}
          </p>
        </section>
      ) : null}

      <Link
        href={`/staff/patients/${patient.id}`}
        className="mt-8 inline-block rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
      >
        Back to patient
      </Link>
    </div>
  );
}

function Field({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold ${
          highlight ? "text-red-600" : "text-[color:var(--color-brand-navy)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

interface TestActionProps {
  status: string;
  testRequestId: string;
  visitId: string;
  paid: boolean;
}

// Renders a context-appropriate cell for the Action column on the visit
// detail tests table. Tells the receptionist what's blocking each test and
// where to go next.
function TestAction({ status, testRequestId, visitId, paid }: TestActionProps) {
  if (status === "ready_for_release") {
    return (
      <ReleaseButton
        testRequestId={testRequestId}
        visitId={visitId}
        paid={paid}
      />
    );
  }

  if (status === "requested" || status === "in_progress") {
    const hint = status === "requested" ? "Awaiting claim" : "Awaiting result";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </span>
        <Link
          href={`/staff/queue/${testRequestId}`}
          className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Open in queue →
        </Link>
      </div>
    );
  }

  if (status === "result_uploaded") {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
        Awaiting sign-off
      </span>
    );
  }

  if (status === "released") {
    return (
      <span className="text-xs font-semibold text-emerald-700">
        Released ✓
      </span>
    );
  }

  if (status === "cancelled") {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
        —
      </span>
    );
  }

  return null;
}
