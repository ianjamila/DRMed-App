import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PayDoctorsGuide } from "./guide-client";

export const metadata = { title: "How to pay doctors — DRMed" };
export const dynamic = "force-dynamic";

export default async function PayDoctorsGuidePage() {
  await requireAdminStaff();
  return <PayDoctorsGuide />;
}
