import { ChevronsUpDown, Download, FolderOpen, HardDrive, KeyRound, LogOut, Palette, RefreshCw, Search, Share2, Shield, Trash2, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { USAGE_CHANGED_EVENT, useAuth, useMe } from "@/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/Kbd";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useOnline } from "@/lib/hooks";
import { formatBytes } from "@/lib/utils";
import { useInstall, useSwUpdate } from "@/pwa/usePwa";
import { UploadPanel } from "@/upload/UploadPanel";
import { UPLOADED_EVENT, useUploads } from "@/upload/UploadProvider";
import { CommandPalette, OPEN_PALETTE_EVENT } from "./CommandPalette";
import { Logo } from "./Logo";
import { ThemeRadioItems } from "./ThemeToggle";
import { QuotaBanner, QuotaBar } from "./quota";

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-warning/20 px-4 py-2 text-sm">
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
    <div role="status" className="flex flex-wrap items-center gap-3 bg-primary px-4 py-2 text-sm text-primary-foreground">
      <RefreshCw className="size-4" aria-hidden />
      <span className="flex-1">{waitingForUploads ? "Update will apply when your uploads finish." : "A new version of FileNest is available."}</span>
      {!waitingForUploads ? (
        <Button size="sm" variant="secondary" onClick={applyUpdate}>
          Update
        </Button>
      ) : null}
    </div>
  );
}

function InstallItem() {
  const { canPrompt, showIosHint, install } = useInstall();
  const [iosOpen, setIosOpen] = useState(false);
  if (!canPrompt && !showIosHint) return null;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => (canPrompt ? void install() : setIosOpen(true))} tooltip="Install app">
          <Download /> <span>Install app</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <Dialog open={iosOpen} onOpenChange={setIosOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Install FileNest on iPhone or iPad</DialogTitle>
            <DialogDescription>Add it to your Home Screen from Safari.</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Tap the <strong>Share</strong> button in Safari’s toolbar.
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>, then open FileNest from your Home Screen.
            </li>
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StorageMeter() {
  const me = useMe();
  return <QuotaBar user={me.user} className="px-2 py-1 text-sidebar-foreground group-data-[collapsible=icon]:hidden" />;
}

function NavItem({ to, icon, label, end }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
  const loc = useLocation();
  const active = end ? loc.pathname === to || loc.pathname.startsWith("/folders/") : loc.pathname.startsWith(to);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label} size="lg" className="h-10">
        <Link to={to} aria-current={active ? "page" : undefined}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function UserMenu({ compact }: { compact?: boolean }) {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const display = me.user.name ?? me.user.email;
  const avatar = (
    <Avatar className="size-8 rounded-lg">
      <AvatarFallback className="rounded-lg bg-primary/15 text-primary">{display.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
  return (
    <DropdownMenu>
      {compact ? (
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account: ${me.user.email}`}>
            {avatar}
          </Button>
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg" aria-label={`Account: ${me.user.email}`} className="data-[state=open]:bg-sidebar-accent">
            {avatar}
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{display}</span>
              <span className="truncate text-xs text-sidebar-foreground/70">{me.user.email}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent className="w-60" align="end" side={compact ? "bottom" : "top"}>
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{display}</div>
          <div className="truncate text-xs text-muted-foreground">{me.user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette /> Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ThemeRadioItems />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            <KeyRound /> Settings & API tokens
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar() {
  const me = useMe();
  const { setOpenMobile } = useSidebar();
  const loc = useLocation();
  useEffect(() => setOpenMobile(false), [loc.pathname, setOpenMobile]);
  return (
    <Sidebar collapsible="icon" aria-label="Main">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" aria-label="FileNest home">
                <Logo className="size-8 shrink-0" />
                <span className="text-base font-semibold tracking-tight">
                  File<span className="text-primary">Nest</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem to="/" end icon={<FolderOpen />} label="My Drive" />
              <NavItem to="/shared" icon={<Share2 />} label="Shared with me" />
              <NavItem to="/trash" icon={<Trash2 />} label="Trash" />
              {me.user.role === "admin" ? <NavItem to="/admin" icon={<Shield />} label="Admin" /> : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <StorageMeter />
        <SidebarMenu>
          <InstallItem />
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function QuotaBannerForMe() {
  return <QuotaBanner user={useMe().user} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { refreshSilently } = useAuth();
  // Keep the storage meter current after uploads/purges: debounced, and a failure
  // never changes auth state (so in-flight uploads keep running).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(refreshSilently, 800);
    };
    window.addEventListener(UPLOADED_EVENT, on);
    window.addEventListener(USAGE_CHANGED_EVENT, on);
    return () => {
      clearTimeout(t);
      window.removeEventListener(UPLOADED_EVENT, on);
      window.removeEventListener(USAGE_CHANGED_EVENT, on);
    };
  }, [refreshSilently]);

  return (
    <SidebarProvider className="h-svh min-h-0">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <OfflineBanner />
        <PwaBar />
        <QuotaBannerForMe />
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarTrigger aria-label="Toggle navigation" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
          <Button
            variant="outline"
            className="h-9 max-w-md flex-1 justify-start gap-2 text-muted-foreground"
            onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
            aria-label="Search files"
          >
            <Search className="size-4" />
            <span className="truncate">Search files…</span>
            <Kbd className="ml-auto hidden sm:inline-flex">⌘K</Kbd>
          </Button>
          <div className="ml-auto md:hidden">
            <UserMenu compact />
          </div>
        </header>
        <main id="main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
          {children}
        </main>
      </SidebarInset>
      <UploadPanel />
      <CommandPalette />
    </SidebarProvider>
  );
}
