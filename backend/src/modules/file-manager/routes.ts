import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { writeFileInputSchema, createDirectoryInputSchema, renameInputSchema, deleteInputSchema, copyInputSchema, archiveInputSchema, extractInputSchema, gitCloneInputSchema } from '@k8s-hosting/api-contracts';
import { clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { fileManagerRequest, getFileManagerStatus, ensureFileManagerRunning, stopFileManager } from './service.js';

const FM_IMAGE = 'file-manager-sidecar:latest';

async function resolveNamespace(app: FastifyInstance, clientId: string): Promise<string> {
  const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  if (client.provisioningStatus !== 'provisioned') {
    throw new ApiError('NOT_PROVISIONED', 'Client must be provisioned before accessing files', 409);
  }
  return client.kubernetesNamespace;
}

export async function fileManagerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // Register raw body parser for binary uploads (application/octet-stream)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
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

  // GET /api/v1/clients/:clientId/files — list directory
  app.get('/clients/:clientId/files', {
    schema: { tags: ['Files'], summary: 'List directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    const path = query.path || '/';
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

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

  // POST /api/v1/clients/:clientId/files/upload-raw — raw binary upload
  // Accepts application/octet-stream body, writes to path from query param
  app.post('/clients/:clientId/files/upload-raw', {
    schema: { tags: ['Files'], summary: 'Upload file (raw binary)', security: [{ bearerAuth: [] }] },
    bodyLimit: 500 * 1024 * 1024, // 500MB per file
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

    const body = request.body as Buffer;

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/write-raw', {
      method: 'POST',
      body,
      contentType: 'application/octet-stream',
      query: { path: query.path },
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to upload', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/clients/:clientId/files/upload — upload file (multipart, legacy)
  app.post('/clients/:clientId/files/upload', {
    schema: { tags: ['Files'], summary: 'Upload file', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, string>;
    const targetPath = query.path || '/';
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

    const contentType = request.headers['content-type'] || '';
    const body = await request.body;

    const result = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/upload', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      contentType,
      query: { path: targetPath },
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to upload', result.status);
    }

    return success(JSON.parse(result.body));
  });
}
