import { Outlet, Link, useLocation } from 'react-router-dom';
import { MessageSquare, LayoutGrid } from 'lucide-react';
import clsx from 'clsx';

export default function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
              <span className="font-bold text-white text-lg">P</span>
            </div>
            <span className="font-semibold text-xl tracking-tight">PodBrief</span>
          </div>
          <nav className="flex items-center gap-1">
            <Link
              to="/"
              className={clsx(
                "px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
                location.pathname === '/' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              )}
            >
              <LayoutGrid className="w-4 h-4" />
              Feed
            </Link>
            <Link
              to="/chat"
              className={clsx(
                "px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
                location.pathname === '/chat' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              )}
            >
              <MessageSquare className="w-4 h-4" />
              Chat
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
