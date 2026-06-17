"use client";
import { useActionState, useState } from "react";
import { recoverDrmIdAction, type RecoverResult } from "./actions";

export function FindMyIdForm() {
  const [state, action, pending] = useActionState<RecoverResult | null, FormData>(recoverDrmIdAction, null);
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [birthdate, setBirthdate] = useState("");

  if (state?.ok) {
    return (
      <p className="rounded-md bg-green-50 p-4 text-sm text-green-800">
        If a record matches those details, we have emailed the DRM-ID to that address. Check your inbox (and spam).
        No email on file? Please visit or call reception.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      <label className="block text-sm">Last name
        <input required name="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm">Email
        <input required type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm">Date of birth
        <input required type="date" name="birthdate" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      {state && !state.ok && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="rounded bg-cyan-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
        {pending ? "Sending…" : "Email me my DRM-ID"}
      </button>
    </form>
  );
}
