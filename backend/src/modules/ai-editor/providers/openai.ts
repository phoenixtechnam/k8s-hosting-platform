import OpenAI from 'openai';
import type { LlmProviderAdapter, LlmMessage, LlmResponse } from './types.js';

export function createOpenAiAdapter(apiKey: string, baseUrl?: string | null): LlmProviderAdapter {
  const client = new OpenAI({
    apiKey: apiKey || 'dummy',
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });

  return {
    async call(modelName, messages, options = {}) {
      const response = await client.chat.completions.create({
        model: modelName,
        max_tokens: options.maxTokens ?? 4096,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';

      return {
        content,
        tokensInput: response.usage?.prompt_tokens ?? 0,
        tokensOutput: response.usage?.completion_tokens ?? 0,
        model: response.model,
      };
    },

    async testConnection(modelName) {
      const start = Date.now();
      try {
        await client.chat.completions.create({
          model: modelName ?? 'gpt-4o-mini',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply with "ok"' }],
        });
        return { success: true, message: 'Connected', latencyMs: Date.now() - start };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'Connection failed' };
      }
    },
  };
}
