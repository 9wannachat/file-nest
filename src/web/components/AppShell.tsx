import { Download, FolderOpen, HardDrive, KeyRound, LogOut, Menu, RefreshCw, Search, Share2, Shield, Trash2, WifiOff, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useAuth, useMe } from "@/auth";
import { useOnline } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useInstall, useSwUpdate } from "@/pwa/usePwa";
import { UploadPanel } from "@/upload/UploadPanel";
import { useUploads } from "@/upload/UploadProvider";
import { Wordmark } from "./Logo";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "./ui/dialog";
import { Input } from "./ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/menu";

function NavItem({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium [&_svg]:size-5",
          isActive
            ? "bg-brand-50 text-brand-800 dark:bg-brand-800/30 dark:text-brand-100"
            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      You are offline. An internet connection is required to open and upload files.
    </div>
  );
}

function PwaBar() {
  const { active } = useUploads();
  const { needRefresh, waitingForUploads, applyUpdate } = useSwUpdate(active);
  if (!needRefresh) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 bg-brand-700 px-4 py-2 text-sm text-white">
      <RefreshCw className="size-4" aria-hidden />
      <span className="flex-1">
        {waitingForUploads ? "Update will apply when your uploads finish." : "A new version of FileNest is available."}
      </span>
      {!waitingForUploads ? (
        <Button size="sm" variant="secondary" onClick={applyUpdate}>
          Update
        </Button>
      ) : null}
    </div>
  );
}

function InstallButton() {
  const { canPrompt, showIosHint, install } = useInstall();
  const [iosOpen, setIosOpen] = useState(false);
  if (!canPrompt && !showIosHint) return null;
  return (
    <>
      <Button variant="outline" size="sm" className="w-full" onClick={() => (canPrompt ? void install() : setIosOpen(true))}>
        <Download /> Install app
      </Button>
      <Dialog open={iosOpen} onOpenChange={setIosOpen}>
        <DialogContent>
          <DialogHeader title="Install FileNest on iPhone or iPad" />
          <DialogBody>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Tap the <strong>Share</strong> button in Safari’s toolbar.
              </li>
              <li>
                Choose <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong>Add</strong>. Open FileNest from your Home Screen.
              </li>
            </ol>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchBox({ onDone }: { onDone?: () => void }) {
  const [params] = useSearchParams();
  const loc = useLocation();
  const [q, setQ] = useState(loc.pathname === "/search" ? (params.get("q") ?? "") : "");
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/search?q=${encodeURIComponent(q.trim())}`);
    onDone?.();
  };
  return (
    <form role="search" onSubmit={submit} className="relative w-full">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <Input aria-label="Search files by name" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" type="search" />
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  const navigate = useNavigate();
  useEffect(() => setNavOpen(false), [loc.pathname]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      <NavItem to="/" end icon={<FolderOpen />}>
        My Drive
      </NavItem>
      <NavItem to="/shared" icon={<Share2 />}>
        Shared with me
      </NavItem>
      <NavItem to="/trash" icon={<Trash2 />}>
        Trash
      </NavItem>
      {me.user.role === "admin" ? (
        <NavItem to="/admin" icon={<Shield />}>
          Admin
        </NavItem>
      ) : null}
    </nav>
  );

  return (
    <div className="flex h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <OfflineBanner />
      <PwaBar />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r border-slate-200 bg-white p-4 md:flex dark:border-slate-800 dark:bg-slate-900">
          <Wordmark />
          {nav}
          <div className="mt-auto space-y-2">
            <InstallButton />
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <HardDrive className="size-4" aria-hidden /> Files are private unless you share them.
            </p>
          </div>
        </aside>

        {navOpen ? (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-slate-950/40" onClick={() => setNavOpen(false)} />
            <div className="absolute inset-y-0 left-0 flex w-72 flex-col gap-4 bg-white p-4 shadow-xl dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <Wordmark />
                <Button size="icon" variant="ghost" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
                  <X />
                </Button>
              </div>
              {nav}
              <div className="mt-auto">
                <InstallButton />
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-4 dark:border-slate-800 dark:bg-slate-900">
            <Button size="icon" variant="ghost" className="md:hidden" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <Menu />
            </Button>
            <div className="max-w-xl flex-1">
              <SearchBox />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label={`Account: ${me.user.email}`}>
                  <span className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800 uppercase">
                    {(me.user.name ?? me.user.email).slice(0, 1)}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <div className="px-3 py-2 text-sm">
                  <div className="font-medium">{me.user.name ?? me.user.email}</div>
                  <div className="text-xs text-slate-500">{me.user.email}</div>
                </div>
                <DropdownMenuItem onSelect={() => navigate("/settings")}>
                  <KeyRound /> API tokens
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void logout()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <UploadPanel />
    </div>
  );
}
