import { Save } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PROVIDER_LABELS, type SignInProvider, type SystemSettings } from "@shared/types";
import { useReauth } from "@/components/reauth";
import { ErrorState, Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes } from "@/lib/utils";
import { t } from "@/i18n";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Choice<T extends string | number>({ id, value, options, onChange }: { id: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const all = options.some(([v]) => v === value) ? options : [[value, String(value)] as [T, string], ...options];
  return (
    <Select value={String(value)} onValueChange={(v) => onChange((typeof value === "number" ? Number(v) : v) as T)}>
      <SelectTrigger id={id} className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map(([v, l]) => (
          <SelectItem key={String(v)} value={String(v)}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AdminSettingsPage() {
  const run = useReauth();
  const { data, error, loading, reload } = useApi<{ settings: SystemSettings; limits: { maxUploadBytes: number }; configured: Record<SignInProvider, boolean> }>("/api/admin/settings");
  const [s, setS] = useState<SystemSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data || !s) return <Spinner />;

  const changed = (Object.keys(s) as (keyof SystemSettings)[]).filter((k) => s[k] !== data.settings[k]);
  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) => setS({ ...s, [k]: v });
  const cap = data.limits.maxUploadBytes;
  const uploadOptions = [50 * MB, 100 * MB, 250 * MB, 512 * MB, GB, 2 * GB, 5 * GB].filter((v) => v <= cap);
  if (!uploadOptions.includes(cap)) uploadOptions.push(cap);

  const save = async () => {
    setBusy(true);
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, s[k]]));
      const r = await run(() => api<{ settings: SystemSettings }>("/api/admin/settings", { method: "PUT", body: patch }));
      if (r) {
        toast.success(t("Settings saved"));
        void reload();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("Sign-in & registration")}</CardTitle>
          <CardDescription>{t("At least one sign-in method must stay on.")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row id="s-reg" label={t("Registration")} hint={t("Invitation links let new people create accounts. Closed stops all new sign-ups.")}>
            <Choice id="s-reg" value={s.registrationMode} options={[["invite", t("Invitation links")], ["closed", t("Closed")]]} onChange={(v) => set("registrationMode", v)} />
          </Row>
          {(["google", "microsoft", "github"] as const).map((p) => {
            const key = `${p}Enabled` as const;
            const ok = data.configured[p];
            return (
              <Row key={p} id={`s-${p}`} label={t("Sign in with {provider}", { provider: PROVIDER_LABELS[p] })} hint={ok ? undefined : t("Not configured: set its client ID and secret on the Worker first.")}>
                <Switch id={`s-${p}`} checked={ok && s[key]} disabled={!ok} onCheckedChange={(v) => set(key, v)} />
              </Row>
            );
          })}
          <Row id="s-pw" label={t("Sign in with email and password")}>
            <Switch id="s-pw" checked={s.passwordEnabled} onCheckedChange={(v) => set("passwordEnabled", v)} />
          </Row>
          <Row id="s-mfa" label={t("Require two-factor authentication")} hint={t("Members who must use 2FA are asked to set it up at their next sign-in.")}>
            <Choice id="s-mfa" value={s.mfaPolicy} options={[["optional", t("Optional")], ["admins", t("Admins")], ["all", t("Everyone")]]} onChange={(v) => set("mfaPolicy", v)} />
          </Row>
          <Row id="s-ttl" label={t("Stay signed in for")} hint={t("Applies to new sign-ins.")}>
            <Choice id="s-ttl" value={s.sessionTtlDays} options={[[1, t("1 day")], [7, t("7 days")], [14, t("14 days")], [30, t("30 days")]]} onChange={(v) => set("sessionTtlDays", v)} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Files & sharing")}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Row id="s-quota" label={t("Default quota for new members")}>
            <Choice
              id="s-quota"
              value={s.defaultQuotaBytes}
              options={[1, 5, 10, 25, 50, 100, 500].map((g) => [g * GB, formatBytes(g * GB)] as [number, string])}
              onChange={(v) => set("defaultQuotaBytes", v)}
            />
          </Row>
          <Row id="s-max" label={t("Maximum file size")} hint={t("Up to {cap} (set at deploy time).", { cap: formatBytes(cap) })}>
            <Choice id="s-max" value={s.maxUploadBytes} options={uploadOptions.map((v) => [v, formatBytes(v)] as [number, string])} onChange={(v) => set("maxUploadBytes", v)} />
          </Row>
          <Row id="s-trash" label={t("Delete trash after")}>
            <Choice id="s-trash" value={s.trashRetentionDays} options={[[7, t("7 days")], [30, t("30 days")], [90, t("90 days")], [365, t("1 year")]]} onChange={(v) => set("trashRetentionDays", v)} />
          </Row>
          <Row id="s-links" label={t("Allow public links")} hint={t("Turning this off takes all public links offline immediately.")}>
            <Switch id="s-links" checked={s.publicLinksEnabled} onCheckedChange={(v) => set("publicLinksEnabled", v)} />
          </Row>
          <Row id="s-linkpw" label={t("Require a password on public links")} hint={t("Links without a password stop working until the owner adds one.")}>
            <Switch id="s-linkpw" checked={s.publicLinksRequirePassword} onCheckedChange={(v) => set("publicLinksRequirePassword", v)} />
          </Row>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-lg border bg-card p-3 shadow-sm">
        <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
          {changed.length ? t(changed.length > 1 ? "{n} unsaved changes" : "{n} unsaved change", { n: changed.length }) : t("All changes saved")}
        </span>
        <Button variant="ghost" disabled={!changed.length || busy} onClick={() => setS(data.settings)}>
          {t("Discard")}
        </Button>
        <Button disabled={!changed.length || busy} onClick={() => void save()}>
          <Save />{" "}{t("Save settings")}
        </Button>
      </div>
    </div>
  );
}
