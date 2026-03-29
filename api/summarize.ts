import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY || '',
  baseURL: 'https://api.minimax.io/anthropic',
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { videoId, title, description, transcriptText, durationSeconds } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  if (durationSeconds > 0 && durationSeconds < 1200) {
    return res.status(400).json({ error: 'VIDEO_TOO_SHORT' });
  }

  if (durationSeconds === 0 && (!transcriptText || transcriptText.length < 4000)) {
    // No duration AND no transcript — skip only if there's also no description to fall back on
    if (!description || description.length < 100) {
      return res.status(400).json({ error: 'VIDEO_TOO_SHORT' });
    }
  }

  const keyPointsInstruction = `Write 5–6 key_points. These should read like the notes a brilliant, opinionated listener jotted down right after the episode — the things they'd bring up at a dinner table or fire off in a group chat.

Each point must:
- State a specific, concrete claim with the angle or implication — not "they discussed AI costs" but "AI inference costs dropped 99% in two years, which Sacks calls 100x faster than Moore's Law — and it's still accelerating"
- Be written in direct, active voice — cut all filler like "the hosts discuss...", "this episode covers...", "according to X...". Just state the idea.
- Include the surprise or the so-what — why does this matter, what's the non-obvious part?
- Be punchy — short when the idea is simple, a full sentence when a complex argument needs it
- Be standalone — a stranger should find it interesting without having heard the episode

Together, the 5–6 points should cover the episode's major threads, not just its 5 most dramatic moments.`;

  const prompt = transcriptText
    ? `Analyze this podcast transcript for the video titled "${title || videoId}". Respond in the same language as the transcript.\n\n${keyPointsInstruction}\n\nRespond with ONLY a valid JSON object (no markdown, no extra text) in this exact format: {"summary": "3-sentence summary here", "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"], "topics": ["topic 1", "topic 2"]}\n\nTranscript:\n${transcriptText}`
    : `Analyze this YouTube video: https://youtube.com/watch?v=${videoId}. Title: "${title}". Description: "${description}". Respond in the same language as the title and description.\n\n${keyPointsInstruction}\n\nRespond with ONLY a valid JSON object (no markdown, no extra text) in this exact format: {"summary": "3-sentence summary here", "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"], "topics": ["topic 1", "topic 2"]}`;

  try {
    const response = await client.messages.create({
      model: 'MiniMax-M2.7',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    const text = textBlock ? (textBlock as any).text : '';
    if (!text) {
      return res.status(500).json({ error: 'No response from MiniMax' });
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'MiniMax returned invalid JSON' });
    }

    try {
      return res.status(200).json(JSON.parse(jsonMatch[0]));
    } catch {
      return res.status(500).json({ error: 'MiniMax returned invalid JSON' });
    }
  } catch (error: any) {
    console.error('Error calling MiniMax API:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
