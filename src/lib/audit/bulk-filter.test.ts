import { describe, expect, it } from "vitest";
import { BULK_AUDIT_OR, batchAuditOr, batchIdOf, parseBatchParam } from "./bulk-filter";

const B = "44444444-4444-4444-8444-444444444444";

describe("audit bulk filters", () => {
  it("bulk = batch size > 1, a likely-no-show sweep, or any bar action with a batch id", () => {
    expect(BULK_AUDIT_OR).toBe(
      "metadata->bulk_batch_size.gt.1,metadata->bulk_booking_count.gt.1,metadata->>bulk_batch_id.not.is.null",
    );
  });
  it("a batch view shows the batch and its Undo", () => {
    expect(batchAuditOr(B)).toBe(`metadata->>bulk_batch_id.eq.${B},metadata->>undo_of_batch.eq.${B}`);
  });
  it("only a uuid is accepted as a batch param (it reaches a PostgREST filter)", () => {
    expect(parseBatchParam(B)).toBe(B);
    expect(parseBatchParam(`${B},id.gt.0`)).toBeNull();
    expect(parseBatchParam(undefined)).toBeNull();
  });
  it("reads the batch id off a row's metadata", () => {
    expect(batchIdOf({ bulk_batch_id: B })).toBe(B);
    expect(batchIdOf({ bulk_batch_id: 3 })).toBeNull();
    expect(batchIdOf(null)).toBeNull();
  });
});
