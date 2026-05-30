// Pure helpers for the doctor consult/procedure fee split. No server-only
// imports so this is unit-testable. Shared by the visit form (defaults for
// display) and the visit-creation action (authoritative snapshot).

/** Clinic's cut of a doctor fee, defaulted from the physician's arrangement. */
export function defaultClinicFee(arrangement: string | undefined | null): number {
  if (arrangement === "rent_paying" || arrangement === "shareholder") return 0;
  return 100; // pf_split (and unknown) → clinic keeps ₱100
}

interface SplitInput {
  finalPrice: number;
  arrangement: string | undefined | null;
  clinicFeeRaw: string; // raw form value; "" means "use the default"
  doctorPfRaw: string;  // raw form value; "" means "remainder"
}

/**
 * Split a doctor line's final price into clinic_fee + doctor_pf.
 * Empty/invalid clinic-fee input falls back to the arrangement default;
 * empty/invalid PF input falls back to (final − clinic fee), floored at 0.
 */
export function splitDoctorFee({
  finalPrice,
  arrangement,
  clinicFeeRaw,
  doctorPfRaw,
}: SplitInput): { clinic_fee_php: number; doctor_pf_php: number } {
  const cfDefault = defaultClinicFee(arrangement);
  const cfNum = clinicFeeRaw.trim() === "" ? cfDefault : Number(clinicFeeRaw);
  const clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : cfDefault;

  const pfDefault = Math.max(0, finalPrice - clinic_fee_php);
  const pfNum = doctorPfRaw.trim() === "" ? pfDefault : Number(doctorPfRaw);
  const doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;

  return { clinic_fee_php, doctor_pf_php };
}
