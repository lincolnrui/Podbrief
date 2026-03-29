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
    document.title = "PodcastPro";
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
        transcript_segments: td.segments?.length > 0 ? td.segments : null,
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

            const decodedTitle = decodeHtml(item.snippet.title);

            const { data: existing } = await supabase
              .from('episodes')
              .select('id, transcript_segments')
              .eq('youtube_video_id', videoId)
              .single();

            if (existing && !existing.transcript_segments) {
              // Episode exists but has no transcript (was added on Vercel without one).
              // Try to fetch the transcript now and update the DB so Deep Synthesis works.
              try {
                setFetchProgress(`Fetching transcript for: ${decodedTitle.substring(0, 40)}...`);
                const tRes = await fetch(`/api/youtube/transcript?videoId=${videoId}`);
                if (tRes.ok) {
                  const td = await tRes.json();
                  if (td.segments?.length > 0) {
                    await supabase
                      .from('episodes')
                      .update({ transcript_segments: td.segments })
                      .eq('id', existing.id);
                    totalProcessed++;
                  }
                }
              } catch {
                // Silently ignore — transcript may still be unavailable
              }
              continue;
            }

            if (!existing) {
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
                  transcript_segments: summaryData.segments?.length > 0 ? summaryData.segments : null,
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
                if (e.message === 'VIDEO_TOO_SHORT' || e.message === 'NO_TRANSCRIPT') {
                  setSkippedVideos(prev => [...prev, decodedTitle]);
                  continue;
                }
                if (e.message.includes('429') || e.message.includes('quota') || e.message.includes('exhausted')) {
                  setError(`Rate limit reached. Please wait a minute before fetching more videos.`);
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
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4 text-center">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Supabase Configuration Required</h2>
          <p className="text-muted-foreground max-w-md text-sm">
            Please set <code className="text-amber-600 bg-amber-50 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-amber-600 bg-amber-50 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code> in your environment variables.
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
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 items-start">

      {/* ── Sidebar ── */}
      <aside className="lg:col-span-1 lg:sticky lg:top-24 space-y-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 px-1">Channels</p>
          <div className="space-y-0.5">
            {channels.map(channel => (
              <button
                key={channel.id}
                onClick={() => setSelectedChannelId(selectedChannelId === channel.id ? null : channel.id)}
                className={`w-full px-3 py-2 rounded-lg flex items-center justify-between text-left transition-all text-sm ${
                  selectedChannelId === channel.id
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {channel.name}
              </button>
            ))}
            {standaloneCount > 0 && (
              <button
                onClick={() => setSelectedChannelId(selectedChannelId === '__standalone__' ? null : '__standalone__')}
                className={`w-full px-3 py-2 rounded-lg flex items-center justify-between text-left transition-all text-sm ${
                  selectedChannelId === '__standalone__'
                    ? 'bg-amber-50 text-amber-700 font-semibold'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <span>✦ My Picks</span>
                <span className={`text-xs tabular-nums ${selectedChannelId === '__standalone__' ? 'text-amber-500' : 'text-muted-foreground/60'}`}>{standaloneCount}</span>
              </button>
            )}
          </div>
        </div>

        <div className="h-px bg-border" />

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 px-1">Time</p>
          <div className="space-y-0.5">
            {[
              { id: 'today', label: 'Last 24 hours' },
              { id: 'week', label: 'Last 7 days' },
              { id: 'month', label: 'Last 30 days' },
              { id: 'all', label: 'All time' },
            ].map(filter => (
              <button
                key={filter.id}
                onClick={() => setTimeFilter(filter.id as any)}
                className={`w-full px-3 py-2 rounded-lg text-left text-sm transition-all ${
                  timeFilter === filter.id
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Main Feed ── */}
      <div className="lg:col-span-3 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {selectedChannelId === '__standalone__'
              ? 'My Picks'
              : selectedChannelId
                ? channels.find(c => c.id === selectedChannelId)?.name
                : 'Latest Briefings'}
          </h1>
          <button
            onClick={handleFetchAndSummarize}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl font-medium text-sm transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {isFetching ? 'Updating...' : 'Fetch Latest'}
          </button>
        </div>

        {/* Add video input */}
        <div className="space-y-2">
          <form onSubmit={e => { e.preventDefault(); handleAddVideo(); }} className="flex gap-2">
            <input
              type="text"
              value={videoUrl}
              onChange={e => { setVideoUrl(e.target.value); setAddVideoError(null); setAddVideoSuccess(null); setAddVideoEpisodeId(null); }}
              placeholder="Paste any YouTube URL to add a single episode..."
              className="flex-1 bg-white border border-border rounded-xl px-4 py-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/50"
              disabled={isAddingVideo}
            />
            <button
              type="submit"
              disabled={!videoUrl.trim() || isAddingVideo}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-border hover:bg-secondary text-foreground rounded-xl font-medium text-sm transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isAddingVideo ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <PlusCircle className="w-4 h-4 text-primary" />}
              {isAddingVideo ? 'Processing...' : 'Add Video'}
            </button>
          </form>
          {addVideoError && (
            <p className="text-xs text-destructive flex items-center gap-1.5 px-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{addVideoError}
            </p>
          )}
          {addVideoSuccess && (
            <p className="text-xs text-emerald-600 flex items-center gap-1.5 px-1">
              <span>✓</span>
              <span><strong>"{addVideoSuccess}"</strong> is ready!{' '}
                {addVideoEpisodeId && (
                  <Link to={`/episode/${addVideoEpisodeId}`} className="underline underline-offset-2 hover:text-emerald-700 transition-colors">
                    Read it here →
                  </Link>
                )}
              </span>
            </p>
          )}
        </div>

        {/* Progress / error banners */}
        {fetchProgress && (
          <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl flex items-center gap-3">
            {isFetching && <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />}
            <p className="text-sm text-primary/80">{fetchProgress}</p>
          </div>
        )}
        {error && (
          <div className="px-4 py-3 bg-destructive/5 border border-destructive/20 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive/80">{error}</p>
          </div>
        )}
        {skippedVideos.length > 0 && (
          <div className="px-4 py-3 bg-secondary border border-border rounded-xl">
            <p className="text-xs font-medium text-muted-foreground mb-1">Skipped {skippedVideos.length} video{skippedVideos.length > 1 ? 's' : ''} — no transcript available</p>
            <ul className="space-y-0.5">
              {skippedVideos.map((title, i) => (
                <li key={i} className="text-xs text-muted-foreground/70 truncate">· {title}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Episode list */}
        <div className="space-y-4">
          {filteredEpisodes.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border rounded-2xl bg-white/50">
              <p className="text-sm text-muted-foreground">No episodes found for the selected filters.</p>
            </div>
          ) : (
            filteredEpisodes.map(episode => (
              <Link
                key={episode.id}
                to={`/episode/${episode.id}`}
                className="group block bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden border border-border/60 hover:-translate-y-0.5"
              >
                <div className="flex flex-col sm:flex-row">
                  {/* Thumbnail */}
                  <div className="sm:w-56 shrink-0 relative bg-muted overflow-hidden">
                    <img
                      src={episode.thumbnail_url}
                      alt={episode.title}
                      className="w-full h-full object-cover aspect-video sm:aspect-auto"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                      <PlayCircle className="w-9 h-9 text-white drop-shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>

                  {/* Content */}
                  <div className="p-5 flex-1 flex flex-col min-w-0">
                    {/* Meta */}
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="text-xs font-semibold text-primary">
                        {episode.channels?.name || episode.channel_name || 'Unknown Channel'}
                      </span>
                      <span className="text-muted-foreground/40 text-xs">·</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })}
                      </span>
                    </div>

                    {/* Title */}
                    <h3 className="text-[15px] font-semibold text-foreground mb-2 line-clamp-2 leading-snug group-hover:text-primary transition-colors">
                      {decodeHtml(episode.title)}
                    </h3>

                    {/* Summary */}
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2 leading-relaxed">
                      {episode.summary}
                    </p>

                    {/* Key insights */}
                    <div className="mt-auto pt-3 border-t border-border/50">
                      <ul className="space-y-1.5">
                        {episode.key_points?.slice(0, 3).map((point: string, i: number) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                            <span className="text-primary/60 mt-0.5 shrink-0">·</span>
                            <span className="line-clamp-1">{point}</span>
                          </li>
                        ))}
                        {episode.key_points?.length > 3 && (
                          <li className="text-xs text-muted-foreground/50 pl-3.5">
                            +{episode.key_points.length - 3} more
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
