import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY || '',
  baseURL: 'https://api.minimax.io/anthropic',
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, segments } = req.body;

  if (!segments || segments.length === 0) {
    return res.status(400).json({ error: 'segments are required' });
  }

  function findQuoteTimestamp(quote: string): string | null {
    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = normalize(quote).split(' ');
    for (const prefixLen of [7, 5, 4]) {
      if (words.length < prefixLen) continue;
      const quoteStart = words.slice(0, prefixLen).join(' ');
      if (quoteStart.length < 6) continue;
      for (let i = 0; i < segments.length; i++) {
        const window = segments.slice(i, i + 6).map((s: any) => normalize(s.text)).join(' ');
        if (window.includes(quoteStart)) {
          const secs = segments[i].offset;
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = secs % 60;
          return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
        }
      }
    }
    return null;
  }

  function tsToSeconds(label: string | null): number {
    if (!label) return Infinity;
    const parts = label.split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }

  const plainTranscript = segments.map((s: any) => s.text).join(' ');

  const prompt = `You are an expert podcast analyst. Create a deep synthesis that a smart, busy reader would genuinely value — capturing real substance, surprises, debates, and memorable moments.

Episode title: "${title}"

Before generating insights, think through these questions internally:
- What are the 3–5 most surprising or counterintuitive claims made?
- Are there genuine disagreements between speakers? What exactly is disputed?
- What specific numbers, data points, or facts were cited?
- What are the most quotable moments — lines a listener would walk away repeating?

Then generate 8–12 insight blocks:

heading:
- For "debate" type → use format "Debate: [the question at stake]?"
  e.g. "Debate: is ChatGPT's consumer brand actually a moat?"
- For all other types → write one specific, concrete claim or insight.
  Only name a specific speaker if the attribution adds real meaning (e.g. a contrarian take from one person). Never use generic topic labels. Every heading must convey actual information.

type: exactly one of:
  "hot-take"   — bold, contrarian, or provocative opinion
  "debate"     — genuine disagreement; speakers hold meaningfully different views
  "data-point" — a specific number, stat, or factual claim is the core of this insight
  "prediction" — a claim about what will or won't happen
  "framework"  — a mental model or way of thinking about something

detail: 4–6 sentences. Capture the actual argument, not just the conclusion. Include who argued what, specific numbers, and what makes this non-obvious. For debates, represent both sides fairly.

quote: The single most "drop everything and listen to this" line from that section.
  - Verbatim from the transcript — exact words, zero paraphrasing
  - The most surprising, specific, or bold line — not a gentle summary
  - Something a stranger would hear and want to find this podcast

second_quote: ONLY for "debate" type — a verbatim line from the opposing speaker that captures the other side. Must come from a different speaker than the first quote. Omit this field entirely for all other types.

Return ONLY a valid JSON array, nothing else:
[
  {
    "heading": "...",
    "type": "hot-take|debate|data-point|prediction|framework",
    "detail": "...",
    "quote": "...",
    "second_quote": "..."
  }
]

Transcript:
${plainTranscript}`;

  try {
    const response = await client.messages.create({
      model: 'MiniMax-M2.7',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    const text = textBlock ? (textBlock as any).text : '';
    if (!text) return res.status(500).json({ error: 'No response from MiniMax' });

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: 'MiniMax returned invalid JSON' });

    let insights: any[];
    try {
      insights = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(500).json({ error: 'MiniMax returned invalid JSON' });
    }

    for (const insight of insights) {
      if (insight.quote) insight.timestamp = findQuoteTimestamp(insight.quote) ?? null;
      if (insight.second_quote) insight.second_timestamp = findQuoteTimestamp(insight.second_quote) ?? null;
    }

    insights.sort((a: any, b: any) => {
      const aMin = Math.min(tsToSeconds(a.timestamp), tsToSeconds(a.second_timestamp ?? null));
      const bMin = Math.min(tsToSeconds(b.timestamp), tsToSeconds(b.second_timestamp ?? null));
      return aMin - bMin;
    });

    return res.status(200).json({ insights });
  } catch (error: any) {
    console.error('Error calling MiniMax API for synthesis:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
