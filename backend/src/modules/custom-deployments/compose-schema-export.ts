// JSON Schema (draft-07) describing the compose subset our parser
// accepts. Served at GET /custom-deployments/compose-schema and
// consumed by monaco-yaml in the client panel for inline schema-
// aware completion + red-squiggle on rejected fields.
//
// This file is the documentation surface: every change to the parser's
// accept/reject contract needs a matching change here so the editor
// stays honest. We deliberately keep it hand-written rather than
// generated from the Zod schemas because:
//
//   1. The Zod shape (customDeploymentSpecSchema) describes the
//      NORMALIZED post-parse form, not the user-facing compose
//      input. They diverge — compose has env_file, restart strings,
//      depends_on conditions, short-form port strings, etc.
//   2. monaco-yaml expects pure JSON Schema (no Zod runtime), and
//      a zod-to-json-schema converter would lose our reject-list
//      semantics (we can't express "this key is forbidden" cleanly).
//
// Schema version: bump `version` when the parser's accept-set changes
// so the client-panel cache busts.

const SCHEMA_VERSION = '1.0.0';

/**
 * Resolve the compose JSON Schema. Returns a literal object —
 * no runtime computation, no I/O. The route handler wraps this in
 * the standard response envelope.
 */
export function getComposeJsonSchema(): {
  $schema: string;
  title: string;
  schema: Record<string, unknown>;
  version: string;
} {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Custom Deployment Compose Subset',
    version: SCHEMA_VERSION,
    schema: COMPOSE_SCHEMA,
  };
}

// ─── Sub-schemas ────────────────────────────────────────────────────────────

const PORT_NAME_PATTERN = '^(?=.*[a-z])[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$';
const VOLUME_NAME_PATTERN = '^[a-z][a-z0-9_-]{0,62}$';
const CUSTOM_NAME_PATTERN = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$';
const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,127}$';

const HEALTHCHECK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: 'Liveness/readiness probe definition.',
  additionalProperties: false,
  properties: {
    test: {
      oneOf: [
        { type: 'string', enum: ['NONE'] },
        {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: '["CMD", "binary", "arg"…] or ["CMD-SHELL", "sh-line"]',
        },
        { type: 'string', description: 'CMD-SHELL shorthand' },
      ],
    },
    interval: { type: ['string', 'number'], minimum: 1, description: 'Probe period, e.g. 10s. Minimum 1s — Kubernetes rejects sub-second periods.' },
    timeout: { type: ['string', 'number'], minimum: 1, description: 'Per-probe timeout, e.g. 1s. Minimum 1s.' },
    retries: { type: 'integer', minimum: 1, maximum: 20 },
    start_period: { type: ['string', 'number'], description: 'Initial delay, e.g. 0s' },
    disable: { type: 'boolean' },
  },
};

const DEPENDS_ON_SCHEMA: Record<string, unknown> = {
  description: 'Ordering-only. The platform spawns one initContainer per dependency that waits for its first exposed Service port (60s timeout).',
  oneOf: [
    { type: 'array', items: { type: 'string', pattern: CUSTOM_NAME_PATTERN } },
    {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          condition: { type: 'string', enum: ['service_started', 'service_healthy'] },
        },
      },
    },
  ],
};

const PORTS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    oneOf: [
      {
        type: 'string',
        description: 'Short form: "container", "host:container", "host:container/protocol"',
        examples: ['80', '8080:80', '5353:53/udp'],
      },
      {
        type: 'object',
        required: ['target'],
        additionalProperties: false,
        properties: {
          target: { type: 'integer', minimum: 1, maximum: 65535 },
          published: { type: ['integer', 'string'], description: 'Ignored — k8s has no host port concept here.' },
          protocol: { type: 'string', enum: ['tcp', 'udp', 'sctp', 'TCP', 'UDP', 'SCTP'] },
          name: { type: 'string', pattern: PORT_NAME_PATTERN },
          mode: { type: 'string', enum: ['host', 'ingress'] },
        },
      },
    ],
  },
};

const VOLUMES_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description: 'Named-volume mounts ONLY. Bind mounts (./path or /abs) are rejected.',
  items: {
    oneOf: [
      {
        type: 'string',
        pattern: `^${VOLUME_NAME_PATTERN.slice(1, -1)}:[^:]+(:ro)?$`,
        description: '"named-volume:/path[:ro]"',
        examples: ['data:/var/www/html', 'cache:/tmp:ro'],
      },
      {
        type: 'object',
        required: ['type', 'source', 'target'],
        properties: {
          type: { type: 'string', enum: ['volume'] },
          source: { type: 'string', pattern: VOLUME_NAME_PATTERN },
          target: { type: 'string', pattern: '^/.+' },
          read_only: { type: 'boolean' },
        },
      },
    ],
  },
};

const ENVIRONMENT_SCHEMA: Record<string, unknown> = {
  description: 'KEY=VALUE pairs. Map or array form.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      patternProperties: { [ENV_NAME_PATTERN]: { type: ['string', 'number', 'boolean', 'null'] } },
    },
    {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*(=.*)?$' },
    },
  ],
};

const TMPFS_SCHEMA: Record<string, unknown> = {
  oneOf: [
    { type: 'string', description: 'Absolute container path, e.g. /run/cache' },
    {
      type: 'array',
      items: {
        type: 'string',
        description: '"/path" or "/path:size=64m"',
      },
    },
  ],
};

const SERVICE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['image'],
  additionalProperties: false,
  properties: {
    image: { type: 'string', minLength: 1, maxLength: 500 },
    command: { type: 'array', items: { type: 'string' }, description: 'Docker CMD (k8s args)' },
    entrypoint: { type: 'array', items: { type: 'string' }, description: 'Docker ENTRYPOINT (k8s command)' },
    environment: ENVIRONMENT_SCHEMA,
    env_file: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    ports: PORTS_SCHEMA,
    volumes: VOLUMES_SCHEMA,
    restart: {
      type: 'string',
      enum: ['always', 'unless-stopped', 'on-failure', 'no'],
    },
    healthcheck: HEALTHCHECK_SCHEMA,
    depends_on: DEPENDS_ON_SCHEMA,
    user: {
      type: ['string', 'integer'],
      description: 'Numeric uid or "uid:gid". Named users (e.g. "root") are rejected.',
    },
    working_dir: { type: 'string', pattern: '^/.+' },
    read_only: { type: 'boolean' },
    tmpfs: TMPFS_SCHEMA,
    stop_grace_period: { type: ['string', 'number'], description: 'Max 300s' },
    labels: {
      oneOf: [
        { type: 'object', additionalProperties: { type: 'string' } },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    configs: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' } } },
        ],
      },
    },
    secrets: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' } } },
        ],
      },
    },
    // `init: true` is parsed-and-warned (COMPOSE_INIT_IGNORED). We
    // intentionally keep it OUT of the schema so monaco-yaml prompts
    // the user to remove it — the warning issue in the editor's
    // pane explains why it's a no-op.
    cap_add: {
      type: 'array',
      items: { type: 'string', enum: ['NET_BIND_SERVICE'] },
      description: 'Only NET_BIND_SERVICE is permitted.',
    },
    sysctls: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            'net.ipv4.ip_unprivileged_port_start': { type: ['string', 'integer'] },
          },
        },
        { type: 'array', items: { type: 'string', pattern: '^net\\.ipv4\\.ip_unprivileged_port_start=' } },
      ],
    },
  },
};

const COMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  // Compose spec §7.3: `x-*` extension fields are silently accepted
  // by the parser, so monaco-yaml must not red-squiggle them either.
  patternProperties: { '^x-': {} },
  properties: {
    version: { type: ['string', 'number'], description: 'Optional. Accepts 3.x but is ignored.' },
    services: {
      type: 'object',
      minProperties: 1,
      maxProperties: 10,
      additionalProperties: SERVICE_SCHEMA,
      patternProperties: { [CUSTOM_NAME_PATTERN]: SERVICE_SCHEMA },
    },
    volumes: {
      type: 'object',
      description: 'Named volumes only. `external: true` is rejected.',
      additionalProperties: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              driver: { type: 'string' },
              driver_opts: { type: 'object' },
            },
          },
        ],
      },
      patternProperties: { [VOLUME_NAME_PATTERN]: {} },
    },
    configs: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          content: { type: 'string', maxLength: 1024 * 1024 },
        },
      },
    },
    secrets: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          content: { type: 'string', maxLength: 1024 * 1024 },
        },
      },
    },
    networks: {
      type: 'object',
      description: 'Ignored — every service joins the tenant namespace default network.',
    },
  },
  required: ['services'],
};
