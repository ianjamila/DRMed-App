// src/lib/consent/types.ts
export type ConsentMethod =
  | "paper_wet_signature"
  | "onscreen_signature"
  | "portal_acceptance"
  | "self_registration";

export type ConsentSignatory = "self" | "guardian" | "representative";

export interface ConsentGrantInput {
  patientId: string;
  method: ConsentMethod;
  signatory: ConsentSignatory;
  signatoryName?: string | null;
  signatoryRelationship?: string | null;
  artifactPath?: string | null;
}
