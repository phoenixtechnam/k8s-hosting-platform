import { useState } from 'react';
import { ArrowLeft, Plus, Trash2, TestTube, CheckCircle, XCircle, Loader2, Power, PowerOff, Pencil } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useAiProviders, useCreateAiProvider, useUpdateAiProvider, useDeleteAiProvider,
  useAiModels, useCreateAiModel, useUpdateAiModel, useDeleteAiModel,
  useTestAiConnection,
} from '@/hooks/use-ai-settings';

const PROVIDER_TYPES = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'openai_compatible', label: 'OpenAI-Compatible (Custom)' },
] as const;

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function AiSettings() {
  const [activeTab, setActiveTab] = useState<'providers' | 'models'>('providers');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Settings</h1>
      </div>

      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {(['providers', 'models'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700'
            }`}
          >
            {tab === 'providers' ? 'Providers' : 'Models'}
          </button>
        ))}
      </div>

      {activeTab === 'providers' ? <ProvidersTab /> : <ModelsTab />}
    </div>
  );
}

function ProvidersTab() {
  const { data, isLoading } = useAiProviders();
  const createProvider = useCreateAiProvider();
  const updateProvider = useUpdateAiProvider();
  const deleteProvider = useDeleteAiProvider();
  const testConnection = useTestAiConnection();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ id: '', type: 'anthropic' as string, display_name: '', base_url: '', api_key: '' });
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string } | null>>({});

  const providers = data?.data ?? [];

  const handleAdd = () => {
    createProvider.mutate({
      id: form.id,
      type: form.type,
      display_name: form.display_name,
      base_url: form.type === 'openai_compatible' ? form.base_url : undefined,
      api_key: form.api_key || undefined,
    }, {
      onSuccess: () => { setShowAdd(false); setForm({ id: '', type: 'anthropic', display_name: '', base_url: '', api_key: '' }); },
    });
  };

  const handleTest = (providerId: string) => {
    setTestResult((prev) => ({ ...prev, [providerId]: null }));
    testConnection.mutate({ provider_id: providerId }, {
      onSuccess: (r) => setTestResult((prev) => ({ ...prev, [providerId]: r.data })),
      onError: (err) => setTestResult((prev) => ({ ...prev, [providerId]: { success: false, message: err instanceof Error ? err.message : 'Failed' } })),
    });
  };

  return (
    <div className="space-y-4">
      {isLoading && <div className="flex items-center gap-2 py-8"><Loader2 size={20} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500">Loading...</span></div>}

      {providers.map((p) => (
        <div key={p.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.displayName}</h3>
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{p.type}</span>
                {p.enabled ? (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Active</span>
                ) : (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">Disabled</span>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                ID: {p.id} {p.baseUrl && `| ${p.baseUrl}`} | API Key: {p.apiKeySet ? 'Set' : 'Not set'}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => handleTest(p.id)} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title="Test connection">
                {testConnection.isPending && testConnection.variables?.provider_id === p.id ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
              </button>
              <button onClick={() => updateProvider.mutate({ id: p.id, enabled: !p.enabled })} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title={p.enabled ? 'Disable' : 'Enable'}>
                {p.enabled ? <PowerOff size={14} /> : <Power size={14} />}
              </button>
              <button onClick={() => { if (confirm(`Delete provider "${p.displayName}"?`)) deleteProvider.mutate(p.id); }} className="rounded p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {testResult[p.id] && (
            <div className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${
              testResult[p.id]!.success ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
            }`}>
              {testResult[p.id]!.success ? <CheckCircle size={12} /> : <XCircle size={12} />}
              {testResult[p.id]!.message}
            </div>
          )}
        </div>
      ))}

      {providers.length === 0 && !isLoading && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No AI providers configured. Add one to enable AI editing.
        </div>
      )}

      {showAdd ? (
        <div className="rounded-xl border border-brand-200 dark:border-brand-700 bg-brand-50/50 dark:bg-brand-900/10 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Provider</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">ID (slug)</label>
              <input className={INPUT_CLASS} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="anthropic-main" />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Type</label>
              <select className={INPUT_CLASS} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {PROVIDER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Display Name</label>
              <input className={INPUT_CLASS} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Anthropic Claude" />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">API Key</label>
              <input className={INPUT_CLASS} type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-..." />
            </div>
            {form.type === 'openai_compatible' && (
              <div className="col-span-2">
                <label className="text-xs text-gray-500 dark:text-gray-400">Base URL</label>
                <input className={INPUT_CLASS} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://ollama.internal:11434/v1" />
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            <button onClick={handleAdd} disabled={!form.id || !form.display_name || createProvider.isPending}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
              {createProvider.isPending ? 'Adding...' : 'Add Provider'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">
          <Plus size={16} /> Add Provider
        </button>
      )}
    </div>
  );
}

function ModelsTab() {
  const { data: providersData } = useAiProviders();
  const { data, isLoading } = useAiModels();
  const createModel = useCreateAiModel();
  const updateModel = useUpdateAiModel();
  const deleteModel = useDeleteAiModel();
  const testConnection = useTestAiConnection();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ id: '', provider_id: '', model_name: '', display_name: '', cost_input: '0', cost_output: '0', max_tokens: '4096' });
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string } | null>>({});

  const models = data?.data ?? [];
  const providers = providersData?.data ?? [];

  const handleAdd = () => {
    createModel.mutate({
      id: form.id,
      provider_id: form.provider_id,
      model_name: form.model_name,
      display_name: form.display_name,
      cost_per_1m_input_tokens: parseFloat(form.cost_input) || 0,
      cost_per_1m_output_tokens: parseFloat(form.cost_output) || 0,
      max_output_tokens: parseInt(form.max_tokens) || 4096,
    }, {
      onSuccess: () => { setShowAdd(false); setForm({ id: '', provider_id: '', model_name: '', display_name: '', cost_input: '0', cost_output: '0', max_tokens: '4096' }); },
    });
  };

  const handleTest = (model: { id: string; providerId: string }) => {
    setTestResult((prev) => ({ ...prev, [model.id]: null }));
    testConnection.mutate({ provider_id: model.providerId, model_id: model.id }, {
      onSuccess: (r) => setTestResult((prev) => ({ ...prev, [model.id]: r.data })),
      onError: (err) => setTestResult((prev) => ({ ...prev, [model.id]: { success: false, message: err instanceof Error ? err.message : 'Failed' } })),
    });
  };

  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  return (
    <div className="space-y-4">
      {isLoading && <div className="flex items-center gap-2 py-8"><Loader2 size={20} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500">Loading...</span></div>}

      {models.map((m) => (
        <div key={m.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.displayName}</h3>
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{providerName(m.providerId)}</span>
                {m.enabled ? (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Active</span>
                ) : (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">Disabled</span>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Model: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{m.modelName}</code> |
                Cost: ${m.costPer1mInputTokens}/M in, ${m.costPer1mOutputTokens}/M out |
                Max tokens: {m.maxOutputTokens}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => handleTest(m)} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title="Test">
                <TestTube size={14} />
              </button>
              <button onClick={() => updateModel.mutate({ id: m.id, enabled: !m.enabled })} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" title={m.enabled ? 'Disable' : 'Enable'}>
                {m.enabled ? <PowerOff size={14} /> : <Power size={14} />}
              </button>
              <button onClick={() => { if (confirm(`Delete model "${m.displayName}"?`)) deleteModel.mutate(m.id); }} className="rounded p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {testResult[m.id] && (
            <div className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${
              testResult[m.id]!.success ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
            }`}>
              {testResult[m.id]!.success ? <CheckCircle size={12} /> : <XCircle size={12} />}
              {testResult[m.id]!.message}
            </div>
          )}
        </div>
      ))}

      {models.length === 0 && !isLoading && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No AI models configured. Add a provider first, then add models.
        </div>
      )}

      {showAdd ? (
        <div className="rounded-xl border border-brand-200 dark:border-brand-700 bg-brand-50/50 dark:bg-brand-900/10 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Model</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">ID (slug)</label>
              <input className={INPUT_CLASS} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="claude-sonnet" />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Provider</label>
              <select className={INPUT_CLASS} value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}>
                <option value="">Select provider</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Model Name (API)</label>
              <input className={INPUT_CLASS} value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} placeholder="claude-sonnet-4-5" />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Display Name</label>
              <input className={INPUT_CLASS} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Claude Sonnet 4.5" />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Cost/1M input tokens ($)</label>
              <input className={INPUT_CLASS} type="number" step="0.01" value={form.cost_input} onChange={(e) => setForm({ ...form, cost_input: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Cost/1M output tokens ($)</label>
              <input className={INPUT_CLASS} type="number" step="0.01" value={form.cost_output} onChange={(e) => setForm({ ...form, cost_output: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Max output tokens</label>
              <input className={INPUT_CLASS} type="number" value={form.max_tokens} onChange={(e) => setForm({ ...form, max_tokens: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            <button onClick={handleAdd} disabled={!form.id || !form.provider_id || !form.model_name || !form.display_name || createModel.isPending}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
              {createModel.isPending ? 'Adding...' : 'Add Model'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} disabled={providers.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50">
          <Plus size={16} /> Add Model
        </button>
      )}
    </div>
  );
}
