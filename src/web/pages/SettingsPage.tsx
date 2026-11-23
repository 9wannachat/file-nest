import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ApiTokenInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Badge, EmptyState, ErrorState, Spinner } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";

function statusOf(t: ApiTokenInfo): { label: string; tone: "green" | "slate" | "red" } {
  if (t.revokedAt) return { label: "Revoked", tone: "red" };
  if (t.expiresAt <= Date.now()) return { label: "Expired", tone: "slate" };
  return { label: "Active", tone: "green" };
}

export function SettingsPage() {
  const { data, error, loading, reload } = useApi<{ tokens: ApiTokenInfo[] }>("/api/tokens");
  const [name, setName] = useState("");
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ token: string }>("/api/tokens", {
        method: "POST",
        body: { name, scopes: write ? ["files:read", "files:write"] : ["files:read"], expiresInDays: days },
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
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-4 pb-24 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold">API tokens</h1>
        <p className="text-sm text-slate-500">
          Personal access tokens let tools on your computer, such as the FileNest MCP server for AI assistants, read your files and upload
          results. A token acts as you, but it can’t share, delete, move to trash or use admin features.
        </p>
      </div>

      <form onSubmit={create} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <div className="space-y-1">
            <Label htmlFor="token-name">Name</Label>
            <Input id="token-name" required maxLength={64} placeholder="e.g. MacBook MCP" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="token-days">Expires (days)</Label>
            <Input id="token-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="size-4" />
          Allow uploads and creating folders (<code>files:write</code>). Reading is always included.
        </label>
        <Button type="submit" disabled={busy || !name.trim()}>
          <Plus /> Create token
        </Button>
      </form>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && !data.tokens.length ? <EmptyState icon={<KeyRound />} title="No tokens yet" /> : null}
      {data?.tokens.length ? (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {data.tokens.map((t) => {
            const st = statusOf(t);
            return (
              <li key={t.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {t.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                  <div className="text-xs text-slate-500">
                    Created {formatDate(t.createdAt)} · expires {formatDate(t.expiresAt)} ·{" "}
                    {t.lastUsedAt ? `last used ${formatDate(t.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                {st.label === "Active" ? (
                  <Button variant="outline" size="sm" onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`}>
                    <Trash2 /> Revoke
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">Use with an AI assistant (MCP)</h2>
        <p className="text-slate-600 dark:text-slate-300">
          Save the token in a file only you can read, then add the FileNest MCP server to your assistant. It downloads into and uploads
          from one working folder only.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-950">{`{
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
      </section>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader title="Copy your new token" description="It won’t be shown again. Store it somewhere safe." />
          <DialogBody className="space-y-2">
            <div className="flex gap-2">
              <Input readOnly value={created ?? ""} aria-label="New token" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button size="icon" variant="outline" aria-label="Copy token" onClick={() => created && void copy(created)}>
                <Copy />
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Tip: <code>mkdir -p ~/.config/filenest</code>, paste it into <code>~/.config/filenest/token</code>, then{" "}
              <code>chmod 600 ~/.config/filenest/token</code>.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
