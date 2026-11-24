import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ApiTokenInfo } from "@shared/types";
import { EmptyState, ErrorState, PageHeader, Spinner } from "@/components/states";
import { ThemeSegmented } from "@/components/ThemeToggle";
import { LanguagePicker } from "@/components/LanguageSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";
import { SecurityCard } from "./SecurityCard";
import { t } from "@/i18n";

function statusOf(tg: ApiTokenInfo): { label: string; variant: "secondary" | "outline" | "destructive" } {
  if (tg.revokedAt) return { label: t("Revoked"), variant: "destructive" };
  if (tg.expiresAt <= Date.now()) return { label: t("Expired"), variant: "outline" };
  return { label: t("Active"), variant: "secondary" };
}

function AppearanceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Appearance")}</CardTitle>
        <CardDescription>{t("System follows your device setting.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ThemeSegmented className="sm:max-w-xs" />
        <div className="mt-4 grid gap-2">
          <span className="text-sm font-medium">{t("Language")}</span>
          <LanguagePicker />
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { data, error, loading, reload } = useApi<{ tokens: ApiTokenInfo[] }>("/api/tokens");
  const [name, setName] = useState("");
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ token: string }>("/api/tokens", {
        method: "POST",
        body: { name, scopes: write ? ["files:read", "files:write"] : ["files:read"], expiresInDays: Number(days) },
      });
      setCreated(r.token);
      setName("");
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tg: ApiTokenInfo) => {
    try {
      await api(`/api/tokens/${tg.id}`, { method: "DELETE" });
      toast.success(t("Revoked “{name}”", { name: tg.name }));
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      toast.success(t("Copied"));
    } catch {
      toast.error(t("Could not copy. Select the text and copy it manually."));
    }
  };

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <PageHeader title={t("Settings")} description={t("Appearance, security and API tokens.")} />
      <div className="grid gap-4 px-4 sm:px-6">
        <AppearanceCard />
        <SecurityCard />

        <Card>
          <CardHeader>
            <CardTitle>{t("API tokens")}</CardTitle>
            <CardDescription>
              {t("Let tools on your computer, such as the FileNest MCP server for AI assistants, read your files and upload results. A token acts as you, but it can’t share, delete, move to trash or use admin features.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form onSubmit={create} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                <div className="grid gap-2">
                  <Label htmlFor="token-name">{t("Name")}</Label>
                  <Input id="token-name" required maxLength={64} placeholder={t("e.g. MacBook MCP")} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="token-days">{t("Expires")}</Label>
                  <Select value={days} onValueChange={setDays}>
                    <SelectTrigger id="token-days" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[7, 30, 90, 180, 365].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}{" "}{t("days")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={write} onCheckedChange={(v) => setWrite(v === true)} />
                {t("Allow uploads and creating folders (")}<code>{t("files:write")}</code>{t("). Reading is always included.")}
              </Label>
              <div>
                <Button type="submit" disabled={busy || !name.trim()}>
                  <Plus />{" "}{t("Create token")}
                </Button>
              </div>
            </form>

            {error ? <ErrorState message={error} onRetry={reload} /> : null}
            {loading && !data ? <Spinner /> : null}
            {data && !data.tokens.length ? <EmptyState icon={<KeyRound />} title={t("No tokens yet")} /> : null}
            {data?.tokens.length ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Token")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("Expires")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("Last used")}</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">{t("Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tokens.map((tg) => {
                      const st = statusOf(tg);
                      return (
                        <TableRow key={tg.id}>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{tg.name}</span>
                              <Badge variant={st.variant}>{st.label}</Badge>
                              {tg.scopes.map((s) => (
                                <Badge key={s} variant="outline">
                                  {s}
                                </Badge>
                              ))}
                            </div>
                            <div className="text-xs text-muted-foreground md:hidden">
                              {t("Expires")}{" "}{formatDate(tg.expiresAt)} · {tg.lastUsedAt ? t("last used {lastUsedAt}", { lastUsedAt: formatDate(tg.lastUsedAt) }) : t("never used")}
                            </div>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(tg.expiresAt)}</TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{tg.lastUsedAt ? formatDate(tg.lastUsedAt) : t("Never")}</TableCell>
                          <TableCell className="text-right">
                            {st.label === "Active" ? (
                              <Button variant="outline" size="sm" onClick={() => void revoke(tg)} aria-label={t("Revoke {name}", { name: tg.name })}>
                                <Trash2 />{" "}{t("Revoke")}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Use with an AI assistant (MCP)")}</CardTitle>
            <CardDescription>
              {t("Save the token in a file only you can read, then add the FileNest MCP server to your assistant. It downloads into and uploads from one working folder only.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`{
  "mcpServers": {
    "filenest": {
      "command": "node",
      "args": ["<path-to-repo>/packages/mcp/dist/index.js"],
      "env": {
        "FILENEST_URL": "${location.origin}",
        "FILENEST_TOKEN_FILE": "~/.config/filenest/token",
        "FILENEST_WORKDIR": "~/FileNest-work"
      }
    }
  }
}`}</pre>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Copy your new token")}</DialogTitle>
            <DialogDescription>{t("It won’t be shown again. Store it somewhere safe.")}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={created ?? ""} aria-label={t("New token")} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button variant="outline" aria-label={t("Copy token")} onClick={() => created && void copy(created)}>
              <Copy />{" "}{t("Copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Tip: paste it into")}{" "}<code>{t("~/.config/filenest/token")}</code>{t(", then run")}{" "}<code>{t("chmod 600 ~/.config/filenest/token")}</code>.
          </p>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>{t("Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
