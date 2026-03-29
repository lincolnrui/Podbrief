export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url);
  const videoId = searchParams.get('videoId');

  if (!videoId) {
    return new Response(JSON.stringify({ error: 'videoId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let durationSeconds = 0;
  let text = '';
  let videoTitle = '';
  let channelId = '';
  let channelTitle = '';
  let publishedAt = '';
  let thumbnailUrl = '';
  let segments: { text: string; offset: number }[] = [];

  // 1. Try YouTube Data API for metadata + duration
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoId}&key=${apiKey}`
      );
      if (ytRes.ok) {
        const ytData = await ytRes.json();
        if (ytData.items?.length > 0) {
          const item = ytData.items[0];
          const m = item.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) {
            durationSeconds = parseInt(m[1] || '0') * 3600
                            + parseInt(m[2] || '0') * 60
                            + parseInt(m[3] || '0');
          }
          videoTitle   = item.snippet.title || '';
          channelId    = item.snippet.channelId || '';
          channelTitle = item.snippet.channelTitle || '';
          publishedAt  = item.snippet.publishedAt || '';
          thumbnailUrl = item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '';
        }
      }
    } catch {}
  }

  // 2. Scrape YouTube watch page for captions + any missing metadata
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const pageHtml = await pageRes.text();

    // Fill missing metadata from HTML
    if (!durationSeconds) {
      const m = pageHtml.match(/"lengthSeconds":"(\d+)"/);
      if (m) durationSeconds = parseInt(m[1]);
    }
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

    // Extract captionTracks
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
          if (!durationSeconds && segments.length > 0) {
            durationSeconds = segments[segments.length - 1].offset + 30;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('Caption scraping failed:', err instanceof Error ? err.message : err);
  }

  return new Response(
    JSON.stringify({ text, segments, durationSeconds, videoTitle, channelId, channelTitle, publishedAt, thumbnailUrl }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
