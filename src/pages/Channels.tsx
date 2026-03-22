import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { summarizeVideo } from '../lib/gemini';
import { Loader2, Trash2, Plus, AlertCircle, Youtube } from 'lucide-react';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

export default function Channels() {
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [youtubeId, setYoutubeId] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    document.title = "Manage Channels - Podcast Briefing";
    fetchChannels();
  }, []);

  async function fetchChannels() {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    
    setLoading(true);
    const { data, error } = await supabase
      .from('channels')
      .select('*')
      .order('name');
      
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
    
    // Auto-extract ID if user pasted a full URL
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

    try {
      const { data, error: insertError } = await supabase
        .from('channels')
        .insert([
          { 
            name: name.trim(), 
            youtube_channel_id: trimmedId, 
            description: description.trim() 
          }
        ])
        .select();

      if (insertError) throw insertError;

      const newChannel = data?.[0];
      if (newChannel) {
        setChannels(prev => [...prev, newChannel].sort((a, b) => a.name.localeCompare(b.name)));
        
        // Start backfill process
        setBackfillProgress(`Fetching last 30 days of videos for ${newChannel.name}...`);
        try {
          const res = await fetch(`/api/youtube/historical?channelId=${newChannel.youtube_channel_id}&days=30`);
          const ytData = await res.json();
          
          if (!res.ok) {
            throw new Error(ytData.error || 'Failed to fetch historical data');
          }

          if (ytData.items && ytData.items.length > 0) {
            let processed = 0;
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
                    fetched_at: new Date().toISOString()
                  });
                  processed++;
                  // Small delay to prevent rate limits
                  await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (e: any) {
                  console.error(`Failed to summarize video ${videoId}:`, e);
                  if (e.message === 'VIDEO_TOO_SHORT') {
                    console.log(`Skipping video ${videoId} because it is too short.`);
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

      // Reset form
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

  async function handleDeleteChannel(id: string, channelName: string) {
    try {
      // First, delete associated episodes to avoid foreign key constraint errors if cascading delete isn't set up
      await supabase.from('episodes').delete().eq('channel_id', id);
      
      // Then delete the channel
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
          <h2 className="text-xl font-bold text-zinc-100 mb-2">Supabase Configuration Required</h2>
          <p className="text-zinc-400 max-w-md">
            Please set <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code> in your environment variables to use this application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Manage Channels</h1>
        <p className="text-zinc-400 mt-1">Add or remove YouTube channels to track for podcast episodes.</p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {backfillProgress && (
        <div className="bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 px-4 py-3 rounded-xl flex items-center gap-3">
          <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
          <p className="text-sm">{backfillProgress}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Add Channel Form */}
        <div className="md:col-span-1 space-y-6">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-zinc-100 mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-indigo-400" />
              Add Channel
            </h2>
            <form onSubmit={handleAddChannel} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-zinc-400 mb-1">Channel Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. All-In Podcast"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all text-zinc-100"
                  required
                />
              </div>
              <div>
                <label htmlFor="youtubeId" className="block text-sm font-medium text-zinc-400 mb-1">YouTube Channel ID</label>
                <input
                  id="youtubeId"
                  type="text"
                  value={youtubeId}
                  onChange={(e) => setYoutubeId(e.target.value)}
                  placeholder="e.g. UCESLZhusAkFfsNsApnjF_Cg"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all text-zinc-100"
                  required
                />
                <p className="text-xs text-zinc-500 mt-1">The 24-character ID starting with "UC".</p>
              </div>
              <div>
                <label htmlFor="description" className="block text-sm font-medium text-zinc-400 mb-1">Description (Optional)</label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description..."
                  rows={2}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all text-zinc-100 resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting || !name.trim() || !youtubeId.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add Channel'}
              </button>
            </form>
          </div>
        </div>

        {/* Channels List */}
        <div className="md:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Youtube className="w-5 h-5 text-red-500" />
            Tracked Channels ({channels.length})
          </h2>
          
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
          ) : channels.length === 0 ? (
            <div className="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-8 text-center">
              <p className="text-zinc-400">No channels are being tracked yet.</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {channels.map((channel) => (
                <div key={channel.id} className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 flex items-center justify-between group hover:border-zinc-700 transition-colors">
                  <div>
                    <h3 className="font-medium text-zinc-100">{channel.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-xs text-zinc-500 bg-zinc-950 px-1.5 py-0.5 rounded">{channel.youtube_channel_id}</code>
                      {channel.description && (
                        <span className="text-xs text-zinc-400 truncate max-w-[200px] sm:max-w-xs block">
                          • {channel.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteChannel(channel.id, channel.name)}
                    className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
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
