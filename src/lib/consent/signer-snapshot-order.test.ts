import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 0162's trigger snapshots a self grant's signer name from the patient row at
// insert. A staff action that saves patient details AND records consent in one
// submission must therefore write the details first — otherwise a name
// corrected in that submission is lost from the consent record for good.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("consent is recorded after the patient row is written", () => {
  it("edit patient: update, then grant", () => {
    const src = read("src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts");
    const update = src.search(/\.from\("patients"\)\s*\.update\(/);
    const grant = src.indexOf("recordConsentGrantAction({");
    expect(update).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(update);
  });

  it("new patient: insert, then grant", () => {
    const src = read("src/app/(staff)/staff/(dashboard)/patients/actions.ts");
    const insert = src.search(/\.from\("patients"\)\s*\.insert\(/);
    const grant = src.indexOf("recordConsentGrantAction({");
    expect(insert).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(insert);
  });
});
