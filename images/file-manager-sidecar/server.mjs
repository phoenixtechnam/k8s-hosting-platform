// File Manager Sidecar — Minimal REST API for PVC file operations
// Runs inside client K8s namespace, mounted PVC at /data
// No auth — protected by NetworkPolicy (only platform namespace can reach it)

import { createServer } from 'node:http';
import { readdir, stat, readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const PORT = 8111;
const BASE = '/data';

// ─── Security: path traversal prevention ─────────────────────────────────────

function safePath(userPath) {
  // Strip leading slash — user paths are relative to BASE
  const cleaned = (userPath || '.').replace(/^\/+/, '') || '.';
  const resolved = resolve(BASE, cleaned);
  if (!resolved.startsWith(BASE)) {
    return null; // Traversal attempt
  }
  return resolved;
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

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(.+)/);
  if (!match) throw new Error('No boundary in content-type');

  const boundary = match[1];
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');

  try {
    const entries = await readdir(full, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (e) => {
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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');

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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');

  try {
    const s = await stat(full);
    if (s.isDirectory()) return sendError(res, 400, 'Directory download not supported yet');

    const name = basename(full);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');

  try {
    await mkdir(full, { recursive: true });
    sendJson(res, 201, { path: p, created: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleUpload(req, res) {
  const { path: targetDir = '/' } = getQuery(req.url);
  const full = safePath(targetDir);
  if (!full) return sendError(res, 403, 'Access denied');

  try {
    const parts = await parseMultipart(req);
    const filePart = parts.find(p => p.filename);
    if (!filePart) return sendError(res, 400, 'No file in upload');

    const destPath = join(full, filePart.filename);
    const destSafe = safePath(join(targetDir, filePart.filename));
    if (!destSafe) return sendError(res, 403, 'Access denied');

    await mkdir(full, { recursive: true });
    await writeFile(destSafe, filePart.data);
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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');

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
  const fullOld = safePath(oldPath);
  const fullNew = safePath(newPath);
  if (!fullOld || !fullNew) return sendError(res, 403, 'Access denied');

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
  const full = safePath(p);
  if (!full) return sendError(res, 403, 'Access denied');
  if (full === BASE) return sendError(res, 403, 'Cannot delete root');

  try {
    await rm(full, { recursive: true });
    sendJson(res, 200, { path: p, deleted: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Not found');
    sendError(res, 500, err.message);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

    sendError(res, 404, 'Not found');
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`File manager sidecar listening on :${PORT}`);
});
