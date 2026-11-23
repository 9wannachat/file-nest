import { LogIn, ShieldAlert } from "lucide-react";
import { useLocation, useSearchParams } from "react-router";
import { Wordmark } from "@/components/Logo";
import { OfflineBanner } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

const LOGIN_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  invalid_state: "Your sign-in session expired. Please try again.",
  signin_failed: "Google sign-in failed. Please try again.",
  email_not_verified: "Your Google email address is not verified.",
  not_configured: "Google sign-in is not configured on this server.",
};

const DENIED: Record<string, string> = {
  not_invited: "Your Google account is not on this FileNest’s member list. Ask an Admin to invite your email address.",
  disabled: "Your access to this FileNest has been turned off by an Admin.",
  account_mismatch: "This email is linked to a different Google account.",
};

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <OfflineBanner />
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Wordmark />
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const err = params.get("error");
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  return (
    <Card>
      <div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">Use the Google account your Admin invited.</p>
      </div>
      {err ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {LOGIN_ERRORS[err] ?? "Sign-in failed."}
        </p>
      ) : null}
      <Button asChild size="lg" className="w-full">
        <a href={`/auth/login?return_to=${encodeURIComponent(from)}`}>
          <LogIn /> Continue with Google
        </a>
      </Button>
    </Card>
  );
}

export function NotAuthorizedPage() {
  const [params] = useSearchParams();
  const reason = params.get("reason") ?? "not_invited";
  return (
    <Card>
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-6 shrink-0 text-amber-600" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">No access</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{DENIED[reason] ?? DENIED.not_invited}</p>
        </div>
      </div>
      <Button asChild variant="outline" className="w-full">
        <a href="/auth/login">Try another account</a>
      </Button>
    </Card>
  );
}
