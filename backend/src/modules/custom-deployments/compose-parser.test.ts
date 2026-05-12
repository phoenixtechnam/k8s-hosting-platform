import { describe, it, expect } from 'vitest';
import { parseCompose } from './compose-parser.js';

function parse(yaml: string, envFiles?: Record<string, string>) {
  return parseCompose({ composeYaml: yaml, envFiles });
}

describe('parseCompose — happy paths', () => {
  it('parses a minimal one-service stack', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
`);
    expect(r.spec).not.toBeNull();
    expect(r.spec!.sourceMode).toBe('compose');
    expect(Object.keys(r.spec!.services)).toEqual(['web']);
    expect(r.spec!.services.web.image).toBe('nginx:1.27');
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('parses a two-service stack with depends_on', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    depends_on:
      - api
  api:
    image: ghcr.io/owner/api:1.0
`);
    expect(r.spec!.services.web.dependsOn).toEqual(['api']);
    expect(r.spec!.services.api.dependsOn).toEqual([]);
  });

  it('parses depends_on condition-map form (treated as ordering-only)', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    depends_on:
      api:
        condition: service_healthy
  api:
    image: api:1.0
`);
    expect(r.spec!.services.web.dependsOn).toEqual(['api']);
  });

  it('parses environment as map AND list', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    environment:
      DB_HOST: localhost
      LOG_LEVEL: debug
  api:
    image: api:1.0
    environment:
      - DB_HOST=remote
      - LOG_LEVEL=info
`);
    const webEnv = r.spec!.services.web.env;
    expect(webEnv).toContainEqual({ name: 'DB_HOST', value: 'localhost' });
    expect(webEnv).toContainEqual({ name: 'LOG_LEVEL', value: 'debug' });
    const apiEnv = r.spec!.services.api.env;
    expect(apiEnv).toContainEqual({ name: 'DB_HOST', value: 'remote' });
  });

  it('parses env_file and merges with inline environment (inline wins)', () => {
    const r = parse(
      `
services:
  web:
    image: nginx:1.27
    env_file:
      - .env
    environment:
      DB_HOST: explicit
`,
      { '.env': 'DB_HOST=from-file\nAPI_KEY=abc123\n# a comment\n\n' },
    );
    const env = r.spec!.services.web.env;
    expect(env.find((e) => e.name === 'DB_HOST')?.value).toBe('explicit');
    expect(env.find((e) => e.name === 'API_KEY')?.value).toBe('abc123');
  });

  it('reports a missing env_file', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    env_file: .missing
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_ENV_FILE_MISSING')).toBeDefined();
  });
});

describe('parseCompose — ports', () => {
  it('parses short-form "8080:80"', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
`);
    const ports = r.spec!.services.web.ports;
    expect(ports).toHaveLength(1);
    expect(ports[0].containerPort).toBe(80);
    expect(ports[0].protocol).toBe('TCP');
  });

  it('parses short-form with /udp', () => {
    const r = parse(`
services:
  dns:
    image: bind:9
    ports:
      - "5353:53/udp"
`);
    const port = r.spec!.services.dns.ports[0];
    expect(port.protocol).toBe('UDP');
    expect(port.containerPort).toBe(53);
  });

  it('parses long-form { target, protocol }', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    ports:
      - target: 8080
        protocol: tcp
`);
    const port = r.spec!.services.web.ports[0];
    expect(port.containerPort).toBe(8080);
    expect(port.protocol).toBe('TCP');
  });

  it('rejects malformed port strings', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    ports:
      - "not-a-port"
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_PORT_INVALID')).toBeDefined();
  });
});

describe('parseCompose — volumes', () => {
  it('parses named-volume short-form', () => {
    const r = parse(`
volumes:
  data: {}
services:
  web:
    image: nginx:1.27
    volumes:
      - "data:/var/www/html"
`);
    const mounts = r.spec!.services.web.volumeMounts;
    expect(mounts).toEqual([{ name: 'data', containerPath: '/var/www/html', readOnly: false }]);
  });

  it('parses :ro modifier', () => {
    const r = parse(`
volumes:
  data: {}
services:
  web:
    image: nginx:1.27
    volumes:
      - "data:/var/www/html:ro"
`);
    expect(r.spec!.services.web.volumeMounts[0].readOnly).toBe(true);
  });

  it('rejects bind mounts (`./path:/in-container`)', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    volumes:
      - "./html:/usr/share/nginx/html"
`);
    expect(r.issues.find((i) => i.code === 'BIND_MOUNT_NOT_PERMITTED')).toBeDefined();
  });

  it('rejects absolute-path bind mounts', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    volumes:
      - "/var/log:/log"
`);
    expect(r.issues.find((i) => i.code === 'BIND_MOUNT_NOT_PERMITTED')).toBeDefined();
  });

  it('rejects long-form type:bind', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    volumes:
      - type: bind
        source: ./data
        target: /data
`);
    expect(r.issues.find((i) => i.code === 'BIND_MOUNT_NOT_PERMITTED')).toBeDefined();
  });

  it('auto-declares a named volume referenced by mount but not declared at top level', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    volumes:
      - "cache:/cache"
`);
    expect(r.spec!.volumes.cache).toEqual({});
    expect(r.issues.find((i) => i.code === 'COMPOSE_VOLUME_AUTO_DECLARED')).toBeDefined();
  });

  it('rejects volumes: external: true', () => {
    const r = parse(`
volumes:
  shared:
    external: true
services:
  web:
    image: nginx:1.27
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_FIELD_REJECTED' && i.path.includes('external'))).toBeDefined();
  });
});

describe('parseCompose — healthcheck', () => {
  it('maps CMD form to exec probe', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: ["CMD", "/bin/healthy"]
      interval: 5s
      timeout: 2s
      retries: 4
`);
    const hc = r.spec!.services.web.healthCheck;
    expect(hc).toBeDefined();
    expect(hc!.type).toBe('exec');
    if (hc!.type === 'exec') expect(hc!.command).toEqual(['/bin/healthy']);
    expect(hc!.periodSeconds).toBe(5);
    expect(hc!.timeoutSeconds).toBe(2);
    expect(hc!.failureThreshold).toBe(4);
  });

  it('maps CMD-SHELL form to /bin/sh -c', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost"]
`);
    const hc = r.spec!.services.web.healthCheck!;
    if (hc.type === 'exec') {
      expect(hc.command).toEqual(['/bin/sh', '-c', 'curl -f http://localhost']);
    } else {
      throw new Error('expected exec probe');
    }
  });

  it('treats test: NONE as no healthcheck', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: NONE
`);
    expect(r.spec!.services.web.healthCheck).toBeUndefined();
  });

  it('treats disable: true as no healthcheck', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      disable: true
`);
    expect(r.spec!.services.web.healthCheck).toBeUndefined();
  });

  // Security review M-1 + code review M-1: k8s rejects sub-second probe
  // periods, so the parser must catch them at submit time.
  it('rejects sub-second interval (100ms rounds to 0)', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: ["CMD", "/bin/healthy"]
      interval: 100ms
`);
    const issue = r.issues.find((i) => i.code === 'COMPOSE_HEALTHCHECK_INVALID' && i.path.endsWith('.interval'));
    expect(issue).toBeDefined();
  });
  it('rejects sub-second timeout', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: ["CMD", "/bin/healthy"]
      timeout: 500ms
`);
    const issue = r.issues.find((i) => i.code === 'COMPOSE_HEALTHCHECK_INVALID' && i.path.endsWith('.timeout'));
    expect(issue).toBeDefined();
  });
  // Security review M-1: js-yaml's JSON_SCHEMA still admits .nan / .inf
  // as numeric extensions. The parser must guard with Number.isFinite
  // so they don't reach the rendered probe.
  it('rejects .nan / .inf timing without crashing', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    healthcheck:
      test: ["CMD", "/bin/healthy"]
      interval: .inf
`);
    // The check either rejects outright OR falls back to the default
    // 10s — either way the resulting probe must NOT carry Infinity.
    const hc = r.spec?.services.web.healthCheck;
    if (hc) {
      expect(Number.isFinite(hc.periodSeconds)).toBe(true);
    }
  });
});

describe('parseCompose — init: warning (PR-3 code-review M-3)', () => {
  it('warns when init: true is set', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    init: true
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_INIT_IGNORED')).toBeDefined();
  });
  it('does not warn when init is unset or false', () => {
    const r1 = parse(`
services:
  web:
    image: nginx:1.27
`);
    expect(r1.issues.find((i) => i.code === 'COMPOSE_INIT_IGNORED')).toBeUndefined();
    const r2 = parse(`
services:
  web:
    image: nginx:1.27
    init: false
`);
    expect(r2.issues.find((i) => i.code === 'COMPOSE_INIT_IGNORED')).toBeUndefined();
  });
});

describe('parseCompose — restart policy', () => {
  it('maps always → Always, on-failure → OnFailure, no → Never', () => {
    const r = parse(`
services:
  a:
    image: x:1
    restart: always
  b:
    image: x:1
    restart: on-failure
  c:
    image: x:1
    restart: no
`);
    expect(r.spec!.services.a.restartPolicy).toBe('Always');
    expect(r.spec!.services.b.restartPolicy).toBe('OnFailure');
    expect(r.spec!.services.c.restartPolicy).toBe('Never');
  });
  it('rejects an unknown policy', () => {
    const r = parse(`
services:
  a:
    image: x:1
    restart: maybe-later
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_RESTART_INVALID')).toBeDefined();
  });
});

describe('parseCompose — rejected fields', () => {
  const rejects = [
    ['network_mode', 'network_mode: host'],
    ['privileged', 'privileged: true'],
    ['devices', 'devices: ["/dev/snd:/dev/snd"]'],
    ['cgroup_parent', 'cgroup_parent: docker.slice'],
    ['pid', 'pid: host'],
    ['ipc', 'ipc: host'],
    ['userns_mode', 'userns_mode: host'],
    ['extends', 'extends:\n      service: base'],
    ['build', 'build: .'],
    ['external_links', 'external_links: ["db:db"]'],
    ['links', 'links: ["db"]'],
    ['runtime', 'runtime: nvidia'],
    ['cap_drop', 'cap_drop: ["NET_RAW"]'],
    ['mac_address', 'mac_address: 02:42:ac:11:00:02'],
    ['mem_limit', 'mem_limit: 1g'],
  ];

  it.each(rejects)('rejects %s', (field, body) => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    ${body}
`);
    const issue = r.issues.find((i) => i.path.endsWith(field));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('rejects cap_add for non-allowlisted capability', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    cap_add:
      - NET_RAW
`);
    expect(r.issues.find((i) => i.path.endsWith('cap_add'))).toBeDefined();
  });

  it('accepts cap_add: NET_BIND_SERVICE', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    cap_add:
      - NET_BIND_SERVICE
`);
    expect(r.issues.find((i) => i.path.endsWith('cap_add'))).toBeUndefined();
  });

  it('rejects unsafe sysctls', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    sysctls:
      net.ipv4.tcp_keepalive_time: 600
`);
    expect(r.issues.find((i) => i.path.endsWith('sysctls'))).toBeDefined();
  });

  it('accepts the allowlisted sysctl', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    sysctls:
      net.ipv4.ip_unprivileged_port_start: "80"
`);
    expect(r.issues.find((i) => i.path.endsWith('sysctls'))).toBeUndefined();
  });

  it('warns on top-level networks (ignored but allowed)', () => {
    const r = parse(`
networks:
  default: {}
services:
  web:
    image: nginx:1.27
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_NETWORKS_IGNORED')).toBeDefined();
    // Still produces a valid spec.
    expect(r.spec).not.toBeNull();
  });

  it('rejects unknown top-level keys but accepts x-* extensions', () => {
    const r = parse(`
x-custom-meta: anything
unknown_top: 42
services:
  web:
    image: nginx:1.27
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_UNKNOWN_TOP_LEVEL' && i.path === 'unknown_top')).toBeDefined();
    expect(r.issues.find((i) => i.path === 'x-custom-meta')).toBeUndefined();
  });
});

describe('parseCompose — configs + secrets', () => {
  it('parses inline configs.content', () => {
    const r = parse(`
configs:
  nginx-conf:
    content: |
      server { listen 80; }
services:
  web:
    image: nginx:1.27
`);
    expect(r.spec!.configMaps).toHaveLength(1);
    expect(r.spec!.configMaps[0].name).toBe('nginx-conf');
    expect(r.spec!.configMaps[0].content).toContain('listen 80');
  });

  it('resolves configs.file from envFiles', () => {
    const r = parse(
      `
configs:
  nginx-conf:
    file: ./nginx.conf
services:
  web:
    image: nginx:1.27
`,
      { './nginx.conf': 'server { listen 8080; }' },
    );
    expect(r.spec!.configMaps[0].content).toContain('listen 8080');
  });

  it('rejects external configs', () => {
    const r = parse(`
configs:
  shared:
    external: true
services:
  web:
    image: nginx:1.27
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_FIELD_REJECTED')).toBeDefined();
  });

  it('parses inline secrets and stores them with octal mode 0o400', () => {
    const r = parse(`
secrets:
  db-password:
    content: super-secret-pw
services:
  web:
    image: nginx:1.27
`);
    expect(r.spec!.secrets).toHaveLength(1);
    expect(r.spec!.secrets[0].mode).toBe(0o400);
    expect(r.spec!.secrets[0].content).toBe('super-secret-pw');
  });
});

describe('parseCompose — service limits + names', () => {
  it('caps services at 10', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `  svc${i}:\n    image: x:1`).join('\n');
    const r = parse(`services:\n${lines}`);
    expect(r.spec).toBeNull();
    expect(r.issues.find((i) => i.code === 'COMPOSE_TOO_MANY_SERVICES')).toBeDefined();
  });

  it('rejects service names that violate the platform regex', () => {
    const r = parse(`
services:
  Web-Server:
    image: nginx:1.27
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_SERVICE_NAME_INVALID')).toBeDefined();
  });

  it('rejects missing image', () => {
    const r = parse(`
services:
  web:
    command: ["nginx"]
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_IMAGE_REQUIRED')).toBeDefined();
  });
});

describe('parseCompose — error handling', () => {
  it('returns an error issue on malformed YAML', () => {
    const r = parse('services:\n  web:\n    image: : nope');
    expect(r.spec).toBeNull();
    expect(r.issues.find((i) => i.code === 'COMPOSE_YAML_PARSE_ERROR')).toBeDefined();
  });

  it('returns an error issue when the document is not an object', () => {
    const r = parse('"just a string"');
    expect(r.spec).toBeNull();
    expect(r.issues.find((i) => i.code === 'COMPOSE_NOT_AN_OBJECT')).toBeDefined();
  });

  it('rejects deeply nested documents', () => {
    let yaml = 'services:\n  web:\n    image: x:1\n    labels:\n';
    // Build a 20-deep nested map.
    let indent = '      ';
    for (let i = 0; i < 20; i++) {
      yaml += `${indent}level${i}:\n`;
      indent += '  ';
    }
    yaml += `${indent}leaf: 1\n`;
    const r = parse(yaml);
    expect(r.issues.find((i) => i.code === 'COMPOSE_TOO_DEEPLY_NESTED')).toBeDefined();
  });

  it('rejects string-form command/entrypoint (forces array form)', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    command: "echo hi"
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_STRING_FORM_REJECTED')).toBeDefined();
  });
});

describe('parseCompose — user / runAsUser', () => {
  it('parses numeric uid', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    user: "1001"
`);
    expect(r.spec!.services.web.runAsUser).toBe(1001);
  });
  it('parses uid:gid', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    user: "1001:2002"
`);
    expect(r.spec!.services.web.runAsUser).toBe(1001);
    expect(r.spec!.services.web.runAsGroup).toBe(2002);
  });
  it('rejects named users (e.g. "root")', () => {
    const r = parse(`
services:
  web:
    image: nginx:1.27
    user: root
`);
    expect(r.issues.find((i) => i.code === 'COMPOSE_USER_INVALID')).toBeDefined();
  });
});
