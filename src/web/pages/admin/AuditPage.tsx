import { Download } from "lucide-react";
import { useState } from "react";
import type { AuditEvent } from "@shared/types";
import { ErrorState, Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/utils";

const GROUPS: [string, string][] = [
  ["all", "All actions"],
  ["member.", "Members"],
  ["invite.", "Invitations"],
  ["auth.", "Sign-in & security"],
  ["share.", "Sharing"],
  ["token.", "API tokens"],
  ["storage.", "Storage"],
  ["settings.", "Settings"],
];

type Row = AuditEvent & { actorEmail: string | null };

export function AuditPage() {
  const [group, setGroup] = useState("all");
  const filter = group !== "all" ? `action=${encodeURIComponent(group)}` : "";
  const { data, error, loading, reload, setData } = useApi<{ events: Row[] }>(`/api/admin/audit${filter ? `?${filter}` : ""}`);
  const [more, setMore] = useState(false);

  const loadMore = async () => {
    const last = data?.events.at(-1);
    if (!last) return;
    setMore(true);
    try {
      const r = await api<{ events: Row[] }>(`/api/admin/audit?before=${last.createdAt}${filter ? `&${filter}` : ""}`);
      setData({ events: [...(data?.events ?? []), ...r.events] });
    } finally {
      setMore(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger aria-label="Filter actions" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUPS.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild variant="outline" className="ml-auto">
          <a href={`/api/admin/audit.csv${filter ? `?${filter}` : ""}`} download>
            <Download /> Export CSV
          </a>
        </Button>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden md:table-cell">Actor</TableHead>
                <TableHead className="hidden lg:table-cell">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                  <TableCell>
                    <code className="text-primary">{e.action}</code>
                  </TableCell>
                  <TableCell className="hidden max-w-48 truncate text-muted-foreground md:table-cell">{e.actorEmail ?? "—"}</TableCell>
                  <TableCell className="hidden max-w-md truncate text-muted-foreground lg:table-cell" title={`${e.resourceType} ${e.resourceId} ${e.metadata ?? ""}`}>
                    {e.resourceType} {e.metadata ?? ""}
                  </TableCell>
                </TableRow>
              ))}
              {!data.events.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No events.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      ) : null}
      {data && data.events.length >= 100 ? (
        <Button variant="outline" className="w-fit" disabled={more} onClick={() => void loadMore()}>
          Load older
        </Button>
      ) : null}
    </div>
  );
}
