import { FolderOpen, CheckCircle2 } from 'lucide-react';

const PLANNED_FEATURES = [
  'Upload/download files',
  'Directory management',
  'File editing',
  'SFTP access',
] as const;

export default function Files() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <FolderOpen size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900" data-testid="files-heading">
            Files
          </h1>
          <p className="text-sm text-gray-500">Manage your website files and directories.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-6 py-16 text-center" data-testid="files-coming-soon">
          <FolderOpen size={48} className="mx-auto text-gray-300" />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">
            File Manager &mdash; Coming Soon
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            File management will be available once FileBrowser is deployed.
            You'll be able to upload, download, and manage your website files.
          </p>

          <div className="mx-auto mt-8 max-w-xs text-left">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-400">
              Planned Features
            </p>
            <ul className="space-y-2">
              {PLANNED_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-gray-500">
                  <CheckCircle2 size={16} className="shrink-0 text-gray-300" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
