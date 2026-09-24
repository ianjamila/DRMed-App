import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import {
  ConsentFormSheet,
  type ConsentFormSigned,
} from "@/components/consent/consent-form-sheet";
import { PrintButton } from "@/components/consent/print-button";
import { manilaDateTime } from "@/lib/dates/manila";
import {
  CURRENT_CONSENT_NOTICE_VERSION,
  consentNoticeText,
} from "@/lib/consent/notice";
import type { ConsentSignatory } from "@/lib/consent/types";
import { LATEST_CONSENT_EVENT_ORDER } from "@/lib/consent/latest-event";
import {
  PUBLIC_FORM_LABEL,
  type ConsentSourceForm,
} from "@/lib/consent/public-form-consent";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
    .from("patients")
    .select("id, first_name, last_name, drm_id")
    .eq("id", id)
    .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/patients/[id]/consent/signed"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : [data.last_name, data.first_name].filter(Boolean).join(", ");
  });
}
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 300;

function publicFormLabel(sourceForm: string | null): string {
  return sourceForm === "register" || sourceForm === "schedule"
    ? PUBLIC_FORM_LABEL[sourceForm as ConsentSourceForm]
    : "public website form";
}

function recordLine(
  consent: {
    method: string | null;
    created_at: string;
    notice_version: string | null;
    artifact_path: string | null;
    source_form: string | null;
    signatory: string | null;
    signatory_name: string | null;
  },
  recordedBy: string | null,
): string {
  const at = manilaDateTime(consent.created_at);
  const by = recordedBy ? ` by ${recordedBy}` : "";
  let how: string;
  switch (consent.method) {
    case "onscreen_signature":
      how = `Signed on-screen at reception on ${at}; recorded${by}.`;
      break;
    case "paper_wet_signature":
      how = `Signed on the paper form on ${at}; recorded${by}. No scan of the paper form was attached.`;
      break;
    case "self_registration":
      // No notice version: the clinic notice was never shown on these forms
      // (0162), so the record states only what the patient ticked, and where.
      return (
        `Accepted online by the patient on the ${publicFormLabel(consent.source_form)} on ${at}.` +
        signerNote(consent)
      );
    case "portal_acceptance":
      how = `Accepted online by the patient in the patient portal on ${at}.`;
      break;
    default:
      how = `Recorded on ${at}${by}.`;
  }
  // The sheet renders the archived wording of the agreed version; say so
  // plainly when that wording was never archived and today's is shown instead.
  const version = consent.notice_version;
  const versionNote = !version
    ? ` The notice version was not recorded; the current wording (${CURRENT_CONSENT_NOTICE_VERSION}) is shown.`
    : consentNoticeText(version)
      ? ` Agreed to notice version ${version}${version === CURRENT_CONSENT_NOTICE_VERSION ? "" : ` (the current version is ${CURRENT_CONSENT_NOTICE_VERSION})`}.`
      : ` Agreed to notice version ${version}, whose exact wording is not on file; the current wording (${CURRENT_CONSENT_NOTICE_VERSION}) is shown.`;
  return how + versionNote + signerNote(consent);
}

// Self grants snapshot the signer's name at insert since 0162; an older one
// with no snapshot shows today's name, and says so.
function signerNote(consent: { signatory: string | null; signatory_name: string | null }): string {
  return consent.signatory === "self" && !consent.signatory_name
    ? " The signer's name was not recorded at the time; the name shown is from today's patient record."
    : "";
}

function markFor(method: string | null): string {
  switch (method) {
    case "self_registration":
    case "portal_acceptance":
      return "Accepted electronically";
    case "paper_wet_signature":
      return "Signed on paper";
    default:
      return "Signature not captured";
  }
}

export default async function SignedConsentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireActiveStaff();
  const { id } = await params;
  const { data: patient } = await loadDetail(id);
  if (!patient) notFound();

  // Same ordering as the sync trigger (LATEST_CONSENT_EVENT_ORDER): the form
  // shown is the one behind the consent currently on file, never an older
  // grant superseded by a withdrawal.
  const admin = createAdminClient();
  const { data: consent } = await admin
    .from("patient_consents")
    .select(
      "id, event_type, method, created_at, notice_version, signatory, signatory_name, signatory_relationship, artifact_path, source_form, accepted_statement, consent_scope, recorded_by:staff_profiles!patient_consents_created_by_fkey(full_name)",
    )
    .eq("patient_id", patient.id)
    .order(LATEST_CONSENT_EVENT_ORDER.column, {
      ascending: LATEST_CONSENT_EVENT_ORDER.ascending,
    })
    .limit(1)
    .maybeSingle();

  const back = (
    <Link
      href={`/staff/patients/${patient.id}#consent`}
      className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
    >
      ← Patient
    </Link>
  );

  if (!consent || consent.event_type !== "granted") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        {back}
        <p className="mt-4 text-sm">
          There is no data privacy consent on file for this patient
          {consent ? " — it was withdrawn" : ""}.
        </p>
      </div>
    );
  }

  const { ip, ua } = await ipAndAgent();
  const auditBase = {
    actor_id: session.user_id,
    actor_type: "staff" as const,
    patient_id: patient.id,
    resource_type: "patient",
    resource_id: patient.id,
    ip_address: ip,
    user_agent: ua,
  };

  let signatureUrl: string | null = null;
  if (consent.artifact_path) {
    const { data: signedUrl } = await admin.storage
      .from("consent-artifacts")
      .createSignedUrl(consent.artifact_path, SIGNED_URL_TTL_SECONDS);
    if (!signedUrl) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
          {back}
          <p className="mt-4 text-sm text-red-600">
            Could not open the signed form. Try again.
          </p>
        </div>
      );
    }
    await audit({
      ...auditBase,
      action: "consent.artifact_viewed",
      metadata: { path: consent.artifact_path, consent_id: consent.id },
    });
    // A paper scan IS the whole signed form — show it as-is. Only the
    // on-screen signature is a bare signature image that needs the form
    // drawn around it.
    if (consent.method !== "onscreen_signature") redirect(signedUrl.signedUrl);
    signatureUrl = signedUrl.signedUrl;
  } else {
    await audit({
      ...auditBase,
      action: "consent.form_viewed",
      metadata: { consent_id: consent.id, method: consent.method },
    });
  }

  const recordedBy = consent.recorded_by?.full_name ?? null;
  const signed: ConsentFormSigned = {
    signedAt: consent.created_at,
    signatory: (consent.signatory ?? "self") as ConsentSignatory,
    signatoryName: consent.signatory_name,
    signatoryRelationship: consent.signatory_relationship,
    signatureUrl,
    mark: markFor(consent.method),
    noticeVersion: consent.notice_version,
    publicForm:
      consent.method === "self_registration"
        ? {
            label: publicFormLabel(consent.source_form),
            statement: consent.accepted_statement,
            bookingOnly: consent.consent_scope === "booking_contact_only",
          }
        : null,
    record: recordLine(consent, recordedBy),
  };

  return (
    <div className="consent-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        {back}
        <PrintButton />
      </div>
      <ConsentFormSheet
        patient={{
          drm_id: patient.drm_id,
          first_name: patient.first_name,
          last_name: patient.last_name,
        }}
        signed={signed}
      />
    </div>
  );
}
