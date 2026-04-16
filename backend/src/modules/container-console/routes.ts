import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { authenticate, type JwtPayload } from '../../middleware/auth.js';
import { isTokenDenied } from '../auth/routes.js';
import * as deploymentService from '../deployments/service.js';
import {
  fetchPods,
  listDeploymentComponents,
  createKubeConfig,
} from './service.js';

interface ConsoleParams {
  clientId: string;
  deploymentId: string;
}

interface ConsoleQuery {
  token?: string;
  component?: string;
  tailLines?: string;
  shell?: string;
}

const ALLOWED_SHELLS = new Set(['/bin/sh', '/bin/bash', '/bin/ash']);

function getK8s(app: FastifyInstance) {
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    return createK8sClients(kubeconfigPath);
  } catch {
    return undefined;
  }
}

function getKubeConfig(app: FastifyInstance): k8s.KubeConfig {
  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
  return createKubeConfig(kubeconfigPath);
}

function authenticateWs(app: FastifyInstance, request: FastifyRequest): JwtPayload {
  const query = request.query as ConsoleQuery;
  const token = query.token ?? request.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing authentication token', 401);

  if (isTokenDenied(token)) throw new ApiError('UNAUTHORIZED', 'Token has been revoked', 401);

  try {
    return app.jwt.verify<JwtPayload>(token);
  } catch {
    throw new ApiError('UNAUTHORIZED', 'Invalid token', 401);
  }
}

function enforceTenantAccess(user: JwtPayload, clientId: string): void {
  if (user.panel === 'client' && user.clientId && user.clientId !== clientId) {
    throw new ApiError('FORBIDDEN', 'Access denied to this client', 403);
  }
}

export async function containerConsoleRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/v1/clients/:clientId/deployments/:deploymentId/components
  app.get('/clients/:clientId/deployments/:deploymentId/components', {
    onRequest: [authenticate],
  }, async (request) => {
    const { clientId, deploymentId } = request.params as ConsoleParams;
    const deployment = await deploymentService.getDeploymentById(app.db, clientId, deploymentId);
    const namespace = await deploymentService.getClientNamespace(app.db, clientId);
    const k8sClients = getK8s(app);
    if (!k8sClients) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

    const pods = await fetchPods(k8sClients, namespace, deployment.name);
    const components = listDeploymentComponents(pods);

    return { data: components };
  });

  // WebSocket: /api/v1/clients/:clientId/deployments/:deploymentId/logs/stream
  app.get('/clients/:clientId/deployments/:deploymentId/logs/stream', {
    websocket: true,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, (socket, request) => {
    let user: JwtPayload;
    try {
      user = authenticateWs(app, request);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      socket.close(4401, 'Unauthorized');
      return;
    }

    const { clientId, deploymentId } = request.params as ConsoleParams;

    try {
      enforceTenantAccess(user, clientId);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }
    const query = request.query as ConsoleQuery;
    const componentFilter = query.component;
    const tailLines = Math.min(parseInt(query.tailLines ?? '100', 10) || 100, 1000);

    const streams: PassThrough[] = [];
    let closed = false;

    const cleanup = () => {
      closed = true;
      for (const s of streams) s.destroy();
      streams.length = 0;
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    (async () => {
      try {
        const deployment = await deploymentService.getDeploymentById(app.db, clientId, deploymentId);
        const namespace = await deploymentService.getClientNamespace(app.db, clientId);
        const k8sClients = getK8s(app);
        if (!k8sClients) {
          socket.send(JSON.stringify({ type: 'error', message: 'K8s unavailable' }));
          socket.close(4503, 'K8s unavailable');
          return;
        }

        const pods = await fetchPods(k8sClients, namespace, deployment.name);
        const components = listDeploymentComponents(pods);

        if (components.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: 'No running pods found' }));
          socket.close(4404, 'No pods');
          return;
        }

        const targets = componentFilter && componentFilter !== '*'
          ? components.filter((c) => c.name === componentFilter)
          : components;

        if (targets.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: `Component "${componentFilter}" not found` }));
          socket.close(4404, 'Component not found');
          return;
        }

        socket.send(JSON.stringify({
          type: 'connected',
          components: targets.map((c) => c.name),
        }));

        const kc = getKubeConfig(app);
        const log = new k8s.Log(kc);

        for (const target of targets) {
          if (closed) break;
          const stream = new PassThrough();
          streams.push(stream);

          log.log(namespace, target.podName, target.containerName, stream, {
            follow: true,
            tailLines,
            timestamps: true,
          }).catch(() => {
            stream.destroy();
          });

          let buffer = '';
          stream.on('data', (chunk: Buffer) => {
            if (closed) return;
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line) continue;
              const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)/);
              const upper = line.toUpperCase();
              let level = 'info';
              if (upper.includes('ERROR') || upper.includes('FATAL')) level = 'error';
              else if (upper.includes('WARN')) level = 'warning';

              try {
                socket.send(JSON.stringify({
                  type: 'log',
                  component: target.name,
                  timestamp: tsMatch?.[1] ?? new Date().toISOString(),
                  text: tsMatch?.[2] ?? line,
                  level,
                }));
              } catch {
                cleanup();
              }
            }
          });

          stream.on('error', () => { /* handled by cleanup */ });
          stream.on('end', () => {
            if (!closed) {
              socket.send(JSON.stringify({
                type: 'log',
                component: target.name,
                text: '--- log stream ended ---',
                level: 'info',
                timestamp: new Date().toISOString(),
              }));
            }
          });
        }

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (closed) { clearInterval(heartbeat); return; }
          try { socket.ping(); } catch { cleanup(); clearInterval(heartbeat); }
        }, 30_000);

        socket.on('close', () => clearInterval(heartbeat));
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'An internal error occurred';
        try {
          socket.send(JSON.stringify({ type: 'error', message: msg }));
          socket.close(4500, 'Internal error');
        } catch { /* already closed */ }
      }
    })();
  });

  // WebSocket: /api/v1/clients/:clientId/deployments/:deploymentId/terminal
  app.get('/clients/:clientId/deployments/:deploymentId/terminal', {
    websocket: true,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, (socket, request) => {
    let user: JwtPayload;
    try {
      user = authenticateWs(app, request);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      socket.close(4401, 'Unauthorized');
      return;
    }

    // Terminal access restricted to platform staff only
    const staffRoles = ['super_admin', 'admin'];
    if (!staffRoles.includes(user.role)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Terminal access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }

    const { clientId, deploymentId } = request.params as ConsoleParams;

    try {
      enforceTenantAccess(user, clientId);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }

    const query = request.query as ConsoleQuery;
    const componentName = query.component;
    const requestedShell = query.shell ?? '/bin/sh';
    const shell = ALLOWED_SHELLS.has(requestedShell) ? requestedShell : '/bin/sh';
    let closed = false;

    const cleanup = () => { closed = true; };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    (async () => {
      try {
        const deployment = await deploymentService.getDeploymentById(app.db, clientId, deploymentId);
        const namespace = await deploymentService.getClientNamespace(app.db, clientId);
        const k8sClients = getK8s(app);
        if (!k8sClients) {
          socket.send(JSON.stringify({ type: 'error', message: 'K8s unavailable' }));
          socket.close(4503, 'K8s unavailable');
          return;
        }

        const pods = await fetchPods(k8sClients, namespace, deployment.name);
        const components = listDeploymentComponents(pods);

        const target = componentName
          ? components.find((c) => c.name === componentName)
          : components[0];

        if (!target) {
          socket.send(JSON.stringify({ type: 'error', message: 'No running pod found for component' }));
          socket.close(4404, 'No pod');
          return;
        }

        socket.send(JSON.stringify({
          type: 'connected',
          component: target.name,
          pod: target.podName,
          shell,
        }));

        const kc = getKubeConfig(app);
        const exec = new k8s.Exec(kc);

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();

        const wsConn = await exec.exec(
          namespace,
          target.podName,
          target.containerName,
          [shell],
          stdout,
          stderr,
          stdin,
          true, // tty
        );

        stdout.on('data', (chunk: Buffer) => {
          if (closed) return;
          try {
            socket.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
          } catch { cleanup(); }
        });

        stderr.on('data', (chunk: Buffer) => {
          if (closed) return;
          try {
            socket.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
          } catch { cleanup(); }
        });

        socket.on('message', (raw: Buffer | string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
            if (msg.type === 'stdin' && typeof msg.data === 'string') {
              stdin.write(msg.data);
            } else if (msg.type === 'resize' && typeof msg.cols === 'number') {
              // K8s exec resize is handled via the WebSocket status channel
              // which @kubernetes/client-node manages internally for tty
            }
          } catch {
            // Raw text input as fallback
            stdin.write(typeof raw === 'string' ? raw : raw.toString());
          }
        });

        const onWsClose = () => {
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
          if (wsConn && typeof (wsConn as { close?: () => void }).close === 'function') {
            (wsConn as { close: () => void }).close();
          }
        };

        socket.on('close', onWsClose);

        stdout.on('end', () => {
          if (!closed) {
            socket.send(JSON.stringify({ type: 'exit', message: 'Shell exited' }));
            socket.close(1000, 'Shell exited');
          }
        });

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (closed) { clearInterval(heartbeat); return; }
          try { socket.ping(); } catch { cleanup(); clearInterval(heartbeat); }
        }, 30_000);

        socket.on('close', () => clearInterval(heartbeat));
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'An internal error occurred';
        try {
          socket.send(JSON.stringify({ type: 'error', message: msg }));
          socket.close(4500, 'Internal error');
        } catch { /* already closed */ }
      }
    })();
  });
}
