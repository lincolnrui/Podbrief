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

  res.status(200).json({ text, durationSeconds });
}
