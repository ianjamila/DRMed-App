"use server";

import { clearVisitPinFlash } from "@/lib/auth/visit-pin-flash";

export async function clearVisitPinFlashAction(): Promise<void> {
  await clearVisitPinFlash();
}
