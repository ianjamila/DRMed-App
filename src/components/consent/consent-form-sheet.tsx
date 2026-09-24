// src/components/consent/consent-form-sheet.tsx
//
// Shared body of the printable data-privacy consent form. Three callers render
// this: the per-patient route (patients/[id]/consent/print), which passes a
// resolved patient so the sheet is pre-filled; the blank/counter route
// (patients/consent/print), which renders it with no patient at all so
// reception can hand a blank copy to be filled in and matched to a patient
// record afterwards (new-patient registration has no patient id yet); and the
// signed-form route (patients/[id]/consent/signed), which also passes `signed`
// so the recorded signature, signatory and date sit on the form the patient
// agreed to — an on-screen signature is stored as a bare PNG, and on its own
// that picture is not a consent record.
import Image from "next/image";
import { ConsentNotice } from "@/components/consent/consent-notice";
import { manilaDate } from "@/lib/dates/manila";
import type { ConsentSignatory } from "@/lib/consent/types";

export interface ConsentFormPatient {
  drm_id: string;
  first_name: string;
  last_name: string;
}

export interface ConsentFormSigned {
  signedAt: string;
  signatory: ConsentSignatory;
  signatoryName: string | null;
  signatoryRelationship: string | null;
  // Short-lived signed URL of the on-screen signature image. Null when the
  // consent carries no drawn signature (accepted online, or a paper form whose
  // scan was never attached) — `mark` then says so in the signature slot.
  signatureUrl: string | null;
  mark: string;
  // The notice version this consent was agreed to — the sheet renders that
  // version's archived wording rather than today's.
  noticeVersion: string | null;
  // The provenance line under the form: how, when and by whom it was recorded.
  record: string;
}

function SignatureSlot({ signed, name }: { signed: ConsentFormSigned; name: string }) {
  return (
    <div className="mb-1 text-sm text-[color:var(--color-brand-text)]">
      {signed.signatureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived storage signed URL; plain img prints reliably
        <img
          src={signed.signatureUrl}
          alt={`Signature of ${name}`}
          className="h-16 w-auto max-w-full object-contain object-left"
        />
      ) : (
        <p className="italic text-[color:var(--color-brand-text-mid)]">{signed.mark}</p>
      )}
      <p className="font-semibold">{name}</p>
    </div>
  );
}

export function ConsentFormSheet({
  patient,
  signed,
}: {
  patient?: ConsentFormPatient;
  signed?: ConsentFormSigned;
}) {
  const patientName = patient ? `${patient.first_name} ${patient.last_name}` : "";
  const selfSigned = signed?.signatory === "self" ? signed : undefined;
  const proxySigned = signed && signed.signatory !== "self" ? signed : undefined;
  return (
    <div className="consent-sheet mx-auto max-w-2xl bg-white p-8 text-[color:var(--color-brand-text)] print:p-0">
      <div className="h-1.5 bg-[color:var(--color-brand-navy)]" />
      <div className="mt-4 flex items-center justify-between">
        <Image src="/logo.png" alt="DR Med Healthcare Inc." width={150} height={43} />
        <div className="text-right text-xs text-[color:var(--color-brand-text-soft)]">
          {patient ? (
            <>
              DRM-ID: <b>{patient.drm_id}</b>
            </>
          ) : (
            <>
              DRM-ID:{" "}
              <span className="inline-block w-28 border-b border-dashed border-[color:var(--color-brand-text-soft)]">
                &nbsp;
              </span>
            </>
          )}
        </div>
      </div>
      <h1 className="mt-4 text-xl font-extrabold text-[color:var(--color-brand-navy)]">
        Data Privacy Consent
      </h1>
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-steel)]">
        Republic Act 10173 — Data Privacy Act of 2012
      </p>
      <p className="mt-3 text-sm">
        {patient ? (
          <>
            Patient: <b>{patient.last_name}, {patient.first_name}</b>
          </>
        ) : (
          <>
            Patient name:{" "}
            <span className="inline-block w-64 border-b border-dashed border-[color:var(--color-brand-text-soft)]">
              &nbsp;
            </span>
          </>
        )}
      </p>

      <div className="mt-4">
        <ConsentNotice version={signed?.noticeVersion} />
      </div>

      <div className="mt-10 flex items-end gap-8">
        <div className="flex-1">
          {selfSigned && <SignatureSlot signed={selfSigned} name={patientName} />}
          <div className="border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
            Signature over printed name
          </div>
        </div>
        <div className="w-28">
          {signed && <p className="mb-1 text-sm">{manilaDate(signed.signedAt)}</p>}
          <div className="border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
            Date
          </div>
        </div>
      </div>

      <div className="mt-8 border-t border-dashed border-[color:var(--color-brand-bg-mid)] pt-3 text-[11px] text-[color:var(--color-brand-text-soft)]">
        <b className="text-[color:var(--color-brand-navy)]">
          If the patient is a minor or unable to sign
        </b>{" "}
        — completed by parent / guardian / authorized representative:
        <div className="mt-6 flex items-end gap-8">
          <div className="flex-1">
            {proxySigned && (
              <SignatureSlot
                signed={proxySigned}
                name={proxySigned.signatoryName ?? ""}
              />
            )}
            <div className="border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
              Guardian / representative — signature over printed name
            </div>
          </div>
          <div className="flex-1">
            {proxySigned && (
              <p className="mb-1 text-sm text-[color:var(--color-brand-text)]">
                {proxySigned.signatoryRelationship}
              </p>
            )}
            <div className="border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
              Relationship to patient
            </div>
          </div>
        </div>
      </div>

      {signed && (
        <p className="mt-6 rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2 text-[11px] text-[color:var(--color-brand-text-mid)]">
          {signed.record}
        </p>
      )}
    </div>
  );
}
