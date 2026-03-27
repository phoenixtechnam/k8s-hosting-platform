import { Sun, Moon, Monitor } from 'lucide-react';
import { useDarkMode } from '@/hooks/use-dark-mode';

const icons = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

export default function DarkModeToggle() {
  const { theme, cycle } = useDarkMode();
  const Icon = icons[theme];

  return (
    <button
      onClick={cycle}
      className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme} (click to cycle)`}
      data-testid="dark-mode-toggle"
    >
      <Icon size={18} />
    </button>
  );
}
