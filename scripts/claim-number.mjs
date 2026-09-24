#!/usr/bin/env node
// scripts/claim-number.mjs — claim the next migration number or P-code.
//
//   npm run claim -- migration              → claims e.g. 0171
//   npm run claim -- pcode 3                → claims e.g. P0065–P0067
//   npm run claim -- list                   → shows every claim on file
//   npm run claim -- peek                   → next free of each, claims nothing
//   npm run claim -- migration --note "why" → records a note with the claim
//
// WHY: several Claude sessions work on this repo at once, each in its own
// worktree. Picking "the next number" by looking around was racy — on
// 2026-09-24 two branches both took 0160, two took 0165, and two sessions
// swapped P-code ranges into each other twice. This makes the pick atomic:
// a claim is a file in <main checkout>/.claims/ created with O_EXCL ("wx"),
// so exactly one caller can ever create migration-0171; a loser simply
// retries the next number. Claims are local to this machine (gitignored) —
// they coordinate the sessions here; git and prod stay the source of truth.
//
// "Seen" = every migration file / P-code on any local or remote branch, in any
// worktree's working tree (uncommitted work counts), plus every claim file.
// Prod is not read (no credentials here): still check `list_migrations`
// right before `supabase db push`, as the drmed-migrations skill says.
// Read-only apart from the claim file; touches no database.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  claimFileName,
  claimedNumberOf,
  formatMigration,
  formatPCode,
  migrationNumberOf,
  nextFree,
  pCodesIn,
} from "./lib/number-claims.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();

const MIGRATIONS = "supabase/migrations";
const PG_ERRORS = "src/lib/accounting/pg-errors.ts";

const mainRoot = resolve(dirname(resolve(git("rev-parse", "--git-common-dir"))));
const claimsDir = join(mainRoot, ".claims");

function refs() {
  return git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
    .split("\n")
    .filter((r) => r && !r.endsWith("/HEAD"));
}

function worktrees() {
  return git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => existsSync(p));
}

function claims(kind) {
  if (!existsSync(claimsDir)) return [];
  return readdirSync(claimsDir)
    .map((f) => claimedNumberOf(kind, f))
    .filter((n) => n !== null);
}

function usedMigrations() {
  const used = new Set(claims("migration"));
  for (const ref of refs()) {
    let names = "";
    try {
      names = git("ls-tree", "--name-only", ref, `${MIGRATIONS}/`);
    } catch {
      continue; // a ref without the directory
    }
    for (const f of names.split("\n")) {
      const n = migrationNumberOf(f);
      if (n !== null) used.add(n);
    }
  }
  for (const wt of worktrees()) {
    const dir = join(wt, MIGRATIONS);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const n = migrationNumberOf(f);
      if (n !== null) used.add(n);
    }
  }
  return used;
}

function usedPCodes() {
  const used = new Set(claims("pcode"));
  for (const ref of refs()) {
    let out = "";
    try {
      out = git("grep", "-hoE", "P[0-9]{4}", ref, "--", MIGRATIONS, PG_ERRORS);
    } catch {
      continue; // git grep exits 1 on no match
    }
    for (const n of pCodesIn(out)) used.add(n);
  }
  for (const wt of worktrees()) {
    const files = [join(wt, PG_ERRORS)];
    const dir = join(wt, MIGRATIONS);
    if (existsSync(dir)) for (const f of readdirSync(dir)) files.push(join(dir, f));
    for (const f of files) {
      if (!existsSync(f)) continue;
      for (const n of pCodesIn(readFileSync(f, "utf8"))) used.add(n);
    }
  }
  return used;
}

function claimOne(kind, start, note) {
  mkdirSync(claimsDir, { recursive: true });
  const who = {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    worktree: process.cwd(),
    claimed_at: new Date().toISOString(),
    note: note ?? null,
  };
  for (let n = start; ; n++) {
    try {
      // "wx" = O_CREAT|O_EXCL: fails if the file exists, so two sessions
      // racing for the same number cannot both win.
      writeFileSync(join(claimsDir, claimFileName(kind, n)), JSON.stringify(who, null, 2) + "\n", {
        flag: "wx",
      });
      return n;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

function list() {
  if (!existsSync(claimsDir)) return console.log("No claims on file.");
  for (const f of readdirSync(claimsDir).sort()) {
    const c = JSON.parse(readFileSync(join(claimsDir, f), "utf8"));
    console.log(`${f.padEnd(18)} ${c.branch}${c.note ? ` — ${c.note}` : ""}  (${c.claimed_at.slice(0, 16)})`);
  }
}

const [kind, ...rest] = process.argv.slice(2);
const noteAt = rest.indexOf("--note");
const note = noteAt >= 0 ? rest[noteAt + 1] : undefined;
const count = Number(rest.find((a, i) => /^\d+$/.test(a) && i !== noteAt + 1) ?? 1);

if (kind === "list") {
  list();
} else if (kind === "peek") {
  console.log(`Next free: migration ${formatMigration(nextFree(usedMigrations()))}, ${formatPCode(nextFree(usedPCodes()))} (not claimed)`);
} else if (kind === "migration") {
  const n = claimOne("migration", nextFree(usedMigrations()), note);
  console.log(`Claimed migration ${formatMigration(n)} — name your file supabase/migrations/${formatMigration(n)}_<name>.sql`);
} else if (kind === "pcode") {
  let start = nextFree(usedPCodes());
  const got = [];
  for (let i = 0; i < count; i++) {
    const n = claimOne("pcode", start, note);
    got.push(n);
    start = n + 1;
  }
  console.log(`Claimed ${got.map(formatPCode).join(", ")} — add each to ${PG_ERRORS} in the same PR`);
} else {
  console.error("usage: npm run claim -- migration | pcode [count] | list | peek   [--note \"why\"]");
  process.exit(1);
}
