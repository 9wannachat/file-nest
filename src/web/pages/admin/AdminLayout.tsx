import { Activity, Database, Globe, LayoutDashboard, Mail, Settings2, Users } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/admin/members", label: "Members", icon: Users },
  { to: "/admin/invitations", label: "Invitations", icon: Mail },
  { to: "/admin/links", label: "Public links", icon: Globe },
  { to: "/admin/settings", label: "Settings", icon: Settings2 },
  { to: "/admin/storage", label: "Storage", icon: Database },
  { to: "/admin/audit", label: "Audit log", icon: Activity },
];

/** Admin Console shell: section navigation (scrollable on mobile) + page outlet. */
export function AdminLayout() {
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <div className="px-4 pt-5 pb-2 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Admin Console</h1>
        <p className="text-sm text-muted-foreground">Members, access, settings and storage for this FileNest.</p>
      </div>
      <nav aria-label="Admin sections" className="sticky top-0 z-10 border-b bg-background/95 px-2 backdrop-blur sm:px-4">
        <ul className="flex gap-1 overflow-x-auto">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
                    isActive ? "border-primary text-foreground" : "border-transparent",
                  )
                }
              >
                <Icon className="size-4" aria-hidden /> {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="px-4 pt-4 sm:px-6">
        <Outlet />
      </div>
    </div>
  );
}
