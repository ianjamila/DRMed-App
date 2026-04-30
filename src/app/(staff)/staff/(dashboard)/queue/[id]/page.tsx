import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClaimButton } from "../claim-button";
import { UploadResultForm } from "./upload-form";
import { ViewResultButton } from "./view-result-button";

export const metadata = {
  title: "Test — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  result_uploaded: "bg-amber-100 text-amber-900",
  ready_for_release: "bg-emerald-100 text-emerald-900",
  released: "bg-[color:var(--color-brand-navy)] text-white",
  cancelled: "bg-red-100 text-red-900",
};

export default async function QueueTestDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: test } = await supabase
    .from("test_requests")
    .select(
      `
        id, status, requested_at, started_at, completed_at, assigned_to,
        services!inner ( id, code, name, turnaround_hours, requires_signoff ),
        visits!inner (
          id, visit_number,
          patients!inner ( id, drm_id, first_name, last_name, phone )
        ),
        results ( id, uploaded_at, file_size_bytes, notes )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!test) notFound();

  const svc = Array.isArray(test.services) ? test.services[0] : test.services;
  const visit = Array.isArray(test.visits) ? test.visits[0] : test.visits;
  if (!svc || !visit) notFound();
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();

  const result = Array.isArray(test.results) ? test.results[0] : test.results;
  const ownedByMe = test.assigned_to === user?.id;
  const claimable = test.status === "requested";
  const uploadable =
    test.status === "in_progress" && (ownedByMe || !test.assigned_to);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/queue"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Queue
      </Link>

      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
            {svc.code}
          </p>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {svc.name}
          </h1>
        </div>
        <span
          className={`rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wider ${
            TEST_STATUS_STYLE[test.status] ?? ""
          }`}
        >
          {test.status.replace(/_/g, " ")}
        </span>
      </header>

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Patient
          </p>
          <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
          </p>
          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
            {patient.drm_id} · Visit #{visit.visit_number}
          </p>
          {patient.phone ? (
            <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
              {patient.phone}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Timing
          </p>
          <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-mid)]">
            Requested {new Date(test.requested_at).toLocaleString("en-PH")}
          </p>
          {test.started_at ? (
            <p className="text-sm text-[color:var(--color-brand-text-mid)]">
              Started {new Date(test.started_at).toLocaleString("en-PH")}
            </p>
          ) : null}
          {svc.turnaround_hours ? (
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Typical turnaround: {svc.turnaround_hours}h
            </p>
          ) : null}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        {claimable ? (
          <div>
            <p className="text-sm text-[color:var(--color-brand-text-mid)]">
              This test is unassigned. Claim it to start working on it.
            </p>
            <div className="mt-4">
              <ClaimButton testRequestId={test.id} />
            </div>
          </div>
        ) : null}

        {uploadable ? (
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              Upload result
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {svc.requires_signoff
                ? "After upload the test moves to result_uploaded — pathologist sign-off required before release."
                : "After upload the test moves to ready_for_release — reception can release it once the visit is paid."}
            </p>
            <div className="mt-4">
              <UploadResultForm testRequestId={test.id} />
            </div>
          </div>
        ) : null}

        {result ? (
          <div className={uploadable || claimable ? "mt-6" : ""}>
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              Result on file
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              Uploaded {new Date(result.uploaded_at).toLocaleString("en-PH")}
              {result.file_size_bytes
                ? ` · ${(result.file_size_bytes / 1024).toFixed(0)} KB`
                : ""}
            </p>
            {result.notes ? (
              <p className="mt-2 rounded-md bg-[color:var(--color-brand-bg)] p-3 text-xs text-[color:var(--color-brand-text-mid)]">
                <span className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Internal notes:{" "}
                </span>
                {result.notes}
              </p>
            ) : null}
            <div className="mt-4">
              <ViewResultButton testRequestId={test.id} />
            </div>
            <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
              Opens a 5-minute signed URL. Each view is audit-logged.
            </p>
          </div>
        ) : null}

        {!claimable && !uploadable && !result ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            No actions available for this test in its current state.
          </p>
        ) : null}
      </section>

      <Link
        href={`/staff/visits/${visit.id}`}
        className="mt-6 inline-block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Open visit →
      </Link>
    </div>
  );
}
