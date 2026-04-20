// File Manager Sidecar — Minimal REST API for PVC file operations
// Runs inside client K8s namespace, mounted PVC at /data
// No auth — protected by NetworkPolicy (only platform namespace can reach it)

import { createServer } from 'node:http';
import { readdir, stat, readFile, writeFile, mkdir, rm, rename, cp, chown as fsChown } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, basename, extname, dirname, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = 8111;

// Default ownership for files created by the file-manager (www-data, compatible with PHP apps)
const DEFAULT_UID = 33;
const DEFAULT_GID = 33;

// ─── UID/GID → Name Resolution ──────────────────────────────────────────────
const uidNameCache = new Map();
const gidNameCache = new Map();

async function loadPasswd() {
  try {
    const data = await readFile('/etc/passwd', 'utf8');
    for (const line of data.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3) uidNameCache.set(parseInt(parts[2], 10), parts[0]);
    }
  } catch { /* no /etc/passwd */ }
}

async function loadGroup() {
  try {
    const data = await readFile('/etc/group', 'utf8');
    for (const line of data.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3) gidNameCache.set(parseInt(parts[2], 10), parts[0]);
    }
  } catch { /* no /etc/group */ }
}

function resolveUidName(uid) { return uidNameCache.get(uid) ?? String(uid); }
function resolveGidName(gid) { return gidNameCache.get(gid) ?? String(gid); }

// Load at startup
await loadPasswd();
await loadGroup();
// Also add well-known names not in Alpine's /etc/passwd
if (!uidNameCache.has(33)) uidNameCache.set(33, 'www-data');
if (!gidNameCache.has(33)) gidNameCache.set(33, 'www-data');
if (!uidNameCache.has(999)) uidNameCache.set(999, 'mysql');
if (!gidNameCache.has(999)) gidNameCache.set(999, 'mysql');
if (!uidNameCache.has(70)) uidNameCache.set(70, 'postgres');
if (!gidNameCache.has(70)) gidNameCache.set(70, 'postgres');
const BASE = '/data';

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.php': 'text/x-php', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/x-toml',
};
function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ─── Hidden platform paths ───────────────────────────────────────────────────
// Files and directories that must never be visible through the file manager.
// The backend uses a separate internal path (X-Platform-Internal header) to
// read/write these. Everything under `.platform/` is platform-managed
// (sendmail submission credentials, scheduled-task queue files, etc.) — if a
// customer sees or modifies them they can break outbound mail or run
// unapproved cron jobs.
//
// Matching is by normalized, relative-to-BASE path. We match both the path
// itself ("foo/.platform") and any descendant ("foo/.platform/sendmail").
// Every file in the root "." that starts with `.platform` is also hidden so
// browsing `/` doesn't leak the folder.

// Hidden at ALL path levels (defense-in-depth for platform internals).
// The SFTP jail now lives in a separate emptyDir volume (/jail), so no
// platform artifacts exist on the PVC. This filter is kept as defense-
// in-depth in case a .platform/ dir is ever created on the PVC.
const HIDDEN_PREFIXES = ['.platform'];

function relToBase(absPath) {
  // Strip BASE prefix to produce a relative POSIX-style path used by
  // the HIDDEN_PREFIXES check. Paths equal to BASE itself become '.'.
  if (absPath === BASE) return '.';
  return absPath.startsWith(BASE + '/') ? absPath.slice(BASE.length + 1) : absPath;
}

function isHidden(relPath) {
  // Normalize: strip trailing slashes, collapse any leading ./
  const norm = relPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  for (const prefix of HIDDEN_PREFIXES) {
    if (norm === prefix) return true;
    if (norm.startsWith(prefix + '/')) return true;
    // Also hide any path that contains the prefix as a path segment
    // (e.g. "nested/dir/.platform/foo"). Defense-in-depth so a customer
    // can't stash data under a nested .platform directory they create.
    if (norm.split('/').includes(prefix)) return true;
  }
  return false;
}

// ─── Security: path traversal prevention ─────────────────────────────────────

function safePath(userPath, opts = {}) {
  // Strip leading slash — user paths are relative to BASE
  const cleaned = (userPath || '.').replace(/^\/+/, '') || '.';
  const resolved = resolve(BASE, cleaned);
  if (!resolved.startsWith(BASE)) {
    return null; // Traversal attempt
  }
  // Hidden-path enforcement. The platform-internal bypass header lets
  // the platform backend read/write these paths while keeping them
  // invisible to the customer's UI.
  if (!opts.allowHidden) {
    const rel = relToBase(resolved);
    if (isHidden(rel)) return null;
  }
  return resolved;
}

// Shared-secret gate for the platform-internal bypass. The backend
// injects this secret via the file-manager Secret at pod creation
// time. If unset, we fail closed and never allow the bypass — this
// means a dev cluster without the secret simply cannot access
// hidden paths via the sidecar, forcing direct kubectl exec.
//
// Constant-time comparison prevents timing attacks against the
// secret value.
const PLATFORM_INTERNAL_SECRET = process.env.PLATFORM_INTERNAL_SECRET || '';

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isPlatformBypass(req) {
  // Fail closed if the sidecar was started without a secret.
  if (!PLATFORM_INTERNAL_SECRET) return false;
  const provided = req.headers['x-platform-internal'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return constantTimeEquals(provided, PLATFORM_INTERNAL_SECRET);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function getQuery(url) {
  const u = new URL(url, 'http://localhost');
  return Object.fromEntries(u.searchParams);
}

function getPath(url) {
  return new URL(url, 'http://localhost').pathname;
}

// ─── Multipart parser (minimal, single file) ────────────────────────────────

// Multipart upload cap. The /upload (multipart) handler buffers the whole
// body in memory before parsing — so it needs a safety cap or huge files
// would OOM the sidecar pod. Frontends should use the streaming
// /upload-raw endpoint, which has no cap (the real limit is the tenant's
// PVC quota, enforced at the filesystem layer via ENOSPC).
//   MAX_UPLOAD_SIZE=0 → no cap on multipart (dangerous; OOM risk)
//   unset or non-numeric → default 2 GiB (lets curl-based admin imports
//       run without OOMing the pod)
const MAX_UPLOAD_SIZE = (() => {
  const v = parseInt(process.env.MAX_UPLOAD_SIZE ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 2 * 1024 * 1024 * 1024;
})();

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(.+)/);
  if (!match) throw new Error('No boundary in content-type');

  const boundary = match[1];
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (MAX_UPLOAD_SIZE > 0 && totalLength > MAX_UPLOAD_SIZE) {
      req.destroy();
      throw Object.assign(new Error(`Upload exceeds ${MAX_UPLOAD_SIZE} byte limit`), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(sep) + sep.length;

  while (true) {
    const next = body.indexOf(sep, start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    start = next + sep.length;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerStr = part.subarray(0, headerEnd).toString();
    const data = part.subarray(headerEnd + 4, part.length - 2); // trim trailing \r\n

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch?.[1] || '',
      filename: filenameMatch?.[1] || null,
      data,
    });
  }

  return parts;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleLs(req, res) {
  const { path: p = '/', recursive } = getQuery(req.url);
  const bypass = isPlatformBypass(req);
  const full = safePath(p, { allowHidden: bypass });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const isRecursive = recursive === 'true' || recursive === '1';

    async function listDir(dirPath, prefix) {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const parentRel = relToBase(dirPath);
      const visibleEntries = bypass
        ? entries
        : entries.filter((e) => {
            const childRel = parentRel === '.' ? e.name : `${parentRel}/${e.name}`;
            return !isHidden(childRel);
          });
      const items = [];
      for (const e of visibleEntries) {
        const entryPath = join(dirPath, e.name);
        const relativeName = prefix ? `${prefix}/${e.name}` : e.name;
        try {
          const s = await stat(entryPath);
          items.push({
            name: relativeName,
            type: e.isDirectory() ? 'directory' : 'file',
            size: s.size,
            modifiedAt: s.mtime.toISOString(),
            permissions: (s.mode & 0o777).toString(8),
            uid: s.uid,
            gid: s.gid,
            owner: resolveUidName(s.uid),
            group: resolveGidName(s.gid),
          });
          if (isRecursive && e.isDirectory()) {
            const subItems = await listDir(entryPath, relativeName);
            items.push(...subItems);
          }
        } catch {
          items.push({ name: relativeName, type: e.isDirectory() ? 'directory' : 'file', size: 0, modifiedAt: null, permissions: '000', uid: 0, gid: 0, owner: 'root', group: 'root' });
        }
      }
      return items;
    }

    const items = await listDir(full, '');
    // Sort: directories first, then alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJson(res, 200, { path: p, entries: items });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Directory not found');
    if (err.code === 'ENOTDIR') return sendError(res, 400, 'Not a directory');
    console.error('[handleLs]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to list directory');
  }
}

async function handleRead(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'File not found');

  try {
    const s = await stat(full);
    if (s.isDirectory()) return sendError(res, 400, 'Cannot read a directory');
    if (s.size > 10 * 1024 * 1024) return sendError(res, 413, 'File too large for inline editing (>10MB)');

    const content = await readFile(full, 'utf-8');
    sendJson(res, 200, { path: p, content, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'File not found');
    console.error('[handleRead]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to read file');
  }
}

async function handleDownload(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'File not found');

  try {
    const s = await stat(full);
    if (s.isDirectory()) return sendError(res, 400, 'Directory download not supported yet');

    const name = basename(full);
    const encoded = encodeURIComponent(name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const mimeType = getMimeType(name);
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Content-Length': s.size,
    });
    const stream = createReadStream(full);
    await pipeline(stream, res);
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'File not found');
    console.error('[handleDownload]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to download file');
  }
}

async function handleMkdir(req, res) {
  const body = await readBody(req);
  const { path: p } = body;
  if (!p) return sendError(res, 400, 'path required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    await mkdir(full, { recursive: true });
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
    sendJson(res, 201, { path: p, created: true });
  } catch (err) {
    console.error('[handleMkdir]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to create directory');
  }
}

async function handleUpload(req, res) {
  const { path: targetDir = '/' } = getQuery(req.url);
  const bypass = isPlatformBypass(req);
  const full = safePath(targetDir, { allowHidden: bypass });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    // Stream multipart upload directly to disk to avoid buffering
    // the entire file in memory. We parse just enough of each part's
    // headers to find the filename, then pipe data to a WriteStream.
    const contentType = req.headers['content-type'] || '';
    const bMatch = contentType.match(/boundary=(.+)/);
    if (!bMatch) return sendError(res, 400, 'No boundary in content-type');

    const boundary = bMatch[1];

    // For multipart streaming we still need to parse structure, but we
    // write file data chunks directly to disk as they arrive.
    const parts = await parseMultipart(req);
    const filePart = parts.find(p => p.filename);
    if (!filePart) return sendError(res, 400, 'No file in upload');

    const rawFilename = (filePart.filename || 'upload')
        .replace(/[/\\]/g, '_')
        .replace(/\0/g, '')
        .replace(/^-+/, '_')
        .slice(0, 255) || 'upload';
    const destSafe = safePath(join(targetDir, rawFilename), { allowHidden: bypass });
    if (!destSafe) return sendError(res, 404, 'Not found');

    await mkdir(full, { recursive: true });

    // Write file data to disk via a stream to avoid holding entire
    // buffer during the write phase.
    const ws = createWriteStream(destSafe);
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.end(filePart.data, resolve);
    });
    await fsChown(destSafe, DEFAULT_UID, DEFAULT_GID).catch(() => {});

    sendJson(res, 201, { path: join(targetDir, filePart.filename), size: filePart.data.length });
  } catch (err) {
    console.error('[handleUpload]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to upload file');
  }
}

async function handleWrite(req, res) {
  const body = await readBody(req);
  const { path: p, content } = body;
  if (!p) return sendError(res, 400, 'path required');
  if (content === undefined) return sendError(res, 400, 'content required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    console.error('[handleWrite]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to write file');
  }
}

async function handleRename(req, res) {
  const body = await readBody(req);
  const { oldPath, newPath } = body;
  if (!oldPath || !newPath) return sendError(res, 400, 'oldPath and newPath required');
  const bypass = isPlatformBypass(req);
  const fullOld = safePath(oldPath, { allowHidden: bypass });
  const fullNew = safePath(newPath, { allowHidden: bypass });
  if (!fullOld || !fullNew) return sendError(res, 404, 'Not found');

  try {
    await rename(fullOld, fullNew);
    sendJson(res, 200, { oldPath, newPath, renamed: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Source not found');
    console.error('[handleRename]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to rename');
  }
}

async function handleRm(req, res) {
  const body = await readBody(req);
  const { path: p } = body;
  if (!p) return sendError(res, 400, 'path required');
  if (p === '/' || p === '.') return sendError(res, 403, 'Cannot delete root');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');
  if (full === BASE) return sendError(res, 403, 'Cannot delete root');

  try {
    await rm(full, { recursive: true });
    sendJson(res, 200, { path: p, deleted: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Not found');
    console.error('[handleDelete]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to delete');
  }
}

async function handleCopy(req, res) {
  const body = await readBody(req);
  const { sourcePath, destPath } = body;
  if (!sourcePath || !destPath) return sendError(res, 400, 'sourcePath and destPath required');
  const bypass = isPlatformBypass(req);
  const fullSrc = safePath(sourcePath, { allowHidden: bypass });
  const fullDest = safePath(destPath, { allowHidden: bypass });
  if (!fullSrc || !fullDest) return sendError(res, 404, 'Not found');

  try {
    // Ensure parent directory exists
    await mkdir(dirname(fullDest), { recursive: true });
    await cp(fullSrc, fullDest, { recursive: true });
    sendJson(res, 200, { sourcePath, destPath, copied: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Source not found');
    console.error('[handleCopy]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to copy');
  }
}

async function handleArchive(req, res) {
  const body = await readBody(req);
  const { paths, destPath, format = 'tar.gz' } = body;
  if (!paths || !Array.isArray(paths) || paths.length === 0) return sendError(res, 400, 'paths array required');
  if (!destPath) return sendError(res, 400, 'destPath required');

  const bypass = isPlatformBypass(req);
  const fullDest = safePath(destPath, { allowHidden: bypass });
  if (!fullDest) return sendError(res, 404, 'Not found');

  // Validate all source paths. Archiving a hidden path would let a
  // customer exfiltrate it in compressed form, so hidden paths stay
  // invisible unless the platform backend is the caller.
  const safePaths = [];
  for (const p of paths) {
    const full = safePath(p, { allowHidden: bypass });
    if (!full) return sendError(res, 404, `Not found: ${p}`);
    safePaths.push(full);
  }

  try {
    await mkdir(dirname(fullDest), { recursive: true });

    if (format === 'zip') {
      // zip -r destPath file1 file2 ...  (run from BASE so paths are relative)
      const relPaths = safePaths.map(p => p.replace(BASE + '/', ''));
      await execFileAsync('zip', ['-r', fullDest, ...relPaths], { cwd: BASE, timeout: 120_000 });
    } else if (format === 'tar.gz' || format === 'tgz') {
      const relPaths = safePaths.map(p => p.replace(BASE + '/', ''));
      await execFileAsync('tar', ['czf', fullDest, ...relPaths], { cwd: BASE, timeout: 120_000 });
    } else if (format === 'tar') {
      const relPaths = safePaths.map(p => p.replace(BASE + '/', ''));
      await execFileAsync('tar', ['cf', fullDest, ...relPaths], { cwd: BASE, timeout: 120_000 });
    } else {
      return sendError(res, 400, 'Unsupported format. Use: zip, tar.gz, tar');
    }

    const s = await stat(fullDest);
    sendJson(res, 201, { path: destPath, size: s.size, format });
  } catch (err) {
    console.error('[handleArchive]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to create archive');
  }
}

async function handleExtract(req, res) {
  const body = await readBody(req);
  const { path: archivePath, destPath = '/' } = body;
  if (!archivePath) return sendError(res, 400, 'path required');

  const bypass = isPlatformBypass(req);
  const fullArchive = safePath(archivePath, { allowHidden: bypass });
  const fullDest = safePath(destPath, { allowHidden: bypass });
  if (!fullArchive || !fullDest) return sendError(res, 404, 'Not found');

  try {
    await mkdir(fullDest, { recursive: true });
    const lower = archivePath.toLowerCase();

    if (lower.endsWith('.zip')) {
      await execFileAsync('unzip', ['-o', fullArchive, '-d', fullDest], { timeout: 120_000 });
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await execFileAsync('tar', ['xzf', fullArchive, '-C', fullDest], { timeout: 120_000 });
    } else if (lower.endsWith('.tar')) {
      await execFileAsync('tar', ['xf', fullArchive, '-C', fullDest], { timeout: 120_000 });
    } else {
      return sendError(res, 400, 'Unsupported archive format. Supports: .zip, .tar.gz, .tgz, .tar');
    }

    sendJson(res, 200, { path: archivePath, extractedTo: destPath, extracted: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Archive not found');
    console.error('[handleExtract]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to extract archive');
  }
}

async function handleWriteRaw(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path query parameter required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const dir = dirname(full);
    await mkdir(dir, { recursive: true });

    const ws = createWriteStream(full);

    // Only abort on actual errors — NOT on normal 'close' events.
    // The K8s service proxy closes the request after transferring all data,
    // which races with pipeline() flushing to disk.
    let pipelineDone = false;
    req.on('error', () => {
      if (!pipelineDone) {
        ws.destroy();
        rm(full, { force: true }).catch(() => {});
      }
    });

    await pipeline(req, ws);
    pipelineDone = true;
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});

    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    // If client disconnected, clean up partial file
    rm(full, { force: true }).catch(() => {});
    console.error('[handleWriteRaw]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to write file');
  }
}

async function handleGitClone(req, res) {
  const body = await readBody(req);
  const { url, destPath } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'destPath required');

  // Basic URL validation — only allow https protocol
  if (!/^https:\/\//i.test(url)) {
    return sendError(res, 400, 'Only https protocol URLs are allowed');
  }

  const fullDest = safePath(destPath, { allowHidden: isPlatformBypass(req) });
  if (!fullDest) return sendError(res, 404, 'Not found');

  try {
    await mkdir(dirname(fullDest), { recursive: true });
    await execFileAsync('git', ['clone', '--depth', '1', url, fullDest], {
      timeout: 300_000, // 5 min for large repos
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // Prevent auth prompts
    });
    sendJson(res, 201, { url, destPath, cloned: true });
  } catch (err) {
    console.error('[handleGitClone]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to clone repository');
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

async function handleDiskUsage(req, res) {
  try {
    // Use du for actual bytes used — runs as root so it can read all dirs
    // (database data owned by mysql/postgres user).
    const { stdout: duOut } = await execFileAsync('du', ['-sb', BASE], { timeout: 30_000 });
    const usedBytes = parseInt(duOut.split('\t')[0], 10) || 0;

    // df gives PVC capacity on real block storage (correct in production).
    // On local-path provisioner (local dev), it returns host FS size — acceptable trade-off.
    const { stdout: dfOut } = await execFileAsync('df', ['-B1', BASE], { timeout: 10_000 });
    const dfLines = dfOut.trim().split('\n');
    const dfParts = dfLines[1]?.split(/\s+/) || [];
    const totalBytes = parseInt(dfParts[1], 10) || 0;
    const availableBytes = parseInt(dfParts[3], 10) || 0;

    sendJson(res, 200, {
      usedBytes,
      totalBytes,
      availableBytes,
      usedFormatted: formatBytes(usedBytes),
      totalFormatted: formatBytes(totalBytes),
      availableFormatted: formatBytes(availableBytes),
    });
  } catch (err) {
    console.error('[handleDiskUsage]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to get disk usage');
  }
}

async function handleFolderSize(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path query parameter required');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const s = await stat(full);
    if (!s.isDirectory()) return sendError(res, 400, 'Path is not a directory');

    // Runs as root — can read all dirs including database data
    const { stdout } = await execFileAsync('du', ['-sb', full], { timeout: 60_000 });
    const sizeBytes = parseInt(stdout.split('\t')[0], 10) || 0;

    sendJson(res, 200, {
      path: p,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
    });
  } catch (err) {
    console.error('[handleFolderSize]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to get folder size');
  }
}

const MAX_JSON_BODY = 10 * 1024 * 1024; // 10 MB cap for JSON-body endpoints

async function readBody(req) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_JSON_BODY) {
      // Drain the rest of the stream so the connection closes cleanly
      req.destroy();
      throw Object.assign(new Error('Request body exceeds 10 MB limit'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─── Permissions & Ownership ─────────────────────────────────────────────────

async function handleChmod(req, res) {
  const body = await readBody(req);
  const { path: p, mode, recursive } = body;
  if (!p) return sendError(res, 400, 'path is required');
  if (!mode || !/^[0-7]{3,4}$/.test(String(mode))) return sendError(res, 400, 'mode must be an octal string (e.g. "755")');
  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Path not found');

  try {
    const args = recursive ? ['-R', String(mode), full] : [String(mode), full];
    await new Promise((resolve, reject) => {
      execFile('chmod', args, { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    sendJson(res, 200, { path: p, mode: String(mode), recursive: !!recursive });
  } catch (err) {
    console.error('[handleChmod]', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleChown(req, res) {
  const body = await readBody(req);
  const { path: p, uid, gid, owner: ownerName, group: groupName, recursive } = body;
  if (!p) return sendError(res, 400, 'path is required');

  // Resolve name strings to numeric UIDs/GIDs (Alpine may not have all users in /etc/passwd)
  let resolvedUid = uid;
  let resolvedGid = gid;
  if (ownerName) {
    // Reverse lookup: name → uid from our cache
    for (const [id, name] of uidNameCache) {
      if (name === ownerName) { resolvedUid = id; break; }
    }
    if (resolvedUid === undefined) {
      // Try parsing as number
      const parsed = parseInt(ownerName, 10);
      if (!isNaN(parsed)) resolvedUid = parsed;
      else return sendError(res, 400, `Unknown user: ${ownerName}`);
    }
  }
  if (groupName) {
    for (const [id, name] of gidNameCache) {
      if (name === groupName) { resolvedGid = id; break; }
    }
    if (resolvedGid === undefined) {
      const parsed = parseInt(groupName, 10);
      if (!isNaN(parsed)) resolvedGid = parsed;
      else return sendError(res, 400, `Unknown group: ${groupName}`);
    }
  }

  const ownerSpec = `${resolvedUid ?? ''}:${resolvedGid ?? ''}`;
  if (ownerSpec === ':') return sendError(res, 400, 'uid/owner or gid/group is required');

  const full = safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Path not found');

  try {
    const args = recursive ? ['-R', ownerSpec, full] : [ownerSpec, full];
    await new Promise((resolve, reject) => {
      execFile('chown', args, { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    sendJson(res, 200, { path: p, uid, gid, recursive: !!recursive });
  } catch (err) {
    console.error('[handleChown]', err.message);
    sendError(res, 500, err.message);
  }
}

// ─── Fetch URL (download from internet) ─────────────────────────────────────

const BLOCKED_URL_PATTERNS = [
  /^file:/i,
  /^ftp:/i,
  /localhost/i,
  /127\.0\.0\./,
  /\[::1\]/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /192\.168\.\d+\.\d+/,
];

async function handleFetchUrl(req, res) {
  const { statfs } = await import('node:fs/promises');
  const body = await readBody(req);
  const { url, path: destPath, force } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'path required');

  // Security: block internal/local URLs (SSRF prevention)
  if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) {
    return sendError(res, 403, 'URL not allowed (internal/local addresses blocked)');
  }
  if (!/^https?:\/\//i.test(url)) {
    return sendError(res, 400, 'Only http:// and https:// URLs are supported');
  }

  const full = safePath(destPath, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Destination path not allowed');

  try {
    await mkdir(dirname(full), { recursive: true });

    // Check available disk space on PVC
    const fsStats = await statfs(BASE);
    const freeBytes = fsStats.bsize * fsStats.bavail;

    async function fetchWithRedirects(fetchUrl, maxRedirects = 5) {
      const fetchProto = fetchUrl.startsWith('https') ? await import('node:https') : await import('node:http');
      return new Promise((resolve, reject) => {
        fetchProto.default.get(fetchUrl, { timeout: 60000 }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
            response.resume();
            resolve(fetchWithRedirects(response.headers.location, maxRedirects - 1));
            return;
          }
          resolve(response);
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Download timed out (60s)')); });
      });
    }

    await new Promise((resolve, reject) => {
      fetchWithRedirects(url).then((response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        const contentLength = parseInt(response.headers['content-length'] || '0', 10);

        // Check against PVC free space (not a hardcoded limit)
        if (contentLength > 0) {
          const usagePercent = ((contentLength / freeBytes) * 100);
          if (usagePercent > 90) {
            response.destroy();
            reject(new Error(`Not enough disk space. File is ${formatBytes(contentLength)} but only ${formatBytes(freeBytes)} free (would use ${Math.round(usagePercent)}% of remaining space).`));
            return;
          }
          if (usagePercent > 70 && !force) {
            response.destroy();
            sendJson(res, 200, {
              type: 'warning',
              message: `This file (${formatBytes(contentLength)}) will use ${Math.round(usagePercent)}% of remaining disk space (${formatBytes(freeBytes)} free). Continue?`,
              fileSize: contentLength,
              fileSizeFormatted: formatBytes(contentLength),
              freeSpace: freeBytes,
              freeSpaceFormatted: formatBytes(freeBytes),
              usagePercent: Math.round(usagePercent),
              needsConfirmation: true,
            });
            resolve();
            return;
          }
        }

        // Stream response with progress
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

        const ws = createWriteStream(full);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          // Runtime check: stop if we'd exceed 95% of free space during download
          if (downloaded > freeBytes * 0.95) {
            response.destroy();
            ws.destroy();
            rm(full).catch(() => {});
            res.write(JSON.stringify({ type: 'error', message: `Download stopped: approaching disk space limit (${formatBytes(freeBytes)} free)` }) + '\n');
            res.end();
            return;
          }
          ws.write(chunk);
          res.write(JSON.stringify({
            type: 'progress',
            downloaded,
            total: contentLength || null,
            percent: contentLength ? Math.round((downloaded / contentLength) * 100) : null,
          }) + '\n');
        });

        response.on('end', async () => {
          ws.end();
          await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
          const s = await stat(full);
          res.write(JSON.stringify({
            type: 'complete',
            path: destPath,
            size: s.size,
            sizeFormatted: formatBytes(s.size),
          }) + '\n');
          res.end();
          resolve();
        });

        response.on('error', (err) => {
          ws.destroy();
          reject(err);
        });
      }).catch(reject);
    });
  } catch (err) {
    // Clean up partial file
    await rm(full).catch(() => {});
    if (!res.headersSent) {
      sendError(res, 500, `Download failed: ${err.message}`);
    } else {
      res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
      res.end();
    }
  }
}

// ─── Pretty-print formatter (no deps) ───────────────────────────────────────

function prettifyHtml(html) {
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const inlineTags = new Set(['a','abbr','b','bdi','bdo','cite','code','data','em','i','kbd','mark','q','s','small','span','strong','sub','sup','time','u','var']);
  let indent = 0;
  const lines = [];
  // Split on tags while preserving them
  const tokens = html.replace(/>\s+</g, '>\n<').split('\n');
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Closing tag
    if (/^<\//.test(trimmed)) {
      indent = Math.max(0, indent - 1);
      lines.push('  '.repeat(indent) + trimmed);
    }
    // Self-closing or void tag
    else if (/\/>$/.test(trimmed) || voidTags.has((trimmed.match(/^<(\w+)/)?.[1] ?? '').toLowerCase())) {
      lines.push('  '.repeat(indent) + trimmed);
    }
    // Opening tag
    else if (/^<\w/.test(trimmed)) {
      lines.push('  '.repeat(indent) + trimmed);
      // Only indent if not inline and not a tag that closes on the same line
      const tagName = (trimmed.match(/^<(\w+)/)?.[1] ?? '').toLowerCase();
      if (!inlineTags.has(tagName) && !trimmed.includes('</')) {
        indent++;
      }
    }
    // Text or other content
    else {
      lines.push('  '.repeat(indent) + trimmed);
    }
  }
  return lines.join('\n');
}

function prettifyCss(css) {
  let result = css;
  // Add newlines after { and ;
  result = result.replace(/\{/g, ' {\n').replace(/\}/g, '\n}\n').replace(/;/g, ';\n');
  // Indent
  let indent = 0;
  const lines = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('}')) indent = Math.max(0, indent - 1);
    const formatted = '  '.repeat(indent) + trimmed;
    if (trimmed.endsWith('{')) indent++;
    return formatted;
  }).filter(Boolean);
  return lines.join('\n');
}

function prettifyJs(js) {
  // Basic: add newlines after { } ; and indent
  let result = js;
  result = result.replace(/\{/g, ' {\n').replace(/\}/g, '\n}\n').replace(/;(?!\s*[\n}])/g, ';\n');
  let indent = 0;
  const lines = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('}')) indent = Math.max(0, indent - 1);
    const formatted = '  '.repeat(indent) + trimmed;
    if (trimmed.endsWith('{')) indent++;
    return formatted;
  }).filter(Boolean);
  return lines.join('\n');
}

function prettifyContent(content, filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return prettifyHtml(content);
  if (ext === 'css' || ext === 'scss') return prettifyCss(content);
  if (ext === 'js' || ext === 'mjs') return prettifyJs(content);
  return content;
}

function shouldPrettify(filePath, html, css, js) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if ((ext === 'html' || ext === 'htm') && html) return true;
  if ((ext === 'css' || ext === 'scss') && css) return true;
  if ((ext === 'js' || ext === 'mjs') && js) return true;
  return false;
}

// ─── Clone Site (website scraper) ────────────────────────────────────────────

async function handleCloneSite(req, res) {
  const body = await readBody(req);
  const { url, path: destPath, maxPages = 50, maxDepth = 3, prettifyHtml = false, prettifyCss = false, prettifyJs = false } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'path required');
  if (!/^https?:\/\//i.test(url)) return sendError(res, 400, 'Only http/https URLs supported');

  const full = safePath(destPath, { allowHidden: false });
  if (!full) return sendError(res, 404, 'Destination path not allowed');

  const clampedMaxPages = Math.min(Math.max(1, maxPages), 500);
  const clampedMaxDepth = Math.min(Math.max(1, maxDepth), 10);

  // Check disk space
  const { statfs: statfsAsync } = await import('node:fs/promises');
  const fsStats = await statfsAsync(BASE);
  const freeBytes = fsStats.bsize * fsStats.bavail;
  if (freeBytes < 50 * 1024 * 1024) {
    return sendError(res, 507, 'Less than 50MB free disk space — cannot clone');
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  const send = (obj) => { if (!aborted) try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    await mkdir(full, { recursive: true });

    const baseUrl = new URL(url);
    const baseOrigin = baseUrl.origin;
    const visited = new Set();
    const queue = [{ url: baseUrl.href, depth: 0 }];
    let pagesDownloaded = 0;
    let assetsDownloaded = 0;
    const assetQueue = [];

    // Fetch helper with redirect following
    async function fetchUrl(fetchUrl) {
      const proto = fetchUrl.startsWith('https') ? await import('node:https') : await import('node:http');
      return new Promise((resolve, reject) => {
        const doFetch = (u, redirects = 0) => {
          const p = u.startsWith('https') ? proto.default : (import('node:http')).then(m => m.default);
          Promise.resolve(p).then(mod => {
            mod.get(u, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteCloner/1.0)' } }, (r) => {
              if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects < 5) {
                r.resume();
                const loc = new URL(r.headers.location, u).href;
                doFetch(loc, redirects + 1);
              } else {
                resolve(r);
              }
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
          });
        };
        doFetch(fetchUrl);
      });
    }

    // Collect response body as buffer
    async function fetchBody(u) {
      const response = await fetchUrl(u);
      if (response.statusCode !== 200) { response.resume(); return null; }
      const chunks = [];
      let size = 0;
      return new Promise((resolve) => {
        response.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) { response.destroy(); resolve(null); } else chunks.push(c); });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => resolve(null));
      });
    }

    // URL to local file path
    function urlToPath(u) {
      try {
        const parsed = new URL(u);
        let p = parsed.pathname;
        if (p.endsWith('/')) p += 'index.html';
        if (!p.includes('.') && !p.endsWith('/')) p += '/index.html';
        return p.replace(/^\//, '');
      } catch { return null; }
    }

    // Extract links from HTML
    function extractLinks(html, pageUrl) {
      const links = { pages: [], assets: [] };
      // Pages: <a href="...">
      for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)/gi)) {
        try {
          const abs = new URL(m[1], pageUrl).href;
          if (abs.startsWith(baseOrigin) && !abs.includes('#')) links.pages.push(abs.split('?')[0].split('#')[0]);
        } catch {}
      }
      // CSS: <link rel="stylesheet" href="...">
      for (const m of html.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        if (m[0].includes('stylesheet') || m[1].endsWith('.css')) {
          try { links.assets.push(new URL(m[1], pageUrl).href); } catch {}
        }
      }
      // Scripts: <script src="...">
      for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
        try { links.assets.push(new URL(m[1], pageUrl).href); } catch {}
      }
      // Images: <img src="...">, srcset, background-image
      for (const m of html.matchAll(/(?:src|srcset|poster)\s*=\s*["']([^"'\s,]+)/gi)) {
        try { const abs = new URL(m[1], pageUrl).href; if (!abs.startsWith('data:')) links.assets.push(abs); } catch {}
      }
      // CSS url() references
      for (const m of html.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        try { const abs = new URL(m[1], pageUrl).href; if (!abs.startsWith('data:')) links.assets.push(abs); } catch {}
      }
      // Favicon
      for (const m of html.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        if (m[0].includes('icon')) { try { links.assets.push(new URL(m[1], pageUrl).href); } catch {} }
      }
      return links;
    }

    // Rewrite URLs in content to relative paths
    function rewriteUrls(content, pageUrl) {
      let result = content;
      // Replace absolute URLs with relative paths
      const pageDir = dirname(urlToPath(pageUrl) || 'index.html');
      result = result.replace(new RegExp(baseOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/[^"\'\\s)]*)', 'g'), (match, path) => {
        const targetFile = urlToPath(baseOrigin + path) || path.slice(1);
        const rel = relative(pageDir, targetFile) || targetFile;
        return rel;
      });
      return result;
    }

    send({ type: 'status', message: `Starting crawl of ${baseOrigin}`, maxPages: clampedMaxPages, maxDepth: clampedMaxDepth });

    // BFS crawl pages
    while (queue.length > 0 && pagesDownloaded < clampedMaxPages && !aborted) {
      const { url: pageUrl, depth } = queue.shift();
      const normalized = pageUrl.split('?')[0].split('#')[0];
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      send({ type: 'crawling', url: normalized, depth, pagesDownloaded, pagesQueued: queue.length });

      const bodyBuf = await fetchBody(normalized);
      if (!bodyBuf) continue;

      const localPath = urlToPath(normalized) || 'index.html';
      const fullPath = join(full, localPath);
      await mkdir(dirname(fullPath), { recursive: true });

      // Detect binary files — skip text processing for non-text files
      const isBinary = /\.(jpg|jpeg|png|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|gz|tar|exe|dll|so|dylib)$/i.test(localPath);

      if (isBinary) {
        // Write binary files directly — no UTF-8 conversion
        await writeFile(fullPath, bodyBuf);
        await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
        assetsDownloaded++;
        send({ type: 'asset', url: normalized, path: localPath, current: assetsDownloaded, total: 0 });
        continue;
      }

      const html = bodyBuf.toString('utf-8');

      // Extract links before rewriting
      const links = extractLinks(html, normalized);

      // Rewrite URLs and save
      const rewritten = rewriteUrls(html, normalized);
      const finalContent = shouldPrettify(localPath, prettifyHtml, prettifyCss, prettifyJs) ? prettifyContent(rewritten, localPath) : rewritten;
      await writeFile(fullPath, finalContent, 'utf-8');
      await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
      pagesDownloaded++;

      send({ type: 'page', url: normalized, path: localPath, size: bodyBuf.length, pagesDownloaded, totalDiscovered: visited.size + queue.length });

      // Queue internal page links
      if (depth < clampedMaxDepth) {
        for (const link of links.pages) {
          const norm = link.split('?')[0].split('#')[0];
          if (!visited.has(norm) && !queue.some(q => q.url === norm)) {
            queue.push({ url: norm, depth: depth + 1 });
          }
        }
      }

      // Queue assets
      for (const asset of links.assets) {
        if (!visited.has(asset)) assetQueue.push(asset);
      }
    }

    // Download assets
    const uniqueAssets = [...new Set(assetQueue)].filter(a => !visited.has(a));
    send({ type: 'status', message: `Downloading ${uniqueAssets.length} assets...` });

    for (let i = 0; i < uniqueAssets.length && !aborted; i++) {
      const assetUrl = uniqueAssets[i];
      visited.add(assetUrl);

      const localPath = urlToPath(assetUrl);
      if (!localPath) continue;

      send({ type: 'asset', url: assetUrl, path: localPath, current: i + 1, total: uniqueAssets.length });

      const assetBuf = await fetchBody(assetUrl);
      if (!assetBuf) continue;

      const fullPath = join(full, localPath);
      await mkdir(dirname(fullPath), { recursive: true });
      // Prettify text assets if enabled per-type
      const isTextAsset = /\.(css|scss|js|mjs|html?|svg|xml)$/i.test(localPath);
      if (isTextAsset && shouldPrettify(localPath, prettifyHtml, prettifyCss, prettifyJs)) {
        await writeFile(fullPath, prettifyContent(assetBuf.toString('utf-8'), localPath), 'utf-8');
      } else {
        await writeFile(fullPath, assetBuf);
      }
      await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
      assetsDownloaded++;

      // Parse CSS for additional url() references
      if (localPath.endsWith('.css')) {
        const cssText = assetBuf.toString('utf-8');
        for (const m of cssText.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
          try {
            const abs = new URL(m[1], assetUrl).href;
            if (!abs.startsWith('data:') && !visited.has(abs)) {
              uniqueAssets.push(abs);
            }
          } catch {}
        }
      }
    }

    send({
      type: 'complete',
      pagesDownloaded,
      assetsDownloaded,
      totalFiles: pagesDownloaded + assetsDownloaded,
      path: destPath,
      message: `Cloned ${pagesDownloaded} pages and ${assetsDownloaded} assets`,
    });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
}

// ─── Router ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const path = getPath(req.url);
  const method = req.method;

  try {
    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (path === '/ls' && method === 'GET') return handleLs(req, res);
    if (path === '/read' && method === 'GET') return handleRead(req, res);
    if (path === '/download' && method === 'GET') return handleDownload(req, res);
    if (path === '/mkdir' && method === 'POST') return handleMkdir(req, res);
    if (path === '/upload' && method === 'POST') return handleUpload(req, res);
    if (path === '/write' && method === 'POST') return handleWrite(req, res);
    if (path === '/rename' && method === 'POST') return handleRename(req, res);
    if (path === '/rm' && (method === 'DELETE' || method === 'POST')) return handleRm(req, res);
    if (path === '/write-raw' && method === 'POST') return handleWriteRaw(req, res);
    if (path === '/copy' && method === 'POST') return handleCopy(req, res);
    if (path === '/archive' && method === 'POST') return handleArchive(req, res);
    if (path === '/extract' && method === 'POST') return handleExtract(req, res);
    if (path === '/git-clone' && method === 'POST') return handleGitClone(req, res);
    if (path === '/disk-usage' && method === 'GET') return handleDiskUsage(req, res);
    if (path === '/folder-size' && method === 'GET') return handleFolderSize(req, res);
    if (path === '/chmod' && method === 'POST') return handleChmod(req, res);
    if (path === '/chown' && method === 'POST') return handleChown(req, res);
    if (path === '/fetch-url' && method === 'POST') return handleFetchUrl(req, res);
    if (path === '/clone-site' && method === 'POST') return handleCloneSite(req, res);

    sendError(res, 404, 'Not found');
  } catch (err) {
    if (!res.headersSent) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendError(res, 413, err.message);
      } else {
        console.error('[router]', err.message);
        sendError(res, 500, 'Internal error');
      }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`File manager sidecar listening on :${PORT}`);
});
