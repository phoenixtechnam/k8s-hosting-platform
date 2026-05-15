import { describe, it, expect } from 'vitest';
import { buildHaproxyDaemonSet, HAPROXY_DS_NAME, HAPROXY_DS_NAMESPACE } from './haproxy-builder.js';

describe('mail-admin/haproxy-builder.buildHaproxyDaemonSet', () => {
  it('produces a DaemonSet in the mail namespace with the expected name', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    expect(ds.kind).toBe('DaemonSet');
    expect(ds.apiVersion).toBe('apps/v1');
    expect(ds.metadata.name).toBe('stalwart-haproxy');
    expect(ds.metadata.namespace).toBe('mail');
    expect(HAPROXY_DS_NAME).toBe('stalwart-haproxy');
    expect(HAPROXY_DS_NAMESPACE).toBe('mail');
  });

  it('carries the managed-by=platform-api label so harness can identify it', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    expect(ds.metadata.labels['platform.phoenix-host.net/managed-by']).toBe('platform-api');
  });

  it('targets server-role nodes via nodeSelector', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    const sel = ds.spec.template.spec.nodeSelector;
    expect(sel).toEqual({ 'platform.phoenix-host.net/node-role': 'server' });
  });

  it('binds all six mail ports with hostPort=containerPort', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    const ports = ds.spec.template.spec.containers[0].ports as Array<{ containerPort: number; hostPort: number }>;
    const containerPorts = ports.map((p) => p.containerPort).sort((a, b) => a - b);
    expect(containerPorts).toEqual([25, 143, 465, 587, 993, 4190]);
    // hostPort must equal containerPort — that's the whole point of this DS.
    for (const p of ports) {
      expect(p.hostPort).toBe(p.containerPort);
    }
  });

  it('runs hostNetwork with ClusterFirstWithHostNet DNS so it can resolve in-cluster Services', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    expect(ds.spec.template.spec.hostNetwork).toBe(true);
    expect(ds.spec.template.spec.dnsPolicy).toBe('ClusterFirstWithHostNet');
  });

  it('runs as root with capabilities.drop=[ALL] + NET_BIND_SERVICE', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    const ctx = ds.spec.template.spec.containers[0].securityContext;
    expect(ctx.runAsUser).toBe(0);
    expect(ctx.capabilities.drop).toEqual(['ALL']);
    expect(ctx.capabilities.add).toEqual(['NET_BIND_SERVICE']);
    expect(ctx.readOnlyRootFilesystem).toBe(true);
    expect(ctx.allowPrivilegeEscalation).toBe(false);
  });

  it('mounts the stalwart-haproxy-config ConfigMap read-only at the expected path', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    const mounts = ds.spec.template.spec.containers[0].volumeMounts as Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
    const cfgMount = mounts.find((m) => m.name === 'haproxy-config');
    expect(cfgMount?.mountPath).toBe('/usr/local/etc/haproxy/haproxy.cfg');
    expect(cfgMount?.subPath).toBe('haproxy.cfg');
    expect(cfgMount?.readOnly).toBe(true);
    const cfgVol = (ds.spec.template.spec.volumes as Array<{ name: string; configMap?: { name: string } }>)
      .find((v) => v.name === 'haproxy-config');
    expect(cfgVol?.configMap?.name).toBe('stalwart-haproxy-config');
  });

  it('uses priorityClassName=system-node-critical for stable scheduling', () => {
    const ds = buildHaproxyDaemonSet() as Record<string, any>;
    expect(ds.spec.template.spec.priorityClassName).toBe('system-node-critical');
  });
});
