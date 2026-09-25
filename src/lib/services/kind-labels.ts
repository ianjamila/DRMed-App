import { humaniseCode } from "@/lib/format/humanise-code";
import type { ServiceKind } from "@/lib/validations/service";

/**
 * The words for `services.kind`. The Services form picker and the Daily
 * Revenue report both read this rather than printing "doctor_consultation".
 * Typed against `SERVICE_KINDS`, so a new kind fails typecheck until it has a
 * label. No zod import, so client components can use it.
 */
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  lab_test: "Lab test",
  lab_package: "Lab package",
  doctor_consultation: "Doctor consultation",
  doctor_procedure: "Doctor procedure",
  home_service: "Home service",
  vaccine: "Vaccine",
};

export function serviceKindLabel(kind: string): string {
  return SERVICE_KIND_LABEL[kind as ServiceKind] ?? humaniseCode(kind);
}
