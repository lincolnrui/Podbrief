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
  'hot-take':   { label: 'Hot Take',   icon: '🔥', badge: 'bg-rose-50 text-rose-600 border-rose-200',         border: 'border-rose-400' },
  'debate':     { label: 'Debate',     icon: '⚔️', badge: 'bg-amber-50 text-amber-600 border-amber-200',       border: 'border-amber-400' },
  'data-point': { label: 'Data',       icon: '📊', badge: 'bg-blue-50 text-blue-600 border-blue-200',          border: 'border-blue-400' },
  'prediction': { label: 'Prediction', icon: '🎯', badge: 'bg-purple-50 text-purple-600 border-purple-200',    border: 'border-purple-400' },
  'framework':  { label: 'Framework',  icon: '💡', badge: 'bg-emerald-50 text-emerald-600 border-emerald-200', border: 'border-emerald-400' },
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
        document.title = `${decodeHtml(data.title)} - PodcastPro`;
        if (data.synthesis?.length > 0) {
          setSynthesisInsights(data.synthesis);
        }
        // Use stored segments immediately if available (works on Vercel where live fetch is blocked)
        if (data.transcript_segments?.length > 0) {
          setSegments(data.transcript_segments);
          setTranscript(data.transcript_segments.map((s: Segment) => s.text).join(' '));
        }
        // Also try live fetch — works on local dev, updates segments if fresher
        setIsTranscriptLoading(true);
        try {
          const res = await fetch(`/api/youtube/transcript?videoId=${data.youtube_video_id}`);
          if (res.ok) {
            const td = await res.json();
            if (td.segments?.length > 0) {
              setSegments(td.segments);
              setTranscript(td.text || '');
            }
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
    if (isSynthesizing) return;
    if (segments.length === 0) {
      setSynthesisError(isTranscriptLoading
        ? 'Transcript is still loading — please wait a moment and try again.'
        : 'No transcript available for this episode.');
      return;
    }
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

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
    </div>
  );

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4 text-center">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-bold text-foreground mb-2">Supabase Configuration Required</h2>
          <p className="text-muted-foreground max-w-md">
            Please set <code className="text-primary bg-primary/10 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and <code className="text-primary bg-primary/10 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Episode not found.</p>
        <Link to="/" className="text-primary hover:text-primary/80 mt-4 inline-block">Return to Feed</Link>
      </div>
    );
  }

  const embedSrc = seekSeconds !== null
    ? `https://www.youtube.com/embed/${episode.youtube_video_id}?start=${seekSeconds}&autoplay=1`
    : `https://www.youtube.com/embed/${episode.youtube_video_id}`;

  const inSynthesis = activeTab === 'synthesis';

  const keyInsightsList = (episode.key_points as string[])?.map((point, i) => (
    <li key={i}>
      <button
        onClick={() => sendMessage(`Tell me more about this key insight: "${point}"`)}
        className="w-full text-left flex items-start gap-3 p-3 rounded-xl hover:bg-secondary/60 transition-colors group"
      >
        <span className="text-primary mt-0.5 shrink-0 text-base leading-none">•</span>
        <span className="leading-relaxed text-foreground/80 group-hover:text-foreground transition-colors flex-1 text-sm">{point}</span>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary shrink-0 mt-0.5 transition-colors" />
      </button>
    </li>
  ));

  return (
    <div className="max-w-5xl mx-auto space-y-8">

      {/* Nav row */}
      <div className="flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Feed
        </Link>
        <button
          onClick={handleDelete}
          disabled={isDeleting}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
        >
          {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          Delete Episode
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

        {/* ── LEFT COLUMN ── */}
        <div className="space-y-6">

          {/* Video — overview mode */}
          {!inSynthesis && (
            <div className="aspect-video w-full rounded-2xl overflow-hidden shadow-md">
              <iframe key={embedSrc} width="100%" height="100%" src={embedSrc} title={episode.title}
                frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
          )}

          <div>
            {/* Meta */}
            <div className="flex items-center gap-2 text-sm font-medium mb-3">
              <span className="text-primary">{episode.channels?.name || episode.channel_name}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="text-muted-foreground">{formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-6 leading-tight">{decodeHtml(episode.title)}</h1>

            {/* Tabs — pill style */}
            <div className="flex items-center gap-1 bg-secondary p-1 rounded-full w-fit mb-1">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all ${
                  activeTab === 'overview'
                    ? 'bg-white text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
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
                className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all flex items-center gap-1.5 ${
                  activeTab === 'synthesis'
                    ? 'bg-white text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Deep Synthesis
                {isSynthesizing && <Loader2 className="w-3 h-3 animate-spin ml-0.5" />}
              </button>
            </div>

            {/* Synthesis loading hint */}
            {isSynthesizing && (
              <p className="text-xs text-muted-foreground italic text-center py-2 mb-4">
                Doing a deep read of the episode, trying my best — this'll take a moment ✨
              </p>
            )}

            {/* ── OVERVIEW TAB ── */}
            {activeTab === 'overview' && (
              <div className="mt-6 space-y-6">
                <div>
                  <h3 className="text-base font-semibold text-foreground mb-2">Summary</h3>
                  <p className="text-muted-foreground leading-relaxed text-sm">{episode.summary}</p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground mb-3">Key Insights</h3>
                  <ul className="space-y-1">{keyInsightsList}</ul>
                  <p className="text-xs text-muted-foreground/60 mt-2 ml-1">Click any insight to dive deeper in the chat →</p>
                </div>
              </div>
            )}

            {/* ── SYNTHESIS TAB ── */}
            {activeTab === 'synthesis' && (
              <div className="mt-6">

                {/* While synthesizing: show overview content */}
                {isSynthesizing && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-base font-semibold text-foreground mb-2">Summary</h3>
                      <p className="text-muted-foreground leading-relaxed text-sm">{episode.summary}</p>
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-foreground mb-3">Key Insights</h3>
                      <ul className="space-y-1">{keyInsightsList}</ul>
                    </div>
                  </div>
                )}

                {!isSynthesizing && synthesisError && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl p-3">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      {synthesisError}
                    </div>
                    <button onClick={generateSynthesis} className="text-sm text-primary hover:text-primary/80 transition-colors">
                      Try again
                    </button>
                  </div>
                )}

                {!isSynthesizing && !synthesisError && synthesisInsights.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                    <Sparkles className="w-8 h-8 text-muted-foreground/20" />
                    <p className="text-sm text-muted-foreground">Click Deep Synthesis to generate an AI analysis of this episode.</p>
                    <button
                      onClick={generateSynthesis}
                      className="text-sm text-primary hover:text-primary/80 font-medium transition-colors"
                    >
                      Generate now
                    </button>
                  </div>
                )}

                {!isSynthesizing && !synthesisError && synthesisInsights.length > 0 && (
                  <div className="space-y-8">
                    {synthesisInsights.map((insight, i) => {
                      const meta = TYPE_META[insight.type] ?? TYPE_META['framework'];
                      return (
                        <div key={i} className="space-y-3">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border ${meta.badge}`}>
                            <span>{meta.icon}</span>
                            {meta.label}
                          </span>
                          <h3 className="text-base font-semibold text-foreground leading-snug">{insight.heading}</h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">{insight.detail}</p>

                          {/* Primary quote */}
                          {insight.quote && (
                            <div className={`border-l-2 ${meta.border} pl-4 space-y-1.5`}>
                              <p className="text-sm text-foreground/80 italic leading-relaxed">"{insight.quote}"</p>
                              {insight.timestamp && (
                                <button
                                  onClick={() => setSeekSeconds(labelToSeconds(insight.timestamp!))}
                                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 border border-primary/20 px-2 py-0.5 rounded-md transition-colors font-mono"
                                >
                                  <PlayCircle className="w-3 h-3" />{insight.timestamp}
                                </button>
                              )}
                            </div>
                          )}

                          {/* Second quote */}
                          {insight.second_quote && (
                            <div className="border-l-2 border-border pl-4 space-y-1.5">
                              <p className="text-sm text-muted-foreground italic leading-relaxed">"{insight.second_quote}"</p>
                              {insight.second_timestamp && (
                                <button
                                  onClick={() => setSeekSeconds(labelToSeconds(insight.second_timestamp!))}
                                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground bg-secondary hover:bg-secondary/80 border border-border px-2 py-0.5 rounded-md transition-colors font-mono"
                                >
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

          {/* Video — synthesis mode */}
          {inSynthesis && (
            <div className="aspect-video w-full rounded-2xl overflow-hidden shadow-md shrink-0">
              <iframe key={embedSrc} width="100%" height="100%" src={embedSrc} title={episode.title}
                frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
          )}

          {/* Chat panel */}
          <div className={`flex flex-col bg-white rounded-2xl border border-border shadow-sm overflow-hidden ${inSynthesis ? 'flex-1 min-h-0' : 'h-[calc(100vh-12rem)] lg:h-full'}`}>
            <div className="p-4 border-b border-border bg-white shrink-0">
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <Bot className="w-5 h-5 text-primary" />
                Ask about this episode
              </h3>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-3">
                  <MessageSquare className="w-8 h-8 text-muted-foreground/20" />
                  <p className="text-center text-sm max-w-[200px]">Ask questions, or click a key insight to dive deeper.</p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                      msg.role === 'user' ? 'bg-primary' : 'bg-secondary border border-border'
                    }`}>
                      {msg.role === 'user'
                        ? <User className="w-3 h-3 text-primary-foreground" />
                        : <Bot className="w-3 h-3 text-primary" />
                      }
                    </div>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-sm'
                        : 'bg-secondary/60 border border-border text-foreground rounded-tl-sm'
                    }`}>
                      {msg.role === 'user' ? (
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      ) : (
                        <div className="prose prose-zinc prose-sm max-w-none prose-p:leading-relaxed prose-table:border-collapse prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-border prose-th:px-2 prose-th:py-1">
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
                                if (!className && content.startsWith('ts:')) {
                                  const ts = content.slice(3);
                                  return (
                                    <button
                                      onClick={() => setSeekSeconds(labelToSeconds(ts))}
                                      className="inline-flex items-center gap-1 text-xs text-primary bg-primary/10 hover:bg-primary/15 border border-primary/20 px-1.5 py-0.5 rounded-md font-mono mx-0.5 transition-colors align-middle"
                                    >
                                      <PlayCircle className="w-3 h-3" />{ts}
                                    </button>
                                  );
                                }
                                return <code className={`${className || ''} bg-secondary px-1 py-0.5 rounded text-xs`}>{children}</code>;
                              },
                            }}
                          >
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
                  <div className="w-6 h-6 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
                    <Bot className="w-3 h-3 text-primary" />
                  </div>
                  <div className="bg-secondary/60 border border-border rounded-2xl rounded-tl-sm px-4 py-3">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-3 bg-background border-t border-border shrink-0">
              <form onSubmit={e => { e.preventDefault(); sendMessage(input.trim()); }} className="relative">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={isTranscriptLoading ? 'Loading transcript...' : 'Ask a question...'}
                  className="w-full bg-secondary/50 border border-border rounded-xl pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/60 text-foreground"
                  disabled={isChatLoading || isTranscriptLoading}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || isChatLoading || isTranscriptLoading}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-primary disabled:opacity-50 transition-colors"
                >
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
