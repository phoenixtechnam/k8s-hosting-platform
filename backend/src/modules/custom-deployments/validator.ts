// Semantic validator for CustomDeploymentSpec. Runs AFTER Zod has
// accepted the shape — Zod handles the structural/lexical contract
// (regex, types, length caps). This layer enforces the cross-field
// rules + the policy-level checks the schema can't express:
//
//   1. Pod-spec deny-list — `runAsUser:0` requires admin allowRoot
//   2. Reference integrity — volumeMount.name → volumes, dependsOn → services
//   3. Cycle detection in dependsOn
//   4. Per-deployment limits — at most ONE ingressEligible port in Phase 1
//   5. Resource limits sanity (cpuLimit >= cpuRequest etc.)
//   6. Inline ConfigMap / Secret name uniqueness
//   7. Advisory warning for unpinned tags (toggled by system_settings)
//   8. Phase-1 service count cap (simple mode = 1; multi-service = PR-3)
//
// Output: `Issue[]`. The orchestrating service throws if any issue
// has severity 'error'. Warnings are returned to the caller (UI shows
// them in the editor preview tab).

import {
  CUSTOM_SPEC_VERSION,
  type CustomDeploymentSpec,
  type CustomDeploymentIssue,
  type CustomDeploymentService,
} from './schema.js';
import {
  parseImageReference,
  isPinnedReference,
} from './image-reference.js';

const MAX_INGRESS_ELIGIBLE_PORTS = 1;

/**
 * Max deployment-name length when the deployment will create k8s
 * Services. The Service name is `{deploymentName}-{portName}` — k8s
 * caps `metadata.name` at 63 chars (RFC 1123 DNS label). With a
 * 15-char port name (the PORT_NAME_RE upper bound) the deployment
 * name must be ≤ 47 chars or the Service creation fails at admission
 * with a 422. Reject early in the validator so the operator gets a
 * useful error before any cluster mutation.
 */
const MAX_DEPLOYMENT_NAME_WITH_SERVICES = 47;

export interface ValidatorContext {
  /** Role of the API caller. `allowRoot` is admin-only. */
  readonly callerRole: 'super_admin' | 'admin' | 'client_admin' | 'client_user';
  /** `system_settings.custom_deployments_warn_unpinned_tags`. */
  readonly warnUnpinnedTags: boolean;
  /** Phase 1 simple-mode: enforce exactly one service. Phase 2 compose
   *  parser passes false so multi-service stacks parse cleanly. */
  readonly singleServiceOnly: boolean;
  /** Deployment name. Optional because the validator is also called
   *  on a not-yet-named spec from the editor preview endpoint. When
   *  set, the Service-name-length check (47-char cap) fires; when
   *  absent, that check is deferred to the create call which will
   *  re-validate with the name set. */
  readonly deploymentName?: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly CustomDeploymentIssue[];
}

const k8sQty = /^([0-9]+(?:\.[0-9]+)?)(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;

/**
 * Pure validator. Returns the same shape regardless of severity so the
 * caller can present warnings AND errors together in the UI editor.
 * The "ok" boolean is true iff NO error-severity issue exists; warnings
 * leave it true.
 */
export function validateCustomSpec(
  spec: CustomDeploymentSpec,
  ctx: ValidatorContext,
): ValidationResult {
  const issues: CustomDeploymentIssue[] = [];

  // ─── 0. Spec-version sanity ───
  if (spec.specVersion !== CUSTOM_SPEC_VERSION) {
    issues.push({
      severity: 'error',
      code: 'SPEC_VERSION_UNSUPPORTED',
      path: 'specVersion',
      message: `Unsupported customSpec specVersion ${spec.specVersion}; this server understands ${CUSTOM_SPEC_VERSION}.`,
    });
  }

  const serviceNames = Object.keys(spec.services);

  // ─── 1. Phase-1 service count cap ───
  if (ctx.singleServiceOnly && serviceNames.length !== 1) {
    issues.push({
      severity: 'error',
      code: 'COMPOSE_NOT_SUPPORTED_YET',
      path: 'services',
      message: 'Multi-service stacks (compose) are not supported in this release; submit one service at a time.',
      hint: 'Use the compose YAML editor in the next release, or split the stack into individual deployments now.',
    });
  }

  // ─── 2. allowRoot gating ───
  // The flag is admin-only. Tenants can't set it via the create
  // schemas (PR-1 removed allow_root from the tenant inputs), but if
  // a stored spec carries allowRoot=true it must have been admin-set.
  // Independently check: if any service runs as uid/gid 0 but
  // allowRoot is false, the deploy would be rejected at k8s PSS
  // baseline anyway — fail fast here with a clear message.
  for (const [name, svc] of Object.entries(spec.services)) {
    const runsAsRoot = svc.runAsUser === 0 || svc.runAsGroup === 0;
    if (runsAsRoot && !spec.allowRoot) {
      issues.push({
        severity: 'error',
        code: 'ROOT_REQUIRES_ALLOW_ROOT',
        path: `services.${name}.runAsUser`,
        message: 'Service declares runAsUser:0 or runAsGroup:0 but allowRoot is not set; admin override required.',
        hint: 'Ask an admin to set allowRoot on this deployment, or pick a non-zero uid/gid.',
      });
    }
  }
  // Setting allowRoot is admin-only regardless of whether anything
  // currently runs as root. Surfacing this at validate time means a
  // non-admin who somehow constructed a spec with allowRoot=true gets
  // a clear rejection rather than the spec landing silently.
  if (spec.allowRoot && !isAdminRole(ctx.callerRole)) {
    issues.push({
      severity: 'error',
      code: 'ALLOW_ROOT_REQUIRES_ADMIN',
      path: 'allowRoot',
      message: 'allowRoot can only be set by an admin.',
    });
  }

  // ─── 3. Reference integrity (per service) ───
  const declaredVolumeNames = new Set(Object.keys(spec.volumes));
  const declaredConfigMapNames = new Set(spec.configMaps.map((c) => c.name));
  const declaredSecretNames = new Set(spec.secrets.map((s) => s.name));

  for (const [name, svc] of Object.entries(spec.services)) {
    // volumeMounts → volumes
    for (const vm of svc.volumeMounts) {
      if (!declaredVolumeNames.has(vm.name)) {
        issues.push({
          severity: 'error',
          code: 'VOLUME_NOT_DECLARED',
          path: `services.${name}.volumeMounts`,
          message: `volumeMount references undeclared volume '${vm.name}'.`,
          hint: `Add an entry under top-level volumes.${vm.name}.`,
        });
      }
    }

    // env.valueFromSecret / valueFromConfigMap → declared inline names
    for (const e of svc.env) {
      if (e.valueFromSecret && !declaredSecretNames.has(e.valueFromSecret)) {
        issues.push({
          severity: 'error',
          code: 'ENV_SECRET_NOT_DECLARED',
          path: `services.${name}.env`,
          message: `Env '${e.name}' references undeclared secret '${e.valueFromSecret}'.`,
        });
      }
      if (e.valueFromConfigMap && !declaredConfigMapNames.has(e.valueFromConfigMap)) {
        issues.push({
          severity: 'error',
          code: 'ENV_CONFIGMAP_NOT_DECLARED',
          path: `services.${name}.env`,
          message: `Env '${e.name}' references undeclared configMap '${e.valueFromConfigMap}'.`,
        });
      }
    }

    // dependsOn → services
    for (const dep of svc.dependsOn) {
      if (!serviceNames.includes(dep)) {
        issues.push({
          severity: 'error',
          code: 'DEPENDS_ON_UNKNOWN_SERVICE',
          path: `services.${name}.dependsOn`,
          message: `dependsOn references undeclared service '${dep}'.`,
        });
      }
      if (dep === name) {
        issues.push({
          severity: 'error',
          code: 'DEPENDS_ON_SELF',
          path: `services.${name}.dependsOn`,
          message: 'A service cannot depend on itself.',
        });
      }
    }

    // Port name uniqueness within the service
    const portNames = new Set<string>();
    for (const p of svc.ports) {
      if (portNames.has(p.name)) {
        issues.push({
          severity: 'error',
          code: 'PORT_NAME_DUPLICATE',
          path: `services.${name}.ports`,
          message: `Duplicate port name '${p.name}' within service '${name}'.`,
        });
      }
      portNames.add(p.name);
    }

    // Resource limits sanity
    const r = svc.resources;
    if (r.cpuLimit && !cpuLimitAtLeastRequest(r.cpuRequest, r.cpuLimit)) {
      issues.push({
        severity: 'error',
        code: 'CPU_LIMIT_BELOW_REQUEST',
        path: `services.${name}.resources.cpuLimit`,
        message: `cpuLimit (${r.cpuLimit}) must be greater than or equal to cpuRequest (${r.cpuRequest}).`,
      });
    }
    if (r.memoryLimit && !memoryLimitAtLeastRequest(r.memoryRequest, r.memoryLimit)) {
      issues.push({
        severity: 'error',
        code: 'MEMORY_LIMIT_BELOW_REQUEST',
        path: `services.${name}.resources.memoryLimit`,
        message: `memoryLimit (${r.memoryLimit}) must be greater than or equal to memoryRequest (${r.memoryRequest}).`,
      });
    }

    // Image-tag pinning advisory (no enforcement — user override).
    const ref = parseImageReference(svc.image);
    if (ctx.warnUnpinnedTags && ref && !isPinnedReference(ref)) {
      issues.push({
        severity: 'warning',
        code: 'UNPINNED_TAG_ADVISORY',
        path: `services.${name}.image`,
        message: `Image '${svc.image}' is unpinned (no version tag or :latest). Pulled image content can change without your knowledge.`,
        hint: 'Consider pinning to a specific tag (`nginx:1.27.3`) or digest (`nginx@sha256:…`).',
      });
    }
  }

  // ─── 4. depends_on cycles (DFS) ───
  for (const start of serviceNames) {
    const path: string[] = [];
    const visiting = new Set<string>();
    if (hasCycle(start, spec.services, visiting, path)) {
      issues.push({
        severity: 'error',
        code: 'DEPENDS_ON_CYCLE',
        path: `services.${path[0] ?? start}.dependsOn`,
        message: `dependsOn forms a cycle: ${path.join(' → ')} → ${path[0]}`,
      });
      break; // one cycle report is enough
    }
  }

  // ─── 4a. k8s resource name length caps ───
  // Single-service: Deployment = {deploymentName},                Service = {deploymentName}-{portName}
  // Multi-service:  Deployment = {deploymentName}-{serviceName},  Service = {deploymentName}-{serviceName}-{portName}
  //
  // k8s rejects names > 63 chars (RFC 1123 DNS label). Port names
  // are 15 chars max via PORT_NAME_RE. Single-service therefore
  // caps deploymentName at 63 - 1 - 15 = 47 when ports are exposed.
  // Multi-service must additionally accommodate the longest
  // service-name segment in the middle.
  if (ctx.deploymentName !== undefined) {
    const willCreateServices = Object.values(spec.services)
      .some((svc) => svc.ports.some((p) => p.exposeAsService));
    if (willCreateServices) {
      if (ctx.singleServiceOnly) {
        if (ctx.deploymentName.length > MAX_DEPLOYMENT_NAME_WITH_SERVICES) {
          issues.push({
            severity: 'error',
            code: 'DEPLOYMENT_NAME_TOO_LONG_FOR_SERVICE',
            path: 'name',
            message: `Deployment name is ${ctx.deploymentName.length} chars; k8s Service names (${ctx.deploymentName}-<port>) would exceed the 63-char DNS label limit. Use a name ≤ ${MAX_DEPLOYMENT_NAME_WITH_SERVICES} chars.`,
            hint: 'Shorten the deployment name, or set `exposeAsService: false` on the ports.',
          });
        }
      } else {
        // Multi-service: worst-case Service name is
        // {dep}-{svc}-{port} = dep + svc + port + 2 separators.
        // With port ≤ 15, the budget for (dep + svc) is 63 - 1 - 15 - 1 = 46.
        // Iterate per-service so the editor surfaces EVERY offender
        // (not just one) — gives the operator a complete list of
        // names to shorten in a single pass.
        const remainingForService = 63 - 1 - 15 - 1 - ctx.deploymentName.length;
        for (const [svcName, svc] of Object.entries(spec.services)) {
          const svcExposesPorts = svc.ports.some((p) => p.exposeAsService);
          if (!svcExposesPorts) continue;
          const worstServiceResourceLen = ctx.deploymentName.length + 1 + svcName.length + 1 + 15;
          if (worstServiceResourceLen > 63) {
            issues.push({
              severity: 'error',
              code: 'MULTI_SERVICE_NAME_TOO_LONG',
              path: `services.${svcName}`,
              message: `Deployment name '${ctx.deploymentName}' (${ctx.deploymentName.length} chars) combined with service '${svcName}' (${svcName.length} chars) produces a k8s Service name > 63 chars (DNS label limit).`,
              hint: remainingForService > 0
                ? `Either shorten the deployment name or keep each service name ≤ ${remainingForService} chars.`
                : 'The deployment name is too long for multi-service stacks; pick a shorter deployment name.',
            });
          }
        }
      }
    }
  }

  // ─── 5. At most ONE ingressEligible port per deployment (Phase 1) ───
  const ingressEligibleCount = Object.values(spec.services)
    .flatMap((svc) => svc.ports.filter((p) => p.ingressEligible && p.exposeAsService))
    .length;
  if (ingressEligibleCount > MAX_INGRESS_ELIGIBLE_PORTS) {
    issues.push({
      severity: 'error',
      code: 'TOO_MANY_INGRESS_ELIGIBLE_PORTS',
      path: 'services',
      message: `At most ${MAX_INGRESS_ELIGIBLE_PORTS} ingressEligible port is allowed per deployment in this release. Found ${ingressEligibleCount}.`,
      hint: 'Mark only the primary HTTP port as ingressEligible; expose the others via routes in a future release.',
    });
  }

  // ─── 6. Inline ConfigMap / Secret name uniqueness ───
  assertUniqueNames(spec.configMaps.map((c) => c.name), 'configMaps', 'CONFIGMAP_NAME_DUPLICATE', issues);
  assertUniqueNames(spec.secrets.map((s) => s.name), 'secrets', 'SECRET_NAME_DUPLICATE', issues);

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isAdminRole(role: ValidatorContext['callerRole']): boolean {
  return role === 'super_admin' || role === 'admin';
}

function assertUniqueNames(
  names: readonly string[],
  path: string,
  code: string,
  issues: CustomDeploymentIssue[],
): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      issues.push({
        severity: 'error',
        code,
        path,
        message: `Duplicate name '${n}'.`,
      });
    }
    seen.add(n);
  }
}

function hasCycle(
  current: string,
  services: Readonly<Record<string, CustomDeploymentService>>,
  visiting: Set<string>,
  path: string[],
): boolean {
  if (visiting.has(current)) {
    // path is a list of nodes from the start of the recursion to here;
    // a cycle is detected when we re-enter `current`.
    return true;
  }
  visiting.add(current);
  path.push(current);
  const deps = services[current]?.dependsOn ?? [];
  for (const dep of deps) {
    if (services[dep] && hasCycle(dep, services, visiting, path)) {
      return true;
    }
  }
  visiting.delete(current);
  path.pop();
  return false;
}

/** Convert a k8s quantity string to a millicpu count. `250m` → 250,
 *  `1` → 1000, `1.5` → 1500. Falls back to NaN on parse failure. */
function cpuToMillis(qty: string): number {
  const m = k8sQty.exec(qty);
  if (!m) return Number.NaN;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === 'm') return n;
  if (unit === undefined) return n * 1000;
  return Number.NaN;
}

/** Convert a k8s memory quantity to bytes. Standard Mi/Gi (binary) and
 *  M/G (decimal) units are recognised; anything else returns NaN. */
function memToBytes(qty: string): number {
  const m = k8sQty.exec(qty);
  if (!m) return Number.NaN;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === undefined) return n; // bytes literal
  const table: Record<string, number> = {
    k: 1_000, M: 1_000_000, G: 1_000_000_000, T: 1_000_000_000_000,
    Ki: 1_024, Mi: 1_048_576, Gi: 1_073_741_824, Ti: 1_099_511_627_776,
    // 'm' was matched as the cpu millicpu suffix earlier; for memory
    // it would mean "milli-byte" which makes no sense — reject.
  };
  return table[unit] !== undefined ? n * table[unit] : Number.NaN;
}

function cpuLimitAtLeastRequest(request: string, limit: string): boolean {
  const r = cpuToMillis(request);
  const l = cpuToMillis(limit);
  // NaN comparisons are always false; treat unparseable as a passthrough
  // (Zod already caught syntactically-malformed quantities).
  if (!Number.isFinite(r) || !Number.isFinite(l)) return true;
  return l >= r;
}

function memoryLimitAtLeastRequest(request: string, limit: string): boolean {
  const r = memToBytes(request);
  const l = memToBytes(limit);
  if (!Number.isFinite(r) || !Number.isFinite(l)) return true;
  return l >= r;
}
