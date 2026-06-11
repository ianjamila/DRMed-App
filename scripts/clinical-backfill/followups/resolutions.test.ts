import { describe, it, expect } from "vitest";
import { parseResolutions, buildOverrideMap } from "./resolutions";

const HEAD = `"cluster_key","sheet_name","candidates","decision","target_drm","notes"`;
const csv = (...lines: string[]) => [HEAD, ...lines].join("\n");
const row = (key: string, dec: string, tgt: string, notes = "") =>
  `"${key}","Name","cands","${dec}","${tgt}","${notes}"`;

describe("parseResolutions", () => {
  it("parses SAME / DISTINCT / SKIP", () => {
    const { resolutions, errors } = parseResolutions(csv(
      row("vicencio|robert", "DISTINCT", "DRM-2000"),
      row("daet|zenaida", "SAME", "DRM-3049"),
      row("foo|bar", "SKIP", ""),
    ));
    expect(errors).toEqual([]);
    expect(resolutions).toHaveLength(3);
    expect(resolutions[0]).toMatchObject({ clusterKey: "vicencio|robert", decision: "DISTINCT", targetDrm: "DRM-2000" });
    expect(resolutions[2].decision).toBe("SKIP");
  });

  it("uppercases the decision token and target_drm", () => {
    const { resolutions } = parseResolutions(csv(row("a|b", "same", "drm-1")));
    expect(resolutions[0]).toMatchObject({ decision: "SAME", targetDrm: "DRM-1" });
  });

  it("ignores blank-decision rows (incremental fill) without erroring", () => {
    const { resolutions, errors } = parseResolutions(csv(row("a|b", "", ""), row("c|d", "SAME", "DRM-9")));
    expect(errors).toEqual([]);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].clusterKey).toBe("c|d");
  });

  it("errors on an unknown decision token", () => {
    const { errors } = parseResolutions(csv(row("a|b", "MAYBE", "DRM-1")));
    expect(errors.join()).toMatch(/unknown decision/);
  });

  it("errors when SAME/DISTINCT lacks a target_drm", () => {
    const { errors } = parseResolutions(csv(row("a|b", "SAME", ""), row("c|d", "DISTINCT", "")));
    expect(errors).toHaveLength(2);
    expect(errors.join()).toMatch(/requires a target_drm/);
  });

  it("errors on a duplicate cluster row", () => {
    const { errors } = parseResolutions(csv(row("a|b", "SAME", "DRM-1"), row("a|b", "DISTINCT", "DRM-2")));
    expect(errors.join()).toMatch(/duplicate cluster/);
  });

  it("errors on a missing required column", () => {
    const { errors } = parseResolutions(`"cluster_key","decision"\n"a|b","SAME"`);
    expect(errors.join()).toMatch(/missing column/);
  });

  it("parses cells containing commas (quoted sheet names)", () => {
    const text = `${HEAD}\n"dubongco|arturo","DUBONGCO,ARTURO","x","DISTINCT","DRM-0129",""`;
    const { resolutions } = parseResolutions(text);
    expect(resolutions[0]).toMatchObject({ clusterKey: "dubongco|arturo", sheetName: "DUBONGCO,ARTURO", targetDrm: "DRM-0129" });
  });
});

describe("buildOverrideMap", () => {
  const drmToId = new Map([["DRM-2000", "id-2000"], ["DRM-3049", "id-3049"]]);

  it("maps SAME and DISTINCT to the target id, omits SKIP", () => {
    const { resolutions } = parseResolutions(csv(
      row("vicencio|robert", "DISTINCT", "DRM-2000"),
      row("daet|zenaida", "SAME", "DRM-3049"),
      row("foo|bar", "SKIP", ""),
    ));
    const { overrides, errors } = buildOverrideMap(resolutions, drmToId);
    expect(errors).toEqual([]);
    expect(overrides.get("vicencio|robert")).toBe("id-2000");
    expect(overrides.get("daet|zenaida")).toBe("id-3049");
    expect(overrides.has("foo|bar")).toBe(false);
  });

  it("reports a target DRM that is not a live patient", () => {
    const { resolutions } = parseResolutions(csv(row("x|y", "SAME", "DRM-9999")));
    const { overrides, errors } = buildOverrideMap(resolutions, drmToId);
    expect(overrides.size).toBe(0);
    expect(errors.join()).toMatch(/DRM-9999 not found/);
  });
});
