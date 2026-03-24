import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit, Pause } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import ResourceBar from '@/components/ui/ResourceBar';
import { mockClients } from '@/lib/mock-data';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const client = mockClients.find((c) => c.id === id);

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg text-gray-500">Client not found</p>
        <Link to="/clients" className="mt-4 text-sm text-brand-500 hover:text-brand-600">
          Back to clients
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/clients"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Back to clients"
        >
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{client.name}</h1>
          <p className="text-sm text-gray-500">{client.email}</p>
        </div>
        <div className="flex gap-2">
          <button className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            <Edit size={14} />
            <span className="hidden sm:inline">Edit</span>
          </button>
          <button className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50">
            <Pause size={14} />
            <span className="hidden sm:inline">Suspend</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Account Information</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Plan</dt>
              <dd className="mt-1 text-sm capitalize text-gray-900">{client.plan}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={client.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {new Date(client.created_at).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Subscription Expires</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {new Date(client.subscription.expiry_date).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Quick Stats</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Domains</span>
              <span className="font-medium text-gray-900">
                {client.usage.domains} / {client.quota.domains}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Databases</span>
              <span className="font-medium text-gray-900">
                {client.usage.databases} / {client.quota.databases}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Resource Usage</h2>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <ResourceBar
            label="Storage"
            used={client.usage.storage_gb}
            total={client.quota.storage_gb}
            unit=" GB"
          />
          <ResourceBar
            label="Bandwidth"
            used={client.usage.monthly_bandwidth_gb}
            total={client.quota.monthly_bandwidth_gb}
            unit=" GB"
          />
          <ResourceBar
            label="Domains"
            used={client.usage.domains}
            total={client.quota.domains}
          />
          <ResourceBar
            label="Databases"
            used={client.usage.databases}
            total={client.quota.databases}
          />
        </div>
      </div>
    </div>
  );
}
