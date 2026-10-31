import {
  Activity,
  Bell,
  BookOpen,
  FileSearch,
  LayoutDashboard,
  ScanLine,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import type { Role } from "../types";

const nav = [
  { to: "/", label: "Command center", icon: LayoutDashboard },
  { to: "/ingest", label: "Ingest & extract", icon: ScanLine },
  { to: "/policy", label: "Policy reader", icon: BookOpen },
  { to: "/alerts", label: "Fraud & leakage", icon: ShieldAlert },
  { to: "/claims", label: "Claims workspace", icon: FileSearch },
  { to: "/providers", label: "Provider intel", icon: Users },
  { to: "/special", label: "Special review", icon: Sparkles },
  { to: "/audit", label: "Audit trail", icon: Activity },
  { to: "/settings", label: "Agent connection", icon: Settings },
];

export function Layout() {
  const location = useLocation();
  const { role, setRole, claims } = useAppStore();
  const special = claims.filter((c) => c.queue === "special").length;
  const flagged = claims.filter(
    (c) => c.queue === "flagged" || c.queue === "confirmed",
  ).length;

  return (
    <div className="min-h-svh bg-gradient-to-br from-mist via-white to-mist text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-line bg-white lg:flex">
        <div className="flex items-center gap-3 px-6 py-8 border-b border-line">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand-dark text-white shadow-md">
            <ShieldAlert size={20} strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight text-ink">
              ClaimsGuard AI
            </p>
            <p className="text-[11px] text-mute">Leakage detection</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-6">
          {nav.map((item) => {
            const Icon = item.icon;
            const active =
              item.to === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-center justify-between rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                  active
                    ? "bg-gradient-to-r from-brand/10 to-brand/5 text-brand border-l-2 border-brand pl-3"
                    : "text-mute hover:bg-mist hover:text-ink"
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon size={18} />
                  {item.label}
                </span>
                {item.to === "/special" && special > 0 ? (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${active ? "bg-brand text-white" : "bg-brand/10 text-brand"}`}>
                    {special}
                  </span>
                ) : null}
                {item.to === "/alerts" && flagged > 0 && !active ? (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-600">
                    {flagged}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
        </nav>
        <div className="border-t border-line p-4">
          <p className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-mute">
            Active role
          </p>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-lg border border-line bg-mist px-3 py-2.5 text-sm font-medium text-ink outline-none transition-colors focus:border-brand focus:ring-1 focus:ring-brand/20"
          >
            <option value="handler">Claims handler</option>
            <option value="supervisor">Supervisor agent</option>
            <option value="executive">Executive</option>
          </select>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white/80 backdrop-blur-xl px-4 py-3 md:px-8 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-mute">
            <div className="flex items-center gap-2 rounded-full bg-green-50 px-3 py-1.5">
              <span className="h-2 w-2 rounded-full bg-green-600 animate-pulse" />
              <span className="text-xs font-medium text-green-700">Live · Connected</span>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-line bg-mist px-4 py-2 text-xs text-mute md:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Demo portfolio · INR
          </div>
        </header>
        <nav className="flex gap-2 overflow-x-auto border-b border-line bg-white/50 backdrop-blur-sm px-4 py-2 lg:hidden">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-medium transition-all duration-200 ${
                  isActive ? "bg-brand text-white shadow-md" : "bg-mist text-mute hover:text-ink"
                }`
              }
            >
              <item.icon size={14} aria-hidden="true" /> {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-h-[calc(100vh-180px)] px-4 py-8 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
