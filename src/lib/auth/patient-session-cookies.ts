import "server-only";
import { cookies } from "next/headers";
import {
  PATIENT_SESSION_COOKIE_NAME,
  getPatientSessionTtlSeconds,
  verifyPatientSession,
  type PatientSession,
} from "./patient-session";

export async function setPatientSessionCookie(token: string) {
  const c = await cookies();
  c.set(PATIENT_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: getPatientSessionTtlSeconds(),
  });
}

export async function clearPatientSessionCookie() {
  const c = await cookies();
  c.delete(PATIENT_SESSION_COOKIE_NAME);
}

export async function getPatientSession(): Promise<PatientSession | null> {
  const c = await cookies();
  const token = c.get(PATIENT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyPatientSession(token);
}
