import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY || '',
  baseURL: 'https://api.minimax.io/anthropic',
});

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context, systemInstruction: providedSystemInstruction } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const systemInstruction = providedSystemInstruction ||
    `You are an AI assistant for a podcast briefing tool. Answer the user's questions based on the following recent podcast episodes context:\n\n${context || 'No recent episodes found.'}`;

  // Convert from Gemini format (role: 'model') to Anthropic format (role: 'assistant')
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((m: any) => ({
    role: m.role === 'model' ? 'assistant' : m.role as 'user' | 'assistant',
    content: m.text,
  }));

  try {
    const response = await client.messages.create({
      model: 'MiniMax-M2.7',
      max_tokens: 4096,
      system: systemInstruction,
      messages: anthropicMessages,
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    const text = textBlock ? (textBlock as any).text : '';
    return res.status(200).json({ text });
  } catch (error: any) {
    console.error('Error calling MiniMax API:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
