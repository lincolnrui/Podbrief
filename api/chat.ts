import { GoogleGenAI } from '@google/genai';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context, systemInstruction: providedSystemInstruction } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const ai = new GoogleGenAI({ 
      apiKey: process.env.GEMINI_API_KEY || ''
    });

    const systemInstruction = providedSystemInstruction || `You are an AI assistant for a podcast briefing tool. Answer the user's questions based on the following recent podcast episodes context:\n\n${context || 'No recent episodes found.'}`;

    const contents = messages.map((m: any) => ({
      role: m.role,
      parts: [{ text: m.text }]
    }));

    // For Vercel Serverless Functions, streaming can be complex depending on the setup.
    // We will use standard generateContent for simplicity, or we can stream using Server-Sent Events.
    // Let's use standard generateContent to ensure compatibility.
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: contents,
      config: {
        systemInstruction,
      }
    });

    const text = response.text;
    if (!text) {
      return res.status(500).json({ error: "No response from Gemini" });
    }

    return res.status(200).json({ text });
  } catch (error: any) {
    console.error("Error calling Gemini API for chat:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
}
