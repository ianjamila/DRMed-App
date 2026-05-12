import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { ReleaseButton } from "./release-button";
import { VoidPaymentDialog } from "../../payments/[id]/void/void-payment-dialog";

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
  hmo: "HMO",
  bpi: "BPI",
  maybank: "Maybank",
};

const DISCOUNT_KIND_LABEL: Record<string, string> = {
  senior_pwd_20: "Sr/PWD",
  pct_10: "10% off",
  pct_5: "5% off",
  other_pct_20: "Other 20%",
  custom: "Custom",
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
        hmo_provider_id, hmo_approval_date, hmo_authorization_no,
        patients!inner ( id, drm_id, first_name, last_name, preferred_release_medium ),
        hmo_providers ( id, name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!visit) notFound();
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();
  const hmo = Array.isArray(visit.hmo_providers)
    ? visit.hmo_providers[0]
    : visit.hmo_providers;

  const [{ data: tests }, { data: payments }] = await Promise.all([
    supabase
      .from("test_requests")
      .select(
        `
          id, status, requested_at, completed_at, released_at, release_medium,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          clinic_fee_php, doctor_pf_php,
          procedure_description, hmo_approved_amount_php,
          services!inner ( id, code, name, kind, price_php )
        `,
      )
      .eq("visit_id", id)
      .order("requested_at", { ascending: true }),
    supabase
      .from("payments")
      .select("id, amount_php, method, reference_number, received_at, notes, voided_at, voided_by, void_reason")
      .eq("visit_id", id)
      .order("received_at", { ascending: false }),
  ]);

  const isPaid = visit.payment_status === "paid" || visit.payment_status === "waived";
  const balance = Number(visit.total_php) - Number(visit.paid_php);
  const activePayments = (payments ?? []).filter((p) => !p.voided_at);
  const voidedPayments = (payments ?? []).filter((p) => p.voided_at);

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

      {hmo ? (
        <section className="mt-6 rounded-xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            HMO authorisation
          </p>
          <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Provider
              </p>
              <p className="font-semibold text-[color:var(--color-brand-navy)]">
                {hmo.name}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Approval date
              </p>
              <p className="text-[color:var(--color-brand-text-mid)]">
                {visit.hmo_approval_date ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Authorization no.
              </p>
              <p className="font-mono text-[color:var(--color-brand-text-mid)]">
                {visit.hmo_authorization_no ?? "—"}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Tests
        </h2>
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3 text-right">Base</th>
                <th className="px-4 py-3 text-right">Discount</th>
                <th className="px-4 py-3 text-right">Final</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(tests ?? []).map((t) => {
                const svc = Array.isArray(t.services) ? t.services[0] : t.services;
                if (!svc) return null;
                // Snapshot fields on the line; fall back to live service price
                // for legacy rows created before P7B.2.
                const base =
                  t.base_price_php != null
                    ? Number(t.base_price_php)
                    : Number(svc.price_php);
                const discount =
                  t.discount_amount_php != null
                    ? Number(t.discount_amount_php)
                    : 0;
                const finalPrice =
                  t.final_price_php != null
                    ? Number(t.final_price_php)
                    : base - discount;
                const discountLabel = t.discount_kind
                  ? DISCOUNT_KIND_LABEL[t.discount_kind] ?? t.discount_kind
                  : null;
                const isConsult = svc.kind === "doctor_consultation";
                const isProcedure = svc.kind === "doctor_procedure";
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3">
                      <p className="text-[color:var(--color-brand-navy)]">
                        {svc.name}
                      </p>
                      <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                        {svc.code}
                        {isConsult ? (
                          <span className="ml-1 rounded bg-[color:var(--color-brand-bg-mid)] px-1 py-0.5 uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                            Doctor
                          </span>
                        ) : null}
                        {isProcedure ? (
                          <span className="ml-1 rounded bg-[color:var(--color-brand-bg-mid)] px-1 py-0.5 uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                            Procedure
                          </span>
                        ) : null}
                      </p>
                      {isConsult && (t.clinic_fee_php != null || t.doctor_pf_php != null) ? (
                        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-soft)]">
                          Clinic fee {formatPhp(Number(t.clinic_fee_php ?? 0))} ·
                          PF {formatPhp(Number(t.doctor_pf_php ?? 0))}
                        </p>
                      ) : null}
                      {isProcedure && t.procedure_description ? (
                        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-mid)]">
                          {t.procedure_description}
                        </p>
                      ) : null}
                      {isProcedure && t.hmo_approved_amount_php != null ? (
                        <p className="mt-0.5 text-[10px] text-[color:var(--color-brand-text-soft)]">
                          HMO approved: {formatPhp(Number(t.hmo_approved_amount_php))}
                        </p>
                      ) : null}
                      {t.release_medium && t.released_at ? (
                        <p className="mt-1 text-[10px] text-emerald-700">
                          Released via {t.release_medium}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatPhp(base)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {discount > 0 ? (
                        <>
                          <span className="text-red-600">
                            −{formatPhp(discount)}
                          </span>
                          {discountLabel ? (
                            <span className="ml-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
                              {discountLabel}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPhp(finalPrice)}
                    </td>
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
                        preferredMedium={
                          (patient.preferred_release_medium ?? null) as
                            | "physical"
                            | "email"
                            | "viber"
                            | "gcash"
                            | "pickup"
                            | null
                        }
                      />
                    </td>
                  </tr>
                );
              })}
              {(tests ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
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
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {activePayments.map((p) => (
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
                  <td className="px-4 py-3">
                    <VoidPaymentDialog
                      paymentId={p.id}
                      amountLabel={formatPhp(p.amount_php)}
                    />
                  </td>
                </tr>
              ))}
              {activePayments.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No active payments.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {voidedPayments.length > 0 ? (
          <details className="mt-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3">
            <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Voided payments ({voidedPayments.length})
            </summary>
            <ul className="mt-2 space-y-2 text-xs">
              {voidedPayments.map((p) => (
                <li key={p.id} className="rounded-md bg-white px-3 py-2">
                  <div className="font-semibold text-[color:var(--color-brand-text-mid)]">
                    {formatPhp(p.amount_php)} · {p.method ? PAYMENT_METHOD_LABEL[p.method] ?? p.method : "—"}
                    <span className="ml-2 text-[color:var(--color-brand-text-soft)]">
                      voided {p.voided_at ? new Date(p.voided_at).toLocaleString("en-PH") : ""}
                    </span>
                  </div>
                  {p.void_reason ? (
                    <div className="mt-1 text-[color:var(--color-brand-text-soft)]">
                      Reason: {p.void_reason}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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
  preferredMedium: "physical" | "email" | "viber" | "gcash" | "pickup" | null;
}

// Renders a context-appropriate cell for the Action column on the visit
// detail tests table. Tells the receptionist what's blocking each test and
// where to go next.
function TestAction({
  status,
  testRequestId,
  visitId,
  paid,
  preferredMedium,
}: TestActionProps) {
  if (status === "ready_for_release") {
    return (
      <ReleaseButton
        testRequestId={testRequestId}
        visitId={visitId}
        paid={paid}
        preferredMedium={preferredMedium}
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
