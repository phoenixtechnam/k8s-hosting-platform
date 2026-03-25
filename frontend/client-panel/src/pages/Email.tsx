import { Mail, CheckCircle2 } from 'lucide-react';

const PLANNED_FEATURES = [
  'Create/delete mailboxes',
  'Email aliases',
  'Forwarding rules',
  'Spam filtering (Rspamd)',
  'Webmail (Roundcube)',
] as const;

export default function Email() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Mail size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900" data-testid="email-heading">
            Email
          </h1>
          <p className="text-sm text-gray-500">Manage your email accounts and settings.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-6 py-16 text-center" data-testid="email-coming-soon">
          <Mail size={48} className="mx-auto text-gray-300" />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">
            Email Management &mdash; Coming Soon
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Email account management will be available once Docker-Mailserver is deployed.
            You'll be able to create mailboxes, manage aliases, and configure forwarding.
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
