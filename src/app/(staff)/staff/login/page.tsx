import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StaffLoginForm } from "./login-form";

export const metadata = {
  title: "Staff sign in — drmed.ph",
};

export default function StaffLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Staff sign in</CardTitle>
          <CardDescription>
            For drmed.ph staff. Patients sign in at /portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StaffLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
