import { AppWindow, Play, Square, Loader2, Box } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useWorkloads, useContainerImages, useUpdateWorkload } from '@/hooks/use-workloads';

const statusColors: Record<string, string> = {
  running: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  stopped: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
};

export default function Applications() {
  const { clientId } = useClientContext();
  const { data: workloadsData, isLoading, error } = useWorkloads(clientId ?? undefined);
  const { data: imagesData } = useContainerImages();
  const updateWorkload = useUpdateWorkload(clientId ?? undefined);

  const workloads = workloadsData?.data ?? [];
  const images = imagesData?.data ?? [];

  const getImageName = (imageId: string | null) => {
    if (!imageId) return 'Unknown';
    const img = images.find((i) => i.id === imageId);
    return img?.name ?? 'Unknown';
  };

  const handleToggleStatus = (workloadId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'running' ? 'stopped' : 'running';
    updateWorkload.mutate({ workloadId, status: newStatus as 'running' | 'stopped' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load applications. Please try again later.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Applications</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Your deployed workloads running on the platform.
          </p>
        </div>
      </div>

      {workloads.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-12 text-center">
          <Box className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
          <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">
            No applications deployed yet
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Go to Workloads to deploy your first application.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {workloads.map((workload) => (
            <div
              key={workload.id}
              className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400">
                    <AppWindow size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {workload.name}
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {getImageName(workload.containerImageId)}
                    </p>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[workload.status] ?? statusColors.stopped}`}
                >
                  {workload.status}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Replicas</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {workload.replicaCount}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                  <p className="text-xs text-gray-500 dark:text-gray-400">CPU</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {workload.cpuRequest}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Memory</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {workload.memoryRequest}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => handleToggleStatus(workload.id, workload.status)}
                  disabled={updateWorkload.isPending || workload.status === 'pending'}
                  className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    workload.status === 'running'
                      ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40'
                      : 'bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40'
                  }`}
                >
                  {updateWorkload.isPending ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : workload.status === 'running' ? (
                    <Square size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                  {workload.status === 'running' ? 'Stop' : 'Start'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
