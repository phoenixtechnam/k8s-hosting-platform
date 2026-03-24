import { Construction } from 'lucide-react';

interface PlaceholderProps {
  readonly title: string;
}

export default function Placeholder({ title }: PlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <Construction size={48} className="text-gray-300" />
      <h1 className="mt-4 text-2xl font-bold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">This page is under construction.</p>
    </div>
  );
}
