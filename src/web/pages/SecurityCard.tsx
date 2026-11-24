import { KeyRound, Link2, LogOut, Monitor, ShieldCheck, ShieldOff, Unlink } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { PROVIDER_LABELS, SIGN_IN_PROVIDERS, type AccountInfo, type SignInProvider } from "@shared/types";
import { MfaSetup, RecoveryCodes } from "@/components/MfaSetup";
import { useReauth } from "@/components/reauth";
import { ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";

function deviceLabel(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function PasswordForm({ has, onDone }: { has: boolean; onDone: () => void }) {
  const run = useReauth();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError("Passwords don’t match");
    setBusy(true);
    setError(null);
    try {
      const r = await run(() => api("/api/account/password", { method: "PUT", body: { newPassword: pw } }));
      if (r !== undefined) {
        toast.success(has ? "Password changed. Other sessions were signed out." : "Password set");
        setPw("");
        setPw2("");
        onDone();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid max-w-sm gap-3">
      <div className="grid gap-2">
        <Label htmlFor="acc-pw">{has ? "New password" : "Password"}</Label>
        <Input id="acc-pw" type="password" autoComplete="new-password" maxLength={128} value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="acc-pw2">Confirm password</Label>
        <Input id="acc-pw2" type="password" autoComplete="new-password" maxLength={128} value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-fit" disabled={busy || !pw}>
        <KeyRound /> {has ? "Change password" : "Set password"}
      </Button>
    </form>
  );
}

const LINK_ERRORS: Record<string, string> = {
  identity_in_use: "That account is already connected to another FileNest member.",
  already_linked: "That sign-in method is already connected.",
  email_not_verified: "Your email address with that provider is not verified.",
  method_disabled: "That sign-in method is turned off.",
  invalid_state: "The connection expired. Please try again.",
};

/** Connect / disconnect external sign-in providers. */
function ConnectedMethods({ data, onChange }: { data: AccountInfo; onChange: () => void }) {
  const run = useReauth();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<SignInProvider | null>(null);
  useEffect(() => {
    const linked = params.get("linked") as SignInProvider | null;
    const err = params.get("link_error");
    if (!linked && !err) return;
    if (linked && linked in PROVIDER_LABELS) toast.success(`${PROVIDER_LABELS[linked]} connected`);
    if (err) toast.error(LINK_ERRORS[err] ?? "Could not connect that account.");
    setParams({}, { replace: true });
  }, [params, setParams]);

  const shown = SIGN_IN_PROVIDERS.filter((p) => data.identities.includes(p) || data.availableProviders.includes(p));
  if (!shown.length) return null;
  const methods = data.identities.length + (data.hasPassword ? 1 : 0);

  const connect = async (p: SignInProvider) => {
    setBusy(p);
    try {
      const r = await run(() => api<{ url: string }>(`/api/account/identities/${p}`, { method: "POST" }));
      if (r) return location.assign(r.url);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(null);
  };
  const disconnect = async (p: SignInProvider) => {
    setBusy(p);
    try {
      const r = await run(() => api(`/api/account/identities/${p}`, { method: "DELETE" }));
      if (r !== undefined) {
        toast.success(`${PROVIDER_LABELS[p]} disconnected`);
        onChange();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section aria-labelledby="sec-ids" className="grid gap-3">
        <h3 id="sec-ids" className="font-medium">
          Connected sign-in methods
        </h3>
        <ul className="divide-y rounded-md border">
          {shown.map((p) => {
            const linked = data.identities.includes(p);
            return (
              <li key={p} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="flex-1 font-medium">{PROVIDER_LABELS[p]}</span>
                <Badge variant={linked ? "secondary" : "outline"}>{linked ? "Connected" : "Not connected"}</Badge>
                {linked ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null || methods <= 1}
                    title={methods <= 1 ? "Add a password or another method first" : undefined}
                    onClick={() => void disconnect(p)}
                  >
                    <Unlink /> Disconnect
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void connect(p)}>
                    <Link2 /> Connect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {methods <= 1 ? <p className="text-xs text-muted-foreground">Your only sign-in method can’t be removed.</p> : null}
      </section>
      <Separator />
    </>
  );
}

export function SecurityCard() {
  const run = useReauth();
  const { data, error, loading, reload } = useApi<AccountInfo>("/api/account");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [editingPw, setEditingPw] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await run(fn);
      if (r !== undefined) {
        toast.success(ok);
        void reload();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>Password, two-factor authentication and signed-in devices.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {loading && !data ? <Spinner /> : null}
        {data ? (
          <>
            <section aria-labelledby="sec-pw" className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="sec-pw" className="font-medium">
                  Password
                </h3>
                <Badge variant={data.hasPassword ? "secondary" : "outline"}>{data.hasPassword ? "Set" : "Not set"}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {data.hasPassword
                  ? `Last changed ${data.passwordUpdatedAt ? formatDate(data.passwordUpdatedAt) : "—"}.`
                  : "Add a password to also sign in with your email address."}
              </p>
              {editingPw ? (
                <PasswordForm has={data.hasPassword} onDone={() => (setEditingPw(false), void reload())} />
              ) : (
                <Button variant="outline" className="w-fit" onClick={() => setEditingPw(true)}>
                  <KeyRound /> {data.hasPassword ? "Change password" : "Set a password"}
                </Button>
              )}
            </section>

            <Separator />

            <ConnectedMethods data={data} onChange={() => void reload()} />

            <section aria-labelledby="sec-mfa" className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="sec-mfa" className="font-medium">
                  Two-factor authentication
                </h3>
                <Badge variant={data.mfa.enabled ? "default" : "outline"}>{data.mfa.enabled ? "On" : "Off"}</Badge>
                {data.mfa.required ? <Badge variant="secondary">Required by your organization</Badge> : null}
              </div>
              {data.mfa.enabled ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Authenticator app since {data.mfa.enabledAt ? formatDate(data.mfa.enabledAt) : "—"} · {data.mfa.recoveryCodesRemaining} recovery codes left
                  </p>
                  {newCodes ? (
                    <RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} />
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={async () => {
                          try {
                            const r = await run(() => api<{ recoveryCodes: string[] }>("/api/account/2fa/recovery-codes", { method: "POST" }));
                            if (r) {
                              setNewCodes(r.recoveryCodes);
                              void reload();
                            }
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        <ShieldCheck /> New recovery codes
                      </Button>
                      {!data.mfa.required ? (
                        <Button variant="ghost" onClick={() => void act(() => api("/api/account/2fa/disable", { method: "POST" }), "Two-factor authentication turned off")}>
                          <ShieldOff /> Turn off
                        </Button>
                      ) : null}
                    </div>
                  )}
                </>
              ) : (
                <MfaSetup onEnabled={() => void reload()} />
              )}
            </section>

            <Separator />

            <section aria-labelledby="sec-sessions" className="grid gap-3">
              <div className="flex items-center gap-2">
                <h3 id="sec-sessions" className="font-medium">
                  Signed-in devices
                </h3>
                {data.sessions.length > 1 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => void act(() => api("/api/account/sessions/revoke-others", { method: "POST" }), "Signed out other devices")}
                  >
                    <LogOut /> Sign out others
                  </Button>
                ) : null}
              </div>
              <ul className="divide-y rounded-md border">
                {data.sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        {deviceLabel(s.userAgent)} {s.current ? <Badge className="ml-1">This device</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {s.authMethod ?? "—"} · signed in {formatDate(s.createdAt)} · active {formatDate(s.lastSeenAt)}
                      </div>
                    </div>
                    {!s.current ? (
                      <Button size="sm" variant="ghost" aria-label={`Sign out ${deviceLabel(s.userAgent)}`} onClick={() => void act(() => api(`/api/account/sessions/${s.id}`, { method: "DELETE" }), "Signed out")}>
                        Sign out
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
