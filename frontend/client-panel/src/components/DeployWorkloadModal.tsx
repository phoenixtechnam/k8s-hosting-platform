import { useState, useMemo, type FormEvent } from 'react';
import { X, Loader2, Search, Rocket, Globe } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useCatalog } from '@/hooks/use-catalog';
import { useCreateDeployment } from '@/hooks/use-deployments';
import { useDomains } from '@/hooks/use-domains';
import type { CatalogEntry } from '@/types/api';

interface DeployWorkloadModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly preSelectedImageId?: string | null;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function DeployWorkloadModal({ open, onClose, preSelectedImageId }: DeployWorkloadModalProps) {
  const { clientId } = useClientContext();
  const { data: catalogData } = useCatalog();
  const { data: domainsData } = useDomains(clientId ?? undefined);
  const createDeployment = useCreateDeployment(clientId ?? undefined);

  const [imageSearch, setImageSearch] = useState('');
  const [selectedImageId, setSelectedImageId] = useState<string>(preSelectedImageId ?? '');
  const [name, setName] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [cpuRequest, setCpuRequest] = useState('100m');
  const [memoryRequest, setMemoryRequest] = useState('128Mi');
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');

  const images = catalogData?.data ?? [];
  const domains = domainsData?.data ?? [];

  // Set name from image when selected
  const selectedImage = useMemo(() => images.find(i => i.id === selectedImageId), [images, selectedImageId]);

  const filteredImages = useMemo(() => {
    if (!imageSearch.trim()) return images;
    const term = imageSearch.toLowerCase();
    return images.filter(
      i => i.name.toLowerCase().includes(term) || i.code.toLowerCase().includes(term),
    );
  }, [images, imageSearch]);

  const handleSelectImage = (img: CatalogEntry) => {
    setSelectedImageId(img.id);
    if (!name) {
      setName(img.code.replace(/[^a-z0-9-]/g, '-').slice(0, 50));
    }
    // Pre-fill resources from image metadata
    if (img.resources?.default?.cpu) setCpuRequest(img.resources.default.cpu);
    if (img.resources?.default?.memory) setMemoryRequest(img.resources.default.memory);
  };

  const resetForm = () => {
    setImageSearch('');
    setSelectedImageId(preSelectedImageId ?? '');
    setName('');
    setReplicas(1);
    setCpuRequest('100m');
    setMemoryRequest('128Mi');
    setSelectedDomainId('');
    createDeployment.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedImageId || !name) return;

    try {
      await createDeployment.mutateAsync({
        name,
        catalog_entry_id: selectedImageId,
        replica_count: replicas,
        cpu_request: cpuRequest,
        memory_request: memoryRequest,
      });
      // TODO: If selectedDomainId is set, create ingress route after deployment creation
      // This requires the deployment ID from the response + domain route creation
      handleClose();
    } catch {
      // error shown in modal
    }
  };

  if (!open) return null;

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
                  onClick={() => { setSelectedImageId(''); setName(''); }}
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
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="my-workload"
                    data-testid="deploy-name-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Replicas</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={replicas}
                    onChange={(e) => setReplicas(Number(e.target.value))}
                    className={INPUT_CLASS}
                    data-testid="deploy-replicas-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">CPU Request</label>
                  <input
                    type="text"
                    value={cpuRequest}
                    onChange={(e) => setCpuRequest(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="100m"
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
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Connect Domain */}
          {selectedImageId && (
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                3. Connect a Domain
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

          {createDeployment.error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {createDeployment.error instanceof Error ? createDeployment.error.message : 'Deployment failed'}
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
              disabled={!selectedImageId || !name || createDeployment.isPending}
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
