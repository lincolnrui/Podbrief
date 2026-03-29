import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { YoutubeTranscript } = require("youtube-transcript");

export default async function handler(req: any, res: any) {
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
          const durationIso = item.contentDetails.duration;
          const match = durationIso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (match) {
            durationSeconds = parseInt(match[1] || '0', 10) * 3600
                            + parseInt(match[2] || '0', 10) * 60
                            + parseInt(match[3] || '0', 10);
          }
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
}
