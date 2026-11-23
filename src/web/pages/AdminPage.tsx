import { Tabs } from "radix-ui";
import { CheckCircle2, CircleAlert, Database, Plus, RefreshCw, Star, Trash2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AuditEvent, Member, StorageCheck, StorageTargetInfo } from "@shared/types";
import { useMe } from "@/auth";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge, EmptyState, ErrorState, Spinner, Switch } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";

const GB = 1024 ** 3;

function MembersTab() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<{ members: Member[] }>("/api/admin/members");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/members", { method: "POST", body: { email, role } });
      toast.success(`Invited ${email}`);
      setEmail("");
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const patch = async (m: Member, body: Record<string, unknown>) => {
    try {
      await api(`/api/admin/members/${m.id}`, { method: "PATCH", body });
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={invite} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end dark:border-slate-800 dark:bg-slate-900">
        <div className="flex-1 space-y-1">
          <Label htmlFor="invite-email">Invite by Google email</Label>
          <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as "member" | "admin")}
            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          <UserPlus /> Invite
        </Button>
      </form>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {data?.members.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{m.name ?? m.email}</span>
                {m.role === "admin" ? <Badge tone="brand">Admin</Badge> : null}
                <Badge tone={m.status === "active" ? "green" : m.status === "invited" ? "amber" : "red"}>{m.status}</Badge>
              </div>
              <div className="truncate text-sm text-slate-500">{m.email}</div>
              <div className="text-xs text-slate-500">
                Quota {formatBytes(m.quotaBytes)} · {m.lastLoginAt ? `last sign-in ${formatDate(m.lastLoginAt)}` : "never signed in"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                Quota (GB)
                <Input
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={Math.round(m.quotaBytes / GB)}
                  className="w-20"
                  aria-label={`Quota in GB for ${m.email}`}
                  onBlur={(e) => {
                    const gb = Number(e.target.value);
                    if (Number.isFinite(gb) && gb >= 0 && Math.round(gb * GB) !== m.quotaBytes) void patch(m, { quotaBytes: Math.round(gb * GB) });
                  }}
                />
              </label>
              <select
                aria-label={`Role for ${m.email}`}
                value={m.role}
                onChange={(e) => void patch(m, { role: e.target.value })}
                className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={m.status !== "disabled"}
                  disabled={m.id === me.user.id}
                  onCheckedChange={(on) => void patch(m, { status: on ? "active" : "disabled" })}
                  aria-label={`Access for ${m.email}`}
                />
                Access
              </label>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StorageTab() {
  const { data, error, loading, reload } = useApi<{ targets: StorageTargetInfo[]; defaultStorageId: string | null }>("/api/admin/storage");
  const [form, setForm] = useState({ name: "", accountId: "", bucket: "", credentialRef: "" });
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
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
    <div className="space-y-4">
      <div className="rounded-xl border border-brand-500/40 bg-brand-50 p-4 text-sm dark:bg-brand-800/20" role="status">
        {current ? (
          <>
            New uploads go to <strong>{current.name}</strong> ({current.bucket}). Switching affects only uploads started after the switch;
            existing files keep their storage.
          </>
        ) : (
          <>No storage is receiving new files yet. Add an R2 target below.</>
        )}
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && !data.targets.length ? <EmptyState icon={<Database />} title="No storage targets" /> : null}
      <ul className="space-y-3">
        {data?.targets.map((t) => (
          <li key={t.id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.isDefault ? (
                    <Badge tone="brand">
                      <Star className="size-3" /> Receiving new files
                    </Badge>
                  ) : null}
                  <Badge tone={t.acceptingUploads ? "green" : "slate"}>{t.acceptingUploads ? "Accepting uploads" : "Read-only"}</Badge>
                  {t.lastCheckOk === true ? (
                    <Badge tone="green">
                      <CheckCircle2 className="size-3" /> Healthy
                    </Badge>
                  ) : t.lastCheckOk === false ? (
                    <Badge tone="red">
                      <CircleAlert className="size-3" /> Check failed
                    </Badge>
                  ) : null}
                  {!t.credentialsPresent ? <Badge tone="red">Secrets missing</Badge> : null}
                </div>
                <div className="text-sm break-all text-slate-500">
                  Bucket <code>{t.bucket}</code> · account <code>{t.accountId}</code> · secrets <code>R2_{t.credentialRef}_*</code>
                </div>
                <div className="text-xs text-slate-500">
                  {t.references.files} files · {t.references.uploadSessions} upload sessions
                  {t.lastCheckAt ? ` · checked ${formatDate(t.lastCheckAt)}: ${t.lastCheckMessage ?? ""}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={checking === t.id} onClick={() => void check(t)}>
                  <RefreshCw className={checking === t.id ? "animate-spin" : ""} /> Check
                </Button>
                {!t.isDefault ? (
                  <Button
                    size="sm"
                    disabled={!t.acceptingUploads}
                    onClick={() =>
                      void call(() => api("/api/admin/storage-default", { method: "PUT", body: { storageId: t.id } }), `New uploads now go to ${t.name}`)
                    }
                  >
                    <Star /> Make default
                  </Button>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={t.acceptingUploads}
                    disabled={t.isDefault}
                    aria-label={`Accept new uploads on ${t.name}`}
                    onCheckedChange={(on) => void call(() => api(`/api/admin/storage/${t.id}`, { method: "PATCH", body: { acceptingUploads: on } }))}
                  />
                  Accept
                </label>
                {!t.isDefault && t.references.files === 0 && t.references.uploadSessions === 0 ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => void call(() => api(`/api/admin/storage/${t.id}`, { method: "DELETE" }), `Removed ${t.name}`)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
        onSubmit={async (e) => {
          e.preventDefault();
          setAdding(true);
          await call(() => api("/api/admin/storage", { method: "POST", body: form }), "Storage target added");
          setForm({ name: "", accountId: "", bucket: "", credentialRef: "" });
          setAdding(false);
        }}
      >
        <h3 className="font-semibold">Add R2 storage target</h3>
        <p className="text-sm text-slate-500">
          Create a bucket-scoped R2 API token (Object Read &amp; Write) in the target Cloudflare account, then set it as Worker Secrets{" "}
          <code>R2_&lt;REF&gt;_ACCESS_KEY_ID</code> and <code>R2_&lt;REF&gt;_SECRET_ACCESS_KEY</code>. Secrets never go through this form.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["name", "Display name", "Main R2"],
              ["accountId", "Cloudflare account ID", "32 hex characters"],
              ["bucket", "Bucket name", "filenest-files"],
              ["credentialRef", "Credential ref", "MAIN"],
            ] as const
          ).map(([k, label, ph]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`st-${k}`}>{label}</Label>
              <Input id={`st-${k}`} required placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <Button type="submit" disabled={adding}>
          <Plus /> Add target
        </Button>
      </form>
    </div>
  );
}

function AuditTab() {
  const { data, error, loading, reload } = useApi<{ events: AuditEvent[] }>("/api/admin/audit");
  return (
    <div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {data?.events.map((e) => (
          <li key={e.id} className="grid gap-1 p-3 sm:grid-cols-[12rem_14rem_1fr]">
            <span className="text-slate-500">{formatDate(e.createdAt)}</span>
            <code className="text-brand-800 dark:text-brand-100">{e.action}</code>
            <span className="break-all text-slate-600 dark:text-slate-300">
              {e.resourceType} {e.resourceId} {e.metadata ? `· ${e.metadata}` : ""}
            </span>
          </li>
        ))}
        {data && !data.events.length ? <li className="p-4 text-slate-500">No events yet.</li> : null}
      </ul>
    </div>
  );
}

export function AdminPage() {
  const tab = "px-4 min-h-11 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-brand-700 data-[state=active]:text-brand-800 dark:data-[state=active]:text-brand-100";
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 pb-24 sm:px-6">
      <h1 className="mb-3 text-lg font-semibold">Admin</h1>
      <Tabs.Root defaultValue="members">
        <Tabs.List aria-label="Admin sections" className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          <Tabs.Trigger value="members" className={tab}>
            Members
          </Tabs.Trigger>
          <Tabs.Trigger value="storage" className={tab}>
            Storage
          </Tabs.Trigger>
          <Tabs.Trigger value="audit" className={tab}>
            Audit log
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="members">
          <MembersTab />
        </Tabs.Content>
        <Tabs.Content value="storage">
          <StorageTab />
        </Tabs.Content>
        <Tabs.Content value="audit">
          <AuditTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
