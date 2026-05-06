"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deleteBlockAction, deleteOverrideAction } from "./actions";

interface BlockProps {
  physicianId: string;
  blockId: string;
}

export function DeleteBlockButton({ physicianId, blockId }: BlockProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this recurring block?")) return;
        startTransition(async () => {
          await deleteBlockAction(physicianId, blockId);
          router.refresh();
        });
      }}
      className="border-red-200 text-red-700 hover:bg-red-50"
    >
      {pending ? "…" : "Delete"}
    </Button>
  );
}

interface OverrideProps {
  physicianId: string;
  overrideId: string;
}

export function DeleteOverrideButton({
  physicianId,
  overrideId,
}: OverrideProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this override?")) return;
        startTransition(async () => {
          await deleteOverrideAction(physicianId, overrideId);
          router.refresh();
        });
      }}
      className="border-red-200 text-red-700 hover:bg-red-50"
    >
      {pending ? "…" : "Delete"}
    </Button>
  );
}
