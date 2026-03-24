import { ApiError } from './errors.js';

interface CursorData {
  readonly resource: string;
  readonly sort: string;
  readonly id: string;
}

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorData {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (!decoded.resource || !decoded.sort || !decoded.id) {
      throw new Error('Missing cursor fields');
    }
    return decoded as CursorData;
  } catch {
    throw new ApiError(
      'INVALID_CURSOR',
      'Pagination cursor is invalid or expired',
      400,
      undefined,
      'Restart pagination from beginning',
    );
  }
}

export function parsePaginationParams(query: Record<string, unknown>): {
  limit: number;
  cursor: string | undefined;
  sort: { field: string; direction: 'asc' | 'desc' };
} {
  const parsed = Number(query.limit);
  const rawLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const limit = Math.min(Math.max(rawLimit, 1), 100);
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;

  const sortParam = typeof query.sort === 'string' ? query.sort : 'created_at:desc';
  const [field = 'created_at', dir = 'desc'] = sortParam.split(':');
  const direction = dir === 'asc' ? 'asc' : 'desc';

  return { limit, cursor, sort: { field, direction } };
}
