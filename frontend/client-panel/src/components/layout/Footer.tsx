import { useSystemInfo } from '@/hooks/use-system-info';
import { Mail, ExternalLink } from 'lucide-react';

/**
 * Minimal footer rendered inside the authenticated shell. Shows whatever
 * support-contact info the platform admin configured in System Settings.
 * Silent when neither value is set.
 */
export default function Footer() {
  const { data: info } = useSystemInfo();
  const email = info?.supportEmail;
  const url = info?.supportUrl;
  if (!email && !url) return null;

  return (
    <footer
      className="flex items-center justify-end gap-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-xs text-gray-500 dark:text-gray-400"
      data-testid="app-footer"
    >
      {email && (
        <a
          href={`mailto:${email}`}
          className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="footer-support-email"
        >
          <Mail size={12} /> {email}
        </a>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="footer-support-url"
        >
          <ExternalLink size={12} /> Help &amp; docs
        </a>
      )}
    </footer>
  );
}
