import { Network, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function OpenZitiProviders() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Network size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">OpenZiti Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Configure OpenZiti controllers to use as the underlying mesh for the App-level
        <strong> Network Access</strong> feature (tunneler mode). Once a provider is registered,
        pick it on any deployment's Network Access tab to advertise that app as a Ziti service —
        end users must run a Ziti tunneler to reach it.
      </p>

      <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5" data-testid="openziti-providers-coming-soon">
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Coming with Milestone A</h2>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          Provider CRUD and the per-deployment Network Access tab ship together as part of the
          Ziti tunneler milestone. The schema and contracts will be added in Phase 1.
        </p>
      </div>
    </div>
  );
}
