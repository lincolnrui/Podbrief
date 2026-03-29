/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import Feed from './pages/Feed';
import Chat from './pages/Chat';
import EpisodeDetail from './pages/EpisodeDetail';
import Channels from './pages/Channels';
import Auth from './pages/Auth';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Feed />} />
            <Route path="chat" element={<Chat />} />
            <Route path="channels" element={<Channels />} />
            <Route path="episode/:id" element={<EpisodeDetail />} />
          </Route>
        </Routes>
      </Router>
    </AuthProvider>
  );
}
