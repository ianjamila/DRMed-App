import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const tr = process.argv[2];
  if (!tr) throw new Error("usage: tsx scripts/dl-finalised.ts <test_request_id>");
  const { data: r } = await admin.from("results").select("storage_path").eq("test_request_id", tr).single();
  if (!r?.storage_path) throw new Error("no storage_path");
  const { data, error } = await admin.storage.from("results").download(r.storage_path);
  if (error || !data) throw error ?? new Error("no data");
  const out = `/tmp/${tr}.pdf`;
  writeFileSync(out, Buffer.from(await data.arrayBuffer()));
  console.log(`✓ ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
