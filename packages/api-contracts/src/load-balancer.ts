import { z } from 'zod';

// M11 load-balancer admin API contracts.
//
// `config` is a provider-specific opaque bag — the platform doesn't
// inspect keys beyond the size/shape limits below. Capped at 32 KB
// of serialised JSON so a malicious payload can't fill platform_
// settings. Disallowed prototype-pollution keys so a future
// Object.assign() against the stored value can't taint prototypes.

export const loadBalancerProviderSchema = z.enum(['null', 'hetzner', 'aws', 'metallb']);
export type LoadBalancerProviderName = z.infer<typeof loadBalancerProviderSchema>;

const configValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(configValueSchema),
    z.record(z.string(), configValueSchema),
  ]),
);

export const loadBalancerConfigSchema = z
  .record(z.string(), configValueSchema)
  .refine((v) => !('__proto__' in v) && !('constructor' in v) && !('prototype' in v), {
    message: 'config contains disallowed key (__proto__ / constructor / prototype)',
  })
  .refine((v) => JSON.stringify(v).length <= 32_768, {
    message: 'config exceeds 32 KB serialised',
  });

export const updateLoadBalancerSchema = z.object({
  enabled: z.boolean().optional(),
  provider: loadBalancerProviderSchema.optional(),
  config: loadBalancerConfigSchema.optional(),
});
export type UpdateLoadBalancerInput = z.infer<typeof updateLoadBalancerSchema>;

export const loadBalancerStatusSchema = z.object({
  enabled: z.boolean(),
  provider: loadBalancerProviderSchema,
  haGate: z.object({
    met: z.boolean(),
    required: z.number(),
    current: z.number(),
  }),
  providerImplemented: z.boolean(),
  message: z.string(),
});
export type LoadBalancerStatusResponse = z.infer<typeof loadBalancerStatusSchema>;
