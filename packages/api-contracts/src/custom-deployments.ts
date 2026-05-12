// Custom Deployments — third deployment path next to workload catalog
// (ADR-025) and application catalog (ADR-026). Tenants bring their own
// image or compose stack. See ADR-036 for the architectural decision
// and the residual-risk discussion (the user-confirmed image-trust
// trade-offs: no registry allowlist, no image-pin requirement, private
// PAT-backed registries supported).
//
// The normalized `customSpec` JSONB shape is reachable from two input
// paths:
//   1. Simple form (mode: 'simple') — one image, declared ports + volumes
//   2. Compose stack (mode: 'compose') — see compose.ts for the parser
//      surface; the backend parses YAML server-side and persists the
//      same `customSpec` shape.

import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Common shapes ──────────────────────────────────────────────────────────

/**
 * Spec format version. Bump when the persisted shape changes in a way
 * that older consumers cannot read. Migrations rewrite older specs to
 * the current version on read. Phase 1 ships v1.
 */
export const CUSTOM_SPEC_VERSION = 1 as const;

/**
 * `capabilities.add` allowlist. PSS baseline admission on tenant
 * namespaces blocks anything not on this list. Single-element tuple
 * so `z.enum(ALLOWED_CAP_ADD)` works at the Zod layer.
 */
export const ALLOWED_CAP_ADD = ['NET_BIND_SERVICE'] as const;

/**
 * Pod-level sysctl allowlist. Only safe-to-namespace sysctls are
 * permitted. Single-element tuple so `z.enum(ALLOWED_SYSCTLS)` works.
 */
export const ALLOWED_SYSCTLS = ['net.ipv4.ip_unprivileged_port_start'] as const;

/**
 * K8s service name: lowercase DNS_LABEL (RFC 1123), 1-63 chars,
 * start and end alphanumeric. Same regex as the catalog
 * deployments `k8sNameRegex`, intentionally identical so a custom
 * deployment can't collide with a catalog deployment on naming rules.
 */
export const CUSTOM_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Port name: IANA service name (RFC 6335). 1-15 chars, lowercase
 * alphanumeric + hyphens, must contain at least one letter, must not
 * start or end with hyphen, no consecutive hyphens. Used for the
 * Service port name and for ingress route targetServicePort matching.
 *
 * The consecutive-hyphen rule is enforced separately via the `.refine`
 * on `customPortSchema.name` (Zod can express the alternation cleanly
 * without an unreadable regex).
 */
export const PORT_NAME_RE = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/;

/**
 * Volume name: single lowercase segment, max 63 chars total. Maps
 * directly to a subPath on the tenant's shared PVC (under
 * `custom/{deployment}/{volume}`). Matches catalog `LOCAL_PATH_RE`
 * excluding the "." (PVC-root) case — custom deployments never mount
 * the PVC root.
 *
 * Length budget: leading `[a-z]` = 1 char, trailing class `{0,62}` =
 * 0-62 chars → total 1-63.
 */
export const VOLUME_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * Env var name: POSIX-ish. `[A-Za-z_][A-Za-z0-9_]{0,127}`. Length cap
 * mirrors the Linux kernel limit (256) halved to leave headroom for
 * the value.
 */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * K8s resource quantity (`250m`, `512Mi`, `1Gi`, `2`). Conservatively
 * narrow — backend validator does the semantic check (parses + compares
 * against plan headroom). At the Zod layer we just keep wildly bad
 * input out.
 */
export const RESOURCE_QTY_RE = /^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;

/**
 * `runAsUser` (a uid) and `runAsGroup` (a gid). 0 is allowed only when
 * the deployment is admin-flagged `allowRoot:true`; the layer-2 backend
 * validator enforces that. At the Zod layer we just bound the integer.
 */
export const uidGidSchema = z.number().int().min(0).max(65535);

/**
 * In-container paths that tenants must NOT use as workingDir or as
 * tmpfs mountpoints. Mounting tmpfs over `/run/secrets/...` shadows
 * the auto-injected service-account token; `workingDir` over `/proc`
 * or `/sys` confuses health probes and audit logs.
 *
 * Exported so the PR-2 validator can apply the same list to
 * volumeMount.containerPath (which has its own subPath rendering and
 * could otherwise overlay a system mount).
 */
export const RESERVED_CONTAINER_PATH_RE = /^(\/proc|\/sys|\/dev|\/run\/secrets|\/var\/run\/secrets)(\/|$)/;

// ─── Port / volume / env / health subschemas ────────────────────────────────

export const customPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  name: z.string()
    .regex(PORT_NAME_RE, {
      message: 'Port name must be a 1-15 char IANA service name (lowercase, alphanumeric+hyphens, must contain a letter)',
    })
    // RFC 6335 forbids consecutive hyphens. Enforced as a refine
    // (rather than baked into PORT_NAME_RE) so the regex stays readable.
    .refine((s) => !s.includes('--'), {
      message: 'Port name must not contain consecutive hyphens (RFC 6335)',
    }),
  /** L4 protocol exposed by the Service. UDP/SCTP are accepted but
   *  ingress routes only wire TCP — those just get a Service. */
  protocol: z.enum(['TCP', 'UDP', 'SCTP']).default('TCP'),
  /** When false, the port is container-internal only (no Service rendered). */
  exposeAsService: z.boolean().default(true),
  /** When true AND `exposeAsService`, the Routes UI lists this port as
   *  an ingress backend candidate. Phase 1: at most one ingressEligible
   *  port per deployment (multi-port wiring → Phase 2). */
  ingressEligible: z.boolean().default(false),
});

export const customVolumeMountSchema = z.object({
  /**
   * What the name references:
   *   'volume'    → a key in customSpec.volumes (subPath on tenant PVC)
   *   'configMap' → a key in customSpec.configMaps (projected ConfigMap volume)
   *   'secret'    → a key in customSpec.secrets (projected Secret volume)
   *
   * Defaults to 'volume' for backward compatibility with Phase 1 mounts
   * that were created without an explicit kind.
   */
  kind: z.enum(['volume', 'configMap', 'secret']).default('volume'),
  /** References a volume / configMap / secret name (see `kind`). */
  name: z.string().regex(VOLUME_NAME_RE, {
    message: 'Volume name must be a single lowercase segment (^[a-z][a-z0-9_-]{0,63}$)',
  }),
  /** Mount point inside the container. Must be absolute. Single-dot
   *  (`/./`) and parent (`/../`) segments are rejected — the path is
   *  rendered into a `subPath` mount on the tenant PVC and weird
   *  segments make the resolved host path ambiguous. */
  containerPath: z.string()
    .min(2).max(4096)
    .startsWith('/', { message: 'containerPath must be absolute' })
    .refine(
      (p) =>
        !p.includes('//') &&
        !p.includes('/../') &&
        !p.endsWith('/..') &&
        !p.includes('/./') &&
        !p.endsWith('/.'),
      { message: 'containerPath must not contain "//", "/./", or ".." segments' },
    )
    .refine(
      (p) => !RESERVED_CONTAINER_PATH_RE.test(p),
      { message: 'containerPath is in a system-reserved directory (/proc, /sys, /dev, /run/secrets, /var/run/secrets)' },
    ),
  readOnly: z.boolean().default(false),
});

export const customEnvSchema = z.object({
  name: z.string().regex(ENV_NAME_RE, {
    message: 'Env var name must match [A-Za-z_][A-Za-z0-9_]{0,127}',
  }),
  /** Either a literal value or a reference to a custom Secret/ConfigMap.
   *  An empty-string `value` is INTENTIONAL — it means "set this env
   *  var to the empty string", which is legitimate for unsetting an
   *  inherited image env (e.g. unset `HTTP_PROXY` baked into the
   *  parent image by setting `HTTP_PROXY=""`). To mean "I'm not
   *  providing a value", omit the field entirely. */
  value: z.string().max(32 * 1024).optional(),
  valueFromSecret: z.string().regex(CUSTOM_NAME_RE).optional(),
  valueFromConfigMap: z.string().regex(CUSTOM_NAME_RE).optional(),
}).refine(
  (e) => [e.value, e.valueFromSecret, e.valueFromConfigMap].filter((v) => v !== undefined).length === 1,
  { message: 'Exactly one of value / valueFromSecret / valueFromConfigMap must be set' },
);

export const customHealthCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('httpGet'),
    path: z.string().startsWith('/').max(2048),
    port: z.number().int().min(1).max(65535),
    scheme: z.enum(['HTTP', 'HTTPS']).default('HTTP'),
    // Header name = RFC 7230 token; CRLF in either name or value
    // rejected to defuse response-splitting / smuggling vectors
    // against the kubelet's probe client.
    httpHeaders: z.array(z.object({
      name: z.string().min(1).max(255).regex(/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/, {
        message: 'HTTP header name must be a RFC 7230 token (no CRLF, no whitespace)',
      }),
      value: z.string().max(8 * 1024).refine((v) => !v.includes('\r') && !v.includes('\n'), {
        message: 'HTTP header value must not contain CR or LF',
      }),
    })).max(20).optional(),
  }),
  z.object({
    type: z.literal('tcpSocket'),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({
    type: z.literal('exec'),
    /** Argv style. The first element is the executable. */
    command: z.array(z.string().max(4096)).min(1).max(64),
  }),
]).and(z.object({
  initialDelaySeconds: z.number().int().min(0).max(3600).default(0),
  periodSeconds: z.number().int().min(1).max(3600).default(10),
  timeoutSeconds: z.number().int().min(1).max(60).default(1),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  successThreshold: z.number().int().min(1).max(10).default(1),
}));

export const customTmpfsSchema = z.object({
  path: z.string().startsWith('/').max(4096).refine(
    (p) => !RESERVED_CONTAINER_PATH_RE.test(p),
    {
      message: 'tmpfs path is in a system-reserved directory (/proc, /sys, /dev, /run/secrets, /var/run/secrets)',
    },
  ),
  /** Cap in MiB. K8s defaults Memory medium to 50% of node memory; we
   *  cap small to prevent a tenant from eating node RAM. */
  sizeMi: z.number().int().min(1).max(256).default(64),
});

export const customResourcesSchema = z.object({
  cpuRequest: z.string().regex(RESOURCE_QTY_RE).default('100m'),
  memoryRequest: z.string().regex(RESOURCE_QTY_RE).default('128Mi'),
  /** Limits default to 2× request (CPU) / 1.5× request (memory) when
   *  not set — applied server-side. Custom deployments enforce limits
   *  to protect against runaway containers; this is a stricter policy
   *  than catalog deployments. */
  cpuLimit: z.string().regex(RESOURCE_QTY_RE).optional(),
  memoryLimit: z.string().regex(RESOURCE_QTY_RE).optional(),
});

// ─── Service (one container) ────────────────────────────────────────────────

/**
 * A single service within a custom deployment. Both the simple form
 * and the compose parser normalize to a map of these.
 *
 * Forbidden Pod-spec fields (`hostNetwork`, `hostPID`, `hostIPC`,
 * `hostPort`, `privileged`, `capabilities.add` outside [NET_BIND_SERVICE],
 * `volumes.hostPath`, etc.) are NOT representable here by design — a
 * tenant cannot construct a `CustomDeploymentService` that asks for
 * them. Compose YAML that uses those fields is rejected in the parser
 * with `COMPOSE_FIELD_REJECTED` before this shape is constructed.
 */
export const customServiceSchema = z.object({
  image: z.string().min(1).max(500),
  command: z.array(z.string().max(4096)).max(64).optional(),
  entrypoint: z.array(z.string().max(4096)).max(64).optional(),
  env: z.array(customEnvSchema).max(200).default([]),
  ports: z.array(customPortSchema).max(20).default([]),
  volumeMounts: z.array(customVolumeMountSchema).max(50).default([]),
  resources: customResourcesSchema.default({ cpuRequest: '100m', memoryRequest: '128Mi' }),
  healthCheck: customHealthCheckSchema.optional(),
  restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).default('Always'),
  /** Maps to PodSpec.securityContext.runAsUser. */
  runAsUser: uidGidSchema.optional(),
  /** Maps to PodSpec.securityContext.runAsGroup. */
  runAsGroup: uidGidSchema.optional(),
  /** Container.workingDir. Rejecting system-reserved roots so a
   *  tenant cannot point cwd at `/proc/self` or similar in ways that
   *  confuse health probes and audit. */
  workingDir: z.string().startsWith('/').max(4096).refine(
    (p) => !RESERVED_CONTAINER_PATH_RE.test(p),
    {
      message: 'workingDir is in a system-reserved directory (/proc, /sys, /dev, /run/secrets, /var/run/secrets)',
    },
  ).optional(),
  /** Container.securityContext.readOnlyRootFilesystem. */
  readOnlyRootFilesystem: z.boolean().default(false),
  /** Tmpfs (`emptyDir { medium: Memory }`) mounts. Used when
   *  readOnlyRootFilesystem=true and the app still needs scratch space. */
  tmpfs: z.array(customTmpfsSchema).max(10).default([]),
  /**
   * `capabilities.add` — only entries from `ALLOWED_CAP_ADD` are
   * accepted; PSS baseline on the namespace blocks anything else.
   * Parsed from compose `cap_add:`. Empty by default.
   */
  capAdd: z.array(z.enum(ALLOWED_CAP_ADD)).max(1).default([]),
  /**
   * Pod-level sysctl overrides. Only keys from `ALLOWED_SYSCTLS` are
   * accepted. Maps to `PodSpec.securityContext.sysctls[]`.
   * Parsed from compose `sysctls:`.
   */
  sysctls: z.record(z.enum(ALLOWED_SYSCTLS), z.string().regex(/^[0-9]+$/, {
    message: 'sysctl value must be a non-negative integer string',
  })).optional(),
  /** PodSpec.terminationGracePeriodSeconds, max 5 min. */
  stopGracePeriodSeconds: z.number().int().min(0).max(300).optional(),
  /** Names of other services this depends on. Resolves to one
   *  initContainer per dep that waits for the dep's Service to have
   *  a ready endpoint, with a 60s timeout. Cycles rejected by validator. */
  dependsOn: z.array(z.string().regex(CUSTOM_NAME_RE)).max(10).default([]),
  /** Free-form labels applied to the Pod. Reserved-prefix labels
   *  (`platform.phoenix-host.net/...`) are stripped server-side. */
  labels: z.record(z.string(), z.string()).optional(),
});

// ─── Top-level Custom Spec ──────────────────────────────────────────────────

/** Named volume definition (persisted on tenant's shared PVC under
 *  `custom/{deployment}/{volumeName}` via subPath). */
export const customVolumeDefSchema = z.object({
  /** Advisory; the underlying PVC is shared across the tenant and
   *  already sized by the plan. Used for UI display only. */
  sizeHint: z.string().regex(RESOURCE_QTY_RE).optional(),
});

/** Inline ConfigMap (compose `configs` or simple-form file injection). */
export const customConfigMapSchema = z.object({
  name: z.string().regex(CUSTOM_NAME_RE),
  /** UTF-8 inline content. Phase 1 cap: 1 MiB per ConfigMap. */
  content: z.string().max(1024 * 1024),
  /** Default file mode for mounted entries (`0644`). */
  mode: z.number().int().min(0).max(0o777).default(0o644),
});

/** Inline Secret (compose `secrets`). Stored encrypted at rest. */
export const customSecretSchema = z.object({
  name: z.string().regex(CUSTOM_NAME_RE),
  /** UTF-8 inline content. Phase 1 cap: 1 MiB per Secret. */
  content: z.string().max(1024 * 1024),
  mode: z.number().int().min(0).max(0o777).default(0o400),
});

export const customDeploymentSpecSchema = z.object({
  specVersion: z.literal(CUSTOM_SPEC_VERSION),
  /** Which input path produced this spec. Diagnostic only. */
  sourceMode: z.enum(['simple', 'compose']),
  /** Map of service name → service. Phase 1 supports up to 10
   *  services per stack. Simple-form deployments have exactly one. */
  services: z.record(z.string().regex(CUSTOM_NAME_RE), customServiceSchema)
    .refine((m) => Object.keys(m).length >= 1, { message: 'at least one service required' })
    .refine((m) => Object.keys(m).length <= 10, { message: 'at most 10 services per stack' }),
  /** Named volumes referenced by services. Each becomes a subPath on
   *  the tenant's shared PVC. */
  volumes: z.record(z.string().regex(VOLUME_NAME_RE), customVolumeDefSchema).default({}),
  /** Inline ConfigMaps. Mount paths declared via volumeMounts ref by name. */
  configMaps: z.array(customConfigMapSchema).max(20).default([]),
  /** Inline Secrets. */
  secrets: z.array(customSecretSchema).max(20).default([]),
  /** Admin-only override that disables `runAsNonRoot` enforcement.
   *  When false (default), `runAsUser:0` is rejected for every service. */
  allowRoot: z.boolean().default(false),
  /** Optional reference to a stored image-pull credential (PAT).
   *  When set, every service in this stack uses the same imagePullSecret. */
  pullCredentialId: uuidField.optional(),
});

// ─── Create / Update inputs ─────────────────────────────────────────────────

/**
 * Simple-form create input — one service, flat field set.
 *
 * NOTE: `allow_root` is NOT a field on this schema by design. The
 * `allowRoot` flag is admin-only and lives only on the persisted
 * `customDeploymentSpecSchema`. To flip it on an existing deployment
 * the operator must hit a separate admin-only endpoint (PR-2).
 * Including it in the tenant input would let a tenant set their own
 * `allowRoot:true` via the create API.
 */
export const createCustomDeploymentSimpleSchema = z.object({
  mode: z.literal('simple'),
  name: z.string().min(1).max(63).regex(CUSTOM_NAME_RE, {
    message: 'Name must be DNS-compatible: lowercase letters, digits, and hyphens (max 63 chars, must start and end with letter/digit)',
  }),
  image: z.string().min(1).max(500),
  command: z.array(z.string()).max(64).optional(),
  entrypoint: z.array(z.string()).max(64).optional(),
  env: z.array(customEnvSchema).max(200).optional(),
  ports: z.array(customPortSchema).max(20).optional(),
  volumes: z.array(customVolumeMountSchema).max(50).optional(),
  resources: customResourcesSchema.optional(),
  health_check: customHealthCheckSchema.optional(),
  restart_policy: z.enum(['Always', 'OnFailure', 'Never']).optional(),
  run_as_user: uidGidSchema.optional(),
  run_as_group: uidGidSchema.optional(),
  read_only_root_filesystem: z.boolean().optional(),
  pull_credential_id: uuidField.optional(),
});

/**
 * Compose-form create input — YAML body, optional PAT, optional
 * env_file map (key=path, value=content). The backend parses the
 * YAML server-side and produces a multi-service `customSpec`.
 *
 * `allow_root` is intentionally absent — same reason as the simple
 * form. Compose YAML's `user: 0` will be rejected unless an admin
 * has already flipped `allowRoot` on the deployment row.
 */
export const createCustomDeploymentComposeSchema = z.object({
  mode: z.literal('compose'),
  /** Optional during the editor preview/validate path; required for actual deployment. */
  name: z.string().max(63).regex(CUSTOM_NAME_RE).optional(),
  compose_yaml: z.string().min(1).max(256 * 1024),
  /** Files referenced by compose `env_file:` directives. Map of
   *  filename → UTF-8 content. */
  env_files: z.record(z.string().min(1).max(255), z.string().max(64 * 1024)).optional(),
  pull_credential_id: uuidField.optional(),
});

export const createCustomDeploymentSchema = z.discriminatedUnion('mode', [
  createCustomDeploymentSimpleSchema,
  createCustomDeploymentComposeSchema,
]);

/** Admin-only: flip `allowRoot` on an existing deployment.
 *  Requires super_admin role. Does NOT trigger a re-deploy; the
 *  tenant must explicitly re-apply the spec after the flag is set. */
export const setAllowRootSchema = z.object({
  allowRoot: z.boolean(),
});

/** Update is a narrow patch — most fields are immutable post-create
 *  (rename = delete + recreate). Tag bumps go via /upgrade-tag. */
export const updateCustomDeploymentSchema = z.object({
  /** Restart the deployment without other changes. */
  restart: z.boolean().optional(),
  /** Re-target an image without rewriting the spec — used by the
   *  one-click "Update available" upgrade flow. Same image, new tag. */
  image: z.string().min(1).max(500).optional(),
  /** Mutate env (full replace, not patch). */
  env: z.array(customEnvSchema).max(200).optional(),
  resources: customResourcesSchema.optional(),
  /** Replace port declarations (simple-mode only). Full replace, not patch. */
  ports: z.array(customPortSchema).max(20).optional(),
  /** Set/clear the imagePullSecret. */
  pull_credential_id: uuidField.nullable().optional(),
});

// ─── Validate (preview) ─────────────────────────────────────────────────────

export const customDeploymentIssueSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  /** Stable SCREAMING_SNAKE_CASE code (e.g. `COMPOSE_FIELD_REJECTED`,
   *  `BIND_MOUNT_NOT_PERMITTED`, `UNPINNED_TAG_ADVISORY`). */
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  /** Dotted path into the submitted spec (e.g. `services.web.privileged`). */
  path: z.string().max(512),
  message: z.string().max(2048),
  /** Optional hint for the UI on how to fix it. */
  hint: z.string().max(2048).optional(),
});

/** Rendered k8s manifest preview, for the editor's "Rendered" tab. */
export const renderedManifestSchema = z.object({
  kind: z.string(),
  name: z.string(),
  yaml: z.string(),
});

export const validateCustomDeploymentResultSchema = z.object({
  /** When false, `issues` contains at least one `error`-severity entry. */
  ok: z.boolean(),
  /** All severities, including warnings (e.g. UNPINNED_TAG_ADVISORY). */
  issues: z.array(customDeploymentIssueSchema),
  /** Normalized spec (if ok). Null on hard parse failure. */
  spec: customDeploymentSpecSchema.nullable(),
  /** Rendered k8s manifests when ok=true. Empty otherwise. */
  rendered: z.array(renderedManifestSchema),
});

// ─── Update checker ─────────────────────────────────────────────────────────

export const updateCheckResultSchema = z.object({
  status: z.enum(['no-update', 'patch', 'minor', 'major', 'unknown']),
  /** Current tag resolved from the running image reference. */
  current: z.string().nullable(),
  /** Latest tag found in the registry that is `>= current` by semver
   *  ordering; null when nothing newer exists or detection failed. */
  latest: z.string().nullable(),
  /** Why we returned `unknown` — useful for the UI tooltip. */
  reason: z.string().nullable(),
  /** ISO timestamp the cache entry was written. Stale results (>60min
   *  old) trigger a background refresh while the cached entry is still
   *  returned. */
  checkedAt: z.string(),
});

export const checkUpdatesBatchSchema = z.object({
  deployment_ids: z.array(uuidField).min(1).max(100),
});

export const checkUpdatesBatchResultSchema = z.object({
  /** Keyed by deploymentId. Deployments without a valid current image
   *  reference (e.g. compose stacks with multiple distinct images)
   *  are reported as `{ status: 'unknown', reason: 'multi-image stack' }`
   *  here; the per-service breakdown is available via /:id/update-check. */
  results: z.record(uuidField, updateCheckResultSchema),
});

// ─── Pull credentials (PAT) ─────────────────────────────────────────────────

/** Submit a PAT. Write-only — the server stores it envelope-encrypted
 *  and never returns the cleartext. The response shape (`pullCredentialResponseSchema`)
 *  echoes only `lastFour` + `registryHost`. */
export const submitPullCredentialSchema = z.object({
  /** Registry host (`ghcr.io`, `docker.io`, `registry.example.com`,
   *  `registry.example.com:5000`). No scheme, no path. Optional
   *  port suffix accepted for on-prem registries on non-default
   *  ports (Harbor, GitLab Container Registry self-hosted, etc.). */
  registry_host: z.string().min(1).max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/, {
      message: 'registry_host must be a lowercase DNS name with optional `:port`, no scheme or path',
    }),
  username: z.string().min(1).max(255),
  token: z.string().min(1).max(4096),
});

export const pullCredentialResponseSchema = z.object({
  id: uuidField,
  deploymentId: z.string(),
  registryHost: z.string(),
  username: z.string(),
  /** Last four characters of the token, for the operator to recognise
   *  which credential they're looking at. Never the full token. */
  tokenLastFour: z.string().length(4),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
});

// ─── Image audit / list ─────────────────────────────────────────────────────

export const customDeploymentImageAuditEntrySchema = z.object({
  id: uuidField,
  deploymentId: z.string(),
  image: z.string(),
  /** Resolved digest captured from `containerStatuses[].imageID` once
   *  the pod has pulled. Null while the pod is still pulling. */
  resolvedDigest: z.string().nullable(),
  pulledAt: z.string(),
});

export const customDeploymentImageAuditListSchema = paginatedResponseSchema(
  customDeploymentImageAuditEntrySchema,
);

// ─── Inferred types ─────────────────────────────────────────────────────────

export type CustomDeploymentSpec = z.infer<typeof customDeploymentSpecSchema>;
export type CustomDeploymentService = z.infer<typeof customServiceSchema>;
export type CustomDeploymentPort = z.infer<typeof customPortSchema>;
export type CustomDeploymentVolumeMount = z.infer<typeof customVolumeMountSchema>;
export type CustomDeploymentEnv = z.infer<typeof customEnvSchema>;
export type CustomDeploymentHealthCheck = z.infer<typeof customHealthCheckSchema>;
export type CustomDeploymentTmpfs = z.infer<typeof customTmpfsSchema>;
export type CustomDeploymentResources = z.infer<typeof customResourcesSchema>;
export type CustomDeploymentVolumeDef = z.infer<typeof customVolumeDefSchema>;
export type CustomDeploymentConfigMap = z.infer<typeof customConfigMapSchema>;
export type CustomDeploymentSecret = z.infer<typeof customSecretSchema>;
export type CreateCustomDeploymentSimpleInput = z.infer<typeof createCustomDeploymentSimpleSchema>;
export type CreateCustomDeploymentComposeInput = z.infer<typeof createCustomDeploymentComposeSchema>;
export type CreateCustomDeploymentInput = z.infer<typeof createCustomDeploymentSchema>;
export type UpdateCustomDeploymentInput = z.infer<typeof updateCustomDeploymentSchema>;
export type SetAllowRootInput = z.infer<typeof setAllowRootSchema>;
export type CustomDeploymentIssue = z.infer<typeof customDeploymentIssueSchema>;
export type ValidateCustomDeploymentResult = z.infer<typeof validateCustomDeploymentResultSchema>;
export type RenderedManifest = z.infer<typeof renderedManifestSchema>;
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export type CheckUpdatesBatchInput = z.infer<typeof checkUpdatesBatchSchema>;
export type CheckUpdatesBatchResult = z.infer<typeof checkUpdatesBatchResultSchema>;
export type SubmitPullCredentialInput = z.infer<typeof submitPullCredentialSchema>;
export type PullCredentialResponse = z.infer<typeof pullCredentialResponseSchema>;
export type CustomDeploymentImageAuditEntry = z.infer<typeof customDeploymentImageAuditEntrySchema>;
export type CustomDeploymentImageAuditList = z.infer<typeof customDeploymentImageAuditListSchema>;
