import { XMLParser } from "fast-xml-parser";

export default async function handler(req: any, res: any) {
  const channelId = req.query.channelId as string;
  if (!channelId) {
    return res.status(400).json({ error: "channelId is required" });
  }

  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  const publishedAfter = oneDayAgo.toISOString();

  try {
    const apiKey = process.env.YOUTUBE_API_KEY || 'AIzaSyAriygxPpbvUDCelrK4Km1dM79BLuHa2FE';
    if (apiKey) {
      const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet,id&order=date&maxResults=1&type=video&videoDuration=long&publishedAfter=${publishedAfter}`;
      const response = await fetch(url);
      const data = await response.json();

      if (response.ok) {
        return res.status(200).json(data);
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

    return res.status(200).json({ items });
  } catch (error) {
    console.error("Error fetching YouTube data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
