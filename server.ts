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
      const apiKey = process.env.YOUTUBE_API_KEY || 'AIzaSyAriygxPpbvUDCelrK4Km1dM79BLuHa2FE';
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
    } catch (e) {
      console.warn("Could not fetch duration from YT API:", e);
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

      const apiKey = process.env.YOUTUBE_API_KEY || 'AIzaSyAriygxPpbvUDCelrK4Km1dM79BLuHa2FE';
      if (apiKey) {
        const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet,id&order=date&maxResults=1&type=video&videoDuration=long&publishedAfter=${publishedAfter}`;
        const response = await fetch(url);
        const data = await response.json();

        if (response.ok) {
          return res.json(data);
        } else {
          console.error("YouTube API Error, falling back to RSS:", data);
        }
      }
      
      // Fallback to RSS feed if no API key is provided or API fails
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const response = await fetch(rssUrl);
        if (!response.ok) {
          return res.status(response.status).json({ error: "Failed to fetch YouTube RSS feed" });
        }
        const xmlData = await response.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const result = parser.parse(xmlData);
        
        const entries = result.feed?.entry || [];
        const items = (Array.isArray(entries) ? entries : [entries])
          .filter((entry: any) => new Date(entry.published) >= oneDayAgo)
          .slice(0, 2)
          .map((entry: any) => ({
          id: { videoId: entry['yt:videoId'] },
          snippet: {
            title: entry.title,
            publishedAt: entry.published,
            thumbnails: {
              high: { url: entry['media:group']?.['media:thumbnail']?.['@_url'] || '' }
            }
          }
        }));

        return res.json({ items });
    } catch (error) {
      console.error("Error fetching YouTube data:", error);
      res.status(500).json({ error: "Internal server error" });
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
