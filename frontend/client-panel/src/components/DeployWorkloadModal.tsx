import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { X, Loader2, Search, Rocket, Globe, CheckCircle, AlertCircle, AlertTriangle, Info, FolderOpen } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useCatalog, useCatalogEntryVersions } from '@/hooks/use-catalog';
import { useCreateDeployment, useStorageFolders } from '@/hooks/use-deployments';
import { useDomains } from '@/hooks/use-domains';
import type { CatalogEntry } from '@/types/api';
import ParameterForm from './ParameterForm';
import ResourceRequirementCheck from './ResourceRequirementCheck';

interface DeployWorkloadModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly preSelectedImageId?: string | null;
  readonly onSuccess?: () => void;
  readonly existingNames?: readonly string[];
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const DNS_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export default function DeployWorkloadModal({ open, onClose, preSelectedImageId, onSuccess, existingNames = [] }: DeployWorkloadModalProps) {
  const { clientId } = useClientContext();
  const { data: catalogData } = useCatalog();
  const { data: domainsData } = useDomains(clientId ?? undefined);
  const createDeployment = useCreateDeployment(clientId ?? undefined);

  const [imageSearch, setImageSearch] = useState('');
  const [selectedImageId, setSelectedImageId] = useState<string>(preSelectedImageId ?? '');

  useEffect(() => {
    if (preSelectedImageId) {
      setSelectedImageId(preSelectedImageId);
    }
  }, [preSelectedImageId]);

  const [name, setName] = useState('');
  const [cpuRequest, setCpuRequest] = useState('100m');
  const [memoryRequest, setMemoryRequest] = useState('128Mi');
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [storageMode, setStorageMode] = useState<'default' | 'custom'>('default');
  const [customFolderName, setCustomFolderName] = useState('');
  const [selectedExistingFolder, setSelectedExistingFolder] = useState<string | null>(null);
  const [deployState, setDeployState] = useState<'form' | 'deploying' | 'success' | 'error'>('form');
  const [resourcesFit, setResourcesFit] = useState(true);

  const images = catalogData?.data ?? [];
  const domains = domainsData?.data ?? [];

  const selectedImage = useMemo(() => images.find(i => i.id === selectedImageId), [images, selectedImageId]);

  const { data: storageFoldersData, isLoading: storageFoldersLoading } = useStorageFolders(
    clientId ?? undefined,
    selectedImage?.type,
    selectedImage?.code,
  );
  const storageFolders = storageFoldersData?.data;

  const nameError = useMemo(() => {
    if (!name) return null;
    if (!DNS_NAME_PATTERN.test(name)) {
      return 'Name must be DNS-compatible: lowercase letters, digits, and hyphens only (max 63 chars)';
    }
    return null;
  }, [name]);

  const customFolderNameError = useMemo(() => {
    if (!customFolderName) return null;
    if (!DNS_NAME_PATTERN.test(customFolderName)) {
      return 'Folder name must be DNS-compatible: lowercase letters, digits, and hyphens only (max 63 chars)';
    }
    return null;
  }, [customFolderName]);

  const selectedResources = selectedImage?.resources as { minimum?: { cpu?: string; memory?: string; storage?: string } } | null;
  const minCpu = selectedResources?.minimum?.cpu;
  const minMemory = selectedResources?.minimum?.memory;
  const minStorage = selectedResources?.minimum?.storage;

  // ─── Min resource validation against user input ───────────────────────────
  const resourceError = useMemo(() => {
    if (!selectedImageId) return null;
    const effectiveMinCpu = minCpu ?? '0.05';
    const effectiveMinMemory = minMemory ?? '64Mi';

    const parseCpuValue = (v: string): number => {
      const trimmed = v.trim();
      if (trimmed.endsWith('m')) return Number(trimmed.slice(0, -1)) / 1000;
      return Number(trimmed) || 0;
    };
    const parseMemoryMi = (v: string): number => {
      const trimmed = v.trim();
      if (trimmed.endsWith('Gi')) return Number(trimmed.slice(0, -2)) * 1024;
      if (trimmed.endsWith('Mi')) return Number(trimmed.slice(0, -2));
      if (trimmed.endsWith('Ki')) return Number(trimmed.slice(0, -2)) / 1024;
      return Number(trimmed) || 0;
    };

    const cpuTooLow = parseCpuValue(cpuRequest) < parseCpuValue(effectiveMinCpu);
    const memoryTooLow = parseMemoryMi(memoryRequest) < parseMemoryMi(effectiveMinMemory);

    if (cpuTooLow) return `Minimum CPU: ${effectiveMinCpu}`;
    if (memoryTooLow) return `Minimum memory: ${effectiveMinMemory}`;
    return null;
  }, [selectedImageId, minCpu, minMemory, cpuRequest, memoryRequest]);

  // Reset resourcesFit when selected image changes
  useEffect(() => {
    setResourcesFit(true);
  }, [selectedImageId]);

  // Fetch versions when an image is selected
  const { data: versionsData } = useCatalogEntryVersions(selectedImageId || undefined);
  const versions = versionsData?.data ?? [];

  // Set default version when versions load
  useEffect(() => {
    if (versions.length > 0) {
      const defaultVer = versions.find(v => v.isDefault === 1);
      setSelectedVersion(defaultVer ? defaultVer.version : versions[0].version);
    } else {
      setSelectedVersion('');
    }
  }, [versions]);

  // Initialize parameter values when image is selected
  useEffect(() => {
    if (selectedImage?.parameters) {
      const initial: Record<string, unknown> = {};
      for (const p of selectedImage.parameters as Array<{ key: string; default?: unknown }>) {
        if (p.default !== undefined) initial[p.key] = p.default;
      }
      setParamValues(initial);
    } else {
      setParamValues({});
    }
  }, [selectedImage]);

  const filteredImages = useMemo(() => {
    if (!imageSearch.trim()) return images;
    const term = imageSearch.toLowerCase();
    return images.filter(
      i => i.name.toLowerCase().includes(term) || i.code.toLowerCase().includes(term),
    );
  }, [images, imageSearch]);

  const parameters = useMemo(() => {
    if (!selectedImage?.parameters) return [];
    return selectedImage.parameters as Array<{
      key: string; label: string; type: string;
      default?: unknown; required?: boolean; description?: string;
    }>;
  }, [selectedImage]);

  const hasRequiredMissing = useMemo(() => {
    return parameters.some(p => {
      if (!p.required) return false;
      const val = paramValues[p.key];
      return val === undefined || val === '' || val === null;
    });
  }, [parameters, paramValues]);

  const handleSelectImage = (img: CatalogEntry) => {
    setSelectedImageId(img.id);
    if (!name) {
      const baseName = img.code.replace(/[^a-z0-9-]/g, '-').slice(0, 50);
      const nameSet = new Set(existingNames);
      let candidate = baseName;
      let suffix = 2;
      while (nameSet.has(candidate)) {
        candidate = `${baseName}-${suffix}`;
        suffix++;
      }
      setName(candidate);
    }
    if (img.resources?.recommended?.cpu) setCpuRequest(img.resources.recommended.cpu);
    if (img.resources?.recommended?.memory) setMemoryRequest(img.resources.recommended.memory);
  };

  const resetForm = () => {
    setImageSearch('');
    setSelectedImageId(preSelectedImageId ?? '');
    setName('');
    setCpuRequest('100m');
    setMemoryRequest('128Mi');
    setSelectedDomainId('');
    setSelectedVersion('');
    setParamValues({});
    setStorageMode('default');
    setCustomFolderName('');
    setSelectedExistingFolder(null);
    setDeployState('form');
    createDeployment.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedImageId || !name || !clientId) return;

    setDeployState('deploying');
    try {
      await createDeployment.mutateAsync({
        catalog_entry_id: selectedImageId,
        name: name.trim(),
        cpu_request: cpuRequest,
        memory_request: memoryRequest,
        configuration: Object.keys(paramValues).length > 0 ? paramValues : undefined,
        version: selectedVersion || undefined,
        storage_mode: storageMode,
        storage_path: storageMode === 'custom'
          ? (selectedExistingFolder ?? `${selectedImage?.type}/${selectedImage?.code}/${customFolderName}`)
          : undefined,
      });
      setDeployState('success');
    } catch {
      setDeployState('error');
    }
  };

  const handleParamChange = (key: string, value: unknown) => {
    setParamValues(prev => ({ ...prev, [key]: value }));
  };

  if (!open) return null;

  // Deploying state
  if (deployState === 'deploying') {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" data-testid="deploy-workload-modal">
        <div className="fixed inset-0 bg-black/50" />
        <div className="relative my-8 w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Rocket size={20} className="text-blue-600" />
              Deploy a Workload
            </h2>
          </div>
          <div className="flex flex-col items-center justify-center py-20 px-6">
            <Loader2 size={40} className="animate-spin text-blue-600 mb-4" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Deploying {name}...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Success state
  if (deployState === 'success') {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" data-testid="deploy-workload-modal">
        <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
        <div className="relative my-8 w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Rocket size={20} className="text-blue-600" />
              Deploy a Workload
            </h2>
            <button onClick={handleClose} className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={20} />
            </button>
          </div>
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <CheckCircle size={48} className="text-green-500 mb-4" />
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Deployed successfully!
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
              Your workload <span className="font-medium text-gray-700 dark:text-gray-300">{name}</span> is now being provisioned.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  onSuccess?.();
                  handleClose();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                View Installed Apps
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              >
                Deploy Another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (deployState === 'error') {
    const errorMessage = createDeployment.error instanceof Error
      ? createDeployment.error.message
      : 'Deployment failed. Please try again.';

    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" data-testid="deploy-workload-modal">
        <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
        <div className="relative my-8 w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Rocket size={20} className="text-blue-600" />
              Deploy a Workload
            </h2>
            <button onClick={handleClose} className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={20} />
            </button>
          </div>
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <AlertCircle size={48} className="text-red-500 mb-4" />
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Deployment Failed
            </p>
            <p className="text-sm text-red-600 dark:text-red-400 mb-8 text-center max-w-md">
              {errorMessage}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setDeployState('form');
                  createDeployment.reset();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Form state (default)
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" data-testid="deploy-workload-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative my-8 w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Rocket size={20} className="text-blue-600" />
            Deploy a Workload
          </h2>
          <button onClick={handleClose} className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Step 1: Select Image */}
          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              1. Select a Workload Image
            </label>
            {selectedImage ? (
              <div className="flex items-center justify-between rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{selectedImage.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{selectedImage.code} {selectedImage.version ? `v${selectedImage.version}` : ''}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setSelectedImageId(''); setName(''); setSelectedVersion(''); setParamValues({}); }}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="search"
                    value={imageSearch}
                    onChange={(e) => setImageSearch(e.target.value)}
                    placeholder="Search images..."
                    className={`${INPUT_CLASS} pl-9`}
                    data-testid="image-search-input"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                  {filteredImages.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No images found.</p>
                  ) : (
                    filteredImages.map(img => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => handleSelectImage(img)}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                        data-testid={`image-option-${img.code}`}
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{img.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{img.type} {img.version ? `· v${img.version}` : ''}</p>
                        </div>
                        <span className="text-xs text-gray-400">{img.code}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Step 1b: Version Selector */}
          {selectedImageId && versions.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Version
              </label>
              <select
                value={selectedVersion}
                onChange={(e) => setSelectedVersion(e.target.value)}
                className={INPUT_CLASS}
                data-testid="deploy-version-select"
              >
                {versions.map(v => {
                  const isEol = v.eolDate && new Date(v.eolDate) <= new Date();
                  const isDeprecated = v.status === 'deprecated';
                  let suffix = '';
                  if (isEol) suffix = ' (EOL)';
                  else if (isDeprecated) suffix = ' (deprecated)';
                  return (
                    <option key={v.id} value={v.version}>
                      {v.version}{v.isDefault === 1 ? ' (default)' : ''}{suffix}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Resource availability check */}
          {selectedImageId && (
            <ResourceRequirementCheck
              minimumCpu={minCpu}
              minimumMemory={minMemory}
              minimumStorage={minStorage}
              onFitsChange={setResourcesFit}
            />
          )}

          {/* Step 2: Configure */}
          {selectedImageId && (
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                2. Configure
              </label>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Name *</label>
                  <input
                    type="text"
                    required
                    maxLength={63}
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    className={INPUT_CLASS}
                    placeholder="my-workload"
                    data-testid="deploy-name-input"
                  />
                  {nameError && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{nameError}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">CPU Request</label>
                  <input
                    type="text"
                    value={cpuRequest}
                    onChange={(e) => setCpuRequest(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="100m"
                    data-testid="deploy-cpu-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Memory Request</label>
                  <input
                    type="text"
                    value={memoryRequest}
                    onChange={(e) => setMemoryRequest(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="128Mi"
                    data-testid="deploy-memory-input"
                  />
                </div>
              </div>
              {resourceError && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400" data-testid="resource-min-warning">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>{resourceError}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2b: Parameters */}
          {selectedImageId && parameters.length > 0 && (
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                Parameters
              </label>
              <ParameterForm
                parameters={parameters}
                values={paramValues}
                onChange={handleParamChange}
              />
            </div>
          )}

          {/* Step 3: Storage Folder */}
          {selectedImageId && (
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                3. Storage Folder
              </label>
              <select
                value={storageMode}
                onChange={(e) => {
                  const mode = e.target.value as 'default' | 'custom';
                  setStorageMode(mode);
                  setCustomFolderName('');
                  setSelectedExistingFolder(null);
                }}
                className={INPUT_CLASS}
                data-testid="deploy-storage-mode-select"
              >
                <option value="default">Use Default Path</option>
                <option value="custom">Use Custom Folder</option>
              </select>

              {storageMode === 'default' && (
                <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2">
                  <p className="text-sm text-gray-600 dark:text-gray-400 font-mono">
                    /{selectedImage?.type}/{selectedImage?.code}/{name || '...'}/
                  </p>
                </div>
              )}

              {storageMode === 'custom' && (
                <div className="mt-3 space-y-3">
                  {storageFoldersLoading ? (
                    <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
                      <Loader2 size={14} className="animate-spin" />
                      Loading existing folders...
                    </div>
                  ) : (
                    <>
                      {/* Existing folders list */}
                      {storageFolders && storageFolders.folders.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Existing folders</p>
                          {storageFolders.folders.map(folder => {
                            const inUse = folder.usedByDeployment !== null;
                            const isSelected = selectedExistingFolder === folder.path;
                            const label = inUse
                              ? `(in use by: ${folder.usedByDeployment})`
                              : folder.isEmpty
                                ? '(unused - empty)'
                                : '(unused - has data)';
                            return (
                              <button
                                key={folder.path}
                                type="button"
                                disabled={inUse}
                                onClick={() => {
                                  setSelectedExistingFolder(isSelected ? null : folder.path);
                                  setCustomFolderName('');
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                                  inUse
                                    ? 'opacity-50 cursor-not-allowed border-gray-200 dark:border-gray-700'
                                    : isSelected
                                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 cursor-pointer'
                                      : 'border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50'
                                }`}
                                data-testid={`storage-folder-${folder.name}`}
                              >
                                <FolderOpen size={14} className={`shrink-0 ${inUse ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-400'}`} />
                                <span className={`font-medium ${inUse ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                                  {folder.name}
                                </span>
                                <span className={`text-xs ${inUse ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}>
                                  {label}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Info banner for non-empty existing folder selection */}
                      {selectedExistingFolder && storageFolders?.folders.some(f => f.path === selectedExistingFolder && !f.isEmpty) && (
                        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
                          <Info size={14} className="shrink-0" />
                          Existing folder contents will be used for this deployment.
                        </div>
                      )}

                      {/* New folder name input */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                          Or create a new folder
                        </label>
                        <div className="flex items-center gap-1.5">
                          {storageFolders?.basePath && (
                            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">
                              {storageFolders.basePath}/
                            </span>
                          )}
                          <input
                            type="text"
                            maxLength={63}
                            value={customFolderName}
                            onChange={(e) => {
                              setCustomFolderName(e.target.value.toLowerCase());
                              setSelectedExistingFolder(null);
                            }}
                            className={INPUT_CLASS}
                            placeholder="my-folder"
                            data-testid="deploy-custom-folder-input"
                          />
                        </div>
                        {customFolderNameError && (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{customFolderNameError}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Connect Domain */}
          {selectedImageId && (
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                4. Connect a Domain
              </label>
              {domains.length > 0 ? (
                <div>
                  <select
                    value={selectedDomainId}
                    onChange={(e) => setSelectedDomainId(e.target.value)}
                    className={INPUT_CLASS}
                    data-testid="deploy-domain-select"
                  >
                    <option value="">Connect a Domain Later</option>
                    {domains.map(d => (
                      <option key={d.id} value={d.id}>
                        <Globe size={12} /> {d.domainName} ({d.dnsMode})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {selectedDomainId
                      ? 'An ingress route will be created to connect this domain to your workload.'
                      : 'You can connect a domain later from the domain\'s Routing tab.'}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 italic rounded-lg bg-gray-50 dark:bg-gray-900 px-4 py-3">
                  No domains available. Add a domain first, or connect one later from the Routing tab.
                </p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!clientId || !selectedImageId || !name || !!nameError || createDeployment.isPending || hasRequiredMissing || !resourcesFit || !!resourceError || !!customFolderNameError || (storageMode === 'custom' && !selectedExistingFolder && !customFolderName)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="deploy-submit-button"
            >
              {createDeployment.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              Deploy
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
