#!/usr/bin/env node
// Smoke-test the role-specific staff dashboards.
//
// For each role we want to test:
//   1. Create a temporary auth.users + staff_profiles row (admin SDK)
//   2. Sign in with a known password to get a real Supabase session
//   3. Build the @supabase/ssr-style auth cookie from that session
//   4. Fetch each protected route with the cookie, assert status + content markers
//   5. Tear the test user down (delete staff_profile + auth.users)
//
// Reads env from .env.local. Runs against whichever dev server is up at APP_BASE.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL.replace(/^"|"$/g, "");
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY.replace(/^"|"$/g, "");
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY.replace(/^"|"$/g, "");
const APP_BASE = process.env.APP_BASE ?? "http://localhost:3001";

const projectRef = new URL(SUPABASE_URL).host.split(".")[0];
const COOKIE_NAME = `sb-${projectRef}-auth-token`;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// One temporary user per role we want to walk. Lab roles share one shell with
// role-conditional cards, so we want all three.
const ROLES = [
  {
    role: "reception",
    expect: {
      "/staff": [
        "Today at the front desk",
        "Reception",
        "Visits today",
        "Walk-ins waiting",
      ],
      "/staff/visits": ["Reception Visits", "Date"],
      "/staff/visits/new": ["New visit", "Pick the patient"],
      "/staff/admin/settings/dashboard-cards": null, // redirect: not admin
    },
  },
  {
    role: "medtech",
    expect: {
      "/staff": [
        "Lab bench",
        "Medtech",
        "Unclaimed in my sections",
        "Send-out awaiting result",
      ],
      "/staff/queue": ["Lab queue"],
      "/staff/admin/settings/dashboard-cards": null,
    },
  },
  {
    role: "xray_technician",
    expect: {
      "/staff": [
        "Imaging bench",
        "Imaging",
        "Unclaimed in my sections",
      ],
      "/staff/queue": ["Imaging queue"],
    },
  },
  {
    role: "pathologist",
    expect: {
      "/staff": [
        "Sign-off",
        "Pathologist",
        "Ready for sign-off",
        "Critical alerts unacked",
      ],
      "/staff/signoff": [],
      "/staff/admin/settings/dashboard-cards": null,
    },
  },
  {
    role: "admin",
    expect: {
      "/staff": ["Clinic command centre", "Admin", "Revenue today"],
      "/staff/admin/accounting/patient-ar": ["Patient AR aging"],
      "/staff/admin/settings/dashboard-cards": [
        "Dashboard card settings",
        "Reception",
        "Medtech",
        "Admin",
      ],
      "/staff/visits": ["Reception Visits", "Date"],
      "/staff/admin/inventory": ["Inventory"],
      "/staff/admin/reports/lab-tat": ["Lab TAT analytics"],
      "/staff/admin/accounting/bank-rec": ["Bank reconciliation"],
      "/staff/admin/accounting/variance": ["Budget vs actual"],
      "/staff/admin/accounting/financial-statements": ["Financial statements"],
    },
  },
];

function makeCookie(session) {
  const payload =
    "base64-" + Buffer.from(JSON.stringify(session)).toString("base64");
  return `${COOKIE_NAME}=${payload}`;
}

async function createTempUser(role) {
  const email = `smoke-${role}-${Date.now()}-${randomBytes(3).toString("hex")}@drmed.test`;
  const password = randomBytes(16).toString("hex");

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${role}: ${error.message}`);

  const userId = data.user.id;

  const { error: profileErr } = await admin.from("staff_profiles").insert({
    id: userId,
    full_name: `Smoke ${role}`,
    role,
    is_active: true,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`staff_profile ${role}: ${profileErr.message}`);
  }

  return { userId, email, password };
}

async function tearDownUser(userId) {
  await admin.from("staff_profiles").delete().eq("id", userId);
  await admin.auth.admin.deleteUser(userId);
}

async function smokeRole(spec) {
  console.log(`\n=== ${spec.role.toUpperCase()} ===`);
  const findings = [];

  let tmp;
  try {
    tmp = await createTempUser(spec.role);
  } catch (e) {
    console.log(`  ✗ setup failed: ${e.message}`);
    return [{ ok: false, route: "(setup)", reason: e.message }];
  }

  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await userClient.auth.signInWithPassword({
      email: tmp.email,
      password: tmp.password,
    });
    if (error || !data.session) {
      console.log(`  ✗ sign in failed: ${error?.message}`);
      return [{ ok: false, route: "(signin)", reason: error?.message }];
    }

    const cookie = makeCookie(data.session);

    for (const [route, expected] of Object.entries(spec.expect)) {
      const res = await fetch(`${APP_BASE}${route}`, {
        headers: { cookie },
        redirect: "manual",
      });
      const body = res.status === 200 ? await res.text() : "";

      if (expected === null) {
        // Expect a redirect (not authorized for this role).
        if (res.status >= 300 && res.status < 400) {
          findings.push({ ok: true, route, status: res.status });
          console.log(`  ✓ ${route} → ${res.status} (expected redirect)`);
        } else {
          findings.push({
            ok: false,
            route,
            status: res.status,
            reason: `expected redirect, got ${res.status}`,
          });
          console.log(`  ✗ ${route} → ${res.status} (expected redirect)`);
        }
        continue;
      }

      if (res.status !== 200) {
        findings.push({ ok: false, route, status: res.status });
        console.log(`  ✗ ${route} → HTTP ${res.status}`);
        continue;
      }

      const missing = expected.filter((needle) => !body.includes(needle));
      if (missing.length === 0) {
        findings.push({ ok: true, route, status: 200 });
        console.log(
          `  ✓ ${route} (${expected.length} marker${expected.length === 1 ? "" : "s"} matched)`,
        );
      } else {
        findings.push({ ok: false, route, status: 200, missing });
        console.log(`  ✗ ${route} — missing markers: ${missing.join(", ")}`);
      }
    }
  } finally {
    await tearDownUser(tmp.userId);
    console.log(`  [teardown] temp ${spec.role} removed`);
  }

  return findings;
}

(async () => {
  const all = [];
  for (const spec of ROLES) {
    const findings = await smokeRole(spec);
    all.push({ role: spec.role, findings });
  }

  console.log("\n\n=== SUMMARY ===");
  let totalPass = 0;
  let totalFail = 0;
  for (const r of all) {
    const passes = r.findings.filter((f) => f.ok).length;
    const fails = r.findings.filter((f) => !f.ok).length;
    totalPass += passes;
    totalFail += fails;
    console.log(`${r.role.padEnd(18)} ${passes} pass, ${fails} fail`);
  }
  console.log(`\nTotal: ${totalPass} pass, ${totalFail} fail`);
  process.exit(totalFail > 0 ? 1 : 0);
})();
