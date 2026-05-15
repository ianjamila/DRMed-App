import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClaimButton } from "../claim-button";
import { UploadResultForm } from "./upload-form";
import { ViewResultButton } from "./view-result-button";
import { StructuredResultForm } from "./structured-form";
import { AmendResultForm } from "./amend-form";
import {
  calculateAgeMonths,
  normalisePatientSex,
  type ParamValue,
  type ResultLayout,
  type TemplateParam,
} from "@/lib/results/types";
import { loadTemplateParams } from "@/lib/results/loaders";

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
        services!inner ( id, code, name, turnaround_hours, requires_signoff, is_send_out ),
        visits!inner (
          id, visit_number,
          patients!inner ( id, drm_id, first_name, last_name, phone, sex, birthdate )
        ),
        results ( id, uploaded_at, file_size_bytes, notes, generation_kind, finalised_at, control_no, amended_at, amendment_count, image_filename )
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
  const editable =
    ["in_progress", "result_uploaded"].includes(test.status) &&
    (ownedByMe || !test.assigned_to);
  // Amendments are allowed once a result exists, regardless of who
  // claimed the test originally — corrections often happen after the
  // patient has already received the PDF.
  const amendable = Boolean(
    result &&
      ["result_uploaded", "ready_for_release", "released"].includes(
        test.status,
      ),
  );

  // Load amendment history for the panel below the result.
  const amendments = result
    ? (
        await supabase
          .from("result_amendments")
          .select(
            "id, reason, amended_at, amendment_seq, amended_by, prior_uploaded_at",
          )
          .eq("result_id", result.id)
          .order("amendment_seq", { ascending: false })
      ).data ?? []
    : [];

  // Fetch names for the amender ids so the panel can show who did each
  // amendment.
  const amenderIds = Array.from(new Set(amendments.map((a) => a.amended_by)));
  const amenderMap = new Map<string, string>();
  if (amenderIds.length > 0) {
    const { data: profs } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", amenderIds);
    for (const p of profs ?? []) amenderMap.set(p.id, p.full_name);
  }

  // Phase 13: load template + (existing values, if any) so we can render
  // the structured form when applicable. Send-out tests skip this entirely.
  let templateLayout: ResultLayout | null = null;
  let templateParams: TemplateParam[] = [];
  const initialValues: Record<string, ParamValue> = {};

  if (!svc.is_send_out) {
    const { data: tpl } = await supabase
      .from("result_templates")
      .select("id, layout, is_active")
      .eq("service_id", svc.id)
      .maybeSingle();
    if (tpl?.is_active) {
      templateLayout = tpl.layout as ResultLayout;
      templateParams = await loadTemplateParams(supabase, tpl.id);

      if (result?.id) {
        const { data: valRows } = await supabase
          .from("result_values")
          .select(
            "parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank",
          )
          .eq("result_id", result.id);
        for (const v of valRows ?? []) {
          initialValues[v.parameter_id] = {
            numeric_value_si: v.numeric_value_si,
            numeric_value_conv: v.numeric_value_conv,
            text_value: v.text_value,
            select_value: v.select_value,
            flag: v.flag as ParamValue["flag"],
            is_blank: v.is_blank,
          };
        }
      }
    }
  }

  // Decide which workflow surface to render in the action card.
  // Order of precedence:
  //   structured-form  → in-house service with a template, editable, no
  //                      uploaded-PDF result already in place
  //   upload-form      → send-out OR no template; editable
  //   nothing          → claimable / no actions
  const canStructured =
    editable &&
    templateLayout != null &&
    templateParams.length > 0 &&
    (!result || result.generation_kind === "structured");
  const canUpload =
    editable &&
    !canStructured &&
    (!result || result.generation_kind === "uploaded");

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

        {canStructured ? (
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              Enter result values
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {svc.requires_signoff
                ? "After Finalise the test moves to result_uploaded — pathologist sign-off required before release."
                : "After Finalise the test moves to ready_for_release — reception can release it once the visit is paid."}
              {result?.finalised_at
                ? " Editing a finalised result will re-render the PDF on the next Finalise."
                : ""}
            </p>
            <div className="mt-5">
              <StructuredResultForm
                testRequestId={test.id}
                layout={templateLayout!}
                params={templateParams}
                patientSex={normalisePatientSex(patient.sex)}
                patientAgeMonths={calculateAgeMonths(patient.birthdate)}
                initial={initialValues}
                alreadyFinalised={false}
              />
            </div>
          </div>
        ) : null}

        {canUpload ? (
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              Upload result
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {svc.is_send_out
                ? "Send-out test: attach the partner-lab PDF."
                : "No structured template configured for this service yet — falling back to PDF upload."}
              {svc.requires_signoff
                ? " After upload the test moves to result_uploaded — pathologist sign-off required before release."
                : " After upload the test moves to ready_for_release — reception can release it once the visit is paid."}
            </p>
            <div className="mt-4">
              <UploadResultForm testRequestId={test.id} />
            </div>
          </div>
        ) : null}

        {result?.finalised_at || (result && result.generation_kind === "uploaded") ? (
          <div className={canStructured || canUpload || claimable ? "mt-6" : ""}>
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              Result on file
              {result.amendment_count > 0 ? (
                <span className="ml-2 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-900">
                  Amended ×{result.amendment_count}
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {result.generation_kind === "structured"
                ? `Auto-generated from structured values. Control No. ${result.control_no?.toString().padStart(6, "0") ?? "—"}.`
                : "Uploaded PDF (legacy / send-out path)."}
              {result.uploaded_at
                ? ` ${new Date(result.uploaded_at).toLocaleString("en-PH")}`
                : ""}
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
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ViewResultButton testRequestId={test.id} />
              {amendable ? (
                <AmendResultForm
                  testRequestId={test.id}
                  generationKind={
                    result.generation_kind === "structured"
                      ? "structured"
                      : "uploaded"
                  }
                  structured={
                    result.generation_kind === "structured" &&
                    templateLayout != null &&
                    templateParams.length > 0
                      ? {
                          layout: templateLayout,
                          params: templateParams,
                          patientSex: normalisePatientSex(patient.sex),
                          patientAgeMonths: calculateAgeMonths(patient.birthdate),
                          initialValues,
                          currentImageFilename: result.image_filename ?? null,
                        }
                      : undefined
                  }
                />
              ) : null}
            </div>
            <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
              Opens a 5-minute signed URL. Each view is audit-logged.
            </p>

            {amendments.length > 0 ? (
              <div className="mt-5 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Amendment history
                </p>
                <ul className="mt-2 grid gap-2 text-xs">
                  {amendments.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-md bg-white px-3 py-2"
                    >
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        v{a.amendment_seq + 1} ·{" "}
                        {new Date(a.amended_at).toLocaleString("en-PH")} ·{" "}
                        {amenderMap.get(a.amended_by) ?? "—"}
                      </p>
                      <p className="mt-1 text-[color:var(--color-brand-text-mid)]">
                        {a.reason}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                        Replaced version uploaded{" "}
                        {new Date(a.prior_uploaded_at).toLocaleString("en-PH")}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {!claimable && !canStructured && !canUpload && !result ? (
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
