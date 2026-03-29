import { Outlet, Link, useLocation } from 'react-router-dom';
import { MessageSquare, LayoutGrid, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';

export default function Layout() {
  const location = useLocation();
  const { user, signOut } = useAuth();

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
            <Link
              to="/channels"
              className={clsx(
                "px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
                location.pathname === '/channels' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              )}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
              Channels
            </Link>
            <div className="w-px h-5 bg-zinc-800 mx-1" />
            <span className="text-xs text-zinc-500 hidden sm:block max-w-[140px] truncate">{user?.email}</span>
            <button
              onClick={signOut}
              className="px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
