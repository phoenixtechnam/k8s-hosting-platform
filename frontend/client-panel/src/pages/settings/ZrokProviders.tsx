import { Share2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function ZrokProviders() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Share2 size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Zrok Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Register zrok controllers (default <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">https://api.zrok.io</code> or
        a self-hosted controller URL) to use for the App-level <strong>Network Access</strong>
        feature (zrok share mode). End users access the app via <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">zrok access private &lt;token&gt;</code>.
      </p>

      <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5" data-testid="zrok-providers-coming-soon">
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Coming with Milestone C</h2>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          Provider CRUD and the per-deployment zrok mode ship together as part of the zrok
          milestone. Contract surface (including the custom controller URL field) is part of
          Phase 1.
        </p>
      </div>
    </div>
  );
}
