export const config = { runtime: 'edge' };

// Encode videoId for YouTube InnerTube get_transcript params (protobuf)
function encodeInnerTubeParams(videoId: string): string {
  const enc = new TextEncoder().encode(videoId);
  const buf = new Uint8Array([0x0a, enc.length, ...enc]);
  return btoa(String.fromCharCode(...buf));
}

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
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let segments: { text: string; offset: number }[] = [];

  // 1. YouTube Data API for metadata (if key set)
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const ytRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoId}&key=${apiKey}`);
      if (ytRes.ok) {
        const d = await ytRes.json();
        if (d.items?.length > 0) {
          const item = d.items[0];
          const m = item.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) durationSeconds = +( m[1]||0)*3600 + +(m[2]||0)*60 + +(m[3]||0);
          videoTitle   = item.snippet.title || '';
          channelId    = item.snippet.channelId || '';
          channelTitle = item.snippet.channelTitle || '';
          publishedAt  = item.snippet.publishedAt || '';
          thumbnailUrl = item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || thumbnailUrl;
        }
      }
    } catch {}
  }

  // Common browser headers used across all requests
  const browserHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    // Consent cookie bypasses YouTube's cookie consent gate
    'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+999; SOCS=CAI; GPS=1; VISITOR_INFO1_LIVE=; YSC=',
  };

  // 2. InnerTube get_transcript API — same approach as youtube-transcript library
  try {
    const params = encodeInnerTubeParams(videoId);
    const itRes = await fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
      method: 'POST',
      headers: {
        ...browserHeaders,
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20230522.06.00',
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20230522.06.00',
            hl: 'en',
            gl: 'US',
          }
        },
        params,
      }),
    });
    if (itRes.ok) {
      const data = await itRes.json();
      const actions = data?.actions?.[0]?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer
        ?.body?.transcriptSegmentListRenderer?.initialSegments;
      if (actions?.length > 0) {
        for (const seg of actions) {
          const r = seg.transcriptSegmentRenderer;
          if (!r) continue;
          const t = r.snippet?.runs?.map((x: any) => x.text).join('') || '';
          const offset = Math.floor(parseInt(r.startMs || '0') / 1000);
          if (t) segments.push({ text: t, offset });
        }
        if (segments.length > 0) {
          text = segments.map(s => s.text).join(' ');
          if (!durationSeconds) durationSeconds = segments[segments.length - 1].offset + 30;
        }
      }
    }
  } catch {}

  // 3. Fallback: scrape watch page with consent cookies + robust captionTracks extraction
  if (segments.length === 0) {
    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          ...browserHeaders,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Referer': 'https://www.google.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      const html = await pageRes.text();

      // Fill missing metadata
      if (!durationSeconds) { const m = html.match(/"lengthSeconds":"(\d+)"/); if (m) durationSeconds = +m[1]; }
      if (!channelId)    { const m = html.match(/"channelId":"(UC[^"]{22})"/); if (m) channelId = m[1]; }
      if (!channelTitle) { const m = html.match(/"author":"([^"]+)"/); if (m) try { channelTitle = JSON.parse(`"${m[1]}"`); } catch {} }
      if (!videoTitle)   { const m = html.match(/<title>([^<]+)<\/title>/); if (m) videoTitle = m[1].replace(' - YouTube', '').trim(); }
      if (!publishedAt)  { const m = html.match(/"publishDate":"([^"]+)"/); if (m) publishedAt = new Date(m[1]).toISOString(); }

      // Robust captionTracks extraction: walk brackets instead of fragile regex
      let captionTracks: any[] = [];
      const marker = '"captionTracks":';
      const idx = html.indexOf(marker);
      if (idx !== -1) {
        let depth = 0, start = idx + marker.length, end = start;
        for (let i = start; i < html.length && i < start + 200000; i++) {
          if (html[i] === '[' || html[i] === '{') depth++;
          else if (html[i] === ']' || html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        try { captionTracks = JSON.parse(html.slice(start, end)); } catch {}
      }

      const track = captionTracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr')
                 || captionTracks.find((t: any) => t.languageCode?.startsWith('en'))
                 || captionTracks[0];

      if (track?.baseUrl) {
        const capRes = await fetch(track.baseUrl + '&fmt=json3', { headers: browserHeaders });
        if (capRes.ok) {
          const capData = await capRes.json();
          for (const event of capData.events || []) {
            if (!event.segs) continue;
            const t = event.segs.map((s: any) => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
            if (t) segments.push({ text: t, offset: Math.floor((event.tStartMs || 0) / 1000) });
          }
          if (segments.length > 0) {
            text = segments.map(s => s.text).join(' ');
            if (!durationSeconds) durationSeconds = segments[segments.length - 1].offset + 30;
          }
        }
      }
    } catch {}
  }

  // 4. Last resort: direct timedtext API (works for some older/manual-caption videos)
  if (segments.length === 0) {
    for (const suffix of ['lang=en', 'lang=en&kind=asr', 'lang=en-US']) {
      try {
        const r = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3&${suffix}`);
        if (r.ok) {
          const body = await r.text();
          if (body && body.length > 50) {
            const data = JSON.parse(body);
            for (const event of data.events || []) {
              if (!event.segs) continue;
              const t = event.segs.map((s: any) => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
              if (t) segments.push({ text: t, offset: Math.floor((event.tStartMs || 0) / 1000) });
            }
            if (segments.length > 0) {
              text = segments.map(s => s.text).join(' ');
              if (!durationSeconds) durationSeconds = segments[segments.length - 1].offset + 30;
              break;
            }
          }
        }
      } catch {}
    }
  }

  return new Response(
    JSON.stringify({ text, segments, durationSeconds, videoTitle, channelId, channelTitle, publishedAt, thumbnailUrl }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
