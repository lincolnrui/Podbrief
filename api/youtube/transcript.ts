import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { YoutubeTranscript } = require('youtube-transcript');

// Supabase client for server-side DB transcript lookup (bypasses YouTube IP blocking)
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export default async function handler(req: any, res: any) {
  const videoId = req.query.videoId as string;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  let durationSeconds = 0;
  let text = '';
  let videoTitle = '';
  let channelId = '';
  let channelTitle = '';
  let publishedAt = '';
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let segments: { text: string; offset: number }[] = [];

  // STEP 0: Check Supabase for a previously-stored transcript.
  // This completely bypasses YouTube's IP blocking — if the video was ever processed
  // locally (where YouTube access works), the transcript is already in the DB.
  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data } = await supabase
        .from('episodes')
        .select('transcript_segments, title, published_at, thumbnail_url')
        .eq('youtube_video_id', videoId)
        .maybeSingle();

      if (data?.transcript_segments?.length > 0) {
        const segs = data.transcript_segments as { text: string; offset: number }[];
        return res.status(200).json({
          text: segs.map((s: any) => s.text).join(' '),
          segments: segs,
          durationSeconds: (segs[segs.length - 1]?.offset || 0) + 30,
          videoTitle: data.title || '',
          channelId: '',
          channelTitle: '',
          publishedAt: data.published_at || '',
          thumbnailUrl: data.thumbnail_url || thumbnailUrl,
        });
      }
    } catch {
      // transcript_segments column might not exist yet — that's OK, continue to live fetch
    }
  }

  // STEP 1: YouTube Data API for metadata (if API key is set)
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoId}&key=${apiKey}`
      );
      if (ytRes.ok) {
        const d = await ytRes.json();
        if (d.items?.length > 0) {
          const item = d.items[0];
          const m = item.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) durationSeconds = +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0);
          videoTitle = item.snippet.title || '';
          channelId = item.snippet.channelId || '';
          channelTitle = item.snippet.channelTitle || '';
          publishedAt = item.snippet.publishedAt || '';
          thumbnailUrl =
            item.snippet.thumbnails?.high?.url ||
            item.snippet.thumbnails?.default?.url ||
            thumbnailUrl;
        }
      }
    } catch {}
  }

  // STEP 2: youtubei.js — the most sophisticated InnerTube client, handles anti-bot measures
  try {
    // Dynamic import handles ESM/CJS interop gracefully
    const { Innertube } = await import('youtubei.js');
    const yt = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
    });

    const info = await yt.getBasicInfo(videoId, 'WEB');
    const transcriptData = await info.getTranscript();
    const body = transcriptData?.transcript?.content?.body;
    const initialSegments = body?.initial_segments ?? (body as any)?.initialSegments;

    if (initialSegments?.length > 0) {
      for (const seg of initialSegments) {
        // The segment type might be 'TranscriptSegment' or have a different shape
        const r = seg?.transcriptSegmentRenderer ?? seg;
        const t: string =
          r?.snippet?.runs?.map((x: any) => x.text).join('') ??
          r?.snippet?.text ??
          seg?.snippet?.text ??
          '';
        const startMs: string =
          r?.startMs ?? r?.start_ms ?? seg?.start_ms ?? '0';
        const offset = Math.floor(parseInt(startMs) / 1000);
        if (t.trim()) segments.push({ text: t.trim(), offset });
      }
      if (segments.length > 0) {
        text = segments.map(s => s.text).join(' ');
        if (!durationSeconds) durationSeconds = segments[segments.length - 1].offset + 30;
      }
    }
  } catch (err) {
    console.warn('youtubei.js failed for', videoId, ':', (err as any)?.message ?? err);
  }

  // STEP 3: youtube-transcript npm library (classic approach)
  if (segments.length === 0) {
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      if (transcript && transcript.length > 0) {
        segments = transcript.map((t: any) => ({
          text: t.text,
          offset: Math.floor((t.offset || 0) / 1000),
        }));
        text = transcript.map((t: any) => t.text).join(' ');
        if (!durationSeconds && segments.length > 0) {
          durationSeconds = segments[segments.length - 1].offset + 30;
        }
      }
    } catch (err) {
      console.warn('youtube-transcript library failed for', videoId, ':', (err as any)?.message ?? err);
    }
  }

  // STEP 4: Scrape watch page with consent cookies
  if (segments.length === 0) {
    const browserHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie:
        'CONSENT=YES+cb.20210328-17-p0.en+FX+999; SOCS=CAI; GPS=1; VISITOR_INFO1_LIVE=; YSC=',
    };

    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          ...browserHeaders,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          Referer: 'https://www.google.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      const html = await pageRes.text();

      // Fill missing metadata from page HTML
      if (!durationSeconds) { const m = html.match(/"lengthSeconds":"(\d+)"/); if (m) durationSeconds = +m[1]; }
      if (!channelId) { const m = html.match(/"channelId":"(UC[^"]{22})"/); if (m) channelId = m[1]; }
      if (!channelTitle) { const m = html.match(/"author":"([^"]+)"/); if (m) try { channelTitle = JSON.parse(`"${m[1]}"`); } catch {} }
      if (!videoTitle) { const m = html.match(/<title>([^<]+)<\/title>/); if (m) videoTitle = m[1].replace(' - YouTube', '').trim(); }
      if (!publishedAt) { const m = html.match(/"publishDate":"([^"]+)"/); if (m) publishedAt = new Date(m[1]).toISOString(); }

      // Extract captionTracks by bracket-walking
      let captionTracks: any[] = [];
      const marker = '"captionTracks":';
      const idx = html.indexOf(marker);
      if (idx !== -1) {
        let depth = 0, start = idx + marker.length, end = start;
        for (let i = start; i < html.length && i < start + 200000; i++) {
          if (html[i] === '[' || html[i] === '{') depth++;
          else if (html[i] === ']' || html[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        try { captionTracks = JSON.parse(html.slice(start, end)); } catch {}
      }

      const track =
        captionTracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ||
        captionTracks.find((t: any) => t.languageCode?.startsWith('en')) ||
        captionTracks[0];

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
    } catch (err) {
      console.warn('Watch page scrape failed for', videoId, ':', (err as any)?.message ?? err);
    }
  }

  // STEP 5: Direct timedtext API (legacy, sometimes works without watch-page session)
  if (segments.length === 0) {
    for (const suffix of ['lang=en', 'lang=en&kind=asr', 'lang=en-US', 'lang=en-US&kind=asr']) {
      try {
        const r = await fetch(
          `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3&${suffix}`
        );
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

  return res.status(200).json({
    text,
    segments,
    durationSeconds,
    videoTitle,
    channelId,
    channelTitle,
    publishedAt,
    thumbnailUrl,
  });
}
