import { ArrowDown, ArrowUp, CheckCircle2, CircleAlert, Database, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, formatBytes, formatDate } from "@/lib/utils";

const GB = 1024 ** 3;
const CAPACITY_CHOICES = [1, 5, 10, 20, 50, 100, 250, 500, 1024, 2048, 5120, 10240];

interface Summary {
  capacityBytes: number | null;
  usedBytes: number;
  freeBytes: number | null;
  largestFreeBytes: number | null;
  nextTargetId: string | null;
  targets: number;
  eligibleTargets: number;
}

function CapacitySelect({ id, value, onChange, disabled }: { id: string; value: number | null; onChange: (v: number | null) => void; disabled?: boolean }) {
  const options = [...new Set([...CAPACITY_CHOICES.map((g) => g * GB), ...(value !== null ? [value] : [])])].sort((a, b) => a - b);
  return (
    <Select value={value === null ? "unlimited" : String(value)} onValueChange={(v) => onChange(v === "unlimited" ? null : Number(v))} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((v) => (
          <SelectItem key={v} value={String(v)}>
            {formatBytes(v)}
          </SelectItem>
        ))}
        <SelectItem value="unlimited">Unlimited</SelectItem>
      </SelectContent>
    </Select>
  );
}

function UsageBar({ used, reserved, capacity, label }: { used: number; reserved: number; capacity: number | null; label: string }) {
  if (capacity === null) return <p className="text-xs text-muted-foreground">{formatBytes(used)} used · no capacity limit</p>;
  const pct = capacity > 0 ? Math.min(100, ((used + reserved) / capacity) * 100) : 100;
  return (
    <div className="grid gap-1">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", pct >= 95 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {formatBytes(used)} of {formatBytes(capacity)} used{reserved ? ` · ${formatBytes(reserved)} uploading` : ""} · {formatBytes(Math.max(0, capacity - used - reserved))} free
      </p>
    </div>
  );
}

export function StoragePage() {
  const run = useReauth();
  const { data, error, loading, reload } = useApi<{ targets: StorageTargetInfo[]; summary: Summary }>("/api/admin/storage");
  const [form, setForm] = useState({ name: "", accountId: "", bucket: "", credentialRef: "" });
  const [capacity, setCapacity] = useState<number | null>(10 * GB);
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
  const move = (i: number, dir: -1 | 1) => {
    if (!data) return;
    const ids = data.targets.map((t) => t.id);
    const j = i + dir;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void call(() => api("/api/admin/storage-order", { method: "PUT", body: { ids } }), "Order updated");
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const { summary } = data;
  const next = data.targets.find((t) => t.id === summary.nextTargetId);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Total capacity</CardTitle>
          <CardDescription>
            Capacities of all R2 targets that accept uploads add up. New files go to the first target in the order below that has room; a single file is never
            split across targets.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <UsageBar used={summary.usedBytes} reserved={0} capacity={summary.capacityBytes} label="Total storage used" />
          <p role="status" className="text-sm">
            {next ? (
              <>
                Next upload goes to <strong>{next.name}</strong>.
                {summary.largestFreeBytes !== null ? ` Largest file that fits right now: ${formatBytes(summary.largestFreeBytes)}.` : ""}
              </>
            ) : summary.eligibleTargets ? (
              <span className="text-destructive">All storage is full. Raise a capacity or add another R2 target.</span>
            ) : (
              <span className="text-destructive">No storage is accepting uploads.</span>
            )}
          </p>
        </CardContent>
      </Card>

      {!data.targets.length ? <EmptyState icon={<Database />} title="No storage targets" /> : null}
      <ol className="grid gap-3" aria-label="Storage targets in placement order">
        {data.targets.map((t, i) => (
          <li key={t.id}>
            <Card className={cn("gap-3", t.isDefault && "border-primary/60")}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs tabular-nums" aria-label={`Order ${t.order}`}>
                    {t.order}
                  </span>
                  {t.name}
                  {t.isDefault ? (
                    <Badge>
                      <Star /> Receives next upload
                    </Badge>
                  ) : null}
                  <Badge variant={t.acceptingUploads ? "secondary" : "outline"}>{t.acceptingUploads ? "Accepting" : "Paused"}</Badge>
                  {t.lastCheckOk === true ? (
                    <Badge variant="secondary" className="text-success">
                      <CheckCircle2 /> Healthy
                    </Badge>
                  ) : t.lastCheckOk === false ? (
                    <Badge variant="destructive">
                      <CircleAlert /> Check failed — skipped
                    </Badge>
                  ) : null}
                  {!t.credentialsPresent ? <Badge variant="destructive">Secrets missing</Badge> : null}
                  <span className="ml-auto flex gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Move ${t.name} down`} disabled={i === data.targets.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown />
                    </Button>
                  </span>
                </CardTitle>
                <CardDescription className="break-all">
                  Bucket <code>{t.bucket}</code> · account <code>{t.accountId}</code> · secrets <code>R2_{t.credentialRef}_*</code>
                  {t.lastCheckAt ? ` · checked ${formatDate(t.lastCheckAt)}: ${t.lastCheckMessage ?? ""}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <UsageBar used={t.usedBytes} reserved={t.reservedBytes} capacity={t.capacityBytes} label={`${t.name} storage used`} />
                <div className="flex flex-wrap items-center gap-3">
                  <Label className="flex items-center gap-2 font-normal" htmlFor={`cap-${t.id}`}>
                    Capacity
                    <CapacitySelect
                      id={`cap-${t.id}`}
                      value={t.capacityBytes}
                      onChange={(v) => {
                        if (v !== null && v < t.usedBytes) toast.warning(`${t.name} already holds ${formatBytes(t.usedBytes)}. Existing files stay; it will receive no new files.`);
                        void call(() => api(`/api/admin/storage/${t.id}`, { method: "PATCH", body: { capacityBytes: v } }), "Capacity updated");
                      }}
                    />
                  </Label>
                  <Label className="flex items-center gap-2 font-normal">
                    <Switch
                      checked={t.acceptingUploads}
                      aria-label={`Accept new uploads on ${t.name}`}
                      onCheckedChange={(on) => void call(() => api(`/api/admin/storage/${t.id}`, { method: "PATCH", body: { acceptingUploads: on } }))}
                    />
                    Accept uploads
                  </Label>
                  <Button variant="outline" size="sm" disabled={checking === t.id} onClick={() => void check(t)}>
                    <RefreshCw className={checking === t.id ? "animate-spin" : ""} /> Check
                  </Button>
                  {t.references.files === 0 && t.references.uploadSessions === 0 ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => void call(() => api(`/api/admin/storage/${t.id}`, { method: "DELETE" }), `Removed ${t.name}`)}
                    >
                      <Trash2 />
                    </Button>
                  ) : (
                    <span className="ml-auto text-xs text-muted-foreground">{t.references.files} files</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>Add R2 storage target</CardTitle>
          <CardDescription>
            New targets are added at the end of the order, so they fill after the existing ones. Create a bucket-scoped R2 API token (Object Read &amp; Write) in the
            target Cloudflare account, then set Worker Secrets <code>R2_&lt;REF&gt;_ACCESS_KEY_ID</code> and <code>R2_&lt;REF&gt;_SECRET_ACCESS_KEY</code>. Secrets
            never go through this form.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setAdding(true);
              await call(() => api("/api/admin/storage", { method: "POST", body: { ...form, capacityBytes: capacity } }), "Storage target added");
              setForm({ name: "", accountId: "", bucket: "", credentialRef: "" });
              setAdding(false);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["name", "Display name", "R2 account B"],
                  ["accountId", "Cloudflare account ID", "32 hex characters"],
                  ["bucket", "Bucket name", "filenest-files"],
                  ["credentialRef", "Credential ref", "B"],
                ] as const
              ).map(([k, label, ph]) => (
                <div key={k} className="grid gap-2">
                  <Label htmlFor={`st-${k}`}>{label}</Label>
                  <Input id={`st-${k}`} required placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </div>
              ))}
              <div className="grid gap-2">
                <Label htmlFor="st-capacity">Capacity</Label>
                <CapacitySelect id="st-capacity" value={capacity} onChange={setCapacity} />
                <p className="text-xs text-muted-foreground">10 GB matches R2’s free storage per account.</p>
              </div>
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
