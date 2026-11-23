import { Copy, Download, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { QrCode } from "./QrCode";

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const text = codes.join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Recovery codes copied");
    } catch {
      toast.error("Could not copy");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`FileNest recovery codes\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "filenest-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Save these one-time codes somewhere safe. Each can be used once if you lose your authenticator. They won’t be shown again.
      </p>
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-md border bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          <Copy /> Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Download
        </Button>
        {onDone ? (
          <Button type="button" size="sm" className="ml-auto" onClick={onDone}>
            I saved them
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Authenticator-app enrollment: start → scan QR / type secret → confirm code → recovery codes. */
export function MfaSetup({ onEnabled }: { onEnabled: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    try {
      setSetup(await api("/api/account/2fa/setup", { method: "POST" }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>("/api/account/2fa/enable", { method: "POST", body: { code: code.trim() } });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={onEnabled} />;
  if (!setup) {
    return (
      <Button onClick={() => void start()} disabled={busy}>
        <ShieldCheck /> Set up authenticator app
      </Button>
    );
  }
  return (
    <form onSubmit={confirm} className="grid gap-4">
      <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
        <li>Open an authenticator app (Google Authenticator, 1Password, Authy…).</li>
        <li>Scan the QR code, or enter the key manually.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <QrCode value={setup.otpauthUrl} label="QR code for your authenticator app" />
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="mfa-secret">Setup key</Label>
          <code id="mfa-secret" className="rounded-md bg-muted px-2 py-1 text-xs break-all select-all">
            {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
          </code>
          <Label htmlFor="mfa-code" className="mt-2">
            6-digit code
          </Label>
          <Input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-36 font-mono tracking-widest"
            aria-invalid={!!error}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || code.length !== 6} className="w-fit">
            Turn on 2FA
          </Button>
        </div>
      </div>
    </form>
  );
}
