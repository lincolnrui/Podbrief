import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { summarizeVideo } from '../lib/gemini';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, PlayCircle, Loader2, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

const INITIAL_CHANNELS = [
  { name: 'All-In Podcast', youtube_channel_id: 'UCESLZhusAkFfsNsApnjF_Cg', description: 'All-In Podcast' },
  { name: 'a16z', youtube_channel_id: 'UC9cn0TuPq4dnbTY-CBsm8XA', description: 'a16z' },
  { name: '20VC', youtube_channel_id: 'UCf0PBRjhf0rF8fWBIxTuoWA', description: '20VC' },
  { name: 'Latent Space', youtube_channel_id: 'UCxBcwypKK-W3GHd_RZ9FZrQ', description: 'Latent Space' },
  { name: 'No Priors', youtube_channel_id: 'UCSI7h9hydQ40K5MJHnCrQvw', description: 'No Priors' },
];

export default function Feed() {
  const [channels, setChannels] = useState<any[]>([]);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Podcast Briefing";
    async function init() {
      if (!isSupabaseConfigured) {
        setLoading(false);
        return;
      }
      setLoading(true);
      await seedChannelsIfEmpty();
      await fetchChannels();
      await fetchEpisodes();
      setLoading(false);
    }
    init();
  }, []);

  async function seedChannelsIfEmpty() {
    const { data, error } = await supabase.from('channels').select('id').limit(1);
    if (error) {
      console.error("Error checking channels:", error);
      return;
    }
    if (data.length === 0) {
      await supabase.from('channels').insert(INITIAL_CHANNELS);
    }
  }

  async function fetchChannels() {
    const { data } = await supabase.from('channels').select('*').order('name');
    if (data) {
      // Deduplicate channels by youtube_channel_id just in case
      const uniqueChannels = data.reduce((acc, current) => {
        const x = acc.find((item: any) => item.youtube_channel_id === current.youtube_channel_id);
        if (!x) {
          return acc.concat([current]);
        } else {
          return acc;
        }
      }, []);
      setChannels(uniqueChannels);
    }
  }

  async function fetchEpisodes() {
    const { data } = await supabase
      .from('episodes')
      .select('*, channels(name)')
      .order('published_at', { ascending: false });
    if (data) setEpisodes(data);
  }

  async function handleFetchAndSummarize() {
    setIsFetching(true);
    setError(null);
    setFetchProgress('Fetching latest videos from YouTube...');
    try {
      let totalProcessed = 0;
      for (const channel of channels) {
        setFetchProgress(`Checking channel: ${channel.name}...`);
        const res = await fetch(`/api/youtube/latest?channelId=${channel.youtube_channel_id}`);
        const ytData = await res.json();
        
        if (!res.ok) {
          throw new Error(ytData.error || 'Failed to fetch YouTube data');
        }

        if (ytData.items) {
          for (const item of ytData.items) {
            const videoId = item.id.videoId;
            if (!videoId) continue;

            const { data: existing } = await supabase
              .from('episodes')
              .select('id')
              .eq('youtube_video_id', videoId)
              .single();
              
            if (!existing) {
              const decodedTitle = decodeHtml(item.snippet.title);
              try {
                setFetchProgress(`Summarizing: ${decodedTitle.substring(0, 40)}...`);
                const summaryData = await summarizeVideo(videoId, decodedTitle, item.snippet.description);
                const { error: insertError } = await supabase.from('episodes').insert({
                  channel_id: channel.id,
                  youtube_video_id: videoId,
                  title: decodedTitle,
                  published_at: item.snippet.publishedAt,
                  thumbnail_url: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
                  summary: summaryData.summary,
                  key_points: summaryData.key_points,
                  fetched_at: new Date().toISOString()
                });
                if (insertError) {
                  if (insertError.message.includes('row-level security')) {
                    throw new Error(`Supabase RLS Error: Please disable Row Level Security (RLS) on the 'episodes' table in your Supabase dashboard, or add a policy to allow inserts.`);
                  }
                  throw new Error(`Supabase insert error: ${insertError.message}`);
                }
                totalProcessed++;
                // Update UI progressively
                await fetchEpisodes();
                
                // Add a small delay to avoid hitting rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));
              } catch (e: any) {
                console.error(`Failed to summarize video ${videoId}:`, e);
                // Don't throw, just continue to the next video
                if (e.message === 'VIDEO_TOO_SHORT') {
                  console.log(`Skipping video ${videoId} because it is too short.`);
                  continue;
                }
                if (e.message.includes('429') || e.message.includes('quota') || e.message.includes('exhausted')) {
                  setError(`Rate limit reached. Please wait a minute before fetching more videos.`);
                  // Break out of the loops if we hit a rate limit
                  setFetchProgress(totalProcessed > 0 ? `Stopped early due to rate limits. Processed ${totalProcessed} videos.` : 'Stopped due to rate limits.');
                  setTimeout(() => setFetchProgress(''), 5000);
                  setIsFetching(false);
                  return;
                }
                setError(`Failed to process video ${decodedTitle}: ${e.message}`);
              }
            }
          }
        }
      }
      setFetchProgress(totalProcessed > 0 ? `Successfully processed ${totalProcessed} new videos!` : 'No new videos found.');
      setTimeout(() => setFetchProgress(''), 3000);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred while fetching latest episodes.');
      setFetchProgress('');
    } finally {
      setIsFetching(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4 text-center">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-bold text-zinc-100 mb-2">Supabase Configuration Required</h2>
          <p className="text-zinc-400 max-w-md">
            Please set <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code> in your environment variables to use this application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
      {/* Sidebar */}
      <div className="lg:col-span-1 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Tracked Channels</h2>
          <div className="space-y-2">
            {channels.map(channel => (
              <button 
                key={channel.id} 
                onClick={() => setSelectedChannelId(selectedChannelId === channel.id ? null : channel.id)}
                className={`w-full p-3 rounded-xl border flex items-center justify-between text-left transition-colors ${
                  selectedChannelId === channel.id 
                    ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200' 
                    : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <span className="text-sm font-medium">{channel.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Feed */}
      <div className="lg:col-span-3 space-y-6">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <h1 className="text-2xl font-bold tracking-tight">
            {selectedChannelId 
              ? `${channels.find(c => c.id === selectedChannelId)?.name} Briefings` 
              : 'Latest Briefings'}
          </h1>
          <button
            onClick={handleFetchAndSummarize}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {isFetching ? 'Processing...' : 'Fetch Latest'}
          </button>
        </div>

        {fetchProgress && (
          <div className="p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl flex items-center gap-3">
            {isFetching && <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />}
            <p className="text-sm text-indigo-200">{fetchProgress}</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/50 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <p className="text-sm text-red-200">{error}</p>
          </div>
        )}

        <div className="space-y-6">
          {(selectedChannelId ? episodes.filter(ep => ep.channel_id === selectedChannelId) : episodes).length === 0 ? (
            <div className="text-center py-12 bg-zinc-900/30 rounded-2xl border border-zinc-800/50 border-dashed">
              <p className="text-zinc-400">No episodes yet. Click "Fetch Latest" to get started.</p>
            </div>
          ) : (
            (selectedChannelId ? episodes.filter(ep => ep.channel_id === selectedChannelId) : episodes).map(episode => (
              <Link 
                key={episode.id} 
                to={`/episode/${episode.id}`}
                className="block bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-colors rounded-2xl overflow-hidden group"
              >
                <div className="flex flex-col sm:flex-row">
                  <div className="sm:w-64 shrink-0 relative">
                    <img 
                      src={episode.thumbnail_url} 
                      alt={episode.title}
                      className="w-full h-full object-cover aspect-video sm:aspect-auto"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition-colors flex items-center justify-center">
                      <PlayCircle className="w-10 h-10 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
                    </div>
                  </div>
                  <div className="p-5 flex-1 flex flex-col">
                    <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
                      <span className="text-indigo-400">{episode.channels?.name}</span>
                      <span>•</span>
                      <span>{formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })}</span>
                    </div>
                    <h3 className="text-lg font-semibold text-zinc-100 mb-3 line-clamp-2 group-hover:text-indigo-400 transition-colors">
                      {decodeHtml(episode.title)}
                    </h3>
                    <p className="text-sm text-zinc-400 mb-4 line-clamp-3 leading-relaxed">
                      {episode.summary}
                    </p>
                    <div className="mt-auto">
                      <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Key Insights</h4>
                      <ul className="space-y-1">
                        {episode.key_points?.slice(0, 3).map((point: string, i: number) => (
                          <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                            <span className="text-indigo-500 mt-0.5">•</span>
                            <span className="line-clamp-1">{point}</span>
                          </li>
                        ))}
                        {episode.key_points?.length > 3 && (
                          <li className="text-xs text-zinc-500 italic mt-1">
                            + {episode.key_points.length - 3} more points
                          </li>
                        )}
                      </ul>
                    </div>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
