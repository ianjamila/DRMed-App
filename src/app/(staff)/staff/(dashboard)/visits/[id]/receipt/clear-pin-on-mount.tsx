"use client";

import { useEffect, useRef } from "react";
import { clearVisitPinFlashAction } from "./clear-pin-action";

// Fires once on mount to delete the flash cookie that contained the plain PIN.
// Receipt-page reload thereafter shows "Already viewed".
export function ClearPinOnMount() {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void clearVisitPinFlashAction();
  }, []);

  return null;
}
