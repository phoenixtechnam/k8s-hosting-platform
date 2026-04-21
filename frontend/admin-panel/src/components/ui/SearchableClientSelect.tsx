import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { useClients, useClient } from '@/hooks/use-clients';

interface SearchableClientSelectProps {
  readonly selectedClientId: string | null;
  readonly onSelect: (clientId: string | null) => void;
  readonly placeholder?: string;
}

export default function SearchableClientSelect({
  selectedClientId,
  onSelect,
  placeholder = 'Search clients...',
}: SearchableClientSelectProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch search results only when there is a debounced query
  const { data: searchData, isLoading: searchLoading } = useClients(
    debouncedQuery ? { search: debouncedQuery, limit: 20 } : { limit: 0 },
  );
  const searchResults = debouncedQuery ? (searchData?.data ?? []) : [];

  // Fetch the selected client's details for display
  const { data: selectedClientData } = useClient(selectedClientId ?? undefined);
  const selectedClient = selectedClientData?.data ?? null;

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value);
    }, 300);
  }, []);

  const handleSelect = useCallback(
    (clientId: string) => {
      onSelect(clientId);
      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onSelect(null);
    setQuery('');
    setDebouncedQuery('');
    setIsOpen(false);
    inputRef.current?.focus();
  }, [onSelect]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const showDropdown = isOpen && query.length > 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-xs" data-testid="client-search-select">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        {selectedClientId && !isOpen ? (
          <div
            className="flex w-full items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-3 text-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 cursor-pointer"
            onClick={() => {
              setIsOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            data-testid="client-search-selected"
          >
            <span className="truncate text-gray-900 dark:text-gray-100">
              {selectedClient?.companyName ?? 'Loading...'}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
              className="ml-2 rounded-full p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
              data-testid="client-search-clear"
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              handleQueryChange(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => {
              if (query.length > 0) setIsOpen(true);
            }}
            placeholder={placeholder}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="client-search-input"
          />
        )}
      </div>

      {showDropdown && (
        <div
          className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
          data-testid="client-search-dropdown"
        >
          {searchLoading && (
            <div className="flex items-center justify-center py-4" data-testid="client-search-loading">
              <Loader2 size={16} className="animate-spin text-gray-400" />
            </div>
          )}

          {!searchLoading && debouncedQuery && searchResults.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="client-search-empty">
              No clients found
            </div>
          )}

          {!searchLoading && searchResults.length > 0 && (
            <ul className="max-h-60 overflow-y-auto py-1" data-testid="client-search-results">
              {searchResults.map((client) => (
                <li key={client.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(client.id)}
                    className="flex w-full flex-col px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    data-testid={`client-option-${client.id}`}
                  >
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {client.companyName}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {client.companyEmail}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
