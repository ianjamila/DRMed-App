import { describe, it, expect } from "vitest";
import { buildServiceIndex, mapService, type CatalogService } from "./service-map";

const catalog: CatalogService[] = [
  { id: "lab-cbc", code: "CBC", name: "Complete Blood Count", kind: "lab_test", is_active: true },
  { id: "lab-fbs", code: "FBS", name: "Fasting Blood Sugar", kind: "lab_test", is_active: true },
  { id: "consult", code: "CONSULT", name: "Consultation", kind: "doctor_consultation", is_active: true },
];
const idx = buildServiceIndex(catalog);

describe("mapService", () => {
  it("consult rows always resolve to the CONSULT anchor", () => {
    expect(mapService("Pedia consult", true, idx)).toEqual({ service_id: "consult", matched: true });
  });
  it("lab rows match by normalized name", () => {
    expect(mapService("complete blood count", false, idx)).toEqual({ service_id: "lab-cbc", matched: true });
  });
  it("lab rows match by code", () => {
    expect(mapService("CBC", false, idx)).toEqual({ service_id: "lab-cbc", matched: true });
  });
  it("unmatched lab falls back to the generic legacy service", () => {
    expect(mapService("Some weird sendout", false, idx)).toEqual({ service_id: idx.legacyLabId, matched: false });
  });
});
