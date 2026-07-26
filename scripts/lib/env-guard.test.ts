import { describe, expect, it } from "vitest";
import { sep } from "node:path";

import {
  classifyTargets,
  evaluateEnvGuard,
  findMainWorktreeRoot,
  formatBlockMessage,
  formatLoadSummary,
  formatProdWarning,
  hostOf,
  isLocalHost,
  planEnvFiles,
  readProdOptIn,
  supabaseProjectRef,
  type EnvFileIo,
} from "./env-guard";

const PROD_URL = "https://qhptbmafrosgibooelpp.supabase.co";
const LOCAL_URL = "http://127.0.0.1:54321";

/** In-memory fs for the env-file resolution tests. */
function io(files: Record<string, string | null>): EnvFileIo {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readText: (path) => files[path] ?? null,
  };
}

describe("isLocalHost", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "app.localhost",
    "::1",
    "0:0:0:0:0:0:0:1",
    "host.docker.internal",
    "supabase_kong",
    "supabase_kong_DRMed",
    "supabase_db_DRMed",
  ])("treats %s as local", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each([
    "qhptbmafrosgibooelpp.supabase.co",
    "aws-0-ap-southeast-1.pooler.supabase.com",
    "drmed.ph",
    "128.0.0.1",
    "1270.0.1",
  ])("treats %s as remote", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it("does not fall for a remote host that merely contains 'localhost'", () => {
    // The original guard used url.includes("localhost"), which this defeats.
    expect(isLocalHost("localhost.attacker.example")).toBe(false);
    expect(hostOf("https://localhost.attacker.example/x")).toBe(
      "localhost.attacker.example",
    );
  });

  it("fails closed on missing or unparseable hosts", () => {
    expect(isLocalHost(null)).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
    expect(isLocalHost("")).toBe(false);
  });
});

describe("hostOf", () => {
  it("parses https and postgres URLs alike", () => {
    expect(hostOf(PROD_URL)).toBe("qhptbmafrosgibooelpp.supabase.co");
    expect(hostOf("postgresql://postgres:pw@127.0.0.1:54322/postgres")).toBe(
      "127.0.0.1",
    );
    expect(
      hostOf("postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"),
    ).toBe("aws-0-ap-southeast-1.pooler.supabase.com");
  });

  it("returns null for junk rather than throwing", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("supabaseProjectRef", () => {
  it("extracts the ref from a hosted project URL", () => {
    expect(supabaseProjectRef("qhptbmafrosgibooelpp.supabase.co")).toBe(
      "qhptbmafrosgibooelpp",
    );
  });
  it("is null for local and unrelated hosts", () => {
    expect(supabaseProjectRef("127.0.0.1")).toBeNull();
    expect(supabaseProjectRef("drmed.ph")).toBeNull();
    expect(supabaseProjectRef(null)).toBeNull();
  });

  it("does not mistake a pooler REGION for a project ref", () => {
    // aws-0-ap-southeast-1 is the region; the ref lives in the username.
    expect(supabaseProjectRef("aws-0-ap-southeast-1.pooler.supabase.com")).toBeNull();
  });
});

describe("classifyTargets", () => {
  it("ignores unset and blank vars", () => {
    expect(classifyTargets({})).toEqual([]);
    expect(classifyTargets({ NEXT_PUBLIC_SUPABASE_URL: "   " })).toEqual([]);
  });

  it("classifies both the REST and the direct Postgres target", () => {
    const targets = classifyTargets({
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
      SUPABASE_DB_URL: "postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres",
    });
    expect(targets.map((t) => [t.varName, t.isLocal])).toEqual([
      ["NEXT_PUBLIC_SUPABASE_URL", true],
      ["SUPABASE_DB_URL", false],
    ]);
  });
});

describe("readProdOptIn", () => {
  it("accepts SEED_ALLOW_PROD=1 and --prod, and records which", () => {
    expect(readProdOptIn({ SEED_ALLOW_PROD: "1" }, [])).toEqual({
      prodOptIn: true,
      optInVia: "SEED_ALLOW_PROD=1",
    });
    expect(readProdOptIn({}, ["node", "x.ts", "--prod"])).toEqual({
      prodOptIn: true,
      optInVia: "--prod",
    });
  });

  it("ignores near-misses", () => {
    expect(readProdOptIn({ SEED_ALLOW_PROD: "true" }, []).prodOptIn).toBe(false);
    expect(readProdOptIn({ SEED_ALLOW_PROD: "0" }, []).prodOptIn).toBe(false);
    expect(readProdOptIn({}, ["--production"]).prodOptIn).toBe(false);
  });
});

describe("evaluateEnvGuard", () => {
  it("allows a fully local target with no opt-in", () => {
    const d = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL },
      argv: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.nonLocal).toEqual([]);
  });

  it("blocks a remote target with no opt-in", () => {
    const d = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
      argv: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.blockReason).toBe("non-local");
    expect(d.nonLocal[0].projectRef).toBe("qhptbmafrosgibooelpp");
  });

  it("allows a remote target once opted in", () => {
    const d = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, SEED_ALLOW_PROD: "1" },
      argv: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.nonLocal).toHaveLength(1);
  });

  it("blocks when the REST target is local but the direct DB URL is not", () => {
    // The wipe/TRUNCATE path connects over SUPABASE_DB_URL, not REST — a guard
    // that only looked at NEXT_PUBLIC_SUPABASE_URL would wave this through.
    const d = evaluateEnvGuard({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
        SUPABASE_DB_URL:
          "postgresql://postgres:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
      },
      argv: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.nonLocal.map((t) => t.varName)).toEqual(["SUPABASE_DB_URL"]);
  });

  it("blocks when nothing is configured at all", () => {
    const d = evaluateEnvGuard({ env: {}, argv: [] });
    expect(d.allowed).toBe(false);
    expect(d.blockReason).toBe("unconfigured");
  });

  it("blocks an unparseable target even though it is not obviously remote", () => {
    const d = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: "127.0.0.1:54321" }, // no scheme
      argv: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.nonLocal[0].host).toBeNull();
  });

  it("does not let an opt-in mask a missing configuration", () => {
    const d = evaluateEnvGuard({ env: { SEED_ALLOW_PROD: "1" }, argv: [] });
    expect(d.allowed).toBe(false);
    expect(d.blockReason).toBe("unconfigured");
  });
});

describe("message formatting", () => {
  const blocked = evaluateEnvGuard({
    env: { NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
    argv: [],
  });

  it("names the host, the project and both opt-in forms when blocking", () => {
    const msg = formatBlockMessage("seed:services", blocked);
    expect(msg).toContain("qhptbmafrosgibooelpp.supabase.co");
    expect(msg).toContain("project qhptbmafrosgibooelpp");
    expect(msg).toContain("SEED_ALLOW_PROD=1 npm run seed:services");
    expect(msg).toContain("npm run seed:services -- --prod");
  });

  it("names the host, the writes and the opt-in in the prod banner", () => {
    const allowed = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, SEED_ALLOW_PROD: "1" },
      argv: [],
    });
    const msg = formatProdWarning(
      "seed:services",
      allowed,
      "upserts `services` rows (prices, active flags)",
    );
    expect(msg).toContain("NON-LOCAL DATABASE");
    expect(msg).toContain("qhptbmafrosgibooelpp.supabase.co");
    expect(msg).toContain("upserts `services` rows");
    expect(msg).toContain("SEED_ALLOW_PROD=1");
  });

  it("says so plainly when a script has not declared its writes", () => {
    const allowed = evaluateEnvGuard({
      env: { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, SEED_ALLOW_PROD: "1" },
      argv: [],
    });
    expect(formatProdWarning("x", allowed, undefined)).toContain(
      "does not declare what it writes",
    );
  });
});

describe("findMainWorktreeRoot", () => {
  const root = `${sep}repo`;
  const worktree = `${sep}repo${sep}.worktrees${sep}feature`;

  it("returns cwd when .git is a directory", () => {
    expect(
      findMainWorktreeRoot(root, io({ [`${root}${sep}.git`]: null })),
    ).toBe(root);
  });

  it("resolves the main root from a linked worktree's .git file", () => {
    const gitdir = `${root}${sep}.git${sep}worktrees${sep}feature`;
    expect(
      findMainWorktreeRoot(
        worktree,
        io({ [`${worktree}${sep}.git`]: `gitdir: ${gitdir}\n` }),
      ),
    ).toBe(root);
  });

  it("returns null outside a repo, and for a .git file it cannot parse", () => {
    expect(findMainWorktreeRoot(root, io({}))).toBeNull();
    expect(
      findMainWorktreeRoot(root, io({ [`${root}${sep}.git`]: "garbage" })),
    ).toBeNull();
  });
});

describe("planEnvFiles", () => {
  const cwd = `${sep}repo`;
  const dev = `${cwd}${sep}.env.development.local`;
  const prod = `${cwd}${sep}.env.local`;

  it("defaults to the local file, layered over .env.local for the rest", () => {
    const plan = planEnvFiles({
      cwd,
      env: {},
      argv: [],
      io: io({ [dev]: "", [prod]: "" }),
    });
    expect(plan.source).toBe("default");
    // Earlier wins under Node's loader, so the LOCAL file must come first.
    expect(plan.files.map((f) => f.path)).toEqual([dev, prod]);
    expect(plan.files[0].role).toBe("primary");
  });

  it("still resolves when only the local file exists", () => {
    const plan = planEnvFiles({ cwd, env: {}, argv: [], io: io({ [dev]: "" }) });
    expect(plan.files.map((f) => f.path)).toEqual([dev]);
  });

  it("loads .env.local ALONE when opting in to prod", () => {
    const plan = planEnvFiles({
      cwd,
      env: { SEED_ALLOW_PROD: "1" },
      argv: [],
      io: io({ [dev]: "", [prod]: "" }),
    });
    expect(plan.source).toBe("prod-opt-in");
    expect(plan.files.map((f) => f.path)).toEqual([prod]);
  });

  it("honours --prod the same way as SEED_ALLOW_PROD", () => {
    const plan = planEnvFiles({
      cwd,
      env: {},
      argv: ["node", "seed.ts", "--prod"],
      io: io({ [dev]: "", [prod]: "" }),
    });
    expect(plan.files.map((f) => f.path)).toEqual([prod]);
  });

  it("falls back to the main worktree's env file from inside a worktree", () => {
    // None of this repo's worktrees carry their own .env.development.local.
    const wt = `${sep}repo${sep}.worktrees${sep}feature`;
    const plan = planEnvFiles({
      cwd: wt,
      env: {},
      argv: [],
      io: io({
        [`${wt}${sep}.git`]: `gitdir: ${sep}repo${sep}.git${sep}worktrees${sep}feature`,
        [dev]: "",
      }),
    });
    expect(plan.files.map((f) => f.path)).toEqual([dev]);
    expect(plan.searched).toContain(`${wt}${sep}.env.development.local`);
  });

  it("uses DRMED_ENV_FILE alone, without layering", () => {
    const custom = `${sep}elsewhere${sep}staging.env`;
    const plan = planEnvFiles({
      cwd,
      env: { DRMED_ENV_FILE: custom },
      argv: [],
      io: io({ [custom]: "", [dev]: "", [prod]: "" }),
    });
    expect(plan.source).toBe("override");
    expect(plan.files.map((f) => f.path)).toEqual([custom]);
  });

  it("resolves a relative DRMED_ENV_FILE against cwd", () => {
    const rel = `${cwd}${sep}envs${sep}ci.env`;
    const plan = planEnvFiles({
      cwd,
      env: { DRMED_ENV_FILE: `envs${sep}ci.env` },
      argv: [],
      io: io({ [rel]: "" }),
    });
    expect(plan.files.map((f) => f.path)).toEqual([rel]);
  });

  it("reports no files (rather than silently falling back) when nothing exists", () => {
    const plan = planEnvFiles({ cwd, env: {}, argv: [], io: io({}) });
    expect(plan.files).toEqual([]);
    expect(plan.searched.length).toBeGreaterThan(0);
  });

  it("does not silently substitute .env.local for a missing override", () => {
    const plan = planEnvFiles({
      cwd,
      env: { DRMED_ENV_FILE: `${sep}nope.env` },
      argv: [],
      io: io({ [prod]: "" }),
    });
    expect(plan.files).toEqual([]);
  });
});

describe("formatLoadSummary", () => {
  const cwd = `${sep}repo`;
  const dev = `${cwd}${sep}.env.development.local`;
  const prod = `${cwd}${sep}.env.local`;

  it("mentions both files in local mode and flags prod mode loudly", () => {
    const local = planEnvFiles({
      cwd,
      env: {},
      argv: [],
      io: io({ [dev]: "", [prod]: "" }),
    });
    expect(formatLoadSummary(local)).toContain(dev);
    expect(formatLoadSummary(local)).toContain(prod);

    const production = planEnvFiles({
      cwd,
      env: { SEED_ALLOW_PROD: "1" },
      argv: [],
      io: io({ [dev]: "", [prod]: "" }),
    });
    expect(formatLoadSummary(production)).toContain("PROD opt-in");
  });
});
