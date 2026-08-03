// Pure helpers for the doctor consult/procedure fee split. No server-only
// imports so this is unit-testable. Shared by the visit form (defaults for
// display) and the visit-creation action (authoritative snapshot).

/**
 * Clinic's cut of a doctor fee.
 *
 * `clinicCutPhp` is the physician's per-doctor override (partner revisions
 * item — physicians.clinic_cut_php). When it's a finite number ≥ 0 it wins
 * outright; otherwise (null/undefined/negative/NaN) this falls back to the
 * arrangement-based default it has always used.
 */
export function defaultClinicFee(
  arrangement: string | undefined | null,
  clinicCutPhp?: number | null,
): number {
  if (Number.isFinite(clinicCutPhp) && (clinicCutPhp as number) >= 0) {
    return clinicCutPhp as number;
  }
  if (arrangement === "rent_paying" || arrangement === "shareholder") return 0;
  return 100; // pf_split (and unknown) → clinic keeps ₱100
}

interface DoctorLineBaseInput {
  kind: string;
  /** Raw counter-typed fee (`consult_fee__…` / `procedure_fee__…`). */
  typedRaw: string;
  /** Catalog price for the line, already resolved cash-vs-HMO by the caller. */
  catalogPrice: number;
}

/**
 * Base price of one order line before discounts.
 *
 * Both doctor kinds are priced at the counter (partner revisions item 3) —
 * the catalog row exists to name the service, not to fix its price. They
 * differ in what an EMPTY box means:
 *
 * - `doctor_consultation` — blank is ₱0. Consultation services carry no
 *   meaningful catalog price, and the create action rejects a ₱0 consult
 *   outright, so a blank box surfaces as "enter a fee" rather than silently
 *   billing a number nobody typed.
 * - `doctor_procedure` — blank falls back to the catalog price. Procedures
 *   are admin-entered services WITH a real price; the free-entry box is an
 *   override for the ones that vary by case, not a demand to retype the usual
 *   amount every visit.
 *
 * Everything else (lab tests, packages, imaging) ignores the typed value.
 */
export function doctorLineBase({
  kind,
  typedRaw,
  catalogPrice,
}: DoctorLineBaseInput): number {
  if (kind !== "doctor_consultation" && kind !== "doctor_procedure") {
    return catalogPrice;
  }
  const fallback = kind === "doctor_consultation" ? 0 : catalogPrice;
  if (typedRaw.trim() === "") return fallback;
  const typed = Number(typedRaw);
  return Number.isFinite(typed) && typed >= 0 ? typed : fallback;
}

interface SplitInput {
  finalPrice: number;
  arrangement: string | undefined | null;
  clinicFeeRaw: string; // raw form value; "" means "use the default"
  doctorPfRaw: string;  // raw form value; "" means "remainder"
  /** Per-doctor clinic-cut override (physicians.clinic_cut_php). */
  clinicCutPhp?: number | null;
}

/**
 * Split a doctor line's final price into clinic_fee + doctor_pf.
 * Empty/invalid clinic-fee input falls back to the default — the per-doctor
 * clinicCutPhp override when set, else the arrangement default; empty/invalid
 * PF input falls back to (final − clinic fee), floored at 0.
 */
export function splitDoctorFee({
  finalPrice,
  arrangement,
  clinicFeeRaw,
  doctorPfRaw,
  clinicCutPhp,
}: SplitInput): { clinic_fee_php: number; doctor_pf_php: number } {
  const cfDefault = defaultClinicFee(arrangement, clinicCutPhp);
  const cfNum = clinicFeeRaw.trim() === "" ? cfDefault : Number(clinicFeeRaw);
  const clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : cfDefault;

  const pfDefault = Math.max(0, finalPrice - clinic_fee_php);
  const pfNum = doctorPfRaw.trim() === "" ? pfDefault : Number(doctorPfRaw);
  const doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;

  return { clinic_fee_php, doctor_pf_php };
}
