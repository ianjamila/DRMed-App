// scripts/patient-dedup/index.ts
import { run } from "./engine";

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
