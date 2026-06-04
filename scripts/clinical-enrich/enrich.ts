import { run } from "./engine";
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
