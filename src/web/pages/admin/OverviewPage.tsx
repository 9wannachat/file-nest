import { Activity, CheckCircle2, CircleAlert, FileStack, Globe, ShieldCheck, Upload, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AuditEvent } from "@shared/types";
import { ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";

interface Overview {
  users: { total: number; active: number; invited: number; disabled: number; admins: number; mfa: number };
  files: { count: number; bytes: number; trashed: number };
  publicLinks: number;
  uploads24h: { n: number; bytes: number };
  signedInUsers: number;
  storage: { id: string; name: string; lastCheckOk: boolean | null; count: number; bytes: number }[];
  recentEvents: AuditEvent[];
  capacity: { capBytes: number | null; membersNearQuota: number; membersOverQuota: number };
}

function Stat({ icon, label, value, hint, to }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <Card className="h-full gap-2 py-4 transition-colors hover:bg-accent/40">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-2 [&_svg]:size-4">
          {icon} {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
  return to ? (
    <Link to={to} className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = useApi<Overview>("/api/admin/overview");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const mfaPct = data.users.total ? Math.round((n(data.users.mfa) / data.users.total) * 100) : 0;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={<Users />}
          label="Members"
          value={n(data.users.total)}
          hint={`${n(data.users.active)} active · ${n(data.users.invited)} invited · ${n(data.users.disabled)} disabled`}
          to="/admin/members"
        />
        <Stat
          icon={<FileStack />}
          label="Storage used"
          value={formatBytes(n(data.files.bytes))}
          hint={`${data.capacity.capBytes ? `of ${formatBytes(data.capacity.capBytes)} capacity · ` : ""}${n(data.files.count)} files · ${data.capacity.membersNearQuota} member(s) ≥80% of quota`}
          to="/admin/usage"
        />
        <Stat icon={<Upload />} label="Uploads (24 h)" value={n(data.uploads24h.n)} hint={formatBytes(n(data.uploads24h.bytes))} />
        <Stat icon={<Globe />} label="Public links" value={data.publicLinks} hint="Active links" to="/admin/links" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden /> Security
            </CardTitle>
            <CardDescription>
              {n(data.users.admins)} admin(s) · {data.signedInUsers} member(s) signed in now
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <div className="flex justify-between text-sm">
              <span>Two-factor authentication</span>
              <span className="tabular-nums">{mfaPct}%</span>
            </div>
            <Progress value={mfaPct} aria-label="Members with 2FA" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Storage</CardTitle>
            <CardDescription>Files per R2 target</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {data.storage.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                {s.lastCheckOk === false ? (
                  <CircleAlert className="size-4 text-destructive" aria-label="Check failed" />
                ) : (
                  <CheckCircle2 className="size-4 text-success" aria-label="OK" />
                )}
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {n(s.count)} files · {formatBytes(n(s.bytes))}
                </span>
              </div>
            ))}
            {!data.storage.length ? <p className="text-sm text-muted-foreground">No storage configured.</p> : null}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" aria-hidden /> Recent activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {data.recentEvents.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge variant="outline" className="font-mono">
                  {e.action}
                </Badge>
                <span className="truncate text-muted-foreground">{e.resourceType}</span>
                <span className="ml-auto text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
              </li>
            ))}
            {!data.recentEvents.length ? <li className="py-2 text-muted-foreground">No activity yet.</li> : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
