import { Search, ShieldCheck, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { PROVIDER_LABELS, type AdminMember } from "@shared/types";
import { ErrorState, Spinner } from "@/components/states";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";

export function statusBadge(m: Pick<AdminMember, "status" | "bannedReason">) {
  if (m.status === "disabled") return <Badge variant="destructive">{m.bannedReason ? "Banned" : "Disabled"}</Badge>;
  if (m.status === "invited") return <Badge variant="outline">Invited</Badge>;
  return <Badge variant="secondary">Active</Badge>;
}

export function MembersPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [role, setRole] = useState("all");
  const dq = useDebounced(q, 250);
  const qs = new URLSearchParams({ ...(dq.trim() ? { q: dq.trim() } : {}), ...(status !== "all" ? { status } : {}), ...(role !== "all" ? { role } : {}) });
  const { data, error, loading, reload } = useApi<{ members: AdminMember[] }>(`/api/admin/members?${qs.toString()}`);
  const [email, setEmail] = useState("");

  const preInvite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/admin/members", { method: "POST", body: { email } });
      toast.success(`${email} can now sign in with Google or GitHub`);
      setEmail("");
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search members" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Filter by status" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="disabled">Disabled / banned</SelectItem>
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger aria-label="Filter by role" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="admin">Admins</SelectItem>
            <SelectItem value="member">Members</SelectItem>
          </SelectContent>
        </Select>
        <Button asChild>
          <Link to="/admin/invitations">
            <UserPlus /> Invite
          </Link>
        </Button>
      </div>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="hidden md:table-cell">Sign-in</TableHead>
                <TableHead className="hidden lg:table-cell">Storage</TableHead>
                <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.id} className="cursor-pointer" onClick={() => navigate(`/admin/members/${m.id}`)}>
                  <TableCell className="max-w-72">
                    <Link to={`/admin/members/${m.id}`} className="flex items-center gap-3 outline-none focus-visible:underline">
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs">{(m.name ?? m.email).slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{m.name ?? m.email}</span>
                          {statusBadge(m)}
                          {m.role === "admin" ? <Badge>Admin</Badge> : null}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span className="flex flex-wrap gap-1">
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
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {formatBytes(m.usedBytes)} / {m.quotaUnlimited ? "∞" : formatBytes(m.quotaBytes)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{m.lastLoginAt ? formatDate(m.lastLoginAt) : "Never"}</TableCell>
                </TableRow>
              ))}
              {!data.members.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No members match.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Allow an email address</CardTitle>
          <CardDescription>Adds an email to the allowlist so it can sign in with Google or GitHub (verified email). For Microsoft or a password, use an invitation link bound to the email.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={preInvite} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="allow-email">Email</Label>
              <Input id="allow-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <Button type="submit" variant="outline">
              Add
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
