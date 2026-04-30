"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getResultDownloadUrl } from "./actions";

interface Props {
  testRequestId: string;
}

export function ViewResultButton({ testRequestId }: Props) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await getResultDownloadUrl(testRequestId);
          if (!result.ok) {
            alert(result.error);
            return;
          }
          window.open(result.url, "_blank", "noopener,noreferrer");
        })
      }
    >
      {pending ? "Opening…" : "View / download result"}
    </Button>
  );
}
