import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../shared/errors.js';
import { errorResponse } from '../shared/response.js';
import { translateOperatorError } from '../shared/operator-error.js';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  if (error instanceof ApiError) {
    reply.status(error.status).send(
      errorResponse(
        error.code,
        error.message,
        error.status,
        requestId,
        error.details,
        error.remediation,
      ),
    );
    return;
  }

  // Fastify validation errors
  if (error.validation) {
    reply.status(400).send(
      errorResponse(
        'VALIDATION_ERROR',
        error.message,
        400,
        requestId,
        { validation: error.validation },
      ),
    );
    return;
  }

  // FastifyError with a 4xx statusCode — these are client-fault errors
  // raised by the framework itself (empty JSON body, payload too large,
  // missing content-type, etc). Preserve the 4xx code AND the framework
  // error code so clients get an actionable response instead of being
  // told "An unexpected error occurred" with a 500.
  const fastifyStatus = (error as FastifyError & { statusCode?: number }).statusCode;
  const fastifyCode = (error as FastifyError & { code?: string }).code;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    reply.status(fastifyStatus).send(
      errorResponse(
        fastifyCode ?? 'BAD_REQUEST',
        error.message,
        fastifyStatus,
        requestId,
      ),
    );
    return;
  }

  // Unexpected errors — try to translate using the operator-error
  // catalog before falling back to the generic INTERNAL_SERVER_ERROR.
  // This catches k8s API errors (FailedAttachVolume, exceeded quota,
  // ImagePullBackOff via @kubernetes/client-node ApiException) that
  // would otherwise reach the operator as a useless 500.
  request.log.error(error);
  const envelope = translateOperatorError(error.message ?? String(error));
  // Only override the generic 500 envelope when we actually identified
  // the error — UNKNOWN means we don't know better than the existing
  // INTERNAL_SERVER_ERROR fallback so we keep the legacy behaviour
  // (avoids hiding a genuine bug behind a misleading translation).
  if (envelope.code !== 'UNKNOWN') {
    reply.status(500).send(
      errorResponse(
        envelope.code,
        envelope.title,
        500,
        requestId,
        { operatorError: envelope, raw: error.message },
        envelope.remediation.join(' • '),
      ),
    );
    return;
  }

  // Drizzle / pg constraint failures — surface the constraint name and
  // the underlying DB message instead of swallowing the whole class as
  // a useless "An unexpected error occurred" 500. Triggered the
  // ingress_routes_target_xor regression for ~2 days because the operator
  // had no signal beyond "unexpected error".
  //
  // We deliberately keep this narrow: only DrizzleQueryError-shaped
  // payloads are unwrapped, so an unrelated 500 from elsewhere still
  // falls through to the legacy generic envelope.
  const drizzle = describeDrizzleError(error);
  if (drizzle) {
    reply.status(drizzle.status).send(
      errorResponse(
        drizzle.code,
        drizzle.message,
        drizzle.status,
        requestId,
        drizzle.details,
        drizzle.remediation,
      ),
    );
    return;
  }

  reply.status(500).send(
    errorResponse(
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred',
      500,
      requestId,
    ),
  );
}

// ─── Postgres / Drizzle error unwrap ────────────────────────────────────────

interface UnwrappedDbError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly remediation?: string;
}

/**
 * Best-effort extraction of a useful response envelope from a
 * `DrizzleQueryError` (or a bare `pg` error). The shapes the platform-api
 * sees in practice carry the postgres error on `.cause` with `.code`,
 * `.constraint`, `.detail`, and `.table`.
 *
 * Returns `null` for anything we don't recognise — caller falls back to
 * the existing INTERNAL_SERVER_ERROR envelope.
 */
function describeDrizzleError(error: unknown): UnwrappedDbError | null {
  if (!error || typeof error !== 'object') return null;
  const ctor = (error as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (ctor !== 'DrizzleQueryError' && ctor !== 'DatabaseError') return null;

  const cause = (error as { cause?: unknown }).cause;
  // Walk through wrappers; pg's DatabaseError can be nested 1–2 deep.
  const pg = unwrapPgError(cause) ?? unwrapPgError(error);
  if (!pg) return null;

  const constraint = pg.constraint ?? null;
  const table = pg.table ?? null;
  const detail = pg.detail ?? null;
  const sqlState = pg.code ?? null;

  // 23xxx — class 23 (integrity constraint violations). Map the most
  // common SQLSTATEs to actionable error codes; everything else still
  // gets useful detail vs. a generic 500.
  if (sqlState && sqlState.startsWith('23')) {
    let code = 'CONSTRAINT_VIOLATION';
    let remediation = 'Check the request payload against the table constraints; the DB rejected the row.';
    if (sqlState === '23505') {
      code = 'DUPLICATE_KEY';
      remediation = 'A row with this unique key already exists. Pick a different value or update the existing row.';
    } else if (sqlState === '23503') {
      code = 'FOREIGN_KEY_VIOLATION';
      remediation = 'The referenced row does not exist (or is being deleted). Verify foreign-key targets before retrying.';
    } else if (sqlState === '23502') {
      code = 'NOT_NULL_VIOLATION';
      remediation = 'Required field is null. Provide a value for the highlighted column.';
    } else if (sqlState === '23514') {
      code = 'CHECK_CONSTRAINT_VIOLATION';
      remediation = 'The DB-level check constraint refused the row. See `details.constraint` for the rule that was violated.';
    }
    return {
      status: 400,
      code,
      message: pg.message ?? 'Database constraint violation',
      details: filterUndefined({
        sqlState,
        constraint,
        table,
        detail,
      }),
      remediation,
    };
  }

  // 22xxx — data exception (string too long, invalid input syntax, etc.).
  if (sqlState && sqlState.startsWith('22')) {
    return {
      status: 400,
      code: 'INVALID_DATA',
      message: pg.message ?? 'Invalid input data',
      details: filterUndefined({ sqlState, detail }),
      remediation: 'Re-check the field values; one or more violate type / length constraints.',
    };
  }

  // Everything else — still useful (we expose the SQLSTATE) but stays a 500.
  return {
    status: 500,
    code: 'DATABASE_ERROR',
    message: pg.message ?? 'Database error',
    details: filterUndefined({ sqlState, constraint, table, detail }),
  };
}

interface PgErrorShape {
  readonly code?: string;
  readonly message?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly detail?: string;
}

function unwrapPgError(value: unknown): PgErrorShape | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  // pg's `error: ...` event has all the fields directly.
  if (typeof v.code === 'string' || typeof v.constraint === 'string') {
    return {
      code: typeof v.code === 'string' ? v.code : undefined,
      message: typeof v.message === 'string' ? v.message : undefined,
      constraint: typeof v.constraint === 'string' ? v.constraint : undefined,
      table: typeof v.table === 'string' ? v.table : undefined,
      detail: typeof v.detail === 'string' ? v.detail : undefined,
    };
  }
  return null;
}

function filterUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
