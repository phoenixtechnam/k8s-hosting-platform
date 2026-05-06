/**
 * S3BackupStore — bundles laid out as objects under an S3 prefix.
 *
 * Object keys (per BACKUP_COMPONENT_MODEL.md):
 *
 *   <prefix>/<bundleId>/meta.json
 *   <prefix>/<bundleId>/components/files/archive.tar.gz
 *   <prefix>/<bundleId>/components/files/tree.jsonl.gz
 *   <prefix>/<bundleId>/components/mailboxes/<addr>.mbox.tar.gz
 *   <prefix>/<bundleId>/components/config/db-rows.json.gz
 *   <prefix>/<bundleId>/components/secrets/tls.json.gz.enc
 *
 * Atomicity: meta.json is a single PUT — the moment that PUT lands the
 * bundle is committed. An S3 multipart upload is used for the four
 * "big" component artifacts via @aws-sdk/lib-storage so very large
 * tenant PVCs don't OOM the platform-api pod.
 *
 * Forward-compat note: this store assumes path-style addressing when
 * an `endpoint` is configured (Hetzner Object Storage, MinIO, B2 S3-compat,
 * Cloudflare R2). Without endpoint we use AWS-style virtual-hosted addressing.
 */

import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BackupComponentName, BackupMetaV1 } from '@k8s-hosting/api-contracts';
import type {
  BackupStore,
  BundleHandle,
  ArtifactRef,
  ArtifactStat,
  WriteComponentOptions,
} from './bundle-store.js';
import { META_FILENAME, componentDir, parseMeta, serializeMeta } from './meta.js';

export interface S3BackupStoreConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathPrefix?: string;
}

interface S3Backend {
  readonly prefix: string;
}

function isS3Backend(b: unknown): b is S3Backend {
  return typeof b === 'object' && b !== null && typeof (b as S3Backend).prefix === 'string';
}

export class S3BackupStore implements BackupStore {
  readonly kind = 's3' as const;

  constructor(private readonly config: S3BackupStoreConfig) {}

  private async client() {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: !!this.config.endpoint,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  private prefixFor(backupId: string): string {
    const base = (this.config.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
    return base ? `${base}/${backupId}` : backupId;
  }

  private resolveBackend(handle: BundleHandle): S3Backend {
    if (!isS3Backend(handle._backend)) {
      throw new Error('S3BackupStore: handle is not an s3 handle');
    }
    return handle._backend;
  }

  private artifactKey(prefix: string, component: BackupComponentName, name: string): string {
    return `${prefix}/${componentDir(component)}/${name}`;
  }

  async reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle> {
    // S3 has no directory concept — reservation is purely logical.
    return {
      bundleId: input.backupId,
      _backend: { prefix: this.prefixFor(input.backupId) },
    };
  }

  async open(backupId: string): Promise<BundleHandle | null> {
    // We don't probe S3 here — the handle is opaque and getMeta()
    // will throw for missing bundles. Restore code that needs a true
    // existence check should call getMeta() or stat() instead.
    return { bundleId: backupId, _backend: { prefix: this.prefixFor(backupId) } };
  }

  async writeComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
    body: Readable,
    opts?: WriteComponentOptions,
  ): Promise<ArtifactRef> {
    const { Upload } = await import('@aws-sdk/lib-storage');
    const backend = this.resolveBackend(handle);
    const key = this.artifactKey(backend.prefix, component, name);
    const c = await this.client();
    // Use multipart upload — handles arbitrarily large component bodies
    // without buffering them in the platform-api pod.
    const upload = new Upload({
      client: c,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();

    // We don't trust the upload return — head the object to read its
    // canonical ContentLength.
    const stat = await this.statKey(key);
    return {
      component,
      name,
      sizeBytes: stat?.sizeBytes ?? 0,
      sha256: opts?.sha256,
    };
  }

  async readComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const backend = this.resolveBackend(handle);
    const key = this.artifactKey(backend.prefix, component, name);
    const c = await this.client();
    const r = await c.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const body = r.Body;
    if (!body) {
      throw new Error(`S3BackupStore: empty response body for ${key}`);
    }
    // SDK returns a `Readable` on Node.
    return body as Readable;
  }

  async listArtifacts(
    handle: BundleHandle,
    component: BackupComponentName,
  ): Promise<ArtifactRef[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const backend = this.resolveBackend(handle);
    const componentPrefix = `${backend.prefix}/${componentDir(component)}/`;
    const c = await this.client();
    const refs: ArtifactRef[] = [];
    let continuationToken: string | undefined;
    do {
      const r = await c.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: componentPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of r.Contents ?? []) {
        if (!obj.Key) continue;
        const name = obj.Key.slice(componentPrefix.length);
        if (!name) continue;
        if (name.endsWith('.sha256')) continue; // sidecars not artifacts
        refs.push({ component, name, sizeBytes: Number(obj.Size ?? 0) });
      }
      continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (continuationToken);
    return refs;
  }

  private async statKey(key: string): Promise<ArtifactStat | null> {
    const { HeadObjectCommand, S3ServiceException } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    try {
      const r = await c.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: Number(r.ContentLength ?? 0), sha256: null };
    } catch (err) {
      if (err instanceof S3ServiceException
          && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) {
        return null;
      }
      throw err;
    }
  }

  async stat(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<ArtifactStat | null> {
    const backend = this.resolveBackend(handle);
    return this.statKey(this.artifactKey(backend.prefix, component, name));
  }

  async putMeta(handle: BundleHandle, meta: BackupMetaV1): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const backend = this.resolveBackend(handle);
    const c = await this.client();
    await c.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: `${backend.prefix}/${META_FILENAME}`,
      Body: serializeMeta(meta),
      ContentType: 'application/json',
    }));
  }

  async getMeta(handle: BundleHandle): Promise<BackupMetaV1> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const backend = this.resolveBackend(handle);
    const c = await this.client();
    const r = await c.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: `${backend.prefix}/${META_FILENAME}`,
    }));
    const body = r.Body;
    if (!body) throw new Error('S3BackupStore: empty meta.json');
    // Buffer the manifest — it's small (<10 KiB).
    const chunks: Buffer[] = [];
    await pipeline(
      body as Readable,
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        },
      }),
    );
    return parseMeta(Buffer.concat(chunks));
  }

  async delete(handle: BundleHandle): Promise<void> {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const backend = this.resolveBackend(handle);
    const c = await this.client();
    let continuationToken: string | undefined;
    // Drop meta.json first so concurrent readers don't see a torn bundle.
    {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      try {
        await c.send(new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: `${backend.prefix}/${META_FILENAME}`,
        }));
      } catch { /* tolerate missing */ }
    }
    do {
      const r = await c.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${backend.prefix}/`,
        ContinuationToken: continuationToken,
      }));
      const keys = (r.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k);
      if (keys.length > 0) {
        await c.send(new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }));
      }
      continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
