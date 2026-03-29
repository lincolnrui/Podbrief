import { Outlet, Link, useLocation } from 'react-router-dom';
import { LayoutGrid, MessageSquare, BookOpen, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/utils';

export default function Layout() {
  const location = useLocation();
  const { user, signOut } = useAuth();

  const navItems = [
    { to: '/', label: 'Feed', icon: LayoutGrid },
    { to: '/chat', label: 'Chat', icon: MessageSquare },
    { to: '/channels', label: 'Channels', icon: BookOpen },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">

          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <span className="font-bold text-primary-foreground text-sm leading-none">P</span>
            </div>
            <span className="font-semibold text-[15px] tracking-tight text-foreground">PodcastPro</span>
          </Link>

          {/* Nav */}
          <nav className="flex items-center gap-0.5">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
                  location.pathname === to
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </Link>
            ))}
          </nav>

          {/* User */}
          <div className="flex items-center gap-2">
            <span className="hidden sm:block text-xs text-muted-foreground truncate max-w-[160px]">
              {user?.email}
            </span>
            <button
              onClick={signOut}
              title="Sign out"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
