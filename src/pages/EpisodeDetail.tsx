import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { ArrowLeft, Loader2, Send, Bot, User, MessageSquare, AlertCircle, Trash2, ChevronRight, PlayCircle, Sparkles } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

function labelToSeconds(label: string): number {
  const parts = label.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

type Segment = { text: string; offset: number };
type InsightType = 'hot-take' | 'debate' | 'data-point' | 'prediction' | 'framework';
type SynthesisInsight = {
  heading: string;
  type: InsightType;
  detail: string;
  quote: string;
  timestamp: string | null;
  second_quote?: string;
  second_timestamp?: string | null;
};
type Message = { role: 'user'; text: string } | { role: 'model'; text: string };

const TYPE_META: Record<InsightType, { label: string; icon: string; badge: string; border: string }> = {
  'hot-take':   { label: 'Hot Take',   icon: '🔥', badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20',    border: 'border-rose-500/40' },
  'debate':     { label: 'Debate',     icon: '⚔️', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',  border: 'border-amber-500/40' },
  'data-point': { label: 'Data',       icon: '📊', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',     border: 'border-blue-500/40' },
  'prediction': { label: 'Prediction', icon: '🎯', badge: 'bg-purple-500/10 text-purple-400 border-purple-500/20', border: 'border-purple-500/40' },
  'framework':  { label: 'Framework',  icon: '💡', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', border: 'border-emerald-500/40' },
};

export default function EpisodeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [episode, setEpisode] = useState<any>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [seekSeconds, setSeekSeconds] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'synthesis'>('overview');
  const [synthesisInsights, setSynthesisInsights] = useState<SynthesisInsight[]>([]);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchEpisode() {
      if (!id || !isSupabaseConfigured) { setLoading(false); return; }
      setLoading(true);
      const { data } = await supabase
        .from('episodes')
        .select('*, channels(name)')
        .eq('id', id)
        .single();
      if (data) {
        setEpisode(data);
        document.title = `${decodeHtml(data.title)} - Podcast Briefing`;
        if (data.synthesis?.length > 0) {
          setSynthesisInsights(data.synthesis);
        }
        setIsTranscriptLoading(true);
        try {
          const res = await fetch(`/api/youtube/transcript?videoId=${data.youtube_video_id}`);
          if (res.ok) {
            const td = await res.json();
            setTranscript(td.text || '');
            if (td.segments?.length > 0) setSegments(td.segments);
          }
        } catch (err) {
          console.warn('Could not fetch transcript', err);
        } finally {
          setIsTranscriptLoading(false);
        }
      }
      setLoading(false);
    }
    fetchEpisode();
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function generateSynthesis() {
    if (segments.length === 0 || isSynthesizing) return;
    setIsSynthesizing(true);
    setSynthesisError(null);
    try {
      const res = await fetch('/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: episode?.title, segments })
      });
      const text = await res.text();
      if (!text) throw new Error('Server returned empty response — the transcript may be too large or the request timed out');
      const data = JSON.parse(text);
      if (!res.ok) throw new Error(data.error || 'Failed to generate synthesis');
      const insights = data.insights || [];
      setSynthesisInsights(insights);
      setActiveTab('synthesis');
      if (id && insights.length > 0) {
        supabase.from('episodes').update({ synthesis: insights }).eq('id', id);
      }
    } catch (err: any) {
      setSynthesisError(err.message);
      setActiveTab('synthesis');
    } finally {
      setIsSynthesizing(false);
    }
  }

  async function sendMessage(userMessage: string) {
    if (!userMessage.trim() || isChatLoading || !episode) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsChatLoading(true);
    try {
      // Build a condensed timestamp guide so the model can cite timestamps on verbatim quotes
      const timestampGuide = segments.length > 0
        ? '\n\nTimestamp guide (sample every ~20 segments):\n' + segments
            .filter((_, i) => i % 20 === 0)
            .map(s => {
              const m = Math.floor(s.offset / 60);
              const sec = s.offset % 60;
              return `[${m}:${String(sec).padStart(2, '0')}] ${s.text.slice(0, 80)}`;
            })
            .join('\n')
        : '';

      const systemInstruction = `You are an AI assistant for a podcast briefing tool. Answer based ONLY on this specific podcast episode.

Channel: ${episode.channels?.name}
Title: ${episode.title}
Summary: ${episode.summary}
Key Points: ${episode.key_points.join(', ')}

Full Transcript:
${transcript}${timestampGuide}

Formatting rules:
- Always leave a blank line between paragraphs and between sections.
- Use **bold** for key names, figures, or important claims.
- When you quote verbatim from the transcript, add the timestamp immediately after the closing quote in [M:SS] or [MM:SS] format, using the timestamp guide above to find the right position. Only do this for direct verbatim quotes — never for paraphrases.`;

      const contents = messages
        .map(m => ({ role: m.role, text: m.text }))
        .concat({ role: 'user', text: userMessage });
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contents, systemInstruction })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to get chat response');
      setMessages(prev => [...prev, { role: 'model', text: data.text }]);
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error.' }]);
    } finally {
      setIsChatLoading(false);
    }
  }

  async function handleDelete() {
    if (!episode || !id) return;
    setIsDeleting(true);
    try {
      const { error } = await supabase.from('episodes').delete().eq('id', id);
      if (error) throw error;
      navigate('/');
    } catch (err) {
      console.error('Failed to delete episode:', err);
      setIsDeleting(false);
    }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-zinc-500" /></div>;

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4 text-center">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-bold text-zinc-100 mb-2">Supabase Configuration Required</h2>
          <p className="text-zinc-400 max-w-md">
            Please set <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-amber-400 bg-amber-400/10 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="text-center py-12">
        <p className="text-zinc-400">Episode not found.</p>
        <Link to="/" className="text-indigo-400 hover:text-indigo-300 mt-4 inline-block">Return to Feed</Link>
      </div>
    );
  }

  const embedSrc = seekSeconds !== null
    ? `https://www.youtube.com/embed/${episode.youtube_video_id}?start=${seekSeconds}&autoplay=1`
    : `https://www.youtube.com/embed/${episode.youtube_video_id}`;

  const inSynthesis = activeTab === 'synthesis';

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Feed
        </Link>
        <button onClick={handleDelete} disabled={isDeleting}
          className="inline-flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">
          {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          Delete Episode
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

        {/* ── LEFT COLUMN ── */}
        <div className="space-y-6">
          {/* Video: only in left col when NOT in synthesis mode */}
          {!inSynthesis && (
            <div className="aspect-video w-full rounded-2xl overflow-hidden border border-zinc-800 bg-black">
              <iframe key={embedSrc} width="100%" height="100%" src={embedSrc} title={episode.title}
                frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
          )}

          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-400 mb-3">
              <span className="text-indigo-400">{episode.channels?.name}</span>
              <span>•</span>
              <span>{formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-6 leading-tight">{decodeHtml(episode.title)}</h1>

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-zinc-800 mb-1">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === 'overview'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => {
                  setActiveTab('synthesis');
                  if (synthesisInsights.length === 0 && !isSynthesizing && !synthesisError) {
                    generateSynthesis();
                  }
                }}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
                  activeTab === 'synthesis'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Deep Synthesis
                {isSynthesizing && <Loader2 className="w-3 h-3 animate-spin" />}
              </button>
            </div>

            {/* Cute loading message — only text, no layout shift */}
            {isSynthesizing && (
              <p className="text-xs text-zinc-500 italic text-center py-2 mb-4">
                Doing a deep read of the episode, trying my best — this'll take a moment ✨
              </p>
            )}

            {/* ── OVERVIEW TAB ── */}
            {activeTab === 'overview' && (
              <div className="prose prose-invert prose-zinc max-w-none mt-6">
                <h3 className="text-lg font-semibold text-zinc-200 mb-3">Summary</h3>
                <p className="text-zinc-400 leading-relaxed mb-8">{episode.summary}</p>

                <h3 className="text-lg font-semibold text-zinc-200 mb-4">Key Insights</h3>
                <ul className="space-y-2">
                  {episode.key_points?.map((point: string, i: number) => (
                    <li key={i}>
                      <button onClick={() => sendMessage(`Tell me more about this key insight: "${point}"`)}
                        className="w-full text-left flex items-start gap-3 p-3 rounded-xl hover:bg-zinc-800/60 transition-colors group">
                        <span className="text-indigo-500 mt-1 shrink-0">•</span>
                        <span className="leading-relaxed text-zinc-300 group-hover:text-zinc-100 transition-colors flex-1">{point}</span>
                        <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-indigo-400 shrink-0 mt-1 transition-colors" />
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-zinc-600 mt-2 ml-1">Click any insight to dive deeper in the chat →</p>
              </div>
            )}

            {/* ── SYNTHESIS TAB ── */}
            {activeTab === 'synthesis' && (
              <div className="mt-6">
                {/* While loading: show overview content naturally, no empty space */}
                {isSynthesizing && (
                  <div className="prose prose-invert prose-zinc max-w-none">
                    <h3 className="text-lg font-semibold text-zinc-200 mb-3">Summary</h3>
                    <p className="text-zinc-400 leading-relaxed mb-8">{episode.summary}</p>
                    <h3 className="text-lg font-semibold text-zinc-200 mb-4">Key Insights</h3>
                    <ul className="space-y-2">
                      {episode.key_points?.map((point: string, i: number) => (
                        <li key={i}>
                          <button onClick={() => sendMessage(`Tell me more about this key insight: "${point}"`)}
                            className="w-full text-left flex items-start gap-3 p-3 rounded-xl hover:bg-zinc-800/60 transition-colors group">
                            <span className="text-indigo-500 mt-1 shrink-0">•</span>
                            <span className="leading-relaxed text-zinc-300 group-hover:text-zinc-100 transition-colors flex-1">{point}</span>
                            <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-indigo-400 shrink-0 mt-1 transition-colors" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!isSynthesizing && synthesisError && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      {synthesisError}
                    </div>
                    <button onClick={generateSynthesis} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                      Try again
                    </button>
                  </div>
                )}

                {!isSynthesizing && !synthesisError && synthesisInsights.length > 0 && (
                  <div className="space-y-10">
                    {synthesisInsights.map((insight, i) => {
                      const meta = TYPE_META[insight.type] ?? TYPE_META['framework'];
                      return (
                        <div key={i} className="space-y-3">
                          {/* Type badge */}
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${meta.badge}`}>
                            <span>{meta.icon}</span>
                            {meta.label}
                          </span>
                          <h3 className="text-base font-semibold text-zinc-100 leading-snug">{insight.heading}</h3>
                          <p className="text-sm text-zinc-400 leading-relaxed">{insight.detail}</p>

                          {/* Primary quote */}
                          {insight.quote && (
                            <div className={`border-l-2 ${meta.border} pl-4 space-y-1.5`}>
                              <p className="text-sm text-zinc-300 italic leading-relaxed">"{insight.quote}"</p>
                              {insight.timestamp && (
                                <button onClick={() => setSeekSeconds(labelToSeconds(insight.timestamp!))}
                                  className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 px-2 py-0.5 rounded-md transition-colors font-mono">
                                  <PlayCircle className="w-3 h-3" />{insight.timestamp}
                                </button>
                              )}
                            </div>
                          )}

                          {/* Second quote — debates only */}
                          {insight.second_quote && (
                            <div className="border-l-2 border-zinc-600/60 pl-4 space-y-1.5">
                              <p className="text-sm text-zinc-400 italic leading-relaxed">"{insight.second_quote}"</p>
                              {insight.second_timestamp && (
                                <button onClick={() => setSeekSeconds(labelToSeconds(insight.second_timestamp!))}
                                  className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-700/30 hover:bg-zinc-700/50 border border-zinc-600/30 px-2 py-0.5 rounded-md transition-colors font-mono">
                                  <PlayCircle className="w-3 h-3" />{insight.second_timestamp}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="lg:sticky lg:top-24 flex flex-col gap-3 h-auto lg:h-[calc(100vh-8rem)]">

          {/* Video: moves to right col in synthesis mode so it stays visible while scrolling */}
          {inSynthesis && (
            <div className="aspect-video w-full rounded-2xl overflow-hidden border border-zinc-800 bg-black shrink-0">
              <iframe key={embedSrc} width="100%" height="100%" src={embedSrc} title={episode.title}
                frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
          )}

          {/* Chat */}
          <div className={`flex flex-col bg-zinc-900/50 rounded-2xl border border-zinc-800 overflow-hidden ${inSynthesis ? 'flex-1 min-h-0' : 'h-[calc(100vh-12rem)] lg:h-full'}`}>
            <div className="p-4 border-b border-zinc-800 bg-zinc-900/80 shrink-0">
              <h3 className="font-semibold text-zinc-200 flex items-center gap-2">
                <Bot className="w-5 h-5 text-indigo-400" />
                Ask about this episode
              </h3>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-3">
                  <MessageSquare className="w-8 h-8 text-zinc-700" />
                  <p className="text-center text-sm max-w-[200px]">Ask questions, or click a key insight to dive deeper.</p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-indigo-600' : 'bg-zinc-800 border border-zinc-700'}`}>
                      {msg.role === 'user' ? <User className="w-3 h-3 text-white" /> : <Bot className="w-3 h-3 text-indigo-400" />}
                    </div>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 rounded-tl-sm'}`}>
                      {msg.role === 'user' ? (
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      ) : (
                        <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-table:border-collapse prose-td:border prose-td:border-zinc-700 prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-zinc-700 prose-th:px-2 prose-th:py-1">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
                              h1: ({ children }) => <h1 className="text-base font-bold mt-4 mb-2 first:mt-0">{children}</h1>,
                              h2: ({ children }) => <h2 className="text-sm font-bold mt-4 mb-2 first:mt-0">{children}</h2>,
                              h3: ({ children }) => <h3 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h3>,
                              ul: ({ children }) => <ul className="list-disc pl-4 mb-3 space-y-1">{children}</ul>,
                              ol: ({ children }) => <ol className="list-decimal pl-4 mb-3 space-y-1">{children}</ol>,
                              code: ({ children, className }) => {
                                const content = String(children);
                                // Render [MM:SS] timestamp markers as seek buttons
                                if (!className && content.startsWith('ts:')) {
                                  const ts = content.slice(3);
                                  return (
                                    <button
                                      onClick={() => setSeekSeconds(labelToSeconds(ts))}
                                      className="inline-flex items-center gap-1 text-xs text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 px-1.5 py-0.5 rounded-md font-mono mx-0.5 transition-colors align-middle"
                                    >
                                      <PlayCircle className="w-3 h-3" />{ts}
                                    </button>
                                  );
                                }
                                return <code className={`${className || ''} bg-zinc-700/50 px-1 py-0.5 rounded text-xs`}>{children}</code>;
                              },
                            }}
                          >
                            {/* Convert [MM:SS] markers to inline code that the custom code component renders as buttons */}
                            {msg.text.replace(/\[(\d+:\d{2}(?::\d{2})?)\]/g, '`ts:$1`')}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {isChatLoading && (
                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0">
                    <Bot className="w-3 h-3 text-indigo-400" />
                  </div>
                  <div className="bg-zinc-800/80 border border-zinc-700/50 rounded-2xl rounded-tl-sm px-4 py-3">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-3 bg-zinc-900 border-t border-zinc-800 shrink-0">
              <form onSubmit={e => { e.preventDefault(); sendMessage(input.trim()); }} className="relative">
                <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                  placeholder={isTranscriptLoading ? 'Loading transcript...' : 'Ask a question...'}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-zinc-600"
                  disabled={isChatLoading || isTranscriptLoading} />
                <button type="submit" disabled={!input.trim() || isChatLoading || isTranscriptLoading}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-indigo-400 disabled:opacity-50 transition-colors">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
