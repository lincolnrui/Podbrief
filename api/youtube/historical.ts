import { XMLParser } from "fast-xml-parser";

export default async function handler(req: any, res: any) {
  const channelId = req.query.channelId as string;
  const days = parseInt(req.query.days as string) || 30;
  
  if (!channelId) {
    return res.status(400).json({ error: "channelId is required" });
  }

  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - days);
  const publishedAfter = pastDate.toISOString();

  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (apiKey) {
      // Fetch up to 50 videos from the past 30 days
      const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet,id&order=date&maxResults=50&type=video&videoDuration=long&publishedAfter=${publishedAfter}`;
      const response = await fetch(url);
      const data = await response.json();

      if (response.ok) {
        return res.status(200).json(data);
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
      return res.status(200).json({ items: [] });
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

    return res.status(200).json({ items });
  } catch (error) {
    console.error("Error fetching YouTube historical data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
