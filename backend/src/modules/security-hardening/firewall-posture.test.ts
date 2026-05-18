import { describe, it, expect, vi } from 'vitest';
import { buildFirewallPosture, DEFAULT_DENIED_WINDOW } from './firewall-posture.js';

interface FakeCrItem { status?: { family?: 'v4' | 'v6' } }

function buildMockCustom(ctrItems: FakeCrItem[], cppItems: FakeCrItem[]) {
  return {
    listClusterCustomObject: vi.fn().mockImplementation(({ plural }: { plural: string }) => {
      if (plural === 'clustertrustedranges') return Promise.resolve({ items: ctrItems });
      if (plural === 'clusterpendingpeers') return Promise.resolve({ items: cppItems });
      return Promise.resolve({ items: [] });
    }),
  } as unknown as Parameters<typeof buildFirewallPosture>[0];
}

describe('buildFirewallPosture', () => {
  it('counts CRs by family', async () => {
    const custom = buildMockCustom(
      [{ status: { family: 'v4' } }, { status: { family: 'v4' } }, { status: { family: 'v6' } }],
      [{ status: { family: 'v4' } }, { status: { family: 'v6' } }, { status: { family: 'v6' } }],
    );
    const posture = await buildFirewallPosture(custom, { publicPortsPerNode: [] });
    expect(posture.trustedRangesV4Count).toBe(2);
    expect(posture.trustedRangesV6Count).toBe(1);
    expect(posture.clusterPeersV4Count).toBe(1);
    expect(posture.clusterPeersV6Count).toBe(2);
  });

  it('returns default denied window when not supplied', async () => {
    const custom = buildMockCustom([], []);
    const posture = await buildFirewallPosture(custom, { publicPortsPerNode: [] });
    expect(posture.deniedCountWindow).toEqual(DEFAULT_DENIED_WINDOW);
  });

  it('uses set mode by default', async () => {
    const custom = buildMockCustom([], []);
    const posture = await buildFirewallPosture(custom, { publicPortsPerNode: [] });
    expect(posture.mode).toBe('set');
  });

  it('returns empty CR counts when the API errors', async () => {
    const custom = {
      listClusterCustomObject: vi.fn().mockRejectedValue(new Error('CRD missing')),
    } as unknown as Parameters<typeof buildFirewallPosture>[0];
    const posture = await buildFirewallPosture(custom, { publicPortsPerNode: [] });
    expect(posture.trustedRangesV4Count).toBe(0);
    expect(posture.clusterPeersV4Count).toBe(0);
  });
});
