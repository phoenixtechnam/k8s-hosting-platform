import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useClientContext } from './use-client-context';
import type { AiEditResponse, AiModelResponse } from '@k8s-hosting/api-contracts';
import { useQuery } from '@tanstack/react-query';

export function useAiModels() {
  return useQuery({
    queryKey: ['ai-models-enabled'],
    queryFn: () => apiFetch<{ data: AiModelResponse[] }>('/api/v1/ai/models'),
    staleTime: 60_000,
  });
}

export interface AiEditChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  originalContent?: string;
  modifiedContent?: string;
  summary?: string;
}

export function useAiFileEdit(deploymentId: string) {
  const { clientId } = useClientContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changes: AiEditChange[]; tokensUsed: { input: number; output: number } } | null>(null);

  const edit = useCallback(async (
    filePath: string,
    fileContent: string,
    instruction: string,
    modelId: string,
  ) => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiFetch<{ data: AiEditResponse }>(
        `/api/v1/clients/${clientId}/ai/edit`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'file',
            ...(deploymentId ? { deployment_id: deploymentId } : {}),
            file_path: filePath,
            file_content: fileContent,
            instruction,
            model_id: modelId,
          }),
        },
      );
      setResult({
        changes: response.data.changes,
        tokensUsed: response.data.tokensUsed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI edit failed');
    } finally {
      setLoading(false);
    }
  }, [clientId, deploymentId]);

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { edit, loading, error, result, clear };
}

export interface FolderOp {
  op: 'read' | 'create' | 'modify' | 'delete' | 'rename' | 'download' | 'mkdir';
  path?: string;
  from?: string;
  to?: string;
  url?: string;
}

export interface AiFolderPlan {
  operations: FolderOp[];
  filesToRead: string[];
  filesToCreate: string[];
  plan: string;
  tokensUsed: { input: number; output: number };
}

export function useAiFolderPlan() {
  const { clientId } = useClientContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiFolderPlan | null>(null);

  const plan = useCallback(async (
    folderPath: string,
    instruction: string,
    modelId: string,
  ): Promise<AiFolderPlan | null> => {
    if (!clientId) return null;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiFetch<{ data: AiFolderPlan }>(
        `/api/v1/clients/${clientId}/ai/edit`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'folder-plan',
            folder_path: folderPath,
            instruction,
            model_id: modelId,
          }),
        },
      );
      setResult(response.data);
      return response.data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Planning failed');
      return null;
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  const clear = useCallback(() => { setResult(null); setError(null); }, []);

  return { plan, loading, error, result, clear };
}

export function useAiFolderExecute() {
  const { clientId } = useClientContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changes: AiEditChange[]; tokensUsed: { input: number; output: number } } | null>(null);

  const execute = useCallback(async (
    folderPath: string,
    instruction: string,
    modelId: string,
    operations: FolderOp[],
    plan: string,
  ) => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiFetch<{ data: { changes: AiEditChange[]; tokensUsed: { input: number; output: number } } }>(
        `/api/v1/clients/${clientId}/ai/edit`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'folder-execute',
            folder_path: folderPath,
            instruction,
            model_id: modelId,
            operations,
            plan,
          }),
        },
      );
      setResult(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  const clear = useCallback(() => { setResult(null); setError(null); }, []);

  return { execute, loading, error, result, clear };
}

export function useAiFolderEdit(deploymentId: string) {
  const { clientId } = useClientContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changes: AiEditChange[]; tokensUsed: { input: number; output: number }; planSummary?: string } | null>(null);

  const edit = useCallback(async (
    folderPath: string,
    instruction: string,
    modelId: string,
  ) => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiFetch<{ data: AiEditResponse }>(
        `/api/v1/clients/${clientId}/ai/edit`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'folder',
            ...(deploymentId ? { deployment_id: deploymentId } : {}),
            folder_path: folderPath,
            instruction,
            model_id: modelId,
          }),
        },
      );
      setResult({
        changes: response.data.changes,
        tokensUsed: response.data.tokensUsed,
        planSummary: response.data.planSummary,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI edit failed');
    } finally {
      setLoading(false);
    }
  }, [clientId, deploymentId]);

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { edit, loading, error, result, clear };
}
