import { CheckCircle2, CircleAlert, Database, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { StorageCheck, StorageTargetInfo } from "@shared/types";
import { useReauth } from "@/components/reauth";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";

export function StoragePage() {
  const run = useReauth();
  const { data, error, loading, reload } = useApi<{ targets: StorageTargetInfo[]; defaultStorageId: string | null }>("/api/admin/storage");
  const [form, setForm] = useState({ name: "", accountId: "", bucket: "", credentialRef: "" });
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      if ((await run(fn)) === undefined) return;
      if (ok) toast.success(ok);
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const check = async (t: StorageTargetInfo) => {
    setChecking(t.id);
    try {
      const r = await api<StorageCheck>(`/api/admin/storage/${t.id}/check`, { method: "POST" });
      if (r.ok) toast.success(`${t.name}: healthy`);
      else toast.error(`${t.name}: ${r.message}`);
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };
  const current = data?.targets.find((t) => t.isDefault);

  return (
    <div className="grid gap-4">
      <div role="status" className="rounded-lg border border-primary/40 bg-primary/10 p-4 text-sm">
        {current ? (
          <>
            New uploads go to <strong>{current.name}</strong> ({current.bucket}). Switching affects only uploads started after the switch; existing
            files keep their storage.
          </>
        ) : (
          <>No storage is receiving new files yet. Add an R2 target below.</>
        )}
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && !data.targets.length ? <EmptyState icon={<Database />} title="No storage targets" /> : null}
      {data?.targets.map((t) => (
        <Card key={t.id} className="gap-3">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {t.name}
              {t.isDefault ? (
                <Badge>
                  <Star /> Receiving new files
                </Badge>
              ) : null}
              <Badge variant={t.acceptingUploads ? "secondary" : "outline"}>{t.acceptingUploads ? "Accepting uploads" : "Read-only"}</Badge>
              {t.lastCheckOk === true ? (
                <Badge variant="secondary" className="text-success">
                  <CheckCircle2 /> Healthy
                </Badge>
              ) : t.lastCheckOk === false ? (
                <Badge variant="destructive">
                  <CircleAlert /> Check failed
                </Badge>
              ) : null}
              {!t.credentialsPresent ? <Badge variant="destructive">Secrets missing</Badge> : null}
            </CardTitle>
            <CardDescription className="break-all">
              Bucket <code>{t.bucket}</code> · account <code>{t.accountId}</code> · secrets <code>R2_{t.credentialRef}_*</code>
              <br />
              {t.references.files} files · {t.references.uploadSessions} upload sessions
              {t.lastCheckAt ? ` · checked ${formatDate(t.lastCheckAt)}: ${t.lastCheckMessage ?? ""}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={checking === t.id} onClick={() => void check(t)}>
              <RefreshCw className={checking === t.id ? "animate-spin" : ""} /> Check
            </Button>
            {!t.isDefault ? (
              <Button
                size="sm"
                disabled={!t.acceptingUploads}
                onClick={() => void call(() => api("/api/admin/storage-default", { method: "PUT", body: { storageId: t.id } }), `New uploads now go to ${t.name}`)}
              >
                <Star /> Make default
              </Button>
            ) : null}
            <Label className="ml-1 flex items-center gap-2 font-normal">
              <Switch
                checked={t.acceptingUploads}
                disabled={t.isDefault}
                aria-label={`Accept new uploads on ${t.name}`}
                onCheckedChange={(on) => void call(() => api(`/api/admin/storage/${t.id}`, { method: "PATCH", body: { acceptingUploads: on } }))}
              />
              Accept uploads
            </Label>
            {!t.isDefault && t.references.files === 0 && t.references.uploadSessions === 0 ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Delete ${t.name}`}
                onClick={() => void call(() => api(`/api/admin/storage/${t.id}`, { method: "DELETE" }), `Removed ${t.name}`)}
              >
                <Trash2 />
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Add R2 storage target</CardTitle>
          <CardDescription>
            Create a bucket-scoped R2 API token (Object Read &amp; Write) in the target Cloudflare account, then set Worker Secrets{" "}
            <code>R2_&lt;REF&gt;_ACCESS_KEY_ID</code> and <code>R2_&lt;REF&gt;_SECRET_ACCESS_KEY</code>. Secrets never go through this form.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setAdding(true);
              await call(() => api("/api/admin/storage", { method: "POST", body: form }), "Storage target added");
              setForm({ name: "", accountId: "", bucket: "", credentialRef: "" });
              setAdding(false);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["name", "Display name", "Main R2"],
                  ["accountId", "Cloudflare account ID", "32 hex characters"],
                  ["bucket", "Bucket name", "filenest-files"],
                  ["credentialRef", "Credential ref", "MAIN"],
                ] as const
              ).map(([k, label, ph]) => (
                <div key={k} className="grid gap-2">
                  <Label htmlFor={`st-${k}`}>{label}</Label>
                  <Input id={`st-${k}`} required placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <div>
              <Button type="submit" disabled={adding}>
                <Plus /> Add target
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

