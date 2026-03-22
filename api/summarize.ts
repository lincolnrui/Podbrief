import { GoogleGenAI, Type } from '@google/genai';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
}
