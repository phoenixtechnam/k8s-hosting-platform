/**
 * Phase 3 T5.1 — write the sendmail auth file to a customer PVC via
 * the file-manager sidecar with the platform-internal bypass header.
 *
 * The file lives at `.platform/sendmail-auth` on the PVC — the
 * file-manager sidecar hides anything under `.platform/` from
 * customer browsing unless `X-Platform-Internal: 1` is set on the
 * request. Workload pods mount the PVC subPath `.platform/` at
 * `/etc/platform/` so the file is visible at
 * `/etc/platform/sendmail-auth` inside the container.
 */

import { fileManagerRequest } from '../file-manager/service.js';
import { buildAuthFileContent, type AuthFileInput } from './service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const AUTH_FILE_PATH = '.platform/sendmail-auth';

export interface WriteAuthFileDeps {
  readonly k8sClients: K8sClients;
  readonly kubeconfigPath?: string;
  readonly fileManagerImage: string;
}

/**
 * Write (or overwrite) the sendmail auth file on the client's PVC.
 *
 * - namespace: the customer's k8s namespace (usually `client-<id>`)
 * - input: the credential + mail host info to embed in the file
 *
 * Throws if the file-manager sidecar is unreachable or the write
 * fails. Callers should treat this as non-fatal for credential
 * generation: the credential still works for Stalwart auth, and the
 * admin can retry the write via a follow-up endpoint. The caller is
 * responsible for logging.
 */
export async function writeSendmailAuthFile(
  deps: WriteAuthFileDeps,
  namespace: string,
  input: AuthFileInput,
): Promise<void> {
  const content = buildAuthFileContent(input);

  // First, make sure the parent directory exists. The file-manager
  // mkdir handler uses `mkdir -p` semantics (idempotent), so an
  // existing directory is not an error — it returns 201 either way.
  // Any HTTP error including 404 (which means the path itself was
  // rejected by the sidecar's safePath guard) is fatal.
  const mkdirResult = await fileManagerRequest(
    deps.k8sClients,
    deps.kubeconfigPath,
    namespace,
    deps.fileManagerImage,
    '/mkdir',
    {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ path: '.platform' }),
      platformInternal: true,
    },
  );
  if (mkdirResult.status >= 400) {
    throw new Error(
      `writeSendmailAuthFile: mkdir .platform failed (${mkdirResult.status}): ${mkdirResult.body}`,
    );
  }

  // Write the file contents.
  const writeResult = await fileManagerRequest(
    deps.k8sClients,
    deps.kubeconfigPath,
    namespace,
    deps.fileManagerImage,
    '/write',
    {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ path: AUTH_FILE_PATH, content }),
      platformInternal: true,
    },
  );
  if (writeResult.status >= 400) {
    throw new Error(
      `writeSendmailAuthFile: write ${AUTH_FILE_PATH} failed (${writeResult.status}): ${writeResult.body}`,
    );
  }
}

export { AUTH_FILE_PATH };
