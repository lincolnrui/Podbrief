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
  const PORT = 3000;

  app.use(express.json());

  app.get("/api/youtube/transcript", async (req, res) => {
    const videoId = req.query.videoId as string;
    if (!videoId) {
      return res.status(400).json({ error: "videoId is required" });
    }
    
    let durationSeconds = 0;
    let text = "";

    // 1. Try to get exact duration from YouTube API
    try {
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        const ytRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${apiKey}`);
      if (ytRes.ok) {
        const ytData = await ytRes.json();
        if (ytData.items && ytData.items.length > 0) {
          const durationIso = ytData.items[0].contentDetails.duration;
          const match = durationIso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (match) {
            const hours = parseInt(match[1] || '0', 10);
            const minutes = parseInt(match[2] || '0', 10);
            const seconds = parseInt(match[3] || '0', 10);
            durationSeconds = hours * 3600 + minutes * 60 + seconds;
          }
        }
      }
      }
    } catch (e) {
      console.warn("Could not fetch duration from YT API:", e);
    }

    // 1.5. Fallback: Scrape duration from YouTube page HTML if API failed
    if (durationSeconds === 0) {
      try {
        const htmlRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        const html = await htmlRes.text();
        const match = html.match(/"lengthSeconds":"(\d+)"/);
        if (match && match[1]) {
          durationSeconds = parseInt(match[1], 10);
        }
      } catch (e) {
        console.warn("Could not scrape duration from HTML:", e);
      }
    }

    // 2. Try to get transcript
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      text = transcript.map((t: any) => t.text).join(" ");
      if (durationSeconds === 0) {
        const lastSegment = transcript[transcript.length - 1];
        durationSeconds = lastSegment ? (lastSegment.offset + lastSegment.duration) / 1000 : 0;
      }
    } catch (error: any) {
      console.warn(`Transcript unavailable for ${videoId} (likely captcha/rate limit):`, error.message);
    }

    res.json({ text, durationSeconds });
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

    const prompt = transcriptText 
      ? `Analyze this podcast transcript for the video titled "${title || videoId}". Provide a 3-sentence summary, 5 key points, and a list of topics.\n\nTranscript:\n${transcriptText}` 
      : `Analyze this YouTube video: https://youtube.com/watch?v=${videoId}. Title: "${title}". Description: "${description}". Provide a 3-sentence summary, 5 key points, and a list of topics.`;

    try {
      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({ 
        apiKey: process.env.GEMINI_API_KEY || ''
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING, description: "A 3-sentence summary of the episode" },
              key_points: { type: Type.ARRAY, items: { type: Type.STRING }, description: "5 bullet point key insights" },
              topics: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of topics discussed" }
            },
            required: ["summary", "key_points", "topics"]
          }
        }
      });

      const text = response.text;
      if (!text) {
        return res.status(500).json({ error: "No response from Gemini" });
      }
      
      try {
        const parsed = JSON.parse(text);
        return res.status(200).json(parsed);
      } catch (e) {
        console.error("Failed to parse Gemini response:", text);
        return res.status(500).json({ error: "Gemini returned invalid JSON" });
      }
    } catch (error: any) {
      console.error("Error calling Gemini API:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { messages, context, systemInstruction: providedSystemInstruction } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ 
        apiKey: process.env.GEMINI_API_KEY || ''
      });

      const systemInstruction = providedSystemInstruction || `You are an AI assistant for a podcast briefing tool. Answer the user's questions based on the following recent podcast episodes context:\n\n${context || 'No recent episodes found.'}`;

      const contents = messages.map((m: any) => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      // For simplicity, we use standard generateContent instead of streaming
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contents,
        config: {
          systemInstruction,
        }
      });

      const text = response.text;
      if (!text) {
        return res.status(500).json({ error: "No response from Gemini" });
      }

      return res.status(200).json({ text });
    } catch (error: any) {
      console.error("Error calling Gemini API for chat:", error);
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
