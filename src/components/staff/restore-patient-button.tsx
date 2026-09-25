"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/staff/confirm-dialog";
import { restorePatientAction } from "@/lib/actions/patients/lifecycle";

// Admin-only. Shown on the lifecycle banner of a deleted record's history
// pages (spec: "restorable forever from Admin Tools › Deleted Patients", and
// inline wherever the banner already appears).
export function RestorePatientButton({ patientId, drmId }: { patientId: string; drmId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onConfirm() {
    setError(null);
    start(async () => {
      const res = await restorePatientAction(patientId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      toast.success(`${res.data.drmId} restored`);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        Restore
      </button>
      <ConfirmDialog
        open={open}
        title={`Restore ${drmId}?`}
        body={
          <div className="space-y-2">
            <p>
              This puts the record back in the patient list, the pickers and the patient portal. Its visits
              and history are unchanged, and it keeps its DRM-ID.
            </p>
            <p className="text-[color:var(--color-brand-text-soft)]">
              If the patient registered again while this record was deleted, restore it and then merge the two
              records in Admin Tools › Merge Duplicate Patients.
            </p>
          </div>
        }
        confirmLabel="Restore"
        confirmVariant="primary"
        onConfirm={onConfirm}
        onCancel={() => {
          if (!pending) setOpen(false);
        }}
        isPending={pending}
        errorMessage={error}
      />
    </>
  );
}
