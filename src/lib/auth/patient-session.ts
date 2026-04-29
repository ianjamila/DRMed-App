// No `server-only` here — middleware (Edge runtime) imports verifyPatientSession.
// Keep this file pure JWT logic; cookie helpers live in patient-session-cookies.ts.
import { SignJWT, jwtVerify } from "jose";

export const PATIENT_SESSION_COOKIE_NAME = "drmed_patient_session";
const ALG = "HS256";
const ISSUER = "drmed.ph";

export interface PatientSession {
  patient_id: string;
  drm_id: string;
  visit_id: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.PATIENT_SESSION_SECRET;
  if (!secret) throw new Error("PATIENT_SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export function getPatientSessionTtlSeconds(): number {
  const minutes = parseInt(
    process.env.PATIENT_SESSION_TTL_MINUTES ?? "30",
    10,
  );
  return minutes * 60;
}

export async function mintPatientSession(
  payload: PatientSession,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${getPatientSessionTtlSeconds()}s`)
    .sign(getSecret());
}

export async function verifyPatientSession(
  token: string,
): Promise<PatientSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      algorithms: [ALG],
    });
    if (
      typeof payload.patient_id !== "string" ||
      typeof payload.drm_id !== "string" ||
      typeof payload.visit_id !== "string"
    ) {
      return null;
    }
    return {
      patient_id: payload.patient_id,
      drm_id: payload.drm_id,
      visit_id: payload.visit_id,
    };
  } catch {
    return null;
  }
}
