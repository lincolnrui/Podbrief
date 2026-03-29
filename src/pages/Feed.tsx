import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { summarizeVideo } from '../lib/gemini';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, PlayCircle, Loader2, AlertCircle, PlusCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

function extractVideoId(input: string): { id: string; isShort: boolean } | null {
  const trimmed = input.trim();
  if (trimmed.includes('youtube.com/shorts/')) {
    const m = trimmed.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? { id: m[1], isShort: true } : null;
  }
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return { id: m[1], isShort: false };
  }
  return null;
}

export default function Feed() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<any[]>([]);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skippedVideos, setSkippedVideos] = useState<string[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<'today' | 'week' | 'month' | 'all'>('week');
  const [videoUrl, setVideoUrl] = useState('');
  const [isAddingVideo, setIsAddingVideo] = useState(false);
  const [addVideoError, setAddVideoError] = useState<string | null>(null);
  const [addVideoSuccess, setAddVideoSuccess] = useState<string | null>(null);
  const [addVideoEpisodeId, setAddVideoEpisodeId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Podcast Briefing";
    async function init() {
      if (!isSupabaseConfigured) {
        setLoading(false);
        return;
      }
      setLoading(true);
      await fetchChannels();
      await fetchEpisodes();
      setLoading(false);
    }
    init();
  }, []);

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

  async function handleAddVideo() {
    setAddVideoError(null);
    setAddVideoSuccess(null);
    const parsed = extractVideoId(videoUrl);
    if (!parsed) {
      setAddVideoError("Couldn't find a YouTube video ID in that URL.");
      return;
    }
    if (parsed.isShort) {
      setAddVideoError("Shorts aren't supported — paste a full episode URL.");
      return;
    }
    const { id: videoId } = parsed;
    setIsAddingVideo(true);
    try {
      // Check duplicate
      const { data: existing } = await supabase
        .from('episodes')
        .select('id')
        .eq('youtube_video_id', videoId)
        .single();
      if (existing) {
        setAddVideoError('This video is already in your library.');
        setIsAddingVideo(false);
        return;
      }

      // Fetch transcript + metadata
      const tRes = await fetch(`/api/youtube/transcript?videoId=${videoId}`);
      const td = await tRes.json();

      if (td.durationSeconds > 0 && td.durationSeconds < 1200) {
        setAddVideoError('This video is too short (under 20 minutes).');
        return;
      }
      if (!td.text || td.text.length < 1000) {
        setAddVideoError('No transcript available for this video.');
        return;
      }

      // Match against tracked channels
      const matchedChannel = channels.find(c => c.youtube_channel_id === td.channelId) || null;

      // Summarize
      const sRes = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          title: td.videoTitle || videoId,
          transcriptText: td.text,
          durationSeconds: td.durationSeconds,
        }),
      });
      const summaryData = await sRes.json();
      if (!sRes.ok) {
        if (summaryData.error === 'VIDEO_TOO_SHORT') {
          setAddVideoError('This video is too short (under 20 minutes).');
          return;
        }
        throw new Error(summaryData.error || 'Summarization failed');
      }

      // Insert episode
      const { data: inserted, error: insertError } = await supabase.from('episodes').insert({
        channel_id: matchedChannel?.id ?? null,
        channel_name: matchedChannel ? null : (td.channelTitle || 'Unknown Channel'),
        youtube_video_id: videoId,
        title: td.videoTitle || videoId,
        published_at: td.publishedAt || new Date().toISOString(),
        thumbnail_url: td.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        summary: summaryData.summary,
        key_points: summaryData.key_points,
        fetched_at: new Date().toISOString(),
        user_id: user!.id,
      }).select('id').single();
      if (insertError) throw new Error(insertError.message);

      setVideoUrl('');
      setAddVideoSuccess(td.videoTitle || 'Episode');
      setAddVideoEpisodeId(inserted.id);
      await fetchEpisodes();
    } catch (err: any) {
      setAddVideoError(err.message || 'Something went wrong.');
    } finally {
      setIsAddingVideo(false);
    }
  }

  async function handleFetchAndSummarize() {
    setIsFetching(true);
    setError(null);
    setSkippedVideos([]);
    setFetchProgress('Fetching latest videos from YouTube...');
    try {
      let totalProcessed = 0;
      let failedChannels: string[] = [];
      
      for (const channel of channels) {
        setFetchProgress(`Checking channel: ${channel.name}...`);
        const res = await fetch(`/api/youtube/historical?channelId=${channel.youtube_channel_id}&days=30`);
        const ytData = await res.json();
        
        if (!res.ok) {
          console.error(`Failed to fetch YouTube data for ${channel.name}:`, ytData.error);
          failedChannels.push(channel.name);
          continue;
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
                  fetched_at: new Date().toISOString(),
                  user_id: user!.id
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
                if (e.message === 'VIDEO_TOO_SHORT' || e.message === 'NO_TRANSCRIPT') {
                  setSkippedVideos(prev => [...prev, decodedTitle]);
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
      
      if (failedChannels.length > 0) {
        setError(`Failed to fetch data for: ${failedChannels.join(', ')}. The channel IDs might be invalid or YouTube is rate-limiting.`);
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

  const standaloneCount = episodes.filter(ep => !ep.channel_id).length;

  const filteredEpisodes = episodes.filter(ep => {
    if (selectedChannelId === '__standalone__') {
      if (ep.channel_id) return false;
    } else if (selectedChannelId) {
      if (ep.channel_id !== selectedChannelId) return false;
    }

    const pubDate = new Date(ep.published_at).getTime();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    if (timeFilter === 'today') return now - pubDate <= day;
    if (timeFilter === 'week') return now - pubDate <= 7 * day;
    if (timeFilter === 'month') return now - pubDate <= 30 * day;
    return true;
  });

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
            {standaloneCount > 0 && (
              <button
                onClick={() => setSelectedChannelId(selectedChannelId === '__standalone__' ? null : '__standalone__')}
                className={`w-full p-3 rounded-xl border flex items-center justify-between text-left transition-colors ${
                  selectedChannelId === '__standalone__'
                    ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200'
                    : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <span className="text-sm font-medium">✦ My Picks</span>
                <span className="text-xs text-zinc-500">{standaloneCount}</span>
              </button>
            )}
          </div>
        </div>
        
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-4 mt-8">Time Filter</h2>
          <div className="space-y-2">
            {[
              { id: 'today', label: 'Last 24 Hours' },
              { id: 'week', label: 'Last 7 Days' },
              { id: 'month', label: 'Last 30 Days' },
              { id: 'all', label: 'All Time' }
            ].map(filter => (
              <button 
                key={filter.id} 
                onClick={() => setTimeFilter(filter.id as any)}
                className={`w-full p-3 rounded-xl border flex items-center justify-between text-left transition-colors ${
                  timeFilter === filter.id 
                    ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200' 
                    : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <span className="text-sm font-medium">{filter.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Feed */}
      <div className="lg:col-span-3 space-y-6">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <h1 className="text-2xl font-bold tracking-tight">
            {selectedChannelId === '__standalone__'
              ? 'My Picks'
              : selectedChannelId
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

        {/* Add single video by URL */}
        <div className="space-y-2">
          <form
            onSubmit={e => { e.preventDefault(); handleAddVideo(); }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={videoUrl}
              onChange={e => { setVideoUrl(e.target.value); setAddVideoError(null); setAddVideoSuccess(null); setAddVideoEpisodeId(null); }}
              placeholder="Paste any YouTube URL to add a single video..."
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-zinc-600"
              disabled={isAddingVideo}
            />
            <button
              type="submit"
              disabled={!videoUrl.trim() || isAddingVideo}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-zinc-700 whitespace-nowrap"
            >
              {isAddingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              {isAddingVideo ? 'Processing...' : 'Add Video'}
            </button>
          </form>
          {addVideoError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{addVideoError}
            </p>
          )}
          {addVideoSuccess && (
            <p className="text-xs text-emerald-400 flex items-center gap-1.5">
              <span>✓</span>
              <span><strong>"{addVideoSuccess}"</strong> is ready!{' '}
                {addVideoEpisodeId && (
                  <Link to={`/episode/${addVideoEpisodeId}`} className="underline hover:text-emerald-300 transition-colors">
                    Take a look here →
                  </Link>
                )}
              </span>
            </p>
          )}
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

        {skippedVideos.length > 0 && (
          <div className="p-4 bg-zinc-800/50 border border-zinc-700 rounded-xl">
            <p className="text-sm font-medium text-zinc-300 mb-1">Skipped {skippedVideos.length} video{skippedVideos.length > 1 ? 's' : ''} (no transcript available):</p>
            <ul className="space-y-0.5">
              {skippedVideos.map((title, i) => (
                <li key={i} className="text-sm text-zinc-400 flex items-start gap-2">
                  <span className="text-zinc-600 mt-0.5">•</span>
                  <span>{title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-6">
          {filteredEpisodes.length === 0 ? (
            <div className="text-center py-12 bg-zinc-900/30 rounded-2xl border border-zinc-800/50 border-dashed">
              <p className="text-zinc-400">No episodes found for the selected filters.</p>
            </div>
          ) : (
            filteredEpisodes.map(episode => (
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
                      <span className="text-indigo-400">{episode.channels?.name || episode.channel_name || 'Unknown Channel'}</span>
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
