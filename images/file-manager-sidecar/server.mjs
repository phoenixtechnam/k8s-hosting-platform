// File Manager Sidecar — Minimal REST API for PVC file operations
// Runs inside client K8s namespace, mounted PVC at /data
// No auth — protected by NetworkPolicy (only platform namespace can reach it)

import { createServer } from 'node:http';
import { readdir, stat, readFile, writeFile, mkdir, rm, rename, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = 8111;
const BASE = '/data';

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

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) || 512 * 1024 * 1024; // 512 MB default

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(.+)/);
  if (!match) throw new Error('No boundary in content-type');

  const boundary = match[1];
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_UPLOAD_SIZE) {
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
  const { path: p = '/' } = getQuery(req.url);
  const bypass = isPlatformBypass(req);
  const full = safePath(p, { allowHidden: bypass });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const entries = await readdir(full, { withFileTypes: true });
    // Filter out hidden platform paths unless the caller is the
    // platform backend with the bypass header. We pre-compute the
    // parent's path relative to BASE so each entry can be checked.
    const parentRel = relToBase(full);
    const visibleEntries = bypass
      ? entries
      : entries.filter((e) => {
          const childRel = parentRel === '.' ? e.name : `${parentRel}/${e.name}`;
          return !isHidden(childRel);
        });
    const items = await Promise.all(visibleEntries.map(async (e) => {
      const entryPath = join(full, e.name);
      try {
        const s = await stat(entryPath);
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
          permissions: (s.mode & 0o777).toString(8),
        };
      } catch {
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: 0, modifiedAt: null, permissions: '000' };
      }
    }));
    // Sort: directories first, then alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJson(res, 200, { path: p, entries: items });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Directory not found');
    if (err.code === 'ENOTDIR') return sendError(res, 400, 'Not a directory');
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Content-Length': s.size,
    });
    const stream = createReadStream(full);
    await pipeline(stream, res);
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'File not found');
    if (!res.headersSent) sendError(res, 500, err.message);
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
    sendJson(res, 201, { path: p, created: true });
  } catch (err) {
    sendError(res, 500, err.message);
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

    sendJson(res, 201, { path: join(targetDir, filePart.filename), size: filePart.data.length });
  } catch (err) {
    sendError(res, 500, err.message);
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
    await writeFile(full, content, 'utf-8');
    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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

    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    // If client disconnected, clean up partial file
    rm(full, { force: true }).catch(() => {});
    if (!res.headersSent) sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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
    sendError(res, 500, err.message);
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

    sendError(res, 404, 'Not found');
  } catch (err) {
    if (!res.headersSent) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendError(res, 413, err.message);
      } else {
        sendError(res, 500, err.message);
      }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`File manager sidecar listening on :${PORT}`);
});
