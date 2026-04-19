import { useState, useCallback } from 'react';
import { Eye, EyeOff, ChevronRight } from 'lucide-react';

interface ParameterDef {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly description?: string;
  readonly advanced?: boolean;
}

interface ParameterFormProps {
  readonly parameters: readonly ParameterDef[];
  readonly values: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

function SecretInput({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (val: string) => void;
  readonly placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${INPUT_CLASS} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        aria-label={visible ? 'Hide value' : 'Show value'}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function BooleanSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (val: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function ParamField({
  param,
  value,
  onChange,
}: {
  readonly param: ParameterDef;
  readonly value: unknown;
  readonly onChange: (key: string, val: unknown) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        {param.label}
        {param.required && <span className="ml-0.5 text-red-500">*</span>}
      </label>

      {param.type === 'string' && (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(param.key, e.target.value)}
          placeholder={param.default != null ? String(param.default) : undefined}
          className={INPUT_CLASS}
        />
      )}

      {param.type === 'secret' && (
        <SecretInput
          value={typeof value === 'string' ? value : ''}
          onChange={(val) => onChange(param.key, val)}
          placeholder={param.default != null ? String(param.default) : undefined}
        />
      )}

      {param.type === 'boolean' && (
        <BooleanSwitch
          checked={Boolean(value)}
          onChange={(val) => onChange(param.key, val)}
        />
      )}

      {param.type === 'integer' && (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(param.key, e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={param.default != null ? String(param.default) : undefined}
          className={INPUT_CLASS}
        />
      )}

      {param.type === 'string[]' && (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(param.key, e.target.value)}
          placeholder="comma-separated values"
          className={INPUT_CLASS}
        />
      )}

      {param.description && (
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{param.description}</p>
      )}
    </div>
  );
}

export default function ParameterForm({ parameters, values, onChange }: ParameterFormProps) {
  const handleChange = useCallback(
    (key: string, value: unknown) => onChange(key, value),
    [onChange],
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { required, advanced } = parameters.reduce(
    (acc, p) => {
      (p.advanced ? acc.advanced : acc.required).push(p);
      return acc;
    },
    { required: [] as ParameterDef[], advanced: [] as ParameterDef[] },
  );

  return (
    <div className="space-y-4">
      {required.map((param) => (
        <ParamField key={param.key} param={param} value={values[param.key]} onChange={handleChange} />
      ))}

      {advanced.length > 0 && (
        <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-expanded={advancedOpen}
          >
            <ChevronRight
              size={14}
              className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
            />
            Advanced settings ({advanced.length})
          </button>
          {advancedOpen && (
            <div className="mt-3 space-y-4 border-l-2 border-gray-100 dark:border-gray-800 pl-3">
              {advanced.map((param) => (
                <ParamField key={param.key} param={param} value={values[param.key]} onChange={handleChange} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
