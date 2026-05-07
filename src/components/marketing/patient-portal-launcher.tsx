"use client";

import { useActionState, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  signInPatient,
  type SignInResult,
} from "@/app/(patient)/portal/login/actions";

interface Props {
  triggerClassName?: string;
}

// Marketing-side trigger for the patient sign-in flow.
// On submit, signInPatient (server action) redirects to /portal on success.
// /portal/login still works as a standalone page for direct links.
export function PatientPortalLauncher({ triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<
    SignInResult | null,
    FormData
  >(signInPatient, null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={
              triggerClassName ??
              "whitespace-nowrap rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white sm:text-sm"
            }
          >
            <span className="hidden sm:inline">Patient </span>Portal
          </button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-[family-name:var(--font-heading)] text-xl text-[color:var(--color-brand-navy)]">
            Patient Portal
          </DialogTitle>
          <DialogDescription>
            Sign in securely to access your laboratory results.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="grid gap-4 pt-2">
          <div className="grid gap-1.5">
            <Label htmlFor="modal-drm-id">Patient User ID</Label>
            <Input
              id="modal-drm-id"
              name="drm_id"
              placeholder="DRM-0001"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="modal-pin">Secure PIN / Claim Password</Label>
            <Input
              id="modal-pin"
              name="pin"
              placeholder="From your receipt"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              maxLength={8}
              required
            />
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              You can find your Secure PIN printed on your official laboratory
              receipt.
            </p>
          </div>

          {state && !state.ok ? (
            <p className="text-sm text-red-600" role="alert">
              {state.error}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={pending}
            className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            {pending ? "Signing in…" : "Access My Results →"}
          </Button>

          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            🔒 Protected under the Philippine Data Privacy Act (RA 10173).
            Results accessible only to the patient or authorized
            representatives.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
