import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The bulk claim / unclaim / delete bodies live in bulk-cores.ts, a plain
// server-only module that takes a batch context. The public "use server"
// entry points mint that context. Modules importing "server-only" can't be
// imported under vitest, so — like actions.undo-reversal.test.ts — this pins
// the source text: it is the only place the rule "a browser can never supply
// a batch id" is checked.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const coresSrc = read("src/lib/actions/queue/bulk-cores.ts");
const actionsSrc = read("src/app/(staff)/staff/(dashboard)/queue/actions.ts");
const deletionSrc = read("src/lib/actions/visits/queue-deletion.ts");

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

describe("bulk-cores.ts is a plain server-only module", () => {
  it('starts with import "server-only" and is never a "use server" file', () => {
    expect(coresSrc.startsWith('import "server-only";')).toBe(true);
    expect(coresSrc).not.toMatch(/^\s*["']use server["']/m);
  });

  it("exports no BulkBatchContext through a use-server file", () => {
    for (const src of [actionsSrc, deletionSrc]) {
      expect(src).toMatch(/^"use server";/);
      expect(src).not.toContain("BulkBatchContext");
    }
  });
});

describe("the public wrappers mint the batch id themselves", () => {
  const cases = [
    {
      name: "claimTestsAction",
      src: actionsSrc,
      core: "claimTestsCore(",
      schema: "BulkClaimSchema",
    },
    {
      name: "unclaimTestsAction",
      src: actionsSrc,
      core: "unclaimTestsCore(",
      schema: "BulkUnclaimSchema",
    },
    {
      name: "deleteTestRequestsManyAction",
      src: deletionSrc,
      core: "deleteTestRequestsManyCore(",
      schema: "ManyDeleteSchema",
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      const body = bodyOf(c.src, c.name);

      it("mints crypto.randomUUID() and passes it to its core", () => {
        expect(body).toContain("crypto.randomUUID()");
        expect(body).toContain(c.core);
        expect(body).toMatch(/\{\s*batchId,\s*batchSize\b/);
      });

      it("has a zod schema with no batch-id field", () => {
        const schema = constOf(c.src, c.schema);
        expect(schema).not.toMatch(/batchId|batch_id|bulk_batch/);
      });

      it("does not write audit rows itself (the core does)", () => {
        expect(body).not.toContain("audit(");
        expect(body).not.toMatch(/bulk_batch_id/);
      });
    });
  }
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
    const body = bodyOf(coresSrc, "deleteTestRequestsManyCore");
    expect(body).toMatch(/batchId:\s*ctx\.batchId/);
    expect(body).toMatch(/size:\s*ctx\.batchSize/);
    expect(body).toMatch(/panelKey:\s*ctx\.panelKey/);
    expect(body).toMatch(/ok:\s*true,\s*changedIds,\s*skipped,\s*batchId:\s*ctx\.batchId/);
    expect(body).not.toContain("randomUUID");
  });

  it("deleteTestRequestsForVisit writes bulk_batch_id and a conditional panel_key from the batch audit", () => {
    const body = bodyOf(coresSrc, "deleteTestRequestsForVisit");
    expect(body).toMatch(/bulk_batch_id:\s*bulk\.batchId/);
    expect(body).toMatch(/\.\.\.\(bulk\.panelKey\s*\?\s*\{\s*panel_key:\s*bulk\.panelKey\s*\}\s*:\s*\{\}\)/);
  });

  it("each core re-checks the role itself, so a direct call cannot skip the refusal", () => {
    for (const fn of ["claimTestsCore", "unclaimTestsCore"]) {
      const body = bodyOf(coresSrc, fn);
      expect(body, fn).toMatch(/LAB_CAPABLE_ROLES as readonly string\[\]\)\.includes\(session\.role\)/);
      expect(body, fn).toContain("NOT_LAB_STAFF");
    }
    const del = bodyOf(coresSrc, "deleteTestRequestsManyCore");
    expect(del).toMatch(/QUEUE_DELETE_ROLES\.has\(session\.role\)/);
    // The reason is re-validated in the core too, before any read.
    expect(del.indexOf("parseQueueDeleteReason(")).toBeGreaterThan(-1);
    expect(del.indexOf("parseQueueDeleteReason(")).toBeLessThan(del.indexOf("createAdminClient()"));
  });
});
