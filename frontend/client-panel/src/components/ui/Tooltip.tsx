import { Info } from 'lucide-react';

interface Props {
  text: string;
}

export function Tooltip({ text }: Props) {
  return (
    <span className="group relative inline-flex items-center">
      <Info
        size={12}
        className="cursor-help text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-56 -translate-x-1/2 rounded-md bg-gray-800 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg group-hover:block dark:bg-gray-700">
        {text}
        <span className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-gray-800 dark:border-t-gray-700" />
      </span>
    </span>
  );
}
