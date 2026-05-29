"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/consent/signature-pad";
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";
import { withdrawConsentAction } from "@/lib/actions/consent/withdraw";
import { uploadConsentArtifactAction } from "@/lib/actions/consent/artifact";

type Signatory = "self" | "guardian" | "representative";

export function ConsentPanel({
  patientId,
  current,
  signedAt,
  noticeVersion,
  isAdmin,
}: {
  patientId: string;
  current: boolean;
  signedAt: string | null;
  noticeVersion: string | null;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "pad">("idle");
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
              ? ` — ${new Date(signedAt).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}`
              : ""}
            {noticeVersion ? ` (notice ${noticeVersion})` : ""}
          </span>
        ) : (
          <span className="text-amber-700">Not on file</span>
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
        {mode === "idle" && (
          <Button
            type="button"
            size="sm"
            onClick={() => setMode("pad")}
            disabled={pending}
          >
            Capture signature
          </Button>
        )}
        {current && isAdmin && (
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

      {mode === "pad" && (
        <div className="mt-3 space-y-2">
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
          <SignaturePad onSave={saveSignature} saving={pending} />
        </div>
      )}
    </section>
  );
}
