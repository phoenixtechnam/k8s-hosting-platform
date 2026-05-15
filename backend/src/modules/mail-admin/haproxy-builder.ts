/**
 * stalwart-haproxy DaemonSet builder.
 *
 * 2026-05-14 streamline: the haproxy DS used to live in
 * k8s/base/stalwart-mail/haproxy/daemonset.yaml with a "disabled"
 * nodeSelector that platform-api flipped on/off via SSA. That setup
 * caused months of churn (PRs #43–#45) because Flux's kustomize-
 * controller and platform-api fought for ownership of the
 * `nodeSelector` field. Even with ssa:merge the failure modes were
 * subtle (MERGE_PATCH key-union, STRATEGIC_MERGE_PATCH field-removal
 * gotchas, "DS present but pinning zero pods").
 *
 * Cleaner ownership model: platform-api owns the DS entirely.
 *   - `thisNodeOnly` mode → DS is DELETED (Stalwart binds hostPort directly)
 *   - `allServerNodes` mode → DS is CREATED with server-role nodeSelector
 *
 * The ConfigMap (`stalwart-haproxy-config`) and NetworkPolicy stay
 * Flux-managed in `k8s/base/stalwart-mail/haproxy/`. Their content is
 * static and Flux is the natural source-of-truth for static config.
 *
 * The DS spec mirrors the previous YAML 1:1 (image, hostNetwork,
 * priorityClass, all six mail ports, runAsUser:0 + drop-all +
 * NET_BIND_SERVICE, livenessProbe, resources, configMap mount, /tmp
 * tmpfs). The verbatim port of the security commentary is in the
 * BUILDER_RATIONALE constant below to keep the same operational
 * documentation co-located with the code that emits the YAML.
 */

const NAMESPACE = 'mail';
const NAME = 'stalwart-haproxy';
const SERVER_ROLE_LABEL_KEY = 'platform.phoenix-host.net/node-role';
const SERVER_ROLE_LABEL_VALUE = 'server';

/**
 * The six mail ports haproxy forwards. Same set as the Stalwart
 * Deployment binds in `thisNodeOnly` mode. Keeping the structure
 * inline so a code reader sees exactly what gets exposed.
 */
const MAIL_PORTS = [
  { name: 'smtp', containerPort: 25 },
  { name: 'smtps', containerPort: 465 },
  { name: 'submission', containerPort: 587 },
  { name: 'imap', containerPort: 143 },
  { name: 'imaps', containerPort: 993 },
  { name: 'sieve', containerPort: 4190 },
] as const;

/**
 * Build the stalwart-haproxy DaemonSet manifest. Returns a plain JS
 * object suitable for `apps.createNamespacedDaemonSet({ namespace,
 * body })`. Single source of truth for the spec — port-exposure.ts,
 * unit tests, and the integration harness all reference the same
 * shape via this function.
 */
export function buildHaproxyDaemonSet(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: NAME,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'stalwart-haproxy',
        'app.kubernetes.io/part-of': 'hosting-platform',
        // Marker so the harness + future tooling can tell at a glance
        // that this object was platform-api-built and not Flux-managed.
        'platform.phoenix-host.net/managed-by': 'platform-api',
      },
      annotations: {
        'configmap.reloader.stakater.com/reload': 'stalwart-haproxy-config',
      },
    },
    spec: {
      selector: {
        matchLabels: { 'app.kubernetes.io/component': 'stalwart-haproxy' },
      },
      updateStrategy: { type: 'RollingUpdate' },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/component': 'stalwart-haproxy',
            'app.kubernetes.io/part-of': 'hosting-platform',
          },
        },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          priorityClassName: 'system-node-critical',
          nodeSelector: { [SERVER_ROLE_LABEL_KEY]: SERVER_ROLE_LABEL_VALUE },
          tolerations: [
            {
              key: 'platform.phoenix-host.net/server-only',
              operator: 'Exists',
              effect: 'NoSchedule',
            },
          ],
          terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: 'haproxy',
              image: 'haproxy:2.9-alpine',
              imagePullPolicy: 'IfNotPresent',
              // SECURITY: runAsUser:0 + dropALL + NET_BIND_SERVICE. The
              // haproxy:2.9-alpine image ends with `USER haproxy` (uid 99);
              // K8s adds caps to bounding but NOT effective for non-root.
              // Verified on staging that uid 99 fails to bind <1024. Root
              // inside the container with dropALL gives an empty effective
              // cap set after the bind — defense-in-depth via readOnly
              // rootfs + allowPrivilegeEscalation:false + RuntimeDefault.
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {
                  drop: ['ALL'],
                  add: ['NET_BIND_SERVICE'],
                },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              ports: MAIL_PORTS.map((p) => ({
                containerPort: p.containerPort,
                hostPort: p.containerPort,
                protocol: 'TCP',
                name: p.name,
              })),
              volumeMounts: [
                {
                  name: 'haproxy-config',
                  mountPath: '/usr/local/etc/haproxy/haproxy.cfg',
                  subPath: 'haproxy.cfg',
                  readOnly: true,
                },
                // Writable tmpfs for the haproxy stats socket.
                { name: 'haproxy-run', mountPath: '/tmp' },
              ],
              livenessProbe: {
                exec: {
                  command: [
                    'sh', '-c',
                    "echo 'show info' | socat - /tmp/haproxy.sock | grep -q 'Uptime'",
                  ],
                },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '200m', memory: '128Mi' },
              },
            },
          ],
          volumes: [
            {
              name: 'haproxy-config',
              configMap: { name: 'stalwart-haproxy-config' },
            },
            {
              name: 'haproxy-run',
              emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
            },
          ],
        },
      },
    },
  };
}

export const HAPROXY_DS_NAMESPACE = NAMESPACE;
export const HAPROXY_DS_NAME = NAME;
