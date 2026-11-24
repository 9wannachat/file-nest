import { KeyRound, Link2Off, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/dialogs";
import { ErrorState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { formatBytes, formatDate } from "@/lib/utils";
import { t } from "@/i18n";

interface LinkRow {
  id: string;
  fileName: string;
  size: number;
  ownerEmail: string;
  createdAt: number;
  passwordProtected: boolean;
}

/** Moderation of PUBLIC links only (already exposed to anyone with the URL). */
export function PublicLinksPage() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const { data, error, loading, reload } = useApi<{ links: LinkRow[] }>(`/api/admin/public-links${dq.trim() ? `?q=${encodeURIComponent(dq.trim())}` : ""}`);
  const [revoke, setRevoke] = useState<LinkRow | null>(null);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t("Every active “anyone with the link” share. Revoking takes effect immediately; the owner can create a new link.")}</p>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input aria-label={t("Search by file name")} placeholder={t("Search by file name")} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("File")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("Owner")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("Created")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("Actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.links.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="max-w-72">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{l.fileName}</span>
                      {l.passwordProtected ? (
                        <Badge variant="secondary">
                          <KeyRound />{" "}{t("Password")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatBytes(l.size)}</div>
                  </TableCell>
                  <TableCell className="hidden truncate text-muted-foreground md:table-cell">{l.ownerEmail}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(l.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setRevoke(l)}>
                      <Link2Off />{" "}{t("Revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!data.links.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    {t("No active public links.")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      ) : null}
      <ConfirmDialog
        open={!!revoke}
        title={t("Revoke this public link?")}
        body={t("“{name}” will no longer be reachable through its link.", { name: revoke?.fileName ?? "" })}
        confirmLabel={t("Revoke link")}
        destructive
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          await api(`/api/admin/public-links/${revoke!.id}`, { method: "DELETE" });
          toast.success(t("Link revoked"));
          void reload();
        }}
      />
    </div>
  );
}
