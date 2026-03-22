/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Feed from './pages/Feed';
import Chat from './pages/Chat';
import EpisodeDetail from './pages/EpisodeDetail';
import Channels from './pages/Channels';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Feed />} />
          <Route path="chat" element={<Chat />} />
          <Route path="channels" element={<Channels />} />
          <Route path="episode/:id" element={<EpisodeDetail />} />
        </Route>
      </Routes>
    </Router>
  );
}
