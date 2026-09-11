"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { InquiryFormFields, type StaffOption } from "./inquiry-form";
import { createInquiryFromSheetAction } from "./actions";

const FORM_ID = "new-inquiry-form";

export function NewInquirySheet({
  staffOptions,
  defaultReceivedById,
}: {
  staffOptions: StaffOption[];
  defaultReceivedById?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  function reset() {
    setError(null);
    formRef.current?.reset();
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createInquiryFromSheetAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Inquiry logged.");
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <SheetTrigger
        render={<Button className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]" />}
      >
        + New inquiry
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New inquiry</SheetTitle>
          <SheetDescription>
            Capture inbound phone leads, FB messages, and walk-up questions
            before they turn into a booking.
          </SheetDescription>
        </SheetHeader>

        <form
          ref={formRef}
          id={FORM_ID}
          onSubmit={submit}
          className="grid gap-5"
        >
          <InquiryFormFields
            staffOptions={staffOptions}
            defaultReceivedById={defaultReceivedById}
            error={error}
          />
        </form>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </SheetClose>
          <Button
            type="submit"
            form={FORM_ID}
            disabled={pending}
            className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            {pending ? "Saving…" : "Create inquiry"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
