import { Folder, FolderOpen, KeyRound, Monitor, Moon, Search, Share2, Shield, Sun, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { FileItem, FolderItem } from "@shared/types";
import { useMe } from "@/auth";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { useTheme } from "@/theme";
import { fileIcon } from "./FileList";

export const OPEN_PALETTE_EVENT = "filenest:open-palette";

/** ⌘K / Ctrl+K: search files and folders by name, jump to pages, switch theme. */
export function CommandPalette() {
  const me = useMe();
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ folders: FolderItem[]; files: FileItem[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setQ("");
      setResults(null);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api<{ folders: FolderItem[]; files: FileItem[] }>(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then(setResults)
        .catch(() => {})
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const openFile = (f: FileItem) =>
    go(f.isOwner ? `${f.folderId ? `/folders/${f.folderId}` : "/"}?preview=${f.id}` : `/shared?preview=${f.id}`);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search FileNest" description="Search files and folders, or jump to a page">
      <CommandInput placeholder="Search files and folders…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>{loading ? "Searching…" : "No results."}</CommandEmpty>
        {results?.folders.length ? (
          <CommandGroup heading="Folders">
            {results.folders.slice(0, 8).map((f) => (
              <CommandItem key={f.id} value={`folder ${f.name} ${f.id}`} keywords={[q]} onSelect={() => go(`/folders/${f.id}`)}>
                <Folder className="fill-primary/15 text-primary" />
                {f.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {results?.files.length ? (
          <CommandGroup heading="Files">
            {results.files.slice(0, 12).map((f) => (
              <CommandItem key={f.id} value={`file ${f.name} ${f.id}`} keywords={[q]} onSelect={() => openFile(f)}>
                {fileIcon(f)}
                <span className="truncate">{f.name}</span>
                <CommandShortcut>{formatBytes(f.size)}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {q.trim() ? (
          <CommandGroup heading="Search">
            <CommandItem value={`search all ${q}`} keywords={[q]} onSelect={() => go(`/search?q=${encodeURIComponent(q.trim())}`)}>
              <Search /> See all results for “{q.trim()}”
            </CommandItem>
          </CommandGroup>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => go("/")}>
            <FolderOpen /> My Drive
          </CommandItem>
          <CommandItem onSelect={() => go("/shared")}>
            <Share2 /> Shared with me
          </CommandItem>
          <CommandItem onSelect={() => go("/trash")}>
            <Trash2 /> Trash
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <KeyRound /> Settings & API tokens
          </CommandItem>
          {me.user.role === "admin" ? (
            <CommandItem onSelect={() => go("/admin")}>
              <Shield /> Admin
            </CommandItem>
          ) : null}
        </CommandGroup>
        <CommandGroup heading="Theme">
          <CommandItem onSelect={() => (setTheme("light"), setOpen(false))}>
            <Sun /> Light
          </CommandItem>
          <CommandItem onSelect={() => (setTheme("dark"), setOpen(false))}>
            <Moon /> Dark
          </CommandItem>
          <CommandItem onSelect={() => (setTheme("system"), setOpen(false))}>
            <Monitor /> System
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
