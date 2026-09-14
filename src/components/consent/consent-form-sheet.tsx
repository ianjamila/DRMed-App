// src/components/consent/consent-form-sheet.tsx
//
// Shared body of the printable data-privacy consent form. Two callers render
// this: the per-patient route (patients/[id]/consent/print), which passes a
// resolved patient so the sheet is pre-filled, and the blank/counter route
// (patients/consent/print), which renders it with no patient at all so
// reception can hand a blank copy to be filled in and matched to a patient
// record afterwards (new-patient registration has no patient id yet).
import Image from "next/image";
import { ConsentNotice } from "@/components/consent/consent-notice";

export interface ConsentFormPatient {
  drm_id: string;
  first_name: string;
  last_name: string;
}

export function ConsentFormSheet({
  patient,
}: {
  patient?: ConsentFormPatient;
}) {
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
        <ConsentNotice />
      </div>

      <div className="mt-10 flex gap-8">
        <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
          Signature over printed name
        </div>
        <div className="w-28 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
          Date
        </div>
      </div>

      <div className="mt-8 border-t border-dashed border-[color:var(--color-brand-bg-mid)] pt-3 text-[11px] text-[color:var(--color-brand-text-soft)]">
        <b className="text-[color:var(--color-brand-navy)]">
          If the patient is a minor or unable to sign
        </b>{" "}
        — completed by parent / guardian / authorized representative:
        <div className="mt-6 flex gap-8">
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
            Guardian / representative — signature over printed name
          </div>
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
            Relationship to patient
          </div>
        </div>
      </div>
    </div>
  );
}
