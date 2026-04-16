import type { AiProviderType } from '@k8s-hosting/api-contracts';
import type { LlmProviderAdapter } from './types.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAiAdapter } from './openai.js';

export type { LlmProviderAdapter, LlmMessage, LlmResponse } from './types.js';

export function createProviderAdapter(
  type: AiProviderType,
  apiKey: string,
  baseUrl?: string | null,
): LlmProviderAdapter {
  switch (type) {
    case 'anthropic':
      return createAnthropicAdapter(apiKey);
    case 'openai':
      return createOpenAiAdapter(apiKey);
    case 'openai_compatible':
      return createOpenAiAdapter(apiKey, baseUrl);
    default:
      throw new Error(`Unsupported provider type: ${type as string}`);
  }
}
