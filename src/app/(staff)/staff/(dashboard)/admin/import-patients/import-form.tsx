"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StableTextarea } from "@/components/forms/stable-fields";
import { importPatientsAction, type ImportResult } from "./actions";

const SAMPLE = `first_name,last_name,middle_name,birthdate,sex,phone,email,address
Maria,Santos,,1985-03-12,female,+639171234567,maria@example.com,Quezon City
Juan,dela Cruz,Reyes,1972-11-08,male,,,Sampaloc Manila
Ana,Lim,,1990/06/22,F,0917 555 0102,,`;

export function ImportPatientsForm() {
  const [state, formAction, pending] = useActionState<
    ImportResult | null,
    FormData
  >(importPatientsAction, null);

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="csv">CSV</Label>
        <StableTextarea
          id="csv"
          name="csv"
          rows={14}
          required
          defaultValue={SAMPLE}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 font-mono text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Required columns: <code>first_name</code>, <code>last_name</code>,{" "}
          <code>birthdate</code>. Optional: <code>middle_name</code>,{" "}
          <code>sex</code> (male/female/M/F), <code>phone</code>,{" "}
          <code>email</code>, <code>address</code>. Up to 2000 rows.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="pre_registered"
          defaultChecked
        />
        <span>
          Mark imported rows as pre-registered (reception verifies on next
          visit)
        </span>
      </label>

      <Button
        type="submit"
        disabled={pending}
        className="w-fit bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        {pending ? "Importing…" : "Import"}
      </Button>

      {state ? <ResultPanel state={state} /> : null}
    </form>
  );
}

function ResultPanel({ state }: { state: ImportResult }) {
  if (!state.ok) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p className="font-bold">Import failed</p>
        <p className="mt-1">{state.error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4">
      <p className="font-bold text-[color:var(--color-brand-navy)]">
        ✓ {state.imported} patient{state.imported === 1 ? "" : "s"} imported
        {state.skipped > 0 ? `, ${state.skipped} skipped` : ""}
      </p>
      {state.errors.length > 0 ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-semibold text-red-700">
            {state.errors.length} skipped row{state.errors.length === 1 ? "" : "s"}{" "}
            (click to expand)
          </summary>
          <ul className="mt-2 max-h-64 overflow-y-auto space-y-1">
            {state.errors.map((e) => (
              <li key={e.row} className="font-mono text-[11px] text-red-800">
                Row {e.row}: {e.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
