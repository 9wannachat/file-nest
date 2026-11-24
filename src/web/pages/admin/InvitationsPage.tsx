import { Copy, Link2, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { InvitationInfo } from "@shared/types";
import { useReauth } from "@/components/reauth";
import { ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";
import { t, type MessageKey } from "@/i18n";

const copy = (url: string) =>
  navigator.clipboard.writeText(url).then(
    () => toast.success(t("Invitation link copied")),
    () => toast.error(t("Could not copy")),
  );

const STATE: Record<InvitationInfo["state"], { label: MessageKey; variant: "secondary" | "outline" | "destructive" }> = {
  active: { label: "Active", variant: "secondary" },
  used_up: { label: "Used", variant: "outline" },
  expired: { label: "Expired", variant: "outline" },
  revoked: { label: "Revoked", variant: "destructive" },
};

export function InvitationsPage() {
  const run = useReauth();
  const { data, error, loading, reload } = useApi<{ invitations: InvitationInfo[]; revealed: boolean }>("/api/admin/invitations");
  const [form, setForm] = useState({ email: "", role: "member", maxUses: "1", days: "7", note: "" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<InvitationInfo | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await run(() =>
        api<InvitationInfo>("/api/admin/invitations", {
          method: "POST",
          body: {
            email: form.email.trim() || null,
            role: form.role,
            maxUses: form.email.trim() ? 1 : Number(form.maxUses),
            expiresInDays: Number(form.days),
            note: form.note,
          },
        }),
      );
      if (r) {
        setCreated(r);
        setForm({ email: "", role: "member", maxUses: "1", days: "7", note: "" });
        void reload();
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("Create an invitation link")}</CardTitle>
          <CardDescription>
            {t("Links bound to an email can be used with Google, Microsoft, GitHub or a password for that address. Open links (no email) accept Google or GitHub sign-in only. Links are secret: share them only with the people you invite.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="inv-email">{t("Email (optional — limits the link to this address)")}</Label>
                <Input id="inv-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t("anyone with the link")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inv-role">{t("Role")}</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger id="inv-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t("Member")}</SelectItem>
                    <SelectItem value="admin">{t("Admin")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inv-days">{t("Expires")}</Label>
                <Select value={form.days} onValueChange={(v) => setForm({ ...form, days: v })}>
                  <SelectTrigger id="inv-days" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 3, 7, 14, 30, 90].map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}{" "}{t("day")}{d > 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inv-uses">{t("Uses")}</Label>
                <Select value={form.email.trim() ? "1" : form.maxUses} disabled={!!form.email.trim()} onValueChange={(v) => setForm({ ...form, maxUses: v })}>
                  <SelectTrigger id="inv-uses" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 5, 10, 25, 100].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} {n > 1 ? "people" : "person"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="inv-note">{t("Note (optional)")}</Label>
                <Input id="inv-note" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("e.g. Design team")} />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={busy}>
                <Link2 />{" "}{t("Create link")}
              </Button>
            </div>
          </form>
          {created?.url ? (
            <div role="status" className="mt-4 grid gap-2 rounded-lg border border-primary/40 bg-primary/10 p-3">
              <Label htmlFor="inv-created">{t("New invitation link")}</Label>
              <div className="flex gap-2">
                <Input id="inv-created" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="text-xs" />
                <Button variant="outline" onClick={() => void copy(created.url!)}>
                  <Copy />{" "}{t("Copy")}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && !data.revealed && data.invitations.some((i) => i.state === "active") ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <span className="flex-1">{t("Invitation links are hidden until you confirm it’s you.")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                if ((await run(() => api("/api/admin/invitations/reveal", { method: "POST" }))) !== undefined) void reload();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            {t("Show links")}
          </Button>
        </div>
      ) : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Invitation")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("Used")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("Expires")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("Actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="max-w-64">
                    <div className="truncate font-medium">{i.email ?? t("Anyone with the link")}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {i.role === "admin" ? t("Admin") : t("Member")}
                      {i.note ? ` · ${i.note}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE[i.state].variant}>{t(STATE[i.state].label)}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {i.useCount}/{i.maxUses}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(i.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    {i.state === "active" ? (
                      <span className="inline-flex gap-1">
                        {i.url ? (
                          <Button size="icon-sm" variant="ghost" aria-label={t("Copy invitation link")} onClick={() => void copy(i.url!)}>
                            <Copy />
                          </Button>
                        ) : null}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("Revoke invitation")}
                          onClick={async () => {
                            try {
                              await api(`/api/admin/invitations/${i.id}`, { method: "DELETE" });
                              toast.success(t("Invitation revoked"));
                              void reload();
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {!data.invitations.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {t("No invitations yet.")}
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
