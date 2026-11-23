import { KeyRound, LogIn, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import type { AuthConfig } from "@shared/types";
import { Alert, AlertDescription } from "@/components/Alert";
import { OfflineBanner } from "@/components/AppShell";
import { Wordmark } from "@/components/Logo";
import { Spinner } from "@/components/states";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api, ApiError, errorMessage } from "@/lib/api";

const LOGIN_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  invalid_state: "Your sign-in session expired. Please try again.",
  signin_failed: "Google sign-in failed. Please try again.",
  email_not_verified: "Your Google email address is not verified.",
  not_configured: "Google sign-in is not configured on this server.",
  method_disabled: "That sign-in method is turned off.",
  invite_invalid: "This invitation is no longer valid.",
  invite_email_mismatch: "This invitation is for a different email address.",
  member_exists: "An account with this email already exists. Sign in instead.",
};

const DENIED: Record<string, string> = {
  not_invited: "Your account is not on this FileNest’s member list. Ask an Admin for an invitation.",
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

function useAuthConfig() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  useEffect(() => {
    api<AuthConfig>("/auth/config")
      .then(setCfg)
      .catch(() => setCfg({ google: true, password: true, registration: "invite" }));
  }, []);
  return cfg;
}

function Err({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" required autoComplete={autoComplete} maxLength={128} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const cfg = useAuthConfig();
  const err = params.get("error");
  const from = (loc.state as { from?: string } | null)?.from ?? params.get("return_to") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const r = await api<{ status: "ok" | "mfa_required"; returnTo: string }>("/auth/password/login", {
        method: "POST",
        body: { email, password, returnTo: from },
      });
      location.assign(r.status === "mfa_required" ? `/mfa?return_to=${encodeURIComponent(r.returnTo)}` : r.returnTo);
    } catch (e2) {
      setFormError(errorMessage(e2));
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Sign in</h1>
          </CardTitle>
          <CardDescription>Sign in with the account your Admin invited.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {err ? <Err>{LOGIN_ERRORS[err] ?? "Sign-in failed."}</Err> : null}
          {!cfg ? <Spinner /> : null}
          {cfg?.google ? (
            <Button asChild size="lg" className="w-full" variant={cfg.password ? "outline" : "default"}>
              <a href={`/auth/login?return_to=${encodeURIComponent(from)}`}>
                <LogIn /> Continue with Google
              </a>
            </Button>
          ) : null}
          {cfg?.google && cfg.password ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" /> or <Separator className="flex-1" />
            </div>
          ) : null}
          {cfg?.password ? (
            <form onSubmit={submit} className="grid gap-3" aria-label="Sign in with email">
              <div className="grid gap-2">
                <Label htmlFor="login-email">Email</Label>
                <Input id="login-email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <PasswordField id="login-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
              {formError ? <Err>{formError}</Err> : null}
              <Button type="submit" size="lg" disabled={busy}>
                <KeyRound /> Sign in
              </Button>
              <p className="text-xs text-muted-foreground">Forgot your password? Ask an Admin for a reset link.</p>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </Shell>
  );
}

export function MfaPage() {
  const [params] = useSearchParams();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ returnTo: string }>("/auth/mfa/verify", { method: "POST", body: useRecovery ? { recoveryCode: value } : { code: value } });
      location.assign(r.returnTo || params.get("return_to") || "/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_expired") location.assign("/login?error=invalid_state");
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            <h1 className="text-xl">Two-factor authentication</h1>
          </CardTitle>
          <CardDescription>{useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}</CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="grid gap-3">
            <Label htmlFor="mfa-input" className="sr-only">
              {useRecovery ? "Recovery code" : "Authentication code"}
            </Label>
            <Input
              id="mfa-input"
              autoFocus
              required
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete={useRecovery ? "off" : "one-time-code"}
              maxLength={useRecovery ? 20 : 6}
              value={value}
              onChange={(e) => setValue(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
              className="text-center font-mono text-lg tracking-widest"
              aria-invalid={!!error}
            />
            {error ? <Err>{error}</Err> : null}
          </CardContent>
          <CardFooter className="mt-4 flex-col gap-2">
            <Button type="submit" className="w-full" disabled={busy || (!useRecovery && value.length !== 6)}>
              Verify
            </Button>
            <Button type="button" variant="link" size="sm" onClick={() => (setUseRecovery(!useRecovery), setValue(""), setError(null))}>
              {useRecovery ? "Use authenticator code" : "Use a recovery code"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </Shell>
  );
}

export function InvitePage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ valid: boolean; email: string | null; role: string; methods: { google: boolean; password: boolean } } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<typeof info>(`/auth/invite/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false, email: null, role: "member", methods: { google: false, password: false } }));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError("Passwords don’t match");
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/invite/${encodeURIComponent(token)}/register`, { method: "POST", body: { name, email: info?.email ?? email, password: pw } });
      location.assign("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Join FileNest</h1>
          </CardTitle>
          <CardDescription>
            {info?.valid ? (info.email ? `This invitation is for ${info.email}.` : "Create your account.") : info ? "This invitation is invalid or has expired." : "Checking invitation…"}
          </CardDescription>
        </CardHeader>
        {info?.valid ? (
          <CardContent className="grid gap-4">
            {info.methods.google ? (
              <Button asChild size="lg" variant={info.methods.password ? "outline" : "default"} className="w-full">
                <a href={`/auth/login?invite=${encodeURIComponent(token)}`}>
                  <LogIn /> Continue with Google
                </a>
              </Button>
            ) : null}
            {info.methods.google && info.methods.password ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" /> or <Separator className="flex-1" />
              </div>
            ) : null}
            {!info.methods.password && !info.email ? (
              <p className="text-sm text-muted-foreground">
                {info.methods.google ? "This link accepts Google sign-in." : "Ask an Admin for an invitation linked to your email address."}
              </p>
            ) : null}
            {info.methods.password ? (
              <form onSubmit={submit} className="grid gap-3" aria-label="Create account with email">
                <div className="grid gap-2">
                  <Label htmlFor="inv-name">Name</Label>
                  <Input id="inv-name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="inv-email">Email</Label>
                  <Input
                    id="inv-email"
                    type="email"
                    required
                    autoComplete="username"
                    value={info.email ?? email}
                    readOnly={!!info.email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <PasswordField id="inv-pw" label="Password (10+ characters)" value={pw} onChange={setPw} autoComplete="new-password" />
                <PasswordField id="inv-pw2" label="Confirm password" value={pw2} onChange={setPw2} autoComplete="new-password" />
                {error ? <Err>{error}</Err> : null}
                <Button type="submit" size="lg" disabled={busy}>
                  Create account
                </Button>
              </form>
            ) : null}
          </CardContent>
        ) : info ? (
          <CardFooter>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </CardFooter>
        ) : (
          <CardContent>
            <Spinner />
          </CardContent>
        )}
      </Card>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ valid: boolean; email?: string } | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ valid: boolean; email?: string }>(`/auth/password-reset/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError("Passwords don’t match");
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/password-reset/${encodeURIComponent(token)}`, { method: "POST", body: { password: pw } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Set a new password</h1>
          </CardTitle>
          <CardDescription>
            {done ? "Your password was changed. You were signed out everywhere." : info?.valid ? `For ${info.email}` : info ? "This reset link is invalid or has expired." : "Checking link…"}
          </CardDescription>
        </CardHeader>
        {info?.valid && !done ? (
          <form onSubmit={submit}>
            <CardContent className="grid gap-3">
              <input type="email" autoComplete="username" value={info.email} readOnly hidden />
              <PasswordField id="rp-pw" label="New password (10+ characters)" value={pw} onChange={setPw} autoComplete="new-password" />
              <PasswordField id="rp-pw2" label="Confirm password" value={pw2} onChange={setPw2} autoComplete="new-password" />
              {error ? <Err>{error}</Err> : null}
            </CardContent>
            <CardFooter className="mt-4">
              <Button type="submit" className="w-full" disabled={busy}>
                Save password
              </Button>
            </CardFooter>
          </form>
        ) : (
          <CardFooter>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </CardFooter>
        )}
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
            <Link to="/login">Try another account</Link>
          </Button>
        </CardFooter>
      </Card>
    </Shell>
  );
}
