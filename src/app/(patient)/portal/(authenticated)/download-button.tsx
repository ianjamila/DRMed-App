"use client";

import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { getPatientResultDownloadUrl, getPatientConsolidatedResultDownloadUrl } from "./actions";

interface Props {
  /** For single-test results (legacy path). Exactly one of testRequestId /
   *  resultId must be provided. */
  testRequestId?: string;
  /** For consolidated group results (Chemistry etc.). */
  resultId?: string;
}

export function DownloadButton({ testRequestId, resultId }: Props) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
        onClick={() =>
          start(async () => {
            setError(null);
            let downloadResult;
            if (resultId) {
              downloadResult = await getPatientConsolidatedResultDownloadUrl(resultId);
            } else if (testRequestId) {
              downloadResult = await getPatientResultDownloadUrl(testRequestId);
            } else {
              setError("No result identifier provided.");
              return;
            }
            if (!downloadResult.ok) {
              setError(downloadResult.error);
              return;
            }
            window.open(downloadResult.url, "_blank", "noopener,noreferrer");
          })
        }
      >
        {pending ? "Opening…" : "Download"}
      </Button>
      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
