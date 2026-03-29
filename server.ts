import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { YoutubeTranscript } = require("youtube-transcript");
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000');

  app.use(express.json({ limit: '10mb' }));

  app.get("/api/youtube/transcript", async (req, res) => {
    const videoId = req.query.videoId as string;
    if (!videoId) {
      return res.status(400).json({ error: "videoId is required" });
    }

    let durationSeconds = 0;
    let text = "";
    let videoTitle = '';
    let channelId = '';
    let channelTitle = '';
    let publishedAt = '';
    let thumbnailUrl = '';

    // 1. Try to get metadata + duration from YouTube API
    try {
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        const ytRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoId}&key=${apiKey}`);
        if (ytRes.ok) {
          const ytData = await ytRes.json();
          if (ytData.items && ytData.items.length > 0) {
            const item = ytData.items[0];
            // Duration
            const durationIso = item.contentDetails.duration;
            const match = durationIso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (match) {
              durationSeconds = parseInt(match[1] || '0', 10) * 3600
                              + parseInt(match[2] || '0', 10) * 60
                              + parseInt(match[3] || '0', 10);
            }
            // Metadata
            videoTitle   = item.snippet.title || '';
            channelId    = item.snippet.channelId || '';
            channelTitle = item.snippet.channelTitle || '';
            publishedAt  = item.snippet.publishedAt || '';
            thumbnailUrl = item.snippet.thumbnails?.high?.url
                        || item.snippet.thumbnails?.default?.url
                        || '';
          }
        }
      }
    } catch (e) {
      console.warn("Could not fetch metadata from YT API:", e);
    }

    // 1.5. Fallback: scrape YouTube page HTML for what we're still missing
    if (durationSeconds === 0 || !channelId) {
      try {
        const htmlRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        const html = await htmlRes.text();
        if (durationSeconds === 0) {
          const m = html.match(/"lengthSeconds":"(\d+)"/);
          if (m) durationSeconds = parseInt(m[1], 10);
        }
        if (!channelId) {
          const m = html.match(/"channelId":"(UC[^"]{22})"/);
          if (m) channelId = m[1];
        }
        if (!channelTitle) {
          const m = html.match(/"author":"([^"]+)"/);
          if (m) channelTitle = decodeURIComponent(JSON.parse(`"${m[1]}"`));
        }
        if (!videoTitle) {
          const m = html.match(/<title>([^<]+)<\/title>/);
          if (m) videoTitle = m[1].replace(' - YouTube', '').trim();
        }
        if (!publishedAt) {
          const m = html.match(/"publishDate":"([^"]+)"/);
          if (m) publishedAt = new Date(m[1]).toISOString();
        }
        if (!thumbnailUrl) {
          thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        }
      } catch (e) {
        console.warn("Could not scrape metadata from HTML:", e);
      }
    }

    // 2. Try to get transcript — primary: youtube-transcript library
    let segments: { text: string; offset: number }[] = [];
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      segments = transcript.map((t: any) => ({ text: t.text, offset: Math.floor(t.offset / 1000) }));
      text = transcript.map((t: any) => t.text).join(" ");
      if (durationSeconds === 0) {
        const lastSegment = transcript[transcript.length - 1];
        durationSeconds = lastSegment ? (lastSegment.offset + lastSegment.duration) / 1000 : 0;
      }
    } catch (error: any) {
      console.warn(`youtube-transcript failed for ${videoId}, trying direct scrape:`, error.message);
    }

    // 2.5. Fallback: scrape caption tracks directly from the YouTube watch page
    if (segments.length === 0) {
      try {
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        });
        const pageHtml = await pageRes.text();

        // Fill any metadata we still need from this page fetch
        if (!channelId) {
          const m = pageHtml.match(/"channelId":"(UC[^"]{22})"/);
          if (m) channelId = m[1];
        }
        if (!channelTitle) {
          const m = pageHtml.match(/"author":"([^"]+)"/);
          if (m) try { channelTitle = JSON.parse(`"${m[1]}"`); } catch {}
        }
        if (!videoTitle) {
          const m = pageHtml.match(/<title>([^<]+)<\/title>/);
          if (m) videoTitle = m[1].replace(' - YouTube', '').trim();
        }
        if (!publishedAt) {
          const m = pageHtml.match(/"publishDate":"([^"]+)"/);
          if (m) publishedAt = new Date(m[1]).toISOString();
        }
        if (!thumbnailUrl) {
          thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        }
        if (durationSeconds === 0) {
          const m = pageHtml.match(/"lengthSeconds":"(\d+)"/);
          if (m) durationSeconds = parseInt(m[1], 10);
        }

        // Extract captionTracks array from page JS
        const tracksMatch = pageHtml.match(/"captionTracks":(\[[\s\S]*?\])/);
        if (tracksMatch) {
          let tracks: any[] = [];
          try { tracks = JSON.parse(tracksMatch[1]); } catch {}

          // Prefer manual English, then ASR English, then first available
          const track = tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr')
                     || tracks.find((t: any) => t.languageCode?.startsWith('en'))
                     || tracks[0];

          if (track?.baseUrl) {
            const capRes = await fetch(track.baseUrl + '&fmt=json3');
            if (capRes.ok) {
              const capData = await capRes.json();
              for (const event of capData.events || []) {
                if (!event.segs) continue;
                const t = event.segs.map((s: any) => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
                if (t) segments.push({ text: t, offset: Math.floor((event.tStartMs || 0) / 1000) });
              }
              text = segments.map(s => s.text).join(' ');
              if (durationSeconds === 0 && segments.length > 0) {
                durationSeconds = segments[segments.length - 1].offset + 30;
              }
              console.log(`Direct caption scrape succeeded for ${videoId}: ${segments.length} segments`);
            }
          }
        }
      } catch (fallbackErr: any) {
        console.warn(`Direct caption scrape also failed for ${videoId}:`, fallbackErr.message);
      }
    }

    res.json({ text, segments, durationSeconds, videoTitle, channelId, channelTitle, publishedAt, thumbnailUrl });
  });

  // API routes FIRST
  app.get("/api/youtube/latest", async (req, res) => {
    console.log("Fetching YouTube latest for channel:", req.query.channelId);
    try {
      const channelId = req.query.channelId as string;
      if (!channelId) {
        return res.status(400).json({ error: "channelId is required" });
      }

      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      const publishedAfter = oneDayAgo.toISOString();

      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet,id&order=date&maxResults=1&type=video&videoDuration=long&publishedAfter=${publishedAfter}`;
        const response = await fetch(url);
        const data = await response.json();

        if (response.ok) {
          return res.json(data);
        } else {
          console.error("YouTube API Error, falling back to RSS:", JSON.stringify(data.error, null, 2));
        }
      }
      
      // Fallback to RSS feed if no API key is provided or API fails
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const response = await fetch(rssUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        if (!response.ok) {
          console.warn(`RSS feed failed for channel ${channelId} with status ${response.status}. Returning empty list.`);
          return res.json({ items: [] });
        }
        const xmlData = await response.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const result = parser.parse(xmlData);
        
        const entries = result.feed?.entry || [];
        const recentEntries = (Array.isArray(entries) ? entries : [entries])
          .filter((entry: any) => new Date(entry.published) >= oneDayAgo);

        const items = [];
        for (const entry of recentEntries) {
          const videoId = entry['yt:videoId'];
          
          // Check if it's a short by seeing if /shorts/ URL returns 200 OK
          try {
            const shortCheck = await fetch(`https://www.youtube.com/shorts/${videoId}`, { method: 'HEAD', redirect: 'manual' });
            if (shortCheck.status === 200) {
              console.log(`Skipping short video from RSS: ${videoId}`);
              continue;
            }
          } catch (e) {
            // Ignore fetch errors for shorts check
          }

          items.push({
            id: { videoId },
            snippet: {
              title: entry.title,
              publishedAt: entry.published,
              thumbnails: {
                high: { url: entry['media:group']?.['media:thumbnail']?.['@_url'] || '' }
              }
            }
          });

          if (items.length >= 2) break; // Limit to 2 valid videos
        }

        return res.json({ items });
    } catch (error) {
      console.error("Error fetching YouTube data:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/youtube/historical", async (req, res) => {
    console.log("Fetching YouTube historical for channel:", req.query.channelId);
    try {
      const channelId = req.query.channelId as string;
      const days = parseInt(req.query.days as string) || 30;
      
      if (!channelId) {
        return res.status(400).json({ error: "channelId is required" });
      }

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - days);
      const publishedAfter = pastDate.toISOString();

      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        // Fetch up to 50 videos from the past 30 days
        const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet,id&order=date&maxResults=50&type=video&videoDuration=long&publishedAfter=${publishedAfter}`;
        const response = await fetch(url);
        const data = await response.json();

        if (response.ok) {
          return res.json(data);
        } else {
          console.error("YouTube API Error, falling back to RSS:", JSON.stringify(data.error, null, 2));
        }
      }
      
      // Fallback to RSS feed if no API key is provided or API fails
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const response = await fetch(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) {
        console.warn(`RSS feed failed for channel ${channelId} with status ${response.status}. Returning empty list.`);
        return res.json({ items: [] });
      }
      const xmlData = await response.text();
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
      const result = parser.parse(xmlData);
      
      const entries = result.feed?.entry || [];
      const recentEntries = (Array.isArray(entries) ? entries : [entries])
        .filter((entry: any) => new Date(entry.published) >= pastDate);

      const items = [];
      for (const entry of recentEntries) {
        const videoId = entry['yt:videoId'];
        
        // Check if it's a short by seeing if /shorts/ URL returns 200 OK
        try {
          const shortCheck = await fetch(`https://www.youtube.com/shorts/${videoId}`, { method: 'HEAD', redirect: 'manual' });
          if (shortCheck.status === 200) {
            console.log(`Skipping short video from RSS: ${videoId}`);
            continue;
          }
        } catch (e) {
          // Ignore fetch errors for shorts check
        }

        items.push({
          id: { videoId },
          snippet: {
            title: entry.title,
            publishedAt: entry.published,
            description: entry['media:group']?.['media:description'] || '',
            thumbnails: {
              high: { url: entry['media:group']?.['media:thumbnail']?.['@_url'] || '' }
            }
          }
        });

        if (items.length >= 15) break; // Limit to 15 valid videos
      }

      return res.json({ items });
    } catch (error) {
      console.error("Error fetching YouTube historical data:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/summarize", async (req, res) => {
    const { videoId, title, description, transcriptText, durationSeconds } = req.body;

    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // If we have a transcript and it's shorter than 20 minutes (1200 seconds), skip it
    if (durationSeconds > 0 && durationSeconds < 1200) {
      return res.status(400).json({ error: "VIDEO_TOO_SHORT" });
    }
    
    // Fallback check based on transcript length if duration is missing
    if (durationSeconds === 0) {
      // If transcript is missing entirely, or it's too short, assume it's a Short or invalid
      if (!transcriptText || transcriptText.length < 4000) {
        return res.status(400).json({ error: "VIDEO_TOO_SHORT" });
      }
    }

    const keyPointsInstruction = `Write 5–6 key_points. These should read like the notes a brilliant, opinionated listener jotted down right after the episode — the things they'd bring up at a dinner table or fire off in a group chat.

Each point must:
- State a specific, concrete claim with the angle or implication — not "they discussed AI costs" but "AI inference costs dropped 99% in two years, which Sacks calls 100x faster than Moore's Law — and it's still accelerating"
- Be written in direct, active voice — cut all filler like "the hosts discuss...", "this episode covers...", "according to X...". Just state the idea.
- Include the surprise or the so-what — why does this matter, what's the non-obvious part?
- Be punchy — short when the idea is simple, a full sentence when a complex argument needs it
- Be standalone — a stranger should find it interesting without having heard the episode

Together, the 5–6 points should cover the episode's major threads, not just its 5 most dramatic moments.`;

    const prompt = transcriptText
      ? `Analyze this podcast transcript for the video titled "${title || videoId}". Respond in the same language as the transcript.\n\n${keyPointsInstruction}\n\nRespond with ONLY a valid JSON object (no markdown, no extra text) in this exact format: {"summary": "3-sentence summary here", "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"], "topics": ["topic 1", "topic 2"]}\n\nTranscript:\n${transcriptText}`
      : `Analyze this YouTube video: https://youtube.com/watch?v=${videoId}. Title: "${title}". Description: "${description}". Respond in the same language as the title and description.\n\n${keyPointsInstruction}\n\nRespond with ONLY a valid JSON object (no markdown, no extra text) in this exact format: {"summary": "3-sentence summary here", "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"], "topics": ["topic 1", "topic 2"]}`;

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({
        apiKey: process.env.MINIMAX_API_KEY || '',
        baseURL: 'https://api.minimax.io/anthropic',
      });

      const response = await client.messages.create({
        model: 'MiniMax-M2.7',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find((b: any) => b.type === 'text');
      const text = textBlock ? (textBlock as any).text : '';
      if (!text) return res.status(500).json({ error: `No response from MiniMax (stop_reason: ${response.stop_reason}, content_blocks: ${response.content.length})` });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'MiniMax returned invalid JSON' });

      try {
        return res.status(200).json(JSON.parse(jsonMatch[0]));
      } catch {
        return res.status(500).json({ error: 'MiniMax returned invalid JSON' });
      }
    } catch (error: any) {
      console.error("Error calling MiniMax API:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { messages, context, systemInstruction: providedSystemInstruction } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({
        apiKey: process.env.MINIMAX_API_KEY || '',
        baseURL: 'https://api.minimax.io/anthropic',
      });

      const systemInstruction = providedSystemInstruction || `You are an AI assistant for a podcast briefing tool. Answer the user's questions based on the following recent podcast episodes context:\n\n${context || 'No recent episodes found.'}`;

      const anthropicMessages = messages.map((m: any) => ({
        role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
        content: m.text,
      }));

      const response = await client.messages.create({
        model: 'MiniMax-M2.7',
        max_tokens: 4096,
        system: systemInstruction,
        messages: anthropicMessages,
      });

      const textBlock = response.content.find((b: any) => b.type === 'text');
      const text = textBlock ? (textBlock as any).text : '';
      return res.status(200).json({ text });
    } catch (error: any) {
      console.error("Error calling MiniMax API for chat:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  app.post("/api/synthesize", async (req, res) => {
    const { title, segments } = req.body;

    if (!segments || segments.length === 0) {
      return res.status(400).json({ error: 'segments are required' });
    }

    // Exact string match: find the segment where the quote starts, return its offset as MM:SS
    // Tries progressively shorter prefixes (7→5→4 words) to handle ASR word-boundary differences
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
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({
        apiKey: process.env.MINIMAX_API_KEY || '',
        baseURL: 'https://api.minimax.io/anthropic',
      });

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

      // Pin each quote to its exact segment offset via string matching
      for (const insight of insights) {
        if (insight.quote) insight.timestamp = findQuoteTimestamp(insight.quote) ?? null;
        if (insight.second_quote) insight.second_timestamp = findQuoteTimestamp(insight.second_quote) ?? null;
      }

      // Sort insights chronologically by their earliest timestamp
      insights.sort((a: any, b: any) => {
        const aMin = Math.min(tsToSeconds(a.timestamp), tsToSeconds(a.second_timestamp ?? null));
        const bMin = Math.min(tsToSeconds(b.timestamp), tsToSeconds(b.second_timestamp ?? null));
        return aMin - bMin;
      });

      return res.status(200).json({ insights });
    } catch (error: any) {
      console.error("Error calling MiniMax API for synthesis:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
