import type { Database } from "@/types/database";

/** One release_notices row (0210), as claim_release_notice / finish_release_notice return it. */
export type ReleaseNoticeRow = Database["public"]["Tables"]["release_notices"]["Row"];
