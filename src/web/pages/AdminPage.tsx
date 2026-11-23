import { CheckCircle2, CircleAlert, Database, Plus, RefreshCw, Star, Trash2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AuditEvent, Member, StorageCheck, StorageTargetInfo } from "@shared/types";
import { useMe } from "@/auth";
import { EmptyState, ErrorState, PageHeader, Spinner } from "@/components/states";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";

const GB = 1024 ** 3;
const QUOTA_CHOICES = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

function quotaOptions(current: number) {
  const gb = Math.round(current / GB);
  return [...new Set([...QUOTA_CHOICES, gb])].sort((a, b) => a - b);
}

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
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Invite a member</CardTitle>
          <CardDescription>They sign in with the Google account for this email.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="invite-email">Google email</Label>
              <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as "member" | "admin")}>
                <SelectTrigger id="invite-role" className="w-full sm:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy}>
              <UserPlus /> Invite
            </Button>
          </form>
        </CardContent>
      </Card>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead className="text-right">Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="max-w-64">
                    <div className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs">{(m.name ?? m.email).slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{m.name ?? m.email}</span>
                          <Badge variant={m.status === "active" ? "secondary" : m.status === "invited" ? "outline" : "destructive"}>{m.status}</Badge>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{m.lastLoginAt ? formatDate(m.lastLoginAt) : "Never"}</TableCell>
                  <TableCell>
                    <Select value={m.role} onValueChange={(v) => void patch(m, { role: v })}>
                      <SelectTrigger size="sm" aria-label={`Role for ${m.email}`} className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={String(Math.round(m.quotaBytes / GB))} onValueChange={(v) => void patch(m, { quotaBytes: Number(v) * GB })}>
                      <SelectTrigger size="sm" aria-label={`Quota for ${m.email}`} className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {quotaOptions(m.quotaBytes).map((gb) => (
                          <SelectItem key={gb} value={String(gb)}>
                            {formatBytes(gb * GB)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={m.status !== "disabled"}
                      disabled={m.id === me.user.id}
                      onCheckedChange={(on) => void patch(m, { status: on ? "active" : "disabled" })}
                      aria-label={`Access for ${m.email}`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
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

function AuditTab() {
  const { data, error, loading, reload } = useApi<{ events: AuditEvent[] }>("/api/admin/audit");
  return (
    <div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                  <TableCell>
                    <code className="text-primary">{e.action}</code>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground" title={`${e.resourceType} ${e.resourceId} ${e.metadata ?? ""}`}>
                    {e.resourceType} {e.resourceId} {e.metadata ? `· ${e.metadata}` : ""}
                  </TableCell>
                </TableRow>
              ))}
              {!data.events.length ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No events yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

export function AdminPage() {
  return (
    <div className="mx-auto max-w-5xl pb-24">
      <PageHeader title="Admin" description="Members, storage and audit log." />
      <div className="px-4 sm:px-6">
        <Tabs defaultValue="members">
          <TabsList aria-label="Admin sections">
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <TabsTrigger value="audit">Audit log</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-4">
            <MembersTab />
          </TabsContent>
          <TabsContent value="storage" className="mt-4">
            <StorageTab />
          </TabsContent>
          <TabsContent value="audit" className="mt-4">
            <AuditTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
