import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, formatBytes } from "@/lib/utils";
import { t } from "@/i18n";

interface UsageRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  quotaBytes: number;
  quotaUnlimited: boolean;
  usedBytes: number;
  trashedBytes: number;
  fileCount: number;
  percent: number | null;
}

const GB = 1024 ** 3;

export function UsagePage() {
  const [filter, setFilter] = useState("all");
  const { data, error, loading, reload } = useApi<{ members: UsageRow[]; totalBytes: number; capBytes: number | null }>(
    `/api/admin/usage${filter !== "all" ? `?filter=${filter}` : ""}`,
  );
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [quota, setQuota] = useState("10");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ updated: number }>("/api/admin/members/bulk-quota", {
        method: "POST",
        body: { userIds: [...sel], quotaBytes: quota === "unlimited" ? null : Number(quota) * GB },
      });
      toast.success(t("Quota updated for {updated} member(s)", { updated: r.updated }));
      setSel(new Set());
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const capPct = data.capBytes ? Math.min(100, (data.totalBytes / data.capBytes) * 100) : null;
  const allSel = data.members.length > 0 && data.members.every((m) => sel.has(m.id));

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("Total storage")}</CardTitle>
          <CardDescription>
            {formatBytes(data.totalBytes)}{" "}{t("used")}{data.capBytes ? t(" of {capBytes} total capacity (all R2 targets)", { capBytes: formatBytes(data.capBytes) }) : t(" · no capacity limit")}
          </CardDescription>
        </CardHeader>
        {capPct !== null ? (
          <CardContent>
            <Progress value={capPct} aria-label={t("Total storage used")} className={capPct >= 95 ? "[&>div]:bg-destructive" : capPct >= 80 ? "[&>div]:bg-warning" : undefined} />
          </CardContent>
        ) : null}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(v) => (setFilter(v), setSel(new Set()))}>
          <SelectTrigger aria-label={t("Filter members")} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All members")}</SelectItem>
            <SelectItem value="near">{t("80% of quota or more")}</SelectItem>
            <SelectItem value="over">{t("Over quota")}</SelectItem>
          </SelectContent>
        </Select>
        {sel.size ? (
          <div role="toolbar" aria-label={t("Bulk quota")} className="ml-auto flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-1.5">
            <span className="text-sm">{sel.size}{" "}{t("selected · set quota to")}</span>
            <Select value={quota} onValueChange={setQuota}>
              <SelectTrigger aria-label={t("New quota")} size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unlimited">{t("Unlimited")}</SelectItem>
                {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((g) => (
                  <SelectItem key={g} value={String(g)}>
                    {formatBytes(g * GB)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={busy} onClick={() => void apply()}>
              {t("Apply")}
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  aria-label={t("Select all")}
                  checked={allSel ? true : sel.size ? "indeterminate" : false}
                  onCheckedChange={(v) => setSel(v === true ? new Set(data.members.slice(0, 100).map((m) => m.id)) : new Set())}
                />
              </TableHead>
              <TableHead>{t("Member")}</TableHead>
              <TableHead className="w-56">{t("Usage")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("In trash")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("Files")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.members.map((m) => {
              const pct = m.percent ?? 0;
              return (
                <TableRow key={m.id} data-state={sel.has(m.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      aria-label={t("Select {email}", { email: m.email })}
                      checked={sel.has(m.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(sel);
                        if (v === true) next.add(m.id);
                        else next.delete(m.id);
                        setSel(next);
                      }}
                    />
                  </TableCell>
                  <TableCell className="max-w-64">
                    <Link to={`/admin/members/${m.id}`} className="block truncate font-medium hover:underline">
                      {m.name ?? m.email}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span>
                          {formatBytes(m.usedBytes)} / {m.quotaUnlimited ? "∞" : formatBytes(m.quotaBytes)}
                        </span>
                        {m.percent !== null && pct > 100 ? <Badge variant="destructive">{t("Over")}</Badge> : m.percent !== null ? <span className="tabular-nums">{Math.round(pct)}%</span> : null}
                      </div>
                      {m.quotaUnlimited ? null : (
                        <Progress
                          value={Math.min(100, pct)}
                          aria-label={t("{email} storage", { email: m.email })}
                          className={cn("h-1.5", pct >= 95 ? "[&>div]:bg-destructive" : pct >= 80 ? "[&>div]:bg-warning" : undefined)}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatBytes(m.trashedBytes)}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{m.fileCount}</TableCell>
                </TableRow>
              );
            })}
            {!data.members.length ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  {t("No members match.")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
