import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientRoleByMethod, requireClientAccess } from '../../middleware/auth.js';
import { writeFileInputSchema, createDirectoryInputSchema, renameInputSchema, deleteInputSchema, copyInputSchema, archiveInputSchema, extractInputSchema, gitCloneInputSchema, chmodInputSchema, chownInputSchema } from '@k8s-hosting/api-contracts';
import { clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { fileManagerRequest, streamToFileManager, getFileManagerStatus, ensureFileManagerRunning, stopFileManager } from './service.js';
import { recordFileManagerAccess } from './idle-cleanup.js';

// File-manager sidecar image. Default is the bare name used by local.sh
// which imports the image into DinD's containerd with that exact tag. On
// real clusters (staging/production) the platform-config ConfigMap
// provides the registry-qualified path via FILE_MANAGER_IMAGE.
const FM_IMAGE = process.env.FILE_MANAGER_IMAGE ?? 'file-manager-sidecar:latest';

async function resolveNamespace(app: FastifyInstance, clientId: string): Promise<string> {
  const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  if (client.provisioningStatus !== 'provisioned') {
    throw new ApiError('NOT_PROVISIONED', 'Client must be provisioned before accessing files', 409);
  }
  return client.kubernetesNamespace;
}

export async function fileManagerRoutes(app: FastifyInstance): Promise<void> {
  // Support ?token= query param for <img src> (browser can't set Authorization header)
  app.addHook('onRequest', (request, _reply, done) => {
    if (!request.headers.authorization) {
      const query = request.query as Record<string, string>;
      if (query.token) {
        request.headers.authorization = `Bearer ${query.token}`;
      }
    }
    done();
  });

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  // Register content type parser for binary uploads — do NOT buffer the body.
  // The upload-raw route streams request.raw directly to the sidecar.
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => {
    done(null, undefined);
  });
  // Accept multipart so the /upload handler can return a clean 410 Gone
  // instead of Fastify's generic "Unsupported Media Type" 415 (which the
  // error pipeline masks as a 500). We never actually parse the body —
  // the deprecated handler short-circuits before needing it.
  app.addContentTypeParser(/^multipart\//, (_req, _payload, done) => {
    done(null, undefined);
  });

  const getK8s = () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    return { k8sClients: createK8sClients(kubeconfigPath), kubeconfigPath };
  };

  // GET /api/v1/clients/:clientId/files/status — check file manager pod status
  app.get('/clients/:clientId/files/status', {
    schema: { tags: ['Files'], summary: 'Get file manager status', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    // Status polling counts as activity — without this, a UI that
    // sits on the loading screen for ~10min would have its pod
    // scaled back to 0 by the idle-cleanup loop while still being
    // actively waited-on by the user.
    recordFileManagerAccess(namespace, k8sClients);
    const status = await getFileManagerStatus(k8sClients, namespace);
    return success(status);
  });

  // POST /api/v1/clients/:clientId/files/start — start file manager pod
  app.post('/clients/:clientId/files/start', {
    schema: { tags: ['Files'], summary: 'Start file manager pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    await ensureFileManagerRunning(k8sClients, namespace, FM_IMAGE);
    // Refresh idle timer so the cleanup loop doesn't immediately
    // scale the pod we just asked for back down. /start is a clear
    // user intent to USE the file-manager.
    recordFileManagerAccess(namespace, k8sClients);
    const status = await getFileManagerStatus(k8sClients, namespace);
    return success(status);
  });

  // POST /api/v1/clients/:clientId/files/stop — stop file manager pod
  app.post('/clients/:clientId/files/stop', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['Files'], summary: 'Stop file manager pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    await stopFileManager(k8sClients, namespace);
    return success({ stopped: true });
  });

  // GET /api/v1/clients/:clientId/files/disk-usage — get disk usage
  app.get('/clients/:clientId/files/disk-usage', {
    schema: { tags: ['Files'], summary: 'Get disk usage', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);
    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/disk-usage', {});
    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to get disk usage', result.status);
    }
    return success(JSON.parse(result.body));
  });

  // GET /api/v1/clients/:clientId/files/folder-size — calculate folder size
  app.get('/clients/:clientId/files/folder-size', {
    schema: { tags: ['Files'], summary: 'Calculate folder size', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);
    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/folder-size', {
      query: { path: query.path },
    });
    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to calculate folder size', result.status);
    }
    return success(JSON.parse(result.body));
  });

  // GET /api/v1/clients/:clientId/files — list directory
  app.get('/clients/:clientId/files', {
    schema: { tags: ['Files'], summary: 'List directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    const path = query.path || '/';
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/ls', {
      query: { path },
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to list directory', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // GET /api/v1/clients/:clientId/files/read — read file content
  app.get('/clients/:clientId/files/read', {
    schema: { tags: ['Files'], summary: 'Read file content', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/read', {
      query: { path: query.path },
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to read file', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // GET /api/v1/clients/:clientId/files/download — download file
  app.get('/clients/:clientId/files/download', {
    schema: { tags: ['Files'], summary: 'Download file', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/download', {
      query: { path: query.path },
    });

    if (result.status !== 200) {
      throw new ApiError('FILE_ERROR', 'Failed to download file', result.status);
    }

    reply.header('Content-Type', result.headers['content-type'] || 'application/octet-stream');
    reply.header('Content-Disposition', result.headers['content-disposition'] || 'attachment');
    return reply.send(result.bodyBuffer);
  });

  // POST /api/v1/clients/:clientId/files/mkdir — create directory
  app.post('/clients/:clientId/files/mkdir', {
    schema: { tags: ['Files'], summary: 'Create directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDirectoryInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: parsed.data.path }),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to create directory', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/write — write file content
  app.post('/clients/:clientId/files/write', {
    schema: { tags: ['Files'], summary: 'Write file content', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = writeFileInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/write', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to write file', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/rename — rename/move
  app.post('/clients/:clientId/files/rename', {
    schema: { tags: ['Files'], summary: 'Rename file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = renameInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/rename', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to rename', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/delete — delete file or directory
  // Uses POST instead of DELETE because K8s API proxy can strip DELETE body
  app.post('/clients/:clientId/files/delete', {
    schema: { tags: ['Files'], summary: 'Delete file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = deleteInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/rm', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to delete', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/copy — copy file or directory
  app.post('/clients/:clientId/files/copy', {
    schema: { tags: ['Files'], summary: 'Copy file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = copyInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/copy', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to copy', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/archive — create archive
  app.post('/clients/:clientId/files/archive', {
    schema: { tags: ['Files'], summary: 'Create archive from files', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = archiveInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/archive', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to create archive', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/extract — extract archive
  app.post('/clients/:clientId/files/extract', {
    schema: { tags: ['Files'], summary: 'Extract archive', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = extractInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/extract', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to extract archive', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/git-clone — clone git repository
  app.post('/clients/:clientId/files/git-clone', {
    schema: { tags: ['Files'], summary: 'Clone git repository', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = gitCloneInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/git-clone', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to clone repository', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/chmod — change file/directory permissions
  app.post('/clients/:clientId/files/chmod', {
    schema: { tags: ['Files'], summary: 'Change file or directory permissions', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = chmodInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/chmod', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to change permissions', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/chown — change file/directory ownership
  app.post('/clients/:clientId/files/chown', {
    schema: { tags: ['Files'], summary: 'Change file or directory ownership', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = chownInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/chown', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to change ownership', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/upload-raw — streaming raw binary upload
  // No body limit — streams directly to sidecar without buffering
  app.post('/clients/:clientId/files/upload-raw', {
    schema: { tags: ['Files'], summary: 'Upload file (raw binary, streaming)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    // Ensure file manager is running
    await ensureFileManagerRunning(k8sClients, namespace, FM_IMAGE);
    const status = await getFileManagerStatus(k8sClients, namespace);
    if (!status.ready) throw new Error(`File manager not ready: ${status.message}`);

    // Stream the raw request body directly to the sidecar
    const result = await streamToFileManager(kubeconfigPath, namespace, '/write-raw', request.raw, {
      contentType: 'application/octet-stream',
      contentLength: request.headers['content-length'],
      query: { path: query.path },
    });

    if (result.status !== 200) {
      let errMsg = 'Failed to upload';
      try { errMsg = JSON.parse(result.body).error || errMsg; } catch { /* ignore parse error */ }
      throw new ApiError('FILE_ERROR', errMsg, result.status);
    }

    return reply.send(success(JSON.parse(result.body)));
  });

  // POST /api/v1/clients/:clientId/files/upload — deprecated multipart path.
  // Responds 410 Gone with a pointer to /upload-raw. The multipart handler
  // used to buffer the whole request body in memory inside the sidecar pod
  // (limits.memory=128Mi), which meant any upload over ~80 MiB OOM-killed
  // the sidecar. The streaming /upload-raw replacement has no in-RAM buffer
  // and is what the UI has used from the start. This stub stays so any
  // external tool still hitting the old URL gets a clear error instead of
  // a 404 guessing game.
  app.post('/clients/:clientId/files/upload', {
    schema: { tags: ['Files'], summary: 'Upload file (deprecated — use /upload-raw)', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    reply.status(410).send({
      error: {
        code: 'DEPRECATED_ENDPOINT',
        message: 'Multipart /files/upload was removed. Stream the body to /files/upload-raw instead (Content-Type: application/octet-stream, path=<dest> query).',
      },
    });
  });

  // POST /api/v1/clients/:clientId/files/fetch-url — download file from URL
  // Uses streaming proxy (not buffered fileManagerRequest) for real-time progress
  app.post('/clients/:clientId/files/fetch-url', {
    schema: { tags: ['Files'], summary: 'Download file from URL to PVC', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const { url, path: destPath, force } = request.body as { url?: string; path?: string; force?: boolean };
    if (!url || !destPath) throw new ApiError('MISSING_REQUIRED_FIELD', 'url and path required', 400);

    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    // Ensure file-manager is running, then stream response directly
    await ensureFileManagerRunning(k8sClients, namespace, FM_IMAGE);

    const { proxyToFileManagerStream } = await import('./service.js');
    await proxyToFileManagerStream(
      kubeconfigPath,
      namespace,
      '/fetch-url',
      JSON.stringify({ url, path: destPath, force: force ?? false }),
      reply.raw,
    );
    return reply;
  });

  // POST /api/v1/clients/:clientId/files/clone-site — clone entire website
  app.post('/clients/:clientId/files/clone-site', {
    schema: { tags: ['Files'], summary: 'Clone website to PVC', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const { url, path: destPath, maxPages, maxDepth, prettifyHtml, prettifyCss, prettifyJs } = request.body as {
      url?: string; path?: string; maxPages?: number; maxDepth?: number;
      prettifyHtml?: boolean; prettifyCss?: boolean; prettifyJs?: boolean;
    };
    if (!url || !destPath) throw new ApiError('MISSING_REQUIRED_FIELD', 'url and path required', 400);

    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();
    recordFileManagerAccess(namespace, k8sClients);

    await ensureFileManagerRunning(k8sClients, namespace, FM_IMAGE);

    const { proxyToFileManagerStream } = await import('./service.js');
    await proxyToFileManagerStream(
      kubeconfigPath,
      namespace,
      '/clone-site',
      JSON.stringify({ url, path: destPath, maxPages: maxPages ?? 50, maxDepth: maxDepth ?? 3, prettifyHtml: prettifyHtml ?? false, prettifyCss: prettifyCss ?? false, prettifyJs: prettifyJs ?? false }),
      reply.raw,
    );
    return reply;
  });
}
