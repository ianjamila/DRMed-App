// Pure helpers for the "doctor's request form instead of itemized tests"
// booking path. No server-only imports — safe to unit-test and to import from
// the booking Server Action.

export type IntakePreference = "walk_in" | "callback";

export function labRequestStatus(pref: IntakePreference): {
  status: "confirmed" | "pending_callback";
  pendingCallback: boolean;
} {
  return pref === "callback"
    ? { status: "pending_callback", pendingCallback: true }
    : { status: "confirmed", pendingCallback: false };
}

export function validateLabRequestGate(input: {
  serviceCount: number;
  hasForm: boolean;
  preference: IntakePreference | null;
}): { ok: true } | { ok: false; error: string } {
  // Picking tests is OPTIONAL — a patient may book with nothing itemized and
  // sort the details with reception (walk-in friendly). The only remaining
  // rule is that an uploaded form still needs a walk-in/confirm preference.
  if (input.hasForm && input.preference === null) {
    return {
      ok: false,
      error: "Tell us whether you'll walk in or want us to confirm first.",
    };
  }
  return { ok: true };
}

export function parseIntakePreference(raw: unknown): IntakePreference | null {
  return raw === "walk_in" || raw === "callback" ? raw : null;
}
