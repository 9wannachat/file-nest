import { LogIn, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { OfflineBanner } from "@/components/AppShell";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

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

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-muted/40">
      <OfflineBanner />
      <div className="flex justify-end p-3">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center p-4 pb-16">
        <div className="grid w-full max-w-sm gap-6">
          <div className="flex justify-center">
            <Wordmark />
          </div>
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
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Sign in</h1>
          </CardTitle>
          <CardDescription>Use the Google account your Admin invited.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {err ? (
            <Alert variant="destructive">
              <AlertDescription>{LOGIN_ERRORS[err] ?? "Sign-in failed."}</AlertDescription>
            </Alert>
          ) : null}
          <Button asChild size="lg" className="w-full">
            <a href={`/auth/login?return_to=${encodeURIComponent(from)}`}>
              <LogIn /> Continue with Google
            </a>
          </Button>
        </CardContent>
      </Card>
    </Shell>
  );
}

export function NotAuthorizedPage() {
  const [params] = useSearchParams();
  const reason = params.get("reason") ?? "not_invited";
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warning" aria-hidden />
            <h1 className="text-xl">No access</h1>
          </CardTitle>
          <CardDescription>{DENIED[reason] ?? DENIED.not_invited}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild variant="outline" className="w-full">
            <a href="/auth/login">Try another account</a>
          </Button>
        </CardFooter>
      </Card>
    </Shell>
  );
}
