import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { ai } from '../lib/gemini';
import { ArrowLeft, PlayCircle, Loader2, Send, Bot, User, MessageSquare, AlertCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import ReactMarkdown from 'react-markdown';

function decodeHtml(html: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

export default function EpisodeDetail() {
  const { id } = useParams();
  const [episode, setEpisode] = useState<any>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<{ role: 'user' | 'model', text: string }[]>([]);
  const [input, setInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  useEffect(() => {
    async function fetchEpisode() {
      if (!id || !isSupabaseConfigured) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data } = await supabase
        .from('episodes')
        .select('*, channels(name)')
        .eq('id', id)
        .single();
      
      if (data) {
        setEpisode(data);
        document.title = `${decodeHtml(data.title)} - Podcast Briefing`;
        // Fetch transcript for the chatbox
        setIsTranscriptLoading(true);
        try {
          const res = await fetch(`/api/youtube/transcript?videoId=${data.youtube_video_id}`);
          if (res.ok) {
            const transcriptData = await res.json();
            setTranscript(transcriptData.text);
          }
        } catch (err) {
          console.warn("Could not fetch transcript for chatbox", err);
        } finally {
          setIsTranscriptLoading(false);
        }
      }
      setLoading(false);
    }
    fetchEpisode();
  }, [id]);

  async function handleChatSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isChatLoading || !episode) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsChatLoading(true);

    try {
      const systemInstruction = `You are an AI assistant for a podcast briefing tool. Answer the user's questions based ONLY on this specific podcast episode context:\n\nChannel: ${episode.channels?.name}\nTitle: ${episode.title}\nSummary: ${episode.summary}\nKey Points: ${episode.key_points.join(', ')}\n\nFull Transcript:\n${transcript}`;
      
      const contents = [
        ...messages.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
        { role: 'user', parts: [{ text: userMessage }] }
      ];

      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: contents as any,
        config: {
          systemInstruction,
        }
      });

      setMessages(prev => [...prev, { role: 'model', text: '' }]);

      for await (const chunk of responseStream) {
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex] = {
            ...newMessages[lastIndex],
            text: newMessages[lastIndex].text + chunk.text
          };
          return newMessages;
        });
      }
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error processing your request.' }]);
    } finally {
      setIsChatLoading(false);
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

  if (!episode) {
    return (
      <div className="text-center py-12">
        <p className="text-zinc-400">Episode not found.</p>
        <Link to="/" className="text-indigo-400 hover:text-indigo-300 mt-4 inline-block">
          Return to Feed
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <Link to="/" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Feed
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Details & Video */}
        <div className="space-y-6">
          <div className="aspect-video w-full rounded-2xl overflow-hidden border border-zinc-800 bg-black">
            <iframe
              width="100%"
              height="100%"
              src={`https://www.youtube.com/embed/${episode.youtube_video_id}`}
              title={episode.title}
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            ></iframe>
          </div>

          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-400 mb-3">
              <span className="text-indigo-400">{episode.channels?.name}</span>
              <span>•</span>
              <span>{formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-6 leading-tight">
              {decodeHtml(episode.title)}
            </h1>

            <div className="prose prose-invert prose-zinc max-w-none">
              <h3 className="text-lg font-semibold text-zinc-200 mb-3">Summary</h3>
              <p className="text-zinc-400 leading-relaxed mb-8">{episode.summary}</p>

              <h3 className="text-lg font-semibold text-zinc-200 mb-4">Key Insights</h3>
              <ul className="space-y-3">
                {episode.key_points?.map((point: string, i: number) => (
                  <li key={i} className="flex items-start gap-3 text-zinc-300">
                    <span className="text-indigo-500 mt-1">•</span>
                    <span className="leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Right Column: Chat */}
        <div className="flex flex-col h-[calc(100vh-12rem)] lg:h-[calc(100vh-8rem)] bg-zinc-900/50 rounded-2xl border border-zinc-800 overflow-hidden lg:sticky lg:top-24">
          <div className="p-4 border-b border-zinc-800 bg-zinc-900/80">
            <h3 className="font-semibold text-zinc-200 flex items-center gap-2">
              <Bot className="w-5 h-5 text-indigo-400" />
              Ask about this episode
            </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-3">
                <MessageSquare className="w-8 h-8 text-zinc-700" />
                <p className="text-center text-sm max-w-[200px]">
                  Ask questions specifically about {episode.channels?.name}'s episode.
                </p>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                    msg.role === 'user' ? 'bg-indigo-600' : 'bg-zinc-800 border border-zinc-700'
                  }`}>
                    {msg.role === 'user' ? <User className="w-3 h-3 text-white" /> : <Bot className="w-3 h-3 text-indigo-400" />}
                  </div>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-sm' 
                      : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 rounded-tl-sm'
                  }`}>
                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown>{msg.text}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-3 bg-zinc-900 border-t border-zinc-800">
            <form onSubmit={handleChatSubmit} className="relative">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={isTranscriptLoading ? "Loading transcript..." : "Ask a question..."}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-zinc-600"
                disabled={isChatLoading || isTranscriptLoading}
              />
              <button
                type="submit"
                disabled={!input.trim() || isChatLoading || isTranscriptLoading}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-indigo-400 disabled:opacity-50 disabled:hover:text-zinc-400 transition-colors"
              >
                {isChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
