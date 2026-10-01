"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldList, movedSummary } from "@/lib/patients/merge-result";
import {
  lookupPatientForMergeAction,
  mergePatientsAction,
  type LookupResult,
  type MergeResult,
  type PatientPreview,
} from "./actions";

export function MergeClient() {
  const [keep, setKeep] = useState<PatientPreview | null>(null);
  const [source, setSource] = useState<PatientPreview | null>(null);

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <PatientSlot
          title="Keep this patient"
          subtitle="The surviving row. All visits/appointments/audit rows from the duplicate move here."
          tone="keep"
          patient={keep}
          onResolve={setKeep}
        />
        <PatientSlot
          title="Merge in this patient"
          subtitle="The duplicate row. Tombstoned with a back-pointer; never hard-deleted."
          tone="source"
          patient={source}
          onResolve={setSource}
        />
      </div>

      <ConfirmMerge keep={keep} source={source} />
    </div>
  );
}

function PatientSlot({
  title,
  subtitle,
  tone,
  patient,
  onResolve,
}: {
  title: string;
  subtitle: string;
  tone: "keep" | "source";
  patient: PatientPreview | null;
  onResolve: (p: PatientPreview | null) => void;
}) {
  const [state, formAction, pending] = useActionState<
    LookupResult | null,
    FormData
  >(async (_prev, fd) => {
    const result = await lookupPatientForMergeAction(_prev, fd);
    if (result.ok) onResolve(result.patient);
    return result;
  }, null);

  const borderTone =
    tone === "keep"
      ? "border-emerald-300 bg-emerald-50/60"
      : "border-amber-300 bg-amber-50/60";

  return (
    <section
      className={`rounded-xl border p-5 ${
        patient ? borderTone : "border-[color:var(--color-brand-bg-mid)] bg-white"
      }`}
    >
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        {subtitle}
      </p>

      <form action={formAction} className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor={`drm-${tone}`}>DRM-ID</Label>
          <Input
            id={`drm-${tone}`}
            name="drm_id"
            placeholder="DRM-0042"
            required
            maxLength={20}
            autoComplete="off"
          />
        </div>
        <Button
          type="submit"
          disabled={pending}
          className="self-end bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Looking up…" : patient ? "Replace" : "Look up"}
        </Button>
      </form>

      {state && !state.ok ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      {patient ? (
        <div className="mt-4 grid gap-1 text-sm">
          <p className="font-bold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
            {patient.middle_name ? ` ${patient.middle_name}` : ""}
          </p>
          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
            {patient.drm_id} · {patient.birthdate}
            {patient.sex ? ` · ${patient.sex}` : ""}
          </p>
          {patient.merged_into_id ? (
            <p className="mt-1 rounded-md bg-red-100 px-2 py-1 text-xs font-bold text-red-900">
              Already merged. Pick a different DRM-ID.
            </p>
          ) : null}
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-[color:var(--color-brand-text-soft)]">Phone</dt>
            <dd>{patient.phone ?? "—"}</dd>
            <dt className="text-[color:var(--color-brand-text-soft)]">Email</dt>
            <dd className="break-all">{patient.email ?? "—"}</dd>
            <dt className="text-[color:var(--color-brand-text-soft)]">Address</dt>
            <dd>{patient.address ?? "—"}</dd>
            <dt className="text-[color:var(--color-brand-text-soft)]">Visits</dt>
            <dd className="font-mono">{patient.visit_count}</dd>
            <dt className="text-[color:var(--color-brand-text-soft)]">Appts</dt>
            <dd className="font-mono">{patient.appointment_count}</dd>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function ConfirmMerge({
  keep,
  source,
}: {
  keep: PatientPreview | null;
  source: PatientPreview | null;
}) {
  const [state, formAction, pending] = useActionState<
    MergeResult | null,
    FormData
  >(mergePatientsAction, null);

  const ready =
    keep !== null &&
    source !== null &&
    keep.id !== source.id &&
    !keep.merged_into_id &&
    !source.merged_into_id;

  if (state?.ok) {
    return (
      <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-5" role="status">
        <h2 className="font-heading text-lg font-extrabold text-emerald-900">Merge complete</h2>
        <p className="mt-2 text-sm text-emerald-900">
          {state.merged_drm_id} merged into {state.kept_drm_id}. Moved {movedSummary(state.moved)}.
        </p>
        {state.filled.length > 0 ? (
          <p className="mt-1 text-sm text-emerald-900">
            Copied onto {state.kept_drm_id} because it had none: {fieldList(state.filled)}.
          </p>
        ) : null}
        {state.rechained > 0 ? (
          <p className="mt-1 text-sm text-emerald-900">
            {state.rechained === 1
              ? `1 record previously merged into ${state.merged_drm_id} now points at ${state.kept_drm_id}.`
              : `${state.rechained} records previously merged into ${state.merged_drm_id} now point at ${state.kept_drm_id}.`}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-emerald-900">
          The merged-in record stays on file, pointing at {state.kept_drm_id}. You can undo this within 30 days from{" "}
          <Link href="/staff/admin/patient-merge/candidates" className="font-semibold underline">
            Possible duplicates › Recently merged
          </Link>.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Confirm merge
      </h2>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Type <span className="font-mono font-bold">MERGE</span> to confirm. Everything moves in one step — if
        anything is in the way, nothing changes. You can undo a merge within 30 days; details the kept record was
        missing (middle name, sex, phone, email, address, birthdate) are copied from the merged-in record.
      </p>

      <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input type="hidden" name="keep_id" value={keep?.id ?? ""} />
        <input type="hidden" name="source_id" value={source?.id ?? ""} />
        <Input
          name="confirm"
          placeholder="MERGE"
          required
          autoComplete="off"
          className="font-mono"
          disabled={!ready}
        />
        <Button
          type="submit"
          disabled={!ready || pending}
          className="bg-red-600 text-white hover:bg-red-700"
        >
          {pending ? "Merging…" : "Merge"}
        </Button>
      </form>

      {state && !state.ok ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      {!ready ? (
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Look up two distinct, un-merged patients above to enable the
          merge button.
        </p>
      ) : null}
    </section>
  );
}
