// Does this session still owe a second factor?
//
// One rule for every role: if you have a verified factor you must use it; if
// you have not enrolled one, you are in. Supabase sets nextLevel to "aal2"
// exactly when a verified factor exists, so that field IS the enrolment check.
//
// Enrolment is opt-in on purpose. Nothing in the app can unenroll a verified
// factor, so forcing anyone to enrol makes a lost phone a permanent lockout.
// Staff get their second factor from Google sign-in instead.
export function needsMfaChallenge(input: {
  mfaRequired: boolean;
  currentLevel: string | null;
  nextLevel: string | null;
}): boolean {
  return (
    input.mfaRequired &&
    input.nextLevel === "aal2" &&
    input.currentLevel !== "aal2"
  );
}
