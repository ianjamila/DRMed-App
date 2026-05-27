import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { SingleClaimActions } from "../../../_components/single-claim-actions";

export const metadata = { title: "Historic HMO claim — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface ClaimRow {
  id: string;
  hmo_provider: string;
  patient_name: string;
  claim_date: string;
  service_description: string | null;
  base_amount_php: number;
  final_amount_php: number;
  status: string;
  date_submitted: string | null;
  deadline_date: string | null;
  date_paid: string | null;
  or_number: string | null;
  source_tab: string;
  source_row: number;
  notes: string | null;
}

export default async function HistoricClaimDetail({
  params,
}: {
  params: Promise<{ providerId: string; claimId: string }>;
}) {
  const { providerId, claimId } = await params;
  await requireAdminStaff();
  const admin = createAdminClient();

  // 1. The claim itself + active staff for the action modals + audit history + payment methods
  const [claimQ, staffQ, auditQ, paymentMethodsQ] = await Promise.all([
    admin
      .from("historic_hmo_claims" as never)
      .select("*")
      .eq("id", claimId)
      .maybeSingle<ClaimRow>(),
    admin
      .from("staff_profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name"),
    admin
      .from("audit_log")
      .select("id, actor_id, action, metadata, created_at")
      .like("action", "historic_hmo.%")
      .or(`resource_id.eq.${claimId},metadata->claim_ids.cs.["${claimId}"]`)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .from("chart_of_accounts")
      .select("code, name")
      .eq("is_active", true)
      .eq("is_settlement_destination", true)
      .order("code"),
  ]);
  const claim = claimQ.data;
  const staff = (staffQ.data ?? []) as { id: string; full_name: string }[];
  const paymentMethods = (paymentMethodsQ.data ?? []) as { code: string; name: string }[];
  type AuditRow = {
    id: number;
    actor_id: string | null;
    action: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  };
  const auditRows = (auditQ.data ?? []) as AuditRow[];

  // Resolve actor names in one fetch.
  const actorIds = Array.from(new Set(auditRows.map((a) => a.actor_id).filter(Boolean) as string[]));
  const { data: actors } = actorIds.length > 0
    ? await admin.from("staff_profiles").select("id, full_name").in("id", actorIds)
    : { data: [] };
  const actorMap = new Map((actors ?? []).map((s) => [s.id, s.full_name]));

  if (!claim) notFound();

  // 2. Sibling rows: same patient name + same claim date + same HMO
  const { data: siblings } = await admin
    .from("historic_hmo_claims" as never)
    .select("*")
    .eq("hmo_provider", claim.hmo_provider)
    .eq("claim_date", claim.claim_date)
    .ilike("patient_name", claim.patient_name)
    .order("source_row")
    .returns<ClaimRow[]>();

  const others = (siblings ?? []).filter((s) => s.id !== claimId);
  const totalBase = (siblings ?? []).reduce((s, r) => s + Number(r.base_amount_php), 0);
  const totalFinal = (siblings ?? []).reduce((s, r) => s + Number(r.final_amount_php), 0);

  function fmtDate(d: string | null): string {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-4">
        <Link
          href={`/staff/admin/accounting/hmo-claims/${providerId}`}
          className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Back to {claim.hmo_provider}
        </Link>
      </div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Historic HMO claim · {claim.source_tab} row {claim.source_row}
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {claim.patient_name}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
            {claim.hmo_provider} · {fmtDate(claim.claim_date)} ·{" "}
            <span
              className={
                "ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                (claim.status === "paid"
                  ? "bg-emerald-100 text-emerald-800"
                  : claim.status === "overdue"
                    ? "bg-red-100 text-red-800"
                    : claim.status === "pending"
                      ? "bg-amber-100 text-amber-800"
                      : claim.status === "written_off"
                        ? "bg-slate-100 text-slate-500"
                        : "bg-slate-100 text-slate-700")
              }
            >
              {claim.status}
            </span>
          </p>
        </div>
        <SingleClaimActions
          claimId={claim.id}
          status={claim.status as "pending" | "overdue" | "paid" | "written_off" | "unknown"}
          hasSubmissionDate={Boolean(claim.date_submitted)}
          finalAmount={Number(claim.final_amount_php)}
          staff={staff}
          paymentMethods={paymentMethods}
        />
      </header>

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Base price" value={PHP.format(Number(claim.base_amount_php))} />
        <Field label="Final price" value={PHP.format(Number(claim.final_amount_php))} />
        <Field label="Service" value={claim.service_description ?? "—"} />
        <Field label="Date submitted (invoice sent)" value={fmtDate(claim.date_submitted)} />
        <Field label="Deadline" value={fmtDate(claim.deadline_date)} />
        <Field label="Date paid" value={fmtDate(claim.date_paid)} />
        <Field label="OR #" value={claim.or_number ?? "—"} />
        <Field label="Source" value={`${claim.source_tab} row ${claim.source_row}`} />
        <Field
          label="Billing status"
          value={
            claim.date_submitted
              ? "Invoiced to HMO"
              : "FOR INVOICE CREATION (never sent)"
          }
        />
      </section>

      {claim.notes && (
        <section className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-xs text-[color:var(--color-brand-text-soft)]">
          <div className="mb-1 font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Notes</div>
          <code className="break-all">{claim.notes}</code>
        </section>
      )}

      <section className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Activity
        </h2>
        {auditRows.length === 0 ? (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            No activity recorded yet for this claim.
          </p>
        ) : (
          <ol className="mt-3 space-y-2 text-xs">
            {auditRows.map((a) => {
              const actorName = a.actor_id ? actorMap.get(a.actor_id) ?? "(unknown)" : "(system)";
              const when = new Date(a.created_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
              const label = a.action.replace("historic_hmo.", "");
              const meta = a.metadata ?? {};
              const datePaid = (meta as Record<string, unknown>).date_paid;
              const dateSubmitted = (meta as Record<string, unknown>).date_submitted;
              const reason = (meta as Record<string, unknown>).reason;
              const method = (meta as Record<string, unknown>).payment_method;
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-[color:var(--color-brand-bg-mid)] pb-2 last:border-b-0">
                  <span
                    className={
                      "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                      (label === "marked_paid"
                        ? "bg-emerald-100 text-emerald-800"
                        : label === "written_off"
                          ? "bg-red-100 text-red-800"
                          : label === "unmarked_billed"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-sky-100 text-sky-800")
                    }
                  >
                    {label}
                  </span>
                  <span className="font-semibold text-[color:var(--color-brand-navy)]">{actorName}</span>
                  <span className="text-[color:var(--color-brand-text-soft)]">at {when}</span>
                  {dateSubmitted ? <span className="text-[color:var(--color-brand-text-soft)]">· date submitted = <span className="font-mono">{String(dateSubmitted)}</span></span> : null}
                  {datePaid ? <span className="text-[color:var(--color-brand-text-soft)]">· date paid = <span className="font-mono">{String(datePaid)}</span></span> : null}
                  {method ? <span className="text-[color:var(--color-brand-text-soft)]">· method = <span className="font-mono uppercase">{String(method)}</span></span> : null}
                  {reason ? <span className="text-[color:var(--color-brand-text-soft)]">· reason: {String(reason)}</span> : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            All tests / services on {fmtDate(claim.claim_date)}
          </h2>
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">
            {(siblings ?? []).length} item{(siblings ?? []).length === 1 ? "" : "s"} · Total{" "}
            <span className="font-semibold text-[color:var(--color-brand-navy)]">{PHP.format(totalFinal)}</span>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Service</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Base</th>
                <th className="px-3 py-2 text-right">Final</th>
              </tr>
            </thead>
            <tbody>
              {(siblings ?? []).map((s) => (
                <tr
                  key={s.id}
                  className={
                    "border-t border-[color:var(--color-brand-bg-mid)] " +
                    (s.id === claimId ? "bg-amber-50" : "")
                  }
                >
                  <td className="px-3 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                    {s.source_tab === "LAB SERVICE" ? "LAB" : "DOC"} r{s.source_row}
                  </td>
                  <td className="px-3 py-2">
                    {s.id === claimId ? (
                      <span className="font-semibold">{s.service_description ?? "—"} (this)</span>
                    ) : (
                      <Link
                        href={`/staff/admin/accounting/hmo-claims/${providerId}/historic/${s.id}`}
                        className="text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        {s.service_description ?? "—"}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                        (s.status === "paid"
                          ? "bg-emerald-100 text-emerald-800"
                          : s.status === "overdue"
                            ? "bg-red-100 text-red-800"
                            : s.status === "pending"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-700")
                      }
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {PHP.format(Number(s.base_amount_php))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                    {PHP.format(Number(s.final_amount_php))}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] font-semibold">
                <td className="px-3 py-2" colSpan={3}>
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {PHP.format(totalBase)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {PHP.format(totalFinal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {others.length === 0 && (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            No other tests recorded for {claim.patient_name} on this date.
          </p>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        {value}
      </div>
    </div>
  );
}
