"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/consent/signature-pad";
import { ConsentNotice } from "@/components/consent/consent-notice";
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";
import { withdrawConsentAction } from "@/lib/actions/consent/withdraw";
import { uploadConsentArtifactAction } from "@/lib/actions/consent/artifact";
import { manilaDate } from "@/lib/dates/manila";

type Signatory = "self" | "guardian" | "representative";

// Mirrors the consent-artifacts bucket's allowed MIME types / 5 MB cap
// (migration 0086) so this shows a clear message before the upload happens,
// instead of the bucket's opaque rejection on an oversize file.
const SCAN_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const EXT_BY_TYPE: Record<(typeof SCAN_TYPES)[number], "png" | "jpg" | "pdf"> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ConsentPanel({
  patientId,
  patientName,
  drmId,
  current,
  signedAt,
  noticeVersion,
  bookingOnlyConsent,
  isAdmin,
  readOnly = false,
}: {
  patientId: string;
  patientName: string;
  drmId: string;
  current: boolean;
  signedAt: string | null;
  noticeVersion: string | null;
  // Latest event is the old online-booking tick (contact details only): on
  // record, but not consent on file — the patient still needs to sign.
  bookingOnlyConsent: boolean;
  isAdmin: boolean;
  // 0167: true for a deleted/merged patient — reads (print, view signed
  // form) stay available; nothing new can be captured or withdrawn. The
  // server actions refuse regardless; this only hides the controls.
  readOnly?: boolean;
}) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "pad" | "paper">("idle");
  const [signatory, setSignatory] = useState<Signatory>("self");
  const [name, setName] = useState("");
  const [rel, setRel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function saveSignature(png: string) {
    setErr(null);
    start(async () => {
      const up = await uploadConsentArtifactAction({
        patientId,
        dataUrl: png,
        ext: "png",
      });
      if (!up.ok) return setErr(up.error);
      const res = await recordConsentGrantAction({
        patientId,
        method: "onscreen_signature",
        signatory,
        signatoryName: signatory === "self" ? undefined : name,
        signatoryRelationship: signatory === "self" ? undefined : rel,
        artifactPath: up.path,
      });
      if (!res.ok) return setErr(res.error);
      setMode("idle");
    });
  }

  function attachPaperScan(file: File) {
    setErr(null);
    if (!SCAN_TYPES.includes(file.type as (typeof SCAN_TYPES)[number])) {
      setErr("Please attach a PDF, PNG, or JPEG file.");
      return;
    }
    if (file.size > MAX_SCAN_BYTES) {
      setErr("That file is too large — the largest we can store is 5MB.");
      return;
    }
    const ext = EXT_BY_TYPE[file.type as (typeof SCAN_TYPES)[number]];
    start(async () => {
      const dataUrl = await readFileAsDataUrl(file);
      const up = await uploadConsentArtifactAction({
        patientId,
        dataUrl,
        ext,
      });
      if (!up.ok) return setErr(up.error);
      const res = await recordConsentGrantAction({
        patientId,
        method: "paper_wet_signature",
        signatory,
        signatoryName: signatory === "self" ? undefined : name,
        signatoryRelationship: signatory === "self" ? undefined : rel,
        artifactPath: up.path,
      });
      if (!res.ok) return setErr(res.error);
      setMode("idle");
    });
  }

  function withdraw() {
    const reason = prompt("Reason for withdrawing consent?");
    if (!reason) return;
    setErr(null);
    start(async () => {
      const res = await withdrawConsentAction({ patientId, reason });
      if (!res.ok) setErr(res.error);
    });
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] p-4">
      <h2 className="font-bold text-[color:var(--color-brand-navy)]">
        Data privacy consent
      </h2>
      <p className="mt-1 text-sm">
        {current ? (
          <span className="text-green-700">
            On file
            {signedAt
              ? ` — ${manilaDate(signedAt)}`
              : ""}
            {noticeVersion ? ` (notice ${noticeVersion})` : ""}
          </span>
        ) : (
          <span className="text-amber-700">
            Not on file
            {bookingOnlyConsent
              ? " — the online booking checkbox covered contact details only. Have the patient sign."
              : ""}
          </span>
        )}
      </p>

      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={`/staff/patients/${patientId}/consent/print`}
          target="_blank"
        >
          <Button type="button" variant="outline" size="sm">
            Print form
          </Button>
        </Link>
        {!readOnly && mode === "idle" && (
          <Button
            type="button"
            size="sm"
            onClick={() => setMode("pad")}
            disabled={pending}
          >
            Capture signature
          </Button>
        )}
        {!readOnly && mode === "idle" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMode("paper")}
            disabled={pending}
          >
            Attach signed paper form
          </Button>
        )}
        {/* The full form with the signature on it (or the paper scan) —
            also for consents accepted online, which carry no file at all. */}
        {(current || bookingOnlyConsent) && (
          <Link
            href={`/staff/patients/${patientId}/consent/signed`}
            target="_blank"
          >
            <Button type="button" variant="outline" size="sm">
              {current ? "View signed form" : "View booking consent"}
            </Button>
          </Link>
        )}
        {!readOnly && current && isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={withdraw}
            disabled={pending}
          >
            Withdraw consent
          </Button>
        )}
      </div>

      {(mode === "pad" || mode === "paper") && (
        <div className="mt-3 space-y-2">
          {/* On screen there is no paper form in front of the patient, so the
              notice they are agreeing to sits right above the pad — the same
              wording the signed form will later show around the signature. */}
          {mode === "pad" && (
            <div className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-3">
              {/* Same header the paper form carries, so the patient can check
                  it is their own consent before signing. */}
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-[color:var(--color-brand-bg-mid)] pb-2">
                <p className="text-sm">
                  <span className="font-extrabold text-[color:var(--color-brand-navy)]">
                    Data Privacy Consent
                  </span>{" "}
                  — Patient: <b>{patientName || "(no name on file)"}</b>
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  DRM-ID: <b>{drmId}</b>
                </p>
              </div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                Have the patient read this before signing
              </p>
              <div className="max-h-72 overflow-y-auto pr-1">
                <ConsentNotice compact />
              </div>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-3">
            <select
              value={signatory}
              onChange={(e) => setSignatory(e.target.value as Signatory)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
            >
              <option value="self">Patient</option>
              <option value="guardian">Guardian</option>
              <option value="representative">Representative</option>
            </select>
            {signatory !== "self" && (
              <>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Signatory name"
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
                />
                <input
                  value={rel}
                  onChange={(e) => setRel(e.target.value)}
                  placeholder="Relationship"
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
                />
              </>
            )}
          </div>
          {mode === "pad" ? (
            <SignaturePad onSave={saveSignature} saving={pending} />
          ) : (
            <div className="grid gap-1.5">
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                disabled={pending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) attachPaperScan(file);
                }}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[color:var(--color-brand-bg)] file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-[color:var(--color-brand-navy)] hover:file:bg-[color:var(--color-brand-bg-mid)]"
              />
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                PDF, PNG, or JPEG, up to 5MB — a scan or photo of the signed
                paper form.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
