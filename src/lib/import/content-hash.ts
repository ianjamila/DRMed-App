import { createHash } from "node:crypto";

export interface ContentHashInput {
  sourceTab: "LAB SERVICE" | "DOCTOR CONSULTATION";
  normalizedPatientName: string;
  sourceDate: string;            // YYYY-MM-DD
  providerId: string;            // uuid
  serviceId: string;             // uuid
  billedAmount: number;
  referenceNo: string | null;
}

export function contentHash(input: ContentHashInput): string {
  const parts = [
    input.sourceTab,
    input.normalizedPatientName,
    input.sourceDate,
    input.providerId,
    input.serviceId,
    input.billedAmount.toFixed(2),
    input.referenceNo ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
