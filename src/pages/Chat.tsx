import { useState, useRef, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { Send, Loader2, Bot, User, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Chat() {
  const [messages, setMessages] = useState<{ role: 'user' | 'model', text: string }[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [context, setContext] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadContext() {
      if (!isSupabaseConfigured) return;

      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

      const { data: recentEpisodes } = await supabase
        .from('episodes')
        .select('title, summary, key_points, channels(name)')
        .gte('published_at', fourteenDaysAgo.toISOString());

      const ctx = recentEpisodes?.map(ep => `
Channel: ${(ep.channels as any)?.name || (Array.isArray(ep.channels) ? ep.channels[0]?.name : '')}
Title: ${ep.title}
Summary: ${ep.summary}
Key Points: ${ep.key_points.join(', ')}
`).join('\n\n') || 'No recent episodes found.';

      setContext(ctx);
    }
    loadContext();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsLoading(true);

    try {
      const contents = [
        ...messages.map(m => ({ role: m.role, text: m.text })),
        { role: 'user', text: userMessage }
      ];

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contents, context })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to get chat response");
      }

      setMessages(prev => [...prev, { role: 'model', text: data.text }]);
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error processing your request.' }]);
    } finally {
      setIsLoading(false);
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-8rem)] space-y-4 text-center bg-white rounded-2xl border border-border shadow-sm">
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
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
            <Bot className="w-12 h-12 text-muted-foreground/20" />
            <p className="text-center max-w-md text-sm leading-relaxed">
              Ask me anything about the podcasts from the last 14 days.<br />
              Try "What did All-In say about tariffs this week?" or "Summarize everything about AI agents."
            </p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={idx} className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                msg.role === 'user' ? 'bg-primary' : 'bg-secondary border border-border'
              }`}>
                {msg.role === 'user'
                  ? <User className="w-4 h-4 text-primary-foreground" />
                  : <Bot className="w-4 h-4 text-primary" />
                }
              </div>
              <div className={`max-w-[80%] rounded-2xl px-5 py-3 text-sm ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-tr-sm'
                  : 'bg-secondary/60 border border-border text-foreground rounded-tl-sm'
              }`}>
                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                ) : (
                  <div className="prose prose-zinc prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-secondary prose-pre:border prose-pre:border-border prose-table:border-collapse prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1 prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="bg-secondary/60 border border-border rounded-2xl rounded-tl-sm px-5 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-background border-t border-border">
        <form onSubmit={handleSubmit} className="relative max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about recent episodes..."
            className="w-full bg-secondary/50 border border-border rounded-xl pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/60 text-foreground"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted-foreground hover:text-primary disabled:opacity-50 disabled:hover:text-muted-foreground transition-colors"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
