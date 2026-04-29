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
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
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
