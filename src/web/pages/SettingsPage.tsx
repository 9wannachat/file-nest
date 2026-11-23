import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ApiTokenInfo } from "@shared/types";
import { EmptyState, ErrorState, PageHeader, Spinner } from "@/components/states";
import { THEME_OPTIONS } from "@/components/ThemeToggle";
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
import { cn, formatDate } from "@/lib/utils";
import { useTheme } from "@/theme";
import { SecurityCard } from "./SecurityCard";

function statusOf(t: ApiTokenInfo): { label: string; variant: "secondary" | "outline" | "destructive" } {
  if (t.revokedAt) return { label: "Revoked", variant: "destructive" };
  if (t.expiresAt <= Date.now()) return { label: "Expired", variant: "outline" };
  return { label: "Active", variant: "secondary" };
}

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>System follows your device setting.</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2 sm:max-w-md">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border p-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                theme === value && "border-primary bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </button>
          ))}
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

  const revoke = async (t: ApiTokenInfo) => {
    try {
      await api(`/api/tokens/${t.id}`, { method: "DELETE" });
      toast.success(`Revoked “${t.name}”`);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy. Select the text and copy it manually.");
    }
  };

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <PageHeader title="Settings" description="Appearance, security and API tokens." />
      <div className="grid gap-4 px-4 sm:px-6">
        <AppearanceCard />
        <SecurityCard />

        <Card>
          <CardHeader>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>
              Let tools on your computer, such as the FileNest MCP server for AI assistants, read your files and upload results. A token acts as you, but it
              can’t share, delete, move to trash or use admin features.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form onSubmit={create} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                <div className="grid gap-2">
                  <Label htmlFor="token-name">Name</Label>
                  <Input id="token-name" required maxLength={64} placeholder="e.g. MacBook MCP" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="token-days">Expires</Label>
                  <Select value={days} onValueChange={setDays}>
                    <SelectTrigger id="token-days" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[7, 30, 90, 180, 365].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d} days
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={write} onCheckedChange={(v) => setWrite(v === true)} />
                Allow uploads and creating folders (<code>files:write</code>). Reading is always included.
              </Label>
              <div>
                <Button type="submit" disabled={busy || !name.trim()}>
                  <Plus /> Create token
                </Button>
              </div>
            </form>

            {error ? <ErrorState message={error} onRetry={reload} /> : null}
            {loading && !data ? <Spinner /> : null}
            {data && !data.tokens.length ? <EmptyState icon={<KeyRound />} title="No tokens yet" /> : null}
            {data?.tokens.length ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Token</TableHead>
                      <TableHead className="hidden md:table-cell">Expires</TableHead>
                      <TableHead className="hidden md:table-cell">Last used</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tokens.map((t) => {
                      const st = statusOf(t);
                      return (
                        <TableRow key={t.id}>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{t.name}</span>
                              <Badge variant={st.variant}>{st.label}</Badge>
                              {t.scopes.map((s) => (
                                <Badge key={s} variant="outline">
                                  {s}
                                </Badge>
                              ))}
                            </div>
                            <div className="text-xs text-muted-foreground md:hidden">
                              Expires {formatDate(t.expiresAt)} · {t.lastUsedAt ? `last used ${formatDate(t.lastUsedAt)}` : "never used"}
                            </div>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(t.expiresAt)}</TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{t.lastUsedAt ? formatDate(t.lastUsedAt) : "Never"}</TableCell>
                          <TableCell className="text-right">
                            {st.label === "Active" ? (
                              <Button variant="outline" size="sm" onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`}>
                                <Trash2 /> Revoke
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
            <CardTitle>Use with an AI assistant (MCP)</CardTitle>
            <CardDescription>
              Save the token in a file only you can read, then add the FileNest MCP server to your assistant. It downloads into and uploads from one working
              folder only.
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
            <DialogTitle>Copy your new token</DialogTitle>
            <DialogDescription>It won’t be shown again. Store it somewhere safe.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={created ?? ""} aria-label="New token" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button variant="outline" aria-label="Copy token" onClick={() => created && void copy(created)}>
              <Copy /> Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Tip: paste it into <code>~/.config/filenest/token</code>, then run <code>chmod 600 ~/.config/filenest/token</code>.
          </p>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
