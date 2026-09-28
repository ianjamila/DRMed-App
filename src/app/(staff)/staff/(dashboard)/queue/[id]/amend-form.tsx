"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { amendResultAction, type AmendResult } from "./actions";
import { StructuredResultForm } from "./structured-form";
import { NotifyPatientCheckbox } from "@/components/staff/notify-patient-checkbox";
import { NOTIFY_OUTCOME_TEXT, type NotifyOffer } from "@/lib/results/copy-followups";
import type {
  ParamValue,
  PatientSex,
  ResultLayout,
  TemplateParam,
} from "@/lib/results/types";

interface Props {
  testRequestId: string;
  // 'uploaded' renders the PDF-replace form (unchanged behaviour).
  // 'structured' renders the StructuredResultForm in amend mode so the
  // medtech can edit per-parameter values and regenerate the PDF.
  generationKind: "uploaded" | "structured";
  // results.amendment_count this page was rendered on. Sent back with the
  // save so an edit made by someone else in the meantime is refused (P0065)
  // instead of silently overwritten.
  expectedAmendmentCount: number;
  // 0179: whether the "let the patient know" checkbox can offer anything —
  // computed server-side (fetchCopyStates + shouldOfferNotify) from the
  // signed-in client; the Server Action re-checks before it ever sends.
  notifyOffer: NotifyOffer;
  // Only used when generationKind === 'structured'. Reuses the same data
  // the finalise flow loads in page.tsx.
  structured?: {
    layout: ResultLayout;
    params: TemplateParam[];
    patientSex: PatientSex;
    patientAgeMonths: number | null;
    initialValues: Record<string, ParamValue>;
    currentImageFilename: string | null;
  };
}

// Amend-an-already-released-result form. Toggle hides behind a small
// "Amend result" link so it doesn't add visual weight on the common
// "look at the result" path. Reason is mandatory and audit-logged.
// Branches on generationKind: uploaded → PDF replace, structured → re-open
// the structured form pre-filled with current values.
export function AmendResultForm({
  testRequestId,
  generationKind,
  expectedAmendmentCount,
  notifyOffer,
  structured,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The success message lives HERE, above the version-keyed forms below.
  // Each save revalidates this page, and the new amendment_count remounts the
  // form (a form seeded from old values must never save over a newer
  // version — and a refresh from elsewhere on the page, e.g. reassign, now
  // resets an open form instead of quietly sending the newer count with the
  // older values). The saved form is replaced by this panel, so it can't be
  // submitted twice with the same reason and notice box by accident.
  const [saved, setSaved] = useState<string | null>(null);

  if (saved) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4">
        <p role="status" className="text-sm font-semibold text-emerald-800">
          {saved}
        </p>
        <button
          type="button"
          onClick={() => {
            setSaved(null);
            setOpen(false);
            router.refresh();
          }}
          className="mt-3 min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-bold uppercase tracking-wider text-amber-700 hover:underline"
      >
        Edit result…
      </button>
    );
  }

  if (generationKind === "structured" && structured) {
    return (
      <div className="grid gap-3 rounded-md border border-amber-300 bg-amber-50/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Amend structured result
            </p>
            <p className="mt-1 text-xs text-amber-900">
              Edit the values below and add a reason. The current PDF,
              values{structured.layout === "imaging_report" ? ", and image" : ""}
              {" "}are snapshotted to the amendment history; the regenerated
              PDF replaces them as the canonical version. Patients who
              already have a copy appear on Result follow-ups until someone
              contacts them.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
        <StructuredResultForm
          key={expectedAmendmentCount}
          testRequestId={testRequestId}
          layout={structured.layout}
          params={structured.params}
          patientSex={structured.patientSex}
          patientAgeMonths={structured.patientAgeMonths}
          initial={structured.initialValues}
          alreadyFinalised={false}
          mode="amend"
          expectedAmendmentCount={expectedAmendmentCount}
          currentImageFilename={structured.currentImageFilename}
          notifyOffer={notifyOffer}
          onAmended={(r) =>
            setSaved(
              `✓ Saved.${r.controlNo != null ? ` Control No. ${r.controlNo.toString().padStart(6, "0")} — amended.` : ""}${
                NOTIFY_OUTCOME_TEXT[r.notify ?? ""] ?? ""
              }`,
            )
          }
        />
      </div>
    );
  }

  return (
    <ReplacePdfForm
      key={expectedAmendmentCount}
      testRequestId={testRequestId}
      expectedAmendmentCount={expectedAmendmentCount}
      notifyOffer={notifyOffer}
      onReplaced={(notify) => setSaved(`Result replaced.${NOTIFY_OUTCOME_TEXT[notify ?? ""] ?? ""}`)}
      onCancel={() => setOpen(false)}
    />
  );
}

// The PDF-replace form for an uploaded result, keyed by version in
// AmendResultForm (see there).
function ReplacePdfForm({
  testRequestId,
  expectedAmendmentCount,
  notifyOffer,
  onReplaced,
  onCancel,
}: {
  testRequestId: string;
  expectedAmendmentCount: number;
  notifyOffer: NotifyOffer;
  onReplaced: (notify: Extract<AmendResult, { ok: true }>["notify"]) => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<AmendResult | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        start(async () => {
          const result = await amendResultAction(testRequestId, formData);
          if (result.ok) {
            onReplaced(result.notify);
            return;
          }
          setState(result);
        });
      }}
      className="grid gap-3 rounded-md border border-amber-300 bg-amber-50/60 p-4"
    >
      <input
        type="hidden"
        name="expected_amendment_count"
        value={expectedAmendmentCount}
      />
      <p className="text-xs font-bold uppercase tracking-wider text-amber-900">
        Amend result
      </p>
      <p className="text-xs text-amber-900">
        Snapshots the current PDF, replaces it with the corrected version.
        The original is preserved in the audit trail. Patients who already
        have a copy appear on Result follow-ups until someone contacts them.
      </p>

      <div className="grid gap-1.5">
        <Label htmlFor="amend-file">Corrected PDF</Label>
        <input
          id="amend-file"
          name="file"
          type="file"
          accept="application/pdf"
          required
          className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="amend-reason">Reason for amendment</Label>
        <textarea
          id="amend-reason"
          name="reason"
          rows={3}
          maxLength={2000}
          required
          minLength={5}
          placeholder="Transcription corrected: glucose was 5.5 mmol/L not 55."
          className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
        />
      </div>

      <NotifyPatientCheckbox
        offer={notifyOffer}
        name="notify_patient"
        id={`notify-patient-${testRequestId}`}
      />

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending}
          className="bg-amber-700 text-white hover:bg-amber-800"
        >
          {pending ? "Amending…" : "Replace result"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
