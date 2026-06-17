import type { Metadata } from "next";
import { FindMyIdForm } from "./find-my-id-form";

export const metadata: Metadata = {
  title: "Find my DRM-ID · DRMed",
  description: "Recover your DRMed patient ID by email.",
  robots: { index: false }, // utility page, keep out of the index
};

export default function FindMyIdPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-bold">Find my DRM-ID</h1>
      <p className="mt-2 text-sm text-slate-600">
        Enter the details from your registration and we will email your DRM-ID to your address on file.
      </p>
      <div className="mt-6"><FindMyIdForm /></div>
    </main>
  );
}
