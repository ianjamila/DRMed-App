import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The bulk claim / unclaim / delete bodies live in bulk-cores.ts, a plain
// server-only module that takes a batch context. The only public "use server"
// entry points that run them are the bulk bar's three *QueueSelectionAction in
// queue/panel-actions.ts (the former per-kind wrappers had no caller left and
// were removed — an unused public endpoint is attack surface); they mint that
// context. Modules importing "server-only" can't be
// imported under vitest, so — like actions.undo-reversal.test.ts — this pins
// the source text: it is the only place the rule "a browser can never supply
// a batch id" is checked.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const coresSrc = read("src/lib/actions/queue/bulk-cores.ts");
const deleteCoreSrc = read("src/lib/actions/queue/bulk-delete-core.ts");
const actionsSrc = read("src/app/(staff)/staff/(dashboard)/queue/actions.ts");
const deletionSrc = read("src/lib/actions/visits/queue-deletion.ts");
const panelActionsSrc = read("src/app/(staff)/staff/(dashboard)/queue/panel-actions.ts");

/** From `export async function name(` up to the next top-level export (or EOF). */
function bodyOf(src: string, fnName: string): string {
  const start = src.indexOf(`export async function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

/** A top-level `const NAME = …;` statement, up to the blank line that ends it. */
function constOf(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n\n", start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

describe("the bulk core modules are plain server-only modules", () => {
  for (const [name, src] of [
    ["bulk-cores.ts", coresSrc],
    ["bulk-delete-core.ts", deleteCoreSrc],
  ] as const) {
    it(`${name} starts with import "server-only" and is never a "use server" file`, () => {
      expect(src.startsWith('import "server-only";')).toBe(true);
      expect(src).not.toMatch(/^\s*["']use server["']/m);
    });
  }

  it("bulk-delete-core.ts takes the batch context as a type import only", () => {
    expect(deleteCoreSrc).toMatch(/import type \{ BulkBatchContext \} from "@\/lib\/actions\/queue\/bulk-cores"/);
  });

  it("exports no BulkBatchContext through a use-server file", () => {
    for (const src of [actionsSrc, deletionSrc, panelActionsSrc]) {
      expect(src).toMatch(/^"use server";/);
      // panel-actions.ts imports the TYPE (erased at build); none may re-export it.
      expect(src).not.toMatch(/export\s[^;]*BulkBatchContext/);
      expect(src).not.toMatch(/export\s*\{[^}]*BulkBatchContext/);
    }
  });
});

describe("the bulk bar's public actions mint the batch id themselves", () => {
  const cases = [
    { name: "claimQueueSelectionAction", core: "claimTestsCore(", schema: "ClaimSelectionSchema" },
    { name: "unclaimQueueSelectionAction", core: "unclaimTestsCore(", schema: "UnclaimSelectionSchema" },
    { name: "deleteQueueSelectionAction", core: "deleteTestRequestsManyCore(", schema: "DeleteSelectionSchema" },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      const body = bodyOf(panelActionsSrc, c.name);

      it("mints crypto.randomUUID() exactly once and passes that context to its core", () => {
        expect(body.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1);
        expect(body).toContain(c.core);
        expect(body).toMatch(/batchId:\s*crypto\.randomUUID\(\)/);
        expect(body).toMatch(/batchSize:/);
      });

      it("has a zod schema with no batch-id or panel-key field", () => {
        const schema = constOf(panelActionsSrc, c.schema);
        expect(schema).not.toMatch(/batchId|batch_id|bulk_batch|panelKey|panel_key/);
      });

      it("does not write audit rows itself (the cores and panel writes do)", () => {
        expect(body).not.toContain("audit(");
        expect(body).not.toMatch(/bulk_batch_id/);
      });
    });
  }

  it("the panel schemas carry no batch-id or panel-key field either", () => {
    const panelSchemas = constOf(panelActionsSrc, "PanelSchema");
    expect(panelSchemas).not.toMatch(/batchId|batch_id|bulk_batch|panelKey|panel_key/);
  });

  it("the removed per-kind wrappers are gone from the use-server files", () => {
    for (const name of ["claimTestsAction", "unclaimTestsAction", "deleteTestRequestsManyAction"]) {
      for (const src of [actionsSrc, deletionSrc, panelActionsSrc]) {
        expect(src).not.toContain(`export async function ${name}(`);
      }
    }
  });

  it("claimPanelAction (the row button) mints its own one-panel batch, never from the input", () => {
    const body = bodyOf(panelActionsSrc, "claimPanelAction");
    expect(body).toContain("claimPanelMembers(");
    expect(body.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1);
    expect(body).toMatch(/batchId,\s*batchSize:\s*1,\s*panelKey:\s*key/);
    expect(body).toMatch(/ok:\s*true,\s*batchId/);
    expect(constOf(panelActionsSrc, "PanelSchema")).not.toMatch(/batchId|batch_id|bulk_batch|panelKey|panel_key/);
  });
});

describe("the cores take the batch context and write it", () => {
  it("claimTestsCore writes bulk_batch_id / bulk_batch_size from ctx and returns ctx.batchId", () => {
    const body = bodyOf(coresSrc, "claimTestsCore");
    expect(body).toMatch(/bulk_batch_id:\s*ctx\.batchId/);
    expect(body).toMatch(/bulk_batch_size:\s*ctx\.batchSize/);
    expect(body).toMatch(/batchId:\s*ctx\.batchId\s*\}/);
    expect(body).not.toContain("randomUUID");
  });

  it("unclaimTestsCore writes bulk_batch_id / bulk_batch_size from ctx and returns ctx.batchId", () => {
    const body = bodyOf(coresSrc, "unclaimTestsCore");
    expect(body).toMatch(/bulk_batch_id:\s*ctx\.batchId/);
    expect(body).toMatch(/bulk_batch_size:\s*ctx\.batchSize/);
    expect(body).toMatch(/batchId:\s*ctx\.batchId\s*\}/);
    expect(body).not.toContain("randomUUID");
  });

  it("deleteTestRequestsManyCore hands ctx.batchId / batchSize to every per-visit delete and returns ctx.batchId", () => {
    const body = bodyOf(deleteCoreSrc, "deleteTestRequestsManyCore");
    expect(body).toMatch(/batchId:\s*ctx\.batchId/);
    expect(body).toMatch(/size:\s*ctx\.batchSize/);
    expect(body).toMatch(/panelKey:\s*ctx\.panelKey/);
    expect(body).toMatch(/ok:\s*true,\s*changedIds,\s*skipped,\s*batchId:\s*ctx\.batchId/);
    expect(body).not.toContain("randomUUID");
  });

  it("deleteTestRequestsForVisit writes bulk_batch_id and a conditional panel_key from the batch audit", () => {
    const body = bodyOf(deleteCoreSrc, "deleteTestRequestsForVisit");
    expect(body).toMatch(/bulk_batch_id:\s*bulk\.batchId/);
    expect(body).toMatch(/\.\.\.\(bulk\.panelKey\s*\?\s*\{\s*panel_key:\s*bulk\.panelKey\s*\}\s*:\s*\{\}\)/);
  });

  it("each core re-checks the role itself, so a direct call cannot skip the refusal", () => {
    for (const fn of ["claimTestsCore", "unclaimTestsCore"]) {
      const body = bodyOf(coresSrc, fn);
      expect(body, fn).toMatch(/LAB_CAPABLE_ROLES as readonly string\[\]\)\.includes\(session\.role\)/);
      expect(body, fn).toContain("NOT_LAB_STAFF");
    }
    const del = bodyOf(deleteCoreSrc, "deleteTestRequestsManyCore");
    expect(del).toMatch(/QUEUE_DELETE_ROLES\.has\(session\.role\)/);
    // The reason is re-validated in the core too, before any read.
    expect(del.indexOf("parseQueueDeleteReason(")).toBeGreaterThan(-1);
    expect(del.indexOf("parseQueueDeleteReason(")).toBeLessThan(del.indexOf("createAdminClient()"));
  });
});
