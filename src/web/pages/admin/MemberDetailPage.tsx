import { ArrowLeft, Ban, Copy, KeyRound, LogOut, ShieldOff, ShieldCheck, Undo2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { PROVIDER_LABELS, type AdminMember, type AuditEvent } from "@shared/types";
import { useMe } from "@/auth";
import { ConfirmDialog } from "@/components/dialogs";
import { useReauth } from "@/components/reauth";
import { ErrorState, Spinner } from "@/components/states";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";
import { statusBadge } from "./MembersPage";

interface Detail {
  member: AdminMember;
  sessions: { id: string; createdAt: number; lastSeenAt: number; authMethod: string | null; userAgent: string | null }[];
  tokens: { id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt: number | null; expiresAt: number; revokedAt: number | null }[];
  publicLinks: { id: string; fileName: string; createdAt: number; passwordProtected: boolean }[];
  activity: AuditEvent[];
}

const GB = 1024 ** 3;
const QUOTAS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

function BanDialog({ open, name, onClose, onBan }: { open: boolean; name: string; onClose: () => void; onBan: (reason: string, days: number | null) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("forever");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onBan(reason, days === "forever" ? null : Number(days));
      setReason("");
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Ban {name}?</DialogTitle>
            <DialogDescription>They are signed out everywhere, their API tokens stop working, and their public links go offline. Files are kept.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="ban-reason">Reason (shown in the audit log)</Label>
            <Input id="ban-reason" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ban-days">Duration</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger id="ban-days" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 day</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="forever">Until lifted</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
              <Ban /> Ban member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberDetailPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const run = useReauth();
  const { data, error, loading, reload } = useApi<Detail>(`/api/admin/members/${id}`);
  const [banOpen, setBanOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; label: string; fn: () => Promise<unknown>; ok: string }>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      if ((await run(fn)) === undefined) return;
      toast.success(ok);
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const m = data.member;
  const self = m.id === me.user.id;
  const base = `/api/admin/members/${m.id}`;

  return (
    <div className="grid gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link to="/admin/members">
          <ArrowLeft /> Members
        </Link>
      </Button>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-4">
          <Avatar className="size-12">
            <AvatarFallback>{(m.name ?? m.email).slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              <h2 className="truncate">{m.name ?? m.email}</h2> {statusBadge(m)} {m.role === "admin" ? <Badge>Admin</Badge> : null}
            </CardTitle>
            <CardDescription className="truncate">{m.email}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Storage</div>
            <div>
              {formatBytes(m.usedBytes)} of {m.quotaUnlimited ? "unlimited" : formatBytes(m.quotaBytes)} · {m.fileCount} files
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Sign-in methods</div>
            <div className="flex flex-wrap gap-1">
              {m.identities.map((p) => (
                <Badge key={p} variant="outline">
                  {PROVIDER_LABELS[p]}
                </Badge>
              ))}
              {m.hasPassword ? <Badge variant="outline">Password</Badge> : null}
              {m.mfaEnabled ? (
                <Badge variant="secondary">
                  <ShieldCheck /> 2FA
                </Badge>
              ) : (
                <Badge variant="outline">No 2FA</Badge>
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Last sign-in</div>
            <div>{m.lastLoginAt ? formatDate(m.lastLoginAt) : "Never"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Joined</div>
            <div>{formatDate(m.createdAt)}</div>
          </div>
          {m.status === "disabled" && m.bannedReason ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 sm:col-span-2 lg:col-span-4">
              Banned: {m.bannedReason} {m.bannedUntil ? `· until ${formatDate(m.bannedUntil)}` : "· until lifted"}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manage</CardTitle>
          <CardDescription>Sensitive actions ask you to confirm it’s you.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="m-role">Role</Label>
              <Select value={m.role} disabled={self} onValueChange={(v) => void act(() => api(base, { method: "PATCH", body: { role: v } }), "Role updated")}>
                <SelectTrigger id="m-role" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-quota">Quota</Label>
              <Select
                value={m.quotaUnlimited ? "unlimited" : String(Math.round(m.quotaBytes / GB))}
                onValueChange={(v) => {
                  const bytes = v === "unlimited" ? null : Number(v) * GB;
                  if (bytes !== null && bytes < m.usedBytes) {
                    toast.warning(`${m.email} already uses ${formatBytes(m.usedBytes)}. Their files stay, but uploads are blocked until they free space.`);
                  }
                  void act(() => api(base, { method: "PATCH", body: { quotaBytes: bytes } }), "Quota updated");
                }}
              >
                <SelectTrigger id="m-quota" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                  {[...new Set([...QUOTAS, Math.round(m.quotaBytes / GB)])]
                    .sort((a, b) => a - b)
                    .map((g) => (
                      <SelectItem key={g} value={String(g)}>
                        {formatBytes(g * GB)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {m.status === "disabled" ? (
              <Button variant="outline" onClick={() => void act(() => api(`${base}/unban`, { method: "POST" }), "Member restored")}>
                <Undo2 /> {m.bannedReason ? "Lift ban" : "Re-enable"}
              </Button>
            ) : (
              <Button variant="destructive" disabled={self} onClick={() => setBanOpen(true)}>
                <Ban /> Ban
              </Button>
            )}
            <Button
              variant="outline"
              disabled={m.sessionCount === 0}
              onClick={() =>
                setConfirm({ title: "Sign out everywhere?", body: `${m.email} will be signed out of all devices.`, label: "Sign out", fn: () => api(`${base}/revoke-sessions`, { method: "POST" }), ok: "Signed out everywhere" })
              }
            >
              <LogOut /> Sign out everywhere ({m.sessionCount})
            </Button>
            <Button
              variant="outline"
              disabled={!data.tokens.some((t) => !t.revokedAt)}
              onClick={() => setConfirm({ title: "Revoke all API tokens?", body: "Tools such as the MCP server will stop working until new tokens are created.", label: "Revoke", fn: () => api(`${base}/revoke-tokens`, { method: "POST" }), ok: "Tokens revoked" })}
            >
              <KeyRound /> Revoke API tokens
            </Button>
            <Button
              variant="outline"
              disabled={!m.mfaEnabled || self}
              onClick={() =>
                setConfirm({ title: "Reset two-factor authentication?", body: "Their authenticator and recovery codes are removed and they are signed out. Only do this after verifying who they are.", label: "Reset 2FA", fn: () => api(`${base}/reset-2fa`, { method: "POST" }), ok: "2FA reset" })
              }
            >
              <ShieldOff /> Reset 2FA
            </Button>
            <Button
              variant="outline"
              disabled={m.status === "disabled"}
              onClick={async () => {
                try {
                  const r = await run(() => api<{ url: string }>(`${base}/password-reset`, { method: "POST" }));
                  if (r) setResetUrl(r.url);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <KeyRound /> Password reset link
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Devices ({data.sessions.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {data.sessions.map((s) => (
                <li key={s.id} className="py-2">
                  <div className="truncate">{s.userAgent ?? "Unknown device"}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.authMethod ?? "—"} · active {formatDate(s.lastSeenAt)}
                  </div>
                </li>
              ))}
              {!data.sessions.length ? <li className="py-2 text-muted-foreground">Not signed in.</li> : null}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>API tokens & public links</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <ul className="divide-y">
              {data.tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-2">
                  <span className="flex-1 truncate">{t.name}</span>
                  <Badge variant={t.revokedAt ? "destructive" : t.expiresAt < Date.now() ? "outline" : "secondary"}>
                    {t.revokedAt ? "Revoked" : t.expiresAt < Date.now() ? "Expired" : "Active"}
                  </Badge>
                </li>
              ))}
              {!data.tokens.length ? <li className="py-2 text-muted-foreground">No API tokens.</li> : null}
            </ul>
            <div className="text-muted-foreground">
              {data.publicLinks.length} active public link(s).{" "}
              <Link className="underline" to="/admin/links">
                Review links
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {data.activity.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-2 py-2">
                <Badge variant="outline" className="font-mono">
                  {e.action}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
              </li>
            ))}
            {!data.activity.length ? <li className="py-2 text-muted-foreground">No activity.</li> : null}
          </ul>
        </CardContent>
      </Card>

      <BanDialog
        open={banOpen}
        name={m.name ?? m.email}
        onClose={() => setBanOpen(false)}
        onBan={(reason, days) => act(() => api(`${base}/ban`, { method: "POST", body: { reason, days } }), "Member banned")}
      />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.label ?? ""}
        destructive
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm) await act(confirm.fn, confirm.ok);
        }}
      />
      <Dialog open={!!resetUrl} onOpenChange={(o) => !o && setResetUrl(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Password reset link</DialogTitle>
            <DialogDescription>Send this to {m.email} through a trusted channel. It works once and expires in 30 minutes.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={resetUrl ?? ""} aria-label="Reset link" onFocus={(e) => e.currentTarget.select()} className="text-xs" />
            <Button
              variant="outline"
              onClick={() =>
                resetUrl &&
                navigator.clipboard.writeText(resetUrl).then(
                  () => toast.success("Copied"),
                  () => toast.error("Could not copy"),
                )
              }
            >
              <Copy /> Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
