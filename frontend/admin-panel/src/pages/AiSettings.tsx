import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Trash2, CheckCircle, XCircle, Loader2, Power, PowerOff, Pencil, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useAiProviders, useCreateAiProvider, useUpdateAiProvider, useDeleteAiProvider,
  useAiModels, useCreateAiModel, useUpdateAiModel, useDeleteAiModel,
  useTestAiConnection,
} from '@/hooks/use-ai-settings';

// ─── Known providers + models (pre-populated dropdowns) ────────────────────

const KNOWN_PROVIDERS = [
  { type: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-...' },
  { type: 'openai', name: 'OpenAI', placeholder: 'sk-...' },
  { type: 'openai_compatible', name: 'OpenAI-Compatible (Custom)', placeholder: 'API key (optional)' },
] as const;

const KNOWN_MODELS: Record<string, Array<{ name: string; displayName: string; costIn: number; costOut: number; maxTokens: number }>> = {
  anthropic: [
    { name: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', costIn: 0.80, costOut: 4.00, maxTokens: 8192 },
    { name: 'claude-sonnet-4-5-20250514', displayName: 'Claude Sonnet 4.5', costIn: 3.00, costOut: 15.00, maxTokens: 8192 },
    { name: 'claude-opus-4-5-20250514', displayName: 'Claude Opus 4.5', costIn: 15.00, costOut: 75.00, maxTokens: 16384 },
    { name: 'claude-sonnet-4-6-20250627', displayName: 'Claude Sonnet 4.6', costIn: 3.00, costOut: 15.00, maxTokens: 8192 },
    { name: 'claude-opus-4-6-20250715', displayName: 'Claude Opus 4.6', costIn: 15.00, costOut: 75.00, maxTokens: 16384 },
  ],
  openai: [
    { name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', costIn: 0.15, costOut: 0.60, maxTokens: 4096 },
    { name: 'gpt-4o', displayName: 'GPT-4o', costIn: 2.50, costOut: 10.00, maxTokens: 8192 },
    { name: 'gpt-4.1', displayName: 'GPT-4.1', costIn: 2.00, costOut: 8.00, maxTokens: 16384 },
    { name: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', costIn: 0.40, costOut: 1.60, maxTokens: 8192 },
    { name: 'gpt-4.1-nano', displayName: 'GPT-4.1 Nano', costIn: 0.10, costOut: 0.40, maxTokens: 4096 },
    { name: 'o3-mini', displayName: 'o3-mini', costIn: 1.10, costOut: 4.40, maxTokens: 16384 },
  ],
  openai_compatible: [],
};

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
const INPUT_ERROR_CLASS = 'w-full rounded-lg border border-red-400 dark:border-red-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500';

interface FormData {
  providerType: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  modelDisplayName: string;
  costInput: string;
  costOutput: string;
  maxTokens: string;
}

const EMPTY_FORM: FormData = {
  providerType: 'anthropic',
  displayName: '',
  apiKey: '',
  baseUrl: '',
  modelName: '',
  modelDisplayName: '',
  costInput: '0',
  costOutput: '0',
  maxTokens: '4096',
};

interface FormErrors {
  displayName?: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  modelDisplayName?: string;
}

function validateForm(form: FormData): FormErrors {
  const errors: FormErrors = {};
  if (!form.displayName.trim()) errors.displayName = 'Required';
  if (form.providerType !== 'openai_compatible' && !form.apiKey.trim()) errors.apiKey = 'API key is required';
  if (form.providerType === 'openai_compatible' && !form.baseUrl.trim()) errors.baseUrl = 'Base URL is required for custom providers';
  if (!form.modelName.trim()) errors.modelName = 'Model name is required';
  if (!form.modelDisplayName.trim()) errors.modelDisplayName = 'Display name is required';
  return errors;
}

export default function AiSettings() {
  const { data: providersData, isLoading: providersLoading } = useAiProviders();
  const { data: modelsData, isLoading: modelsLoading } = useAiModels();
  const createProvider = useCreateAiProvider();
  const updateProvider = useUpdateAiProvider();
  const deleteProvider = useDeleteAiProvider();
  const createModel = useCreateAiModel();
  const updateModel = useUpdateAiModel();
  const deleteModel = useDeleteAiModel();
  const testConnection = useTestAiConnection();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormData>({ ...EMPTY_FORM });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const providers = providersData?.data ?? [];
  const models = modelsData?.data ?? [];
  const isLoading = providersLoading || modelsLoading;

  // Build a unified view: each model + its provider
  const entries = models.map((m) => {
    const provider = providers.find((p) => p.id === m.providerId);
    return { model: m, provider };
  });

  const handleSelectKnownModel = (modelName: string) => {
    const known = KNOWN_MODELS[form.providerType]?.find((m) => m.name === modelName);
    if (known) {
      setForm((f) => ({
        ...f,
        modelName: known.name,
        modelDisplayName: known.displayName,
        costInput: String(known.costIn),
        costOutput: String(known.costOut),
        maxTokens: String(known.maxTokens),
      }));
    }
  };

  const handleProviderTypeChange = (type: string) => {
    const known = KNOWN_PROVIDERS.find((p) => p.type === type);
    setForm((f) => ({
      ...f,
      providerType: type,
      displayName: f.displayName || known?.name || '',
      modelName: '',
      modelDisplayName: '',
      costInput: '0',
      costOutput: '0',
    }));
  };

  const handleEdit = (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    const provider = providers.find((p) => p.id === model?.providerId);
    if (!model || !provider) return;
    setEditingId(modelId);
    setShowAdd(true);
    setSaveStatus(null);
    setErrors({});
    setForm({
      providerType: provider.type,
      displayName: provider.displayName,
      apiKey: '',
      baseUrl: provider.baseUrl ?? '',
      modelName: model.modelName,
      modelDisplayName: model.displayName,
      costInput: String(model.costPer1mInputTokens),
      costOutput: String(model.costPer1mOutputTokens),
      maxTokens: String(model.maxOutputTokens),
    });
  };

  const handleSave = async () => {
    const validationErrors = validateForm(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setSaving(true);
    setSaveStatus(null);

    try {
      const providerSlug = form.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      const modelSlug = form.modelDisplayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

      if (editingId) {
        // Update existing
        const model = models.find((m) => m.id === editingId);
        if (model) {
          await updateProvider.mutateAsync({
            id: model.providerId,
            display_name: form.displayName,
            ...(form.apiKey ? { api_key: form.apiKey } : {}),
            ...(form.providerType === 'openai_compatible' ? { base_url: form.baseUrl } : {}),
          });
          await updateModel.mutateAsync({
            id: editingId,
            display_name: form.modelDisplayName,
            cost_per_1m_input_tokens: parseFloat(form.costInput) || 0,
            cost_per_1m_output_tokens: parseFloat(form.costOutput) || 0,
            max_output_tokens: parseInt(form.maxTokens) || 4096,
          });
        }
      } else {
        // Create new
        await createProvider.mutateAsync({
          id: providerSlug,
          type: form.providerType,
          display_name: form.displayName,
          base_url: form.providerType === 'openai_compatible' ? form.baseUrl : undefined,
          api_key: form.apiKey || undefined,
        });
        await createModel.mutateAsync({
          id: modelSlug,
          provider_id: providerSlug,
          model_name: form.modelName,
          display_name: form.modelDisplayName,
          cost_per_1m_input_tokens: parseFloat(form.costInput) || 0,
          cost_per_1m_output_tokens: parseFloat(form.costOutput) || 0,
          max_output_tokens: parseInt(form.maxTokens) || 4096,
        });
      }

      // Test connection
      const testResult = await testConnection.mutateAsync({
        provider_id: editingId ? models.find((m) => m.id === editingId)?.providerId ?? providerSlug : providerSlug,
        model_id: editingId ?? modelSlug,
      });

      if (testResult.data.success) {
        setSaveStatus({ type: 'success', message: `Saved and verified (${testResult.data.latencyMs}ms)` });
        setTimeout(() => { setShowAdd(false); setEditingId(null); setForm({ ...EMPTY_FORM }); setSaveStatus(null); }, 1500);
      } else {
        setSaveStatus({ type: 'error', message: `Saved but connection test failed: ${testResult.data.message}` });
      }
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (!model || !confirm(`Delete "${model.displayName}"? This will also remove the provider if no other models use it.`)) return;

    await deleteModel.mutateAsync(modelId);
    // If no other models use this provider, delete the provider too
    const siblingModels = models.filter((m) => m.providerId === model.providerId && m.id !== modelId);
    if (siblingModels.length === 0) {
      await deleteProvider.mutateAsync(model.providerId);
    }
  };

  const knownModelsForType = KNOWN_MODELS[form.providerType] ?? [];
  const providerPlaceholder = KNOWN_PROVIDERS.find((p) => p.type === form.providerType)?.placeholder ?? 'API key';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure AI providers and models for the code editor</p>
        </div>
      </div>

      {isLoading && <div className="flex items-center gap-2 py-8"><Loader2 size={20} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500">Loading...</span></div>}

      {/* Configured models (unified view) */}
      {entries.map(({ model: m, provider: p }) => (
        <div key={m.id}
          className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 cursor-pointer hover:border-brand-300 dark:hover:border-brand-600 transition-colors"
          onClick={() => handleEdit(m.id)}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.displayName}</h3>
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{p?.type ?? 'unknown'}</span>
                {m.enabled ? (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Active</span>
                ) : (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">Disabled</span>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Provider: {p?.displayName ?? '?'} | Model: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{m.modelName}</code> |
                ${m.costPer1mInputTokens}/M in, ${m.costPer1mOutputTokens}/M out
              </p>
            </div>
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => handleEdit(m.id)} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title="Edit">
                <Pencil size={14} />
              </button>
              <button onClick={() => updateModel.mutate({ id: m.id, enabled: !m.enabled })} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title={m.enabled ? 'Disable' : 'Enable'}>
                {m.enabled ? <PowerOff size={14} /> : <Power size={14} />}
              </button>
              <button onClick={() => handleDelete(m.id)} className="rounded p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      ))}

      {entries.length === 0 && !isLoading && !showAdd && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-8 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">No AI models configured</p>
          <p className="text-xs text-gray-400">Add a provider and model to enable AI editing in the file manager</p>
        </div>
      )}

      {/* Add / Edit form */}
      {showAdd ? (
        <div className="rounded-xl border border-brand-200 dark:border-brand-700 bg-brand-50/50 dark:bg-brand-900/10 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {editingId ? 'Edit AI Model' : 'Add AI Model'}
          </h3>

          {/* Provider type */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Provider</label>
            <select className={INPUT_CLASS} value={form.providerType} onChange={(e) => handleProviderTypeChange(e.target.value)} disabled={!!editingId}>
              {KNOWN_PROVIDERS.map((p) => <option key={p.type} value={p.type}>{p.name}</option>)}
            </select>
          </div>

          {/* Display name + API key */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Provider Name</label>
              <input className={errors.displayName ? INPUT_ERROR_CLASS : INPUT_CLASS} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="My Anthropic" />
              {errors.displayName && <p className="text-[10px] text-red-500 mt-0.5">{errors.displayName}</p>}
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">API Key {editingId && <span className="text-gray-400">(leave blank to keep current)</span>}</label>
              <input className={errors.apiKey ? INPUT_ERROR_CLASS : INPUT_CLASS} type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={providerPlaceholder} />
              {errors.apiKey && <p className="text-[10px] text-red-500 mt-0.5">{errors.apiKey}</p>}
            </div>
          </div>

          {/* Base URL for custom */}
          {form.providerType === 'openai_compatible' && (
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Base URL</label>
              <input className={errors.baseUrl ? INPUT_ERROR_CLASS : INPUT_CLASS} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://ollama.internal:11434/v1" />
              {errors.baseUrl && <p className="text-[10px] text-red-500 mt-0.5">{errors.baseUrl}</p>}
            </div>
          )}

          {/* Model selection */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Model</label>
            {knownModelsForType.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                <select className={INPUT_CLASS} value={form.modelName} onChange={(e) => handleSelectKnownModel(e.target.value)}>
                  <option value="">Select a model...</option>
                  {knownModelsForType.map((m) => <option key={m.name} value={m.name}>{m.displayName} — {m.name}</option>)}
                  <option value="__custom">Custom model name...</option>
                </select>
                <div>
                  <input className={errors.modelName ? INPUT_ERROR_CLASS : INPUT_CLASS} value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} placeholder="Model API name" />
                  {errors.modelName && <p className="text-[10px] text-red-500 mt-0.5">{errors.modelName}</p>}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <input className={errors.modelName ? INPUT_ERROR_CLASS : INPUT_CLASS} value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} placeholder="Model API name (e.g., llama3.1)" />
                  {errors.modelName && <p className="text-[10px] text-red-500 mt-0.5">{errors.modelName}</p>}
                </div>
                <div>
                  <input className={errors.modelDisplayName ? INPUT_ERROR_CLASS : INPUT_CLASS} value={form.modelDisplayName} onChange={(e) => setForm({ ...form, modelDisplayName: e.target.value })} placeholder="Display name" />
                  {errors.modelDisplayName && <p className="text-[10px] text-red-500 mt-0.5">{errors.modelDisplayName}</p>}
                </div>
              </div>
            )}
          </div>

          {/* Cost + max tokens (auto-filled from dropdown, editable) */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Cost/1M input ($)</label>
              <input className={INPUT_CLASS} type="number" step="0.01" min="0" value={form.costInput} onChange={(e) => setForm({ ...form, costInput: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Cost/1M output ($)</label>
              <input className={INPUT_CLASS} type="number" step="0.01" min="0" value={form.costOutput} onChange={(e) => setForm({ ...form, costOutput: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Max output tokens</label>
              <input className={INPUT_CLASS} type="number" min="256" max="65536" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
            </div>
          </div>

          {/* Save status */}
          {saveStatus && (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
              saveStatus.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
            }`}>
              {saveStatus.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {saveStatus.message}
            </div>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowAdd(false); setEditingId(null); setForm({ ...EMPTY_FORM }); setSaveStatus(null); setErrors({}); }}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
              {saving ? <><Loader2 size={14} className="animate-spin inline mr-1" /> Saving & Testing...</> : 'Save & Test'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setShowAdd(true); setEditingId(null); setForm({ ...EMPTY_FORM }); setSaveStatus(null); setErrors({}); }}
          className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">
          <Plus size={16} /> Add AI Model
        </button>
      )}
    </div>
  );
}
