"use client";

import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { getPatientResultDownloadUrl } from "./actions";

interface Props {
  testRequestId: string;
}

export function DownloadButton({ testRequestId }: Props) {
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
            const result = await getPatientResultDownloadUrl(testRequestId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            window.open(result.url, "_blank", "noopener,noreferrer");
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
