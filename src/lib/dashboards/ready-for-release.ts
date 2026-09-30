// Hint for the admin "Ready for release" card. `total` = every finished lab
// result waiting to go out; `settled` = those on a paid / waived / HMO visit.
// The difference is what's stuck on payment (the release trigger, 0133).
export function readyForReleaseHint(total: number, settled: number): string {
  const waiting = total - settled;
  return waiting > 0 ? `${waiting} waiting on payment` : "All dates — finished, waiting to go to the patient";
}
