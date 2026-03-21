import { GoogleGenAI, Type } from '@google/genai';

export const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || ''
});

export async function summarizeVideo(videoId: string, title?: string, description?: string) {
  let transcriptText = "";
  let durationSeconds = 0;
  try {
    const res = await fetch(`/api/youtube/transcript?videoId=${videoId}`);
    if (res.ok) {
      const data = await res.json();
      transcriptText = data.text;
      durationSeconds = data.durationSeconds || 0;
    }
  } catch (err) {
    console.warn("Could not fetch transcript for video", videoId, err);
  }

  // If we have a transcript and it's shorter than 20 minutes (1200 seconds), skip it
  if (durationSeconds > 0 && durationSeconds < 1200) {
    throw new Error("VIDEO_TOO_SHORT");
  }
  
  // Fallback check based on transcript length if duration is missing
  if (durationSeconds === 0 && transcriptText && transcriptText.length < 5000) {
    throw new Error("VIDEO_TOO_SHORT");
  }

  const prompt = transcriptText 
    ? `Analyze this podcast transcript for the video titled "${title || videoId}". Provide a 3-sentence summary, 5 key points, and a list of topics.\n\nTranscript:\n${transcriptText}` 
    : `Analyze this YouTube video: https://youtube.com/watch?v=${videoId}. Title: "${title}". Description: "${description}". Provide a 3-sentence summary, 5 key points, and a list of topics.`;

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
  if (!text) throw new Error("No response from Gemini");
  
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse Gemini response:", text);
    throw new Error("Gemini returned invalid JSON: " + text.substring(0, 100));
  }
}
