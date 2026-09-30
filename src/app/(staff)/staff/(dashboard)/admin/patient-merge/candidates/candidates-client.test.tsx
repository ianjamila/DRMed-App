import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, useActionState: (_fn: unknown, init: unknown) => [init, () => undefined, false] };
});
vi.mock("../actions", () => ({ mergeCandidateAction: vi.fn(), undoMergeAction: vi.fn() }));

import { CandidatesClient } from "./candidates-client";
import type { RecentMerge } from "../actions";

const row = (over: Partial<RecentMerge>): RecentMerge => ({
  id: "m1", keep_id: "k1", source_id: "s1", keep_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
  keep_deleted_at: null, keep_merged_into_id: null, merged_at: "2026-09-30T06:40:47Z", legacy: false,
  undoable: true, interrupted: false, blocked_reason: null, ...over,
});

describe("Recently merged list", () => {
  it("offers Undo on an undoable merge", () => {
    const html = renderToStaticMarkup(<CandidatesClient pairs={[]} recent={[row({})]} />);
    expect(html).toContain("DRM-0002 → DRM-0001");
    expect(html).toContain(">Undo<");
  });
  it("explains why Undo is unavailable and badges a deleted kept record", () => {
    const html = renderToStaticMarkup(
      <CandidatesClient pairs={[]} recent={[row({ undoable: false, keep_deleted_at: "2026-09-30T08:00:00Z",
        blocked_reason: "The kept record has since been deleted — restore it first." })]} />,
    );
    expect(html).not.toContain(">Undo<");
    expect(html).toContain("The kept record has since been deleted — restore it first.");
    expect(html).toContain("Deleted record");
  });
  it("labels an interrupted undo as needing to be finished", () => {
    const html = renderToStaticMarkup(<CandidatesClient pairs={[]} recent={[row({ legacy: true, interrupted: true })]} />);
    expect(html).toContain("Undo was interrupted — finish it");
    expect(html).toContain(">Finish undo<");
  });
});
