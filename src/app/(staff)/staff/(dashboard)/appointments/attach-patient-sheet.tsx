"use client";

// H2: a walk-in-mode appointment (patient_id = null, walk_in_name/phone only)
// can be marked arrived, but until this existed nothing could ever attach a
// real patient to it — reception's only workaround was abandoning the card
// and re-registering from /staff/patients/new, leaving the appointment
// dangling at arrived forever. Mirrors the "Existing / New" patient picker in
// new-appointment-sheet.tsx rather than inventing new UI.

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
import {
  PRE_REGISTERED_LABEL_SHORT,
  PRE_REGISTERED_BADGE_CLASS,
} from "@/lib/patients/labels";
import type { AttachPatientInput } from "@/lib/appointments/attach-patient";
import {
  searchPatientsAction,
  type PatientSearchRow,
} from "./new-appointment-actions";
import { checkPatientDuplicatesAction, type PublicCandidate } from "@/lib/patients/check-duplicates-action";
import { attachPatientToAppointmentAction } from "./actions";

type PatientMode = "existing" | "new";

const INPUT_CLS = "rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm";

function splitWalkInName(name: string | null): { first: string; last: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

export function AttachPatientSheet({
  appointmentId,
  walkInName,
  walkInPhone,
}: {
  appointmentId: string;
  walkInName: string | null;
  walkInPhone: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [mode, setMode] = React.useState<PatientMode>("existing");

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PatientSearchRow[]>([]);
  const [selected, setSelected] = React.useState<PatientSearchRow | null>(null);

  const guess = splitWalkInName(walkInName);
  const blankNew = {
    first_name: guess.first,
    last_name: guess.last,
    middle_name: "",
    birthdate: "",
    sex: "" as "" | "male" | "female",
    phone: walkInPhone ?? "",
    email: "",
    address: "",
  };
  const [newP, setNewP] = React.useState(blankNew);
  const [dupCandidates, setDupCandidates] = React.useState<PublicCandidate[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (mode !== "existing") return;
    const term = query.trim();
    if (selected || term.length < 2) return;
    const handle = setTimeout(() => {
      searchPatientsAction(term).then((r) => {
        if (r.ok) setResults(r.data);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query, mode, selected]);

  React.useEffect(() => {
    const t = setTimeout(async () => {
      if (
        mode !== "new" ||
        !newP.last_name.trim() ||
        (!newP.email && !newP.phone && !newP.birthdate)
      ) {
        setDupCandidates([]);
        return;
      }
      const res = await checkPatientDuplicatesAction({
        first_name: newP.first_name,
        last_name: newP.last_name,
        birthdate: newP.birthdate || null,
        email: newP.email || null,
        phone: newP.phone || null,
      });
      if (res.ok) setDupCandidates(res.candidates);
    }, 400);
    return () => clearTimeout(t);
  }, [mode, newP.first_name, newP.last_name, newP.birthdate, newP.email, newP.phone]);

  function reset() {
    setMode("existing");
    setQuery("");
    setResults([]);
    setSelected(null);
    setNewP(blankNew);
    setDupCandidates([]);
    setError(null);
  }

  function pickPatient(p: PatientSearchRow) {
    setSelected(p);
    setResults([]);
    setQuery(`${p.last_name}, ${p.first_name} · ${p.drm_id}`);
  }

  function submit() {
    setError(null);
    let patient: AttachPatientInput;
    if (mode === "existing") {
      if (!selected) {
        setError("Search and pick a patient first.");
        return;
      }
      patient = { mode: "existing", patient_id: selected.id };
    } else {
      const hasExact = dupCandidates.some((c) => c.tier === "exact_dup");
      if (
        hasExact &&
        !window.confirm(
          "This looks like an exact match for an existing patient. Create a SEPARATE record anyway?",
        )
      ) {
        return;
      }
      patient = { mode: "new", ...newP };
    }
    startTransition(async () => {
      const result = await attachPatientToAppointmentAction(appointmentId, patient);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Patient attached. “+ Start visit” is now available on this row.");
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
      <SheetTrigger render={<Button type="button" size="sm" variant="success" />}>
        Attach patient
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Attach a patient</SheetTitle>
          <SheetDescription>
            Link this walk-in to a patient record so reception can start the visit. Every change here is audit-logged.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-1">
            {(["existing", "new"] as PatientMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setSelected(null);
                  setQuery("");
                  setResults([]);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  mode === m ? "bg-[color:var(--color-brand-navy)] text-white" : "bg-muted text-foreground"
                }`}
              >
                {m === "existing" ? "Existing patient" : "Register new"}
              </button>
            ))}
          </div>

          {mode === "existing" && (
            <div className="flex flex-col gap-1">
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                }}
                placeholder="Search DRM-ID, name, phone, email…"
                className={INPUT_CLS}
              />
              {!selected && query.trim().length >= 2 && results.length > 0 && (
                <ul className="max-h-44 overflow-y-auto rounded-md border border-[color:var(--color-brand-bg-mid)]">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => pickPatient(p)}
                        className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-semibold">
                          {p.last_name}, {p.first_name}
                          {p.pre_registered ? (
                            <span
                              className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${PRE_REGISTERED_BADGE_CLASS}`}
                            >
                              {PRE_REGISTERED_LABEL_SHORT}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.drm_id} · {p.phone ?? p.email ?? "—"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {mode === "new" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <input value={newP.first_name} onChange={(e) => setNewP({ ...newP, first_name: e.target.value })} placeholder="First name" className={INPUT_CLS} />
                <input value={newP.last_name} onChange={(e) => setNewP({ ...newP, last_name: e.target.value })} placeholder="Last name" className={INPUT_CLS} />
                <input value={newP.middle_name} onChange={(e) => setNewP({ ...newP, middle_name: e.target.value })} placeholder="Middle name (optional)" className={INPUT_CLS} />
                <input type="date" value={newP.birthdate} onChange={(e) => setNewP({ ...newP, birthdate: e.target.value })} className={INPUT_CLS} />
                <select value={newP.sex} onChange={(e) => setNewP({ ...newP, sex: e.target.value as "" | "male" | "female" })} className={INPUT_CLS}>
                  <option value="">Sex (optional)</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
                <input value={newP.phone} onChange={(e) => setNewP({ ...newP, phone: e.target.value })} placeholder="Phone" className={INPUT_CLS} />
                <input value={newP.email} onChange={(e) => setNewP({ ...newP, email: e.target.value })} placeholder="Email (required)" className={`col-span-2 ${INPUT_CLS}`} />
                <input value={newP.address} onChange={(e) => setNewP({ ...newP, address: e.target.value })} placeholder="Address (optional)" className={`col-span-2 ${INPUT_CLS}`} />
              </div>
              {dupCandidates.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                  <p className="mb-2 font-semibold text-amber-900">
                    Possible existing patient{dupCandidates.length > 1 ? "s" : ""}:
                  </p>
                  <ul className="space-y-2">
                    {dupCandidates.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2">
                        <span className="text-amber-900">
                          {c.first_name} {c.last_name} · {c.drm_id} · {c.birthdate ?? "—"}
                          {c.tier === "exact_dup" && (
                            <span className="ml-1 font-bold text-red-700">exact match</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            searchPatientsAction(c.drm_id).then((r) => {
                              if (!r.ok) return;
                              const match = r.data.find((p) => p.id === c.id);
                              if (!match) return;
                              setMode("existing");
                              setDupCandidates([]);
                              pickPatient(match);
                            });
                          }}
                          className="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                        >
                          Use this patient
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <SheetFooter>
          <SheetClose render={<Button variant="outline" disabled={pending} />}>Cancel</SheetClose>
          <Button
            type="button"
            disabled={pending}
            onClick={submit}
            className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            {pending ? "Attaching…" : "Attach patient"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
