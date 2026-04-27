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
  reply.status(500).send(
    errorResponse(
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred',
      500,
      requestId,
    ),
  );
}
