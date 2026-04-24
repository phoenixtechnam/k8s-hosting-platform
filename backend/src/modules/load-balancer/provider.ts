/**
 * M11: Load Balancer provider abstraction.
 *
 * ADR-031 §8 — the platform stays vendor-neutral by default. Tenant
 * traffic uses DNS-RR to per-worker public IPs (the M3 model);
 * system traffic can optionally sit behind a provider-managed LB
 * once the cluster reaches 3+ servers and the HA benefit outweighs
 * the cost.
 *
 * This module defines the minimal interface every LB implementation
 * must expose. Only `NullProvider` is shippable today; the other
 * providers are scaffolded so the routing code can already reference
 * them without a follow-up refactor when real integrations land.
 *
 * Activation is gated by:
 *   - platform_settings key `load_balancer.enabled` (boolean, default false)
 *   - platform_settings key `load_balancer.provider` (null|hetzner|aws|metallb)
 *   - a cluster_nodes count check: server count ≥ 3 (see enforceHaGate)
 */

import { ApiError } from '../../shared/errors.js';

export type LoadBalancerProviderName = 'null' | 'hetzner' | 'aws' | 'metallb';

export interface LoadBalancerTarget {
  readonly name: string;       // human-readable id ("admin-panel-lb")
  readonly hostname: string;   // FQDN to route (admin.phoenix-host.net)
  readonly ports: readonly { readonly src: number; readonly dst: number; readonly proto: 'tcp' | 'udp' }[];
  readonly backendIps: readonly string[]; // server node public IPs
}

export interface LoadBalancerHandle {
  readonly providerId: string;   // provider-specific resource id
  readonly publicIp: string;     // the IP the LB exposes
  readonly hostname: string;     // what DNS should CNAME to
}

export interface LoadBalancerProvider {
  readonly name: LoadBalancerProviderName;
  /** Create or update an LB matching the target. Idempotent. */
  ensure(target: LoadBalancerTarget): Promise<LoadBalancerHandle>;
  /** Tear down an LB by its provider id. Idempotent — no-op if absent. */
  remove(providerId: string): Promise<void>;
  /** Probe the LB is reachable; used by the admin UI health badge. */
  status(providerId: string): Promise<{ readonly healthy: boolean; readonly message?: string }>;
}

/**
 * NullProvider — the vendor-neutral default. "Creating" an LB returns
 * a no-op handle; DNS still points directly at the server node IPs.
 * Operators running on a single server, on a bare-metal cluster
 * without MetalLB yet, or during dev all land on NullProvider.
 */
export class NullProvider implements LoadBalancerProvider {
  readonly name = 'null' as const;

  async ensure(target: LoadBalancerTarget): Promise<LoadBalancerHandle> {
    // The first backend IP is the "public address". Callers treat
    // the NullProvider as DNS-RR-ready.
    const publicIp = target.backendIps[0] ?? '0.0.0.0';
    return {
      providerId: `null-${target.name}`,
      publicIp,
      hostname: target.hostname,
    };
  }

  async remove(_providerId: string): Promise<void> {
    // No external resource to delete.
  }

  async status(_providerId: string): Promise<{ readonly healthy: boolean; readonly message?: string }> {
    return { healthy: true, message: 'NullProvider — LB bypassed, DNS-RR only' };
  }
}

/**
 * HetznerProvider — stub. Real implementation needs the hcloud
 * Go SDK or REST client + the HCLOUD_TOKEN secret + a
 * NetworkPolicy allowing the backend to reach api.hetzner.cloud.
 * See M11 follow-up work; activation lives behind the
 * enforceHaGate check in service.ts.
 */
export class HetznerProvider implements LoadBalancerProvider {
  readonly name = 'hetzner' as const;

  async ensure(_target: LoadBalancerTarget): Promise<LoadBalancerHandle> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'HetznerProvider is not yet implemented. Set provider back to "null" or pick a different provider.', 501);
  }

  async remove(_providerId: string): Promise<void> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'HetznerProvider is not yet implemented.', 501);
  }

  async status(_providerId: string): Promise<{ readonly healthy: boolean; readonly message?: string }> {
    return { healthy: false, message: 'HetznerProvider not yet implemented' };
  }
}

/**
 * AWSProvider — stub. A future integration uses the AWS SDK's ELBv2
 * client. Scope TBD (NLB vs ALB depends on whether we want L4 or L7
 * termination — L4 keeps TLS on our nginx and is the recommended
 * default to avoid re-configuring cert-manager).
 */
export class AWSProvider implements LoadBalancerProvider {
  readonly name = 'aws' as const;

  async ensure(_target: LoadBalancerTarget): Promise<LoadBalancerHandle> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'AWSProvider is not yet implemented.', 501);
  }

  async remove(_providerId: string): Promise<void> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'AWSProvider is not yet implemented.', 501);
  }

  async status(_providerId: string): Promise<{ readonly healthy: boolean; readonly message?: string }> {
    return { healthy: false, message: 'AWSProvider not yet implemented' };
  }
}

/**
 * MetalLBProvider — stub. On bare-metal clusters without a cloud LB,
 * MetalLB announces a VIP via BGP or L2. Implementation shape: create
 * `IPAddressPool` + `L2Advertisement` CRs and a Service of type
 * LoadBalancer — MetalLB watches these and assigns an IP from the
 * pool. The Service is the "handle" we return.
 */
export class MetalLBProvider implements LoadBalancerProvider {
  readonly name = 'metallb' as const;

  async ensure(_target: LoadBalancerTarget): Promise<LoadBalancerHandle> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'MetalLBProvider is not yet implemented.', 501);
  }

  async remove(_providerId: string): Promise<void> {
    throw new ApiError('PROVIDER_NOT_IMPLEMENTED', 'MetalLBProvider is not yet implemented.', 501);
  }

  async status(_providerId: string): Promise<{ readonly healthy: boolean; readonly message?: string }> {
    return { healthy: false, message: 'MetalLBProvider not yet implemented' };
  }
}

export function pickProvider(name: LoadBalancerProviderName): LoadBalancerProvider {
  switch (name) {
    case 'null':    return new NullProvider();
    case 'hetzner': return new HetznerProvider();
    case 'aws':     return new AWSProvider();
    case 'metallb': return new MetalLBProvider();
  }
}
