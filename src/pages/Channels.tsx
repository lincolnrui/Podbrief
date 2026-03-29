import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { summarizeVideo } from '../lib/gemini';
import { Loader2, Trash2, Plus, AlertCircle, Youtube } from 'lucide-react';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

export default function Channels() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);
  const [skippedVideos, setSkippedVideos] = useState<string[]>([]);

  const [name, setName] = useState('');
  const [youtubeId, setYoutubeId] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    document.title = "Manage Channels - PodcastPro";
    fetchChannels();
  }, []);

  async function fetchChannels() {
    if (!isSupabaseConfigured) { setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase.from('channels').select('*').order('name');
    if (error) {
      console.error("Error fetching channels:", error);
      setError("Failed to load channels.");
    } else if (data) {
      setChannels(data);
    }
    setLoading(false);
  }

  async function handleAddChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !youtubeId.trim()) return;

    let trimmedId = youtubeId.trim();
    if (trimmedId.includes('youtube.com/channel/')) {
      trimmedId = trimmedId.split('youtube.com/channel/')[1].split('/')[0].split('?')[0];
    }
    if (!trimmedId.startsWith('UC') || trimmedId.length !== 24) {
      setError("Invalid YouTube Channel ID. It must start with 'UC' and be exactly 24 characters long. Handles (like @username) will not work.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setBackfillProgress(null);
    setSkippedVideos([]);

    try {
      const { data, error: insertError } = await supabase
        .from('channels')
        .insert([{ name: name.trim(), youtube_channel_id: trimmedId, description: description.trim(), user_id: user!.id }])
        .select();

      if (insertError) throw insertError;

      const newChannel = data?.[0];
      if (newChannel) {
        setChannels(prev => [...prev, newChannel].sort((a, b) => a.name.localeCompare(b.name)));
        setBackfillProgress(`Fetching last 30 days of videos for ${newChannel.name}...`);
        try {
          const res = await fetch(`/api/youtube/historical?channelId=${newChannel.youtube_channel_id}&days=30`);
          const ytData = await res.json();
          if (!res.ok) throw new Error(ytData.error || 'Failed to fetch historical data');

          if (ytData.items && ytData.items.length > 0) {
            let processed = 0;
            for (const item of ytData.items) {
              const videoId = item.id.videoId;
              if (!videoId) continue;
              const { data: existing } = await supabase.from('episodes').select('id').eq('youtube_video_id', videoId).single();
              if (!existing) {
                const decodedTitle = decodeHtml(item.snippet.title);
                try {
                  setBackfillProgress(`Summarizing: ${decodedTitle.substring(0, 40)}... (${processed + 1}/${ytData.items.length})`);
                  const summaryData = await summarizeVideo(videoId, decodedTitle, item.snippet.description);
                  await supabase.from('episodes').insert({
                    channel_id: newChannel.id,
                    youtube_video_id: videoId,
                    title: decodedTitle,
                    published_at: item.snippet.publishedAt,
                    thumbnail_url: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
                    summary: summaryData.summary,
                    key_points: summaryData.key_points,
                    fetched_at: new Date().toISOString(),
                    user_id: user!.id
                  });
                  processed++;
                  await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (e: any) {
                  console.error(`Failed to summarize video ${videoId}:`, e);
                  if (e.message === 'VIDEO_TOO_SHORT' || e.message === 'NO_TRANSCRIPT') {
                    setSkippedVideos(prev => [...prev, decodedTitle]);
                  } else if (e.message.includes('429') || e.message.includes('quota')) {
                    setBackfillProgress(`Stopped early due to rate limits. Processed ${processed} videos.`);
                    break;
                  }
                }
              }
            }
            setBackfillProgress(`Successfully processed ${processed} historical videos!`);
            setTimeout(() => setBackfillProgress(null), 5000);
          } else {
            setBackfillProgress('No recent videos found for this channel.');
            setTimeout(() => setBackfillProgress(null), 3000);
          }
        } catch (err: any) {
          console.error("Backfill error:", err);
          setBackfillProgress(`Added channel, but failed to fetch history: ${err.message}`);
          setTimeout(() => setBackfillProgress(null), 5000);
        }
      }

      setName('');
      setYoutubeId('');
      setDescription('');
    } catch (err: any) {
      console.error("Error adding channel:", err);
      setError(err.message || "Failed to add channel.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteChannel(id: string) {
    try {
      await supabase.from('episodes').delete().eq('channel_id', id);
      const { error: deleteError } = await supabase.from('channels').delete().eq('id', id);
      if (deleteError) throw deleteError;
      setChannels(prev => prev.filter(c => c.id !== id));
    } catch (err: any) {
      console.error("Error deleting channel:", err);
      setError("Failed to delete channel. Please try again.");
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4 text-center">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-bold text-foreground mb-2">Supabase Configuration Required</h2>
          <p className="text-muted-foreground max-w-md">
            Please set <code className="text-primary bg-primary/10 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-primary bg-primary/10 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code> in your environment variables.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Manage Channels</h1>
        <p className="text-muted-foreground text-sm mt-1">Add or remove YouTube channels to track for podcast episodes.</p>
      </div>

      {error && (
        <div className="flex items-start gap-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 px-4 py-3 rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {backfillProgress && (
        <div className="flex items-center gap-3 text-sm text-primary bg-primary/10 border border-primary/20 px-4 py-3 rounded-xl">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
          <p>{backfillProgress}</p>
        </div>
      )}

      {skippedVideos.length > 0 && (
        <div className="bg-secondary border border-border px-4 py-3 rounded-xl">
          <p className="text-sm font-medium text-foreground mb-1">Skipped {skippedVideos.length} video{skippedVideos.length > 1 ? 's' : ''} (no transcript available):</p>
          <ul className="space-y-0.5">
            {skippedVideos.map((title, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50 mt-0.5">•</span>
                <span className="truncate">{title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

        {/* Add Channel Form */}
        <div className="md:col-span-1">
          <div className="bg-white border border-border rounded-2xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" />
              Add Channel
            </h2>
            <form onSubmit={handleAddChannel} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-muted-foreground mb-1.5">Channel Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. All-In Podcast"
                  className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all text-foreground placeholder:text-muted-foreground/50"
                  required
                />
              </div>
              <div>
                <label htmlFor="youtubeId" className="block text-sm font-medium text-muted-foreground mb-1.5">YouTube Channel ID</label>
                <input
                  id="youtubeId"
                  type="text"
                  value={youtubeId}
                  onChange={(e) => setYoutubeId(e.target.value)}
                  placeholder="e.g. UCESLZhusAkFfsNsApnjF_Cg"
                  className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all text-foreground placeholder:text-muted-foreground/50"
                  required
                />
                <p className="text-xs text-muted-foreground/70 mt-1.5">The 24-character ID starting with "UC".</p>
              </div>
              <div>
                <label htmlFor="description" className="block text-sm font-medium text-muted-foreground mb-1.5">Description <span className="font-normal opacity-60">(optional)</span></label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description..."
                  rows={2}
                  className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all text-foreground placeholder:text-muted-foreground/50 resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting || !name.trim() || !youtubeId.trim()}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium py-2 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add Channel'}
              </button>
            </form>
          </div>
        </div>

        {/* Channels List */}
        <div className="md:col-span-2 space-y-4">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Youtube className="w-4 h-4 text-red-500" />
            Tracked Channels
            <span className="text-muted-foreground font-normal">({channels.length})</span>
          </h2>

          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="bg-white border border-border rounded-2xl p-8 text-center shadow-sm">
              <p className="text-muted-foreground text-sm">No channels are being tracked yet.</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {channels.map((channel) => (
                <div
                  key={channel.id}
                  className="bg-white border border-border rounded-xl px-4 py-3.5 flex items-center justify-between group hover:shadow-sm transition-all"
                >
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground text-sm">{channel.name}</h3>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <code className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded font-mono">{channel.youtube_channel_id}</code>
                      {channel.description && (
                        <span className="text-xs text-muted-foreground truncate max-w-[180px] sm:max-w-xs">
                          {channel.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteChannel(channel.id)}
                    className="p-2 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 ml-3 shrink-0"
                    title="Stop tracking channel"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
