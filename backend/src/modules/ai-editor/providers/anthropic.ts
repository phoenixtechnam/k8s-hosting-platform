import Anthropic from '@anthropic-ai/sdk';
import type { LlmProviderAdapter, LlmMessage, LlmResponse } from './types.js';

export function createAnthropicAdapter(apiKey: string): LlmProviderAdapter {
  const client = new Anthropic({ apiKey });

  return {
    async call(modelName, messages, options = {}) {
      const systemMessage = messages.find((m) => m.role === 'system');
      const userMessages = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const response = await client.messages.create({
        model: modelName,
        max_tokens: options.maxTokens ?? 4096,
        ...(systemMessage ? { system: systemMessage.content } : {}),
        messages: userMessages,
      });

      const content = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return {
        content,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
        model: response.model,
      };
    },

    async testConnection(modelName) {
      const start = Date.now();
      try {
        await client.messages.create({
          model: modelName ?? 'claude-haiku-4-5-20251001',
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
