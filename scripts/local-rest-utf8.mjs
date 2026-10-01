#!/usr/bin/env node
// Give the LOCAL stack's PostgREST container a UTF-8 locale.
//
// The local PostgREST v14.5 image runs with no locale, and it logs every 5xx
// response — which includes every custom P-code refusal (PostgREST maps P0002–
// P0999 to HTTP 500). Logging a message that holds a non-ASCII character
// (— or ›) then throws, and the caller gets a plain-text 500 "Something went
// wrong" instead of the refusal. Prod is not affected (checked 2026-10-01: a
// refusal with "—" came back as JSON). `supabase start` re-creates the
// container, so re-run this after every start.
//
// usage: npm run db:local-rest-utf8 [-- --workdir <dir>]
// Only touches the PostgREST container (stateless); the database keeps running.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const wi = args.indexOf("--workdir");
const workdir = wi >= 0 ? args[wi + 1] : process.cwd();
const config = readFileSync(join(workdir, "supabase", "config.toml"), "utf8");
const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
if (!projectId) throw new Error(`no project_id in ${workdir}/supabase/config.toml`);
const name = `supabase_rest_${projectId}`;

const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const c = JSON.parse(docker(["inspect", name]))[0];
if (c.Config.Labels?.["com.supabase.cli.project"] !== projectId) {
  throw new Error(`${name} is not a Supabase CLI container for ${projectId} — refusing`);
}
if (c.Config.Env.includes("LANG=C.UTF-8")) {
  console.log(`${name} already has LANG=C.UTF-8 — nothing to do.`);
  process.exit(0);
}

const env = c.Config.Env.filter((e) => !/^(LANG|LC_ALL)=/.test(e));
env.push("LANG=C.UTF-8", "LC_ALL=C.UTF-8");
// The env holds the JWT secret and DB password: pass it through a 0600 file, never argv.
const dir = mkdtempSync(join(tmpdir(), "rest-env-"));
const envFile = join(dir, "env");
writeFileSync(envFile, env.join("\n") + "\n", { mode: 0o600 });

const run = ["run", "-d", "--name", name, "--env-file", envFile];
if (c.Config.User) run.push("--user", c.Config.User);
for (const [k, v] of Object.entries(c.Config.Labels ?? {})) run.push("--label", `${k}=${v}`);
for (const [net, ep] of Object.entries(c.NetworkSettings.Networks)) {
  run.push("--network", net);
  for (const a of ep.Aliases ?? []) run.push("--network-alias", a);
  break; // the CLI attaches PostgREST to exactly one network
}
run.push("--restart", c.HostConfig.RestartPolicy?.Name || "no");
run.push(c.Config.Image, ...(c.Config.Cmd ?? []));

try {
  docker(["rm", "-f", name]);
  docker(run);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${name} re-created with LANG=C.UTF-8 (${c.Config.Image}).`);
