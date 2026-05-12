// Hand-written compose 3.7–3.9 parser → normalized CustomDeploymentSpec.
//
// We do NOT use `kompose`: it accepts fields we want to reject, and
// produces k8s manifests in a shape that diverges from the
// CustomDeploymentSpec shape we already render via
// `custom-deployments/k8s-deployer.ts`. Writing a focused parser
// keeps the accepted-field surface locked down and lets the
// validator + deployer share one structural representation with the
// simple-form path.
//
// Accepted subset (per ADR-036 Phase 1):
//   Top level:
//     services (required, ≥1 ≤10 in Phase 1)
//     volumes  (named only — bind / external rejected)
//     configs  (`file:` or inline content; external rejected)
//     secrets  (Opaque k8s Secret per entry)
//     networks (ignored with WARNING)
//     version  (ignored; we accept 3.x)
//     x-*      (extension fields — ignored)
//
//   Per service:
//     image (required)
//     command, entrypoint, environment, env_file
//     ports (short "8080:80" and long-form maps)
//     volumes (named refs `vol:/path[:ro]` only)
//     restart (always|on-failure|no → Always|OnFailure|Never)
//     healthcheck (CMD / CMD-SHELL / NONE)
//     depends_on (string list or condition map)
//     user, working_dir, read_only, tmpfs, stop_grace_period
//     labels, configs, secrets, init
//
// Rejected fields produce one Issue per occurrence with a clear
// error code so the editor can underline the offending line.
//
// The parser is pure — no DB or k8s calls. It returns the spec
// (or null on hard parse failure) + Issue[] (errors and warnings).
// `validateCustomSpec` runs after this layer and applies semantic
// checks (ref integrity, depends_on cycles, etc.).

import yaml from 'js-yaml';
import {
  CUSTOM_SPEC_VERSION,
  CUSTOM_NAME_RE,
  PORT_NAME_RE,
  VOLUME_NAME_RE,
  ALLOWED_CAP_ADD,
  ALLOWED_SYSCTLS,
  type CustomDeploymentSpec,
  type CustomDeploymentService,
  type CustomDeploymentPort,
  type CustomDeploymentVolumeMount,
  type CustomDeploymentEnv,
  type CustomDeploymentHealthCheck,
  type CustomDeploymentTmpfs,
  type CustomDeploymentIssue,
  type CustomDeploymentConfigMap,
  type CustomDeploymentSecret,
  type CustomDeploymentVolumeDef,
} from './schema.js';

const MAX_SERVICES = 10;
const MAX_YAML_DEPTH = 16;
const MAX_INLINE_CONFIG_BYTES = 1024 * 1024;

// Use shared allowlist Sets derived from the api-contracts constants.
const ALLOWED_CAP_ADD_SET = new Set<string>(ALLOWED_CAP_ADD);
const ALLOWED_SYSCTLS_SET = new Set<string>(ALLOWED_SYSCTLS);

// Compose `restart:` literal → k8s restartPolicy.
const RESTART_MAP: Record<string, CustomDeploymentService['restartPolicy']> = {
  'always': 'Always',
  'unless-stopped': 'Always', // best k8s approximation
  'on-failure': 'OnFailure',
  'no': 'Never',
};

export interface ComposeParseInput {
  /** YAML body submitted by the tenant. Cap is enforced by the
   *  Zod schema; we additionally check structural depth here. */
  readonly composeYaml: string;
  /** filename → UTF-8 content map. Pre-loaded env files referenced
   *  by `env_file:` directives. */
  readonly envFiles?: Readonly<Record<string, string>>;
}

export interface ComposeParseResult {
  /** Null when a hard parse failure prevents constructing any spec. */
  readonly spec: CustomDeploymentSpec | null;
  readonly issues: readonly CustomDeploymentIssue[];
}

/**
 * Parse a docker-compose YAML body into the normalized
 * `customDeploymentSpec` shape. Errors and warnings live in
 * `issues`; the caller's pipeline calls `validateCustomSpec` next
 * (with `singleServiceOnly: false`).
 *
 * Crucially this function is total: it never throws. A pathological
 * YAML is caught by the inner try/catch and reported as an error
 * issue with a null spec. Caller handles the null case.
 */
export function parseCompose(input: ComposeParseInput): ComposeParseResult {
  const issues: CustomDeploymentIssue[] = [];

  let doc: unknown;
  try {
    // JSON_SCHEMA: ints / floats / booleans / null are parsed as JS
    // types; sexagesimal / merge-key / binary / timestamps are NOT
    // (we don't need any of those, and they confuse downstream
    // logic — e.g. `30s` accidentally interpreted as a sexagesimal
    // integer under DEFAULT_SCHEMA). Recursive alias cycles throw
    // at parse time. NON-recursive aliases are still accepted and
    // js-yaml materialises them as SHARED JS references (not deep
    // copies), so a billion-laughs-style YAML produces a small
    // shallow tree with aliased nodes — no memory amplification.
    // CAUTION: never `structuredClone()` / `JSON.parse(JSON.stringify())`
    // the parsed doc before the `objectDepth` guard runs — that
    // would expand aliases into deep copies and break the safety.
    // Numeric extensions `.nan` / `.inf` ARE parsed as `NaN` /
    // `Infinity`; downstream code that consumes numbers must
    // guard with `Number.isFinite` (see `parseHealthcheck`).
    doc = yaml.load(input.composeYaml, {
      schema: yaml.JSON_SCHEMA,
      json: true, // strict-mode JSON-compat: throws on duplicate keys
    });
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_YAML_PARSE_ERROR',
      path: '',
      message: err instanceof Error ? err.message.slice(0, 500) : 'YAML parse error',
    });
    return { spec: null, issues };
  }

  if (!isPlainObject(doc)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_NOT_AN_OBJECT',
      path: '',
      message: 'compose document must be a YAML mapping at the top level',
    });
    return { spec: null, issues };
  }

  // Depth guard: a deeply-nested YAML (recursive aliases banned by
  // FAILSAFE_SCHEMA, but multi-level maps still allowed) shouldn't
  // crash the parser. 16 levels is generous for legitimate compose.
  if (objectDepth(doc) > MAX_YAML_DEPTH) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_TOO_DEEPLY_NESTED',
      path: '',
      message: `compose document exceeds the max allowed nesting depth of ${MAX_YAML_DEPTH}`,
    });
    return { spec: null, issues };
  }

  // ─── Top-level keys ───
  const services = pickField(doc, 'services');
  const volumesField = pickField(doc, 'volumes');
  const configsField = pickField(doc, 'configs');
  const secretsField = pickField(doc, 'secrets');
  // networks/version/x-* accepted-but-ignored. Warn on networks
  // so the user knows that field is a no-op.
  if (doc.networks !== undefined) {
    issues.push({
      severity: 'warning',
      code: 'COMPOSE_NETWORKS_IGNORED',
      path: 'networks',
      message: 'Top-level `networks:` is ignored — every service joins the tenant namespace default network.',
    });
  }

  // Reject any TOP-LEVEL key we don't recognise. Catches typos +
  // future compose fields the parser hasn't been audited against.
  const knownTop = new Set(['services', 'volumes', 'configs', 'secrets', 'networks', 'version']);
  for (const k of Object.keys(doc)) {
    if (!knownTop.has(k) && !k.startsWith('x-')) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_UNKNOWN_TOP_LEVEL',
        path: k,
        message: `Unknown top-level compose key '${k}'.`,
        hint: 'Use `x-...` for custom extensions if you need to keep a non-spec field in the document.',
      });
    }
  }

  if (!isPlainObject(services)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_SERVICES_MISSING',
      path: 'services',
      message: '`services:` must be a non-empty mapping.',
    });
    return { spec: null, issues };
  }
  const serviceCount = Object.keys(services).length;
  if (serviceCount === 0) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_SERVICES_EMPTY',
      path: 'services',
      message: '`services:` is empty.',
    });
    return { spec: null, issues };
  }
  if (serviceCount > MAX_SERVICES) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_TOO_MANY_SERVICES',
      path: 'services',
      message: `compose stack has ${serviceCount} services; this release allows at most ${MAX_SERVICES}.`,
    });
    return { spec: null, issues };
  }

  // ─── Volumes (named only) ───
  const volumes: Record<string, CustomDeploymentVolumeDef> = {};
  if (volumesField !== undefined) {
    if (!isPlainObject(volumesField)) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_VOLUMES_NOT_MAP',
        path: 'volumes',
        message: '`volumes:` must be a mapping of name→{}.',
      });
    } else {
      for (const [name, def] of Object.entries(volumesField)) {
        if (!VOLUME_NAME_RE.test(name)) {
          issues.push({
            severity: 'error',
            code: 'VOLUME_NAME_INVALID',
            path: `volumes.${name}`,
            message: `Volume name '${name}' must match the platform regex (lowercase segment, max 63 chars).`,
          });
          continue;
        }
        if (def !== null && isPlainObject(def) && def.external === true) {
          issues.push({
            severity: 'error',
            code: 'COMPOSE_FIELD_REJECTED',
            path: `volumes.${name}.external`,
            message: 'External volumes are not permitted — define a named volume that maps to a subPath on the tenant PVC.',
            hint: 'Drop the `external: true` line; data persists automatically on the tenant PVC.',
          });
          continue;
        }
        volumes[name] = {};
      }
    }
  }

  // ─── Inline ConfigMaps / Secrets ───
  const configMaps: CustomDeploymentConfigMap[] = [];
  if (configsField !== undefined) {
    extractInlineFiles(
      configsField,
      'configs',
      'CONFIGMAP',
      configMaps,
      issues,
      input.envFiles,
      0o644,
    );
  }
  const secrets: CustomDeploymentSecret[] = [];
  if (secretsField !== undefined) {
    extractInlineFiles(
      secretsField,
      'secrets',
      'SECRET',
      secrets,
      issues,
      input.envFiles,
      0o400,
    );
  }

  // ─── Services ───
  const parsedServices: Record<string, CustomDeploymentService> = {};
  for (const [name, raw] of Object.entries(services)) {
    if (!CUSTOM_NAME_RE.test(name)) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_SERVICE_NAME_INVALID',
        path: `services.${name}`,
        message: `Service name '${name}' must match the platform DNS-label regex.`,
      });
      continue;
    }
    const svc = parseService(name, raw, input.envFiles, issues);
    if (svc) parsedServices[name] = svc;
  }

  if (Object.keys(parsedServices).length === 0) {
    return { spec: null, issues };
  }

  // Auto-declare any named volume referenced by a mount but missing
  // from the top-level `volumes:` block. Compose tolerates this
  // (many tenants will forget the block entirely), so we make the
  // parser permissive but emit an info-level issue so the editor's
  // "Issues" tab still surfaces it.
  for (const [svcName, svc] of Object.entries(parsedServices)) {
    for (const vm of svc.volumeMounts) {
      if (!volumes[vm.name]) {
        volumes[vm.name] = {};
        issues.push({
          severity: 'info',
          code: 'COMPOSE_VOLUME_AUTO_DECLARED',
          path: `services.${svcName}.volumes`,
          message: `Volume '${vm.name}' was used by a mount but missing from the top-level volumes block; auto-declared.`,
        });
      }
    }
  }

  const spec: CustomDeploymentSpec = {
    specVersion: CUSTOM_SPEC_VERSION,
    sourceMode: 'compose',
    services: parsedServices,
    volumes,
    configMaps,
    secrets,
    allowRoot: false,
  };
  return { spec, issues };
}

// ─── Per-service parser ─────────────────────────────────────────────────────

function parseService(
  name: string,
  raw: unknown,
  envFiles: Readonly<Record<string, string>> | undefined,
  issues: CustomDeploymentIssue[],
): CustomDeploymentService | null {
  if (!isPlainObject(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_SERVICE_NOT_MAP',
      path: `services.${name}`,
      message: `Service '${name}' must be a mapping.`,
    });
    return null;
  }
  const path = `services.${name}`;

  // Reject every known-bad field first so the user sees them all in
  // one pass rather than one-by-one.
  const reject = (field: string, hint?: string): void => {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_REJECTED',
      path: `${path}.${field}`,
      message: `Compose field '${field}' is not supported on this platform.`,
      ...(hint ? { hint } : {}),
    });
  };
  for (const field of ['network_mode', 'cgroup_parent', 'pid', 'ipc', 'userns_mode', 'extends', 'build', 'external_links', 'links', 'runtime', 'devices', 'cap_drop', 'mac_address', 'cpus', 'mem_limit', 'mem_reservation', 'cpu_shares']) {
    if (raw[field] !== undefined) reject(field, rejectHint(field));
  }
  if (raw.privileged === true) reject('privileged', 'Privileged containers are not permitted on this platform.');

  // `init: true` was historically a tini opt-in. We don't honour it
  // (k8s pods already have a proper init), and silently ignoring it
  // would let a tenant assume tini-like PID-1 behaviour they're not
  // getting. Emit a warning so the editor's Issues pane surfaces it.
  if (raw.init === true) {
    issues.push({
      severity: 'warning',
      code: 'COMPOSE_INIT_IGNORED',
      path: `${path}.init`,
      message: '`init: true` is ignored — the Kubernetes runtime already provides a proper PID 1. Tenants needing tini-like reaping should build it into the image.',
    });
  }

  // `cap_add` — validate and collect allowed entries.
  const capAdd: Array<typeof ALLOWED_CAP_ADD[number]> = [];
  if (raw.cap_add !== undefined) {
    const list = Array.isArray(raw.cap_add) ? raw.cap_add : [];
    for (const cap of list) {
      if (typeof cap !== 'string' || !ALLOWED_CAP_ADD_SET.has(cap)) {
        reject('cap_add', `Only ${ALLOWED_CAP_ADD.join(', ')} is permitted via cap_add.`);
        break;
      } else {
        capAdd.push(cap as typeof ALLOWED_CAP_ADD[number]);
      }
    }
  }

  // `sysctls` — validate and collect allowed entries.
  const sysctls: Record<typeof ALLOWED_SYSCTLS[number], string> = {} as Record<typeof ALLOWED_SYSCTLS[number], string>;
  let hasSysctls = false;
  if (raw.sysctls !== undefined) {
    const entries: Array<[string, string]> = isPlainObject(raw.sysctls)
      ? Object.entries(raw.sysctls).map(([k, v]) => [k, String(v)])
      : Array.isArray(raw.sysctls)
        ? raw.sysctls
          .filter((s): s is string => typeof s === 'string')
          .map((s) => { const [k, ...rest] = s.split('='); return [k, rest.join('=')] as [string, string]; })
        : [];
    for (const [key, value] of entries) {
      if (!ALLOWED_SYSCTLS_SET.has(key)) {
        reject('sysctls', `Only ${ALLOWED_SYSCTLS.join(', ')} is permitted via sysctls.`);
        break;
      }
      sysctls[key as typeof ALLOWED_SYSCTLS[number]] = value;
      hasSysctls = true;
    }
  }

  // ─── Required: image ───
  if (typeof raw.image !== 'string' || raw.image.length === 0) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_IMAGE_REQUIRED',
      path: `${path}.image`,
      message: `Service '${name}' must declare an image (build:/Dockerfile is not supported).`,
    });
    return null;
  }
  const image = raw.image;

  // ─── command + entrypoint ───
  const entrypoint = parseStringArray(raw.entrypoint, `${path}.entrypoint`, issues);
  const command = parseStringArray(raw.command, `${path}.command`, issues);

  // ─── environment + env_file ───
  const env: CustomDeploymentEnv[] = [];
  if (raw.environment !== undefined) {
    const mapped = parseEnvironment(raw.environment, `${path}.environment`, issues);
    env.push(...mapped);
  }
  if (raw.env_file !== undefined) {
    const fromFiles = parseEnvFiles(raw.env_file, envFiles, `${path}.env_file`, issues);
    // env_file values are overridden by the inline environment block
    // per compose semantics; reverse-merge so that environment wins.
    const inlineNames = new Set(env.map((e) => e.name));
    for (const e of fromFiles) {
      if (!inlineNames.has(e.name)) env.push(e);
    }
  }

  // ─── ports ───
  const ports = parsePorts(raw.ports, `${path}.ports`, issues);

  // ─── volumes ───
  const volumeMounts = parseVolumeMounts(raw.volumes, `${path}.volumes`, issues);

  // ─── healthcheck ───
  const healthCheck = parseHealthcheck(raw.healthcheck, `${path}.healthcheck`, issues);

  // ─── depends_on (string list or condition map) ───
  const dependsOn = parseDependsOn(raw.depends_on, `${path}.depends_on`, issues);

  // ─── restart ───
  let restartPolicy: CustomDeploymentService['restartPolicy'] = 'Always';
  if (raw.restart !== undefined) {
    const mapped = RESTART_MAP[String(raw.restart)];
    if (mapped) {
      restartPolicy = mapped;
    } else {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_RESTART_INVALID',
        path: `${path}.restart`,
        message: `Invalid restart policy '${String(raw.restart)}'; allowed: ${Object.keys(RESTART_MAP).join(', ')}.`,
      });
    }
  }

  // ─── user / runAsUser parsing ───
  let runAsUser: number | undefined;
  let runAsGroup: number | undefined;
  if (raw.user !== undefined) {
    const u = String(raw.user);
    const [uidStr, gidStr] = u.split(':');
    const uid = parseInt(uidStr, 10);
    if (Number.isFinite(uid) && uid >= 0 && uid <= 65535) {
      runAsUser = uid;
    } else {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_USER_INVALID',
        path: `${path}.user`,
        message: `'user: ${u}' must use numeric uid[:gid]; names (e.g. 'root') are not supported because the platform cannot resolve them against the image.`,
      });
    }
    if (gidStr !== undefined) {
      const gid = parseInt(gidStr, 10);
      if (Number.isFinite(gid) && gid >= 0 && gid <= 65535) {
        runAsGroup = gid;
      } else {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_USER_INVALID',
          path: `${path}.user`,
          message: `'user: ${u}' gid component must be numeric.`,
        });
      }
    }
  }

  // ─── tmpfs ───
  const tmpfs: CustomDeploymentTmpfs[] = parseTmpfs(raw.tmpfs, `${path}.tmpfs`, issues);

  // ─── stop_grace_period ───
  let stopGracePeriodSeconds: number | undefined;
  if (raw.stop_grace_period !== undefined) {
    const secs = parseDurationSeconds(raw.stop_grace_period);
    if (secs === null || secs < 0 || secs > 300) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_STOP_GRACE_INVALID',
        path: `${path}.stop_grace_period`,
        message: `stop_grace_period must be a duration ≤ 300s.`,
      });
    } else {
      stopGracePeriodSeconds = secs;
    }
  }

  // ─── labels ───
  let labels: Record<string, string> | undefined;
  if (raw.labels !== undefined) {
    labels = parseLabels(raw.labels, `${path}.labels`, issues);
  }

  // ─── read_only / working_dir ───
  const readOnlyRootFilesystem = raw.read_only === true;
  const workingDir = typeof raw.working_dir === 'string' ? raw.working_dir : undefined;

  // ─── per-service configs / secrets → additional volumeMounts ───
  const configMountEntries = parseServiceFileMounts(
    raw.configs, `${path}.configs`, 'configMap', '/<name>', issues,
  );
  const secretMountEntries = parseServiceFileMounts(
    raw.secrets, `${path}.secrets`, 'secret', '/run/secrets/<name>', issues,
  );
  volumeMounts.push(...configMountEntries, ...secretMountEntries);

  return {
    image,
    ...(command && command.length > 0 ? { command } : {}),
    ...(entrypoint && entrypoint.length > 0 ? { entrypoint } : {}),
    env,
    ports,
    volumeMounts,
    resources: { cpuRequest: '100m', memoryRequest: '128Mi' },
    ...(healthCheck ? { healthCheck } : {}),
    restartPolicy,
    ...(runAsUser !== undefined ? { runAsUser } : {}),
    ...(runAsGroup !== undefined ? { runAsGroup } : {}),
    ...(workingDir ? { workingDir } : {}),
    readOnlyRootFilesystem,
    tmpfs,
    ...(stopGracePeriodSeconds !== undefined ? { stopGracePeriodSeconds } : {}),
    dependsOn,
    ...(labels ? { labels } : {}),
    capAdd,
    ...(hasSysctls ? { sysctls } : {}),
  };
}

// ─── Field parsers ─────────────────────────────────────────────────────────

function parseStringArray(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    // compose accepts a single string for entrypoint/command; in k8s
    // we wrap as `[shell, -c, "string"]` is NOT what we want here —
    // splitting naively would break quoting. Reject and tell the
    // user to use the array form.
    issues.push({
      severity: 'error',
      code: 'COMPOSE_STRING_FORM_REJECTED',
      path,
      message: `${path} must use the array form (['arg1', 'arg2']) so shell-quoting semantics are unambiguous.`,
    });
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be a string array.`,
    });
    return undefined;
  }
  return raw.map((v) => String(v));
}

function parseEnvironment(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentEnv[] {
  const out: CustomDeploymentEnv[] = [];
  if (isPlainObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      out.push({ name: k, value: v === null ? '' : String(v) });
    }
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_ENV_INVALID',
          path,
          message: `${path} entries must be 'KEY=value' strings.`,
        });
        continue;
      }
      const eq = entry.indexOf('=');
      if (eq === -1) {
        // compose's "KEY (no value)" inherits from the host env; we
        // do not have a host env to inherit from in the platform's
        // namespace context, so this is a no-op. Skip with a warning.
        issues.push({
          severity: 'warning',
          code: 'COMPOSE_ENV_HOST_INHERIT',
          path,
          message: `'${entry}' has no value; host-env inheritance is not supported. Set an explicit value or use valueFromSecret/valueFromConfigMap.`,
        });
        continue;
      }
      out.push({ name: entry.slice(0, eq), value: entry.slice(eq + 1) });
    }
    return out;
  }
  issues.push({
    severity: 'error',
    code: 'COMPOSE_FIELD_TYPE',
    path,
    message: `${path} must be a list or mapping.`,
  });
  return out;
}

function parseEnvFiles(
  raw: unknown,
  files: Readonly<Record<string, string>> | undefined,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentEnv[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be a string or array of strings.`,
    });
    return [];
  }
  const out: CustomDeploymentEnv[] = [];
  for (const fname of list) {
    if (typeof fname !== 'string') continue;
    const content = files?.[fname];
    if (content === undefined) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_ENV_FILE_MISSING',
        path,
        message: `env_file '${fname}' was referenced but not uploaded with the compose body.`,
        hint: 'Include the file in the `env_files` map when calling the create endpoint.',
      });
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        issues.push({
          severity: 'warning',
          code: 'COMPOSE_ENV_FILE_INVALID_LINE',
          path,
          message: `env_file '${fname}' contains a line with no '=': '${trimmed.slice(0, 40)}'`,
        });
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      out.push({ name: key, value });
    }
  }
  return out;
}

function parsePorts(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentPort[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be an array.`,
    });
    return [];
  }
  const out: CustomDeploymentPort[] = [];
  let portCounter = 0;
  for (const entry of raw) {
    const idx = portCounter++;
    if (typeof entry === 'string') {
      // Short form: "80", "8080:80", "8080:80/udp", "127.0.0.1:8080:80"
      // The host-side bits are silently dropped (k8s has no host
      // port concept here; the tenant declares the container port
      // only). The protocol suffix becomes the Service protocol.
      const match = /^(?:[^:]+:)?(\d+)(?::(\d+))?(?:\/(tcp|udp|sctp))?$/i.exec(entry);
      if (!match) {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_PORT_INVALID',
          path: `${path}[${idx}]`,
          message: `Port spec '${entry}' could not be parsed.`,
        });
        continue;
      }
      // For "8080:80" the LAST capture group is the container port
      // (because compose maps host→container). If there's only one
      // numeric, it's the container port.
      const containerPort = match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10);
      const protocol = (match[3] ?? 'TCP').toUpperCase() as 'TCP' | 'UDP' | 'SCTP';
      out.push({
        containerPort,
        name: synthesisePortName(containerPort, idx, protocol),
        protocol,
        exposeAsService: true,
        ingressEligible: false,
      });
      continue;
    }
    if (isPlainObject(entry)) {
      const target = entry.target;
      if (typeof target !== 'number') {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_PORT_INVALID',
          path: `${path}[${idx}]`,
          message: `Long-form port must declare a numeric \`target\`.`,
        });
        continue;
      }
      const protocol = (typeof entry.protocol === 'string' ? entry.protocol.toUpperCase() : 'TCP') as 'TCP' | 'UDP' | 'SCTP';
      const name = typeof entry.name === 'string' && PORT_NAME_RE.test(entry.name)
        ? entry.name
        : synthesisePortName(target, idx, protocol);
      out.push({
        containerPort: target,
        name,
        protocol,
        exposeAsService: true,
        ingressEligible: false,
      });
      continue;
    }
    issues.push({
      severity: 'error',
      code: 'COMPOSE_PORT_INVALID',
      path: `${path}[${idx}]`,
      message: `Port entry must be a string or long-form mapping.`,
    });
  }
  return out;
}

function synthesisePortName(port: number, idx: number, protocol: string): string {
  // RFC 6335: 1–15 chars, lowercase alphanumeric+hyphen, must contain
  // at least one letter, no leading/trailing hyphens, no consecutive
  // hyphens. `p<port>` is always valid; for idx > 0 we suffix the
  // protocol to dedupe in the rare case of two TCP/UDP entries on
  // the same port.
  const base = `p${port}`;
  if (idx === 0) return base;
  const proto = protocol.toLowerCase();
  return `${base}${proto}`.slice(0, 15);
}

function parseVolumeMounts(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentVolumeMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be an array.`,
    });
    return [];
  }
  const out: CustomDeploymentVolumeMount[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry === 'string') {
      // "source:target[:mode]". Source must be a NAMED volume — paths
      // (./data, /abs) are bind mounts and rejected.
      const parts = entry.split(':');
      const source = parts[0];
      const target = parts[1];
      const mode = parts[2];
      if (source === undefined || target === undefined) {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_VOLUME_INVALID',
          path: `${path}[${i}]`,
          message: `Volume entry '${entry}' must be 'source:target[:mode]'.`,
        });
        continue;
      }
      if (source.startsWith('/') || source.startsWith('.')) {
        issues.push({
          severity: 'error',
          code: 'BIND_MOUNT_NOT_PERMITTED',
          path: `${path}[${i}]`,
          message: `Bind mount '${entry}' is not permitted; use a named volume.`,
          hint: `Declare a named volume at the top level (e.g. 'volumes: { data: {} }') and reference it as 'data:${target}'.`,
        });
        continue;
      }
      if (!VOLUME_NAME_RE.test(source)) {
        issues.push({
          severity: 'error',
          code: 'VOLUME_NAME_INVALID',
          path: `${path}[${i}]`,
          message: `Named volume '${source}' must match the platform regex.`,
        });
        continue;
      }
      out.push({
        kind: 'volume' as const,
        name: source,
        containerPath: target,
        readOnly: mode === 'ro',
      });
      continue;
    }
    if (isPlainObject(entry)) {
      // Long-form: { type, source, target, read_only }.
      const type = String(entry.type ?? 'volume');
      if (type !== 'volume') {
        issues.push({
          severity: 'error',
          code: type === 'bind' ? 'BIND_MOUNT_NOT_PERMITTED' : 'COMPOSE_FIELD_REJECTED',
          path: `${path}[${i}].type`,
          message: type === 'bind'
            ? 'Bind mounts are not permitted; use a named volume.'
            : `Volume type '${type}' is not supported.`,
        });
        continue;
      }
      const source = entry.source;
      const target = entry.target;
      if (typeof source !== 'string' || typeof target !== 'string') {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_VOLUME_INVALID',
          path: `${path}[${i}]`,
          message: `Long-form volume must declare string source + target.`,
        });
        continue;
      }
      if (!VOLUME_NAME_RE.test(source)) {
        issues.push({
          severity: 'error',
          code: 'VOLUME_NAME_INVALID',
          path: `${path}[${i}]`,
          message: `Named volume '${source}' must match the platform regex.`,
        });
        continue;
      }
      out.push({
        kind: 'volume' as const,
        name: source,
        containerPath: target,
        readOnly: entry.read_only === true,
      });
      continue;
    }
    issues.push({
      severity: 'error',
      code: 'COMPOSE_VOLUME_INVALID',
      path: `${path}[${i}]`,
      message: `Volume entry must be a string or long-form mapping.`,
    });
  }
  return out;
}

function parseHealthcheck(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentHealthCheck | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_HEALTHCHECK_INVALID',
      path,
      message: `${path} must be a mapping.`,
    });
    return undefined;
  }
  if (raw.disable === true) return undefined;

  // Compose: test = ["CMD", "<binary>", "<arg>", ...] or
  //                ["CMD-SHELL", "<one shell line>"] or "NONE".
  const test = raw.test;
  if (test === 'NONE' || test === undefined) return undefined;

  let command: string[];
  if (Array.isArray(test) && test.length >= 1) {
    const head = String(test[0]);
    if (head === 'CMD') {
      command = test.slice(1).map((v) => String(v));
    } else if (head === 'CMD-SHELL') {
      command = ['/bin/sh', '-c', String(test[1] ?? '')];
    } else if (head === 'NONE') {
      return undefined;
    } else {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_HEALTHCHECK_INVALID',
        path: `${path}.test`,
        message: `healthcheck.test must start with 'CMD', 'CMD-SHELL', or 'NONE'.`,
      });
      return undefined;
    }
  } else if (typeof test === 'string') {
    command = ['/bin/sh', '-c', test];
  } else {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_HEALTHCHECK_INVALID',
      path: `${path}.test`,
      message: `healthcheck.test must be an array or 'NONE'.`,
    });
    return undefined;
  }
  if (command.length === 0) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_HEALTHCHECK_INVALID',
      path: `${path}.test`,
      message: `healthcheck.test must include a command.`,
    });
    return undefined;
  }

  // Resolve a positive-int duration field. Returns `null` and pushes
  // an error issue when the user SUPPLIED a value that's invalid
  // (NaN, Infinity, non-positive). Returns the `default` when the
  // user OMITTED the field. The distinction matters: silently
  // falling back to the default on a user-supplied sub-second value
  // (`interval: 100ms` → rounds to 0) would hide the mistake and
  // the kubelet would later reject the probe with a generic 422.
  const resolvePositiveDuration = (
    rawValue: unknown,
    fieldName: string,
    defaultValue: number,
  ): number | null => {
    if (rawValue === undefined) return defaultValue;
    const parsed = parseDurationSeconds(rawValue);
    if (parsed === null || !Number.isFinite(parsed) || parsed < 1) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_HEALTHCHECK_INVALID',
        path: `${path}.${fieldName}`,
        message: `healthcheck.${fieldName} must be a finite duration ≥ 1s (Kubernetes rejects sub-second probe values).`,
      });
      return null;
    }
    return parsed;
  };
  const interval = resolvePositiveDuration(raw.interval, 'interval', 10);
  const timeout = resolvePositiveDuration(raw.timeout, 'timeout', 1);
  if (interval === null || timeout === null) return undefined;

  const start_period = (() => {
    if (raw.start_period === undefined) return 0;
    const v = parseDurationSeconds(raw.start_period);
    // start_period can legitimately be 0; only reject NaN / negative /
    // Infinity.
    if (v === null || !Number.isFinite(v) || v < 0) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_HEALTHCHECK_INVALID',
        path: `${path}.start_period`,
        message: 'healthcheck.start_period must be a finite duration ≥ 0s.',
      });
      return null;
    }
    return v;
  })();
  if (start_period === null) return undefined;

  const retries = (typeof raw.retries === 'number' && Number.isFinite(raw.retries) && raw.retries >= 1)
    ? Math.min(20, Math.floor(raw.retries))
    : 3;

  return {
    type: 'exec',
    command,
    periodSeconds: interval,
    timeoutSeconds: timeout,
    initialDelaySeconds: start_period,
    failureThreshold: retries,
    successThreshold: 1,
  };
}

function parseDependsOn(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v));
  }
  if (isPlainObject(raw)) {
    // Condition map: { svc: { condition: service_started|service_healthy } }
    // We treat both conditions as ordering-only — the platform
    // initContainer polls the dependency's Service endpoint for
    // readiness regardless of which condition the user picked.
    return Object.keys(raw);
  }
  issues.push({
    severity: 'error',
    code: 'COMPOSE_FIELD_TYPE',
    path,
    message: `${path} must be a string array or condition mapping.`,
  });
  return [];
}

function parseTmpfs(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentTmpfs[] {
  if (raw === undefined) return [];
  const out: CustomDeploymentTmpfs[] = [];
  const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!entries) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be a string or array.`,
    });
    return [];
  }
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    // Allow "<path>" or "<path>:size=<bytes>" (compose syntax).
    const [pathPart, optPart] = entry.split(':');
    if (!pathPart.startsWith('/')) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_TMPFS_INVALID',
        path,
        message: `tmpfs path '${pathPart}' must be absolute.`,
      });
      continue;
    }
    let sizeMi = 64; // default — matches customTmpfsSchema's default
    if (optPart) {
      const m = /size=(\d+)([mMgG])?/.exec(optPart);
      if (m) {
        const n = parseInt(m[1], 10);
        sizeMi = m[2] && /[gG]/.test(m[2]) ? n * 1024 : n;
      }
    }
    out.push({ path: pathPart, sizeMi: Math.min(sizeMi, 256) });
  }
  return out;
}

function parseLabels(
  raw: unknown,
  path: string,
  issues: CustomDeploymentIssue[],
): Record<string, string> | undefined {
  if (isPlainObject(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = String(v);
    }
    return out;
  }
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) {
        out[entry] = '';
      } else {
        out[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    }
    return out;
  }
  issues.push({
    severity: 'error',
    code: 'COMPOSE_FIELD_TYPE',
    path,
    message: `${path} must be a mapping or array.`,
  });
  return undefined;
}

// ─── Per-service config/secret mount parsing ────────────────────────────────

/**
 * Parse a per-service `configs:` or `secrets:` block into volumeMount
 * entries with the appropriate `kind`. Compose has two forms:
 *
 *   Short:  - my-config                         → target: /<config-name>
 *   Long:   - source: my-config
 *               target: /etc/app/config.yaml
 *
 * For secrets, the compose default target `/run/secrets/<name>` is
 * blocked by the reserved-path regex — users MUST supply an explicit
 * target, or we emit an error.
 */
function parseServiceFileMounts(
  raw: unknown,
  path: string,
  kind: 'configMap' | 'secret',
  defaultTargetDescription: string,
  issues: CustomDeploymentIssue[],
): CustomDeploymentVolumeMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_FIELD_TYPE',
      path,
      message: `${path} must be an array.`,
    });
    return [];
  }
  const out: CustomDeploymentVolumeMount[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    let sourceName: string;
    let targetPath: string | undefined;

    if (typeof entry === 'string') {
      sourceName = entry;
      targetPath = kind === 'configMap' ? `/${entry}` : undefined;
    } else if (isPlainObject(entry)) {
      const src = entry.source;
      if (typeof src !== 'string' || src.length === 0) {
        issues.push({
          severity: 'error',
          code: 'COMPOSE_FIELD_TYPE',
          path: `${path}[${i}].source`,
          message: `${path}[${i}].source must be a non-empty string.`,
        });
        continue;
      }
      sourceName = src;
      targetPath = typeof entry.target === 'string' ? entry.target : undefined;
      if (!targetPath && kind === 'configMap') {
        targetPath = `/${sourceName}`;
      }
    } else {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_FIELD_TYPE',
        path: `${path}[${i}]`,
        message: `${path}[${i}] must be a string name or long-form mapping.`,
      });
      continue;
    }

    if (!targetPath) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_FIELD_REJECTED',
        path: `${path}[${i}]`,
        message: `${kind === 'secret' ? 'Secret' : 'Config'} '${sourceName}' must specify an explicit target path — the compose default (${defaultTargetDescription}) is a reserved system path on this platform.`,
        hint: `Add 'target: /etc/app/${sourceName}' (or another non-reserved path) to mount the ${kind === 'secret' ? 'secret' : 'config'}.`,
      });
      continue;
    }

    out.push({
      kind,
      name: sourceName,
      containerPath: targetPath,
      readOnly: true,
    });
  }
  return out;
}

// ─── Inline config/secret extraction ────────────────────────────────────────

function extractInlineFiles<T extends { name: string; content: string; mode: number }>(
  raw: unknown,
  topKey: string,
  errCodePrefix: 'CONFIGMAP' | 'SECRET',
  out: T[],
  issues: CustomDeploymentIssue[],
  envFiles: Readonly<Record<string, string>> | undefined,
  defaultMode: number,
): void {
  if (!isPlainObject(raw)) {
    issues.push({
      severity: 'error',
      code: `${errCodePrefix}_FIELD_TYPE` as const,
      path: topKey,
      message: `${topKey} must be a mapping.`,
    });
    return;
  }
  for (const [name, def] of Object.entries(raw)) {
    if (!CUSTOM_NAME_RE.test(name)) {
      issues.push({
        severity: 'error',
        code: `${errCodePrefix}_NAME_INVALID` as const,
        path: `${topKey}.${name}`,
        message: `${topKey} '${name}' must match the platform name regex.`,
      });
      continue;
    }
    if (def !== null && isPlainObject(def) && def.external === true) {
      issues.push({
        severity: 'error',
        code: 'COMPOSE_FIELD_REJECTED',
        path: `${topKey}.${name}.external`,
        message: `external ${topKey} are not permitted; provide inline content via 'file:' or 'content:'.`,
      });
      continue;
    }
    let content = '';
    if (isPlainObject(def) && typeof def.content === 'string') {
      content = def.content;
    } else if (isPlainObject(def) && typeof def.file === 'string') {
      const fileContent = envFiles?.[def.file];
      if (fileContent === undefined) {
        issues.push({
          severity: 'error',
          code: `${errCodePrefix}_FILE_MISSING` as const,
          path: `${topKey}.${name}.file`,
          message: `${topKey} '${name}' references file '${def.file}' which was not uploaded with the compose body.`,
        });
        continue;
      }
      content = fileContent;
    } else {
      issues.push({
        severity: 'error',
        code: `${errCodePrefix}_BODY_REQUIRED` as const,
        path: `${topKey}.${name}`,
        message: `${topKey} '${name}' must declare 'content:' or 'file:'.`,
      });
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_INLINE_CONFIG_BYTES) {
      issues.push({
        severity: 'error',
        code: `${errCodePrefix}_TOO_LARGE` as const,
        path: `${topKey}.${name}`,
        message: `${topKey} '${name}' exceeds the 1 MiB inline cap.`,
      });
      continue;
    }
    out.push({ name, content, mode: defaultMode } as T);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickField(doc: Record<string, unknown>, key: string): unknown {
  return doc[key];
}

function objectDepth(v: unknown, current = 0): number {
  if (current > MAX_YAML_DEPTH + 1) return current; // short-circuit
  if (Array.isArray(v)) {
    let max = current;
    for (const item of v) max = Math.max(max, objectDepth(item, current + 1));
    return max;
  }
  if (isPlainObject(v)) {
    let max = current;
    for (const item of Object.values(v)) max = Math.max(max, objectDepth(item, current + 1));
    return max;
  }
  return current;
}

function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Math.floor(raw);
  if (typeof raw !== 'string') return null;
  // Compose duration: <num><unit> where unit ∈ {s,ms,m,h}.
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? 's';
  const seconds: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  // floor (not round) so a sub-second value like `500ms` resolves
  // to 0 and is then rejected by the caller's `>= 1` check rather
  // than rounding up to 1 and silently coercing the user's value.
  return Math.floor(n * seconds[unit]);
}

function rejectHint(field: string): string | undefined {
  switch (field) {
    case 'network_mode': return 'Tenant pods always run on the tenant\'s default network.';
    case 'cap_drop': return 'Capabilities are dropped to PSS baseline automatically; cap_drop is unnecessary.';
    case 'devices': return 'Host device passthrough is not permitted.';
    case 'cgroup_parent': return 'cgroup placement is managed by Kubernetes.';
    case 'pid':
    case 'ipc':
    case 'userns_mode':
      return 'Host namespace sharing is not permitted.';
    case 'extends': return 'Inline all definitions; extends is not supported.';
    case 'build': return 'Build images in CI (e.g. GitHub Actions to GHCR) and reference the pushed digest here.';
    case 'external_links':
    case 'links':
      return 'Use `depends_on` and service-name DNS for service-to-service connections.';
    case 'runtime': return 'Only the default container runtime is available.';
    case 'mac_address': return 'Host network customisation is not permitted.';
    case 'cpus':
    case 'mem_limit':
    case 'mem_reservation':
    case 'cpu_shares':
      return 'Use the platform\'s `resources` block instead of compose\'s legacy CPU/memory fields.';
    default: return undefined;
  }
}
