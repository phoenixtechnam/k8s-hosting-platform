/**
 * File-manager sidecar image resolution. Single source of truth for
 * every code path that creates or patches a file-manager Deployment.
 *
 * Resolution order:
 *   1. `process.env.FILE_MANAGER_IMAGE` — set from the
 *      platform-config ConfigMap key `file-manager-image`. Staging
 *      and production resolve to a registry-qualified path like
 *      `ghcr.io/phoenixtechnam/hosting-platform/file-manager-sidecar:latest`.
 *   2. Fallback `'file-manager-sidecar:latest'` — bare image name
 *      for local DinD where containerd has been pre-loaded by
 *      `scripts/local.sh`.
 *
 * History: a hardcoded fallback in `deployments/routes.ts:19`
 * (without reading the env first) caused the 2026-05-11 Normal Test
 * incident — containerd resolved the bare name as
 * `docker.io/library/file-manager-sidecar:latest`, ImagePullBackOff,
 * pod stuck holding the RWO PVC, Multi-Attach blocked every other
 * deployment in the tenant namespace. Consolidating to one helper
 * removes the drift surface so that bug class can't recur.
 *
 * @see project_normal_test_fm_image_fix_2026_05_11.md
 */
export function getFileManagerImage(): string {
  return process.env.FILE_MANAGER_IMAGE ?? 'file-manager-sidecar:latest';
}
