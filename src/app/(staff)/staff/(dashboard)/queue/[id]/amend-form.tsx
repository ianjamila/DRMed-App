"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { amendResultAction, type AmendResult } from "./actions";
import { StructuredResultForm } from "./structured-form";
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
  structured,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [state, setState] = useState<AmendResult | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-bold uppercase tracking-wider text-amber-700 hover:underline"
      >
        Amend result…
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
              PDF replaces them as the canonical version. Patients with the
              prior PDF already downloaded need to be notified manually.
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
          testRequestId={testRequestId}
          layout={structured.layout}
          params={structured.params}
          patientSex={structured.patientSex}
          patientAgeMonths={structured.patientAgeMonths}
          initial={structured.initialValues}
          alreadyFinalised={false}
          mode="amend"
          currentImageFilename={structured.currentImageFilename}
        />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        start(async () => {
          const result = await amendResultAction(testRequestId, formData);
          setState(result);
          if (result.ok) {
            setOpen(false);
            router.refresh();
          }
        });
      }}
      className="grid gap-3 rounded-md border border-amber-300 bg-amber-50/60 p-4"
    >
      <p className="text-xs font-bold uppercase tracking-wider text-amber-900">
        Amend result
      </p>
      <p className="text-xs text-amber-900">
        Snapshots the current PDF, replaces it with the corrected version.
        The original is preserved in the audit trail. Patients with the
        result already downloaded need to be notified manually.
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
          onClick={() => {
            setOpen(false);
            setState(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
