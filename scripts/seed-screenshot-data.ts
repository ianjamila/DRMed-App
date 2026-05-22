/**
 * One-off seed for screenshot-capture session.
 * Creates: reception + medtech active users; 4 sample patients; 4 sample visits.
 *
 *   npx tsx --env-file=.env.development.local scripts/seed-screenshot-data.ts
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { generatePin, hashPin } from "../src/lib/auth/pin";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
requireLocalOrExplicitProd("seed-screenshot-data");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function ensureUser(opts: {
  email: string;
  password: string;
  fullName: string;
  role: "reception" | "medtech" | "pathologist" | "admin" | "xray_technician";
}) {
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  let userId = existing.users.find((u) => u.email === opts.email)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: opts.email,
      password: opts.password,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user!.id;
  }
  const { error: upErr } = await admin
    .from("staff_profiles")
    .upsert({
      id: userId,
      full_name: opts.fullName,
      role: opts.role,
      is_active: true,
    } as never);
  if (upErr) throw upErr;
  console.log(`✓ ${opts.role}: ${opts.email} / ${opts.password}`);
  return userId!;
}

async function ensurePatient(opts: {
  drm_id: string;
  first_name: string;
  last_name: string;
  birthdate: string;
  sex: "male" | "female";
  phone: string;
  created_by: string;
}) {
  const { data: existing } = await admin
    .from("patients")
    .select("id")
    .eq("drm_id", opts.drm_id)
    .maybeSingle();
  if (existing?.id) {
    console.log(`  · patient exists ${opts.drm_id}`);
    return existing.id as string;
  }
  const { data, error } = await admin
    .from("patients")
    .insert({
      drm_id: opts.drm_id,
      first_name: opts.first_name,
      last_name: opts.last_name,
      birthdate: opts.birthdate,
      sex: opts.sex,
      phone: opts.phone,
      pre_registered: false,
      created_by: opts.created_by,
    } as never)
    .select("id")
    .single();
  if (error) throw error;
  console.log(`  + patient ${opts.drm_id} ${opts.first_name} ${opts.last_name}`);
  return data!.id as string;
}

async function ensureVisit(opts: {
  patient_id: string;
  service_codes: string[];
  payment_method: "cash" | "gcash" | "card";
  paid: boolean;
  created_by: string;
}) {
  const services = await admin
    .from("services")
    .select("id, code, price_php")
    .in("code", opts.service_codes);
  if (!services.data || services.data.length === 0) {
    throw new Error(`no services matched ${opts.service_codes.join(",")}`);
  }
  const total = services.data.reduce(
    (s, r) => s + Number((r as { price_php: number }).price_php ?? 0),
    0,
  );

  const { data: visit, error: vErr } = await admin
    .from("visits")
    .insert({
      patient_id: opts.patient_id,
      total_php: total,
      paid_php: opts.paid ? total : 0,
      payment_status: opts.paid ? "paid" : "unpaid",
      created_by: opts.created_by,
    } as never)
    .select("id, visit_number")
    .single();
  if (vErr) throw vErr;

  const pin = generatePin();
  const pinHash = await hashPin(pin);
  await admin.from("visit_pins").insert({
    visit_id: visit!.id,
    pin_hash: pinHash,
  } as never);

  for (const s of services.data) {
    await admin.from("test_requests").insert({
      visit_id: visit!.id,
      service_id: s.id,
      base_price_php: (s as { price_php: number }).price_php,
      final_price_php: (s as { price_php: number }).price_php,
      status: "requested",
      requested_by: opts.created_by,
    } as never);
  }

  if (opts.paid) {
    await admin.from("payments").insert({
      visit_id: visit!.id,
      amount_php: total,
      method: opts.payment_method,
      reference_number: `SMOKE-${(visit as { visit_number: string }).visit_number}`,
      received_by: opts.created_by,
    } as never);
  }
  console.log(
    `  + visit ${(visit as { visit_number: string }).visit_number} (${services.data.length} svc, ₱${total}, ${opts.paid ? "paid" : "unpaid"}) · pin ${pin}`,
  );
  return visit!.id as string;
}

async function main() {
  console.log("\nUsers...");
  const adminId = (
    await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  ).data.users.find((u) => u.email === "admin@drmed.ph")!.id;

  await ensureUser({
    email: "reception@drmed.ph",
    password: "ReceptionPass123!",
    fullName: "Crystal Reyes",
    role: "reception",
  });
  await ensureUser({
    email: "medtech@drmed.ph",
    password: "MedtechPass123!",
    fullName: "Jelome Suzette Rillo, RMT",
    role: "medtech",
  });

  console.log("\nPatients...");
  const pid1 = await ensurePatient({
    drm_id: "DRM-002841",
    first_name: "Maria",
    last_name: "Santos",
    birthdate: "1983-08-14",
    sex: "female",
    phone: "+639171234567",
    created_by: adminId,
  });
  const pid2 = await ensurePatient({
    drm_id: "DRM-006754",
    first_name: "Juan",
    last_name: "Dela Cruz",
    birthdate: "1967-03-22",
    sex: "male",
    phone: "+639182345678",
    created_by: adminId,
  });
  const pid3 = await ensurePatient({
    drm_id: "DRM-005210",
    first_name: "Rosa",
    last_name: "Tan",
    birthdate: "1994-11-02",
    sex: "female",
    phone: "+639193456789",
    created_by: adminId,
  });
  const pid4 = await ensurePatient({
    drm_id: "DRM-004187",
    first_name: "Antonio",
    last_name: "Garcia",
    birthdate: "1958-06-30",
    sex: "male",
    phone: "+639204567890",
    created_by: adminId,
  });

  console.log("\nVisits...");
  await ensureVisit({
    patient_id: pid1,
    service_codes: ["CBC", "URINALYSIS"],
    payment_method: "cash",
    paid: true,
    created_by: adminId,
  });
  await ensureVisit({
    patient_id: pid2,
    service_codes: ["LIPID"],
    payment_method: "gcash",
    paid: true,
    created_by: adminId,
  });
  await ensureVisit({
    patient_id: pid3,
    service_codes: ["URINALYSIS"],
    payment_method: "cash",
    paid: true,
    created_by: adminId,
  });
  await ensureVisit({
    patient_id: pid4,
    service_codes: ["FBS"],
    payment_method: "cash",
    paid: true,
    created_by: adminId,
  });

  console.log("\n✓ done");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
