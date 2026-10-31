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
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import type { Role } from '../types'

const nav = [
  { to: '/', label: 'Command center', icon: LayoutDashboard },
  { to: '/ingest', label: 'Ingest & extract', icon: ScanLine },
  { to: '/policy', label: 'Policy reader', icon: BookOpen },
  { to: '/alerts', label: 'Fraud & leakage', icon: ShieldAlert },
  { to: '/claims', label: 'Claims workspace', icon: FileSearch },
  { to: '/providers', label: 'Provider intel', icon: Users },
  { to: '/special', label: 'Special review', icon: Sparkles },
  { to: '/audit', label: 'Audit trail', icon: Activity },
  { to: '/settings', label: 'Agent connection', icon: Settings },
]

export function Layout() {
  const location = useLocation()
  const { role, setRole, claims } = useAppStore()
  const special = claims.filter((c) => c.queue === 'special').length
  const flagged = claims.filter((c) => c.queue === 'flagged' || c.queue === 'confirmed').length

  return (
    <div className="min-h-svh bg-mist text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col bg-ink text-white lg:flex">
        <div className="flex items-center gap-3 px-5 py-6">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-ink">
            <ShieldAlert size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">ClaimsGuard AI</p>
            <p className="text-[11px] text-white/50">Leakage detection desk</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {nav.map((item) => {
            const Icon = item.icon
            const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm ${
                  active ? 'bg-brand text-ink' : 'text-white/75 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon size={16} />
                  {item.label}
                </span>
                {item.to === '/special' && special > 0 ? (
                  <span className={`rounded-full px-1.5 text-[10px] ${active ? 'bg-ink text-brand' : 'bg-brand text-ink'}`}>
                    {special}
                  </span>
                ) : null}
                {item.to === '/alerts' && flagged > 0 && !active ? (
                  <span className="rounded-full bg-white/10 px-1.5 text-[10px]">{flagged}</span>
                ) : null}
              </NavLink>
            )
          })}
        </nav>
        <div className="p-4">
          <p className="mb-2 px-1 text-[11px] uppercase tracking-wider text-white/40">Active role</p>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
          >
            <option value="handler">Claims handler</option>
            <option value="supervisor">Supervisor agent</option>
            <option value="executive">Executive</option>
          </select>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white/90 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex items-center gap-2 text-sm text-mute">
            <Bell size={16} className="text-brand-dark" />
            Live desk · detection engine is connected from the sister project
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-line bg-mist px-3 py-1 text-xs text-mute md:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Demo portfolio · INR
          </div>
        </header>
        <nav className="flex gap-2 overflow-x-auto border-b border-line bg-white px-4 py-2 lg:hidden">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-full px-3 py-1.5 text-xs ${
                  isActive ? 'bg-brand text-ink' : 'bg-mist text-mute'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
