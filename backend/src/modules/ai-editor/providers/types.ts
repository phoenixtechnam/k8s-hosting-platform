export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmResponse {
  readonly content: string;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly model: string;
}

export interface LlmProviderAdapter {
  call(
    modelName: string,
    messages: readonly LlmMessage[],
    options?: { maxTokens?: number },
  ): Promise<LlmResponse>;

  testConnection(modelName?: string): Promise<{ success: boolean; message: string; latencyMs?: number }>;
}
