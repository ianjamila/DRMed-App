import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StaffLoginForm } from "./login-form";
import { GoogleSignInButton } from "./google-button";

export const metadata = {
  title: "Staff sign in — drmed.ph",
};

const ERROR_COPY: Record<string, string> = {
  auth_failed: "That sign-in didn't complete. Please try again.",
  not_staff:
    "That Google account isn't set up as staff here. Ask an admin to add it, or sign in with your password.",
};

interface Props {
  searchParams: Promise<{ error?: string }>;
}

export default async function StaffLoginPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const message = error ? ERROR_COPY[error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Staff sign in</CardTitle>
          <CardDescription>
            For drmed.ph staff. Patients sign in at /portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {message ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {message}
            </p>
          ) : null}

          <GoogleSignInButton />

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-xs uppercase tracking-wider text-slate-500">
              or
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <StaffLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
