// Monaco + monaco-yaml lazy-loaded YAML editor. Wired to the platform's
// compose JSON Schema for per-field validation, autocomplete, and hover.
//
// This module is dynamically imported by ComposeEditor via React.lazy so
// its ~1.5 MB bundle does not inflate the main chunk. If monaco-yaml fails
// to initialise (e.g. missing CDN worker), ComposeEditor's ErrorBoundary
// catches the error and falls back to a plain textarea.

import { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';

interface Props {
  value: string;
  onChange: (v: string) => void;
  jsonSchema: unknown;
}

let yamlConfigured = false;

function ensureYaml(monaco: Monaco, schema: unknown) {
  if (yamlConfigured) return;
  yamlConfigured = true;
  configureMonacoYaml(monaco, {
    enableSchemaRequest: false,
    hover: true,
    completion: true,
    validate: true,
    format: {},
    schemas: schema
      ? [
          {
            uri: 'platform://compose-schema',
            fileMatch: ['*'],
            schema: schema as object,
          },
        ]
      : [],
  });
}

export default function MonacoYamlEditor({ value, onChange, jsonSchema }: Props) {
  const schemaRef = useRef(jsonSchema);
  schemaRef.current = jsonSchema;

  useEffect(() => {
    yamlConfigured = false;
  }, [jsonSchema]);

  return (
    <Editor
      height="100%"
      language="yaml"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        renderWhitespace: 'trailing',
        tabSize: 2,
      }}
      onMount={(_editor, monaco) => {
        ensureYaml(monaco, schemaRef.current);
      }}
      data-testid="custom-compose-monaco"
    />
  );
}
