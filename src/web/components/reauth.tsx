import { ShieldCheck } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { AccountInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, errorMessage } from "@/lib/api";
import { t } from "@/i18n";

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
const Ctx = createContext<Run | null>(null);

/**
 * Step-up re-authentication. `run(fn)` executes fn; if the server answers
 * `reauth_required`, it asks for a 2FA code or password (or a fresh sign-in),
 * then retries fn once.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ resolve: (ok: boolean) => void } | null>(null);

  const ask = useCallback(async () => {
    setValue("");
    setError(null);
    setAccount(await api<AccountInfo>("/api/account").catch(() => null));
    setOpen(true);
    return new Promise<boolean>((resolve) => (pending.current = { resolve }));
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    pending.current?.resolve(ok);
    pending.current = null;
  };

  const run: Run = useCallback(
    async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "reauth_required")) throw e;
        if (!(await ask())) return undefined;
        return fn();
      }
    },
    [ask],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/account/reauth", { method: "POST", body: account?.mfa.enabled ? { code: value.trim() } : { password: value } });
      toast.success(t("Confirmed"));
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const mode = account?.mfa.enabled ? "code" : account?.hasPassword ? "password" : "signin";

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog open={open} onOpenChange={(o) => !o && finish(false)}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-primary" aria-hidden />{" "}{t("Confirm it’s you")}
              </DialogTitle>
              <DialogDescription>{t("This action needs a recent confirmation.")}</DialogDescription>
            </DialogHeader>
            {mode === "signin" ? (
              <p className="text-sm text-muted-foreground">{t("Sign in again to continue, then repeat the action.")}</p>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="reauth-input">{mode === "code" ? t("Authenticator code") : t("Password")}</Label>
                <Input
                  id="reauth-input"
                  autoFocus
                  type={mode === "code" ? "text" : "password"}
                  inputMode={mode === "code" ? "numeric" : undefined}
                  autoComplete={mode === "code" ? "one-time-code" : "current-password"}
                  maxLength={mode === "code" ? 6 : 128}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={!!error}
                />
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(false)}>
                {t("Cancel")}
              </Button>
              {mode === "signin" ? (
                <Button asChild>
                  <a href={`/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}>{t("Sign in again")}</a>
                </Button>
              ) : (
                <Button type="submit" disabled={busy || !value}>
                  {t("Confirm")}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useReauth(): Run {
  const c = useContext(Ctx);
  if (!c) throw new Error("useReauth outside ReauthProvider");
  return c;
}
