import { useState, useMemo } from 'react';
import { Server, Container, Rocket, Search } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';

interface ContainerImage {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: 'php' | 'wordpress' | 'static' | 'nodejs';
  readonly registryUrl: string;
  readonly status: 'active' | 'pending' | 'error';
}

const CONTAINER_IMAGES: readonly ContainerImage[] = [
  {
    id: 'img-1',
    name: 'NGINX + PHP 8.4',
    slug: 'nginx-php84',
    type: 'php',
    registryUrl: 'ghcr.io/k8s-hosting/nginx-php84',
    status: 'active',
  },
  {
    id: 'img-2',
    name: 'Apache + PHP 8.4',
    slug: 'apache-php84',
    type: 'php',
    registryUrl: 'ghcr.io/k8s-hosting/apache-php84',
    status: 'active',
  },
  {
    id: 'img-3',
    name: 'WordPress (PHP 8.4)',
    slug: 'wordpress-php84',
    type: 'wordpress',
    registryUrl: 'ghcr.io/k8s-hosting/wordpress-php84',
    status: 'active',
  },
  {
    id: 'img-4',
    name: 'Static Site (NGINX)',
    slug: 'static-nginx',
    type: 'static',
    registryUrl: 'ghcr.io/k8s-hosting/static-nginx',
    status: 'active',
  },
  {
    id: 'img-5',
    name: 'Node.js 22',
    slug: 'node22',
    type: 'nodejs',
    registryUrl: 'ghcr.io/k8s-hosting/node22',
    status: 'active',
  },
] as const;

export default function Workloads() {
  const [search, setSearch] = useState('');

  const filteredImages = useMemo(() => {
    if (!search.trim()) return CONTAINER_IMAGES;
    const term = search.toLowerCase();
    return CONTAINER_IMAGES.filter(
      (img) =>
        img.name.toLowerCase().includes(term) ||
        img.slug.toLowerCase().includes(term),
    );
  }, [search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Server size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900">Workloads</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Images" value={5} icon={Container} accent="brand" />
        <StatCard title="Active Workloads" value={12} icon={Server} accent="green" />
        <StatCard title="Deployments Today" value={3} icon={Rocket} accent="amber" />
      </div>

      <div className="space-y-4">
        <div className="relative max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search images..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="image-search"
          />
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="images-table">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="hidden px-5 py-3 md:table-cell">Registry URL</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredImages.map((image) => (
                  <tr key={image.id} className="transition-colors hover:bg-gray-50">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <Container size={14} className="text-gray-400" />
                        <span className="font-medium text-gray-900">{image.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-gray-600">{image.type}</td>
                    <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-500 md:table-cell">
                      {image.registryUrl}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={image.status} />
                    </td>
                  </tr>
                ))}
                {filteredImages.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                      No images found matching your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
            {filteredImages.length} image{filteredImages.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
