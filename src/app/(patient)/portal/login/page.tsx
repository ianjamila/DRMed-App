import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PatientLoginForm } from "./login-form";

export const metadata = {
  title: "Patient sign in — drmed.ph",
};

export default function PatientLoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[color:var(--color-brand-bg)] p-6">
      <div className="mb-6 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="DRMed" className="mx-auto mb-4 h-12 w-auto" />
        <p className="font-[family-name:var(--font-heading)] text-2xl font-extrabold tracking-tight text-[color:var(--color-brand-navy)]">
          drmed<span className="text-[color:var(--color-brand-cyan)]">.portal</span>
        </p>
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Your results, securely accessible</CardTitle>
          <CardDescription>
            Sign in with your DRM-ID and the Secure PIN printed on your receipt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PatientLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
